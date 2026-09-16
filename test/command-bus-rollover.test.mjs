import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPolicy, authorize } from '../src/core.mjs';
import { lookupRequest } from '../src/request-recovery.mjs';
import { control, alias, requestId, receiptId, r2Views } from './fixtures/r2-receipt.mjs';
import { receiptBodyProof, assertBodyProofRequest } from './fixtures/receipt-body-proof.mjs';

const policy = await loadPolicy();
const command = { lookup_request_id: requestId };
const baseContext = {
  controlRepository: control,
  controlIssue: 39,
  controlToken: 'rollover-control-token',
  targetAlias: alias,
};

function onIssue(comment, issue) {
  const copy = structuredClone(comment);
  copy.issue_url = `https://api.github.com/repos/${control}/issues/${issue}`;
  copy.html_url = `https://github.com/${control}/issues/${issue}#issuecomment-${copy.id}`;
  return copy;
}

function install(t, { issue39 = [], issue3 = [], exact }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    calls.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/graphql') {
      assertBodyProofRequest(init, exact);
      return new Response(JSON.stringify({ data: receiptBodyProof(exact) }));
    }
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer rollover-control-token');
    for (const [issue, items] of [[39, issue39], [3, issue3]]) {
      if (url.pathname === `/repos/${control}/issues/${issue}/comments`) {
        assert.equal(url.searchParams.get('per_page'), '100');
        const page = Number(url.searchParams.get('page'));
        return new Response(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
      }
    }
    if (exact && url.pathname === `/repos/${control}/issues/comments/${exact.id}`) {
      return new Response(JSON.stringify(exact));
    }
    throw new Error(`unexpected request ${init.method || 'GET'} ${url.pathname}`);
  });
  return calls;
}

test('policy makes Issue #39 active while preserving historical Issue #3', () => {
  assert.deepEqual(policy.control_issues, [39, 3]);
  for (const issue of [39, 3]) {
    assert.doesNotThrow(() => authorize({
      policy,
      actor: 'alescim17',
      controlRepository: control,
      controlIssue: issue,
      command: { repository: alias },
    }));
  }
  assert.throws(() => authorize({
    policy,
    actor: 'alescim17',
    controlRepository: control,
    controlIssue: 40,
    command: { repository: alias },
  }), { code: 'CONTROL_ISSUE_FORBIDDEN' });
});

test('workflow trigger allowlists only historical #3 and successor #39', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/reporelay.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\(github\.event\.issue\.number == 39 \|\| github\.event\.issue\.number == 3\)/);
  assert.equal(workflow.includes('github.event.issue.number == 40'), false);
});

test('read.request invoked from successor #39 recovers a successor receipt', async t => {
  const views = r2Views();
  const collection = onIssue(views.collection, 39);
  const exact = onIssue(views.exact, 39);
  const calls = install(t, { issue39: [collection], issue3: [], exact });
  const result = await lookupRequest(policy, command, baseContext);
  assert.equal(result.found, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.receipt_comment_id, receiptId);
  assert.ok(calls.includes(`GET /repos/${control}/issues/39/comments`));
  assert.ok(calls.includes(`GET /repos/${control}/issues/3/comments`));
});

test('read.request invoked from successor #39 still recovers historical #3 receipts', async t => {
  const views = r2Views();
  const calls = install(t, { issue39: [], issue3: [views.collection], exact: views.exact });
  const result = await lookupRequest(policy, command, baseContext);
  assert.equal(result.found, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.receipt_comment_id, receiptId);
  assert.ok(calls.includes(`GET /repos/${control}/issues/39/comments`));
  assert.ok(calls.includes(`GET /repos/${control}/issues/3/comments`));
});

test('read.request invoked from historical #3 stays scoped to historical #3', async t => {
  const views = r2Views();
  const calls = install(t, { issue39: [], issue3: [views.collection], exact: views.exact });
  const result = await lookupRequest(policy, command, { ...baseContext, controlIssue: 3 });
  assert.equal(result.found, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.receipt_comment_id, receiptId);
  assert.ok(calls.includes(`GET /repos/${control}/issues/3/comments`));
  assert.equal(calls.includes(`GET /repos/${control}/issues/39/comments`), false);
});

test('the same authoritative request identity on two buses fails closed', async t => {
  const views = r2Views();
  const successor = onIssue(views.collection, 39);
  install(t, { issue39: [successor], issue3: [views.collection], exact: null });
  await assert.rejects(
    lookupRequest(policy, command, baseContext),
    { code: 'REQUEST_ID_AMBIGUOUS' },
  );
});

test('read.request refuses a context from an unallowlisted control issue', async () => {
  await assert.rejects(
    lookupRequest(policy, command, { ...baseContext, controlIssue: 40 }),
    { code: 'READ_REQUEST_CONTEXT_INVALID' },
  );
});
