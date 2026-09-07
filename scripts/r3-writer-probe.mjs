import assert from 'node:assert/strict';
import { isRepoRelayReceipt } from '../src/receipt-authority.mjs';

// Temporary fixed-target security experiment; never touches real receipts/products.
const root = '/repos/alescim17/github-chatops';
const probeId = 5569031545;
const route = `${root}/issues/comments/${probeId}`;
const issueUrl = `https://api.github.com${root}/issues/32`;
const original = 'R3 isolated writer-continuity probe m8q2. This is NOT a RepoRelay receipt, NOT request authority, and contains no product data. phase=APP_CREATED. Reserved exclusively for bounded Issue #32 security diagnostic.';
const control = process.env.R3_CONTROL_TOKEN, app = process.env.R3_APP_TOKEN;
const out = (key, value) => console.log(`R3_WRITER ${key}=${value}`);
const appKind = comment => {
  const value = comment?.performed_via_github_app;
  return value == null ? 'OMITTED_OR_NULL' : value.id === 4764725 ? 'REPORELAY_APP' : value.id === 15368 ? 'GENERIC_ACTIONS_APP' : 'OTHER';
};
async function api(token, method, path, body) {
  assert.ok(token);
  assert.ok(path === route || (method === 'GET' && [
    `${root}/issues/32/comments?per_page=100`, `${root}/issues/comments/5567823124`
  ].includes(path)));
  const response = await fetch(`https://api.github.com${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ body }) } : {}),
  });
  return { status: response.status, value: response.ok ? await response.json() : null };
}
async function snapshot(label, expectedBody, initial) {
  const listed = await api(control, 'GET', `${root}/issues/32/comments?per_page=100`);
  assert.equal(listed.status, 200); assert.ok(listed.value.length < 100);
  const collection = listed.value.find(comment => comment.id === probeId);
  const exactControl = await api(control, 'GET', route), exactApp = await api(app, 'GET', route);
  assert.equal(exactControl.status, 200); assert.equal(exactApp.status, 200);
  for (const [view, comment] of [['collection_control', collection], ['exact_control', exactControl.value], ['exact_app', exactApp.value]]) {
    assert.equal(comment.id, probeId); assert.equal(comment.issue_url, issueUrl);
    out(`${label}_${view}_app`, appKind(comment));
    out(`${label}_${view}_authority`, isRepoRelayReceipt(comment));
    out(`${label}_${view}_body_expected`, comment.body === expectedBody);
    out(`${label}_${view}_user_is_reporelay`, comment.user?.login === 'reporelay-control[bot]' && comment.user.id === 322612842 && comment.user.type === 'Bot');
    if (initial) {
      out(`${label}_${view}_immutable_identity_equal`, ['id', 'node_id', 'url', 'issue_url', 'created_at'].every(key => comment[key] === initial[key]));
      out(`${label}_${view}_body_changed`, comment.body !== initial.body);
    }
  }
  return collection;
}
try {
  const before = await snapshot('before', original);
  assert.ok(isRepoRelayReceipt(before)); assert.equal(before.body, original);
  const controlBody = original.replace('phase=APP_CREATED', 'phase=CONTROL_EDIT');
  const attempted = await api(control, 'PATCH', route, controlBody);
  out('generic_actions_patch_http_status', attempted.status);
  assert.ok([200, 403].includes(attempted.status));
  const expected = attempted.status === 200 ? controlBody : original;
  const after = await snapshot('after_control', expected, before);
  assert.equal(after.body, expected);
  const appBody = original.replace('phase=APP_CREATED', 'phase=APP_UPDATED_PROBE_COMPLETE');
  const restored = await api(app, 'PATCH', route, appBody);
  out('reporelay_app_patch_http_status', restored.status); assert.equal(restored.status, 200);
  await snapshot('after_app', appBody, before);
  const r2 = await api(app, 'GET', `${root}/issues/comments/5567823124`);
  out('original_r2_exact_app_http_status', r2.status);
  out('original_r2_exact_app_authority', isRepoRelayReceipt(r2.value));
  out('probe_complete', true);
} catch { out('probe_complete', false); process.exitCode = 1; }
