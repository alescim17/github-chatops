import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findReceipt, assertReceiptCompatible, commandHash, receiptMarker } from '../src/core.mjs';

const command = { v: 1, request_id: 'pagination-recovery', action: 'read.capabilities', repository: 'target/aether' };
const receipt = (id, status = 'SUCCESS') => ({ id, body: receiptMarker({ sourceCommentId: '900001', requestId: command.request_id, action: command.action, repository: command.repository, status, hash: commandHash(command) }) });
const pageOf = (page, length = 100) => Array.from({ length }, (_, i) => ({ id: (page - 1) * 100 + i + 1, body: 'ordinary bus comment' }));
function mockPages(t, respond) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/repos/alescim17/github-chatops/issues/3/comments');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(url.searchParams.has('since'), false, 'old receipts must remain searchable');
    assert.equal(init.method, 'GET');
    const page = Number(url.searchParams.get('page'));
    calls.push(page);
    const result = respond(page);
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  });
  return calls;
}
const scan = (source = '900001', request = command.request_id) => findReceipt('fake-token', 'alescim17/github-chatops', 3, source, request);

for (const count of [0, 1, 999, 1000, 1001, 1100, 2501]) {
  test(`absence requires terminal page and stable boundaries after ${count} comments`, async (t) => {
    const calls = mockPages(t, p => pageOf(p, Math.max(0, Math.min(100, count - (p - 1) * 100))));
    assert.equal(await scan(), null);
    const full = Math.floor(count / 100);
    assert.deepEqual(calls, [...Array.from({ length: full + 1 }, (_, i) => i + 1), ...Array.from({ length: full }, (_, i) => i + 1)]);
  });
}
for (const position of [1, 1000, 1001, 2577]) {
  test(`receipt at position ${position} is found without losing historic duplicate protection`, async (t) => {
    const expected = receipt(position);
    const calls = mockPages(t, p => pageOf(p).map(c => c.id === position ? expected : c));
    assert.deepEqual(await scan(), expected);
    assert.equal(calls.length, Math.ceil(position / 100));
    assert.doesNotThrow(() => assertReceiptCompatible(expected.body, command));
  });
}
for (const status of ['STARTED', 'FAILED', 'SUCCESS']) {
  test(`request-id replay after 1000 comments retains ${status} receipt semantics`, async (t) => {
    const expected = receipt(1001, status);
    mockPages(t, p => p <= 10 ? pageOf(p) : [expected]);
    assert.deepEqual(await scan('different-source'), expected);
    assert.throws(() => assertReceiptCompatible(expected.body, { ...command, action: 'pr.draft' }), { code: 'REQUEST_ID_CONFLICT' });
  });
}
test('source-comment lookup remains effective without a request id', async (t) => {
  const expected = receipt(1001);
  mockPages(t, p => p <= 10 ? pageOf(p) : [expected]);
  assert.deepEqual(await scan('900001', null), expected);
});
test('legacy receipt still fails intent verification', async (t) => {
  mockPages(t, p => p <= 10 ? pageOf(p) : [{ id: 1001, body: '<!-- reporelay-receipt source_comment_id=900001 -->' }]);
  const found = await scan();
  assert.throws(() => assertReceiptCompatible(found.body, command), { code: 'RECEIPT_HASH_MISSING' });
});
for (const invalid of [null, {}, 'not JSON comments', Array.from({ length: 101 }, (_, i) => ({ id: 1001 + i }))]) {
  test('malformed later page fails closed, never returns absence', async (t) => {
    mockPages(t, p => p <= 10 ? pageOf(p) : invalid);
    await assert.rejects(scan, { code: 'RECEIPT_PAGE_INVALID' });
  });
}
for (const invalid of [[{ id: 1000 }], [{ id: 1002 }, { id: 1001 }], [{ id: '1001' }], [{ body: 'missing ID' }]]) {
  test('repeated, overlapping or invalid comment IDs fail closed', async (t) => {
    mockPages(t, p => p <= 10 ? pageOf(p) : invalid);
    await assert.rejects(scan, { code: 'RECEIPT_SCAN_NOT_ADVANCING' });
  });
}
test('HTTP failure on page 11 is not converted to absence', async (t) => {
  mockPages(t, p => p <= 10 ? pageOf(p) : new Response('{"message":"rate limited"}', { status: 403 }));
  await assert.rejects(scan, { code: 'GITHUB_API_ERROR' });
});
test('network timeout on page 11 is not converted to absence', async (t) => {
  mockPages(t, p => { if (p > 10) throw new Error('timeout'); return pageOf(p); });
  await assert.rejects(scan, /timeout/);
});
for (const boundary of [1, 10, 25]) {
  test(`deletion across boundary ${boundary} cannot hide an unread receipt`, async (t) => {
    const items = Array.from({ length: (boundary + 1) * 100 + 1 }, (_, i) => ({ id: i + 1, body: 'ordinary' }));
    items[boundary * 100] = receipt(boundary * 100 + 1);
    let deleted = false;
    mockPages(t, p => {
      if (!deleted && p === boundary + 1) { items.shift(); deleted = true; }
      return items.slice((p - 1) * 100, p * 100);
    });
    await assert.rejects(scan, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
test('append-only growth does not shift previously scanned boundaries', async t => {
  const items = pageOf(1);
  mockPages(t, p => { if (p === 2 && items.length === 100) items.push({ id: 101, body: 'new ordinary comment' }); return items.slice((p - 1) * 100, p * 100); });
  assert.equal(await scan(), null);
});
test('boundary verification HTTP failure cannot establish absence', async t => {
  let firstReads = 0;
  mockPages(t, p => { if (p === 1 && ++firstReads > 1) return new Response('{}', { status: 503 }); return p === 1 ? pageOf(1) : []; });
  await assert.rejects(scan, { code: 'GITHUB_API_ERROR' });
});
test('boundary verification rejects a deleted entire page', async t => {
  let firstReads = 0;
  mockPages(t, p => p === 1 && ++firstReads === 1 ? pageOf(1) : []);
  await assert.rejects(scan, { code: 'RECEIPT_HISTORY_MOVED' });
});

// Actual runner subprocesses prove that historic duplicates, conflicting
// intent, API failure and deletion-induced forward gaps cannot execute targets.
for (const mode of ['new', 'duplicate', 'conflict', 'api-error', 'deletion']) {
  test(`runner ${mode} beyond page 10 preserves execution and replay boundary`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'reporelay-pagination-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const eventPath = join(dir, 'event.json');
    const callsPath = join(dir, 'calls.json');
    const preload = join(dir, 'preload.mjs');
    const cmd = { ...command, ...(mode === 'conflict' ? { action: 'pr.draft', pr: 7, expected_head_sha: 'a'.repeat(40) } : {}) };
    writeFileSync(eventPath, JSON.stringify({ action: 'created', comment: { id: 900001, user: { login: 'alescim17' }, body: '/reporelay ' + JSON.stringify(cmd) }, repository: { full_name: 'alescim17/github-chatops' }, issue: { number: 3 } }));
    writeFileSync(preload, `import fs from 'node:fs';
const mode=${JSON.stringify(mode)},calls=[];let deleted=false;const items=Array.from({length:1101},(_,i)=>({id:i+1,body:'ordinary'}));items[1000]=${JSON.stringify(receipt(1001))};process.on('exit',()=>fs.writeFileSync(${JSON.stringify(callsPath)},JSON.stringify(calls)));
globalThis.fetch=async(input,init={})=>{const u=new URL(input),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;calls.push({path:u.pathname,page:u.searchParams.get('page'),method,body});
if(!u.pathname.startsWith('/repos/alescim17/github-chatops/'))throw Error('Unexpected target I/O');
if(method==='GET'){const p=Number(u.searchParams.get('page'));
if(mode==='deletion'){if(!deleted&&p===11){items.shift();deleted=true;}return new Response(JSON.stringify(items.slice((p-1)*100,p*100)));}
if(p<=10)return new Response(JSON.stringify(Array.from({length:100},(_,i)=>({id:(p-1)*100+i+1,body:'ordinary'}))));
if(mode==='api-error')return new Response('{}',{status:403});
return new Response(JSON.stringify(${JSON.stringify(['duplicate', 'conflict'].includes(mode) ? [receipt(1001)] : [])}));}
return new Response(JSON.stringify({id:999999,body:body.body}));};`);
    const child = spawnSync(process.execPath, ['--import', preload, 'src/runner.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, REPORELAY_EVENT_PATH: eventPath, REPORELAY_DISPATCH_COMMAND: '', REPORELAY_TARGET_TOKEN: 'fake-target', REPORELAY_CONTROL_TOKEN: 'fake-control', REPORELAY_TARGETS_JSON: JSON.stringify({ 'target/aether': 'owner/private-target' }) },
    });
    assert.equal(child.error, undefined);
    const calls = JSON.parse(readFileSync(callsPath, 'utf8'));
    assert.equal(calls.filter(c => c.method === 'GET').length, mode === 'new' ? 21 : mode === 'deletion' ? 13 : 11);
    assert.ok(calls.every(c => c.path.startsWith('/repos/alescim17/github-chatops/')));
    const writes = calls.filter(c => c.method !== 'GET');
    if (mode === 'new') {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(writes.length, 2);
      assert.match(writes[0].body.body, /status=STARTED/);
      assert.match(writes[1].body.body, /status=SUCCESS/);
    } else if (mode === 'duplicate') {
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /DUPLICATE_SUPPRESSED/);
      assert.equal(writes.length, 0);
    } else {
      assert.equal(child.status, 1);
      assert.match(child.stderr, mode === 'conflict' ? /REQUEST_ID_CONFLICT/ : mode === 'deletion' ? /RECEIPT_HISTORY_MOVED/ : /GITHUB_API_ERROR/);
      assert.equal(writes.length, 1);
      assert.match(writes[0].body.body, /status=FAILED/);
    }
  });
}
