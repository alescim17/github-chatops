import crypto from 'node:crypto';
import { githubRequest, scanReceiptHistory, loadPolicy } from '../../src/core.mjs';
import { isRepoRelayReceipt } from '../../src/receipt-authority.mjs';
import { lookupRequest } from '../../src/request-recovery.mjs';

// Temporary, fixed R2 control-bus GET-only diagnostic. Never print raw responses.
const repository = 'alescim17/github-chatops';
const receiptId = 5567823124;
const requestId = 'rr-r2-20260907-k7m4-rr-freeze';
const token = process.env.R3_DIAGNOSTIC_CONTROL_TOKEN;
const out = (key, value) => console.log(`R3_DIAG ${key}=${value}`);
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const hash = body => typeof body === 'string' ? crypto.createHash('sha256').update(body).digest('hex') : null;
const state = comment => comment?.body?.split('\n', 1)[0]?.match(/ status=(STARTED|SUCCESS|FAILED) -->$/)?.[1] || 'INVALID';
try {
  let collection;
  await scanReceiptHistory(token, repository, 3, comments => {
    for (const comment of comments) if (comment.id === receiptId) collection = comment;
  }, { complete: true });
  if (!collection) throw new Error('fixed receipt missing');
  const exact = await githubRequest(token, 'GET', `/repos/${repository}/issues/comments/${receiptId}`);
  for (const field of ['id', 'node_id', 'url', 'issue_url', 'created_at', 'updated_at']) {
    out(`${field}_equal`, collection[field] === exact?.[field]);
    out(`${field}_collection_type`, kind(collection[field]));
    out(`${field}_exact_type`, kind(exact?.[field]));
  }
  for (const field of ['login', 'id', 'type', 'node_id']) {
    out(`user_${field}_equal`, collection.user?.[field] === exact?.user?.[field]);
    out(`user_${field}_collection_type`, kind(collection.user?.[field]));
    out(`user_${field}_exact_type`, kind(exact?.user?.[field]));
  }
  for (const [name, comment] of [['collection', collection], ['exact', exact]]) {
    out(`app_${name}_own`, Object.hasOwn(comment, 'performed_via_github_app'));
    out(`app_${name}_type`, kind(comment.performed_via_github_app));
    out(`app_id_${name}_type`, kind(comment.performed_via_github_app?.id));
    out(`app_id_${name}_expected`, comment.performed_via_github_app?.id === 4764725);
    out(`reporelay_authority_${name}`, isRepoRelayReceipt(comment));
    out(`status_${name}`, state(comment));
  }
  out('app_id_equal', collection.performed_via_github_app?.id === exact?.performed_via_github_app?.id);
  out('body_equal', collection.body === exact?.body);
  out('body_hash_equal', hash(collection.body) === hash(exact?.body));
  out('marker_equal', collection.body?.split('\n', 1)[0] === exact?.body?.split('\n', 1)[0]);
  const before = Date.parse(collection.updated_at), after = Date.parse(exact?.updated_at);
  out('updated_at_relation', !Number.isFinite(before) || !Number.isFinite(after) ? 'INVALID' : before === after ? 'equal' : after > before ? 'newer' : 'older');
  const policy = await loadPolicy();
  try {
    const result = await lookupRequest(policy, { lookup_request_id: requestId }, {
      controlRepository: repository, controlIssue: 3, controlToken: token, targetAlias: 'target/reporelay'
    });
    out('lookup_found', result.found === true);
    out('lookup_terminal', result.terminal === true);
  } catch (error) {
    out('lookup_code', /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'UNEXPECTED_ERROR');
  }
} catch {
  out('diagnostic', 'FAILED');
  process.exitCode = 1;
}
