import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleRead } from '../src/handlers/read.mjs';
import { readLimits, resultDigest } from '../src/read-contract.mjs';
import { assertPublicRead } from '../src/read-receipts.mjs';
import { fakeApi, target } from './fixtures/read-api.mjs';

const policy = JSON.parse(fs.readFileSync(new URL('../config/policy.json', import.meta.url), 'utf8'));
const limits = readLimits(policy);
const command = { v: 1, request_id: 'history-freeze', repository: target, action: 'read.freeze',
  branches: ['main', 'issue-183'], prs: [185], issues: [183], include_checks: true, include_workflows: true, include_reviews: true };
function install(t, options = {}) {
  const previous = globalThis.fetch;
  const api = fakeApi({ intercept(url, init, seen) {
    const isChecks = url.pathname.endsWith('/check-runs');
    const isStatus = url.pathname.endsWith('/status');
    const isRuns = url.pathname.endsWith('/actions/runs');
    if (!isChecks && !isRuns && !isStatus) return;
    const key = isChecks ? 'check_runs' : isStatus ? 'statuses' : 'workflow_runs';
    const count = options.overflow ? 1001 : isChecks ? 123 : isStatus ? 103 : 119;
    const page = Number(url.searchParams.get('page'));
    const size = Number(url.searchParams.get('per_page'));
    const sha = isRuns ? url.searchParams.get('head_sha') : url.pathname.split('/').at(-2);
    const all = Array.from({ length: count }, (_, index) => isChecks
      ? { id: 1000 - index, head_sha: sha, name: options.tooManyChecks ? `Check ${index}` : index === 121 ? 'second-page-only' : 'CI',
          app: { slug: 'github-actions' }, status: 'completed', conclusion: index === 121 ? 'failure' : 'success' }
      : isStatus ? { id: 1000 - index, context: index === 101 ? 'second-page-status' : 'status', state: index === 101 ? 'error' : 'success' }
        : { id: 2000 - index, workflow_id: options.tooManyWorkflows ? index + 1 : 101, name: 'Validation',
            status: 'completed', conclusion: 'success', event: index === 110 ? 'workflow_dispatch' : 'pull_request',
            run_number: 200 - index, run_attempt: 1, head_sha: sha });
    const items = all.slice((page - 1) * size, page * size);
    if (options.duplicate && page === 2 && items.length) items[0].id = all[0].id;
    if (options.partial && page === 2) items.pop();
    const more = page * size < count;
    return new Response(JSON.stringify({ total_count: options.race && page === 2 ? count + 1 : count,
      ...(isStatus ? { sha, state: 'failure' } : {}), [key]: items }), { headers: more && !options.missingLink ? { link: '<https://api.github.com/server-controlled>; rel="next"' } : {} });
  } });
  globalThis.fetch = api.fetch;
  t.after(() => { globalThis.fetch = previous; });
  return api;
}

test('freeze scans every history page before latest identity selection, including second-page-only failure authority', async (t) => {
  const api = install(t);
  const envelope = await handleRead('fake-token', policy, command);
  const result = envelope.result;
  assert.equal(result.stable, true);
  assert.equal(envelope.result_sha256, resultDigest(result));
  assert.ok(envelope.result_bytes < limits.max_read_result_bytes);
  for (const group of result.checks) {
    assert.equal(group.observed_check_run_count, 123);
    assert.equal(group.observed_status_count, 103);
    assert.equal(group.check_runs.length, 2);
    assert.equal(group.check_runs.find((run) => run.name === 'CI').id, 1000);
    assert.equal(group.check_runs.find((run) => run.name === 'second-page-only').conclusion, 'failure');
    assert.equal(group.statuses.find((status) => status.context === 'second-page-status').state, 'error');
    assert.equal(group.combined_status, 'failure');
  }
  for (const group of result.workflows) {
    assert.equal(group.observed_run_count, 119);
    assert.equal(group.selection, 'latest_per_workflow_event');
    assert.equal(group.runs.length, 2);
    assert.equal(group.runs.find((run) => run.event === 'pull_request').id, 2000);
    assert.ok(group.runs.find((run) => run.event === 'workflow_dispatch'));
  }
  assert.equal(api.calls.filter((call) => new URL(call.url).searchParams.get('page') === '2').length, 12);
  assert.doesNotThrow(() => assertPublicRead('read.freeze', result, limits, [target, 'fake-token']));
});
for (const [name, options, code] of [
  ['bounded source scan overflow', { overflow: true }, 'READ_RESULT_TOO_LARGE'],
  ['history total moves across pages', { race: true }, 'READ_FREEZE_MOVED'],
  ['duplicate identities across pages', { duplicate: true }, 'READ_FREEZE_MOVED'],
  ['missing pagination link', { missingLink: true }, 'READ_UPSTREAM_INCOMPLETE'],
  ['partial final page', { partial: true }, 'READ_RESULT_TOO_LARGE'],
  ['too many distinct current checks', { tooManyChecks: true }, 'READ_RESULT_TOO_LARGE'],
  ['too many distinct workflow-event identities', { tooManyWorkflows: true }, 'READ_RESULT_TOO_LARGE'],
]) {
  test(name + ' fails closed without relaxing result bounds', async (t) => {
    install(t, options);
    await assert.rejects(() => handleRead('fake-token', policy, command), { code });
  });
}
test('public history coverage metadata cannot falsely claim fewer source items than selected results', async (t) => {
  install(t);
  const { result } = await handleRead('fake-token', policy, command);
  result.workflows[0].observed_run_count = 0;
  assert.throws(() => assertPublicRead('read.freeze', result, limits), { code: 'PUBLIC_READ_RESULT_UNSAFE' });
});
