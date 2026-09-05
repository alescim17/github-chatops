import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executeCommand } from '../src/handlers/index.mjs';
import { readLimits, resultDigest } from '../src/read-contract.mjs';
import { fakeApi, target, privateCanaries } from './fixtures/read-api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const policy = JSON.parse(fs.readFileSync(new URL('../config/policy.json', import.meta.url)));
const base = { v: 1, request_id: 'runner-test', repository: 'target/streamforge' };
const parse = (body) => JSON.parse(body.split('```json\n')[1].split('\n```')[0]);
function run(t, action, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporelay-read-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outer = { ...base, action, ...(action === 'relay.private' ? { source_comment_id: 101 } : {}), ...(config.outer ?? {}) };
  const event = { action: 'created', comment: { id: 99, body: '/reporelay ' + JSON.stringify(outer), user: { login: 'alescim17' } },
    repository: { full_name: 'alescim17/github-chatops' }, issue: { number: 3 } };
  const eventPath = path.join(dir, 'event.json');
  const configPath = path.join(dir, 'config.json');
  const output = path.join(dir, 'output.json');
  fs.writeFileSync(eventPath, JSON.stringify(event));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, outer, output }));
  const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/runner-harness.mjs', import.meta.url)), 'src/runner.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, REPORELAY_TEST_HARNESS: configPath, REPORELAY_EVENT_PATH: eventPath,
      REPORELAY_DISPATCH_COMMAND: '', REPORELAY_TARGET_TOKEN: 'fake-target-token', REPORELAY_CONTROL_TOKEN: 'fake-control-token',
      REPORELAY_TARGETS_JSON: JSON.stringify({ 'target/streamforge': target }) },
  });
  assert.equal(child.error, undefined);
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
  const publicWrites = evidence.calls.filter((call) => call.path.startsWith('/repos/alescim17/github-chatops') && ['POST', 'PATCH'].includes(call.method));
  const privateWrites = evidence.calls.filter((call) => call.path === `/repos/${target}/issues/183/comments` && call.method === 'POST');
  return { ...child, ...evidence, publicWrites, privateWrites, result: publicWrites.length ? parse(publicWrites.at(-1).body.body) : null };
}

for (const action of ['read.capabilities', 'read.freeze', 'read.query']) {
  test(`dispatcher routes ${action} through the typed handler`, async (t) => {
    const old = globalThis.fetch;
    const api = fakeApi();
    globalThis.fetch = api.fetch;
    t.after(() => { globalThis.fetch = old; });
    const command = { ...base, repository: target, action, ...(action === 'read.query' ? { kind: 'repository' } : {}) };
    const result = await executeCommand('fake-token', policy, command, { privateRelay: action === 'read.query' });
    assert.equal(result.result_sha256, resultDigest(result.result));
  });
}
test('dispatcher rejects unknown read kinds before target I/O', async () => {
  await assert.rejects(() => executeCommand('fake-token', policy, { ...base, repository: target, action: 'read.query', kind: 'http' }, { privateRelay: true }), { code: 'READ_KIND_UNSUPPORTED' });
});
test('runner publishes complete capabilities with no target read when native authority is healthy', (t) => {
  // This tests the explicitly requested diagnostic action, not automatic invocation by the operator.
  const result = run(t, 'read.capabilities');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.result.supports_fallback_freeze, true);
  assert.equal(result.targetCalls.length, 0);
  assert.equal(result.result.result_sha256, resultDigest(result.result.result));
});
test('runner public freeze transports usable authority and no private payload', (t) => {
  const result = run(t, 'read.freeze', { outer: { branches: ['main', 'issue-183'], prs: [185], issues: [183], include_checks: true, include_workflows: true, include_reviews: true } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.result.result.stable, true);
  const publicText = JSON.stringify(result.publicWrites) + result.stdout + result.stderr;
  for (const secret of privateCanaries) assert.ok(!publicText.includes(secret), secret);
});
test('runner rejects public read.query before any target fetch', (t) => {
  const result = run(t, 'read.query', { outer: { kind: 'issue', issue: 183 } });
  assert.equal(result.status, 1);
  assert.equal(result.result.code, 'PRIVATE_RELAY_REQUIRED');
  assert.equal(result.calls.filter((call) => call.path.includes(target)).length, 0);
});
test('runner private query emits actual private result and only matching digest metadata publicly', (t) => {
  const result = run(t, 'relay.private');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.privateWrites.length, 1);
  const privateResult = parse(result.privateWrites[0].body.body);
  assert.equal(privateResult.result.data.body, 'PRIVATE_ISSUE_BODY');
  assert.equal(result.result.result_sha256, resultDigest(privateResult.result));
  assert.equal(result.result.result_bytes, Buffer.byteLength(JSON.stringify(privateResult.result)));
  assert.deepEqual(Object.keys(result.result).sort(), ['completed', 'private_receipt', 'query_kind', 'result_bytes', 'result_sha256']);
  assert.ok(!JSON.stringify(result.publicWrites).includes('PRIVATE_ISSUE_BODY'));
  assert.ok(!(result.stdout + result.stderr).includes(target));
});
test('private delivery failure cannot become a successful read receipt', (t) => {
  const result = run(t, 'relay.private', { privateDeliveryFails: true });
  assert.equal(result.status, 1);
  assert.equal(result.result.code, 'PRIVATE_RECEIPT_WRITE_FAILED');
  assert.equal(result.result.completed, false);
  assert.equal(result.result.private_receipt, false);
});
for (const issueUrl of ['https://api.github.com/repos/other/repository/issues/1', 'https://evil.invalid/repos/owner/private-target/issues/183']) {
  test('private receipt destination cannot escape its authenticated target conversation', (t) => {
    const result = run(t, 'relay.private', { issueUrl });
    assert.equal(result.status, 1);
    assert.equal(result.result.code, 'PRIVATE_RECEIPT_TARGET_INVALID');
    assert.equal(result.privateWrites.length, 0);
    assert.equal(result.targetCalls.length, 0);
  });
}
test('unbound private command cannot leak its repository identity into public failure metadata', (t) => {
  const result = run(t, 'relay.private', { privateCommand: { repository: 'other/sensitive-repo' } });
  assert.equal(result.result.code, 'PRIVATE_TARGET_MISMATCH');
  assert.ok(!JSON.stringify(result.publicWrites).includes('other/sensitive-repo'));
  assert.ok(!(result.stdout + result.stderr).includes('other/sensitive-repo'));
});
test('existing mutation success receipts stay minimal even when handler returns sensitive data', (t) => {
  const result = run(t, 'relay.private', { privateCommand: { action: 'issue.update', issue: 183, body: 'PRIVATE_MUTATION_BODY', kind: undefined } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.result, { completed: true, private_receipt: true });
  assert.ok(!JSON.stringify(result.publicWrites).includes('PRIVATE_MUTATION'));
  assert.ok(!JSON.stringify(result.publicWrites).includes('secret-credentials'));
  assert.ok(JSON.stringify(result.privateWrites).includes('PRIVATE_MUTATION_RESULT'));
});
test('duplicate reads are suppressed rather than advertised as a fresh observation', (t) => {
  const result = run(t, 'read.freeze', { duplicate: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DUPLICATE_SUPPRESSED/);
  assert.equal(result.targetCalls.length, 0);
  assert.equal(result.publicWrites.length, 0);
});
test('new independent request IDs yield independent target observations', (t) => {
  for (const request_id of ['observation-1', 'observation-2']) {
    const result = run(t, 'read.freeze', { outer: { request_id } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.targetCalls.length > 0);
    assert.equal(result.result.result.stable, true);
  }
});
