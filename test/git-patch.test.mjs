import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyExactReplacements, handleAtomicPatch } from '../src/handlers/patch.mjs';

const repository = 'owner/private-target';
const policy = {
  allow_direct_default_branch_writes: false,
  limits: { max_atomic_commit_files: 32, max_atomic_commit_bytes: 48000 },
};

test('git.patch.atomic is registered in the typed command dispatcher', () => {
  const dispatcher = readFileSync(new URL('../src/handlers/index.mjs', import.meta.url), 'utf8');
  assert.match(dispatcher, /case 'git\.patch\.atomic': return handleAtomicPatch/);
});

test('applyExactReplacements applies only the exact expected occurrence count', () => {
  assert.equal(
    applyExactReplacements('alpha beta alpha', [
      { before: 'alpha', after: 'omega', expected_count: 2 },
    ], 'src/example.ts'),
    'omega beta omega',
  );

  assert.throws(
    () => applyExactReplacements('alpha beta', [
      { before: 'alpha', after: 'omega', expected_count: 2 },
    ], 'src/example.ts'),
    (error) => error.code === 'REPLACEMENT_COUNT_MISMATCH'
      && error.details.expected === 2
      && error.details.actual === 1,
  );
});

test('git.patch.atomic reads the exact parent blob and commits the patched UTF-8 content', async (t) => {
  const originalFetch = global.fetch;
  const parentSha = 'a'.repeat(40);
  const expectedBlobSha = 'b'.repeat(40);
  const createdBlobSha = 'c'.repeat(40);
  const treeSha = 'd'.repeat(40);
  const commitSha = 'e'.repeat(40);
  let postedBlobContent = null;
  const methods = [];

  global.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || 'GET';
    methods.push({ value, method, body: options.body });

    if (value.endsWith('/repos/owner/private-target') && method === 'GET') {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    if (value.endsWith('/git/ref/heads/issue-x') && method === 'GET') {
      return new Response(JSON.stringify({ object: { sha: parentSha } }), { status: 200 });
    }
    if (value.endsWith(`/git/commits/${parentSha}`) && method === 'GET') {
      return new Response(JSON.stringify({ tree: { sha: 'parent-tree' } }), { status: 200 });
    }
    if (value.endsWith(`/contents/src/example.ts?ref=${parentSha}`) && method === 'GET') {
      return new Response(JSON.stringify({
        type: 'file',
        encoding: 'base64',
        sha: expectedBlobSha,
        content: Buffer.from('const mode = "old";\n', 'utf8').toString('base64'),
      }), { status: 200 });
    }
    if (value.endsWith('/git/blobs') && method === 'POST') {
      const body = JSON.parse(options.body);
      postedBlobContent = body.content;
      return new Response(JSON.stringify({ sha: createdBlobSha }), { status: 201 });
    }
    if (value.endsWith('/git/trees') && method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body, {
        base_tree: 'parent-tree',
        tree: [{ path: 'src/example.ts', mode: '100644', type: 'blob', sha: createdBlobSha }],
      });
      return new Response(JSON.stringify({ sha: treeSha }), { status: 201 });
    }
    if (value.endsWith('/git/commits') && method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body, {
        message: 'fix: patch example',
        tree: treeSha,
        parents: [parentSha],
      });
      return new Response(JSON.stringify({ sha: commitSha }), { status: 201 });
    }
    if (value.endsWith('/git/refs/heads/issue-x') && method === 'PATCH') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { sha: commitSha, force: false });
      return new Response(JSON.stringify({ object: { sha: commitSha } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${method} ${value}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await handleAtomicPatch('token', policy, {
    action: 'git.patch.atomic',
    repository,
    branch: 'issue-x',
    expected_parent_sha: parentSha,
    message: 'fix: patch example',
    files: [{
      path: 'src/example.ts',
      expected_blob_sha: expectedBlobSha,
      replacements: [{ before: 'const mode = "old";', after: 'const mode = "new";' }],
    }],
  });

  assert.equal(result.sha, commitSha);
  assert.equal(result.patched, true);
  assert.equal(postedBlobContent, 'const mode = "new";\n');
  assert.equal(methods.filter(({ value }) => value.endsWith('/git/blobs')).length, 1);
});

test('git.patch.atomic rejects a stale source blob before creating a replacement blob', async (t) => {
  const originalFetch = global.fetch;
  const parentSha = 'a'.repeat(40);
  let blobPostSeen = false;

  global.fetch = async (url, options = {}) => {
    const value = String(url);
    const method = options.method || 'GET';
    if (value.endsWith('/repos/owner/private-target') && method === 'GET') {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    if (value.endsWith('/git/ref/heads/issue-x') && method === 'GET') {
      return new Response(JSON.stringify({ object: { sha: parentSha } }), { status: 200 });
    }
    if (value.endsWith(`/git/commits/${parentSha}`) && method === 'GET') {
      return new Response(JSON.stringify({ tree: { sha: 'parent-tree' } }), { status: 200 });
    }
    if (value.endsWith(`/contents/src/example.ts?ref=${parentSha}`) && method === 'GET') {
      return new Response(JSON.stringify({
        type: 'file',
        encoding: 'base64',
        sha: 'f'.repeat(40),
        content: Buffer.from('old', 'utf8').toString('base64'),
      }), { status: 200 });
    }
    if (value.endsWith('/git/blobs') && method === 'POST') blobPostSeen = true;
    throw new Error(`unexpected fetch ${method} ${value}`);
  };
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    () => handleAtomicPatch('token', policy, {
      action: 'git.patch.atomic',
      repository,
      branch: 'issue-x',
      expected_parent_sha: parentSha,
      message: 'fix: patch example',
      files: [{
        path: 'src/example.ts',
        expected_blob_sha: 'b'.repeat(40),
        replacements: [{ before: 'old', after: 'new' }],
      }],
    }),
    (error) => error.code === 'EXPECTED_BLOB_SHA_MISMATCH',
  );
  assert.equal(blobPostSeen, false);
});
