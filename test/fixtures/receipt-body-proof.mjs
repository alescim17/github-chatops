import assert from 'node:assert/strict';

// Live R2 proof: fullDatabaseId is a string; node/body/URL/timestamps bind REST.
// Actor IDs are deliberately opaque synthetic values. Their equality relation,
// not a guessed REST-to-GraphQL encoding or login projection, is the contract.
export const appActor = { __typename: 'Bot', id: 'opaque-graphql-app-author-fixture' };
export const actionsActor = { __typename: 'Bot', id: 'opaque-graphql-generic-actions-fixture' };
export function receiptBodyProof(comment) {
  const unedited = comment.updated_at === comment.created_at && comment.body.includes(' status=STARTED -->');
  const url = new URL(comment.issue_url), parts = url.pathname.split('/');
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(parts[1], 'repos'); assert.equal(parts[4], 'issues');
  return { node: { __typename: 'IssueComment', id: comment.node_id, fullDatabaseId: String(comment.id),
    body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at,
    lastEditedAt: unedited ? null : comment.updated_at, url: comment.html_url,
    issue: { number: Number(parts[5]), repository: { nameWithOwner: parts.slice(2, 4).join('/') } },
    author: { ...appActor }, editor: unedited ? null : { ...appActor },
  } };
}
export function assertBodyProofRequest(init, comment) {
  assert.equal(init.method, 'POST');
  const request = JSON.parse(init.body);
  assert.deepEqual(Object.keys(request).sort(), ['query', 'variables']);
  assert.deepEqual(request.variables, { id: comment.node_id });
  assert.ok(request.query.startsWith('query RepoRelayReceiptBody($id: ID!)'));
  assert.equal(request.query.includes('mutation'), false);
  for (const field of ['fullDatabaseId', 'body', 'createdAt', 'updatedAt', 'lastEditedAt', 'author', 'editor']) {
    assert.ok(request.query.includes(field));
  }
}
