# Server-frozen pull-request merge gate

`pr.merge.frozen` is a private-relay recovery action for ChatGPT/web connector sessions in which GitHub native reads work but the connector does not materialize the current head SHA as a reusable command argument.

It does not remove the exact-SHA merge fence. RepoRelay establishes that fence server-side immediately before delegating to the ordinary `pr.merge` gate.

## Required command evidence

The private command must provide:

- `pr`: target pull-request number;
- `expected_head_ref`: exact same-repository head branch;
- `expected_base_ref`: exact base branch;
- `expected_base_sha`: exact 40-character base SHA from the operator freeze;
- `expected_commit_count`: exact PR commit count;
- `expected_files`: complete sorted-or-unsorted changed-file path set;
- `method`: approved merge method.

Example private source command:

```text
/reporelay-private
{"v":1,"request_id":"merge-frozen-42","action":"pr.merge.frozen","repository":"target/example","pr":42,"expected_head_ref":"issue-42","expected_base_ref":"main","expected_base_sha":"<40-char-sha>","expected_commit_count":3,"expected_files":["src/a.ts","test/a.test.ts"],"method":"merge"}
```

The public bus receives only the ordinary `relay.private` envelope. File paths and other private scope evidence must not be copied into the public command bus.

## Execution contract

RepoRelay:

1. fetches the current pull request;
2. verifies same-repository ownership, open state, head/base refs, exact base SHA, commit count, and complete changed-file set;
3. captures the live head SHA;
4. delegates to the ordinary `pr.merge` implementation with that exact head SHA and the verified base SHA;
5. therefore retains the existing checks, mergeability, review-decision, unresolved-thread, last-moment refetch, and GitHub merge-SHA guards.

A change to the head branch, base, commit count, or changed-file scope before the command fails closed. A change after the server-side freeze is rejected by the ordinary exact-head merge fence.

## Boundary

Use this action only when the native connector cannot supply a read value as a subsequent command argument. Prefer ordinary `pr.merge` whenever the operator can carry an exact `expected_head_sha` directly.
