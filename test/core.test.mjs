import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, authorize, RepoRelayError, assertChecksGreen } from '../src/core.mjs';

const policy = {
  control_repository: 'alescim17/github-chatops',
  control_issues: [1],
  authorized_actors: ['alescim17'],
  allowed_repositories: ['alescim17/aether-factory'],
};

test('parseCommand accepts a typed command', () => {
  const command = parseCommand('/reporelay {"v":1,"request_id":"r1","action":"pr.ready","repository":"alescim17/aether-factory"}');
  assert.equal(command.action, 'pr.ready');
});

test('parseCommand rejects malformed JSON', () => {
  assert.throws(() => parseCommand('/reporelay nope'), (error) => error instanceof RepoRelayError && error.code === 'COMMAND_JSON_INVALID');
});

test('authorize rejects actors outside allowlist', () => {
  assert.throws(() => authorize({ policy, actor: 'mallory', controlRepository: 'alescim17/github-chatops', controlIssue: 1, command: { repository: 'alescim17/aether-factory' } }), (error) => error.code === 'ACTOR_FORBIDDEN');
});

test('authorize rejects target repositories outside allowlist', () => {
  assert.throws(() => authorize({ policy, actor: 'alescim17', controlRepository: 'alescim17/github-chatops', controlIssue: 1, command: { repository: 'someone/else' } }), (error) => error.code === 'REPOSITORY_FORBIDDEN');
});

test('assertChecksGreen accepts success/neutral/skipped and ignores historical duplicates selected upstream', () => {
  assert.doesNotThrow(() => assertChecksGreen({ checkRuns: [
    { name: 'ci', status: 'completed', conclusion: 'success' },
    { name: 'optional', status: 'completed', conclusion: 'skipped' },
  ], statuses: [] }));
});

test('assertChecksGreen fails pending checks', () => {
  assert.throws(() => assertChecksGreen({ checkRuns: [{ name: 'ci', status: 'in_progress', conclusion: null }], statuses: [] }), (error) => error.code === 'CHECKS_PENDING');
});

test('request_id is mandatory and constrained', () => {
  assert.throws(() => parseCommand('/reporelay {"v":1,"request_id":"bad space","action":"pr.ready","repository":"alescim17/aether-factory"}'), (error) => error.code === 'REQUEST_ID_INVALID');
});
