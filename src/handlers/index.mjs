import { RepoRelayError } from '../core.mjs';
import { handlePrCreate, handlePrUpdate, setDraftState, handlePrMerge, handleReviewers, handleReview, handleReviewDismiss, handleReviewThread } from './pr.mjs';
import { handleIssueCreate, handleIssueUpdate, handleLabels, handleAssignees, handleConversationLock, handleCommentCreate, handleCommentUpdate, handleMilestoneCreate, handleMilestoneUpdate, handleMilestoneDelete } from './issue.mjs';
import { handleWorkflowDispatch, handleWorkflowRunMutation, handleWorkflowJobRerun } from './workflow.mjs';
import { handleBranchCreate, handleBranchUpdate, handleBranchDelete, handleMergedBranchDelete, handleAtomicCommit } from './git.mjs';
import { handleAtomicPatch } from './patch.mjs';
import { handleBranchMergeFenced } from './branch-merge.mjs';
import { handleRead } from './read.mjs';

const entry = (kind, channel, handler) => Object.freeze({ kind, channel, handler });
const simple = handler => (token, _policy, command) => handler(token, command);
const option = (handler, value) => (token, _policy, command) => handler(token, command, value);

// One executable registration owns both dispatch and public capability metadata.
// Channel flags preserve the pre-R1 public/private boundary exactly.
export const ACTION_REGISTRY = Object.freeze({
  'read.capabilities': entry('read', 'public', handleRead),
  'read.freeze': entry('read', 'public', handleRead),
  'read.request': entry('read', 'public', handleRead),
  'read.query': entry('read', 'private', handleRead),
  'pr.create': entry('mutation', 'private', simple(handlePrCreate)),
  'pr.update': entry('mutation', 'private', simple(handlePrUpdate)),
  'pr.ready': entry('mutation', 'public', option(setDraftState, true)),
  'pr.draft': entry('mutation', 'public', option(setDraftState, false)),
  'pr.merge': entry('mutation', 'public', handlePrMerge),
  'pr.reviewers.request': entry('mutation', 'private', option(handleReviewers, true)),
  'pr.reviewers.remove': entry('mutation', 'private', option(handleReviewers, false)),
  'pr.review': entry('mutation', 'private', simple(handleReview)),
  'pr.review.dismiss': entry('mutation', 'private', simple(handleReviewDismiss)),
  'pr.thread.resolve': entry('mutation', 'private', option(handleReviewThread, true)),
  'pr.thread.unresolve': entry('mutation', 'private', option(handleReviewThread, false)),
  'issue.create': entry('mutation', 'private', simple(handleIssueCreate)),
  'issue.update': entry('mutation', 'private', simple(handleIssueUpdate)),
  'issue.labels.add': entry('mutation', 'private', option(handleLabels, true)),
  'issue.labels.remove': entry('mutation', 'private', option(handleLabels, false)),
  'issue.assignees.add': entry('mutation', 'private', option(handleAssignees, true)),
  'issue.assignees.remove': entry('mutation', 'private', option(handleAssignees, false)),
  'issue.lock': entry('mutation', 'private', option(handleConversationLock, true)),
  'issue.unlock': entry('mutation', 'private', option(handleConversationLock, false)),
  'comment.create': entry('mutation', 'private', simple(handleCommentCreate)),
  'comment.update': entry('mutation', 'private', simple(handleCommentUpdate)),
  'milestone.create': entry('mutation', 'private', simple(handleMilestoneCreate)),
  'milestone.update': entry('mutation', 'private', simple(handleMilestoneUpdate)),
  'milestone.delete': entry('mutation', 'private', simple(handleMilestoneDelete)),
  'workflow.dispatch': entry('mutation', 'private', simple(handleWorkflowDispatch)),
  'workflow.rerun': entry('mutation', 'public', option(handleWorkflowRunMutation, 'rerun')),
  'workflow.rerun_failed': entry('mutation', 'public', option(handleWorkflowRunMutation, 'rerun-failed-jobs')),
  'workflow.cancel': entry('mutation', 'public', option(handleWorkflowRunMutation, 'cancel')),
  'workflow.job.rerun': entry('mutation', 'public', simple(handleWorkflowJobRerun)),
  'branch.merge.fenced': entry('mutation', 'private', handleBranchMergeFenced),
  'branch.create': entry('mutation', 'private', handleBranchCreate),
  'branch.update': entry('mutation', 'private', handleBranchUpdate),
  'branch.delete': entry('mutation', 'private', handleBranchDelete),
  'branch.delete_merged': entry('mutation', 'public', simple(handleMergedBranchDelete)),
  'git.commit.atomic': entry('mutation', 'private', handleAtomicCommit),
  'git.patch.atomic': entry('mutation', 'private', handleAtomicPatch),
});

export function installedCapabilities() {
  const result = {};
  for (const kind of ['read', 'mutation']) for (const channel of ['public', 'private']) {
    result[`${channel}_${kind}_actions`] = Object.entries(ACTION_REGISTRY)
      .filter(([, item]) => item.kind === kind && item.channel === channel).map(([name]) => name);
  }
  return result;
}

export async function executeCommand(token, policy, command, context = {}) {
  if (!Object.hasOwn(ACTION_REGISTRY, command.action)) {
    throw new RepoRelayError('ACTION_UNSUPPORTED', `Unsupported RepoRelay action: ${command.action}`);
  }
  return ACTION_REGISTRY[command.action].handler(token, policy, command, context);
}
