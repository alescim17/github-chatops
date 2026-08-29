import fs from 'node:fs/promises';
import {
  RepoRelayError,
  loadPolicy,
  parseCommand,
  authorize,
  commandFromEvent,
  findReceipt,
  createReceipt,
  updateReceipt,
  assertReceiptCompatible,
} from './core.mjs';
import { executeCommand } from './handlers/index.mjs';

const eventPath = process.env.REPORELAY_EVENT_PATH || process.env.GITHUB_EVENT_PATH;
const targetToken = process.env.REPORELAY_TARGET_TOKEN;
const controlToken = process.env.REPORELAY_CONTROL_TOKEN || process.env.GITHUB_TOKEN;
const dispatchCommand = process.env.REPORELAY_DISPATCH_COMMAND;

let source;
let command;
let receipt;

try {
  if (!eventPath) throw new RepoRelayError('EVENT_PATH_REQUIRED', 'Workflow event path is missing');
  const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  const policy = await loadPolicy();
  source = commandFromEvent(event, dispatchCommand);
  command = parseCommand(source.body, policy.limits.max_command_bytes);
  authorize({
    policy,
    actor: source.actor,
    controlRepository: source.controlRepository,
    controlIssue: source.controlIssue,
    command,
  });
  const existing = await findReceipt(
    controlToken,
    source.controlRepository,
    source.controlIssue,
    source.sourceCommentId,
    command.request_id,
  );
  if (existing) {
    assertReceiptCompatible(existing.body, command);
    console.log(`RepoRelay duplicate suppressed by compatible receipt ${existing.id}`);
    process.exit(0);
  }

  // Persist intent before the target mutation. If the runner disappears after
  // this point, the same source comment/request_id is never replayed blindly.
  receipt = await createReceipt(
    controlToken,
    source.controlRepository,
    source.controlIssue,
    source.sourceCommentId,
    command,
    'STARTED',
    { message: 'Command accepted; mutation outcome pending.' },
  );

  const result = await executeCommand(targetToken, policy, command);
  await updateReceipt(
    controlToken,
    source.controlRepository,
    receipt.id,
    source.sourceCommentId,
    command,
    'SUCCESS',
    result,
  );
  console.log(JSON.stringify({ status: 'SUCCESS', request_id: command.request_id, action: command.action, result }));
} catch (error) {
  const result = error instanceof RepoRelayError
    ? { code: error.code, message: error.message, details: error.details || null }
    : { code: 'UNEXPECTED_ERROR', message: error?.message || String(error) };
  console.error(JSON.stringify(result));
  try {
    if (source?.controlRepository && source?.controlIssue && controlToken) {
      if (receipt?.id) {
        await updateReceipt(controlToken, source.controlRepository, receipt.id, source.sourceCommentId || 'unknown', command, 'FAILED', result);
      } else {
        await createReceipt(controlToken, source.controlRepository, source.controlIssue, source.sourceCommentId || 'unknown', command, 'FAILED', result);
      }
    }
  } catch (receiptError) {
    console.error('Failed to persist RepoRelay failure receipt:', receiptError);
  }
  process.exitCode = 1;
}
