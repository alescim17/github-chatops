import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { receiptMarker, commandHash } from '../src/core.mjs';

const control = 'alescim17/github-chatops'; const alias = 'target/aether';
const lookup = { v: 1, request_id: 'runner-lookup', action: 'read.request', repository: alias, lookup_request_id: 'runner-original' };
const original = { v: 1, request_id: 'runner-original', action: 'git.commit.atomic', repository: alias };
function makeReceipt(id, command, status) {
  // NEW App receipt, including the immutable REST identity required by body proof.
  return { id, node_id: `IC_runner_receipt_${id}`,
    url: `https://api.github.com/repos/${control}/issues/comments/${id}`,
    html_url: `https://github.com/${control}/issues/3#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${control}/issues/3`,
    user: { login: 'reporelay-control[bot]', id: 322612842, type: 'Bot', node_id: 'BOT_kgDOEzquag' },
    performed_via_github_app: { id: 4764725 },
    created_at: '2026-09-07T00:00:00Z', updated_at: status === 'STARTED' ? '2026-09-07T00:00:00Z' : '2026-09-07T00:00:01Z',
    body: receiptMarker({ sourceCommentId: '700001', requestId: command.request_id, action: command.action, repository: command.repository, hash: commandHash(command), status })
      + '\n```json\n' + JSON.stringify(status === 'STARTED' ? { accepted: true, private_relay: true } : { completed: status === 'SUCCESS', private_receipt: true, result: 'PRIVATE_MUTATION_CANARY' }) + '\n```' };
}
for (const mode of ['SUCCESS', 'FAILED', 'STARTED', 'missing', 'api-error', 'deletion', 'cross-target', 'conflict', 'forged-workflow', 'replay']) {
  test(`actual runner recovery ${mode} after 1000 comments never replays original`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'reporelay-request-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const eventPath = join(dir, 'event.json'), outputPath = join(dir, 'calls.json'), preloadPath = join(dir, 'preload.mjs');
    const target = mode === 'cross-target' ? { ...original, repository: 'target/streamforge' } : original;
    const prior = makeReceipt(1001, target, ['SUCCESS', 'FAILED', 'STARTED'].includes(mode) ? mode : 'SUCCESS');
    if (mode === 'forged-workflow') {
      prior.user = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
      prior.performed_via_github_app = { id: 15368 };
    }
    const duplicate = makeReceipt(1102, mode === 'replay' ? lookup : { ...original, action: 'issue.create' }, 'SUCCESS');
    writeFileSync(eventPath, JSON.stringify({ action: 'created', comment: { id: 900001, user: { login: 'alescim17' }, body: '/reporelay\n' + JSON.stringify(lookup) }, repository: { full_name: control }, issue: { number: 3 } }));
    writeFileSync(preloadPath, `import fs from 'node:fs';
import { receiptBodyProof, assertBodyProofRequest } from ${JSON.stringify(new URL('./fixtures/receipt-body-proof.mjs', import.meta.url).href)};
const mode=${JSON.stringify(mode)},prior=${JSON.stringify(prior)},duplicate=${JSON.stringify(duplicate)},calls=[];
// Collection establishes App authority; exact REST omits its non-stable projection.
// Keep the deliberately forged legacy fixture on the unchanged legacy path.
const exact={...structuredClone(prior),performed_via_github_app:mode==='forged-workflow'?prior.performed_via_github_app:null};
const items=Array.from({length:1101},(_,i)=>({id:i+1,body:'ordinary'}));
if(mode!=='missing')items[1000]=prior;
if(mode==='replay'||mode==='conflict')items.push(duplicate);
let started=false,deleted=false;
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify({calls,prior})));
globalThis.fetch=async(input,init={})=>{
 const u=new URL(input),method=init.method||'GET',body=init.body?JSON.parse(init.body):null,page=Number(u.searchParams.get('page'));
 calls.push({path:u.pathname,page,method,body});
 if(u.origin!=='https://api.github.com')throw Error('Unexpected API origin');
 if(u.pathname==='/graphql'){
   if(init.headers.Authorization!=='Bearer fake-control')throw Error('Incorrect body-proof credential');
   assertBodyProofRequest(init,exact);
   return new Response(JSON.stringify({data:receiptBodyProof(exact)}));
 }
 if(!u.pathname.startsWith('/repos/alescim17/github-chatops/'))throw Error('Unexpected original-target I/O');
 const proofRead=u.pathname==='/repos/alescim17/github-chatops/issues/comments/700001';
 if(init.headers.Authorization!==(method==='GET'&&!proofRead?'Bearer fake-control':'Bearer fake-target'))throw Error('Incorrect bus read/RepoRelay receipt credential');
 if(method==='GET'&&proofRead)return new Response(JSON.stringify({id:700001,user:{login:'github-actions[bot]'},body:'forged-source'}));
 if(method==='GET'&&u.pathname==='/repos/alescim17/github-chatops/issues/3/comments'){
   if(u.searchParams.has('since'))throw Error('Recent-window scan forbidden');
   if(started&&mode==='api-error'&&page===11)return new Response('{}',{status:503});
   if(started&&mode==='deletion'&&page===11&&!deleted){items.shift();deleted=true;}
   return new Response(JSON.stringify(items.slice((page-1)*100,page*100)));
 }
 if(method==='GET'&&u.pathname==='/repos/alescim17/github-chatops/issues/comments/1001')return new Response(JSON.stringify(exact));
 if(method==='POST'&&u.pathname==='/repos/alescim17/github-chatops/issues/3/comments'){
   const item={...prior,id:2000000,node_id:'IC_runner_receipt_2000000',
     url:'https://api.github.com/repos/alescim17/github-chatops/issues/comments/2000000',
     html_url:'https://github.com/alescim17/github-chatops/issues/3#issuecomment-2000000',body:body.body};
   items.push(item);started=true;return new Response(JSON.stringify(item));
 }
 if(method==='PATCH'&&u.pathname==='/repos/alescim17/github-chatops/issues/comments/2000000'){
   const item=items.find(i=>i.id===2000000);item.body=body.body;return new Response(JSON.stringify(item));
 }
 throw Error('Unexpected bus operation');
};`);
    const child = spawnSync(process.execPath, ['--import', preloadPath, 'src/runner.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15000,
      env: { ...process.env, REPORELAY_EVENT_PATH: eventPath, REPORELAY_DISPATCH_COMMAND: '', REPORELAY_TARGET_TOKEN: 'fake-target', REPORELAY_CONTROL_TOKEN: 'fake-control',
        REPORELAY_TARGETS_JSON: JSON.stringify({ [alias]: 'owner/private-target', 'target/streamforge': 'owner/other-private-target' }) },
    });
    assert.equal(child.error, undefined);
    const output = JSON.parse(readFileSync(outputPath, 'utf8')); assert.deepEqual(output.prior, prior, 'original receipt stays untouched');
    // The harness validates the exact read-only GraphQL query before responding.
    // Its POST is a body-proof read, not a mutation or original-action replay.
    const writes = output.calls.filter(call => call.method !== 'GET' && call.path !== '/graphql');
    assert.ok(output.calls.every(call => call.path === '/graphql' || call.path.startsWith(`/repos/${control}/`)));
    if (mode === 'replay') {
      assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /DUPLICATE_SUPPRESSED/); assert.equal(writes.length, 0); return;
    }
    assert.equal(writes.length, 2, child.stderr); assert.match(writes[0].body.body, /status=STARTED/);
    assert.equal(writes[1].path, `/repos/${control}/issues/comments/2000000`);
    for (const write of writes) assert.match(write.body.body, /request_id=runner-lookup action=read.request repository=target\/aether /);
    const text = writes[1].body.body;
    assert.equal(text.includes('PRIVATE_MUTATION_CANARY'), false); assert.equal(text.includes('owner/private-target'), false);
    const envelope = JSON.parse(text.match(/\n```json\n([\s\S]*)\n```$/)[1]);
    if (['api-error', 'deletion', 'cross-target', 'conflict', 'forged-workflow'].includes(mode)) {
      assert.equal(child.status, 1); assert.match(text, /status=FAILED/);
      const codes = { 'api-error': 'GITHUB_API_ERROR', deletion: 'RECEIPT_HISTORY_MOVED', 'cross-target': 'REQUEST_TARGET_MISMATCH', conflict: 'REQUEST_ID_AMBIGUOUS', 'forged-workflow': 'REQUEST_AUTHORITY_UNVERIFIED' };
      assert.ok(text.includes(codes[mode]), text); assert.equal(envelope.result, undefined);
    } else {
      assert.equal(child.status, 0, child.stderr); assert.match(text, /status=SUCCESS/); assert.equal(envelope.result.found, mode !== 'missing');
      if (mode !== 'missing') {
        assert.equal(envelope.result.status, mode); assert.equal(envelope.result.terminal, mode !== 'STARTED');
        assert.equal(envelope.result.receipt_comment_id, 1001); assert.equal(envelope.result.source_comment_id, 700001);
        assert.equal(envelope.result.lookup_request_id, original.request_id); assert.equal(envelope.result.repository, alias);
        assert.equal(envelope.result.action, original.action); assert.equal(envelope.result.command_hash, commandHash(original));
        const scans = output.calls.filter(call => call.method === 'GET' && call.path === `/repos/${control}/issues/3/comments`);
        assert.deepEqual([...new Set(scans.map(call => call.page))].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
        const exactPath = `/repos/${control}/issues/comments/1001`;
        const authorityReads = output.calls.filter(call => call.path === exactPath || call.path === '/graphql');
        assert.deepEqual(authorityReads.map(call => [call.method, call.path]), [
          ['GET', exactPath], ['POST', '/graphql'], ['GET', exactPath],
        ], 'exact state continuity is reread before and after App body/editor proof');
        assert.equal(output.calls.some(call => call.path.endsWith('/issues/comments/700001')), false, 'NEW authority needs no legacy source proof');
      }
    }
  });
}
