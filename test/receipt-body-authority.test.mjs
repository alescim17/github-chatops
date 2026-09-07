import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadPolicy } from '../src/core.mjs';
import { lookupRequest } from '../src/request-recovery.mjs';
import { control, alias, requestId, receiptId, resultSha256, r2Views, withState } from './fixtures/r2-receipt.mjs';
import { receiptBodyProof, assertBodyProofRequest, appActor, actionsActor } from './fixtures/receipt-body-proof.mjs';

const policy = await loadPolicy();
const context = { controlRepository: control, controlIssue: 3, controlToken: 'r2-fake-control', targetAlias: alias };
const lookup = () => lookupRequest(policy, { lookup_request_id: requestId }, context);
const exactPath = `/repos/${control}/issues/comments/${receiptId}`;
function install(t, views, options = {}) {
  const counts = { collection: 0, exact: 0, proof: 0 };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.headers.Authorization, 'Bearer r2-fake-control');
    if (url.pathname === '/graphql') {
      assertBodyProofRequest(init, views.exact);
      assert.equal(++counts.proof, 1);
      if (options.proofError) throw new Error('PRIVATE_PROOF_ERROR_CANARY');
      if (options.proofHttpError) return new Response('PRIVATE_PROOF_ERROR_CANARY', { status: 403 });
      const data = receiptBodyProof(views.exact);
      return new Response(JSON.stringify({ data: options.proof ? options.proof(data) : data }));
    }
    assert.equal(init.method, 'GET', 'only a fixed read-only node query may use POST');
    if (url.pathname === `/repos/${control}/issues/3/comments`) {
      counts.collection++;
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.has('since'), false);
      return new Response(JSON.stringify([views.collection]));
    }
    assert.equal(url.pathname, exactPath, 'no source/product/workflow access');
    counts.exact++;
    if (counts.exact > 1 && options.deletedAfterProof) return new Response('{}', { status: 404 });
    const current = counts.exact > 1 && options.afterProof ? options.afterProof(structuredClone(views.exact)) : views.exact;
    return new Response(JSON.stringify(current));
  });
  return counts;
}
const unverified = { code: 'REQUEST_AUTHORITY_UNVERIFIED' };

for (const status of ['SUCCESS', 'FAILED']) {
  for (const timing of ['before-scan', 'after-scan']) {
    for (const projection of ['null', 'full']) {
      test(`P1 generic Actions body editor rejected: ${timing}, ${status}, exact App=${projection}`, async t => {
        const views = r2Views('STARTED');
        views.exact = withState(views.exact, status);
        views.exact.body = views.exact.body.replace(resultSha256, 'f'.repeat(64)).replace('R2_FAILURE_FIXTURE', 'FORGED_FAILURE');
        if (timing === 'before-scan') {
          views.collection = withState(views.collection, status);
          views.collection.body = views.exact.body;
        }
        if (projection === 'full') views.exact.performed_via_github_app = views.collection.performed_via_github_app;
        const counts = install(t, views, { proof: data => { data.node.editor = { ...actionsActor }; return data; } });
        await assert.rejects(lookup, unverified);
        assert.deepEqual(counts, { collection: 2, exact: 1, proof: 1 });
      });
    }
  }
}
for (const editor of [null, {}, { __typename: 'Bot', id: 'another-app' },
  { __typename: 'User', id: appActor.id }, { __typename: 'Bot', id: '' }]) {
  test('edited body requires the same nonempty Bot actor ID as its immutable creator', async t => {
    install(t, r2Views(), { proof: data => { data.node.editor = editor; return data; } });
    await assert.rejects(lookup, unverified);
  });
}
for (const field of ['editor', 'lastEditedAt', 'author']) {
  test(`missing ${field} proof cannot become success`, async t => {
    install(t, r2Views(), { proof: data => { delete data.node[field]; return data; } });
    await assert.rejects(lookup, unverified);
  });
}
for (const author of [null, {}, { __typename: 'User', id: appActor.id }]) {
  test('missing or non-Bot immutable GraphQL author fails closed', async t => {
    install(t, r2Views(), { proof: data => { data.node.author = author; return data; } });
    await assert.rejects(lookup, unverified);
  });
}
for (const [field, value] of [
  ['__typename', 'PullRequest'], ['id', 'different-comment-node'], ['fullDatabaseId', receiptId],
  ['body', 'PRIVATE_PROOF_BODY_CANARY'], ['createdAt', '2026-09-07T08:39:12Z'],
  ['updatedAt', '2026-09-07T08:39:16Z'], ['url', 'https://github.com/other/issue'],
]) {
  test(`proof ${field} must bind the exact REST snapshot`, async t => {
    install(t, r2Views(), { proof: data => { data.node[field] = value; return data; } });
    await assert.rejects(lookup, unverified);
  });
}
for (const issue of [{ number: 32, repository: { nameWithOwner: control } },
  { number: 3, repository: { nameWithOwner: 'owner/other-control' } }]) {
  test('proof cannot substitute another issue or repository', async t => {
    install(t, r2Views(), { proof: data => { data.node.issue = issue; return data; } });
    await assert.rejects(lookup, unverified);
  });
}
for (const lastEditedAt of ['invalid', '2026-09-07T08:39:12Z', '2026-09-07T08:39:16Z', null]) {
  test('edited body requires a coherent edit timestamp and editor pair', async t => {
    install(t, r2Views(), { proof: data => { data.node.lastEditedAt = lastEditedAt; return data; } });
    await assert.rejects(lookup, unverified);
  });
}
test('explicit unedited proof is valid for an App-created STARTED receipt', async t => {
  const counts = install(t, r2Views('STARTED'));
  const result = await lookup();
  assert.equal(result.status, 'STARTED'); assert.equal(result.terminal, false);
  assert.deepEqual(counts, { collection: 2, exact: 2, proof: 1 });
});
test('same opaque author/editor identity needs no REST/GraphQL ID encoding assumption', async t => {
  const views = r2Views();
  assert.notEqual(appActor.id, views.exact.user.node_id);
  install(t, views);
  assert.equal((await lookup()).result_sha256, resultSha256);
});
for (const options of [{ proofError: true }, { proofHttpError: true }, { proof: () => ({ node: null }) }]) {
  test('unreadable body proof is sanitized, never success or NOT_FOUND', async t => {
    install(t, r2Views(), options);
    await assert.rejects(lookup, error => {
      assert.equal(error.code, 'REQUEST_AUTHORITY_UNVERIFIED');
      assert.equal(error.message.includes('PRIVATE_'), false);
      assert.equal(error.details, undefined); return true;
    });
  });
}
for (const field of ['id', 'node_id', 'created_at', 'updated_at', 'body', 'html_url']) {
  test(`post-proof ${field} movement is rejected by the last exact reread`, async t => {
    install(t, r2Views(), { afterProof: comment => {
      comment[field] = field === 'id' ? receiptId + 1 : field === 'body' ? comment.body + ' ' : 'substitution';
      return comment;
    } });
    await assert.rejects(lookup, { code: 'RECEIPT_HISTORY_MOVED' });
  });
}
test('post-proof deletion is an error, not a recovered request or NOT_FOUND', async t => {
  const counts = install(t, r2Views(), { deletedAfterProof: true });
  await assert.rejects(lookup, { code: 'GITHUB_API_ERROR' });
  assert.deepEqual(counts, { collection: 2, exact: 2, proof: 1 });
});

for (const status of ['SUCCESS', 'FAILED']) {
  test(`actual runner rejects generic Actions editor forging STARTED -> ${status}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-p1-'));
    try {
      const eventPath = path.join(dir, 'event.json'), configPath = path.join(dir, 'config.json'), output = path.join(dir, 'output.json');
      const command = { v: 1, request_id: 'r3-editor-forgery-recovery', action: 'read.request', repository: alias, lookup_request_id: requestId };
      const views = r2Views('STARTED'); views.exact = withState(views.exact, status);
      fs.writeFileSync(eventPath, JSON.stringify({ action: 'created', repository: { full_name: control }, issue: { number: 3 },
        comment: { id: 6000000001, body: '/reporelay ' + JSON.stringify(command), user: { login: 'alescim17' } } }));
      fs.writeFileSync(configPath, JSON.stringify({ ...views, output, forgedEditor: true }));
      const run = spawnSync(process.execPath, ['--import', './test/fixtures/r2-runner-harness.mjs', './src/runner.mjs'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 20000,
        env: { PATH: process.env.PATH, HOME: dir, REPORELAY_R2_HARNESS: configPath,
          REPORELAY_EVENT_PATH: eventPath, REPORELAY_CONTROL_TOKEN: 'r2-fake-control', REPORELAY_TARGET_TOKEN: 'r2-fake-app',
          REPORELAY_TARGETS_JSON: JSON.stringify({ [alias]: control }) },
      });
      assert.equal(run.error, undefined); assert.equal(run.status, 1);
      const observed = JSON.parse(fs.readFileSync(output, 'utf8'));
      const envelope = JSON.parse(observed.receipt.body.split('```json')[1].split('```')[0]);
      assert.equal(envelope.completed, false); assert.equal(envelope.code, 'REQUEST_AUTHORITY_UNVERIFIED');
      assert.equal(envelope.result, undefined);
      assert.equal(observed.calls.filter(call => call.path === '/graphql').length, 1);
      assert.deepEqual(observed.calls.filter(call => call.path !== '/graphql' && call.method !== 'GET').map(call => call.method), ['POST', 'PATCH']);
      assert.equal(run.stdout.includes('r2-fake-'), false); assert.equal(run.stderr.includes('r2-fake-'), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
