# RepoRelay

RepoRelay is a public, repository-agnostic GitHub ChatOps control plane for deterministic GitHub mutations initiated from ChatGPT when a native GitHub write action is missing, temporarily unavailable, or broken.

Target repositories can remain private. The public repository is intentionally small so its standard GitHub-hosted Actions can run without consuming private-repository Actions minutes.

## Model

```text
ChatGPT
  ├─ native GitHub mutation (preferred when healthy)
  │
  └─ RepoRelay fallback
       ├─ metadata-only command → public Issue #3
       └─ sensitive command → private target comment
                              + public Issue #3 relay pointer
                                      ↓
                               RepoRelay Action
                                      ↓
                          short-lived GitHub App token
                                      ↓
                               private target repo
```

The privileged `issue_comment` workflow always runs from this repository's default branch. Target repositories do not need a RepoRelay workflow in V1.

## Public control-plane privacy

Private repository full names are not stored in `config/policy.json` or normal command receipts. Public commands use aliases such as `target/aether`. The alias-to-repository mapping is stored only in the `REPORELAY_TARGETS_JSON` Actions secret.

Only metadata-only actions may execute directly from public Issue #3:

- `pr.ready`
- `pr.draft`
- `pr.merge`
- `workflow.rerun`
- `workflow.rerun_failed`
- `workflow.cancel`
- `workflow.job.rerun`

All content-bearing or potentially sensitive actions must use `relay.private`.

## Private relay

For a sensitive mutation, ChatGPT first writes the complete command as a comment in the private target repository:

```text
/reporelay-private
{"v":1,"request_id":"feature-commit-1","action":"git.commit.atomic","repository":"target/aether","branch":"issue-x","expected_parent_sha":"<40-char-sha>","message":"fix: example","files":[{"path":"src/example.ts","content":"..."}]}
```

Then ChatGPT posts only a pointer to public command-bus Issue #3:

```text
/reporelay
{"v":1,"request_id":"feature-commit-1","action":"relay.private","repository":"target/aether","source_comment_id":123456789}
```

RepoRelay resolves the alias from its secret target map, fetches the private comment with the GitHub App token, verifies that its author is the authorized actor, requires matching `request_id` and target alias, executes the private command, and writes detailed results back to the private issue/PR. The public receipt stays minimal.

## Safety properties

- typed JSON only; no arbitrary shell and no generic HTTP/API proxy
- authenticated GitHub actor allowlist
- target alias allowlist plus secret alias-to-repository mapping
- write-ahead idempotency receipt keyed by source comment/request ID and canonical command hash
- duplicate or changed intent fails closed
- exact `expected_head_sha` fence for Ready/Draft/Merge; a raced Ready is restored to Draft
- optional `expected_base_sha` merge fence
- current exact-head check/status evidence required before merge
- green checks, review-decision, unresolved-thread and mergeability gates before merge
- PR head/base refetched immediately before merge
- atomic multi-file commits use `expected_parent_sha` and non-force branch updates
- direct default-branch commits and branch creation disabled by policy
- public logs/receipts do not emit private command results
- privileged workflow dependencies are pinned to reviewed full commit SHAs

## V1 actions

PR: `pr.create`, `pr.update`, `pr.ready`, `pr.draft`, `pr.merge`, reviewer/review/thread mutations.

Issues: create/update, labels, assignees, lock/unlock, comments, milestone create/update/delete.

Actions: dispatch, rerun, rerun failed, cancel, job rerun.

Git: branch create/update/delete and `git.commit.atomic`.

## Example: Ready

```text
/reporelay
{"v":1,"request_id":"aether-108-ready-ba457d6","action":"pr.ready","repository":"target/aether","pr":108,"expected_head_sha":"ba457d654a622723b90c72ac8d7c00ec4a301c5c"}
```

## Example: fenced merge

```text
/reporelay
{"v":1,"request_id":"aether-108-merge-ba457d6","action":"pr.merge","repository":"target/aether","pr":108,"expected_head_sha":"ba457d654a622723b90c72ac8d7c00ec4a301c5c","expected_base_sha":"a84c983ed352e246322fdfcfbefee227fc962900","method":"merge"}
```

RepoRelay refetches the PR immediately before the merge mutation and fails closed if the head/base moved.

## Setup

See [`docs/GITHUB_APP.md`](docs/GITHUB_APP.md).
