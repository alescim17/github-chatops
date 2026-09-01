import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFrozenPullScope } from '../src/handlers/pr-merge-frozen.mjs';
import { PUBLIC_ACTIONS } from '../src/relay.mjs';

const command = {
  repository: 'owner/repository',
  expected_head_ref: 'issue-51-recovery',
  expected_base_ref: 'main',
  expected_base_sha: '1'.repeat(40),
  expected_commit_count: 7,
  expected_files: ['a.ts', 'b.ts'],
};

const pull = {
  state: 'open',
  merged: false,
  commits: 7,
  head: {
    ref: 'issue-51-recovery',
    sha: '2'.repeat(40),
    repo: { full_name: 'owner/repository' },
  },
  base: { ref: 'main', sha: '1'.repeat(40) },
};

const files = [{ filename: 'b.ts' }, { filename: 'a.ts' }];

test('frozen merge accepts exact branch, base, commit count, and file scope', () => {
  assert.doesNotThrow(() => assertFrozenPullScope(pull, files, command));
});

test('frozen merge rejects a changed head ref', () => {
  assert.throws(
    () => assertFrozenPullScope({ ...pull, head: { ...pull.head, ref: 'other' } }, files, command),
    (error) => error?.code === 'PR_HEAD_REF_MISMATCH',
  );
});

test('frozen merge rejects a changed base SHA', () => {
  assert.throws(
    () => assertFrozenPullScope({ ...pull, base: { ...pull.base, sha: '3'.repeat(40) } }, files, command),
    (error) => error?.code === 'PR_BASE_SHA_MISMATCH',
  );
});

test('frozen merge rejects commit-count or file-scope drift', () => {
  assert.throws(
    () => assertFrozenPullScope({ ...pull, commits: 8 }, files, command),
    (error) => error?.code === 'PR_COMMIT_COUNT_MISMATCH',
  );
  assert.throws(
    () => assertFrozenPullScope(pull, [{ filename: 'a.ts' }, { filename: 'c.ts' }], command),
    (error) => error?.code === 'PR_FILE_SCOPE_MISMATCH',
  );
});

test('pr.merge.frozen stays private and cannot be posted directly on the public bus', () => {
  assert.equal(PUBLIC_ACTIONS.has('pr.merge.frozen'), false);
});
