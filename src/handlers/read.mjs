import crypto from 'node:crypto';
import { invariant, RepoRelayError } from '../core.mjs';
import { ReadClient } from '../read-client.mjs';
import {
  READ_PLANE_VERSION, PUBLIC_READ_ACTIONS, PRIVATE_READ_ACTIONS, READ_QUERY_KINDS,
  readLimits, validateReadCommand, integer, sha, branchName,
  resultDigest, sealReadResult, tooLarge, lineRange, bodyResult,
} from '../read-contract.mjs';
import { sanitizePublicRead } from '../read-receipts.mjs';

function object(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'READ_UPSTREAM_SHAPE_INVALID', 'Expected a GitHub object');
  return value;
}
function array(value) {
  invariant(Array.isArray(value), 'READ_UPSTREAM_SHAPE_INVALID', 'Expected a GitHub collection');
  return value;
}
function count(value) { return integer(value, Number.MAX_SAFE_INTEGER, 0); }
function boolean(value) {
  invariant(typeof value === 'boolean', 'READ_UPSTREAM_SHAPE_INVALID', 'Expected a GitHub boolean');
  return value;
}
function text(value, nullable = false) {
  invariant(typeof value === 'string' || (nullable && value === null), 'READ_UPSTREAM_SHAPE_INVALID', 'Expected GitHub text metadata');
  return value;
}
function pick(value, keys) {
  object(value);
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}
function latest(items, key) {
  const selected = new Map();
  for (const item of items) if (!selected.has(key(item)) || item.id > selected.get(key(item)).id) selected.set(key(item), item);
  return [...selected.values()].sort((a, b) => a.id - b.id);
}
function pageResult(items, response, command, total = null) {
  array(items);
  invariant(items.length <= command.per_page, 'READ_UPSTREAM_SHAPE_INVALID', 'GitHub exceeded the requested page');
  if (total !== null) count(total);
  const more = total === null ? response.hasNextPage : command.page * command.per_page < total;
  return { page: command.page, per_page: command.per_page, total_count: total,
    next_page: more ? command.page + 1 : null, has_more: more, items };
}
function completeCollection(response, key, max) {
  const data = object(response.data);
  const items = array(data[key]);
  const total = count(data.total_count);
  if (items.length > max || total > max || response.hasNextPage || items.length !== total) tooLarge('use_paged_query');
  return items;
}
async function repository(client, expected) {
  const data = object((await client.get()).data);
  invariant(typeof data.full_name === 'string' && data.full_name.toLowerCase() === expected.toLowerCase(),
    'READ_SCOPE_MISMATCH', 'GitHub repository identity differs from the resolved target');
  text(data.default_branch);
  return data;
}
function commitSummary(data, limits) {
  object(data);
  const commit = data.commit ?? data;
  const parents = array(data.parents);
  if (parents.length > limits.max_parent_commits) tooLarge('use_paged_query');
  return { sha: sha(data.sha), tree_sha: sha(commit.tree?.sha), parents: parents.map((parent) => sha(parent.sha)),
    authored_at: text(commit.author?.date), committed_at: text(commit.committer?.date),
    verified: boolean(commit.verification?.verified) };
}
async function gitCommit(client, value, limits) {
  const data = object((await client.get(`/git/commits/${sha(value)}`)).data);
  invariant(data.sha === value, 'READ_SCOPE_MISMATCH', 'Git commit identity does not match the request');
  return { ...commitSummary(data, limits), message: text(data.message) };
}
async function resolveRef(client, value, limits) {
  if (/^[0-9a-f]{40}$/.test(value)) return gitCommit(client, value, limits);
  const data = object((await client.get(`/commits/${encodeURIComponent(value)}`, { per_page: 1, page: 1 })).data);
  return commitSummary(data, limits);
}
async function readBranch(client, ref, limits) {
  const name = branchName(ref, limits);
  let data;
  try { data = object((await client.get(`/branches/${encodeURIComponent(name)}`)).data); }
  catch (error) {
    if (error.code === 'READ_GITHUB_ERROR' && error.details?.status === 404) return { ref: name, exists: false, sha: null, tree_sha: null };
    throw error;
  }
  invariant(data.name === name, 'READ_SCOPE_MISMATCH', 'Branch identity does not match the requested ref');
  const commitSha = sha(data.commit?.sha);
  const commit = await gitCommit(client, commitSha, limits);
  return { ref: name, exists: true, sha: commit.sha, tree_sha: commit.tree_sha };
}
async function getPull(client, number) {
  const pr = object((await client.get(`/pulls/${number}`)).data);
  invariant(pr.number === number, 'READ_SCOPE_MISMATCH', 'PR identity does not match the request');
  sha(pr.head?.sha); sha(pr.base?.sha);
  text(pr.head?.ref); text(pr.base?.ref); text(pr.updated_at);
  return pr;
}
function pullMarker(pr) {
  return { number: pr.number, head_sha: pr.head.sha, head_ref: pr.head.ref, base_sha: pr.base.sha, base_ref: pr.base.ref,
    head_repository_id: pr.head.repo?.id ?? null, base_repository_id: pr.base.repo?.id ?? null,
    state: pr.state, draft: pr.draft, merged: pr.merged, updated_at: pr.updated_at,
    commits: pr.commits, changed_files: pr.changed_files };
}
function assertPullUnmoved(before, after, expected) {
  if ((expected !== undefined && before.head.sha !== expected) || resultDigest(pullMarker(before)) !== resultDigest(pullMarker(after))) {
    throw new RepoRelayError('READ_FREEZE_MOVED', 'PR authority moved during the bounded read', {
      before_sha256: resultDigest(pullMarker(before)), after_sha256: resultDigest(pullMarker(after)),
    });
  }
}
async function reviews(client, pr, limits) {
  let after = null;
  let unresolved = 0;
  let seen = 0;
  let decision;
  const cursors = new Set();
  for (;;) {
    const data = object(await client.threads(pr.number, limits.max_read_page_size, after));
    invariant(data.number === pr.number, 'READ_SCOPE_MISMATCH', 'Review query returned another PR');
    if (data.headRefOid !== pr.head.sha || data.baseRefOid !== pr.base.sha) {
      throw new RepoRelayError('READ_FREEZE_MOVED', 'PR refs moved during the review observation');
    }
    if (decision !== undefined && decision !== data.reviewDecision) throw new RepoRelayError('READ_FREEZE_MOVED', 'Review decision moved during pagination');
    decision = data.reviewDecision;
    const threads = object(data.reviewThreads);
    const nodes = array(threads.nodes);
    const total = count(threads.totalCount);
    if (total > limits.max_review_threads || seen + nodes.length > limits.max_review_threads) tooLarge('use_paged_query');
    seen += nodes.length;
    unresolved += nodes.filter((node) => !boolean(node.isResolved)).length;
    if (!boolean(threads.pageInfo?.hasNextPage)) {
      invariant(seen === total, 'READ_UPSTREAM_SHAPE_INVALID', 'Review-thread pagination is incomplete');
      return { review_decision: decision, unresolved_review_thread_count: unresolved };
    }
    after = text(threads.pageInfo.endCursor);
    invariant(after.length > 0 && !cursors.has(after), 'READ_UPSTREAM_SHAPE_INVALID', 'Review pagination cursor did not advance');
    cursors.add(after);
  }
}
function checkProjection(run, exactSha) {
  invariant(run.head_sha === exactSha, 'READ_SCOPE_MISMATCH', 'Check run is not tied to the requested SHA');
  return { name: text(run.name), app_slug: run.app?.slug ?? null, id: integer(run.id),
    status: text(run.status), conclusion: text(run.conclusion, true) };
}
function statusProjection(status) {
  return { context: text(status.context), state: text(status.state), id: status.id === undefined ? null : integer(status.id) };
}
async function fullChecks(client, exactSha, limits) {
  const runsResponse = await client.get(`/commits/${exactSha}/check-runs`, { filter: 'latest', per_page: limits.max_check_runs, page: 1 });
  const statusesResponse = await client.get(`/commits/${exactSha}/status`, { per_page: limits.max_commit_statuses, page: 1 });
  invariant(statusesResponse.data?.sha === exactSha, 'READ_SCOPE_MISMATCH', 'Combined status is not tied to the requested SHA');
  const runs = completeCollection(runsResponse, 'check_runs', limits.max_check_runs).map((run) => checkProjection(run, exactSha));
  const statuses = completeCollection(statusesResponse, 'statuses', limits.max_commit_statuses).map(statusProjection);
  return { sha: exactSha, check_runs: latest(runs, (run) => `${run.app_slug}:${run.name}`),
    statuses: latest(statuses, (status) => status.context), combined_status: text(statusesResponse.data.state) };
}
function runProjection(run) {
  return { id: integer(run.id), name: text(run.name, true), status: text(run.status), conclusion: text(run.conclusion, true),
    event: text(run.event), run_number: integer(run.run_number), run_attempt: integer(run.run_attempt), head_sha: sha(run.head_sha) };
}
async function fullWorkflows(client, exactSha, limits) {
  const response = await client.get('/actions/runs', { head_sha: exactSha, per_page: limits.max_workflow_runs, page: 1 });
  const runs = completeCollection(response, 'workflow_runs', limits.max_workflow_runs).map(runProjection);
  invariant(runs.every((run) => run.head_sha === exactSha), 'READ_SCOPE_MISMATCH', 'Workflow evidence is not exact-SHA scoped');
  return { sha: exactSha, runs: runs.sort((a, b) => a.id - b.id) };
}
async function collectFreeze(client, command, limits) {
  const repo = await repository(client, command.repository);
  const defaultBranch = await readBranch(client, repo.default_branch, limits);
  invariant(defaultBranch.exists, 'READ_DEFAULT_BRANCH_MISSING', 'Default branch is missing');
  const branches = [];
  const commits = new Map([[defaultBranch.sha, defaultBranch.tree_sha]]);
  function remember(value, treeSha) {
    sha(value); sha(treeSha);
    if (!commits.has(value) && commits.size >= limits.max_freeze_shas) tooLarge('reduce_freeze_scope');
    invariant(!commits.has(value) || commits.get(value) === treeSha, 'READ_UPSTREAM_SHAPE_INVALID', 'One commit resolved to contradictory trees');
    commits.set(value, treeSha);
  }
  async function treeFor(value) {
    if (commits.has(value)) return commits.get(value);
    if (commits.size >= limits.max_freeze_shas) tooLarge('reduce_freeze_scope');
    const commit = await gitCommit(client, value, limits);
    remember(value, commit.tree_sha);
    return commit.tree_sha;
  }
  for (const ref of command.branches ?? []) {
    const branch = branchName(ref, limits) === defaultBranch.ref ? defaultBranch : await readBranch(client, ref, limits);
    branches.push(branch);
    if (branch.exists) remember(branch.sha, branch.tree_sha);
  }
  const prs = [];
  const markers = [];
  for (const number of command.prs ?? []) {
    const pr = await getPull(client, number);
    const item = { number, state: text(pr.state), draft: boolean(pr.draft), merged: boolean(pr.merged),
      mergeable: pr.mergeable === null ? null : boolean(pr.mergeable), mergeable_state: text(pr.mergeable_state),
      head_ref: pr.head.ref, head_sha: pr.head.sha, head_tree_sha: await treeFor(pr.head.sha),
      base_ref: pr.base.ref, base_sha: pr.base.sha, base_tree_sha: await treeFor(pr.base.sha),
      commit_count: count(pr.commits), changed_file_count: count(pr.changed_files) };
    if (command.include_reviews === true) Object.assign(item, await reviews(client, pr, limits));
    prs.push(item);
    markers.push(pullMarker(pr));
  }
  const issues = [];
  for (const number of command.issues ?? []) {
    const issue = object((await client.get(`/issues/${number}`)).data);
    invariant(issue.number === number && !issue.pull_request, 'READ_SCOPE_MISMATCH', 'Requested Issue is missing or is a PR');
    issues.push({ number, state: text(issue.state), state_reason: text(issue.state_reason, true), locked: boolean(issue.locked),
      comments_count: count(issue.comments), updated_at: text(issue.updated_at) });
  }
  const relevant = [...commits.keys()].sort();
  const checks = [];
  const workflows = [];
  for (const value of relevant) {
    if (command.include_checks === true) checks.push(await fullChecks(client, value, limits));
    if (command.include_workflows === true) workflows.push(await fullWorkflows(client, value, limits));
  }
  return { data: { schema_version: 1, stable: true,
    includes: { checks: command.include_checks === true, workflows: command.include_workflows === true, reviews: command.include_reviews === true },
    repository: { default_branch: repo.default_branch, default_branch_sha: defaultBranch.sha, default_branch_tree_sha: defaultBranch.tree_sha },
    branches, prs, issues, relevant_shas: relevant, checks, workflows }, markers };
}
async function freeze(client, command, limits, token) {
  const start = new Date().toISOString();
  const before = await collectFreeze(client, command, limits);
  const after = await collectFreeze(client, command, limits);
  const end = new Date().toISOString();
  if (resultDigest(before) !== resultDigest(after)) {
    throw new RepoRelayError('READ_FREEZE_MOVED', 'Authority changed during the bounded observation interval', {
      before_sha256: resultDigest(before), after_sha256: resultDigest(after),
    });
  }
  const safe = sanitizePublicRead('read.freeze', { ...after.data, observed_at_start: start, observed_at_end: end }, limits, [command.repository, token]);
  try { return sealReadResult(safe, limits); }
  catch (error) {
    if (error.code === 'READ_RESULT_TOO_LARGE') error.details.guidance = 'reduce_freeze_scope';
    throw error;
  }
}
async function readTree(client, treeSha, recursive, limits) {
  const data = object((await client.get(`/git/trees/${treeSha}`, recursive ? { recursive: '1' } : {})).data);
  invariant(data.sha === treeSha, 'READ_SCOPE_MISMATCH', 'Tree identity differs from the request');
  const entries = array(data.tree);
  if (data.truncated !== false || entries.length > limits.max_tree_entries) tooLarge('upstream_source_limit');
  return entries;
}
async function readFile(client, command, limits) {
  const commit = await resolveRef(client, command.ref, limits);
  let treeSha = commit.tree_sha;
  const parts = command.path.split('/');
  let entry;
  for (let i = 0; i < parts.length; i++) {
    const entries = await readTree(client, treeSha, false, limits);
    entry = entries.find((item) => item.path === parts[i]);
    invariant(entry, 'READ_NOT_FOUND', 'Requested file was not found at the resolved commit');
    if (i < parts.length - 1) {
      invariant(entry.type === 'tree' && entry.mode === '040000', 'READ_FILE_TYPE_INVALID', 'Path traversal through symlinks or submodules is forbidden');
      treeSha = sha(entry.sha);
    }
  }
  invariant(entry.type === 'blob' && ['100644', '100755'].includes(entry.mode), 'READ_FILE_TYPE_INVALID', 'Only regular UTF-8 repository files are supported');
  const blobSha = sha(entry.sha);
  const blob = object((await client.get(`/git/blobs/${blobSha}`)).data);
  invariant(blob.sha === blobSha && blob.encoding === 'base64' && typeof blob.content === 'string', 'READ_UPSTREAM_SHAPE_INVALID', 'Expected the exact file blob');
  const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
  invariant(bytes.byteLength === blob.size && crypto.createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex') === blobSha,
    'READ_BLOB_MISMATCH', 'File bytes do not match the Git blob identity');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new RepoRelayError('READ_TEXT_INVALID', 'Requested file is not UTF-8 text'); }
  return { path: command.path, ref: command.ref, commit_sha: commit.sha, tree_sha: commit.tree_sha, blob_sha: blobSha,
    mode: entry.mode, ...lineRange(content, command.start_line, command.end_line) };
}
function issueProjection(issue, command) {
  return { ...pick(issue, ['number', 'state', 'state_reason', 'locked', 'title', 'created_at', 'updated_at', 'closed_at', 'comments']),
    body: bodyResult(issue.body, command), author: issue.user?.login ?? null,
    labels: array(issue.labels).map((label) => typeof label === 'string' ? label : label.name),
    assignees: array(issue.assignees).map((person) => person.login), is_pull_request: Boolean(issue.pull_request) };
}
function privatePullProjection(pr, command) {
  return { ...pick(pr, ['number', 'state', 'draft', 'merged', 'mergeable', 'mergeable_state', 'title', 'created_at', 'updated_at', 'merged_at', 'closed_at', 'commits', 'changed_files']),
    body: bodyResult(pr.body, command), author: pr.user?.login ?? null,
    head_ref: pr.head.ref, head_sha: pr.head.sha, base_ref: pr.base.ref, base_sha: pr.base.sha };
}
function commentProjection(comment, command) {
  return { ...pick(comment, ['id', 'created_at', 'updated_at', 'path', 'line', 'original_line', 'in_reply_to_id', 'commit_id']),
    author: comment.user?.login ?? null, body: bodyResult(comment.body, command) };
}
async function getRun(client, number, target) {
  const run = object((await client.get(`/actions/runs/${number}`)).data);
  invariant(run.id === number && run.repository?.full_name?.toLowerCase() === target.toLowerCase(),
    'READ_SCOPE_MISMATCH', 'Workflow run does not belong to the resolved target');
  return run;
}
async function query(client, command, limits, repo) {
  const params = { page: command.page, per_page: command.per_page };
  switch (command.kind) {
    case 'repository': return pick(repo, ['id', 'full_name', 'private', 'visibility', 'default_branch', 'description', 'archived', 'disabled', 'created_at', 'updated_at', 'pushed_at']);
    case 'branch': return readBranch(client, command.ref, limits);
    case 'branches.list': {
      const response = await client.get('/branches', params);
      const items = array(response.data).map((branch) => ({ ref: text(branch.name), sha: sha(branch.commit?.sha), protected: boolean(branch.protected) }));
      return pageResult(items, response, command);
    }
    case 'commit': {
      const commit = await gitCommit(client, command.sha, limits);
      return { ...commit, message: bodyResult(commit.message, command) };
    }
    case 'commits.list': {
      const commit = await resolveRef(client, command.ref, limits);
      const response = await client.get('/commits', { ...params, sha: commit.sha });
      return { resolved_sha: commit.sha, ...pageResult(array(response.data).map((item) => commitSummary(item, limits)), response, command) };
    }
    case 'tree': {
      const commit = command.ref === undefined ? null : await resolveRef(client, command.ref, limits);
      const treeSha = command.tree_sha ?? commit.tree_sha;
      const entries = await readTree(client, treeSha, command.recursive === true, limits);
      const start = (command.page - 1) * command.per_page;
      const items = entries.slice(start, start + command.per_page).map((entry) => ({
        path: text(entry.path), mode: text(entry.mode), type: text(entry.type), sha: sha(entry.sha), size: entry.size ?? null,
      }));
      return { tree_sha: treeSha, commit_sha: commit?.sha ?? null, recursive: command.recursive === true,
        ...pageResult(items, { hasNextPage: false }, command, entries.length) };
    }
    case 'file': return readFile(client, command, limits);
    case 'compare': {
      const response = await client.get(`/compare/${command.base_sha}...${command.head_sha}`, params);
      const data = object(response.data);
      invariant(data.base_commit?.sha === command.base_sha, 'READ_SCOPE_MISMATCH', 'Compare base identity differs');
      return { base_sha: command.base_sha, head_sha: command.head_sha,
        ...pick(data, ['status', 'ahead_by', 'behind_by', 'total_commits']),
        merge_base_sha: sha(data.merge_base_commit?.sha), files_included: false,
        commits: pageResult(array(data.commits).map((item) => commitSummary(item, limits)), response, command, count(data.total_commits)) };
    }
    case 'code.search': {
      const response = await client.search(command.terms, command.page, command.per_page);
      const data = object(response.data);
      invariant(data.incomplete_results === false, 'READ_SEARCH_INCOMPLETE', 'GitHub search did not return complete requested results');
      const items = array(data.items).map((item) => {
        invariant(item.repository?.full_name?.toLowerCase() === command.repository.toLowerCase(), 'READ_SCOPE_MISMATCH', 'Search result escaped the target repository');
        return { path: text(item.path), name: text(item.name), sha: sha(item.sha) };
      });
      return { scope: 'target_default_branch_index', ...pageResult(items, response, command, count(data.total_count)) };
    }
    case 'issue': {
      const data = object((await client.get(`/issues/${command.issue}`)).data);
      invariant(data.number === command.issue, 'READ_SCOPE_MISMATCH', 'Issue identity differs');
      return issueProjection(data, command);
    }
    case 'issue.comments': {
      const response = await client.get(`/issues/${command.issue}/comments`, params);
      return { issue: command.issue, ...pageResult(array(response.data).map((comment) => commentProjection(comment, command)), response, command) };
    }
    case 'pr': return privatePullProjection(await getPull(client, command.pr), command);
    case 'pr.files':
    case 'pr.comments':
    case 'pr.reviews':
    case 'pr.diff':
    case 'pr.threads': {
      const before = await getPull(client, command.pr);
      if (command.expected_head_sha !== undefined && before.head.sha !== command.expected_head_sha) {
        throw new RepoRelayError('READ_FREEZE_MOVED', 'PR no longer matches the requested expected_head_sha');
      }
      let data;
      if (command.kind === 'pr.diff') {
        const response = await client.get(`/pulls/${command.pr}`, {}, { text: true });
        data = lineRange(response.data, command.start_line, command.end_line);
      } else if (command.kind === 'pr.threads') {
        const result = await client.threads(command.pr, command.per_page, command.after ?? null);
        invariant(result.number === command.pr && result.headRefOid === before.head.sha && result.baseRefOid === before.base.sha,
          'READ_FREEZE_MOVED', 'PR moved during review-thread observation');
        const threads = object(result.reviewThreads);
        const items = array(threads.nodes).map((thread) => ({ id: text(thread.id), is_resolved: boolean(thread.isResolved),
          is_outdated: boolean(thread.isOutdated), path: text(thread.path), line: thread.line ?? null, original_line: thread.originalLine ?? null }));
        invariant(items.length <= command.per_page, 'READ_UPSTREAM_SHAPE_INVALID', 'Review query exceeded its page');
        data = { review_decision: result.reviewDecision, total_count: count(threads.totalCount),
          per_page: command.per_page, after: command.after ?? null, has_more: boolean(threads.pageInfo?.hasNextPage),
          next_cursor: threads.pageInfo.hasNextPage ? text(threads.pageInfo.endCursor) : null, items };
      } else {
        const suffix = { 'pr.files': 'files', 'pr.comments': 'comments', 'pr.reviews': 'reviews' }[command.kind];
        const response = await client.get(`/pulls/${command.pr}/${suffix}`, params);
        const raw = array(response.data);
        const items = raw.map((item) => command.kind === 'pr.files'
          ? { ...pick(item, ['filename', 'previous_filename', 'status', 'additions', 'deletions', 'changes']), sha: sha(item.sha) }
          : command.kind === 'pr.comments' ? commentProjection(item, command)
            : { ...pick(item, ['id', 'state', 'submitted_at', 'commit_id']), author: item.user?.login ?? null, body: bodyResult(item.body, command) });
        if (command.kind === 'pr.files') {
          const wanted = Math.min(command.per_page, Math.max(0, before.changed_files - (command.page - 1) * command.per_page));
          invariant(items.length === wanted, 'READ_UPSTREAM_INCOMPLETE', 'GitHub did not return the complete requested file page');
        }
        data = pageResult(items, response, command, command.kind === 'pr.files' ? count(before.changed_files) : null);
      }
      const after = await getPull(client, command.pr);
      assertPullUnmoved(before, after, command.expected_head_sha);
      return { pr: command.pr, head_sha: before.head.sha, base_sha: before.base.sha, ...data };
    }
    case 'checks': {
      const runs = await client.get(`/commits/${command.sha}/check-runs`, { ...params, filter: 'latest' });
      const statuses = await client.get(`/commits/${command.sha}/status`, params);
      invariant(statuses.data?.sha === command.sha, 'READ_SCOPE_MISMATCH', 'Combined status is not exact-SHA scoped');
      return { sha: command.sha, combined_status: text(statuses.data.state),
        check_runs: pageResult(array(runs.data?.check_runs).map((run) => checkProjection(run, command.sha)), runs, command, count(runs.data.total_count)),
        statuses: pageResult(array(statuses.data.statuses).map(statusProjection), statuses, command, count(statuses.data.total_count)) };
    }
    case 'workflow.runs': {
      const response = await client.get('/actions/runs', { ...params, head_sha: command.sha });
      const items = array(response.data?.workflow_runs).map(runProjection);
      invariant(command.sha === undefined || items.every((run) => run.head_sha === command.sha), 'READ_SCOPE_MISMATCH', 'Workflow search escaped exact SHA scope');
      return pageResult(items, response, command, count(response.data.total_count));
    }
    case 'workflow.run': return runProjection(await getRun(client, command.run, command.repository));
    case 'workflow.jobs': {
      const run = await getRun(client, command.run, command.repository);
      const attempt = command.attempt ?? integer(run.run_attempt);
      invariant(attempt <= run.run_attempt, 'READ_FIELD_INVALID', 'Requested attempt does not exist');
      const response = await client.get(`/actions/runs/${command.run}/attempts/${attempt}/jobs`, params);
      const items = array(response.data?.jobs).map((job) => {
        invariant(job.run_id === command.run, 'READ_SCOPE_MISMATCH', 'Job escaped the requested run');
        const steps = array(job.steps);
        if (steps.length > limits.max_workflow_steps) tooLarge('reduce_page_or_line_range');
        return { ...pick(job, ['id', 'name', 'status', 'conclusion', 'started_at', 'completed_at']),
          steps: steps.map((step) => pick(step, ['number', 'name', 'status', 'conclusion', 'started_at', 'completed_at'])) };
      });
      return { run: command.run, run_attempt: attempt, head_sha: sha(run.head_sha),
        ...pageResult(items, response, command, count(response.data.total_count)) };
    }
    case 'workflow.job.log': {
      const job = object((await client.get(`/actions/jobs/${command.job}`)).data);
      integer(job.run_id);
      invariant(job.id === command.job && job.run_url === `https://api.github.com/repos/${command.repository}/actions/runs/${job.run_id}`,
        'READ_SCOPE_MISMATCH', 'Job does not belong to the target repository');
      const run = await getRun(client, job.run_id, command.repository);
      invariant(job.head_sha === run.head_sha, 'READ_SCOPE_MISMATCH', 'Job and run commit identity differ');
      const { data } = await client.jobLog(command.job);
      let start = command.start_line;
      let end = command.end_line;
      if (command.tail_lines !== undefined) {
        const lines = data === '' ? [] : data.split(/\r?\n/);
        if (lines.at(-1) === '') lines.pop();
        start = Math.max(1, lines.length - command.tail_lines + 1);
        end = Math.max(1, lines.length);
      }
      return { job: command.job, run: job.run_id, head_sha: sha(job.head_sha), ...lineRange(data, start, end) };
    }
    case 'workflow.artifacts': {
      const run = await getRun(client, command.run, command.repository);
      const response = await client.get(`/actions/runs/${command.run}/artifacts`, params);
      const items = array(response.data?.artifacts).map((artifact) => pick(artifact, ['id', 'name', 'size_in_bytes', 'expired', 'created_at', 'updated_at', 'expires_at', 'digest']));
      return { run: command.run, head_sha: sha(run.head_sha), metadata_only: true,
        ...pageResult(items, response, command, count(response.data.total_count)) };
    }
    default: throw new RepoRelayError('READ_KIND_UNSUPPORTED', 'Unknown typed query kind');
  }
}

export async function handleRead(token, policy, command, context = {}) {
  // The server-owned context is not a command field and cannot be spoofed in JSON.
  if (command.action === 'read.query') invariant(context.privateRelay === true, 'PRIVATE_RELAY_REQUIRED', 'read.query requires relay.private');
  const limits = readLimits(policy);
  validateReadCommand(command, limits);
  if (command.action === 'read.capabilities') {
    return sealReadResult(sanitizePublicRead(command.action, { schema_version: 1,
      observed_at: new Date().toISOString(), read_plane_version: READ_PLANE_VERSION,
      public_read_actions: [...PUBLIC_READ_ACTIONS], private_read_actions: [...PRIVATE_READ_ACTIONS], read_query_kinds: [...READ_QUERY_KINDS],
      limits, supports_fallback_freeze: true, supports_read_after_write_freeze: true }, limits), limits);
  }
  const client = new ReadClient(token, command.repository, limits);
  if (command.action === 'read.freeze') return freeze(client, command, limits, token);
  const repo = await repository(client, command.repository);
  invariant(repo.private === true, 'PRIVATE_READ_TARGET_REQUIRED', 'Sensitive read results require a private target conversation');
  const data = await query(client, command, limits, repo);
  return sealReadResult({ schema_version: 1, observed_at: new Date().toISOString(), query_kind: command.kind, data }, limits);
}
