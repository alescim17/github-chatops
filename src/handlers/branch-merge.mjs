import { randomBytes } from 'node:crypto';
import { RepoRelayError, invariant, commandHash, splitRepository, githubRequest } from '../core.mjs';
import { requireString, ensureBranchWriteAllowed } from './common.mjs';

const SHA = /^[0-9a-f]{40}$/;
const FIELDS = new Set(['v', 'request_id', 'action', 'repository', 'branch', 'expected_sha', 'head_ref', 'expected_head_sha', 'message']);

function branchName(command, key) {
  const value = requireString(command, key, /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/);
  invariant(!value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.')
    && !value.startsWith('refs/') && value !== 'reporelay-merge' && !value.startsWith('reporelay-merge/')
    && value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')),
  'BRANCH_MERGE_REF_INVALID', 'Use a short branch name outside the reserved internal namespace');
  return value;
}

function exactRef(ref, branch, expected, code) {
  invariant(ref?.ref === `refs/heads/${branch}` && ref?.object?.type === 'commit' && ref.object.sha === expected,
    code, 'Exact branch authority differs', { branch, expected, actual: ref?.object?.sha || null });
}

function exactCommit(commit, sha, root) {
  invariant(SHA.test(sha || '') && commit?.sha === sha && SHA.test(commit?.tree?.sha || '')
    && commit?.url === `https://api.github.com${root}/git/commits/${sha}`,
  'BRANCH_MERGE_COMMIT_INVALID', 'Commit identity, tree or canonical repository differs');
}

async function cleanupTemp(token, root, temp) {
  const path = `${root}/git/refs/heads/${encodeURIComponent(temp)}`;
  try {
    try {
      await githubRequest(token, 'DELETE', path);
    } catch (error) {
      if (!(error instanceof RepoRelayError && error.details?.status === 404)) throw error;
    }
    let absent = false;
    try {
      await githubRequest(token, 'GET', `${root}/git/ref/heads/${encodeURIComponent(temp)}`);
    } catch (error) {
      if (!(error instanceof RepoRelayError && error.details?.status === 404)) throw error;
      absent = true;
    }
    invariant(absent, 'BRANCH_MERGE_TEMP_PRESENT', 'Internal temporary ref still exists');
  } catch (error) {
    throw new RepoRelayError('BRANCH_MERGE_TEMP_CLEANUP_FAILED', 'Target unchanged: internal ref cleanup was not verified', {
      temp_ref: temp, cause: error.code || 'UNEXPECTED_ERROR', status: error.details?.status || null,
    });
  }
}

// Only the authenticated runner supplies context; no command field enables this action.
export async function handleBranchMergeFenced(token, policy, command, context = {}) {
  invariant(context.privateRelay === true, 'PRIVATE_RELAY_REQUIRED', 'branch.merge.fenced requires relay.private');
  invariant(command && typeof command === 'object' && !Array.isArray(command)
    && Object.keys(command).every((key) => FIELDS.has(key)),
  'BRANCH_MERGE_FIELDS_INVALID', 'Unknown branch.merge.fenced command field');
  invariant(command.v === 1 && command.action === 'branch.merge.fenced'
    && typeof command.request_id === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(command.request_id),
  'BRANCH_MERGE_COMMAND_INVALID', 'Invalid version, action or request identity');
  const repository = requireString(command, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const branch = branchName(command, 'branch');
  const headRef = branchName(command, 'head_ref');
  const expected = requireString(command, 'expected_sha', /^[0-9a-f]{40}$/i).toLowerCase();
  const head = requireString(command, 'expected_head_sha', /^[0-9a-f]{40}$/i).toLowerCase();
  const message = requireString(command, 'message');
  invariant(Buffer.byteLength(message, 'utf8') <= 1000 && message.trim().length > 0
    && !/[\x00-\x08\x0b-\x1f\x7f]/.test(message), 'BRANCH_MERGE_MESSAGE_INVALID', 'Merge message must be bounded UTF-8 text');
  invariant(branch !== headRef, 'BRANCH_MERGE_SAME_REF', 'Target and head ref must differ');
  invariant(expected !== head, 'BRANCH_MERGE_NOT_DIVERGED', 'A two-parent synchronization requires distinct commits');

  const meta = await ensureBranchWriteAllowed(token, policy, repository, branch);
  invariant(typeof meta?.full_name === 'string' && meta.full_name.toLowerCase() === repository.toLowerCase()
    && typeof meta.default_branch === 'string' && meta.default_branch.length > 0,
    'BRANCH_MERGE_REPOSITORY_MISMATCH', 'Canonical repository differs');
  // This primitive never permits a default-branch target, even under a more permissive policy.
  invariant(branch !== meta.default_branch, 'DEFAULT_BRANCH_WRITE_FORBIDDEN', 'Default branch merge target is forbidden');
  const { owner, repo } = splitRepository(meta.full_name);
  const root = `/repos/${owner}/${repo}`;
  const readRef = (name) => githubRequest(token, 'GET', `${root}/git/ref/heads/${encodeURIComponent(name)}`);
  exactRef(await readRef(branch), branch, expected, 'EXPECTED_BRANCH_SHA_MISMATCH');
  exactRef(await readRef(headRef), headRef, head, 'EXPECTED_HEAD_REF_SHA_MISMATCH');
  exactCommit(await githubRequest(token, 'GET', `${root}/git/commits/${expected}`), expected, root);
  exactCommit(await githubRequest(token, 'GET', `${root}/git/commits/${head}`), head, root);

  // The runner authenticated the intent; a server nonce prevents caller-selected refs and collisions.
  const temp = `reporelay-merge/${commandHash(command).slice(0, 32)}-${randomBytes(12).toString('hex')}`;
  let created = false;
  let merge;
  try {
    const ref = await githubRequest(token, 'POST', `${root}/git/refs`, { ref: `refs/heads/${temp}`, sha: expected });
    created = true;
    exactRef(ref, temp, expected, 'BRANCH_MERGE_TEMP_INVALID');
    let result;
    try {
      result = await githubRequest(token, 'POST', `${root}/merges`, { base: temp, head, commit_message: message });
    } catch (error) {
      if (error instanceof RepoRelayError && error.details?.status === 409) {
        throw new RepoRelayError('BRANCH_MERGE_CONFLICT', 'Merge conflict: target branch unchanged');
      }
      throw error;
    }
    invariant(SHA.test(result?.sha || ''), 'BRANCH_MERGE_RESULT_INVALID', 'Server did not produce a merge SHA (already merged/no-op is not synchronization)');
    merge = await githubRequest(token, 'GET', `${root}/git/commits/${result.sha}`);
    exactCommit(merge, result.sha, root);
    const parents = merge.parents;
    invariant(Array.isArray(parents) && parents.length === 2
      && parents[0]?.sha === expected && parents[1]?.sha === head,
    'BRANCH_MERGE_PARENTS_MISMATCH', 'Merge must have exactly the target then the exact head as its two parents');
    exactRef(await readRef(temp), temp, merge.sha, 'BRANCH_MERGE_TEMP_INVALID');
  } finally {
    // Never delete a colliding/pre-existing ref when creation failed. A cleanup error blocks all target writes.
    if (created) await cleanupTemp(token, root, temp);
  }

  // Optimistic fences, not a cross-ref GitHub transaction. Non-force is always mandatory.
  exactRef(await readRef(branch), branch, expected, 'BRANCH_MERGE_TARGET_MOVED');
  exactRef(await readRef(headRef), headRef, head, 'BRANCH_MERGE_HEAD_MOVED');
  const updated = await githubRequest(token, 'PATCH', `${root}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: merge.sha, force: false });
  exactRef(updated, branch, merge.sha, 'BRANCH_MERGE_UPDATE_UNVERIFIED');
  exactRef(await readRef(branch), branch, merge.sha, 'BRANCH_MERGE_UPDATE_UNVERIFIED');
  return { branch, from: expected, head_ref: headRef, head_sha: head, merge_sha: merge.sha,
    tree_sha: merge.tree.sha, parents: merge.parents.map((parent) => parent.sha) };
}
