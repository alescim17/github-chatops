import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { executeCommand } from '../src/handlers/index.mjs';
import { PUBLIC_ACTIONS, assertPublicActionAllowed } from '../src/relay.mjs';
import { publicSuccessResult, privateReceiptBody } from '../src/read-receipts.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40), TREE = 'd'.repeat(40), OTHER = 'e'.repeat(40);
const root = '/repos/owner/target';
const policy = { allow_direct_default_branch_writes: false, limits: { max_atomic_commit_files: 32, max_atomic_commit_bytes: 48000 } };
const command = { v: 1, request_id: 'fenced-test', action: 'branch.merge.fenced', repository: 'owner/target',
  branch: 'issue-7', expected_sha: A, head_ref: 'main', expected_head_sha: B, message: 'chore(sync): exact main' };
const ref = (branch, sha) => ({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha } });
const commit = (sha, parents = []) => ({ sha, url: `https://api.github.com${root}/git/commits/${sha}`, tree: { sha: TREE }, parents: parents.map((sha) => ({ sha })) });
const response = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });

function fixture(t, options = {}) {
  const calls = [];
  const state = { target: options.initialTarget || A, head: options.initialHead || B, temp: null, tempSha: null, exists: false, wrote: false };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, 'https://api.github.com');
    const method = init.method || 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method, path, body });
    if (method === 'GET' && path === root) return response({ full_name: options.repository || 'owner/target', default_branch: 'main' });
    if (method === 'GET' && path === `${root}/git/ref/heads/issue-7`) return response(ref('issue-7', state.wrote && options.postMove ? OTHER : state.target));
    if (method === 'GET' && path === `${root}/git/ref/heads/main`) return response(ref('main', state.head));
    if (method === 'GET' && path === `${root}/git/commits/${A}`) return response(commit(A), options.missingCommit ? 404 : 200);
    if (method === 'GET' && path === `${root}/git/commits/${B}`) return response(commit(B));
    if (method === 'POST' && path === `${root}/git/refs`) {
      if (options.createFailure) return response({ message: 'already exists' }, 422);
      assert.deepEqual(Object.keys(body).sort(), ['ref', 'sha']);
      assert.equal(body.sha, A);
      assert.match(body.ref, /^refs\/heads\/reporelay-merge\/[0-9a-f]{32}-[0-9a-f]{24}$/);
      state.temp = body.ref.slice('refs/heads/'.length); state.tempSha = A; state.exists = true;
      return response(ref(state.temp, options.badCreatedRef ? OTHER : A), 201);
    }
    if (method === 'POST' && path === `${root}/merges`) {
      assert.deepEqual(body, { base: state.temp, head: B, commit_message: command.message });
      if (options.targetMoves) state.target = OTHER;
      if (options.headMoves) state.head = OTHER;
      if (options.conflict) return response({ message: 'Merge conflict' }, 409);
      if (options.noop) return response(null, 204);
      state.tempSha = options.fastForward ? B : M;
      return response({ sha: options.badResult ? 'short' : state.tempSha }, 201);
    }
    if (method === 'GET' && path === `${root}/git/commits/${M}`) return response({ ...commit(M, options.parents || [A, B]), ...(options.mergeOverride || {}) });
    if (state.temp && method === 'GET' && path === `${root}/git/ref/heads/${encodeURIComponent(state.temp)}`) {
      return state.exists ? response(ref(state.temp, state.tempSha)) : response({ message: 'Not Found' }, options.absenceError ? 503 : 404);
    }
    if (state.temp && method === 'DELETE' && path === `${root}/git/refs/heads/${encodeURIComponent(state.temp)}`) {
      if (options.cleanupFails) return response({ message: 'Forbidden' }, 403);
      state.exists = Boolean(options.cleanupSticky);
      return response(null, 204);
    }
    if (method === 'PATCH' && path === `${root}/git/refs/heads/issue-7`) {
      assert.equal(state.exists, false);
      assert.deepEqual(body, { sha: M, force: false });
      if (options.updateFails) return response({ message: 'Not fast forward' }, 422);
      state.target = M; state.wrote = true;
      return response(ref('issue-7', M));
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return { calls, state, run: (overrides = {}, context = { privateRelay: true }, chosenPolicy = policy) => executeCommand('test-token', chosenPolicy, { ...command, ...overrides }, context) };
}
const targetWrites = (f) => f.calls.filter((c) => c.method === 'PATCH');
const merges = (f) => f.calls.filter((c) => c.path === `${root}/merges`);
const mutations = (f) => f.calls.filter((c) => c.method !== 'GET');
const code = (expected) => (error) => error.code === expected;

test('diverged exact parents, server-only temporary ref, cleanup/absence proof before final fences and force=false update', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.deepEqual(result, { branch: 'issue-7', from: A, head_ref: 'main', head_sha: B, merge_sha: M, tree_sha: TREE, parents: [A, B] });
  const deletion = f.calls.findIndex((c) => c.method === 'DELETE');
  const update = f.calls.findIndex((c) => c.method === 'PATCH');
  assert.deepEqual(f.calls.slice(deletion + 1, update).map((c) => [c.method, c.path]), [
    ['GET', `${root}/git/ref/heads/${encodeURIComponent(f.state.temp)}`],
    ['GET', `${root}/git/ref/heads/issue-7`], ['GET', `${root}/git/ref/heads/main`],
  ]);
  assert.deepEqual(f.calls.at(-1), { method: 'GET', path: `${root}/git/ref/heads/issue-7`, body: undefined });
  assert.equal(targetWrites(f).length, 1);
  assert.equal(f.state.target, M);
  assert.equal(f.state.exists, false);
  assert.equal(f.state.temp.includes(command.request_id), false);
  assert.deepEqual(publicSuccessResult(command, result, true), { completed: true, private_receipt: true });
  assert.match(privateReceiptBody(command, 'SUCCESS', result), new RegExp(M));
});

for (const [title, options, error] of [
  ['wrong target fence before materialization', { initialTarget: OTHER }, 'EXPECTED_BRANCH_SHA_MISMATCH'],
  ['wrong head fence before materialization', { initialHead: OTHER }, 'EXPECTED_HEAD_REF_SHA_MISMATCH'],
  ['canonical repository mismatch', { repository: 'other/repo' }, 'BRANCH_MERGE_REPOSITORY_MISMATCH'],
  ['missing existing commit', { missingCommit: true }, 'GITHUB_API_ERROR'],
]) test(title, async (t) => {
  const f = fixture(t, options);
  await assert.rejects(() => f.run(), code(error));
  assert.equal(mutations(f).length, 0);
});

for (const [title, options, error] of [
  ['target moves while preparing merge', { targetMoves: true }, 'BRANCH_MERGE_TARGET_MOVED'],
  ['head ref moves while preparing merge', { headMoves: true }, 'BRANCH_MERGE_HEAD_MOVED'],
  ['conflict leaves target unchanged', { conflict: true }, 'BRANCH_MERGE_CONFLICT'],
  ['wrong parent set', { parents: [A, OTHER] }, 'BRANCH_MERGE_PARENTS_MISMATCH'],
  ['third parent', { parents: [A, B, OTHER] }, 'BRANCH_MERGE_PARENTS_MISMATCH'],
  ['reversed first-parent authority', { parents: [B, A] }, 'BRANCH_MERGE_PARENTS_MISMATCH'],
  ['duplicate parents', { parents: [A, A] }, 'BRANCH_MERGE_PARENTS_MISMATCH'],
  ['missing parents', { mergeOverride: { parents: null } }, 'BRANCH_MERGE_PARENTS_MISMATCH'],
  ['wrong canonical merge origin', { mergeOverride: { url: `https://api.github.com/repos/other/repo/git/commits/${M}` } }, 'BRANCH_MERGE_COMMIT_INVALID'],
  ['wrong fetched merge SHA', { mergeOverride: { sha: OTHER } }, 'BRANCH_MERGE_COMMIT_INVALID'],
  ['invalid merge tree', { mergeOverride: { tree: { sha: 'short' } } }, 'BRANCH_MERGE_COMMIT_INVALID'],
  ['invalid merge result SHA', { badResult: true }, 'BRANCH_MERGE_RESULT_INVALID'],
  ['204 already merged is not an exact two-parent sync', { noop: true }, 'BRANCH_MERGE_RESULT_INVALID'],
  ['fast-forward is not silently substituted for a merge', { fastForward: true }, 'BRANCH_MERGE_PARENTS_MISMATCH'],
  ['wrong temporary ref creation response', { badCreatedRef: true }, 'BRANCH_MERGE_TEMP_INVALID'],
  ['non-fast-forward target update is never forced', { updateFails: true }, 'GITHUB_API_ERROR'],
]) test(title, async (t) => {
  const f = fixture(t, options);
  await assert.rejects(() => f.run(), code(error));
  assert.equal(f.state.wrote, false);
  assert.equal(f.state.exists, false);
  assert.equal(f.state.target, options.targetMoves ? OTHER : A);
  assert.equal(targetWrites(f).length, options.updateFails ? 1 : 0);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
});

for (const options of [{ cleanupFails: true }, { cleanupSticky: true }, { absenceError: true }]) {
  test(`cleanup failure prevents target update: ${JSON.stringify(options)}`, async (t) => {
    const f = fixture(t, options);
    await assert.rejects(() => f.run(), code('BRANCH_MERGE_TEMP_CLEANUP_FAILED'));
    assert.equal(targetWrites(f).length, 0);
    assert.equal(f.state.target, A);
  });
}

test('creation collision never deletes an existing ref or mutates target', async (t) => {
  const f = fixture(t, { createFailure: true });
  await assert.rejects(() => f.run(), code('GITHUB_API_ERROR'));
  assert.equal(f.calls.some((c) => c.method === 'DELETE'), false);
  assert.equal(merges(f).length, 0);
  assert.equal(targetWrites(f).length, 0);
});

test('post-update movement is reported as unverified, never silently SUCCESS', async (t) => {
  const f = fixture(t, { postMove: true });
  await assert.rejects(() => f.run(), code('BRANCH_MERGE_UPDATE_UNVERIFIED'));
  assert.equal(f.state.wrote, true);
});

test('server nonce makes internal refs distinct even for identical validated intent', async (t) => {
  const f = fixture(t);
  await f.run();
  const first = f.state.temp;
  f.state.target = A; f.state.wrote = false;
  await f.run();
  assert.notEqual(f.state.temp, first);
});

test('private-only public routing and handler gate reject before target access', async (t) => {
  const f = fixture(t);
  assert.equal(PUBLIC_ACTIONS.has(command.action), false);
  assert.throws(() => assertPublicActionAllowed(command.action), code('PRIVATE_RELAY_REQUIRED'));
  await assert.rejects(() => f.run({}, {}), code('PRIVATE_RELAY_REQUIRED'));
  await assert.rejects(() => f.run({ privateRelay: true }, {}), code('PRIVATE_RELAY_REQUIRED'));
  assert.equal(f.calls.length, 0);
});

for (const field of ['temp_ref', 'temporary_ref', 'force', 'method', 'parents', 'tree', 'path', 'url', 'graphql', 'shell', 'context', 'privateRelay']) {
  test(`strict command rejects caller capability ${field}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(() => f.run({ [field]: 'injected' }), code('BRANCH_MERGE_FIELDS_INVALID'));
    assert.equal(f.calls.length, 0);
  });
}

for (const name of ['bad..name', 'bad//name', 'bad.lock', 'bad/.name', 'bad/name.lock', 'bad/', 'bad.', 'refs/heads/main', 'reporelay-merge/x', 'reporelay-merge', '-option', 'bad@{name}', 'a'.repeat(201)]) {
  test(`invalid/reserved branch names reject both selectors: ${name.slice(0, 30)}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(() => f.run({ branch: name }));
    await assert.rejects(() => f.run({ head_ref: name }));
    assert.equal(f.calls.length, 0);
  });
}

for (const override of [{ expected_sha: 'short' }, { expected_head_sha: 'g'.repeat(40) }, { expected_sha: null },
  { expected_head_sha: A }, { head_ref: 'issue-7' }, { message: 'x'.repeat(1001) }, { message: ' ' }, { message: 'bad\u0000' }, { v: 2 }]) {
  test(`invalid bounded command fails before network: ${Object.keys(override)[0]} ${JSON.stringify(override).slice(0, 55)}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(() => f.run(override));
    assert.equal(f.calls.length, 0);
  });
}

test('default-branch target is refused by existing policy and even by permissive policy', async (t) => {
  const f = fixture(t);
  for (const allow of [false, true]) {
    await assert.rejects(() => f.run({ branch: 'main', head_ref: 'issue-7' }, { privateRelay: true },
      { ...policy, allow_direct_default_branch_writes: allow }), code('DEFAULT_BRANCH_WRITE_FORBIDDEN'));
  }
  assert.equal(mutations(f).length, 0);
});

test('full uppercase SHA selectors are normalized, never truncated', async (t) => {
  const f = fixture(t);
  const result = await f.run({ expected_sha: A.toUpperCase(), expected_head_sha: B.toUpperCase() });
  assert.equal(result.from, A); assert.equal(result.head_sha, B);
});

test('installed permission and private routing contracts remain narrow', async () => {
  const p = JSON.parse(await fs.readFile(new URL('../config/policy.json', import.meta.url), 'utf8'));
  assert.equal(p.allow_direct_default_branch_writes, false);
  assert.equal(p.allow_force_branch_updates, false);
  const workflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /permissions:\n  contents: read/);
  for (const action of ['branch.create', 'branch.update', 'branch.delete', 'git.commit.atomic', 'git.patch.atomic', 'read.query', 'branch.merge.fenced']) {
    assert.equal(PUBLIC_ACTIONS.has(action), false);
  }
});
