import fs from 'node:fs/promises';
import {
  RepoRelayError,
  invariant,
  loadPolicy,
  parseCommand,
  authorize,
  commandFromEvent,
  findReceipt,
  createReceipt,
  updateReceipt,
  assertReceiptCompatible,
  githubRequest,
  splitRepository,
} from './core.mjs';
import { executeCommand } from './handlers/index.mjs';

const eventPath = process.env.REPORELAY_EVENT_PATH || process.env.GITHUB_EVENT_PATH;
const targetToken = process.env.REPORELAY_TARGET_TOKEN;
const controlToken = process.env.REPORELAY_CONTROL_TOKEN || process.env.GITHUB_TOKEN;
const dispatchCommand = process.env.REPORELAY_DISPATCH_COMMAND;
const targetMapRaw = process.env.REPORELAY_TARGETS_JSON;

const PUBLIC_ACTIONS = new Set([
  'pr.ready',
  'pr.draft',
  'pr.merge',
  'workflow.rerun',
  'workflow.rerun_failed',
  'workflow.cancel',
  'workflow.job.rerun',
]);

function loadTargetMap(raw) {
  invariant(typeof raw === 'string' && raw.trim().length > 0, 'TARGET_MAP_REQUIRED', 'RepoRelay target map secret is missing');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RepoRelayError('TARGET_MAP_INVALID', 'RepoRelay target map secret is invalid JSON');
  }
  invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'TARGET_MAP_INVALID', 'RepoRelay target map must be an object');
  for (const [alias, repository] of Object.entries(parsed)) {
    invariant(/^target\/[A-Za-z0-9._-]+$/.test(alias), 'TARGET_ALIAS_INVALID', 'Target aliases must use target/<name>');
    invariant(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'TARGET_REPOSITORY_INVALID', `Target ${alias} does not map to owner/name`);
  }
  return parsed;
}

function resolveTargetRepository(alias, targetMap) {
  const repository = targetMap[alias];
  invariant(typeof repository === 'string', 'TARGET_ALIAS_UNMAPPED', `Target alias ${alias} is not mapped`);
  return repository;
}

function privateCommandBody(body) {
  invariant(typeof body === 'string', 'PRIVATE_COMMAND_BODY_REQUIRED', 'Private source comment has no body');
  const trimmed = body.trim();
  invariant(trimmed.startsWith('/reporelay-private'), 'PRIVATE_COMMAND_PREFIX_INVALID', 'Private source comment must start with /reporelay-private');
  return `/reporelay${trimmed.slice('/reporelay-private'.length)}`;
}

async function fetchPrivateCommand({ token, repository, sourceCommentId, actor, maxBytes }) {
  const id = Number(sourceCommentId);
  invariant(Number.isInteger(id) && id > 0, 'PRIVATE_SOURCE_COMMENT_INVALID', 'source_comment_id must be a positive integer');
  const { owner, repo } = splitRepository(repository);
  const comment = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/issues/comments/${id}`);
  invariant(comment?.user?.login === actor, 'PRIVATE_SOURCE_ACTOR_MISMATCH', 'Private source comment author is not the authorized command actor');
  const command = parseCommand(privateCommandBody(comment?.body), maxBytes);
  return { command, comment };
}

function privateIssuePath(comment) {
  try {
    const url = new URL(comment.issue_url);
    invariant(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname), 'PRIVATE_RECEIPT_TARGET_INVALID', 'Private source issue URL is invalid');
    return `${url.pathname}/comments`;
  } catch (error) {
    if (error instanceof RepoRelayError) throw error;
    throw new RepoRelayError('PRIVATE_RECEIPT_TARGET_INVALID', 'Private source issue URL is invalid');
  }
}

async function writePrivateReceipt(token, sourceComment, command, status, result) {
  if (!sourceComment) return false;
  const body = [
    `<!-- reporelay-private-receipt request_id=${command.request_id} status=${status} -->`,
    `**RepoRelay ${status}** — \`${command.action}\``,
    '',
    '```json',
    JSON.stringify(result ?? null, null, 2).slice(0, 12000),
    '```',
  ].join('\n');
  await githubRequest(token, 'POST', privateIssuePath(sourceComment), { body });
  return true;
}

function publicReceiptResult(status, privateReceipt, errorCode = undefined) {
  return {
    completed: status === 'SUCCESS',
    private_receipt: privateReceipt === true,
    ...(errorCode ? { code: errorCode } : {}),
  };
}

let source;
let command;
let receipt;
let privateSourceComment;

try {
  if (!eventPath) throw new RepoRelayError('EVENT_PATH_REQUIRED', 'Workflow event path is missing');
  const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  const policy = await loadPolicy();
  const targetMap = loadTargetMap(targetMapRaw);

  source = commandFromEvent(event, dispatchCommand);
  if ((event.inputs || dispatchCommand) && Array.isArray(policy.control_issues) && policy.control_issues.length > 0) {
    source.controlIssue = policy.control_issues[0];
  }

  const outerCommand = parseCommand(source.body, policy.limits.max_command_bytes);
  authorize({
    policy,
    actor: source.actor,
    controlRepository: source.controlRepository,
    controlIssue: source.controlIssue,
    command: outerCommand,
  });

  if (outerCommand.action === 'relay.private') {
    const targetRepository = resolveTargetRepository(outerCommand.repository, targetMap);
    const privateSource = await fetchPrivateCommand({
      token: targetToken,
      repository: targetRepository,
      sourceCommentId: outerCommand.source_comment_id,
      actor: source.actor,
      maxBytes: policy.limits.max_command_bytes,
    });
    privateSourceComment = privateSource.comment;
    command = privateSource.command;
    invariant(command.request_id === outerCommand.request_id, 'PRIVATE_REQUEST_ID_MISMATCH', 'Private command request_id must match the public relay envelope');
    invariant(command.repository === outerCommand.repository, 'PRIVATE_TARGET_MISMATCH', 'Private command target alias must match the public relay envelope');
    authorize({
      policy,
      actor: source.actor,
      controlRepository: source.controlRepository,
      controlIssue: source.controlIssue,
      command,
    });
  } else {
    invariant(PUBLIC_ACTIONS.has(outerCommand.action), 'PRIVATE_RELAY_REQUIRED', `Action ${outerCommand.action} requires relay.private on the public control plane`);
    command = outerCommand;
  }

  const existing = await findReceipt(
    controlToken,
    source.controlRepository,
    source.controlIssue,
    source.sourceCommentId,
    command.request_id,
  );
  if (existing) {
    assertReceiptCompatible(existing.body, command);
    console.log(JSON.stringify({ status: 'DUPLICATE_SUPPRESSED', request_id: command.request_id, action: command.action, target: command.repository }));
    process.exit(0);
  }

  receipt = await createReceipt(
    controlToken,
    source.controlRepository,
    source.controlIssue,
    source.sourceCommentId,
    command,
    'STARTED',
    { accepted: true, private_relay: Boolean(privateSourceComment) },
  );

  const targetRepository = resolveTargetRepository(command.repository, targetMap);
  const executionCommand = { ...command, repository: targetRepository };
  const result = await executeCommand(targetToken, policy, executionCommand);

  let privateReceipt = false;
  if (privateSourceComment) {
    try {
      privateReceipt = await writePrivateReceipt(targetToken, privateSourceComment, command, 'SUCCESS', result);
    } catch {
      privateReceipt = false;
    }
  }

  await updateReceipt(
    controlToken,
    source.controlRepository,
    receipt.id,
    source.sourceCommentId,
    command,
    'SUCCESS',
    publicReceiptResult('SUCCESS', privateReceipt),
  );
  console.log(JSON.stringify({ status: 'SUCCESS', request_id: command.request_id, action: command.action, target: command.repository }));
} catch (error) {
  const internalResult = error instanceof RepoRelayError
    ? { code: error.code, message: error.message, details: error.details || null }
    : { code: 'UNEXPECTED_ERROR', message: error?.message || String(error) };
  const safeCode = internalResult.code || 'UNEXPECTED_ERROR';
  console.error(JSON.stringify({ status: 'FAILED', code: safeCode, request_id: command?.request_id || null, action: command?.action || null, target: command?.repository || null }));

  if (privateSourceComment && command && targetToken) {
    try {
      await writePrivateReceipt(targetToken, privateSourceComment, command, 'FAILED', internalResult);
    } catch {
      // The public receipt below is still authoritative for replay suppression.
    }
  }

  try {
    if (source?.controlRepository && source?.controlIssue && controlToken) {
      const publicResult = publicReceiptResult('FAILED', Boolean(privateSourceComment), safeCode);
      if (receipt?.id) {
        await updateReceipt(controlToken, source.controlRepository, receipt.id, source.sourceCommentId || 'unknown', command, 'FAILED', publicResult);
      } else {
        await createReceipt(controlToken, source.controlRepository, source.controlIssue, source.sourceCommentId || 'unknown', command, 'FAILED', publicResult);
      }
    }
  } catch {
    console.error(JSON.stringify({ status: 'RECEIPT_WRITE_FAILED', code: safeCode }));
  }
  process.exitCode = 1;
}
