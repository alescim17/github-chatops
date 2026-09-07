import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPolicy } from '../src/core.mjs';
import { lookupRequest } from '../src/request-recovery.mjs';
import { isRepoRelayReceipt } from '../src/receipt-authority.mjs';
import { control, alias, requestId, receiptId, resultSha256, r2Views, withState, r2Writes, r2WriteViews } from './fixtures/r2-receipt.mjs';

const policy = await loadPolicy();
const context = { controlRepository: control, controlIssue: 3, controlToken: 'r2-fake-control', targetAlias: alias };
const command = { lookup_request_id: requestId };
const lookup = () => lookupRequest(policy, command, context);
const bus = `/repos/${control}/issues/3/comments`;
const exactPath = `/repos/${control}/issues/comments/${receiptId}`;
function install(t, views, options = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer r2-fake-control');
    calls.push(url.pathname);
    if (url.pathname === bus) {
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.has('since'), false);
      const page = Number(url.searchParams.get('page'));
      const items = options.items ?? [views.collection];
      return new Response(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
    }
    assert.equal(url.pathname, options.exactPath ?? exactPath, 'no target, source or workflow access for App receipt recovery');
    return new Response(JSON.stringify(views.exact), { status: options.status ?? 200 });
  });
  return calls;
}

test('R2 live regression: collection App metadata and exact null recover immutable SUCCESS', async t => {
  const views = r2Views();
  assert.equal(isRepoRelayReceipt(views.collection), true);
  assert.equal(isRepoRelayReceipt(views.exact), false, 'writer authority predicate must NOT be weakened');
  assert.equal(views.exact.performed_via_github_app, null);
  assert.equal(views.collection.body, views.exact.body);
  const calls = install(t, views), result = await lookup();
  assert.equal(result.found, true); assert.equal(result.status, 'SUCCESS'); assert.equal(result.terminal, true);
  assert.equal(result.receipt_comment_id, receiptId); assert.equal(result.source_comment_id, 5567819415);
  assert.equal(result.command_hash, '571ff150413c1a0712825baebba0cc4e4c4ba43ac53862e2d81b836ddcfe714d');
  assert.equal(result.result_sha256, resultSha256); assert.equal(result.result_bytes, 483);
  assert.equal(result.result, undefined); assert.equal(calls.at(-1), exactPath); assert.equal(calls.length, 3);
});
for (const mode of ['absent-app', 'complete-app', 'client-id-only-absent', 'reverse-non-authority-metadata']) {
  test(`safe endpoint projection: ${mode}`, async t => {
    const views = r2Views();
    if (mode === 'absent-app') delete views.exact.performed_via_github_app;
    else views.exact.performed_via_github_app = structuredClone(views.collection.performed_via_github_app);
    if (mode === 'client-id-only-absent') delete views.exact.performed_via_github_app.client_id;
    if (mode === 'reverse-non-authority-metadata') delete views.collection.performed_via_github_app.client_id;
    install(t, views); assert.equal((await lookup()).status, 'SUCCESS');
  });
}
for (const missing of [null, undefined]) {
  test(`no collection App proof cannot be upgraded by an exact view (${missing})`, async t => {
    const views = r2Views(); views.exact = structuredClone(views.collection);
    views.collection.performed_via_github_app = missing;
    const calls = install(t, views);
    assert.equal((await lookup()).found, false);
    assert.equal(calls.includes(exactPath), false);
  });
}
for (const app of [{ id: 999 }, { id: '4764725' }, {}, 'invalid']) {
  test('explicit contradictory or malformed exact App identity fails closed', async t => {
    const views = r2Views(); views.exact.performed_via_github_app = app;
    install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
for (const field of ['login', 'id', 'type', 'node_id']) {
  test(`exact user ${field} substitution cannot inherit prior App proof`, async t => {
    const views = r2Views(); views.exact.user[field] = field === 'id' ? 41898282 : 'substitute';
    install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
for (const field of ['id', 'node_id', 'url', 'issue_url', 'created_at']) {
  test(`immutable exact ${field} substitution rejected`, async t => {
    const views = r2Views();
    views.exact[field] = field === 'id' ? receiptId + 1 : field === 'created_at' ? '2026-09-07T08:39:12Z' : 'substitute';
    install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
for (const [from, to] of [
  ['repository=target/reporelay', 'repository=target/aether'],
  ['action=read.freeze', 'action=comment.create'],
  ['source_comment_id=5567819415', 'source_comment_id=5567819416'],
  [`request_id=${requestId}`, 'request_id=substitute'],
  ['command_hash=571ff150413c1a0712825baebba0cc4e4c4ba43ac53862e2d81b836ddcfe714d', `command_hash=${'0'.repeat(64)}`],
]) {
  test(`exact marker substitution rejected: ${from.split('=')[0]}`, async t => {
    const views = r2Views(); views.exact.body = views.exact.body.replace(from, to);
    install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
for (const appPresent of [false, true]) {
  test(`terminal body substitution rejected even with full exact authority=${appPresent}`, async t => {
    const views = r2Views(); views.exact.body = views.exact.body.replace(resultSha256, 'b'.repeat(64));
    if (appPresent) views.exact.performed_via_github_app = views.collection.performed_via_github_app;
    install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
for (const [before, after] of [['SUCCESS', 'FAILED'], ['FAILED', 'SUCCESS'], ['SUCCESS', 'STARTED'], ['FAILED', 'STARTED']]) {
  test(`terminal state cannot switch/regress ${before} -> ${after}`, async t => {
    const views = r2Views(before); views.exact = withState(views.exact, after);
    views.exact.updated_at = '2026-09-07T08:39:16Z';
    install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
for (const status of ['SUCCESS', 'FAILED']) {
  for (const projection of ['null', 'full']) {
    test(`STARTED -> ${status} exact ${projection} projection is accepted`, async t => {
      const views = r2Views('STARTED'); views.exact = withState(views.exact, status);
      if (projection === 'full') views.exact.performed_via_github_app = views.collection.performed_via_github_app;
      install(t, views); const result = await lookup();
      assert.equal(result.status, status); assert.equal(result.terminal, true);
    });
  }
}
test('same-second STARTED -> SUCCESS remains valid', async t => {
  const views = r2Views('STARTED'); views.exact = withState(views.exact, 'SUCCESS');
  views.exact.updated_at = views.collection.updated_at;
  install(t, views); assert.equal((await lookup()).status, 'SUCCESS');
});
test('unchanged STARTED with null projection remains nonterminal', async t => {
  install(t, r2Views('STARTED')); assert.equal((await lookup()).terminal, false);
});
test('older exact updated_at is a history error', async t => {
  const views = r2Views(); views.exact.updated_at = views.collection.created_at;
  install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
});
for (const status of [403, 404, 503]) {
  test(`exact unreadable HTTP ${status} is never NOT_FOUND`, async t => {
    install(t, r2Views(), { status }); await assert.rejects(lookup, { code: 'GITHUB_API_ERROR' });
  });
}
test('generic Actions forgery is a legacy candidate, never standalone authority', async t => {
  const views = r2Views();
  views.collection.user = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
  views.collection.performed_via_github_app = { id: 15368 };
  views.exact = structuredClone(views.collection);
  install(t, views); await assert.rejects(lookup, { code: 'REQUEST_AUTHORITY_UNVERIFIED' });
});
test('generic Actions exact substitution cannot inherit valid App authority', async t => {
  const views = r2Views();
  views.exact.user = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
  views.exact.performed_via_github_app = { id: 15368 };
  install(t, views); await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
});
test('another App cannot establish collection authority', async t => {
  const views = r2Views(); views.collection.performed_via_github_app.id = 999;
  install(t, views); assert.equal((await lookup()).found, false);
});
test('REQUEST_TARGET_MISMATCH survives endpoint projection correction', async t => {
  const views = r2Views(); views.collection.body = views.collection.body.replace('repository=target/reporelay', 'repository=target/aether');
  install(t, views); await assert.rejects(lookup, { code: 'REQUEST_TARGET_MISMATCH' });
});
test('REQUEST_ID_AMBIGUOUS survives endpoint projection correction', async t => {
  const views = r2Views(); const duplicate = { ...structuredClone(views.collection), id: receiptId + 1 };
  install(t, views, { items: [views.collection, duplicate] });
  await assert.rejects(lookup, { code: 'REQUEST_ID_AMBIGUOUS' });
});
for (const action of ['comment.create', 'read.query']) {
  test(`private ${action} payload remains redacted with exact null projection`, async t => {
    const views = r2Views();
    views.collection.body = views.collection.body.replace('action=read.freeze', `action=${action}`);
    views.collection = withState(views.collection, 'SUCCESS', { completed: true, private_receipt: true,
      result: 'PRIVATE_R2_CANARY', details: 'PRIVATE_R2_CANARY', result_sha256: resultSha256, result_bytes: 483, query_kind: 'file' });
    views.exact = { ...structuredClone(views.collection), performed_via_github_app: null };
    install(t, views); const result = await lookup();
    assert.equal(JSON.stringify(result).includes('PRIVATE_R2_CANARY'), false);
    assert.equal(result.private_receipt, true); assert.equal(result.result, undefined); assert.equal(result.details, undefined);
    assert.equal(result.result_sha256, action === 'read.query' ? resultSha256 : undefined);
    assert.equal(result.result_bytes, action === 'read.query' ? 483 : undefined);
    assert.equal(result.query_kind, action === 'read.query' ? 'file' : undefined);
  });
}

for (const status of ['SUCCESS', 'FAILED']) {
  test(`actual runner subprocess recovers STARTED -> ${status} with real R2 null projection`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-r2-'));
    try {
      const eventPath = path.join(dir, 'event.json'), configPath = path.join(dir, 'config.json'), output = path.join(dir, 'output.json');
      const outer = { v: 1, request_id: 'r3-runner-recovery', action: 'read.request', repository: alias, lookup_request_id: requestId };
      const views = r2Views('STARTED'); views.exact = withState(views.exact, status);
      fs.writeFileSync(eventPath, JSON.stringify({ action: 'created', repository: { full_name: control }, issue: { number: 3 },
        comment: { id: 6000000001, body: '/reporelay ' + JSON.stringify(outer), user: { login: 'alescim17' } } }));
      fs.writeFileSync(configPath, JSON.stringify({ ...views, output }));
      const root = fileURLToPath(new URL('../', import.meta.url));
      const run = spawnSync(process.execPath, ['--import', './test/fixtures/r2-runner-harness.mjs', './src/runner.mjs'], {
        cwd: root, encoding: 'utf8', timeout: 20000,
        env: { PATH: process.env.PATH, HOME: dir, REPORELAY_R2_HARNESS: configPath,
          REPORELAY_EVENT_PATH: eventPath, REPORELAY_CONTROL_TOKEN: 'r2-fake-control', REPORELAY_TARGET_TOKEN: 'r2-fake-app',
          REPORELAY_TARGETS_JSON: JSON.stringify({ [alias]: control }) },
      });
      assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
      const observed = JSON.parse(fs.readFileSync(output, 'utf8'));
      const envelope = JSON.parse(observed.receipt.body.match(/\n```json\n([\s\S]*)\n```$/)[1]);
      assert.equal(envelope.completed, true); assert.equal(envelope.result.status, status);
      assert.equal(envelope.result.terminal, true); assert.equal(envelope.result.receipt_comment_id, receiptId);
      assert.ok(observed.calls.some(call => call.path === exactPath && call.method === 'GET'));
      assert.deepEqual(observed.calls.filter(call => call.method !== 'GET').map(call => call.method), ['POST', 'PATCH']);
      assert.equal(run.stdout.includes('r2-fake-'), false); assert.equal(run.stderr.includes('r2-fake-'), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const vector of r2Writes) {
  test(`existing R2 ${vector[0]} comment.create receipt recovers without another mutation`, async t => {
    const views = r2WriteViews(vector);
    const calls = install(t, views, { exactPath: `/repos/${control}/issues/comments/${vector[2]}` });
    const result = await lookupRequest(policy, { lookup_request_id: views.lookupId }, { ...context, targetAlias: views.repository });
    assert.equal(result.found, true); assert.equal(result.terminal, true); assert.equal(result.status, 'SUCCESS');
    assert.equal(result.receipt_comment_id, vector[2]); assert.equal(result.source_comment_id, vector[3]);
    assert.equal(result.repository, vector[0]); assert.equal(result.command_hash, vector[6]);
    assert.equal(result.private_receipt, true); assert.equal(result.result, undefined);
    assert.equal(calls.length, 3);
  });
}
