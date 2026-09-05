import { invariant, RepoRelayError } from './core.mjs';
import { tooLarge } from './read-contract.mjs';

// This is the only GraphQL document available to the read plane. No caller text
// is interpolated into it; the caller can only supply validated typed selectors.
const THREAD_QUERY = `query RepoRelayReadThreads($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number headRefOid baseRefOid reviewDecision
      reviewThreads(first: $first, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id isResolved isOutdated path line originalLine }
      }
    }
  }
}`;

async function responseText(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    tooLarge('upstream_source_limit', { max_source_bytes: maxBytes });
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        tooLarge('upstream_source_limit', { max_source_bytes: maxBytes });
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof RepoRelayError) throw error;
    throw new RepoRelayError('READ_TEXT_INVALID', 'Read response is not valid UTF-8');
  } finally {
    reader.releaseLock();
  }
}

export class ReadClient {
  #token;
  #limits;
  #count = 0;
  #repository;
  #base;
  constructor(token, repository, limits) {
    invariant(typeof token === 'string' && token.length > 0, 'TOKEN_REQUIRED', 'GitHub token is missing');
    invariant(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
      'READ_TARGET_INVALID', 'Invalid resolved read target');
    this.#token = token;
    this.#repository = repository;
    this.#base = `https://api.github.com/repos/${repository}`;
    this.#limits = limits;
  }
  async #request(url, body, { text = false, logRedirect = false } = {}) {
    invariant(++this.#count <= this.#limits.max_read_requests, 'READ_REQUEST_LIMIT', 'Read request budget exhausted');
    invariant(url.origin === 'https://api.github.com', 'READ_TARGET_INVALID', 'Read target origin is invalid');
    const method = body === undefined ? 'GET' : 'POST';
    invariant(method === 'GET' || (url.pathname === '/graphql' && body.query === THREAD_QUERY),
      'READ_SIDE_EFFECT_FORBIDDEN', 'Only GET and the fixed GraphQL query are allowed');
    const signal = AbortSignal.timeout(this.#limits.max_read_timeout_ms);
    let response;
    try {
      response = await fetch(url, {
        method, redirect: 'manual', cache: 'no-store', signal,
        headers: { Accept: text && !logRedirect ? 'application/vnd.github.diff' : 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`, 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'RepoRelay/read-1', 'Cache-Control': 'no-cache',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (logRedirect && response.status === 302) {
        const location = response.headers.get('location');
        let signed;
        try { signed = new URL(location); } catch { throw new RepoRelayError('READ_LOG_REDIRECT_INVALID', 'Missing signed log redirect'); }
        invariant(signed.protocol === 'https:' && !signed.username && !signed.password && !signed.port
          && (signed.hostname.endsWith('.actions.githubusercontent.com') || signed.hostname.endsWith('.blob.core.windows.net')),
        'READ_LOG_REDIRECT_INVALID', 'Unexpected signed log host');
        await response.body?.cancel();
        // No GitHub token or other original headers are forwarded to log storage.
        response = await fetch(signed, { method: 'GET', redirect: 'error', signal });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new RepoRelayError('READ_GITHUB_ERROR', 'GitHub could not complete the typed read', { status: response.status });
      }
      const hasNextPage = /rel="next"/.test(response.headers.get('link') ?? '');
      const content = await responseText(response, this.#limits.max_read_source_bytes);
      if (text) return { data: content, hasNextPage };
      let data;
      try { data = JSON.parse(content); } catch { throw new RepoRelayError('READ_UPSTREAM_SHAPE_INVALID', 'Expected a complete JSON response'); }
      return { data, hasNextPage };
    } catch (error) {
      if (error instanceof RepoRelayError) throw error;
      throw new RepoRelayError('READ_TRANSPORT_FAILED', 'GitHub typed-read transport failed');
    }
  }
  get(suffix = '', params = {}, options = {}) {
    invariant(typeof suffix === 'string' && (suffix === '' || suffix.startsWith('/'))
      && (!suffix.includes('..') || /^\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(suffix)) && !suffix.includes('//') && !/[?#\p{Cc}\p{Cf}]/u.test(suffix),
    'READ_TARGET_INVALID', 'Invalid server read route');
    const url = new URL(`${this.#base}${suffix}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.#request(url, undefined, options);
  }
  async threads(number, first, after = null) {
    const [owner, repo] = this.#repository.split('/');
    const { data } = await this.#request(new URL('https://api.github.com/graphql'), {
      query: THREAD_QUERY, variables: { owner, repo, number, first, after },
    });
    invariant(!data?.errors?.length && data?.data?.repository?.pullRequest,
      'READ_GRAPHQL_ERROR', 'GitHub review query did not return complete data');
    return data.data.repository.pullRequest;
  }
  search(terms, page, perPage) {
    const url = new URL('https://api.github.com/search/code');
    url.searchParams.set('q', `${terms.join(' ')} repo:${this.#repository}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    return this.#request(url);
  }
  jobLog(job) {
    return this.get(`/actions/jobs/${job}/logs`, {}, { text: true, logRedirect: true });
  }
}
