import { splitRepository, githubRequest } from '../core.mjs';
import { requireNumber, requireString, optionalObject } from './common.mjs';

export async function handleWorkflowDispatch(token, command) {
  const workflow = requireString(command, 'workflow');
  const ref = requireString(command, 'ref');
  const { owner, repo } = splitRepository(command.repository);
  const inputs = optionalObject(command.inputs, 'inputs') || {};
  await githubRequest(token, 'POST', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs });
  return { dispatched: true, workflow, ref };
}

export async function handleWorkflowRunMutation(token, command, endpoint) {
  const run = requireNumber(command, 'run');
  const { owner, repo } = splitRepository(command.repository);
  await githubRequest(token, 'POST', `/repos/${owner}/${repo}/actions/runs/${run}/${endpoint}`);
  return { accepted: true, run, operation: endpoint };
}

export async function handleWorkflowJobRerun(token, command) {
  const job = requireNumber(command, 'job');
  const { owner, repo } = splitRepository(command.repository);
  await githubRequest(token, 'POST', `/repos/${owner}/${repo}/actions/jobs/${job}/rerun`);
  return { accepted: true, job, operation: 'rerun' };
}
