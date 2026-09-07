import { invariant, parseCommand, commandHash } from './core.mjs';
import { ReadClient } from './read-client.mjs';
import { readLimits } from './read-contract.mjs';

// Existing RepoRelay App, not the generic GitHub Actions identity. No new rights.
export function isRepoRelayReceipt(comment) {
  return comment?.user?.login === 'reporelay-control[bot]' && comment.user.id === 322612842
    && comment.user.type === 'Bot' && comment.performed_via_github_app?.id === 4764725;
}
export function isLegacyReceipt(comment) {
  return comment?.user?.login === 'github-actions[bot]' && comment.user.id === 41898282
    && comment.user.type === 'Bot' && comment.performed_via_github_app?.id === 15368;
}
const unverified = (condition) => invariant(condition, 'REQUEST_AUTHORITY_UNVERIFIED', 'RepoRelay-specific request authority could not be established');
const validSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
function sourceIdentity(comment) {
  return JSON.stringify([comment.id, comment.user?.login, comment.user?.id, comment.issue_url,
    comment.created_at, comment.updated_at, comment.body]);
}

async function collection(client, route, key, params = {}) {
  const records = [], ids = new Set();
  let total;
  for (let page = 1; ; page++) {
    const response = await client.get(route, { ...params, per_page: 100, page });
    const current = response.data;
    unverified(current && Number.isSafeInteger(current.total_count) && current.total_count >= 0 && Array.isArray(current[key]));
    if (total !== undefined) invariant(total === current.total_count, 'RECEIPT_HISTORY_MOVED', 'Workflow proof history moved');
    total = current.total_count;
    unverified(current[key].length === Math.min(100, total - records.length));
    for (const item of current[key]) {
      unverified(Number.isSafeInteger(item?.id) && item.id > 0 && !ids.has(item.id));
      ids.add(item.id); records.push(item);
    }
    if (records.length === total) { unverified(!response.hasNextPage); return records; }
    // API search truncation, missing pages or the existing request budget cannot
    // establish authority. This is not the unbounded permanent receipt scan.
    unverified(response.hasNextPage);
  }
}

// Legacy GITHUB_TOKEN comments are candidates, never authority by author tuple
// alone. Corroborate exact immutable owner intent AND real RepoRelay job output.
// Log text, private source bodies and mutation payloads never leave this function.
export async function verifyLegacyReceipt(policy, receipt, context) {
  unverified(receipt.status !== 'STARTED' && Number.isSafeInteger(receipt.source_comment_id)
    && typeof context.proofToken === 'string' && context.proofToken.length > 0);
  const limits = readLimits(policy);
  const client = new ReadClient(context.proofToken, context.controlRepository, limits);
  const sourceRoute = `/issues/comments/${receipt.source_comment_id}`;
  const source = (await client.get(sourceRoute)).data;
  const issueUrl = `https://api.github.com/repos/${context.controlRepository}/issues/${context.controlIssue}`;
  const validSource = (value, id, actor) => value?.id === id && typeof value.body === 'string'
    && policy.authorized_actors.includes(value.user?.login) && (!actor || value.user.login === actor)
    && typeof value.created_at === 'string' && value.updated_at === value.created_at
    && Number.isFinite(Date.parse(value.created_at))
    && Date.parse(value.created_at) <= Date.parse(receipt.receipt_created_at);
  unverified(validSource(source, receipt.source_comment_id) && source.issue_url === issueUrl);
  const outer = parseCommand(source.body, policy.limits.max_command_bytes);
  unverified(outer.request_id === receipt.lookup_request_id && outer.repository === receipt.repository);
  let original = outer, privateSource, privateClient;
  if (outer.action === 'relay.private' && receipt.action !== 'relay.private') {
    unverified(Number.isSafeInteger(outer.source_comment_id) && outer.source_comment_id > 0
      && typeof context.targetRepository === 'string');
    privateClient = new ReadClient(context.proofToken, context.targetRepository, limits);
    privateSource = (await privateClient.get(`/issues/comments/${outer.source_comment_id}`)).data;
    unverified(validSource(privateSource, outer.source_comment_id, source.user.login)
      && typeof privateSource.issue_url === 'string'
      && privateSource.issue_url.startsWith(`https://api.github.com/repos/${context.targetRepository}/issues/`)
      && /^[1-9][0-9]*$/.test(privateSource.issue_url.split('/').at(-1))
      && /^\/reporelay-private(?:\s|$)/.test(privateSource.body));
    original = parseCommand(privateSource.body.replace(/^\/reporelay-private/, '/reporelay'), policy.limits.max_command_bytes);
  }
  unverified(original.request_id === receipt.lookup_request_id && original.repository === receipt.repository
    && original.action === receipt.action && commandHash(original) === receipt.command_hash);
  const workflow = (await client.get('/actions/workflows/reporelay.yml')).data;
  unverified(Number.isSafeInteger(workflow?.id) && workflow.id > 0 && workflow.path === '.github/workflows/reporelay.yml');
  const main = (await client.get('/branches/main')).data;
  unverified(main?.name === 'main' && validSha(main.commit?.sha));
  const after = new Date(Date.parse(source.created_at) - 1000).toISOString();
  const before = new Date(Date.parse(receipt.receipt_created_at) + 1000).toISOString();
  const runs = await collection(client, `/actions/workflows/${workflow.id}/runs`, 'workflow_runs',
    { event: 'issue_comment', created: `${after}..${before}` });
  let proofs = 0;
  const ancestors = new Set();
  for (const run of runs) {
    // Caller-supplied run IDs and generic Actions jobs are never accepted.
    if (run.workflow_id !== workflow.id || run.path !== workflow.path || run.event !== 'issue_comment'
      || run.head_branch !== 'main' || run.repository?.full_name !== context.controlRepository
      || run.head_repository?.full_name !== context.controlRepository || run.actor?.login !== source.user.login
      || !validSha(run.head_sha)) continue;
    unverified(Number.isFinite(Date.parse(run.created_at)) && Number.isFinite(Date.parse(run.updated_at)));
    if (Date.parse(run.created_at) > Date.parse(receipt.receipt_created_at)
      || Date.parse(run.updated_at) < Date.parse(receipt.receipt_updated_at)) continue;
    if (!ancestors.has(run.head_sha)) {
      const comparison = (await client.get(`/compare/${run.head_sha}...${main.commit.sha}`)).data;
      unverified(comparison?.merge_base_commit?.sha === run.head_sha && ['ahead', 'identical'].includes(comparison.status));
      ancestors.add(run.head_sha);
    }
    const jobs = await collection(client, `/actions/runs/${run.id}/jobs`, 'jobs', { filter: 'all' });
    for (const job of jobs) {
      if (job.name !== 'execute' || job.run_id !== run.id) continue;
      unverified(Number.isFinite(Date.parse(job.started_at)));
      if (Date.parse(job.started_at) > Date.parse(receipt.receipt_created_at)) continue;
      unverified(job.status === 'completed' && Number.isFinite(Date.parse(job.completed_at)));
      if (Date.parse(job.completed_at) < Date.parse(receipt.receipt_updated_at)) continue;
      const log = (await client.jobLog(job.id)).data;
      unverified(typeof log === 'string');
      for (const line of log.split('\n')) {
        const record = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (\{.*\})\r?$/);
        if (!record) continue;
        let event; try { event = JSON.parse(record[2]); } catch { continue; }
        if (event?.status !== receipt.status || event.request_id !== receipt.lookup_request_id
          || event.action !== receipt.action || event.target !== receipt.repository) continue;
        const time = Date.parse(record[1]);
        unverified(Number.isFinite(time) && time >= Date.parse(job.started_at) && time <= Date.parse(job.completed_at));
        proofs++;
      }
    }
  }
  unverified(proofs === 1);
  const sourceNow = (await client.get(sourceRoute)).data;
  invariant(sourceIdentity(sourceNow) === sourceIdentity(source), 'RECEIPT_HISTORY_MOVED', 'Original request source moved during authority verification');
  if (privateSource) {
    const privateNow = (await privateClient.get(`/issues/comments/${outer.source_comment_id}`)).data;
    invariant(sourceIdentity(privateNow) === sourceIdentity(privateSource), 'RECEIPT_HISTORY_MOVED', 'Private request source moved during authority verification');
  }
  // Old logs bind execution status/intent, not result bytes or delivery flags.
  // Do not elevate uncorroborated legacy payload/digest metadata to authority.
  return {};
}
