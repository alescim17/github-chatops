import fs from 'node:fs';
import { fakeApi, target } from './read-api.mjs';
import { commandHash, receiptMarker } from '../../src/core.mjs';

// Activated only in an isolated child process by read-runner.test.mjs.
if (process.env.REPORELAY_TEST_HARNESS) {
  const config = JSON.parse(fs.readFileSync(process.env.REPORELAY_TEST_HARNESS, 'utf8'));
  const api = fakeApi(config.api ?? {});
  const calls = [];
  const control = '/repos/alescim17/github-chatops';
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const privateCommand = { v: 1, request_id: 'runner-test', repository: 'target/streamforge',
    action: 'read.query', kind: 'issue', issue: 183, ...(config.privateCommand ?? {}) };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    if (url.pathname.startsWith(control)) {
      if (method === 'GET') {
        return json(config.duplicate ? [{ id: 1, body: receiptMarker({ sourceCommentId: '99', requestId: config.outer.request_id,
          action: config.outer.action, repository: config.outer.repository, status: 'SUCCESS', hash: commandHash(config.outer) }) }] : []);
      }
      return json({ id: 900, body: body.body });
    }
    if (url.pathname === `/repos/${target}/issues/comments/101` && method === 'GET') {
      return json({ id: 101, user: { login: config.privateActor ?? 'alescim17' },
        issue_url: config.issueUrl ?? `https://api.github.com/repos/${target}/issues/183`,
        body: '/reporelay-private ' + JSON.stringify(privateCommand) });
    }
    if (url.pathname === `/repos/${target}/issues/183/comments` && method === 'POST') {
      if (config.privateDeliveryFails) return json({ message: 'PRIVATE_DELIVERY_FAILURE' }, 403);
      return json({ id: 901, body: body.body });
    }
    if (config.privateCommand?.action === 'issue.update' && url.pathname === `/repos/${target}/issues/183` && method === 'PATCH') {
      return json({ number: 183, body: 'PRIVATE_MUTATION_RESULT', credentials: 'secret-credentials', repository: target });
    }
    return api.fetch(input, init);
  };
  process.on('exit', () => fs.writeFileSync(config.output, JSON.stringify({ calls, targetCalls: api.calls })));
}
