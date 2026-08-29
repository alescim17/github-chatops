import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand } from '../src/handlers/index.mjs';
import { assertPublicActionAllowed } from '../src/relay.mjs';

const repository = 'owner/private-target';
const expectedHead = 'a'.repeat(40);
const pullNumber = 42;

function mergedPull(overrides = {}) {
  return {
    number: pullNumber,
    merged: true,
    merged_at: '2026-08-29T20:00:00Z',
    head: {
      sha: expectedHead,
      ref: 'issue-42',
      repo: { full_name: repository },
    },
    ...overrides,
  };
}

test('branch.delete_merged is allowed as a metadata-only public action', () => {
  assert.doesNotThrow(() => assertPublicActionAllowed('branch.delete_merged'));
});

test('branch.delete_merged deletes an unchanged same-repository branch from a merged PR', async (t) => {
  const originalFetch = global.fetch;
  let deleteSeen = false;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || 'GET';
    if (value.endsWith(`/repos/owner/private-target/pulls/${pullNumber}`)) {
      return new Response(JSON.stringify(mergedPull()), { status: 200 });
    }
    if (value.endsWith('/repos/owner/private-target')) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    if (value.endsWith('/git/ref/heads/issue-42')) {
      return new Response(JSON.stringify({ object: { sha: expectedHead } }), { status: 200 });
    }
    if (value.includes('/pulls?state=open&head=owner%3Aissue-42&per_page=100')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === 'DELETE' && value.endsWith('/git/refs/heads/issue-42')) {
      deleteSeen = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await executeCommand('token', {}, {
    action: 'branch.delete_merged',
    repository,
    pr: pullNumber,
    expected_head_sha: expectedHead,
  });

  assert.equal(deleteSeen, true);
  assert.deepEqual(result, {
    deleted: true,
    merged_pr: pullNumber,
    branch: 'issue-42',
    sha: expectedHead,
  });
});

test('branch.delete_merged fails closed when the PR is not merged', async (t) => {
  const originalFetch = global.fetch;
  let deleteSeen = false;
  global.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'DELETE') deleteSeen = true;
    return new Response(JSON.stringify(mergedPull({ merged: false, merged_at: null })), { status: 200 });
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', {}, {
    action: 'branch.delete_merged', repository, pr: pullNumber, expected_head_sha: expectedHead,
  }), (error) => error.code === 'PR_NOT_MERGED');
  assert.equal(deleteSeen, false);
});

test('branch.delete_merged fails closed if the branch moved after merge', async (t) => {
  const originalFetch = global.fetch;
  let deleteSeen = false;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if ((options.method || 'GET') === 'DELETE') deleteSeen = true;
    if (value.endsWith(`/repos/owner/private-target/pulls/${pullNumber}`)) {
      return new Response(JSON.stringify(mergedPull()), { status: 200 });
    }
    if (value.endsWith('/repos/owner/private-target')) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    if (value.endsWith('/git/ref/heads/issue-42')) {
      return new Response(JSON.stringify({ object: { sha: 'b'.repeat(40) } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', {}, {
    action: 'branch.delete_merged', repository, pr: pullNumber, expected_head_sha: expectedHead,
  }), (error) => error.code === 'EXPECTED_BRANCH_SHA_MISMATCH');
  assert.equal(deleteSeen, false);
});

test('branch.delete_merged preserves a branch still used by another open PR', async (t) => {
  const originalFetch = global.fetch;
  let deleteSeen = false;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if ((options.method || 'GET') === 'DELETE') deleteSeen = true;
    if (value.endsWith(`/repos/owner/private-target/pulls/${pullNumber}`)) {
      return new Response(JSON.stringify(mergedPull()), { status: 200 });
    }
    if (value.endsWith('/repos/owner/private-target')) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    if (value.endsWith('/git/ref/heads/issue-42')) {
      return new Response(JSON.stringify({ object: { sha: expectedHead } }), { status: 200 });
    }
    if (value.includes('/pulls?state=open&head=owner%3Aissue-42&per_page=100')) {
      return new Response(JSON.stringify([{ number: 99 }]), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(() => executeCommand('token', {}, {
    action: 'branch.delete_merged', repository, pr: pullNumber, expected_head_sha: expectedHead,
  }), (error) => error.code === 'BRANCH_IN_USE_BY_OPEN_PR');
  assert.equal(deleteSeen, false);
});
