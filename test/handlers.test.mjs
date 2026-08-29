import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand } from '../src/handlers/index.mjs';

const policy = {
  merge_methods: ['merge'],
  allow_direct_default_branch_writes: false,
  limits: { max_atomic_commit_files: 32, max_atomic_commit_bytes: 48000 },
  merge: { require_mergeable: true, require_no_changes_requested: true, require_no_unresolved_review_threads: true, require_current_checks_green: true, require_any_check: true },
};

test('unsupported actions fail closed before network access', async () => {
  await assert.rejects(() => executeCommand('token', policy, { action: 'shell.exec', repository: 'alescim17/aether-factory' }), (error) => error.code === 'ACTION_UNSUPPORTED');
});

test('pr.ready uses a minimal GraphQL mutation and preserves expected head', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/repos/alescim17/aether-factory/pulls/108')) {
      return new Response(JSON.stringify({ head: { sha: 'a'.repeat(40) }, state: 'open', draft: true }), { status: 200 });
    }
    if (String(url).endsWith('/graphql')) {
      const body = JSON.parse(options.body);
      if (body.query.includes('query(')) {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_node', isDraft: true, reviewDecision: null, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }), { status: 200 });
      }
      assert.equal(body.query.includes('fullDatabaseId'), false);
      assert.equal(body.query.includes('markPullRequestReadyForReview'), true);
      return new Response(JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { number: 108, isDraft: false, headRefOid: 'a'.repeat(40) } } } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await executeCommand('token', policy, {
    action: 'pr.ready', repository: 'alescim17/aether-factory', pr: 108, expected_head_sha: 'a'.repeat(40),
  });
  assert.equal(result.draft, false);
  assert.equal(calls.some((call) => call.url.endsWith('/graphql')), true);
});

test('pr.merge rejects stale head before any merge mutation', async (t) => {
  const originalFetch = global.fetch;
  const methods = [];
  global.fetch = async (url, options = {}) => {
    methods.push(options.method || 'GET');
    return new Response(JSON.stringify({ head: { sha: 'b'.repeat(40) } }), { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', policy, {
    action: 'pr.merge', repository: 'alescim17/aether-factory', pr: 108, expected_head_sha: 'a'.repeat(40), method: 'merge',
  }), (error) => error.code === 'EXPECTED_HEAD_MISMATCH');
  assert.equal(methods.includes('PUT'), false);
});

test('git.commit.atomic forbids direct default-branch writes by policy', async (t) => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', policy, {
    action: 'git.commit.atomic', repository: 'alescim17/aether-factory', branch: 'main', expected_parent_sha: 'a'.repeat(40), message: 'x', files: [{ path: 'x.txt', content: 'x' }],
  }), (error) => error.code === 'DEFAULT_BRANCH_WRITE_FORBIDDEN');
  assert.equal(callCount, 1);
});

test('pr.ready restores Draft if head races during Ready transition', async (t) => {
  const originalFetch = global.fetch;
  const mutations = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/repos/alescim17/aether-factory/pulls/108')) {
      return new Response(JSON.stringify({ head: { sha: 'a'.repeat(40) }, state: 'open', draft: true }), { status: 200 });
    }
    if (String(url).endsWith('/graphql')) {
      const body = JSON.parse(options.body);
      if (body.query.includes('query(')) {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_node', isDraft: true, reviewDecision: null, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }), { status: 200 });
      }
      mutations.push(body.query);
      if (body.query.includes('markPullRequestReadyForReview')) {
        return new Response(JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { number: 108, isDraft: false, headRefOid: 'b'.repeat(40) } } } }), { status: 200 });
      }
      if (body.query.includes('convertPullRequestToDraft')) {
        return new Response(JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { number: 108, isDraft: true, headRefOid: 'b'.repeat(40) } } } }), { status: 200 });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', policy, {
    action: 'pr.ready', repository: 'alescim17/aether-factory', pr: 108, expected_head_sha: 'a'.repeat(40),
  }), (error) => error.code === 'EXPECTED_HEAD_MISMATCH' && error.details.restored_draft === true);
  assert.equal(mutations.some((query) => query.includes('convertPullRequestToDraft')), true);
});

test('branch.create cannot create the default branch when direct default writes are disabled', async (t) => {
  const originalFetch = global.fetch;
  let postSeen = false;
  global.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'POST') postSeen = true;
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', policy, {
    action: 'branch.create', repository: 'alescim17/aether-factory', branch: 'main', from_sha: 'a'.repeat(40),
  }), (error) => error.code === 'DEFAULT_BRANCH_WRITE_FORBIDDEN');
  assert.equal(postSeen, false);
});

test('git.commit.atomic rejects unsupported Git tree modes before blob creation', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', policy, {
    action: 'git.commit.atomic', repository: 'alescim17/aether-factory', branch: 'issue-x', expected_parent_sha: 'a'.repeat(40), message: 'x', files: [{ path: 'x.txt', content: 'x', mode: '160000' }],
  }), (error) => error.code === 'FILE_MODE_INVALID');
  assert.equal(calls, 1);
});

test('pr.merge requires at least one exact-head check or status evidence item', async (t) => {
  const originalFetch = global.fetch;
  let mergePutSeen = false;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || 'GET';
    if (method === 'PUT' && value.endsWith('/pulls/108/merge')) mergePutSeen = true;
    if (value.endsWith('/repos/alescim17/aether-factory/pulls/108')) {
      return new Response(JSON.stringify({
        head: { sha: 'a'.repeat(40) },
        base: { sha: 'c'.repeat(40) },
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
      }), { status: 200 });
    }
    if (value.endsWith('/graphql')) {
      return new Response(JSON.stringify({ data: { repository: { pullRequest: {
        id: 'PR_node', isDraft: false, reviewDecision: null,
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      } } } }), { status: 200 });
    }
    if (value.includes('/check-runs?')) {
      return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
    }
    if (value.includes('/status?')) {
      return new Response(JSON.stringify({ state: 'pending', statuses: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', policy, {
    action: 'pr.merge', repository: 'alescim17/aether-factory', pr: 108,
    expected_head_sha: 'a'.repeat(40), expected_base_sha: 'c'.repeat(40), method: 'merge',
  }), (error) => error.code === 'CHECK_EVIDENCE_REQUIRED');
  assert.equal(mergePutSeen, false);
});
