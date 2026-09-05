import { invariant } from './core.mjs';
import {
  READ_PLANE_VERSION, PUBLIC_READ_ACTIONS, PRIVATE_READ_ACTIONS, READ_QUERY_KINDS, READ_LIMIT_KEYS,
  canonicalSerialize, resultDigest, verifyReadResult, integer, sha, refName,
} from './read-contract.mjs';

const isRead = (action) => [...PUBLIC_READ_ACTIONS, ...PRIVATE_READ_ACTIONS].includes(action);
const forbiddenText = /(?:[\p{Cc}\p{Cf}<>`@\\]|https?:|\b(?:gh[pousr]_|github_pat_|bearer\b|password\b|secret\b|token\b|BEGIN\b))/iu;
function safeText(value, limits, secrets) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limits.max_public_label_bytes
    && !forbiddenText.test(value) && !secrets.some((secret) => secret && value.toLowerCase().includes(secret.toLowerCase()));
}
function label(result, key, value, limits, secrets) {
  invariant(typeof value === 'string' || value === null, 'PUBLIC_READ_RESULT_UNSAFE', 'Invalid public metadata label');
  // Paths and arbitrary free-form payloads are not public metadata labels.
  const safe = value === null || (safeText(value, limits, secrets)
    && /^[\p{L}\p{N} _().:+-]+$/u.test(value)
    && !/\.(?:m?js|c?ts|json|ya?ml|pem|key|env|txt|md|py|sh)(?:\b|$)/i.test(value));
  result[key] = safe ? value : '[redacted]';
  if (!safe) result[`${key}_sha256`] = resultDigest(value);
}
function publicRef(value, limits, secrets) {
  refName(value, limits);
  invariant(!forbiddenText.test(value) && !secrets.some((secret) => secret && value.toLowerCase().includes(secret.toLowerCase())),
    'PUBLIC_READ_RESULT_UNSAFE', 'Ref metadata requires a private read');
  return value;
}
function bool(value) {
  invariant(typeof value === 'boolean', 'PUBLIC_READ_RESULT_UNSAFE', 'Missing public boolean');
  return value;
}
function member(value, values, nullable = false) {
  invariant((nullable && value === null) || values.includes(value), 'PUBLIC_READ_RESULT_UNSAFE', 'Unexpected public metadata enum');
  return value;
}
function timestamp(value) {
  invariant(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)), 'PUBLIC_READ_RESULT_UNSAFE', 'Invalid observation timestamp');
  return value;
}
function list(value, max) {
  invariant(Array.isArray(value) && value.length <= max, 'PUBLIC_READ_RESULT_UNSAFE', 'Public metadata exceeds collection bounds');
  return value;
}
const states = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'];
const conclusions = ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'];
const statuses = ['success', 'failure', 'pending', 'error'];

export function sanitizePublicRead(action, raw, limits, sensitive = []) {
  const secrets = sensitive.filter((item) => typeof item === 'string' && item.length > 0);
  invariant(PUBLIC_READ_ACTIONS.includes(action), 'PUBLIC_READ_RESULT_UNSAFE', 'Only public typed reads may publish results');
  invariant(raw?.schema_version === 1, 'PUBLIC_READ_RESULT_UNSAFE', 'Unsupported public read result schema');
  if (action === 'read.capabilities') {
    invariant(raw.read_plane_version === READ_PLANE_VERSION
      && canonicalSerialize(raw.public_read_actions) === canonicalSerialize(PUBLIC_READ_ACTIONS)
      && canonicalSerialize(raw.private_read_actions) === canonicalSerialize(PRIVATE_READ_ACTIONS)
      && canonicalSerialize(raw.read_query_kinds) === canonicalSerialize(READ_QUERY_KINDS),
    'PUBLIC_READ_RESULT_UNSAFE', 'Invalid installed read capabilities');
    const safeLimits = Object.fromEntries(READ_LIMIT_KEYS.map((key) => [key, integer(raw.limits?.[key])]));
    return { schema_version: 1, observed_at: timestamp(raw.observed_at), read_plane_version: READ_PLANE_VERSION,
      public_read_actions: [...PUBLIC_READ_ACTIONS], private_read_actions: [...PRIVATE_READ_ACTIONS],
      read_query_kinds: [...READ_QUERY_KINDS], limits: safeLimits,
      supports_fallback_freeze: bool(raw.supports_fallback_freeze),
      supports_read_after_write_freeze: bool(raw.supports_read_after_write_freeze) };
  }
  invariant(raw.stable === true, 'PUBLIC_READ_RESULT_UNSAFE', 'Only a stable freeze may succeed');
  const result = { schema_version: 1,
    observed_at_start: timestamp(raw.observed_at_start), observed_at_end: timestamp(raw.observed_at_end), stable: true,
    includes: { checks: bool(raw.includes?.checks), workflows: bool(raw.includes?.workflows), reviews: bool(raw.includes?.reviews) },
    repository: { default_branch: publicRef(raw.repository?.default_branch, limits, secrets),
      default_branch_sha: sha(raw.repository?.default_branch_sha), default_branch_tree_sha: sha(raw.repository?.default_branch_tree_sha) },
  };
  invariant(Date.parse(result.observed_at_start) <= Date.parse(result.observed_at_end), 'PUBLIC_READ_RESULT_UNSAFE', 'Invalid observation interval');
  result.branches = list(raw.branches, limits.max_freeze_branches).map((branch) => ({
    ref: publicRef(branch.ref, limits, secrets), exists: bool(branch.exists),
    sha: branch.exists ? sha(branch.sha) : null, tree_sha: branch.exists ? sha(branch.tree_sha) : null,
  }));
  result.prs = list(raw.prs, limits.max_freeze_prs).map((pr) => {
    const item = { number: integer(pr.number), state: member(pr.state, ['open', 'closed']), draft: bool(pr.draft), merged: bool(pr.merged),
      mergeable: pr.mergeable === null ? null : bool(pr.mergeable),
      mergeable_state: member(pr.mergeable_state, ['clean', 'dirty', 'unknown', 'unstable', 'blocked', 'behind', 'draft', 'has_hooks']),
      head_ref: publicRef(pr.head_ref, limits, secrets), head_sha: sha(pr.head_sha), head_tree_sha: sha(pr.head_tree_sha),
      base_ref: publicRef(pr.base_ref, limits, secrets), base_sha: sha(pr.base_sha), base_tree_sha: sha(pr.base_tree_sha),
      commit_count: integer(pr.commit_count, Number.MAX_SAFE_INTEGER, 0), changed_file_count: integer(pr.changed_file_count, Number.MAX_SAFE_INTEGER, 0) };
    if (result.includes.reviews) {
      item.review_decision = member(pr.review_decision, ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'], true);
      item.unresolved_review_thread_count = integer(pr.unresolved_review_thread_count, limits.max_review_threads, 0);
    }
    return item;
  });
  result.issues = list(raw.issues, limits.max_freeze_issues).map((issue) => ({ number: integer(issue.number),
    state: member(issue.state, ['open', 'closed']), state_reason: member(issue.state_reason, ['completed', 'not_planned', 'reopened', 'duplicate'], true),
    locked: bool(issue.locked), comments_count: integer(issue.comments_count, Number.MAX_SAFE_INTEGER, 0), updated_at: timestamp(issue.updated_at) }));
  result.relevant_shas = list(raw.relevant_shas, limits.max_freeze_shas).map(sha);
  invariant(new Set(result.relevant_shas).size === result.relevant_shas.length, 'PUBLIC_READ_RESULT_UNSAFE', 'Duplicate SHA scope');
  result.checks = list(raw.checks, limits.max_freeze_shas).map((checks) => ({
    sha: sha(checks.sha), combined_status: member(checks.combined_status, statuses),
    observed_check_run_count: integer(checks.observed_check_run_count, limits.max_freeze_history_items, 0),
    observed_status_count: integer(checks.observed_status_count, limits.max_freeze_history_items, 0),
    check_runs: list(checks.check_runs, limits.max_check_runs).map((run) => {
      const item = { id: integer(run.id), status: member(run.status, states), conclusion: member(run.conclusion, conclusions, true) };
      label(item, 'name', run.name, limits, secrets);
      label(item, 'app_slug', run.app_slug, limits, secrets);
      // Idempotent validation of an already-redacted label preserves its digest.
      for (const key of ['name', 'app_slug']) if (run[key] === '[redacted]' && /^[0-9a-f]{64}$/.test(run[`${key}_sha256`] ?? '')) {
        item[`${key}_sha256`] = run[`${key}_sha256`];
      }
      return item;
    }),
    statuses: list(checks.statuses, limits.max_commit_statuses).map((status) => {
      const item = { state: member(status.state, statuses), id: status.id === null ? null : integer(status.id) };
      label(item, 'context', status.context, limits, secrets);
      if (status.context === '[redacted]' && /^[0-9a-f]{64}$/.test(status.context_sha256 ?? '')) item.context_sha256 = status.context_sha256;
      return item;
    }),
  }));
  result.workflows = list(raw.workflows, limits.max_freeze_shas).map((group) => ({ sha: sha(group.sha),
    selection: member(group.selection, ['latest_per_workflow_event']),
    observed_run_count: integer(group.observed_run_count, limits.max_freeze_history_items, 0),
    runs: list(group.runs, limits.max_workflow_runs).map((run) => {
      const item = { id: integer(run.id), workflow_id: integer(run.workflow_id), status: member(run.status, states), conclusion: member(run.conclusion, conclusions, true),
        event: run.event, run_number: integer(run.run_number), run_attempt: integer(run.run_attempt), head_sha: sha(run.head_sha) };
      invariant(typeof run.event === 'string' && /^[a-z_]{1,60}$/.test(run.event), 'PUBLIC_READ_RESULT_UNSAFE', 'Invalid event metadata');
      invariant(item.head_sha === group.sha, 'PUBLIC_READ_RESULT_UNSAFE', 'Workflow run is not scoped to the exact SHA');
      label(item, 'name', run.name, limits, secrets);
      if (run.name === '[redacted]' && /^[0-9a-f]{64}$/.test(run.name_sha256 ?? '')) item.name_sha256 = run.name_sha256;
      return item;
    }),
  }));
  for (const group of result.checks) {
    invariant(group.observed_check_run_count >= group.check_runs.length && group.observed_status_count >= group.statuses.length,
      'PUBLIC_READ_RESULT_UNSAFE', 'Check history coverage count is invalid');
  }
  for (const group of result.workflows) {
    invariant(group.observed_run_count >= group.runs.length
      && new Set(group.runs.map((run) => `${run.workflow_id}:${run.event}`)).size === group.runs.length,
      'PUBLIC_READ_RESULT_UNSAFE', 'Workflow history coverage or latest identity is invalid');
  }
  for (const [key, included] of [['checks', result.includes.checks], ['workflows', result.includes.workflows]]) {
    invariant(included ? canonicalSerialize(result[key].map((item) => item.sha).sort()) === canonicalSerialize([...result.relevant_shas].sort()) : result[key].length === 0,
      'PUBLIC_READ_RESULT_UNSAFE', 'Exact-SHA evidence coverage is incomplete');
  }
  return result;
}

export function assertPublicRead(action, result, limits, sensitive = []) {
  const sanitized = sanitizePublicRead(action, result, limits, sensitive);
  invariant(canonicalSerialize(sanitized) === canonicalSerialize(result), 'PUBLIC_READ_RESULT_UNSAFE', 'Public result includes non-schema fields');
  return sanitized;
}
export function mutationReceiptResult(status, privateReceipt, errorCode = undefined) {
  return { completed: status === 'SUCCESS', private_receipt: privateReceipt === true, ...(errorCode ? { code: errorCode } : {}) };
}
export function publicSuccessResult(command, result, privateReceipt, limits, sensitive = []) {
  if (!isRead(command.action)) return mutationReceiptResult('SUCCESS', privateReceipt);
  const envelope = verifyReadResult(result, limits);
  if (command.action === 'read.query') {
    invariant(privateReceipt === true, 'PRIVATE_RECEIPT_WRITE_FAILED', 'Private read result was not delivered');
    invariant(READ_QUERY_KINDS.includes(envelope.result.query_kind) && envelope.result.query_kind === command.kind, 'READ_RESULT_INVALID', 'Invalid private query kind');
    return { completed: true, private_receipt: true, result_sha256: envelope.result_sha256,
      result_bytes: envelope.result_bytes, query_kind: envelope.result.query_kind };
  }
  assertPublicRead(command.action, envelope.result, limits, sensitive);
  return { completed: true, ...envelope };
}
export function privateReceiptBody(command, status, result, limits) {
  let json;
  if (isRead(command.action)) {
    if (status === 'SUCCESS') verifyReadResult(result, limits);
    json = canonicalSerialize(result ?? null);
  } else json = JSON.stringify(result ?? null, null, 2).slice(0, 12000);
  return [`<!-- reporelay-private-receipt request_id=${command.request_id} status=${status} -->`,
    `**RepoRelay ${status}** — \`${command.action}\``, '', '```json', json, '```'].join('\n');
}
export function publicReadFailure(error) {
  const details = error?.details;
  if (error?.code === 'READ_FREEZE_MOVED') {
    const result = { guidance: 'new_request_id' };
    for (const key of ['before_sha256', 'after_sha256']) if (/^[0-9a-f]{64}$/.test(details?.[key] ?? '')) result[key] = details[key];
    return result;
  }
  if (error?.code === 'READ_RESULT_TOO_LARGE') {
    const result = { guidance: ['reduce_freeze_scope', 'reduce_page_or_line_range', 'upstream_source_limit', 'use_paged_query'].includes(details?.guidance)
      ? details.guidance : 'reduce_page_or_line_range' };
    for (const key of ['result_bytes', 'max_read_result_bytes', 'max_source_bytes']) {
      if (Number.isSafeInteger(details?.[key]) && details[key] >= 0) result[key] = details[key];
    }
    return result;
  }
  return undefined;
}
