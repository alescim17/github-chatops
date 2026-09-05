import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { READ_QUERY_KINDS, READ_LIMIT_KEYS, readLimits } from '../src/read-contract.mjs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('normative protocol preserves native-first read/write/post-write priorities and no duplicate healthy reads', () => {
  const protocol = read('docs/OPERATOR_PROTOCOL.md');
  for (const section of [
    'READ PRIORITY:\n\n1. native GitHub read;\n2. exact native GitHub REST read;\n3. RepoRelay read.freeze/read.query fallback;\n4. only then declare read plane unavailable.',
    'WRITE PRIORITY:\n\nRepoRelay remains the normal fenced mutation plane for configured targets.',
    'POST-WRITE PRIORITY:\n\n1. new native GitHub read;\n2. exact native GitHub REST read;\n3. new independent RepoRelay read.freeze;\n4. only then report inability to verify.',
    'Do NOT call RepoRelay reads if native GitHub already produced sufficient fresh authority, except for contradiction/recovery diagnostics.',
    'Mutation SUCCESS receipt != post-mutation state verification.',
  ]) assert.ok(protocol.includes(section), section);
});
test('the exact eight-step recovery recipe is documented', () => {
  const recipe = `WHEN A GITHUB READ IS NEEDED:

1. Try native @GitHub read.
2. If insufficient, try exact native GitHub REST/resource read.
3. If still unusable, use RepoRelay read.freeze.
4. For private content/logs/diffs use RepoRelay read.query via relay.private.
5. Use a new request_id for every fresh observation.
6. Never reuse a mutation SUCCESS receipt as target-state verification.
7. After mutation, repeat the same read priority with a fresh observation.
8. Only if native reads AND RepoRelay reads fail may the task report
    READ_PLANE_BLOCKED.

WHEN NATIVE READ IS HEALTHY:

Do NOT call RepoRelay read fallback unnecessarily.`;
  assert.ok(read('docs/OPERATOR_PROTOCOL.md').includes(recipe));
});
test('all typed kinds and limits are documented or discoverable, without weakening validation', () => {
  const docs = read('docs/READ_PLANE.md');
  for (const kind of READ_QUERY_KINDS) assert.ok(docs.includes(`| ${kind} |`), kind);
  const policy = JSON.parse(read('config/policy.json'));
  assert.deepEqual(Object.keys(readLimits(policy)), [...READ_LIMIT_KEYS]);
  assert.equal(policy.allow_direct_default_branch_writes, false);
  assert.equal(policy.allow_force_branch_updates, false);
  assert.deepEqual(policy.authorized_actors, ['alescim17']);
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts.test, 'node --test');
  for (const file of ['core', 'relay', 'runner', 'read-contract', 'read-client', 'read-receipts']) assert.ok(scripts.check.includes(`node --check src/${file}.mjs`));
  for (const file of ['common', 'pr', 'issue', 'workflow', 'git', 'patch', 'index', 'read']) assert.ok(scripts.check.includes(`node --check src/handlers/${file}.mjs`));
  assert.match(read('docs/GITHUB_APP.md'), /No permission expansion is required/);
});
