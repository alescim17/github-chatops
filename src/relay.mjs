import { RepoRelayError, invariant } from './core.mjs';

export const PUBLIC_ACTIONS = new Set([
  'pr.ready',
  'pr.draft',
  'pr.merge',
  'branch.delete_merged',
  'workflow.rerun',
  'workflow.rerun_failed',
  'workflow.cancel',
  'workflow.job.rerun',
]);

export function loadTargetMap(raw) {
  invariant(typeof raw === 'string' && raw.trim().length > 0, 'TARGET_MAP_REQUIRED', 'RepoRelay target map secret is missing');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RepoRelayError('TARGET_MAP_INVALID', 'RepoRelay target map secret is invalid JSON');
  }
  invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'TARGET_MAP_INVALID', 'RepoRelay target map must be an object');
  for (const [alias, repository] of Object.entries(parsed)) {
    invariant(/^target\/[A-Za-z0-9._-]+$/.test(alias), 'TARGET_ALIAS_INVALID', 'Target aliases must use target/<name>');
    invariant(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'TARGET_REPOSITORY_INVALID', `Target ${alias} does not map to owner/name`);
  }
  return parsed;
}

export function resolveTargetRepository(alias, targetMap) {
  const repository = targetMap[alias];
  invariant(typeof repository === 'string', 'TARGET_ALIAS_UNMAPPED', `Target alias ${alias} is not mapped`);
  return repository;
}

export function privateCommandBody(body) {
  invariant(typeof body === 'string', 'PRIVATE_COMMAND_BODY_REQUIRED', 'Private source comment has no body');
  const trimmed = body.trim();
  invariant(trimmed.startsWith('/reporelay-private'), 'PRIVATE_COMMAND_PREFIX_INVALID', 'Private source comment must start with /reporelay-private');
  return `/reporelay${trimmed.slice('/reporelay-private'.length)}`;
}

export function normalizeDispatchSource(source, event, dispatchCommand, policy) {
  if ((event?.inputs || dispatchCommand) && Array.isArray(policy?.control_issues) && policy.control_issues.length > 0) {
    return { ...source, controlIssue: policy.control_issues[0] };
  }
  return source;
}

export function assertPublicActionAllowed(action) {
  invariant(PUBLIC_ACTIONS.has(action), 'PRIVATE_RELAY_REQUIRED', `Action ${action} requires relay.private on the public control plane`);
}

export function assertPrivateEnvelope(outerCommand, privateCommand) {
  invariant(privateCommand.request_id === outerCommand.request_id, 'PRIVATE_REQUEST_ID_MISMATCH', 'Private command request_id must match the public relay envelope');
  invariant(privateCommand.repository === outerCommand.repository, 'PRIVATE_TARGET_MISMATCH', 'Private command target alias must match the public relay envelope');
}
