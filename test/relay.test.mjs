import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTargetMap,
  resolveTargetRepository,
  privateCommandBody,
  normalizeDispatchSource,
  assertPublicActionAllowed,
  assertPrivateEnvelope,
} from '../src/relay.mjs';

test('target map resolves a public alias without putting repository names in policy commands', () => {
  const map = loadTargetMap('{"target/aether":"owner/private-repo"}');
  assert.equal(resolveTargetRepository('target/aether', map), 'owner/private-repo');
});

test('target map rejects malformed aliases and repositories', () => {
  assert.throws(() => loadTargetMap('{"owner/repo":"owner/private"}'), (error) => error.code === 'TARGET_ALIAS_INVALID');
  assert.throws(() => loadTargetMap('{"target/aether":"not-a-repo"}'), (error) => error.code === 'TARGET_REPOSITORY_INVALID');
});

test('private command prefix is converted to the normal typed parser prefix', () => {
  const body = privateCommandBody('/reporelay-private {"v":1}');
  assert.equal(body, '/reporelay {"v":1}');
});

test('workflow_dispatch is normalized onto the configured permanent control issue', () => {
  const source = normalizeDispatchSource(
    { controlIssue: 1 },
    { inputs: { command: 'x' } },
    'x',
    { control_issues: [3] },
  );
  assert.equal(source.controlIssue, 3);
});

test('content-bearing action cannot run directly on the public bus', () => {
  assert.throws(() => assertPublicActionAllowed('git.commit.atomic'), (error) => error.code === 'PRIVATE_RELAY_REQUIRED');
  assert.doesNotThrow(() => assertPublicActionAllowed('pr.ready'));
  assert.doesNotThrow(() => assertPublicActionAllowed('pr.merge'));
});

test('private envelope must bind request identity and target alias', () => {
  const outer = { request_id: 'r1', repository: 'target/aether' };
  assert.doesNotThrow(() => assertPrivateEnvelope(outer, { request_id: 'r1', repository: 'target/aether' }));
  assert.throws(() => assertPrivateEnvelope(outer, { request_id: 'r2', repository: 'target/aether' }), (error) => error.code === 'PRIVATE_REQUEST_ID_MISMATCH');
  assert.throws(() => assertPrivateEnvelope(outer, { request_id: 'r1', repository: 'target/other' }), (error) => error.code === 'PRIVATE_TARGET_MISMATCH');
});
