import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/reporelay.yml', import.meta.url);
const policyUrl = new URL('../config/policy.json', import.meta.url);

test('privileged workflow pins executable actions to full commit SHAs', async () => {
  const workflow = await fs.readFile(workflowUrl, 'utf8');
  const uses = workflow
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+uses:\s+([^\s#]+)/)?.[1])
    .filter(Boolean);
  assert.ok(uses.length >= 2, `expected at least two pinned actions, got ${uses.length}`);
  for (const ref of uses) {
    const [, sha] = ref.split('@');
    assert.match(sha, /^[0-9a-f]{40}$/i, `un-pinned privileged action: ${ref}`);
  }
});

test('privileged workflow is gated to owner command-bus Issue #3', async () => {
  const workflow = await fs.readFile(workflowUrl, 'utf8');
  assert.match(workflow, /github\.event\.comment\.user\.login == 'alescim17'/);
  assert.match(workflow, /github\.event\.issue\.number == 3/);
  assert.match(workflow, /startsWith\(github\.event\.comment\.body, '\/reporelay'\)/);
});

test('GitHub App token explicitly requests merge-evidence and workflow-write permissions', async () => {
  const workflow = await fs.readFile(workflowUrl, 'utf8');
  for (const permission of [
    'permission-actions: write',
    'permission-checks: read',
    'permission-contents: write',
    'permission-issues: write',
    'permission-pull-requests: write',
    'permission-statuses: read',
    'permission-workflows: write',
  ]) {
    assert.ok(workflow.includes(permission), `missing ${permission}`);
  }
  assert.ok(workflow.includes('REPORELAY_TARGETS_JSON: ${{ secrets.REPORELAY_TARGETS_JSON }}'));
});

test('public policy contains aliases rather than private repository full names', async () => {
  const policy = JSON.parse(await fs.readFile(policyUrl, 'utf8'));
  assert.deepEqual(policy.control_issues, [3]);
  assert.ok(policy.allowed_repositories.length > 0);
  for (const target of policy.allowed_repositories) assert.match(target, /^target\/[A-Za-z0-9._-]+$/);
  const serialized = JSON.stringify(policy);
  assert.equal(serialized.includes('alescim17/aether-factory'), false);
  assert.equal(serialized.includes('alescim17/streamforge'), false);
  assert.equal(serialized.includes('alescim17/homeassistant'), false);
});
