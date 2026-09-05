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
import {
  loadTargetMap,
  resolveTargetRepository,
  privateCommandBody,
  normalizeDispatchSource,
  assertPublicActionAllowed,
  assertPrivateEnvelope,
} from './relay.mjs';
import { executeCommand } from './handlers/index.mjs';
import { readLimits, PUBLIC_READ_ACTIONS, PRIVATE_READ_ACTIONS } from './read-contract.mjs';
import { publicSuccessResult, mutationReceiptResult as publicReceiptResult, privateReceiptBody, publicReadFailure } from './read-receipts.mjs';

const eventPath = process.env.REPORELAY_EVENT_PATH || process.env.GITHUB_EVENT_PATH;
const targetToken = process.env.REPORELAY_TARGET_TOKEN;
const controlToken = process.env.REPORELAY_CONTROL_TOKEN || process.env.GITHUB_TOKEN;
const dispatchCommand = process.env.REPORELAY_DISPATCH_COMMAND;
const targetMapRaw = process.env.REPORELAY_TARGETS_JSON;

async function fetchPrivateCommand({ token, repository, sourceCommentId, actor, maxBytes }) {
  const id = Number(sourceCommentId);
  invariant(Number.isInteger(id) && id > 0, 'PRIVATE_SOURCE_COMMENT_INVALID', 'source_comment_id must be a positive integer');
  const { owner, repo } = splitRepository(repository);
  const comment = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/issues/comments/${id}`);
  invariant(comment?.user?.login === actor, 'PRIVATE_SOURCE_ACTOR_MISMATCH', 'Private source comment author is not the authorized command actor');
  invariant(comment?.id === id, 'PRIVATE_SOURCE_COMMENT_INVALID', 'Private source comment identity differs');
  privateIssuePath(comment, repository);
  const command = parseCommand(privateCommandBody(comment?.body), maxBytes);
  return { command, comment };
}

function privateIssuePath(comment, repository) {
  try {
    const url = new URL(comment.issue_url);
    invariant(url.origin === 'https://api.github.com' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(`/repos/${repository}/issues/`)
      && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname),
    'PRIVATE_RECEIPT_TARGET_INVALID', 'Private source issue URL is invalid');
    return `${url.pathname}/comments`;
  } catch (error) {
    if (error instanceof RepoRelayError) throw error;
    throw new RepoRelayError('PRIVATE_RECEIPT_TARGET_INVALID', 'Private source issue URL is invalid');
  }
}

async function writePrivateReceipt(token, sourceComment, command, status, result) {
  if (!sourceComment) return false;
  const body = privateReceiptBody(command, status, result, activeReadLimits);
  await githubRequest(token, 'POST', privateIssuePath(sourceComment, privateTargetRepository), { body });
  return true;
}

let source;
let command;
let receipt;
let privateSourceComment;
let privateTargetRepository;
let activeReadLimits;

try {
  if (!eventPath) throw new RepoRelayError('EVENT_PATH_REQUIRED', 'Workflow event path is missing');
  const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  const policy = await loadPolicy();
  const targetMap = loadTargetMap(targetMapRaw);

  source = normalizeDispatchSource(
    commandFromEvent(event, dispatchCommand),
    event,
    dispatchCommand,
    policy,
  );

  const outerCommand = parseCommand(source.body, policy.limits.max_command_bytes);
  authorize({
    policy,
    actor: source.actor,
    controlRepository: source.controlRepository,
    controlIssue: source.controlIssue,
    command: outerCommand,
  });

  command = outerCommand;
  if (outerCommand.action === 'relay.private') {
    const targetRepository = resolveTargetRepository(outerCommand.repository, targetMap);
    privateTargetRepository = targetRepository;
    const privateSource = await fetchPrivateCommand({
      token: targetToken,
      repository: targetRepository,
      sourceCommentId: outerCommand.source_comment_id,
      actor: source.actor,
      maxBytes: policy.limits.max_command_bytes,
    });
    privateSourceComment = privateSource.comment;
    const privateCommand = privateSource.command;
    assertPrivateEnvelope(outerCommand, privateCommand);
    authorize({
      policy,
      actor: source.actor,
      controlRepository: source.controlRepository,
      controlIssue: source.controlIssue,
      command: privateCommand,
    });
    command = privateCommand;
  } else {
    assertPublicActionAllowed(outerCommand.action);
    command = outerCommand;
  }

  if ([...PUBLIC_READ_ACTIONS, ...PRIVATE_READ_ACTIONS].includes(command.action)) activeReadLimits = readLimits(policy);

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
  const result = await executeCommand(targetToken, policy, executionCommand, { privateRelay: Boolean(privateSourceComment) });

  let privateReceipt = false;
  if (privateSourceComment) {
    try {
      privateReceipt = await writePrivateReceipt(targetToken, privateSourceComment, command, 'SUCCESS', result);
    } catch {
      privateReceipt = false;
      if (command.action === 'read.query') throw new RepoRelayError('PRIVATE_RECEIPT_WRITE_FAILED', 'Private read result was not delivered');
    }
  }

  await updateReceipt(
    controlToken,
    source.controlRepository,
    receipt.id,
    source.sourceCommentId,
    command,
    'SUCCESS',
    publicSuccessResult(command, result, privateReceipt, activeReadLimits, [targetRepository, targetToken, controlToken, ...Object.values(targetMap)]),
  );
  console.log(JSON.stringify({ status: 'SUCCESS', request_id: command.request_id, action: command.action, target: command.repository }));
} catch (error) {
  const internalResult = error instanceof RepoRelayError
    ? { code: error.code, message: error.message, details: error.details || null }
    : { code: 'UNEXPECTED_ERROR', message: error?.message || String(error) };
  const safeCode = internalResult.code || 'UNEXPECTED_ERROR';
  console.error(JSON.stringify({ status: 'FAILED', code: safeCode, request_id: command?.request_id || null, action: command?.action || null, target: command?.repository || null }));

  let failurePrivateReceipt = false;
  if (privateSourceComment && command && targetToken) {
    try {
      failurePrivateReceipt = await writePrivateReceipt(targetToken, privateSourceComment, command, 'FAILED', internalResult);
    } catch {
      // The public receipt below is still authoritative for replay suppression.
    }
  }

  try {
    if (source?.controlRepository && source?.controlIssue && controlToken) {
      const publicResult = publicReceiptResult('FAILED', failurePrivateReceipt, safeCode);
      if ([...PUBLIC_READ_ACTIONS, ...PRIVATE_READ_ACTIONS].includes(command?.action)) {
        const guidance = publicReadFailure(error);
        if (guidance) publicResult.read_retry = guidance;
      }
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
