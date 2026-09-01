import { invariant, splitRepository, githubRequest } from '../core.mjs';
import { requireString, ensureBranchWriteAllowed } from './common.mjs';

function validateFilePath(path) {
  invariant(
    typeof path === 'string'
      && path.length > 0
      && !path.startsWith('/')
      && !path.split('/').includes('..'),
    'FILE_PATH_INVALID',
    'File path is invalid',
  );
  return path;
}

function encodeContentPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function countExactOccurrences(content, search) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = content.indexOf(search, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + search.length;
  }
}

export function applyExactReplacements(content, replacements, path = 'file') {
  invariant(typeof content === 'string', 'FILE_CONTENT_INVALID', `${path} content must be UTF-8 text`);
  invariant(Array.isArray(replacements) && replacements.length > 0, 'REPLACEMENTS_REQUIRED', `${path} requires replacements`);

  let next = content;
  for (const [index, replacement] of replacements.entries()) {
    invariant(replacement && typeof replacement === 'object', 'REPLACEMENT_INVALID', `${path} replacement ${index} must be an object`);
    invariant(typeof replacement.before === 'string' && replacement.before.length > 0, 'REPLACEMENT_BEFORE_INVALID', `${path} replacement ${index} requires non-empty before text`);
    invariant(typeof replacement.after === 'string', 'REPLACEMENT_AFTER_INVALID', `${path} replacement ${index} requires after text`);
    const expectedCount = replacement.expected_count === undefined ? 1 : Number(replacement.expected_count);
    invariant(Number.isInteger(expectedCount) && expectedCount > 0, 'REPLACEMENT_COUNT_INVALID', `${path} replacement ${index} expected_count must be a positive integer`);

    const actualCount = countExactOccurrences(next, replacement.before);
    invariant(
      actualCount === expectedCount,
      'REPLACEMENT_COUNT_MISMATCH',
      `${path} replacement ${index} did not match the expected count`,
      { path, replacement: index, expected: expectedCount, actual: actualCount },
    );
    next = next.split(replacement.before).join(replacement.after);
  }

  invariant(next !== content, 'PATCH_NO_CHANGE', `${path} patch produced no change`);
  return next;
}

export async function handleAtomicPatch(token, policy, command) {
  const branch = requireString(command, 'branch', /^[A-Za-z0-9._\/-]+$/);
  const expectedParent = requireString(command, 'expected_parent_sha', /^[0-9a-f]{40}$/i);
  const message = requireString(command, 'message');
  invariant(Array.isArray(command.files) && command.files.length > 0, 'FILES_REQUIRED', 'git.patch.atomic requires files');
  invariant(command.files.length <= policy.limits.max_atomic_commit_files, 'TOO_MANY_FILES', 'Atomic patch exceeds file-count limit');

  let totalBytes = 0;
  const paths = new Set();
  for (const file of command.files) {
    invariant(file && typeof file === 'object', 'FILE_INVALID', 'Each file entry must be an object');
    validateFilePath(file.path);
    invariant(!paths.has(file.path), 'FILE_DUPLICATE', `Duplicate file path ${file.path}`);
    paths.add(file.path);
    invariant(typeof file.expected_blob_sha === 'string' && /^[0-9a-f]{40}$/i.test(file.expected_blob_sha), 'EXPECTED_BLOB_SHA_INVALID', `File ${file.path} requires expected_blob_sha`);
    invariant(Array.isArray(file.replacements) && file.replacements.length > 0, 'REPLACEMENTS_REQUIRED', `File ${file.path} requires replacements`);
    if (file.mode !== undefined) invariant(['100644', '100755'].includes(file.mode), 'FILE_MODE_INVALID', `Unsupported file mode for ${file.path}`);
    for (const replacement of file.replacements) {
      invariant(replacement && typeof replacement === 'object', 'REPLACEMENT_INVALID', `File ${file.path} has an invalid replacement`);
      invariant(typeof replacement.before === 'string' && replacement.before.length > 0, 'REPLACEMENT_BEFORE_INVALID', `File ${file.path} replacement requires non-empty before text`);
      invariant(typeof replacement.after === 'string', 'REPLACEMENT_AFTER_INVALID', `File ${file.path} replacement requires after text`);
      if (replacement.expected_count !== undefined) {
        const expectedCount = Number(replacement.expected_count);
        invariant(Number.isInteger(expectedCount) && expectedCount > 0, 'REPLACEMENT_COUNT_INVALID', `File ${file.path} replacement expected_count must be a positive integer`);
      }
      totalBytes += Buffer.byteLength(replacement.before, 'utf8') + Buffer.byteLength(replacement.after, 'utf8');
    }
  }
  invariant(totalBytes <= policy.limits.max_atomic_commit_bytes, 'PATCH_TOO_LARGE', 'Atomic patch exceeds replacement payload limit', { totalBytes });

  await ensureBranchWriteAllowed(token, policy, command.repository, branch);
  const { owner, repo } = splitRepository(command.repository);
  const ref = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  invariant(ref?.object?.sha === expectedParent, 'EXPECTED_PARENT_MISMATCH', 'Branch moved before patch', { expected: expectedParent, actual: ref?.object?.sha });
  const parentCommit = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/commits/${expectedParent}`);
  const patchedFiles = [];

  for (const file of command.files) {
    const source = await githubRequest(
      token,
      'GET',
      `/repos/${owner}/${repo}/contents/${encodeContentPath(file.path)}?ref=${encodeURIComponent(expectedParent)}`,
    );
    invariant(source?.type === 'file' && source?.encoding === 'base64' && typeof source?.content === 'string', 'PATCH_SOURCE_INVALID', `File ${file.path} is not a readable UTF-8 repository file`);
    invariant(
      source.sha === file.expected_blob_sha,
      'EXPECTED_BLOB_SHA_MISMATCH',
      `File ${file.path} moved before patch`,
      { path: file.path, expected: file.expected_blob_sha, actual: source.sha || null },
    );

    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(source.content.replace(/\s/g, ''), 'base64'),
      );
    } catch {
      invariant(false, 'PATCH_SOURCE_NOT_UTF8', `File ${file.path} is not valid UTF-8`);
    }
    patchedFiles.push({
      file,
      content: applyExactReplacements(content, file.replacements, file.path),
    });
  }

  const tree = [];
  for (const { file, content } of patchedFiles) {
    const blob = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'utf-8' });
    tree.push({ path: file.path, mode: file.mode || '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: parentCommit.tree.sha, tree });
  const commit = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/commits`, { message, tree: newTree.sha, parents: [expectedParent] });
  await githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  return { committed: true, patched: true, branch, sha: commit.sha, parent: expectedParent, files: command.files.length };
}
