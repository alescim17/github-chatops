import {
  RepoRelayError,
  invariant,
  splitRepository,
  githubRequest,
  graphql,
  getPullGovernance,
  assertExpectedHead,
  assertExpectedBase,
  getCurrentChecks,
  assertChecksGreen,
} from '../core.mjs';
import { requireNumber, requireString } from './common.mjs';

export async function handlePrCreate(token, command) {
  const { owner, repo } = splitRepository(command.repository);
  const payload = {
    title: requireString(command, 'title'),
    head: requireString(command, 'head'),
    base: requireString(command, 'base'),
    draft: command.draft === true,
  };
  if (typeof command.body === 'string') payload.body = command.body;
  if (command.maintainer_can_modify !== undefined) payload.maintainer_can_modify = command.maintainer_can_modify === true;
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, payload);
}

export async function handlePrUpdate(token, command) {
  const number = requireNumber(command, 'pr');
  if (command.expected_head_sha) await assertExpectedHead(token, command.repository, number, command.expected_head_sha);
  const { owner, repo } = splitRepository(command.repository);
  const payload = {};
  for (const key of ['title', 'body', 'state', 'base']) if (command[key] !== undefined) payload[key] = command[key];
  if (command.maintainer_can_modify !== undefined) payload.maintainer_can_modify = command.maintainer_can_modify === true;
  invariant(Object.keys(payload).length > 0, 'PR_UPDATE_EMPTY', 'pr.update requires at least one mutable field');
  return githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/pulls/${number}`, payload);
}

export async function setDraftState(token, command, ready) {
  const number = requireNumber(command, 'pr');
  const expected = requireString(command, 'expected_head_sha', /^[0-9a-f]{40}$/i);
  await assertExpectedHead(token, command.repository, number, expected);
  const { owner, repo } = splitRepository(command.repository);
  const governance = await getPullGovernance(token, command.repository, number);
  if (ready && !governance.isDraft) return { no_op: true, state: 'ready' };
  if (!ready && governance.isDraft) return { no_op: true, state: 'draft' };
  const mutation = ready ? 'markPullRequestReadyForReview' : 'convertPullRequestToDraft';
  const data = await graphql(token, `
    mutation($id: ID!) {
      ${mutation}(input: { pullRequestId: $id }) {
        pullRequest { number isDraft headRefOid }
      }
    }
  `, { id: governance.id });
  const pr = data?.[mutation]?.pullRequest;
  if (pr?.headRefOid !== expected) {
    if (ready && pr?.isDraft === false) {
      // Ready has no atomic expected-head argument in GitHub GraphQL. Restore the
      // conservative Draft state if the head raced after our precondition check.
      await graphql(token, `
        mutation($id: ID!) {
          convertPullRequestToDraft(input: { pullRequestId: $id }) {
            pullRequest { number isDraft headRefOid }
          }
        }
      `, { id: governance.id });
    }
    throw new RepoRelayError('EXPECTED_HEAD_MISMATCH', 'Pull request head moved during draft-state transition', {
      expected,
      actual: pr?.headRefOid || null,
      restored_draft: ready && pr?.isDraft === false,
    });
  }
  return { number: pr.number, draft: pr.isDraft, head_sha: pr.headRefOid, repository: `${owner}/${repo}` };
}

export async function handlePrMerge(token, policy, command) {
  const number = requireNumber(command, 'pr');
  const expectedHead = requireString(command, 'expected_head_sha', /^[0-9a-f]{40}$/i);
  const method = command.method || 'merge';
  invariant(policy.merge_methods.includes(method), 'MERGE_METHOD_FORBIDDEN', `Merge method ${method} is not allowed`);
  let pr = await assertExpectedHead(token, command.repository, number, expectedHead);
  await assertExpectedBase(token, pr, command.expected_base_sha);
  invariant(pr.state === 'open', 'PR_NOT_OPEN', 'Pull request is not open');
  invariant(pr.draft === false, 'PR_IS_DRAFT', 'Pull request is still draft');
  if (policy.merge.require_mergeable) invariant(pr.mergeable === true, 'PR_NOT_MERGEABLE', 'Pull request is not currently mergeable', { mergeable: pr.mergeable, mergeable_state: pr.mergeable_state });
  const governance = await getPullGovernance(token, command.repository, number);
  if (policy.merge.require_no_changes_requested) invariant(governance.reviewDecision !== 'CHANGES_REQUESTED', 'REVIEW_CHANGES_REQUESTED', 'Pull request has requested changes');
  if (policy.merge.require_no_unresolved_review_threads) {
    const unresolved = governance.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
    invariant(unresolved === 0, 'REVIEW_THREADS_UNRESOLVED', 'Pull request has unresolved review threads', { unresolved });
  }
  if (policy.merge.require_current_checks_green || policy.merge.require_any_check) {
    const checks = await getCurrentChecks(token, command.repository, expectedHead);
    if (policy.merge.require_any_check) {
      invariant(checks.checkRuns.length + checks.statuses.length > 0, 'CHECK_EVIDENCE_REQUIRED', 'No current check or status evidence exists for the expected head');
    }
    if (policy.merge.require_current_checks_green) assertChecksGreen(checks);
  }
  pr = await assertExpectedHead(token, command.repository, number, expectedHead);
  await assertExpectedBase(token, pr, command.expected_base_sha);
  const { owner, repo } = splitRepository(command.repository);
  const payload = { sha: expectedHead, merge_method: method };
  if (typeof command.commit_title === 'string') payload.commit_title = command.commit_title;
  if (typeof command.commit_message === 'string') payload.commit_message = command.commit_message;
  const result = await githubRequest(token, 'PUT', `/repos/${owner}/${repo}/pulls/${number}/merge`, payload);
  invariant(result?.merged === true, 'MERGE_REJECTED', result?.message || 'GitHub rejected the merge', result);
  return { merged: true, sha: result.sha, message: result.message };
}

export async function handleReviewers(token, command, add) {
  const pr = requireNumber(command, 'pr');
  const reviewers = Array.isArray(command.reviewers) ? command.reviewers : [];
  const teamReviewers = Array.isArray(command.team_reviewers) ? command.team_reviewers : [];
  invariant(reviewers.length + teamReviewers.length > 0, 'REVIEWERS_REQUIRED', 'reviewer mutation requires reviewers or team_reviewers');
  const { owner, repo } = splitRepository(command.repository);
  return githubRequest(token, add ? 'POST' : 'DELETE', `/repos/${owner}/${repo}/pulls/${pr}/requested_reviewers`, { reviewers, team_reviewers: teamReviewers });
}

export async function handleReviewThread(token, command, resolve) {
  const thread = requireString(command, 'thread_id');
  const mutation = resolve ? 'resolveReviewThread' : 'unresolveReviewThread';
  const data = await graphql(token, `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id isResolved } } }`, { id: thread });
  return data?.[mutation]?.thread;
}

export async function handleReviewDismiss(token, command) {
  const pr = requireNumber(command, 'pr');
  const review = requireNumber(command, 'review');
  const message = requireString(command, 'message');
  const { owner, repo } = splitRepository(command.repository);
  return githubRequest(token, 'PUT', `/repos/${owner}/${repo}/pulls/${pr}/reviews/${review}/dismissals`, { message });
}

export async function handleReview(token, command) {
  const pr = requireNumber(command, 'pr');
  const event = requireString(command, 'event').toUpperCase();
  invariant(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event), 'REVIEW_EVENT_INVALID', 'Unsupported review event');
  const { owner, repo } = splitRepository(command.repository);
  const payload = { event };
  if (typeof command.body === 'string') payload.body = command.body;
  if (command.commit_id) payload.commit_id = command.commit_id;
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls/${pr}/reviews`, payload);
}
