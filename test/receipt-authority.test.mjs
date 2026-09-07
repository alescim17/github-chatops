import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, commandHash, receiptMarker } from '../src/core.mjs';
import { executeCommand } from '../src/handlers/index.mjs';
import { isRepoRelayReceipt, isLegacyReceipt } from '../src/receipt-authority.mjs';

const policy = await loadPolicy();
const control = 'alescim17/github-chatops', target = 'owner/private-target', alias = 'target/aether';
const intent = { v: 1, request_id: 'legacy-request', action: 'read.capabilities', repository: alias };
const lookup = { v: 1, request_id: 'authority-lookup', action: 'read.request', repository: target, lookup_request_id: intent.request_id };
const context = { controlRepository: control, controlIssue: 3, controlToken: 'fake-control', targetAlias: alias };
const sha = 'a'.repeat(40), main = 'b'.repeat(40);
const canaries = ['PRIVATE_PAYLOAD_CANARY', 'private/source.mjs', target, 'PRIVATE_LOG_CANARY'];
function fixture(status = 'SUCCESS', privateRead = false) {
  const original = privateRead ? { ...intent, action: 'read.query', kind: 'file', path: 'private/source.mjs', ref: sha, start_line: 1, end_line: 5 } : { ...intent };
  const outer = privateRead ? { v: 1, request_id: intent.request_id, action: 'relay.private', repository: alias, source_comment_id: 2000 } : original;
  const source = { id: 1000, body: '/reporelay\n' + JSON.stringify(outer), user: { login: 'alescim17', id: 106375165 },
    issue_url: `https://api.github.com/repos/${control}/issues/3`, created_at: '2026-09-07T00:00:00Z', updated_at: '2026-09-07T00:00:00Z' };
  const privateSource = { ...source, id: 2000, issue_url: `https://api.github.com/repos/${target}/issues/84`, body: '/reporelay-private\n' + JSON.stringify(original) };
  const receipt = { id: 1, issue_url: source.issue_url, user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }, performed_via_github_app: { id: 15368 },
    created_at: '2026-09-07T00:00:10Z', updated_at: '2026-09-07T00:00:20Z',
    body: receiptMarker({ sourceCommentId: 1000, requestId: original.request_id, action: original.action, repository: alias, hash: commandHash(original), status })
      + '\n```json\n' + JSON.stringify({ completed: status === 'SUCCESS', accepted: true, private_receipt: true,
        result_sha256: 'c'.repeat(64), result_bytes: 999, query_kind: 'file', result: canaries }) + '\n```' };
  const run = { id: 3000, workflow_id: 123, path: '.github/workflows/reporelay.yml', event: 'issue_comment', head_branch: 'main',
    repository: { full_name: control }, head_repository: { full_name: control }, actor: { login: 'alescim17' }, head_sha: sha,
    created_at: '2026-09-07T00:00:01Z', updated_at: '2026-09-07T00:00:30Z', status: 'completed', conclusion: status === 'SUCCESS' ? 'failure' : 'success' };
  const job = { id: 4000, name: 'execute', run_id: 3000, status: 'completed', started_at: '2026-09-07T00:00:02Z', completed_at: '2026-09-07T00:00:30Z' };
  const event = { status, request_id: original.request_id, action: original.action, target: alias };
  return { source, privateSource, original, receipt, run, job, event, privateRead };
}
function install(t, data, mutate = () => {}) {
  const calls = [], counts = new Map();
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input), path = url.pathname;
    assert.equal(init.method, 'GET', 'legacy proof may read intent but must never execute it');
    const bus = path === `/repos/${control}/issues/3/comments` || path === `/repos/${control}/issues/comments/1`;
    assert.equal(init.headers.Authorization, bus ? 'Bearer fake-control' : 'Bearer fake-target');
    calls.push(path); counts.set(path, (counts.get(path) ?? 0) + 1);
    const call = { path, count: counts.get(path), response: null }; mutate(data, call);
    if (call.response) return call.response;
    let result;
    if (path === `/repos/${control}/issues/3/comments`) result = [data.receipt];
    else if (path === `/repos/${control}/issues/comments/1`) result = data.receipt;
    else if (path === `/repos/${control}/issues/comments/1000`) result = data.source;
    else if (path === `/repos/${target}/issues/comments/2000`) result = data.privateSource;
    else if (path === `/repos/${control}/actions/workflows/reporelay.yml`) result = { id: 123, path: '.github/workflows/reporelay.yml' };
    else if (path === `/repos/${control}/branches/main`) result = { name: 'main', commit: { sha: main } };
    else if (path === `/repos/${control}/actions/workflows/123/runs`) {
      assert.equal(url.searchParams.get('event'), 'issue_comment');
      assert.match(url.searchParams.get('created'), /^2026-09-06T23:59:59.000Z\.\.2026-09-07T00:00:11.000Z$/);
      result = { total_count: 1, workflow_runs: [data.run] };
    } else if (path === `/repos/${control}/compare/${sha}...${main}`) result = { status: 'ahead', merge_base_commit: { sha } };
    else if (path === `/repos/${control}/actions/runs/3000/jobs`) result = { total_count: 1, jobs: [data.job] };
    else if (path === `/repos/${control}/actions/jobs/4000/logs`) return new Response('PRIVATE_LOG_CANARY\n2026-09-07T00:00:21.123456Z ' + JSON.stringify(data.event) + '\n');
    else throw new Error('Unexpected legacy proof route');
    return new Response(JSON.stringify(result));
  });
  return calls;
}
const read = () => executeCommand('fake-target', policy, lookup, context);

for (const status of ['SUCCESS', 'FAILED']) {
  test(`legacy ${status} requires immutable owner intent and exact trusted workflow log, not conclusion`, async t => {
    const data = fixture(status); const before = JSON.stringify(data); const calls = install(t, data);
    const { result } = await read();
    assert.equal(result.found, true); assert.equal(result.status, status); assert.equal(result.terminal, true);
    assert.equal(result.command_hash, commandHash(data.original)); assert.ok(calls.some(path => path.endsWith('/logs')));
    assert.equal(JSON.stringify(data), before);
    for (const key of ['result', 'private_receipt', 'result_sha256', 'result_bytes', 'query_kind']) assert.equal(result[key], undefined);
    for (const canary of canaries) assert.equal(JSON.stringify(result).includes(canary), false);
  });
}
test('legacy private command proof is hash-bound without exposing source, result or log content', async t => {
  const data = fixture('SUCCESS', true); const calls = install(t, data); const { result } = await read();
  assert.equal(result.found, true); assert.equal(result.action, 'read.query');
  assert.equal(result.command_hash, commandHash(data.original));
  assert.equal(calls.filter(path => path === `/repos/${target}/issues/comments/2000`).length, 2);
  for (const canary of canaries) assert.equal(JSON.stringify(result).includes(canary), false);
});
for (const modify of [
  data => { data.source.user.login = 'github-actions[bot]'; },
  data => { data.source.updated_at = '2026-09-07T00:00:01Z'; },
  data => { data.source.body = '/reporelay\n' + JSON.stringify({ ...intent, request_id: 'different-request' }); },
  data => { data.receipt.body = data.receipt.body.replace(commandHash(data.original), 'd'.repeat(64)); },
  data => { data.run.workflow_id = 999; data.run.path = '.github/workflows/attacker.yml'; },
  data => { data.run.path = '.github/workflows/attacker.yml'; },
  data => { data.run.head_branch = 'untrusted-branch'; },
  data => { data.run.actor.login = 'github-actions[bot]'; },
  data => { data.run.repository.full_name = 'owner/untrusted'; },
  data => { data.run.head_repository.full_name = 'owner/untrusted'; },
  data => { data.event.status = 'FAILED'; },
  data => { data.event.action = 'issue.create'; },
  data => { data.event.request_id = 'different-request'; },
  data => { data.event.target = 'target/streamforge'; },
]) {
  test('generic Actions receipt forgery cannot establish RepoRelay request authority', async t => {
    const data = fixture(); modify(data); install(t, data);
    await assert.rejects(read, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
  });
}
test('workflow logs from a non-ancestor candidate cannot authenticate a legacy receipt', async t => {
  install(t, fixture(), (_data, call) => { if (call.path.includes('/compare/')) call.response = new Response(JSON.stringify({ status: 'diverged', merge_base_commit: { sha: 'c'.repeat(40) } })); });
  await assert.rejects(read, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
});
test('multiple matching execution log records cannot select an arbitrary proof', async t => {
  install(t, fixture(), (data, call) => { if (call.path.endsWith('/logs')) call.response = new Response(('2026-09-07T00:00:21Z ' + JSON.stringify(data.event) + '\n').repeat(2)); });
  await assert.rejects(read, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
});
for (const route of ['/actions/workflows/reporelay.yml', '/actions/jobs/4000/logs']) {
  test('missing/expired/API-failed workflow proof is an error, never NOT_FOUND or accepted authority', async t => {
    install(t, fixture(), (_data, call) => { if (call.path.endsWith(route)) call.response = new Response('{}', { status: 404 }); });
    await assert.rejects(read, { code: 'READ_GITHUB_ERROR' });
  });
}
test('incomplete workflow proof pagination cannot manufacture authority', async t => {
  install(t, fixture(), (data, call) => { if (call.path.endsWith('/123/runs')) call.response = new Response(JSON.stringify({ total_count: 2, workflow_runs: [data.run] })); });
  await assert.rejects(read, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
});
test('legacy STARTED without execution proof fails closed rather than trusting a generic writer', async t => {
  const calls = install(t, fixture('STARTED'));
  await assert.rejects(read, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
  assert.equal(calls.some(path => path.includes('/actions/')), false);
});
test('legacy dispatch without immutable source intent fails closed', async t => {
  const data = fixture(); data.receipt.body = data.receipt.body.replace('source_comment_id=1000', 'source_comment_id=dispatch-123');
  install(t, data); await assert.rejects(read, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
});
for (const field of ['source', 'receipt', 'privateSource']) {
  test(`legacy ${field} changing while proof is read invalidates recovery`, async t => {
    install(t, fixture('SUCCESS', field === 'privateSource'), (data, call) => {
      const id = field === 'source' ? 1000 : field === 'receipt' ? 1 : 2000;
      if (call.path.endsWith(`/issues/comments/${id}`) && call.count === 2) data[field].updated_at = '2026-09-07T00:00:22Z';
    });
    await assert.rejects(read, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
test('RepoRelay App writer binding includes both application and actor identity', () => {
  const data = fixture(); assert.equal(isRepoRelayReceipt(data.receipt), false); assert.equal(isLegacyReceipt(data.receipt), true);
  const actual = { ...data.receipt, user: { login: 'reporelay-control[bot]', id: 322612842, type: 'Bot' }, performed_via_github_app: { id: 4764725 } };
  assert.equal(isRepoRelayReceipt(actual), true);
  assert.equal(isRepoRelayReceipt({ ...actual, performed_via_github_app: { id: 15368 } }), false);
  assert.equal(isRepoRelayReceipt({ ...actual, user: data.receipt.user }), false);
});
