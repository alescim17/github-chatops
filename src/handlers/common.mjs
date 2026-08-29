import { invariant, getRepository } from '../core.mjs';

export function requireNumber(command, key) {
  const value = Number(command[key]);
  invariant(Number.isInteger(value) && value > 0, 'FIELD_INVALID', `${key} must be a positive integer`);
  return value;
}

export function requireString(command, key, pattern = null) {
  const value = command[key];
  invariant(typeof value === 'string' && value.length > 0, 'FIELD_INVALID', `${key} must be a non-empty string`);
  if (pattern) invariant(pattern.test(value), 'FIELD_INVALID', `${key} has an invalid format`);
  return value;
}

export function optionalObject(value, key) {
  if (value === undefined) return undefined;
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'FIELD_INVALID', `${key} must be an object`);
  return value;
}

export async function ensureBranchWriteAllowed(token, policy, repository, branch) {
  const repo = await getRepository(token, repository);
  if (branch === repo.default_branch) {
    invariant(policy.allow_direct_default_branch_writes === true, 'DEFAULT_BRANCH_WRITE_FORBIDDEN', `Direct writes to default branch ${branch} are disabled`);
  }
  return repo;
}
