import { RepoRelayError } from '../core.mjs';
import { handlePrCreate, handlePrUpdate, setDraftState, handlePrMerge, handleReviewers, handleReview, handleReviewDismiss, handleReviewThread } from './pr.mjs';
import { handleIssueCreate, handleIssueUpdate, handleLabels, handleAssignees, handleConversationLock, handleCommentCreate, handleCommentUpdate, handleMilestoneCreate, handleMilestoneUpdate, handleMilestoneDelete } from './issue.mjs';
import { handleWorkflowDispatch, handleWorkflowRunMutation, handleWorkflowJobRerun } from './workflow.mjs';
import { handleBranchCreate, handleBranchUpdate, handleBranchDelete, handleMergedBranchDelete, handleAtomicCommit } from './git.mjs';

export async function executeCommand(token, policy, command) {
  switch (command.action) {
    case 'pr.create': return handlePrCreate(token, command);
    case 'pr.update': return handlePrUpdate(token, command);
    case 'pr.ready': return setDraftState(token, command, true);
    case 'pr.draft': return setDraftState(token, command, false);
    case 'pr.merge': return handlePrMerge(token, policy, command);
    case 'pr.reviewers.request': return handleReviewers(token, command, true);
    case 'pr.reviewers.remove': return handleReviewers(token, command, false);
    case 'pr.review': return handleReview(token, command);
    case 'pr.review.dismiss': return handleReviewDismiss(token, command);
    case 'pr.thread.resolve': return handleReviewThread(token, command, true);
    case 'pr.thread.unresolve': return handleReviewThread(token, command, false);
    case 'issue.create': return handleIssueCreate(token, command);
    case 'issue.update': return handleIssueUpdate(token, command);
    case 'issue.labels.add': return handleLabels(token, command, true);
    case 'issue.labels.remove': return handleLabels(token, command, false);
    case 'issue.assignees.add': return handleAssignees(token, command, true);
    case 'issue.assignees.remove': return handleAssignees(token, command, false);
    case 'issue.lock': return handleConversationLock(token, command, true);
    case 'issue.unlock': return handleConversationLock(token, command, false);
    case 'comment.create': return handleCommentCreate(token, command);
    case 'comment.update': return handleCommentUpdate(token, command);
    case 'milestone.create': return handleMilestoneCreate(token, command);
    case 'milestone.update': return handleMilestoneUpdate(token, command);
    case 'milestone.delete': return handleMilestoneDelete(token, command);
    case 'workflow.dispatch': return handleWorkflowDispatch(token, command);
    case 'workflow.rerun': return handleWorkflowRunMutation(token, command, 'rerun');
    case 'workflow.rerun_failed': return handleWorkflowRunMutation(token, command, 'rerun-failed-jobs');
    case 'workflow.cancel': return handleWorkflowRunMutation(token, command, 'cancel');
    case 'workflow.job.rerun': return handleWorkflowJobRerun(token, command);
    case 'branch.create': return handleBranchCreate(token, policy, command);
    case 'branch.update': return handleBranchUpdate(token, policy, command);
    case 'branch.delete': return handleBranchDelete(token, policy, command);
    case 'branch.delete_merged': return handleMergedBranchDelete(token, command);
    case 'git.commit.atomic': return handleAtomicCommit(token, policy, command);
    default: throw new RepoRelayError('ACTION_UNSUPPORTED', `Unsupported RepoRelay action: ${command.action}`);
  }
}
