import fs from 'node:fs/promises';

export class RepoRelayError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RepoRelayError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new RepoRelayError(code, message, details);
}

export async function loadPolicy(path = new URL('../config/policy.json', import.meta.url)) {
  const raw = await fs.readFile(path, 'utf8');
  const policy = JSON.parse(raw);
  invariant(policy?.version === 1, 'POLICY_VERSION_UNSUPPORTED', 'Unsupported RepoRelay policy version');
  return policy;
}

export function parseCommand(body, maxBytes = 60000) {
  invariant(typeof body === 'string', 'COMMAND_BODY_REQUIRED', 'Command body must be a string');
  invariant(Buffer.byteLength(body, 'utf8') <= maxBytes, 'COMMAND_TOO_LARGE', 'Command exceeds configured size limit');
  const trimmed = body.trim();
  invariant(trimmed.startsWith('/reporelay'), 'COMMAND_PREFIX_INVALID', 'Command must start with /reporelay');
  const jsonText = trimmed.slice('/reporelay'.length).trim();
  invariant(jsonText.length > 0, 'COMMAND_JSON_REQUIRED', 'A JSON command object is required after /reporelay');
  let command;
  try {
    command = JSON.parse(jsonText);
  } catch (error) {
    throw new RepoRelayError('COMMAND_JSON_INVALID', 'Command JSON is invalid', { message: error.message });
  }
  invariant(command && typeof command === 'object' && !Array.isArray(command), 'COMMAND_OBJECT_REQUIRED', 'Command must be a JSON object');
  invariant(command.v === 1, 'COMMAND_VERSION_UNSUPPORTED', 'Only command version 1 is supported');
  invariant(typeof command.request_id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(command.request_id), 'REQUEST_ID_INVALID', 'request_id must be 1-120 safe characters');
  invariant(typeof command.action === 'string' && /^[a-z][a-z0-9_.-]{1,80}$/.test(command.action), 'ACTION_INVALID', 'action is invalid');
  invariant(typeof command.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(command.repository), 'REPOSITORY_INVALID', 'repository must be owner/name');
  return command;
}

export function authorize({ policy, actor, controlRepository, controlIssue, command }) {
  invariant(policy.control_repository === controlRepository, 'CONTROL_REPOSITORY_MISMATCH', 'Command arrived from an unauthorized control repository');
  invariant(policy.control_issues.includes(Number(controlIssue)), 'CONTROL_ISSUE_FORBIDDEN', 'Command arrived from an unauthorized control issue');
  invariant(policy.authorized_actors.includes(actor), 'ACTOR_FORBIDDEN', `Actor ${actor} is not authorized`);
  invariant(policy.allowed_repositories.includes(command.repository), 'REPOSITORY_FORBIDDEN', `Repository ${command.repository} is not allowlisted`);
}

export function splitRepository(repository) {
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}

export async function githubRequest(token, method, path, body, options = {}) {
  invariant(token, 'TOKEN_REQUIRED', 'GitHub token is missing');
  const headers = {
    Accept: options.accept || 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'RepoRelay/0.1',
    ...(options.headers || {}),
  };
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    throw new RepoRelayError('GITHUB_API_ERROR', `${method} ${path} failed with HTTP ${response.status}`, {
      status: response.status,
      payload,
    });
  }
  return payload;
}

export async function graphql(token, query, variables = {}) {
  const result = await githubRequest(token, 'POST', '/graphql', { query, variables });
  if (result?.errors?.length) {
    throw new RepoRelayError('GITHUB_GRAPHQL_ERROR', 'GitHub GraphQL request failed', { errors: result.errors });
  }
  return result?.data;
}

export async function getRepository(token, repository) {
  const { owner, repo } = splitRepository(repository);
  return githubRequest(token, 'GET', `/repos/${owner}/${repo}`);
}

export async function getPull(token, repository, number) {
  const { owner, repo } = splitRepository(repository);
  return githubRequest(token, 'GET', `/repos/${owner}/${repo}/pulls/${number}`);
}

export async function getPullGovernance(token, repository, number) {
  const { owner, repo } = splitRepository(repository);
  const data = await graphql(token, `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          isDraft
          reviewDecision
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes { isResolved }
          }
        }
      }
    }
  `, { owner, repo, number: Number(number) });
  const pr = data?.repository?.pullRequest;
  invariant(pr, 'PR_NOT_FOUND', `Pull request #${number} not found`);
  invariant(!pr.reviewThreads.pageInfo.hasNextPage, 'REVIEW_THREADS_PAGINATION_UNSUPPORTED', 'More than 100 review threads require a future pagination implementation');
  return pr;
}

export async function assertExpectedHead(token, repository, number, expectedHeadSha) {
  invariant(typeof expectedHeadSha === 'string' && /^[0-9a-f]{40}$/i.test(expectedHeadSha), 'EXPECTED_HEAD_REQUIRED', 'expected_head_sha must be a full 40-character SHA');
  const pr = await getPull(token, repository, number);
  invariant(pr.head?.sha === expectedHeadSha, 'EXPECTED_HEAD_MISMATCH', 'Pull request head moved', {
    expected: expectedHeadSha,
    actual: pr.head?.sha,
  });
  return pr;
}

export async function assertExpectedBase(token, pr, expectedBaseSha) {
  if (!expectedBaseSha) return;
  invariant(/^[0-9a-f]{40}$/i.test(expectedBaseSha), 'EXPECTED_BASE_INVALID', 'expected_base_sha must be a full 40-character SHA');
  invariant(pr.base?.sha === expectedBaseSha, 'EXPECTED_BASE_MISMATCH', 'Pull request base moved', {
    expected: expectedBaseSha,
    actual: pr.base?.sha,
  });
}

function latestCheckRuns(checkRuns = []) {
  const byKey = new Map();
  for (const run of checkRuns) {
    const key = `${run.app?.slug || 'unknown'}:${run.name}`;
    const current = byKey.get(key);
    if (!current || Number(run.id) > Number(current.id)) byKey.set(key, run);
  }
  return [...byKey.values()];
}

export async function getCurrentChecks(token, repository, sha) {
  const { owner, repo } = splitRepository(repository);
  const checks = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
  const statuses = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/commits/${sha}/status`);
  return {
    checkRuns: latestCheckRuns(checks?.check_runs || []),
    statuses: statuses?.statuses || [],
    combinedState: statuses?.state || 'pending',
  };
}

export function assertChecksGreen(checks) {
  const allowed = new Set(['success', 'neutral', 'skipped']);
  const pending = checks.checkRuns.filter((run) => run.status !== 'completed');
  invariant(pending.length === 0, 'CHECKS_PENDING', 'Current check runs are still pending', {
    checks: pending.map((run) => run.name),
  });
  const failed = checks.checkRuns.filter((run) => run.status === 'completed' && !allowed.has(run.conclusion));
  invariant(failed.length === 0, 'CHECKS_NOT_GREEN', 'One or more current check runs are not green', {
    checks: failed.map((run) => ({ name: run.name, conclusion: run.conclusion })),
  });
  if (checks.statuses.length > 0) {
    const badStatuses = checks.statuses.filter((status) => status.state !== 'success');
    invariant(badStatuses.length === 0, 'COMMIT_STATUSES_NOT_GREEN', 'One or more commit status contexts are not green', {
      statuses: badStatuses.map((status) => ({ context: status.context, state: status.state })),
    });
  }
}

export function receiptMarker({ sourceCommentId, requestId, action, repository, status }) {
  return `<!-- reporelay-receipt source_comment_id=${sourceCommentId} request_id=${requestId} action=${action} repository=${repository} status=${status} -->`;
}

function receiptBody(sourceCommentId, command, status, result) {
  const marker = receiptMarker({
    sourceCommentId,
    requestId: command?.request_id || 'unknown',
    action: command?.action || 'unknown',
    repository: command?.repository || 'unknown',
    status,
  });
  const safeResult = result === undefined ? null : result;
  return `${marker}\n**RepoRelay ${status}** — \`${command?.action || 'unknown'}\` on \`${command?.repository || 'unknown'}\`\n\n\`request_id: ${command?.request_id || 'unknown'}\`\n\n\`\`\`json\n${JSON.stringify(safeResult, null, 2).slice(0, 12000)}\n\`\`\``;
}

export async function findReceipt(controlToken, controlRepository, controlIssue, sourceCommentId, requestId) {
  const { owner, repo } = splitRepository(controlRepository);
  let page = 1;
  const sourceNeedle = `source_comment_id=${sourceCommentId}`;
  const requestNeedle = requestId ? `request_id=${requestId}` : null;
  while (page <= 10) {
    const comments = await githubRequest(controlToken, 'GET', `/repos/${owner}/${repo}/issues/${controlIssue}/comments?per_page=100&page=${page}`);
    const match = comments.find((comment) =>
      typeof comment.body === 'string' &&
      comment.body.includes('reporelay-receipt') &&
      (comment.body.includes(sourceNeedle) || (requestNeedle && comment.body.includes(requestNeedle)))
    );
    if (match) return match;
    if (comments.length < 100) return null;
    page += 1;
  }
  throw new RepoRelayError('RECEIPT_SCAN_LIMIT', 'Receipt scan exceeded 1000 comments');
}

export async function createReceipt(controlToken, controlRepository, controlIssue, sourceCommentId, command, status, result) {
  const { owner, repo } = splitRepository(controlRepository);
  const body = receiptBody(sourceCommentId, command, status, result);
  return githubRequest(controlToken, 'POST', `/repos/${owner}/${repo}/issues/${controlIssue}/comments`, { body });
}

export async function updateReceipt(controlToken, controlRepository, receiptCommentId, sourceCommentId, command, status, result) {
  const { owner, repo } = splitRepository(controlRepository);
  const body = receiptBody(sourceCommentId, command, status, result);
  return githubRequest(controlToken, 'PATCH', `/repos/${owner}/${repo}/issues/comments/${receiptCommentId}`, { body });
}

export function commandFromEvent(event, dispatchCommand) {
  if (event.action === 'created' && event.comment) {
    return {
      sourceCommentId: String(event.comment.id),
      actor: event.comment.user?.login,
      controlRepository: event.repository?.full_name,
      controlIssue: event.issue?.number,
      body: event.comment.body,
    };
  }
  if (event.inputs || dispatchCommand) {
    return {
      sourceCommentId: `dispatch-${process.env.GITHUB_RUN_ID || Date.now()}`,
      actor: event.sender?.login || process.env.GITHUB_ACTOR,
      controlRepository: event.repository?.full_name || process.env.GITHUB_REPOSITORY,
      controlIssue: 1,
      body: dispatchCommand || event.inputs?.command,
    };
  }
  throw new RepoRelayError('EVENT_UNSUPPORTED', 'Unsupported workflow event');
}
