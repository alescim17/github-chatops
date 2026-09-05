import crypto from 'node:crypto';
import { invariant, RepoRelayError } from './core.mjs';

export const READ_PLANE_VERSION = '1.0.1';
export const PUBLIC_READ_ACTIONS = Object.freeze(['read.capabilities', 'read.freeze']);
export const PRIVATE_READ_ACTIONS = Object.freeze(['read.query']);
const BODY = ['body_start_line', 'body_end_line'];
const PAGE = ['page', 'per_page'];
const PR_PAGE = ['pr', ...PAGE, 'expected_head_sha'];
export const QUERY_FIELDS = Object.freeze({
  repository: [],
  branch: ['ref'],
  'branches.list': PAGE,
  commit: ['sha', ...BODY],
  'commits.list': ['ref', ...PAGE],
  tree: ['ref', 'tree_sha', 'recursive', ...PAGE],
  file: ['ref', 'path', 'start_line', 'end_line'],
  compare: ['base_sha', 'head_sha', ...PAGE],
  'code.search': ['terms', ...PAGE],
  issue: ['issue', ...BODY],
  'issue.comments': ['issue', ...PAGE, ...BODY],
  pr: ['pr', ...BODY],
  'pr.files': PR_PAGE,
  'pr.diff': ['pr', 'expected_head_sha', 'start_line', 'end_line'],
  'pr.comments': [...PR_PAGE, ...BODY],
  'pr.reviews': [...PR_PAGE, ...BODY],
  'pr.threads': ['pr', 'after', 'per_page', 'expected_head_sha'],
  checks: ['sha', ...PAGE],
  'workflow.runs': ['sha', ...PAGE],
  'workflow.run': ['run'],
  'workflow.jobs': ['run', 'attempt', ...PAGE],
  'workflow.job.log': ['job', 'start_line', 'end_line', 'tail_lines'],
  'workflow.artifacts': ['run', ...PAGE],
});
export const READ_QUERY_KINDS = Object.freeze(Object.keys(QUERY_FIELDS));
export const READ_LIMIT_KEYS = Object.freeze([
  'max_freeze_branches', 'max_freeze_prs', 'max_freeze_issues', 'max_freeze_shas',
  'max_read_result_bytes', 'max_file_lines', 'max_diff_lines', 'max_comment_items',
  'max_search_results', 'max_workflow_runs', 'max_workflow_jobs', 'max_log_lines',
  'max_read_page', 'max_read_page_size', 'max_read_requests', 'max_read_source_bytes',
  'max_read_timeout_ms', 'max_read_ref_bytes', 'max_read_path_bytes', 'max_read_path_depth',
  'max_tree_entries', 'max_review_threads', 'max_check_runs', 'max_commit_statuses',
  'max_branch_items', 'max_commit_items', 'max_pr_files', 'max_artifact_items',
  'max_workflow_steps', 'max_search_terms', 'max_search_term_bytes', 'max_parent_commits',
  'max_public_label_bytes', 'max_freeze_history_items',
]);

export function readLimits(policy) {
  const limits = {};
  for (const key of READ_LIMIT_KEYS) {
    invariant(Number.isSafeInteger(policy?.limits?.[key]) && policy.limits[key] > 0,
      'READ_POLICY_INVALID', 'A required read limit is missing or invalid');
    limits[key] = policy.limits[key];
  }
  invariant(limits.max_read_result_bytes <= 10240 && limits.max_read_page_size <= 100,
    'READ_POLICY_INVALID', 'Read transport or GitHub page ceiling exceeded');
  return limits;
}

export function integer(value, max = Number.MAX_SAFE_INTEGER, min = 1) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max,
    'READ_FIELD_INVALID', 'Expected a bounded integer');
  return value;
}
export function sha(value) {
  invariant(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
    'READ_SHA_INVALID', 'A full lowercase 40-character Git SHA is required');
  return value;
}
export function refName(value, limits) {
  invariant(typeof value === 'string' && Buffer.byteLength(value) <= limits.max_read_ref_bytes
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..')
    && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.')
    && !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')),
  'READ_REF_INVALID', 'Expected a safe explicit ref');
  return value;
}
export function branchName(value, limits) {
  refName(value, limits);
  invariant(!value.startsWith('refs/') || value.startsWith('refs/heads/'),
    'READ_REF_INVALID', 'A branch or refs/heads ref is required');
  return value.replace(/^refs\/heads\//, '');
}
export function filePath(value, limits) {
  invariant(typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value) <= limits.max_read_path_bytes && value.normalize('NFC') === value
    && !value.startsWith('/') && !value.includes('..') && !/[\\:\p{Cc}\p{Cf}]/u.test(value)
    && value.split('/').length <= limits.max_read_path_depth
    && value.split('/').every((part) => part.length > 0 && part !== '.'),
  'READ_PATH_INVALID', 'Expected a bounded repository-relative path');
  return value;
}
export function exactKeys(object, allowed) {
  invariant(object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).every((key) => allowed.includes(key)),
  'READ_FIELDS_UNKNOWN', 'Unknown typed-read fields are forbidden');
}
function range(command, start, end, max, required = true) {
  if (!required && command[start] === undefined && command[end] === undefined) return;
  integer(command[start]);
  integer(command[end]);
  invariant(command[end] >= command[start] && command[end] - command[start] + 1 <= max,
    'READ_RANGE_INVALID', 'Requested line range exceeds the configured limit');
}
function arrayOf(value, max, validate) {
  invariant(Array.isArray(value) && value.length <= max, 'READ_COLLECTION_INVALID', 'Read collection exceeds its limit');
  value.forEach(validate);
  invariant(new Set(value).size === value.length, 'READ_COLLECTION_INVALID', 'Duplicate read selectors are forbidden');
}

export function validateReadCommand(command, limits) {
  const base = ['v', 'request_id', 'repository', 'action'];
  invariant(command?.v === 1 && typeof command.request_id === 'string'
    && /^[A-Za-z0-9._:-]{1,120}$/.test(command.request_id), 'READ_FIELD_INVALID', 'Invalid typed-read envelope');
  if (command.action === 'read.capabilities') {
    exactKeys(command, base);
    return;
  }
  if (command.action === 'read.freeze') {
    exactKeys(command, [...base, 'branches', 'prs', 'issues', 'include_checks', 'include_workflows', 'include_reviews']);
    arrayOf(command.branches ?? [], limits.max_freeze_branches, (ref) => branchName(ref, limits));
    invariant(new Set((command.branches ?? []).map((ref) => branchName(ref, limits))).size === (command.branches ?? []).length,
      'READ_COLLECTION_INVALID', 'Duplicate normalized branches are forbidden');
    arrayOf(command.prs ?? [], limits.max_freeze_prs, (n) => integer(n));
    arrayOf(command.issues ?? [], limits.max_freeze_issues, (n) => integer(n));
    for (const key of ['include_checks', 'include_workflows', 'include_reviews']) {
      invariant(command[key] === undefined || typeof command[key] === 'boolean', 'READ_FIELD_INVALID', 'Read options must be booleans');
    }
    return;
  }
  invariant(command.action === 'read.query', 'ACTION_UNSUPPORTED', 'Unsupported typed-read action');
  invariant(Object.hasOwn(QUERY_FIELDS, command.kind), 'READ_KIND_UNSUPPORTED', 'Unknown read query kind');
  exactKeys(command, [...base, 'kind', ...QUERY_FIELDS[command.kind]]);
  const fields = QUERY_FIELDS[command.kind];
  const required = (key) => invariant(command[key] !== undefined, 'READ_FIELD_INVALID', 'A required read selector is missing');
  for (const key of ['issue', 'pr', 'run', 'job']) {
    if (fields.includes(key)) { required(key); integer(command[key]); }
  }
  for (const key of ['sha', 'base_sha', 'head_sha', 'tree_sha', 'expected_head_sha']) {
    if (command[key] !== undefined) sha(command[key]);
  }
  if (command.ref !== undefined) refName(command.ref, limits);
  if (['branch', 'commits.list', 'file'].includes(command.kind)) required('ref');
  if (command.kind === 'branch') branchName(command.ref, limits);
  if (['commit', 'checks'].includes(command.kind)) required('sha');
  if (command.kind === 'compare') { required('base_sha'); required('head_sha'); }
  if (command.kind === 'tree') {
    invariant((command.ref !== undefined) !== (command.tree_sha !== undefined), 'READ_FIELD_INVALID', 'Provide exactly one ref or tree_sha');
    invariant(command.recursive === undefined || typeof command.recursive === 'boolean', 'READ_FIELD_INVALID', 'recursive must be boolean');
  }
  const pageLimits = {
    'branches.list': limits.max_branch_items, 'commits.list': limits.max_commit_items,
    tree: limits.max_read_page_size, compare: limits.max_commit_items,
    'code.search': limits.max_search_results, 'pr.files': limits.max_pr_files,
    'workflow.runs': limits.max_workflow_runs, 'workflow.jobs': limits.max_workflow_jobs,
    'workflow.artifacts': limits.max_artifact_items, checks: Math.min(limits.max_check_runs, limits.max_commit_statuses),
  };
  if (fields.includes('page')) integer(command.page, limits.max_read_page);
  if (fields.includes('per_page')) integer(command.per_page, Math.min(limits.max_read_page_size, pageLimits[command.kind] ?? limits.max_comment_items));
  if (command.kind === 'file') { filePath(command.path, limits); range(command, 'start_line', 'end_line', limits.max_file_lines); }
  if (command.kind === 'pr.diff') range(command, 'start_line', 'end_line', limits.max_diff_lines);
  if (fields.includes('body_start_line')) range(command, 'body_start_line', 'body_end_line', limits.max_file_lines, false);
  if (command.kind === 'pr.threads' && command.after !== undefined) {
    invariant(typeof command.after === 'string' && /^[A-Za-z0-9+/=_:-]{1,256}$/.test(command.after), 'READ_FIELD_INVALID', 'Invalid pagination cursor');
  }
  if (command.kind === 'workflow.jobs' && command.attempt !== undefined) integer(command.attempt);
  if (command.kind === 'workflow.job.log') {
    if (command.tail_lines !== undefined) {
      integer(command.tail_lines, limits.max_log_lines);
      invariant(command.start_line === undefined && command.end_line === undefined, 'READ_RANGE_INVALID', 'Choose tail or line range, not both');
    } else range(command, 'start_line', 'end_line', limits.max_log_lines);
  }
  if (command.kind === 'code.search') {
    arrayOf(command.terms, limits.max_search_terms, (term) => invariant(typeof term === 'string'
      && Buffer.byteLength(term) <= limits.max_search_term_bytes && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(term)
      && !/^(OR|AND|NOT)$/i.test(term), 'READ_SEARCH_INVALID', 'Only literal search terms are accepted'));
    invariant(command.terms.length > 0, 'READ_SEARCH_INVALID', 'At least one literal search term is required');
  }
}

export function canonicalSerialize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'READ_RESULT_INVALID', 'Read result contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  invariant(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'READ_RESULT_INVALID', 'Read result must be plain JSON data');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(',')}}`;
}
export function resultDigest(value) {
  return crypto.createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}
export function tooLarge(guidance = 'reduce_page_or_line_range', details = {}) {
  throw new RepoRelayError('READ_RESULT_TOO_LARGE', 'The complete requested read cannot fit its explicit bounds', { guidance, ...details });
}
export function sealReadResult(result, limits) {
  const serialized = canonicalSerialize(result);
  const resultBytes = Buffer.byteLength(serialized, 'utf8');
  if (resultBytes > limits.max_read_result_bytes) tooLarge('reduce_page_or_line_range', {
    result_bytes: resultBytes, max_read_result_bytes: limits.max_read_result_bytes,
  });
  return { result, result_sha256: resultDigest(result), result_bytes: resultBytes };
}
export function verifyReadResult(envelope, limits) {
  exactKeys(envelope, ['result', 'result_sha256', 'result_bytes']);
  const verified = sealReadResult(envelope.result, limits);
  invariant(envelope.result_sha256 === verified.result_sha256 && envelope.result_bytes === verified.result_bytes,
    'READ_DIGEST_MISMATCH', 'Read result identity does not match the receipt metadata');
  return verified;
}

export function lineRange(text, start, end) {
  invariant(typeof text === 'string' && !text.includes('\0'), 'READ_TEXT_INVALID', 'Expected UTF-8 text without NUL');
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const requestedEnd = end;
  const actualEnd = Math.min(end, lines.length);
  invariant(start <= lines.length || (start === 1 && lines.length === 0), 'READ_RANGE_INVALID', 'Requested start is past the end of the text');
  return { start_line: start, end_line: actualEnd, requested_end_line: requestedEnd, total_lines: lines.length,
    has_more: actualEnd < lines.length, text: lines.slice(start - 1, actualEnd).join('\n') };
}
export function bodyResult(text, command) {
  invariant(typeof text === 'string' || text === null, 'READ_UPSTREAM_SHAPE_INVALID', 'Missing text metadata');
  const body = text ?? '';
  return command.body_start_line === undefined ? body : lineRange(body, command.body_start_line, command.body_end_line);
}
