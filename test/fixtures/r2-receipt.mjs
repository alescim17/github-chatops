// Safe projection of the real R2 receipt 5567823124; see docs/ISSUE_32.md.
// Values used by recovery retain their observed types and exact public values.
export const control = 'alescim17/github-chatops';
export const alias = 'target/reporelay';
export const requestId = 'rr-r2-20260907-k7m4-rr-freeze';
export const receiptId = 5567823124;
export const issueUrl = `https://api.github.com/repos/${control}/issues/3`;
export const resultSha256 = 'd51f84192bde9eed6a03c9650cad81e492d7a5059e77afd41d63e10606ce305a';
const commandHash = '571ff150413c1a0712825baebba0cc4e4c4ba43ac53862e2d81b836ddcfe714d';
const main = 'bfe8f32dec3a5ce31a45bfdb154ae86f93c01659';
const result = {
  schema_version: 1, observed_at_start: '2026-09-07T08:39:14.034Z',
  observed_at_end: '2026-09-07T08:39:15.478Z', stable: true,
  includes: { checks: false, workflows: false, reviews: false },
  repository: { default_branch: 'main', default_branch_sha: main,
    default_branch_tree_sha: '45b735e0e668105b73903dd209516ed687ffb73d' },
  branches: [], prs: [], issues: [], relevant_shas: [main], checks: [], workflows: [],
};
export function withState(comment, status, envelope) {
  const action = comment.body.match(/ action=([^ ]+)/)[1];
  const repository = comment.body.match(/ repository=([^ ]+)/)[1];
  const first = comment.body.split('\n', 1)[0].replace(/ status=[A-Z]+ -->$/, ` status=${status} -->`);
  const payload = envelope ?? (status === 'STARTED' ? { accepted: true, private_relay: false }
    : status === 'SUCCESS' ? { completed: true, result, result_sha256: resultSha256, result_bytes: 483 }
      : { completed: false, private_receipt: false, code: 'R2_FAILURE_FIXTURE' });
  return { ...structuredClone(comment),
    updated_at: status === 'STARTED' ? '2026-09-07T08:39:13Z' : '2026-09-07T08:39:15Z',
    body: [first, '**RepoRelay ' + status + '** — `' + action + '` on `' + repository + '`', '',
      '`request_id: ' + requestId + '`', '', '```json', JSON.stringify(payload), '```'].join('\n'),
  };
}
export function r2Views(status = 'SUCCESS') {
  const collection = withState({
    id: receiptId, node_id: 'IC_kwDOUIUQUs8AAAABS949FA',
    url: `https://api.github.com/repos/${control}/issues/comments/${receiptId}`,
    html_url: `https://github.com/${control}/issues/3#issuecomment-${receiptId}`,
    issue_url: issueUrl,
    user: { login: 'reporelay-control[bot]', id: 322612842, type: 'Bot',
      node_id: 'BOT_kgDOEzquag', user_view_type: 'public', site_admin: false },
    performed_via_github_app: { id: 4764725, slug: 'reporelay-control',
      node_id: 'A_kwDOBlcn_c4ASLQ1', client_id: 'Iv23litbuo7CDvbhapNF' },
    created_at: '2026-09-07T08:39:13Z', updated_at: '2026-09-07T08:39:15Z',
    author_association: 'CONTRIBUTOR', minimized: null, pin: null,
    body: `<!-- reporelay-receipt source_comment_id=5567819415 request_id=${requestId} action=read.freeze repository=${alias} command_hash=${commandHash} status=SUCCESS -->`,
  }, status);
  // Observed with the real workflow GITHUB_TOKEN, not a guessed absent property.
  const exact = { ...structuredClone(collection), performed_via_github_app: null };
  return { collection, exact };
}

// Existing R2 public mutation receipts. No private source or result content.
export const r2Writes = [
  ['target/reporelay', 'rr', 5567979951, 5567976481, '08:51:10', '08:51:11', '0d7c395f782bd2aa340875c2faf5864f9ab72d7b09359dab07497354bb95af11'],
  ['target/aether', 'ae', 5567981698, 5567978144, '08:51:17', '08:51:20', '42a2e874b50030aef197b30d91ea496727cb2308c56d61ee634b9dd90d1e82b9'],
  ['target/streamforge', 'sf', 5567982987, 5567979201, '08:51:23', '08:51:25', 'e602eb5c0bf332f500796333e973a0c445fd6bc4c64239916dced99344c48031'],
  ['target/homeassistant', 'ha', 5567985401, 5567981310, '08:51:34', '08:51:36', '7e2181eec77e1089638e5184b96fef0759c16946e545091f12102064906e4a97'],
];
export function r2WriteViews([repository, short, id, source, created, updated, hash]) {
  const lookupId = `rr-r2-20260907-k7m4-${short}-write`;
  const collection = r2Views().collection;
  delete collection.node_id; // not needed for these additional minimized vectors
  Object.assign(collection, { id, url: `https://api.github.com/repos/${control}/issues/comments/${id}`,
    html_url: `https://github.com/${control}/issues/3#issuecomment-${id}`,
    created_at: `2026-09-07T${created}Z`, updated_at: `2026-09-07T${updated}Z`,
    body: [`<!-- reporelay-receipt source_comment_id=${source} request_id=${lookupId} action=comment.create repository=${repository} command_hash=${hash} status=SUCCESS -->`,
      '**RepoRelay SUCCESS** — `comment.create` on `' + repository + '`', '', '`request_id: ' + lookupId + '`', '',
      '```json', JSON.stringify({ completed: true, private_receipt: true }, null, 2), '```'].join('\n'),
  });
  return { collection, exact: { ...structuredClone(collection), performed_via_github_app: null }, lookupId, repository };
}
