import { invariant, splitRepository, githubRequest } from '../core.mjs';
import { requireNumber, requireString } from './common.mjs';

export async function handleIssueCreate(token, command) {
  const { owner, repo } = splitRepository(command.repository);
  const payload = { title: requireString(command, 'title') };
  for (const key of ['body', 'milestone']) if (command[key] !== undefined) payload[key] = command[key];
  if (Array.isArray(command.labels)) payload.labels = command.labels;
  if (Array.isArray(command.assignees)) payload.assignees = command.assignees;
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues`, payload);
}

export async function handleIssueUpdate(token, command) {
  const issue = requireNumber(command, 'issue');
  const { owner, repo } = splitRepository(command.repository);
  const payload = {};
  for (const key of ['title', 'body', 'state', 'state_reason', 'milestone']) if (command[key] !== undefined) payload[key] = command[key];
  if (Array.isArray(command.labels)) payload.labels = command.labels;
  if (Array.isArray(command.assignees)) payload.assignees = command.assignees;
  invariant(Object.keys(payload).length > 0, 'ISSUE_UPDATE_EMPTY', 'issue.update requires at least one mutable field');
  return githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/issues/${issue}`, payload);
}

export async function handleMilestoneCreate(token, command) {
  const { owner, repo } = splitRepository(command.repository);
  const payload = { title: requireString(command, 'title') };
  for (const key of ['state', 'description', 'due_on']) if (command[key] !== undefined) payload[key] = command[key];
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/milestones`, payload);
}

export async function handleMilestoneUpdate(token, command) {
  const milestone = requireNumber(command, 'milestone');
  const { owner, repo } = splitRepository(command.repository);
  const payload = {};
  for (const key of ['title', 'state', 'description', 'due_on']) if (command[key] !== undefined) payload[key] = command[key];
  invariant(Object.keys(payload).length > 0, 'MILESTONE_UPDATE_EMPTY', 'milestone.update requires at least one mutable field');
  return githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/milestones/${milestone}`, payload);
}

export async function handleMilestoneDelete(token, command) {
  const milestone = requireNumber(command, 'milestone');
  const { owner, repo } = splitRepository(command.repository);
  await githubRequest(token, 'DELETE', `/repos/${owner}/${repo}/milestones/${milestone}`);
  return { deleted: true, milestone };
}

export async function handleCommentCreate(token, command) {
  const issue = requireNumber(command, 'issue');
  const body = requireString(command, 'body');
  const { owner, repo } = splitRepository(command.repository);
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues/${issue}/comments`, { body });
}

export async function handleCommentUpdate(token, command) {
  const comment = requireNumber(command, 'comment');
  const body = requireString(command, 'body');
  const { owner, repo } = splitRepository(command.repository);
  return githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/issues/comments/${comment}`, { body });
}

export async function handleLabels(token, command, add) {
  const issue = requireNumber(command, 'issue');
  const { owner, repo } = splitRepository(command.repository);
  if (add) {
    invariant(Array.isArray(command.labels) && command.labels.length > 0, 'LABELS_REQUIRED', 'labels.add requires labels');
    return githubRequest(token, 'POST', `/repos/${owner}/${repo}/issues/${issue}/labels`, { labels: command.labels });
  }
  const label = requireString(command, 'label');
  await githubRequest(token, 'DELETE', `/repos/${owner}/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
  return { removed: true, label };
}

export async function handleAssignees(token, command, add) {
  const issue = requireNumber(command, 'issue');
  invariant(Array.isArray(command.assignees) && command.assignees.length > 0, 'ASSIGNEES_REQUIRED', 'assignee mutation requires assignees');
  const { owner, repo } = splitRepository(command.repository);
  return githubRequest(token, add ? 'POST' : 'DELETE', `/repos/${owner}/${repo}/issues/${issue}/assignees`, { assignees: command.assignees });
}

export async function handleConversationLock(token, command, lock) {
  const issue = requireNumber(command, 'issue');
  const { owner, repo } = splitRepository(command.repository);
  if (lock) {
    const body = command.reason ? { lock_reason: command.reason } : undefined;
    await githubRequest(token, 'PUT', `/repos/${owner}/${repo}/issues/${issue}/lock`, body);
  } else {
    await githubRequest(token, 'DELETE', `/repos/${owner}/${repo}/issues/${issue}/lock`);
  }
  return { locked: lock, issue };
}
