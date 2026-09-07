import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, receiptMarker, commandHash, findReceipt } from '../src/core.mjs';
import { executeCommand, ACTION_REGISTRY, installedCapabilities } from '../src/handlers/index.mjs';
import { readLimits, validateReadCommand, PUBLIC_READ_ACTIONS, PRIVATE_READ_ACTIONS, resultDigest } from '../src/read-contract.mjs';
import { assertPublicRead, publicSuccessResult } from '../src/read-receipts.mjs';
import { PUBLIC_ACTIONS, assertPublicActionAllowed } from '../src/relay.mjs';

import { receiptBodyProof, assertBodyProofRequest } from './fixtures/receipt-body-proof.mjs';

const policy = await loadPolicy();
const limits = readLimits(policy);
const control = 'alescim17/github-chatops';
const alias = 'target/aether';
const original = { v: 1, request_id: 'prior-request', action: 'git.commit.atomic', repository: alias };
const command = { v: 1, request_id: 'lookup-request', action: 'read.request', repository: 'owner/private-target', lookup_request_id: original.request_id };
const context = { controlRepository: control, controlIssue: 3, controlToken: 'fake-control', targetAlias: alias };
const issueUrl = `https://api.github.com/repos/${control}/issues/3`;
const digest = 'a'.repeat(64);
const canaries = ['PRIVATE_SOURCE_CANARY', 'private/file.mjs', 'owner/private-target', 'PRIVATE_ISSUE_BODY', 'PRIVATE_WORKFLOW_LOG', 'ghp_canary123'];
function receipt(id, status = 'SUCCESS', overrides = {}, envelope) {
  const intent = { ...original, ...overrides };
  const payload = envelope ?? (status === 'STARTED' ? { accepted: true, private_relay: true } : { completed: status === 'SUCCESS', private_receipt: true });
  return { id, node_id: `fixture-comment-node-${id}`,
    url: `https://api.github.com/repos/${control}/issues/comments/${id}`,
    html_url: `https://github.com/${control}/issues/3#issuecomment-${id}`,
    user: { login: 'reporelay-control[bot]', id: 322612842, type: 'Bot', node_id: 'BOT_kgDOEzquag' },
    performed_via_github_app: { id: 4764725 },
    issue_url: issueUrl, created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:01Z',
    body: receiptMarker({ sourceCommentId: '900001', requestId: intent.request_id, action: intent.action, repository: intent.repository, status, hash: commandHash(intent) })
      + '\n**RepoRelay receipt**\n\n```json\n' + JSON.stringify(payload) + '\n```' };
}
const itemsOf = count => Array.from({ length: count }, (_, i) => ({ id: i + 1, body: 'ordinary bus comment' }));
function install(t, items, options = {}) {
  const calls = [];
  const reads = new Map();
  let lastExact;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    if (url.pathname === '/graphql') {
      assert.equal(init.headers.Authorization, 'Bearer fake-control', 'body proof uses only the control token');
      assertBodyProofRequest(init, lastExact);
      calls.push({ path: url.pathname, page: 0 });
      return new Response(JSON.stringify({ data: receiptBodyProof(lastExact) }));
    }
    assert.equal(init.method, 'GET', 'request recovery must never execute the original action');
    assert.equal(init.headers.Authorization, 'Bearer fake-control', 'target credentials must not be used for bus recovery');
    const page = Number(url.searchParams.get('page'));
    calls.push({ path: url.pathname, page });
    if (url.pathname === `/repos/${control}/issues/3/comments`) {
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.has('since'), false, 'complete lifetime history, never a recent window');
      reads.set(page, (reads.get(page) ?? 0) + 1);
      const data = options.page ? options.page(page, reads.get(page), items) : items.slice((page - 1) * 100, page * 100);
      return data instanceof Response ? data : new Response(JSON.stringify(data));
    }
    const match = url.pathname.match(/^\/repos\/alescim17\/github-chatops\/issues\/comments\/(\d+)$/);
    assert.ok(match, `unexpected target/source/workflow access: ${url.pathname}`);
    const id = Number(match[1]);
    const data = options.exact ? options.exact(id) : items.find(item => item.id === id);
    lastExact = data;
    return data instanceof Response ? data : new Response(JSON.stringify(data));
  });
  return calls;
}
const lookup = () => executeCommand('fake-target', policy, command, context);

for (const position of [20, 1001, 2501]) {
  test(`public lookup recovers SUCCESS at ${position} and scans all later history`, async t => {
    const items = itemsOf(position + 105); items[position - 1] = receipt(position);
    const before = JSON.stringify(items[position - 1]);
    const calls = install(t, items); const envelope = await lookup(); const result = envelope.result;
    assert.equal(result.found, true); assert.equal(result.status, 'SUCCESS'); assert.equal(result.terminal, true);
    assert.equal(result.repository, alias); assert.equal(result.source_comment_id, 900001);
    assert.equal(result.receipt_comment_id, position); assert.equal(result.command_hash, commandHash(original));
    assert.equal(result.private_receipt, true); assert.equal(envelope.result_sha256, resultDigest(result));
    assert.ok(envelope.result_bytes < 10240);
    assert.ok(calls.some(call => call.page > Math.ceil(position / 100)));
    assert.equal(calls.at(-1).path, `/repos/${control}/issues/comments/${position}`);
    assert.equal(JSON.stringify(items[position - 1]), before);
  });
}
for (const status of ['STARTED', 'FAILED']) {
  test(`lookup retains authoritative ${status} state`, async t => {
    install(t, [receipt(1, status)]); const { result } = await lookup();
    assert.equal(result.status, status); assert.equal(result.terminal, status !== 'STARTED');
    assert.equal(result.private_receipt, status === 'STARTED' ? undefined : true);
  });
}
test('exact comment re-read observes STARTED to SUCCESS in-place transition', async t => {
  const current = receipt(1, 'SUCCESS'); current.updated_at = '2026-09-07T00:00:02Z';
  install(t, [receipt(1, 'STARTED')], { exact: () => current });
  assert.equal((await lookup()).result.status, 'SUCCESS');
});
for (const count of [0, 1, 1000, 2501]) {
  test(`NOT_FOUND requires stable complete history and terminal page (${count})`, async t => {
    const calls = install(t, itemsOf(count)); const { result } = await lookup();
    assert.deepEqual(Object.keys(result).sort(), ['schema_version', 'observed_at', 'lookup_request_id', 'repository', 'found'].sort());
    assert.equal(result.found, false); assert.equal(calls.length, 2 * (Math.floor(count / 100) + 1));
  });
}
for (const mode of ['http', 'network', 'boundary', 'exact']) {
  test(`${mode} failure is never NOT_FOUND`, async t => {
    const items = itemsOf(1101); if (mode === 'exact') items[1000] = receipt(1001);
    install(t, items, { page: (page, count, data) => {
      if (mode === 'network' && page === 11) throw new Error('network failure');
      if ((mode === 'http' && page === 11) || (mode === 'boundary' && page === 1 && count === 2)) return new Response('{}', { status: 503 });
      return data.slice((page - 1) * 100, page * 100);
    }, exact: () => new Response('{}', { status: 404 }) });
    await assert.rejects(lookup, mode === 'network' ? /network failure/ : { code: 'GITHUB_API_ERROR' });
  });
}
for (const matched of [false, true]) {
  test(`deletion across scanned boundary fails closed after match=${matched}`, async t => {
    const items = itemsOf(1201); items[matched ? 19 : 1000] = receipt(matched ? 20 : 1001); let deleted = false;
    install(t, items, { page: (page, _count, data) => {
      if (page === 11 && !deleted) { data.shift(); deleted = true; }
      return data.slice((page - 1) * 100, page * 100);
    } });
    await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
test('movement of terminal page cannot establish absence', async t => {
  install(t, [{ id: 1, body: 'ordinary' }], { page: (_page, count, items) => count === 1 ? items : [...items, receipt(2)] });
  await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
});
for (const invalid of [null, {}, Array.from({ length: 101 }, (_, i) => ({ id: i + 1001 }))]) {
  test('malformed later page fails closed', async t => {
    install(t, itemsOf(1000), { page: (page, _count, items) => page === 11 ? invalid : items.slice((page - 1) * 100, page * 100) });
    await assert.rejects(lookup, { code: 'RECEIPT_PAGE_INVALID' });
  });
}
for (const invalid of [[{ id: 1000 }], [{ id: 1002 }, { id: 1001 }], [{ id: '1001' }]]) {
  test('overlapping, unordered and invalid IDs fail closed', async t => {
    install(t, itemsOf(1000), { page: (page, _count, items) => page === 11 ? invalid : items.slice((page - 1) * 100, page * 100) });
    await assert.rejects(lookup, { code: 'RECEIPT_SCAN_NOT_ADVANCING' });
  });
}
test('repository alias mismatch fails without returning cross-target metadata', async t => {
  install(t, [receipt(1, 'SUCCESS', { repository: 'target/streamforge' })]);
  await assert.rejects(lookup, error => error.code === 'REQUEST_TARGET_MISMATCH' && !JSON.stringify(error).includes('streamforge'));
});
for (const change of [{ action: 'issue.create' }, { extra_intent: 'conflict' }, {}]) {
  test('multiple historical request receipts are ambiguous, never first-match authority', async t => {
    const items = itemsOf(1101); items[0] = receipt(1); items[1100] = receipt(1101, 'FAILED', change);
    install(t, items); await assert.rejects(lookup, { code: 'REQUEST_ID_AMBIGUOUS' });
  });
}
for (const status of ['STARTED', 'FAILED']) {
  test(`terminal receipt cannot regress from SUCCESS to ${status}`, async t => {
    install(t, [receipt(1)], { exact: () => receipt(1, status) });
    await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
test('exact receipt identity change is a history error', async t => {
  install(t, [receipt(1)], { exact: () => receipt(1, 'SUCCESS', { action: 'issue.create' }) });
  await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
});
test('human and unrelated-App marker text cannot impersonate RepoRelay receipts', async t => {
  const human = receipt(1); human.user = { login: 'alescim17', id: 106375165, type: 'User' };
  const app = receipt(2); app.performed_via_github_app.id = 999;
  install(t, [human, app]); assert.equal((await lookup()).result.found, false);
});
test('malformed trusted receipt claiming exact request cannot become absence', async t => {
  const broken = receipt(1); broken.body = broken.body.replace(/command_hash=[0-9a-f]+/, 'command_hash=invalid');
  install(t, [broken]); await assert.rejects(lookup, { code: 'REQUEST_RECEIPT_INVALID' });
});
test('request identity matching is exact, not prefix matching', async t => {
  install(t, [receipt(1, 'SUCCESS', { request_id: 'prior-request-longer' })]);
  assert.equal((await lookup()).result.found, false);
});
test('replay scan rejects longer lookup id and quoted marker matches', async t => {
  const longer = receipt(1, 'SUCCESS', { request_id: 'lookup-request-longer' });
  const quoted = { id: 2, body: 'quoted text\n' + receipt(2, 'SUCCESS', { request_id: command.request_id }).body };
  install(t, [longer, quoted]);
  assert.equal(await findReceipt('fake-control', control, 3, '9000019', command.request_id), null);
});
for (const extra of [{ query: 'anything' }, { url: 'https://evil.invalid' }, { path: 'file.mjs' }, { lookup_source_comment_id: 4 }, { controlToken: 'injected' }]) {
  test('lookup rejects arbitrary selectors and context injection before I/O', async t => {
    const calls = install(t, []);
    await assert.rejects(() => executeCommand('fake-target', policy, { ...command, ...extra }, context), { code: 'READ_FIELDS_UNKNOWN' });
    assert.equal(calls.length, 0);
  });
}
for (const id of ['', 'a b', 'a'.repeat(121), command.request_id]) {
  test('lookup rejects invalid or self-referential request identity', () => {
    assert.throws(() => validateReadCommand({ ...command, lookup_request_id: id }, limits), { code: 'READ_REQUEST_ID_INVALID' });
  });
}
test('private query payload is redacted while safe integrity metadata is retained', async t => {
  const body = { completed: true, private_receipt: true, result_sha256: digest, result_bytes: 321, query_kind: 'file', result: { files: canaries }, message: canaries.join(' ') };
  install(t, [receipt(1, 'SUCCESS', { action: 'read.query' }, body)]);
  const envelope = await lookup();
  const published = publicSuccessResult(command, envelope, false, limits, ['owner/private-target', 'fake-control', 'fake-target']);
  for (const canary of canaries) assert.equal(JSON.stringify(published).includes(canary), false, canary);
  assert.equal(envelope.result.result_sha256, digest); assert.equal(envelope.result.result_bytes, 321);
  assert.equal(envelope.result.query_kind, 'file'); assert.equal(envelope.result.result, undefined);
});
test('private mutation result, error details and digest-shaped payload are never exposed', async t => {
  install(t, [receipt(1, 'FAILED', {}, { completed: false, private_receipt: true, result: canaries, details: canaries, result_sha256: digest, result_bytes: 123, query_kind: 'file' })]);
  const { result } = await lookup();
  for (const canary of canaries) assert.equal(JSON.stringify(result).includes(canary), false);
  for (const key of ['result', 'details', 'result_sha256', 'result_bytes', 'query_kind']) assert.equal(result[key], undefined);
});
test('public output rejects extra content and false terminal state', async t => {
  install(t, [receipt(1)]); const { result } = await lookup();
  assert.throws(() => assertPublicRead('read.request', { ...result, result: canaries }, limits), { code: 'PUBLIC_READ_RESULT_UNSAFE' });
  assert.throws(() => assertPublicRead('read.request', { ...result, terminal: false }, limits), { code: 'PUBLIC_READ_RESULT_UNSAFE' });
  assert.throws(() => assertPublicRead('read.request', { ...result, repository: 'owner/private-target' }, limits), { code: 'PUBLIC_READ_RESULT_UNSAFE' });
});

const publicMutations = ['pr.ready', 'pr.draft', 'pr.merge', 'workflow.rerun', 'workflow.rerun_failed', 'workflow.cancel', 'workflow.job.rerun', 'branch.delete_merged'];
const privateMutations = ['pr.create', 'pr.update', 'pr.reviewers.request', 'pr.reviewers.remove', 'pr.review', 'pr.review.dismiss', 'pr.thread.resolve', 'pr.thread.unresolve',
  'issue.create', 'issue.update', 'issue.labels.add', 'issue.labels.remove', 'issue.assignees.add', 'issue.assignees.remove', 'issue.lock', 'issue.unlock',
  'comment.create', 'comment.update', 'milestone.create', 'milestone.update', 'milestone.delete', 'workflow.dispatch',
  'branch.merge.fenced', 'branch.create', 'branch.update', 'branch.delete', 'git.commit.atomic', 'git.patch.atomic'];
test('capabilities publish complete exact installed mutation matrix without target I/O', async t => {
  const calls = install(t, []);
  const { result } = await executeCommand('fake-target', policy, { v: 1, request_id: 'capabilities', action: 'read.capabilities', repository: command.repository });
  assert.deepEqual(result.public_mutation_actions, publicMutations); assert.deepEqual(result.private_mutation_actions, privateMutations);
  assert.deepEqual(result.public_read_actions, PUBLIC_READ_ACTIONS); assert.deepEqual(result.private_read_actions, PRIVATE_READ_ACTIONS);
  assert.deepEqual(result.transport_actions, ['relay.private']); assert.equal(result.read_plane_version, '1.1.0'); assert.equal(calls.length, 0);
});
test('capability and public-channel lists cannot drift from executable registry', () => {
  const capabilities = installedCapabilities(); const names = Object.values(capabilities).flat();
  assert.equal(new Set(names).size, names.length); assert.deepEqual(names.sort(), Object.keys(ACTION_REGISTRY).sort());
  assert.ok(Object.isFrozen(ACTION_REGISTRY));
  for (const item of Object.values(ACTION_REGISTRY)) { assert.ok(Object.isFrozen(item)); assert.equal(typeof item.handler, 'function'); }
  assert.deepEqual([...PUBLIC_ACTIONS].sort(), [...PUBLIC_READ_ACTIONS, ...publicMutations].sort());
  for (const action of [...privateMutations, ...PRIVATE_READ_ACTIONS]) assert.throws(() => assertPublicActionAllowed(action), { code: 'PRIVATE_RELAY_REQUIRED' });
  capabilities.public_mutation_actions.push('invented.action'); assert.equal(installedCapabilities().public_mutation_actions.includes('invented.action'), false);
});
test('sanitizer refuses capability claims not executable by dispatcher', async () => {
  const { result } = await executeCommand('fake-target', policy, { v: 1, request_id: 'capabilities', action: 'read.capabilities', repository: command.repository });
  assert.throws(() => assertPublicRead('read.capabilities', { ...result, public_mutation_actions: [...result.public_mutation_actions, 'invented.action'] }, limits), { code: 'PUBLIC_READ_RESULT_UNSAFE' });
  await assert.rejects(() => executeCommand('fake-target', policy, { action: 'invented.action' }), { code: 'ACTION_UNSUPPORTED' });
});
