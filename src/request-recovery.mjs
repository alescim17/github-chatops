import { invariant, githubRequest, scanReceiptHistory } from './core.mjs';
import { PUBLIC_READ_ACTIONS, PRIVATE_READ_ACTIONS, READ_QUERY_KINDS } from './read-contract.mjs';

import { isRepoRelayReceipt, isRepoRelayReceiptContinuation, isLegacyReceipt, verifyLegacyReceipt } from './receipt-authority.mjs';

// A generic Actions writer is only a legacy candidate and requires additional
// verified RepoRelay execution evidence before ANY recovery result can succeed.
const trusted = comment => isRepoRelayReceipt(comment) || isLegacyReceipt(comment);
const marker = /^<!-- reporelay-receipt source_comment_id=([1-9][0-9]*|dispatch-[1-9][0-9]*) request_id=([A-Za-z0-9._:-]{1,120}) action=([a-z][a-z0-9_.-]{1,80}) repository=(target\/[A-Za-z0-9._-]{1,100}) command_hash=([0-9a-f]{64}) status=(STARTED|SUCCESS|FAILED) -->$/;
function timestamp(value) {
  invariant(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)), 'REQUEST_RECEIPT_INVALID', 'Invalid receipt timestamp');
  return value;
}
function positive(value) {
  invariant(Number.isSafeInteger(value) && value > 0, 'REQUEST_RECEIPT_INVALID', 'Invalid receipt identity');
  return value;
}
function matchingReceipt(comment, requestId, issueUrl, authority = trusted) {
  if (!authority(comment) || typeof comment.body !== 'string') return null;
  const first = comment.body.split('\n', 1)[0];
  if (!first.startsWith('<!-- reporelay-receipt ')) return null;
  const claimed = first.match(/(?:^| )request_id=([^ ]+)(?= |$)/)?.[1];
  if (claimed !== requestId) return null;
  invariant(Buffer.byteLength(comment.body, 'utf8') <= 65536, 'REQUEST_RECEIPT_INVALID', 'Receipt exceeds transport bounds');
  const match = first.match(marker);
  invariant(match && comment.issue_url === issueUrl, 'REQUEST_RECEIPT_INVALID', 'Malformed or mis-scoped authoritative receipt');
  const source = match[1].startsWith('dispatch-') ? match[1] : positive(Number(match[1]));
  invariant(typeof source !== 'string' || source.length <= 80, 'REQUEST_RECEIPT_INVALID', 'Invalid dispatch identity');
  const created = timestamp(comment.created_at), updated = timestamp(comment.updated_at);
  invariant(Date.parse(updated) >= Date.parse(created), 'REQUEST_RECEIPT_INVALID', 'Invalid receipt time order');
  return { lookup_request_id: match[2], repository: match[4], action: match[3], status: match[6],
    source_comment_id: source, receipt_comment_id: positive(comment.id), command_hash: match[5],
    receipt_created_at: created, receipt_updated_at: updated };
}
function identity(receipt) {
  return JSON.stringify([receipt.lookup_request_id, receipt.repository, receipt.action,
    receipt.source_comment_id, receipt.receipt_comment_id, receipt.command_hash, receipt.receipt_created_at]);
}
function integrityMetadata(comment, receipt) {
  const match = comment.body.match(/\n```json\n([\s\S]*)\n```$/);
  invariant(match, 'REQUEST_RECEIPT_INVALID', 'Receipt result envelope is missing');
  let envelope;
  try { envelope = JSON.parse(match[1]); } catch {
    invariant(false, 'REQUEST_RECEIPT_INVALID', 'Receipt result envelope is invalid');
  }
  invariant(envelope && typeof envelope === 'object' && !Array.isArray(envelope),
    'REQUEST_RECEIPT_INVALID', 'Receipt result envelope is invalid');
  if (receipt.status === 'STARTED') {
    invariant(envelope.accepted === true, 'REQUEST_RECEIPT_INVALID', 'Invalid in-flight receipt');
    return {}; // private_relay is not evidence of private receipt delivery.
  }
  invariant(envelope.completed === (receipt.status === 'SUCCESS'), 'REQUEST_RECEIPT_INVALID', 'Receipt status and envelope disagree');
  const safe = {};
  if (Object.hasOwn(envelope, 'private_receipt')) {
    invariant(typeof envelope.private_receipt === 'boolean', 'REQUEST_RECEIPT_INVALID', 'Invalid private receipt indicator');
    safe.private_receipt = envelope.private_receipt;
  }
  // Never spread the envelope, its result, error details or mutation payload.
  if ([...PUBLIC_READ_ACTIONS, ...PRIVATE_READ_ACTIONS].includes(receipt.action)) {
    if (Object.hasOwn(envelope, 'result_sha256') || Object.hasOwn(envelope, 'result_bytes')) {
      invariant(typeof envelope.result_sha256 === 'string' && /^[0-9a-f]{64}$/.test(envelope.result_sha256)
        && Number.isSafeInteger(envelope.result_bytes) && envelope.result_bytes >= 0,
      'REQUEST_RECEIPT_INVALID', 'Invalid typed-read integrity metadata');
      safe.result_sha256 = envelope.result_sha256;
      safe.result_bytes = envelope.result_bytes;
    }
    if (Object.hasOwn(envelope, 'query_kind')) {
      invariant(receipt.action === 'read.query' && READ_QUERY_KINDS.includes(envelope.query_kind),
        'REQUEST_RECEIPT_INVALID', 'Invalid typed-read query kind');
      safe.query_kind = envelope.query_kind;
    }
  }
  return safe;
}

export async function lookupRequest(policy, command, context) {
  // These selectors and the token come only from the authorized runner, not JSON.
  invariant(context?.controlRepository === policy.control_repository
    && context.controlIssue === policy.control_issues[0] && context.controlToken
    && policy.allowed_repositories.includes(context.targetAlias)
    && /^target\/[A-Za-z0-9._-]{1,100}$/.test(context.targetAlias),
  'READ_REQUEST_CONTEXT_INVALID', 'Request recovery requires the permanent control-bus context');
  const issueUrl = `https://api.github.com/repos/${context.controlRepository}/issues/${context.controlIssue}`;
  let selected = null, selectedComment = null;
  await scanReceiptHistory(context.controlToken, context.controlRepository, context.controlIssue, comments => {
    for (const comment of comments) {
      const candidate = matchingReceipt(comment, command.lookup_request_id, issueUrl);
      if (!candidate) continue;
      invariant(candidate.repository === context.targetAlias, 'REQUEST_TARGET_MISMATCH', 'Request belongs to another target alias');
      invariant(selected === null, 'REQUEST_ID_AMBIGUOUS', 'Multiple authoritative receipts claim this request identity');
      selected = candidate;
      selectedComment = comment;
    }
  }, { complete: true });
  const base = { schema_version: 1, observed_at: new Date().toISOString(),
    lookup_request_id: command.lookup_request_id, repository: context.targetAlias };
  if (!selected) return { ...base, found: false };
  // Anchor the authority class to the complete-history view, never an optional
  // exact-endpoint projection or a substituted generic Actions identity.
  const appAuthority = isRepoRelayReceipt(selectedComment);
  // STARTED is updated in place. Read the exact comment AFTER the complete scan.
  // A deleted/unreadable receipt is an error, never NOT_FOUND or inferred success.
  const currentComment = await githubRequest(context.controlToken, 'GET',
    `/repos/${context.controlRepository}/issues/comments/${selected.receipt_comment_id}`);
  const current = matchingReceipt(currentComment, command.lookup_request_id, issueUrl, comment =>
    appAuthority ? isRepoRelayReceiptContinuation(selectedComment, comment) : isLegacyReceipt(comment));
  invariant(current && identity(current) === identity(selected)
    && Date.parse(current.receipt_updated_at) >= Date.parse(selected.receipt_updated_at)
    && (selected.status === 'STARTED' || current.status === selected.status)
    // Only STARTED -> terminal can change the authenticated receipt body.
    && ((selected.status === 'STARTED' && current.status !== 'STARTED')
      || currentComment.body === selectedComment.body),
  'RECEIPT_HISTORY_MOVED', 'Authoritative receipt identity or terminal state moved');
  const metadata = appAuthority
    ? integrityMetadata(currentComment, current)
    : await verifyLegacyReceipt(policy, current, context);
  if (!appAuthority) {
    const verified = await githubRequest(context.controlToken, 'GET',
      `/repos/${context.controlRepository}/issues/comments/${selected.receipt_comment_id}`);
    invariant(isLegacyReceipt(verified) && verified.id === currentComment.id
      && verified.issue_url === currentComment.issue_url && verified.created_at === currentComment.created_at
      && verified.updated_at === currentComment.updated_at && verified.body === currentComment.body,
    'RECEIPT_HISTORY_MOVED', 'Receipt changed during legacy authority verification');
  }
  return { ...base, observed_at: new Date().toISOString(), found: true, ...current,
    terminal: current.status !== 'STARTED', ...metadata };
}
