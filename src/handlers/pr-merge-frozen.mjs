import { getPull, githubRequest, invariant } from '../core.mjs';
import { requireNumber, requireString } from './common.mjs';
import { handlePrMerge } from './pr.mjs';

function requireSha(command, key) {
  const value = requireString(command, key);
  invariant(/^[0-9a-f]{40}$/.test(value), 'SHA_INVALID', `${key} must be a 40-character lowercase SHA`);
  return value;
}

function requireExpectedFiles(command) {
  invariant(Array.isArray(command.expected_files), 'EXPECTED_FILES_REQUIRED', 'pr.merge.frozen requires expected_files');
  invariant(command.expected_files.length > 0, 'EXPECTED_FILES_REQUIRED', 'expected_files must not be empty');
  const files = command.expected_files.map((value) => {
    invariant(typeof value === 'string' && value.length > 0, 'EXPECTED_FILE_INVALID', 'Every expected file must be a non-empty path');
    return value;
  });
  invariant(new Set(files).size === files.length, 'EXPECTED_FILES_DUPLICATE', 'expected_files must not contain duplicates');
  return [...files].sort();
}

export function assertFrozenPullScope(pull, changedFiles, command) {
  const expectedHeadRef = requireString(command, 'expected_head_ref');
  const expectedBaseRef = requireString(command, 'expected_base_ref');
  const expectedBaseSha = requireSha(command, 'expected_base_sha');
  const expectedCommitCount = requireNumber(command, 'expected_commit_count');
  const expectedFiles = requireExpectedFiles(command);
  const actualFiles = changedFiles.map((file) => file.filename).sort();

  invariant(pull.state === 'open' && !pull.merged, 'PR_NOT_OPEN', 'Pull request must be open and unmerged');
  invariant(pull.head?.repo?.full_name === command.repository, 'PR_HEAD_REPOSITORY_MISMATCH', 'Pull request head must belong to the target repository');
  invariant(pull.head?.ref === expectedHeadRef, 'PR_HEAD_REF_MISMATCH', 'Pull request head ref changed', {
    expected: expectedHeadRef,
    actual: pull.head?.ref,
  });
  invariant(pull.base?.ref === expectedBaseRef, 'PR_BASE_REF_MISMATCH', 'Pull request base ref changed', {
    expected: expectedBaseRef,
    actual: pull.base?.ref,
  });
  invariant(pull.base?.sha === expectedBaseSha, 'PR_BASE_SHA_MISMATCH', 'Pull request base SHA changed', {
    expected: expectedBaseSha,
    actual: pull.base?.sha,
  });
  invariant(pull.commits === expectedCommitCount, 'PR_COMMIT_COUNT_MISMATCH', 'Pull request commit count changed', {
    expected: expectedCommitCount,
    actual: pull.commits,
  });
  invariant(actualFiles.length === expectedFiles.length, 'PR_FILE_SCOPE_MISMATCH', 'Pull request file count changed', {
    expected: expectedFiles,
    actual: actualFiles,
  });
  invariant(actualFiles.every((value, index) => value === expectedFiles[index]), 'PR_FILE_SCOPE_MISMATCH', 'Pull request file scope changed', {
    expected: expectedFiles,
    actual: actualFiles,
  });
}

export async function handlePrMergeFrozen(token, policy, command) {
  const pr = requireNumber(command, 'pr');
  const pull = await getPull(token, command.repository, pr);
  invariant(Number(pull.changed_files) <= 100, 'PR_FILE_SCOPE_TOO_LARGE', 'pr.merge.frozen supports at most 100 changed files');
  const [changedFiles] = await Promise.all([
    githubRequest(token, 'GET', `/repos/${command.repository}/pulls/${pr}/files?per_page=100`),
  ]);
  assertFrozenPullScope(pull, changedFiles, command);

  return handlePrMerge(token, policy, {
    ...command,
    action: 'pr.merge',
    expected_head_sha: pull.head.sha,
    expected_base_sha: pull.base.sha,
  });
}
