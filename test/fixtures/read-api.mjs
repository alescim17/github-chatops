import crypto from 'node:crypto';
import assert from 'node:assert/strict';

export const target = 'owner/private-target';
export const A = 'a'.repeat(40);
export const B = 'b'.repeat(40);
export const C = 'c'.repeat(40);
export const D = 'd'.repeat(40);
export const E = 'e'.repeat(40);
export const F = 'f'.repeat(40);
export const time = '2026-09-05T18:00:00Z';
export const privateCanaries = [target, 'PRIVATE_PR_TITLE', 'PRIVATE_PR_BODY', 'PRIVATE_ISSUE_TITLE', 'PRIVATE_ISSUE_BODY',
  'PRIVATE_COMMENT_BODY', 'PRIVATE_REVIEW_BODY', 'src/private-source.mjs', 'PRIVATE_SOURCE_CONTENT', 'PRIVATE_WORKFLOW_LOG',
  'ghp_secret_credential', 'PRIVATE_COMMIT_MESSAGE', 'secret@example.invalid'];
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

export function fakeApi(options = {}) {
  const calls = [];
  const counters = new Map();
  const content = options.fileBytes ?? Buffer.from('PRIVATE_SOURCE_CONTENT\nsecond line\nthird line\n');
  const blobSha = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const repo = { id: 1, name: 'private-target', full_name: target, private: options.publicTarget !== true,
    default_branch: 'main', description: 'PRIVATE_REPOSITORY_DESCRIPTION', token: 'ghp_secret_credential' };
  const gitCommit = (value) => ({ sha: value, tree: { sha: value === A ? C : value === E ? F : D }, parents: [{ sha: A }],
    author: { name: 'Private Author', email: 'secret@example.invalid', date: time }, committer: { date: time },
    message: 'PRIVATE_COMMIT_MESSAGE', verification: { verified: true } });
  const restCommit = (value) => { const git = gitCommit(value); return { sha: value, commit: git, parents: git.parents }; };
  const pr = (seen = 1) => ({ number: 185, state: 'open', draft: true, merged: false, mergeable: true, mergeable_state: 'clean',
    title: 'PRIVATE_PR_TITLE', body: 'PRIVATE_PR_BODY', user: { login: 'owner' },
    head: { ref: 'issue-183', sha: options.race === 'pr-head' && seen > 1 ? E : B, repo },
    base: { ref: 'main', sha: options.race === 'pr-base' && seen > 1 ? E : A, repo },
    commits: 2, changed_files: 1, updated_at: time });
  const run = (value = B) => ({ id: 55, name: 'Validation', status: 'completed', conclusion: 'success', event: 'pull_request',
    run_number: 31, run_attempt: 2, head_sha: value, repository: repo, logs: 'PRIVATE_WORKFLOW_LOG', path: 'src/private-source.mjs' });
  const job = { id: 66, run_id: 55, head_sha: B, name: 'test', status: 'completed', conclusion: 'success',
    run_url: `https://api.github.com/repos/${target}/actions/runs/55`,
    steps: [{ number: 1, name: 'test', status: 'completed', conclusion: 'success', started_at: time, completed_at: time }] };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push({ url: url.toString(), method, headers: init.headers ?? {}, body: init.body });
    const key = `${url.pathname}:${url.searchParams.get('head_sha') ?? ''}`;
    const seen = (counters.get(key) ?? 0) + 1;
    counters.set(key, seen);
    if (options.intercept) {
      const intercepted = await options.intercept(url, init, seen);
      if (intercepted !== undefined) return intercepted;
    }
    if (url.hostname.endsWith('.blob.core.windows.net')) {
      assert.equal(init.headers, undefined);
      return new Response('first\nPRIVATE_WORKFLOW_LOG\nlast\n');
    }
    if (url.pathname === '/graphql') {
      assert.equal(method, 'POST');
      const body = JSON.parse(init.body);
      assert.match(body.query, /^query RepoRelayRead/);
      assert.doesNotMatch(body.query, /\bmutation\b/);
      assert.equal(body.variables.owner, 'owner');
      assert.equal(body.variables.repo, 'private-target');
      return json({ data: { repository: { pullRequest: {
        number: 185, headRefOid: B, baseRefOid: A, reviewDecision: 'REVIEW_REQUIRED',
        reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: 'cursor' },
          nodes: [{ id: 'PRRT_1', isResolved: options.race === 'reviews' && seen > 1, isOutdated: false,
            path: 'src/private-source.mjs', line: 2, originalLine: 2, body: 'PRIVATE_REVIEW_BODY' }] },
      } } } });
    }
    assert.equal(method, 'GET');
    assert.equal(url.origin, 'https://api.github.com');
    if (url.pathname === '/search/code') {
      assert.match(url.searchParams.get('q'), / repo:owner\/private-target$/);
      return json({ total_count: 1, incomplete_results: false,
        items: [{ path: 'src/private-source.mjs', name: 'private-source.mjs', sha: blobSha, repository: options.searchEscape ? { full_name: 'other/repository' } : repo }] });
    }
    assert.ok(url.pathname.startsWith(`/repos/${target}`), `Unexpected target ${url.pathname}`);
    const path = decodeURIComponent(url.pathname.slice(`/repos/${target}`.length));
    if (path === '') return json(repo);
    if (path === '/branches/main') return json({ name: 'main', commit: { sha: options.race === 'branch' && seen > 1 ? E : A } });
    if (path === '/branches/issue-183') return json({ name: 'issue-183', commit: { sha: B } });
    if (path === '/branches/missing') return json({ message: 'Not Found' }, 404);
    if (path === '/branches') return json([{ name: 'main', commit: { sha: A }, protected: false }]);
    if (/^\/git\/commits\/[a-f0-9]{40}$/.test(path)) return json(gitCommit(path.split('/').at(-1)));
    if (path === '/commits/main') return json(restCommit(A));
    if (path === '/commits') return json([restCommit(B)]);
    if (path === '/pulls/185') {
      if (init.headers.Accept === 'application/vnd.github.diff') return new Response('diff --git a/a b/a\n+PRIVATE_SOURCE_CONTENT\n');
      return json(pr(seen));
    }
    if (path === '/issues/183') return json({ number: 183, state: 'open', state_reason: null, locked: false,
      comments: options.race === 'issue' && seen > 1 ? 2 : 1, updated_at: options.race === 'issue' && seen > 1 ? '2026-09-05T18:00:01Z' : time,
      title: 'PRIVATE_ISSUE_TITLE', body: 'PRIVATE_ISSUE_BODY', labels: [], assignees: [], user: { login: 'owner' } });
    if (path === '/issues/183/comments') return json([{ id: 71, body: 'PRIVATE_COMMENT_BODY', user: { login: 'owner' } }]);
    if (path === '/pulls/185/comments') return json([{ id: 72, path: 'src/private-source.mjs', body: 'PRIVATE_COMMENT_BODY', user: { login: 'owner' } }]);
    if (path === '/pulls/185/reviews') return json([{ id: 73, body: 'PRIVATE_REVIEW_BODY', state: 'COMMENTED', commit_id: B, user: { login: 'owner' } }]);
    if (path === '/pulls/185/files') return json([{ filename: 'src/private-source.mjs', sha: blobSha, status: 'modified', additions: 1, deletions: 1, changes: 2, patch: 'PRIVATE_SOURCE_CONTENT' }]);
    const checkMatch = path.match(/^\/commits\/([a-f0-9]{40})\/check-runs$/);
    if (checkMatch) return json({ total_count: 1, check_runs: [{ id: 10, head_sha: checkMatch[1], name: options.secretLabel ? 'ghp_secret_credential' : 'CI',
      app: { slug: 'github-actions' }, status: options.race === 'checks' && seen > 1 ? 'in_progress' : 'completed',
      conclusion: options.race === 'checks' && seen > 1 ? null : 'success', output: { summary: 'PRIVATE_WORKFLOW_LOG' } }] });
    const statusMatch = path.match(/^\/commits\/([a-f0-9]{40})\/status$/);
    if (statusMatch) return json({ sha: statusMatch[1], state: 'success', total_count: 1,
      statuses: [{ context: 'gate', state: 'success', id: 42, description: 'PRIVATE_REVIEW_BODY' }] });
    if (path === '/actions/runs') {
      const item = run(url.searchParams.get('head_sha') ?? B);
      if (options.race === 'workflows' && seen > 1) item.run_attempt = 3;
      return json({ total_count: 1, workflow_runs: [item] });
    }
    if (path === '/actions/runs/55') return json(run());
    if (path === '/actions/runs/55/attempts/2/jobs') return json({ total_count: 1, jobs: [{ ...job, run_id: options.jobEscape ? 999 : 55 }] });
    if (path === '/actions/jobs/66') return json({ ...job, run_url: options.jobEscape ? 'https://api.github.com/repos/other/repository/actions/runs/55' : job.run_url });
    if (path === '/actions/jobs/66/logs') {
      if (options.logRedirect) return new Response(null, { status: 302, headers: { location: options.logRedirect } });
      return new Response('first\nPRIVATE_WORKFLOW_LOG\nlast\n');
    }
    if (path === '/actions/runs/55/artifacts') return json({ total_count: 1, artifacts: [{ id: 77, name: 'report', size_in_bytes: 20,
      expired: false, created_at: time, updated_at: time, expires_at: time, digest: 'sha256:abc', archive_download_url: 'https://sensitive.invalid/binary' }] });
    if (path === `/git/trees/${C}` || path === `/git/trees/${D}`) return json({ sha: path.split('/').at(-1), truncated: false,
      tree: [{ path: 'demo.mjs', mode: options.fileMode ?? '100644', type: 'blob', sha: blobSha, size: content.length }] });
    if (path === `/git/blobs/${blobSha}`) return json({ sha: blobSha, encoding: 'base64', size: content.length, content: content.toString('base64') });
    if (path === `/compare/${A}...${B}`) return json({ base_commit: restCommit(A), merge_base_commit: restCommit(A), status: 'ahead',
      ahead_by: 1, behind_by: 0, total_commits: 1, commits: [restCommit(B)], files: [{ filename: 'src/private-source.mjs', patch: 'PRIVATE_SOURCE_CONTENT' }] });
    throw new Error(`Unexpected fake route: ${url}`);
  };
  return { fetch, calls, counters, blobSha, content, repo, gitCommit, pr, run, job };
}
