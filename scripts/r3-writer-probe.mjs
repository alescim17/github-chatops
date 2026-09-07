import assert from 'node:assert/strict';
import { graphql, githubRequest } from '../src/core.mjs';

// Temporary READ-ONLY proof; fixed control-plane IDs, no body/diff output.
const root = '/repos/alescim17/github-chatops';
const out = (key, value) => console.log(`R3_EDITOR ${key}=${value}`);
const actorKind = actor => actor?.__typename === 'Bot' && actor.login === 'reporelay-control[bot]' && actor.id === 'BOT_kgDOEzquag' ? 'REPORELAY_APP'
  : actor?.login === 'github-actions[bot]' ? 'GENERIC_ACTIONS' : actor === null ? 'NULL' : 'OTHER';
const query = `query($id: ID!) { node(id: $id) { __typename ... on IssueComment {
  id fullDatabaseId body createdAt updatedAt lastEditedAt url
  issue { number repository { nameWithOwner } }
  author { __typename login ... on Bot { id } }
  editor { __typename login ... on Bot { id } }
  userContentEdits(last: 5) { nodes { editedAt editor { __typename login ... on Bot { id } } } }
} } }`;
try {
  for (const [name, token] of [['control', process.env.R3_CONTROL_TOKEN], ['app', process.env.R3_APP_TOKEN]]) {
    for (const [label, id] of [['probe', 5569031545], ['r2', 5567823124]]) {
      const rest = await githubRequest(token, 'GET', `${root}/issues/comments/${id}`);
      assert.equal(rest.id, id);
      const data = await graphql(token, query, { id: rest.node_id });
      const node = data.node;
      out(`${name}_${label}_typename_issue_comment`, node?.__typename === 'IssueComment');
      out(`${name}_${label}_node_id_equal`, node?.id === rest.node_id);
      out(`${name}_${label}_database_id_type`, typeof node?.fullDatabaseId);
      out(`${name}_${label}_database_id_equal`, String(node?.fullDatabaseId) === String(rest.id));
      out(`${name}_${label}_created_equal`, node?.createdAt === rest.created_at);
      out(`${name}_${label}_updated_equal`, node?.updatedAt === rest.updated_at);
      out(`${name}_${label}_body_equal`, node?.body === rest.body);
      out(`${name}_${label}_url_equal`, node?.url === rest.html_url);
      out(`${name}_${label}_issue_binding_equal`, node?.issue?.number === (label === 'probe' ? 32 : 3) && node.issue.repository.nameWithOwner === 'alescim17/github-chatops');
      out(`${name}_${label}_author`, actorKind(node?.author));
      out(`${name}_${label}_editor`, actorKind(node?.editor));
      out(`${name}_${label}_last_edited_type`, node?.lastEditedAt === null ? 'null' : typeof node?.lastEditedAt);
      out(`${name}_${label}_last_edited_equals_updated`, node?.lastEditedAt === node?.updatedAt);
      out(`${name}_${label}_history_editors`, node?.userContentEdits?.nodes?.map(edit => actorKind(edit.editor)).join('|'));
    }
  }
  out('probe_complete', true);
} catch { out('probe_complete', false); process.exitCode = 1; }
