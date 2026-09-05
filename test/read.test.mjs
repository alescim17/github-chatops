import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { handleRead } from '../src/handlers/read.mjs';
import { readLimits, validateReadCommand, sealReadResult, verifyReadResult, resultDigest, canonicalSerialize, READ_QUERY_KINDS } from '../src/read-contract.mjs';
import { sanitizePublicRead, assertPublicRead, publicSuccessResult, privateReceiptBody, publicReadFailure } from '../src/read-receipts.mjs';
import { assertPublicActionAllowed } from '../src/relay.mjs';
import { createReceipt } from '../src/core.mjs';
import { target, A, B, C, D, fakeApi, privateCanaries } from './fixtures/read-api.mjs';

const policy = JSON.parse(await fs.readFile(new URL('../config/policy.json', import.meta.url), 'utf8'));
const limits = readLimits(policy);
const base = { v: 1, request_id: 'read-1', repository: target };
const freezeCommand = { ...base, action: 'read.freeze', branches: ['main', 'issue-183'], prs: [185], issues: [183],
  include_checks: true, include_workflows: true, include_reviews: true };
function install(t, options) {
  const api = fakeApi(options);
  const original = global.fetch;
  global.fetch = api.fetch;
  t.after(() => { global.fetch = original; });
  return api;
}
const query = (fields) => ({ ...base, action: 'read.query', ...fields });
const executeQuery = (fields) => handleRead('test-installation-token', policy, query(fields), { privateRelay: true });

test('read.capabilities is public, bounded, versioned, and makes no target request', async (t) => {
  const api = install(t);
  assert.doesNotThrow(() => assertPublicActionAllowed('read.capabilities'));
  const result = await handleRead('test-installation-token', policy, { ...base, action: 'read.capabilities' });
  assert.equal(result.result.supports_fallback_freeze, true);
  assert.equal(result.result.supports_read_after_write_freeze, true);
  assert.deepEqual(result.result.read_query_kinds, READ_QUERY_KINDS);
  assert.equal(result.result_bytes <= 10240, true);
  assert.equal(result.result_sha256, resultDigest(result.result));
  assert.equal(api.calls.length, 0);
});

test('read.freeze returns branch, PR, Issue, review, exact-SHA checks and workflow authority', async (t) => {
  const api = install(t);
  assert.doesNotThrow(() => assertPublicActionAllowed('read.freeze'));
  const envelope = await handleRead('test-installation-token', policy, freezeCommand);
  const result = envelope.result;
  assert.equal(result.stable, true);
  assert.deepEqual(result.repository, { default_branch: 'main', default_branch_sha: A, default_branch_tree_sha: C });
  assert.equal(result.branches[1].tree_sha, D);
  assert.equal(result.prs[0].head_sha, B);
  assert.equal(result.prs[0].base_sha, A);
  assert.equal(result.prs[0].draft, true);
  assert.equal(result.prs[0].unresolved_review_thread_count, 1);
  assert.equal(result.issues[0].state, 'open');
  assert.equal(result.issues[0].locked, false);
  assert.deepEqual(result.relevant_shas, [A, B]);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[0].check_runs[0].conclusion, 'success');
  assert.equal(result.checks[0].statuses[0].id, 42);
  assert.equal(result.workflows[1].runs[0].head_sha, B);
  assert.ok(Date.parse(result.observed_at_end) >= Date.parse(result.observed_at_start));
  assert.ok(api.counters.get('/repos/owner/private-target/branches/main:') >= 2);
  for (const secret of privateCanaries) assert.equal(JSON.stringify(publicSuccessResult(freezeCommand, envelope, false, limits)).includes(secret), false, secret);
});

for (const race of ['branch', 'pr-head', 'pr-base', 'issue', 'checks', 'workflows', 'reviews']) {
  test(`freeze fails closed on ${race} movement`, async (t) => {
    install(t, { race });
    await assert.rejects(() => handleRead('test-installation-token', policy, freezeCommand), (error) => error.code === 'READ_FREEZE_MOVED');
  });
}

test('missing requested branch is explicit and cannot masquerade as an empty SHA', async (t) => {
  install(t);
  const envelope = await handleRead('test-installation-token', policy, { ...base, action: 'read.freeze', branches: ['missing'] });
  assert.deepEqual(envelope.result.branches, [{ ref: 'missing', exists: false, sha: null, tree_sha: null }]);
});

test('public query is rejected before fetching any target content; JSON cannot spoof private context', async (t) => {
  const api = install(t);
  assert.throws(() => assertPublicActionAllowed('read.query'), { code: 'PRIVATE_RELAY_REQUIRED' });
  await assert.rejects(() => handleRead('test-installation-token', policy, query({ kind: 'repository', privateRelay: true })), { code: 'PRIVATE_RELAY_REQUIRED' });
  assert.equal(api.calls.length, 0);
});

test('private query refuses a public target conversation', async (t) => {
  const api = install(t, { publicTarget: true });
  await assert.rejects(() => executeQuery({ kind: 'file', ref: B, path: 'demo.mjs', start_line: 1, end_line: 2 }), { code: 'PRIVATE_READ_TARGET_REQUIRED' });
  assert.equal(api.calls.length, 1);
});

test('unknown kind and generic API escape fields fail before network access', async (t) => {
  const api = install(t);
  await assert.rejects(() => executeQuery({ kind: 'read.http', url: 'https://evil.invalid' }), { code: 'READ_KIND_UNSUPPORTED' });
  for (const field of ['api_path', 'rest_path', 'url', 'method', 'graphql', 'query_text', 'privateRelay']) {
    await assert.rejects(() => executeQuery({ kind: 'repository', [field]: 'arbitrary' }), { code: 'READ_FIELDS_UNKNOWN' });
  }
  for (const action of ['read.capabilities', 'read.freeze']) {
    await assert.rejects(() => handleRead('test-installation-token', policy, { ...base, action, unexpected: true }), { code: 'READ_FIELDS_UNKNOWN' });
  }
  assert.equal(api.calls.length, 0);
});

for (const path of ['../secret', '/absolute', 'a\0b', 'a\nb', 'a\u202eb', 'C:\\secret', 'a/../b', 'a//b', 'x'.repeat(513)]) {
  test(`path validation rejects ${JSON.stringify(path)}`, async (t) => {
    const api = install(t);
    await assert.rejects(() => executeQuery({ kind: 'file', ref: B, path, start_line: 1, end_line: 2 }), { code: 'READ_PATH_INVALID' });
    assert.equal(api.calls.length, 0);
  });
}

test('strict collections, ranges, integers, refs and exact-SHA checks cannot be weakened', () => {
  const invalid = [
    { ...freezeCommand, branches: Array.from({ length: 9 }, (_, i) => `b${i}`) },
    { ...freezeCommand, branches: ['main', 'refs/heads/main'] },
    { ...freezeCommand, include_checks: 'true' },
    query({ kind: 'checks', sha: 'main', page: 1, per_page: 1 }),
    query({ kind: 'branches.list', page: '1', per_page: 1 }),
    query({ kind: 'branches.list', page: 1, per_page: 101 }),
    query({ kind: 'tree', ref: B, tree_sha: D, page: 1, per_page: 1 }),
    query({ kind: 'file', ref: '../main', path: 'demo.mjs', start_line: 1, end_line: 2 }),
    query({ kind: 'file', ref: B, path: 'demo.mjs', start_line: 1, end_line: 121 }),
    query({ kind: 'workflow.job.log', job: 66, tail_lines: 2, start_line: 1, end_line: 2 }),
  ];
  for (const command of invalid) assert.throws(() => validateReadCommand(command, limits));
});

const cases = [
  { kind: 'repository' }, { kind: 'branch', ref: 'main' }, { kind: 'branches.list', page: 1, per_page: 2 },
  { kind: 'commit', sha: B }, { kind: 'commits.list', ref: B, page: 1, per_page: 2 },
  { kind: 'tree', tree_sha: D, page: 1, per_page: 2 }, { kind: 'file', ref: B, path: 'demo.mjs', start_line: 1, end_line: 2 },
  { kind: 'compare', base_sha: A, head_sha: B, page: 1, per_page: 2 }, { kind: 'code.search', terms: ['literal'], page: 1, per_page: 2 },
  { kind: 'issue', issue: 183 }, { kind: 'issue.comments', issue: 183, page: 1, per_page: 2 },
  { kind: 'pr', pr: 185 }, { kind: 'pr.files', pr: 185, page: 1, per_page: 2 },
  { kind: 'pr.diff', pr: 185, expected_head_sha: B, start_line: 1, end_line: 2 },
  { kind: 'pr.comments', pr: 185, page: 1, per_page: 2 }, { kind: 'pr.reviews', pr: 185, page: 1, per_page: 2 },
  { kind: 'pr.threads', pr: 185, per_page: 2 }, { kind: 'checks', sha: B, page: 1, per_page: 2 },
  { kind: 'workflow.runs', sha: B, page: 1, per_page: 2 }, { kind: 'workflow.run', run: 55 },
  { kind: 'workflow.jobs', run: 55, page: 1, per_page: 2 }, { kind: 'workflow.job.log', job: 66, tail_lines: 2 },
  { kind: 'workflow.artifacts', run: 55, page: 1, per_page: 2 },
];
for (const fields of cases) {
  test(`typed private ${fields.kind} returns a complete requested result with matching digest`, async (t) => {
    const api = install(t);
    const envelope = await executeQuery(fields);
    assert.equal(envelope.result.query_kind, fields.kind);
    assert.equal(envelope.result_sha256, resultDigest(envelope.result));
    assert.ok(envelope.result_bytes <= limits.max_read_result_bytes);
    const publicResult = publicSuccessResult(query(fields), envelope, true, limits);
    assert.deepEqual(Object.keys(publicResult).sort(), ['completed', 'private_receipt', 'query_kind', 'result_bytes', 'result_sha256'].sort());
    for (const secret of privateCanaries) assert.equal(JSON.stringify(publicResult).includes(secret), false);
    const body = privateReceiptBody(query(fields), 'SUCCESS', envelope, limits);
    const parsed = JSON.parse(body.split('```json\n')[1].split('\n```')[0]);
    assert.deepEqual(parsed, envelope);
    for (const call of api.calls) {
      assert.ok(call.method === 'GET' || (call.method === 'POST' && new URL(call.url).pathname === '/graphql' && JSON.parse(call.body).query.startsWith('query ')));
    }
  });
}

test('all required query kinds are exercised by a successful target-scoped test', () => {
  assert.deepEqual(cases.map((item) => item.kind).sort(), [...READ_QUERY_KINDS].sort());
});

test('query file includes exact blob SHA and explicit range, not a silently truncated body', async (t) => {
  const api = install(t);
  const { result } = await executeQuery({ kind: 'file', ref: B, path: 'demo.mjs', start_line: 2, end_line: 2 });
  assert.equal(result.data.blob_sha, api.blobSha);
  assert.equal(result.data.text, 'second line');
  assert.equal(result.data.total_lines, 3);
  assert.equal(result.data.has_more, true);
});

test('file content rejects non-UTF-8 bytes and symlinks rather than resolving them', async (t) => {
  install(t, { fileBytes: Buffer.from([255]) });
  await assert.rejects(() => executeQuery({ kind: 'file', ref: B, path: 'demo.mjs', start_line: 1, end_line: 1 }), { code: 'READ_TEXT_INVALID' });
});
test('file symlink mode is forbidden', async (t) => {
  install(t, { fileMode: '120000' });
  await assert.rejects(() => executeQuery({ kind: 'file', ref: B, path: 'demo.mjs', start_line: 1, end_line: 1 }), { code: 'READ_FILE_TYPE_INVALID' });
});

test('search terms cannot broaden repository scope', async (t) => {
  const api = install(t);
  for (const term of ['repo:other/repo', 'org:other', 'user:other', 'OR', 'x OR y', 'x"', 'x\n']) {
    await assert.rejects(() => executeQuery({ kind: 'code.search', terms: [term], page: 1, per_page: 2 }), { code: 'READ_SEARCH_INVALID' });
  }
  assert.equal(api.calls.length, 0);
});
test('cross-repository search result fails closed', async (t) => {
  install(t, { searchEscape: true });
  await assert.rejects(() => executeQuery({ kind: 'code.search', terms: ['safe'], page: 1, per_page: 2 }), { code: 'READ_SCOPE_MISMATCH' });
});
for (const kind of ['workflow.jobs', 'workflow.job.log']) {
  test(`${kind} cannot escape the target repository`, async (t) => {
    const api = install(t, { jobEscape: true });
    const fields = kind === 'workflow.jobs' ? { kind, run: 55, page: 1, per_page: 2 } : { kind, job: 66, tail_lines: 2 };
    await assert.rejects(() => executeQuery(fields), { code: 'READ_SCOPE_MISMATCH' });
    assert.equal(api.calls.some((call) => call.url.includes('/logs')), false);
  });
}

test('signed log redirect is target-originated, GET-only, bounded, and never receives the GitHub token', async (t) => {
  const api = install(t, { logRedirect: 'https://example.blob.core.windows.net/log?sig=private' });
  const result = await executeQuery({ kind: 'workflow.job.log', job: 66, tail_lines: 1 });
  assert.equal(result.result.data.text, 'last');
  assert.equal(api.calls.at(-1).headers.Authorization, undefined);
});
test('log redirect to arbitrary HTTP or unapproved hosts is forbidden', async (t) => {
  install(t, { logRedirect: 'https://attacker.invalid/log' });
  await assert.rejects(() => executeQuery({ kind: 'workflow.job.log', job: 66, tail_lines: 1 }), { code: 'READ_LOG_REDIRECT_INVALID' });
});

test('result bounds count UTF-8 bytes and never truncate authoritative output', () => {
  const value = { schema_version: 1, observed_at: '2026-09-05T18:00:00Z', query_kind: 'file', data: '😀'.repeat(3000) };
  assert.throws(() => sealReadResult(value, limits), (error) => error.code === 'READ_RESULT_TOO_LARGE' && error.details.result_bytes > 12000);
});
test('private compact receipt transports the complete near-limit result, including its digest', () => {
  const value = { schema_version: 1, observed_at: '2026-09-05T18:00:00Z', query_kind: 'file', data: Array.from({ length: 250 }, () => ({ a: 'x'.repeat(30) })) };
  const envelope = sealReadResult(value, limits);
  assert.ok(JSON.stringify(envelope, null, 2).length > 12000);
  const body = privateReceiptBody(query({ kind: 'file' }), 'SUCCESS', envelope, limits);
  const parsed = JSON.parse(body.split('```json\n')[1].split('\n```')[0]);
  assert.deepEqual(parsed, envelope);
});
test('canonical digest is independent of key ordering and changes when result data changes', () => {
  assert.equal(resultDigest({ b: [2, { c: 3 }], a: 1 }), resultDigest({ a: 1, b: [2, { c: 3 }] }));
  assert.notEqual(resultDigest({ a: 1 }), resultDigest({ a: 2 }));
  const envelope = sealReadResult({ a: 1 }, limits);
  assert.throws(() => verifyReadResult({ ...envelope, result_sha256: '0'.repeat(64) }, limits), { code: 'READ_DIGEST_MISMATCH' });
});

test('upstream truncation cannot be reported as a successful tree read', async (t) => {
  install(t, { intercept: (url) => url.pathname.includes('/git/trees/') ? new Response(JSON.stringify({ sha: D, truncated: true, tree: [] })) : undefined });
  await assert.rejects(() => executeQuery({ kind: 'tree', tree_sha: D, page: 1, per_page: 1 }), { code: 'READ_RESULT_TOO_LARGE' });
});
test('incomplete search and oversized source fail closed', async (t) => {
  install(t, { intercept: (url) => url.pathname === '/search/code' ? new Response(JSON.stringify({ total_count: 1, incomplete_results: true, items: [] })) : undefined });
  await assert.rejects(() => executeQuery({ kind: 'code.search', terms: ['safe'], page: 1, per_page: 1 }), { code: 'READ_SEARCH_INCOMPLETE' });
});
test('response byte guard rejects oversized upstream body before consuming it', async (t) => {
  install(t, { intercept: () => new Response('x', { headers: { 'content-length': String(limits.max_read_source_bytes + 1) } }) });
  await assert.rejects(() => executeQuery({ kind: 'repository' }), { code: 'READ_RESULT_TOO_LARGE' });
});
test('full freeze refuses a partially returned exact-SHA check collection', async (t) => {
  install(t, { intercept: (url) => url.pathname.endsWith('/check-runs') ? new Response(JSON.stringify({ total_count: 2, check_runs: [] })) : undefined });
  await assert.rejects(() => handleRead('test-installation-token', policy, freezeCommand), { code: 'READ_RESULT_TOO_LARGE' });
});

test('public sanitizer removes intentionally sensitive fields and rejects unvalidated receipt extras', async (t) => {
  install(t, { secretLabel: true });
  const { result } = await handleRead('test-installation-token', policy, freezeCommand);
  const injected = structuredClone(result);
  injected.repository.full_name = target;
  injected.prs[0].body = 'PRIVATE_PR_BODY';
  injected.issues[0].comments = ['PRIVATE_COMMENT_BODY'];
  injected.files = [{ path: 'src/private-source.mjs', content: 'PRIVATE_SOURCE_CONTENT' }];
  injected.credentials = 'ghp_secret_credential';
  const safe = sanitizePublicRead('read.freeze', injected, limits, [target, 'test-installation-token']);
  for (const secret of privateCanaries) assert.equal(JSON.stringify(safe).includes(secret), false, secret);
  assert.equal(safe.checks[0].check_runs[0].name, '[redacted]');
  assert.throws(() => assertPublicRead('read.freeze', injected, limits), { code: 'PUBLIC_READ_RESULT_UNSAFE' });
  assert.doesNotThrow(() => assertPublicRead('read.freeze', result, limits));
});

test('public mutation receipts remain minimal for every existing content-bearing mutation family', () => {
  for (const action of ['git.commit.atomic', 'git.patch.atomic', 'pr.update', 'issue.update', 'comment.create', 'workflow.dispatch']) {
    const result = publicSuccessResult({ action }, { repository: target, content: privateCanaries }, true, limits);
    assert.deepEqual(result, { completed: true, private_receipt: true });
  }
});
test('private query cannot claim success without actual private result delivery', () => {
  const envelope = sealReadResult({ schema_version: 1, query_kind: 'repository', observed_at: '2026-09-05T18:00:00Z', data: {} }, limits);
  assert.throws(() => publicSuccessResult(query({ kind: 'repository' }), envelope, false, limits), { code: 'PRIVATE_RECEIPT_WRITE_FAILED' });
});
test('safe public read-failure guidance cannot leak raw errors or private before/after payloads', () => {
  const failure = publicReadFailure({ code: 'READ_FREEZE_MOVED', details: { before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64), before: target, body: 'PRIVATE_PR_BODY' } });
  assert.deepEqual(failure, { guidance: 'new_request_id', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) });
});

test('core public typed-read transport preserves a valid near-limit envelope without slicing', async (t) => {
  install(t);
  const { result } = await handleRead('test-installation-token', policy, freezeCommand);
  result.checks[0].observed_check_run_count = 45;
  result.checks[0].check_runs = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, name: `Check ${i}`, app_slug: 'github-actions', status: 'completed', conclusion: 'success' }));
  const envelope = sealReadResult(result, limits);
  const receipt = publicSuccessResult(freezeCommand, envelope, false, limits);
  assert.ok(JSON.stringify(receipt, null, 2).length > 12000);
  let body;
  global.fetch = async (url, options) => { body = JSON.parse(options.body).body; return new Response(JSON.stringify({ id: 1 })); };
  await createReceipt('control-token', 'owner/control', 3, '1', { ...freezeCommand, repository: 'target/example' }, 'SUCCESS', receipt);
  const parsed = JSON.parse(body.split('```json\n')[1].split('\n```')[0]);
  assert.equal(parsed.result_sha256, resultDigest(parsed.result));
  assert.equal(canonicalSerialize(parsed.result), canonicalSerialize(result));
});
