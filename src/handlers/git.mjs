import { invariant, splitRepository, githubRequest, getRepository } from '../core.mjs';
import { requireString, ensureBranchWriteAllowed } from './common.mjs';

export async function handleBranchCreate(token, command) {
  const branch = requireString(command, 'branch', /^[A-Za-z0-9._\/-]+$/);
  const fromSha = requireString(command, 'from_sha', /^[0-9a-f]{40}$/i);
  const { owner, repo } = splitRepository(command.repository);
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
}

export async function handleBranchUpdate(token, policy, command) {
  const branch = requireString(command, 'branch', /^[A-Za-z0-9._\/-]+$/);
  const expected = requireString(command, 'expected_sha', /^[0-9a-f]{40}$/i);
  const target = requireString(command, 'target_sha', /^[0-9a-f]{40}$/i);
  await ensureBranchWriteAllowed(token, policy, command.repository, branch);
  const { owner, repo } = splitRepository(command.repository);
  const ref = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  invariant(ref?.object?.sha === expected, 'EXPECTED_BRANCH_SHA_MISMATCH', 'Branch moved before update', { expected, actual: ref?.object?.sha });
  const updated = await githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: target, force: false });
  return { updated: true, branch, from: expected, to: updated?.object?.sha || target };
}

export async function handleBranchDelete(token, policy, command) {
  const branch = requireString(command, 'branch', /^[A-Za-z0-9._\/-]+$/);
  const expected = requireString(command, 'expected_sha', /^[0-9a-f]{40}$/i);
  const repoMeta = await getRepository(token, command.repository);
  invariant(branch !== repoMeta.default_branch, 'DEFAULT_BRANCH_DELETE_FORBIDDEN', 'Default branch cannot be deleted');
  const { owner, repo } = splitRepository(command.repository);
  const ref = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  invariant(ref?.object?.sha === expected, 'EXPECTED_BRANCH_SHA_MISMATCH', 'Branch moved before deletion', { expected, actual: ref?.object?.sha });
  await githubRequest(token, 'DELETE', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
  return { deleted: true, branch, sha: expected };
}

export async function handleAtomicCommit(token, policy, command) {
  const branch = requireString(command, 'branch', /^[A-Za-z0-9._\/-]+$/);
  const expectedParent = requireString(command, 'expected_parent_sha', /^[0-9a-f]{40}$/i);
  const message = requireString(command, 'message');
  invariant(Array.isArray(command.files) && command.files.length > 0, 'FILES_REQUIRED', 'git.commit.atomic requires files');
  invariant(command.files.length <= policy.limits.max_atomic_commit_files, 'TOO_MANY_FILES', 'Atomic commit exceeds file-count limit');
  await ensureBranchWriteAllowed(token, policy, command.repository, branch);
  let totalBytes = 0;
  const paths = new Set();
  for (const file of command.files) {
    invariant(file && typeof file === 'object', 'FILE_INVALID', 'Each file entry must be an object');
    invariant(typeof file.path === 'string' && file.path.length > 0 && !file.path.startsWith('/') && !file.path.includes('..'), 'FILE_PATH_INVALID', 'File path is invalid');
    invariant(!paths.has(file.path), 'FILE_DUPLICATE', `Duplicate file path ${file.path}`);
    paths.add(file.path);
    invariant(file.delete === true || typeof file.content === 'string', 'FILE_CONTENT_INVALID', `File ${file.path} requires content or delete=true`);
    if (file.delete !== true) totalBytes += Buffer.byteLength(file.content, 'utf8');
  }
  invariant(totalBytes <= policy.limits.max_atomic_commit_bytes, 'COMMIT_TOO_LARGE', 'Atomic commit exceeds byte limit', { totalBytes });
  const { owner, repo } = splitRepository(command.repository);
  const ref = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  invariant(ref?.object?.sha === expectedParent, 'EXPECTED_PARENT_MISMATCH', 'Branch moved before commit', { expected: expectedParent, actual: ref?.object?.sha });
  const parentCommit = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/commits/${expectedParent}`);
  const tree = [];
  for (const file of command.files) {
    if (file.delete === true) {
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, { content: file.content, encoding: 'utf-8' });
    tree.push({ path: file.path, mode: file.mode || '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: parentCommit.tree.sha, tree });
  const commit = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/commits`, { message, tree: newTree.sha, parents: [expectedParent] });
  await githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  return { committed: true, branch, sha: commit.sha, parent: expectedParent, files: command.files.length };
}
