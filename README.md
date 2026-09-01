# RepoRelay

RepoRelay is a repository-agnostic GitHub ChatOps control plane for deterministic, policy-gated repository mutations.

Commands are submitted as typed comments and executed through GitHub Actions with a short-lived GitHub App installation token.

```text
operator / automation
        ↓
GitHub comment
        ↓
GitHub Actions
        ↓
GitHub App installation token
        ↓
allowlisted target repository
```

The control repository can be public while target repositories remain private. Target repositories do not need a RepoRelay workflow in the central-control model.

## Operator authority protocol

ChatGPT/web orchestrators must use GitHub native access as the authoritative read plane and RepoRelay as the fenced write/control plane for configured target repositories. Every consequential mutation requires a fresh authoritative freeze, expected-state fences where supported, and GitHub-native read-after-write verification before the resulting state is considered complete.

A single connector-wrapper failure is not sufficient evidence that GitHub is unavailable, and `PRIVATE_RELAY_REQUIRED` is a policy decision rather than a RepoRelay outage. Native target writes are a recovery path only when explicitly authorized.

See [`docs/OPERATOR_PROTOCOL.md`](docs/OPERATOR_PROTOCOL.md) for the normative orchestration protocol, including anti-false-blockage, contradiction handling, and final-state reporting rules.

## Command channels

RepoRelay supports two command paths.

### Public metadata commands

Metadata-only operations may be posted directly to the public command-bus issue. Public receipts intentionally contain minimal execution metadata.

Allowed public actions include:

- `pr.ready`
- `pr.draft`
- `pr.merge`
- `branch.delete_merged`
- `workflow.rerun`
- `workflow.rerun_failed`
- `workflow.cancel`
- `workflow.job.rerun`

### Private relay

Content-bearing or potentially sensitive operations use `relay.private`.

1. Put the complete `/reporelay-private { ... }` command in an issue or PR comment inside the private target repository.
2. Post a small `relay.private` envelope to the public command bus containing only the target alias, `request_id`, and private `source_comment_id`.
3. RepoRelay fetches the private source comment with its GitHub App token, verifies the author and envelope binding, executes the command, and writes detailed evidence back to the private source conversation.

Example private command:

```text
/reporelay-private
{"v":1,"request_id":"change-1","action":"git.commit.atomic","repository":"target/example","branch":"issue-42","expected_parent_sha":"<40-char-sha>","message":"fix: example","files":[{"path":"src/example.ts","content":"..."}]}
```

Public relay envelope:

```text
/reporelay
{"v":1,"request_id":"change-1","action":"relay.private","repository":"target/example","source_comment_id":123456789}
```

## Safety properties

- typed, versioned JSON commands only
- no arbitrary shell execution
- no generic HTTP/API proxy
- authenticated GitHub actor allowlist
- target alias allowlist plus secret alias-to-repository mapping
- write-ahead idempotency receipts with canonical command hashing
- duplicate or changed intent fails closed
- exact `expected_head_sha` fencing for Ready, Draft, Merge, and merged-branch cleanup
- optional `expected_base_sha` merge fence
- current exact-head check/status evidence required before merge
- mergeability, review-decision, and unresolved-thread gates
- PR head/base refetched immediately before merge
- atomic multi-file commits use `expected_parent_sha` and non-force branch updates
- direct default-branch commits and branch creation disabled by policy
- privileged workflow dependencies pinned to reviewed full commit SHAs
- public receipts do not expose private command results

## Command surface

### Pull requests

- `pr.create`
- `pr.update`
- `pr.ready`
- `pr.draft`
- `pr.merge`
- reviewer, review, and review-thread mutations

### Issues and milestones

- issue create/update
- labels and assignees
- lock/unlock
- comments
- milestone create/update/delete

### Actions

- workflow dispatch
- rerun
- rerun failed
- cancel
- job rerun

### Git

- `branch.create`
- `branch.update`
- `branch.delete`
- `branch.delete_merged`
- `git.commit.atomic`

`branch.delete_merged` is the recommended post-merge cleanup path. It derives the branch from a merged PR and deletes it only when:

- the PR is actually merged;
- the PR head belongs to the same repository;
- `expected_head_sha` matches the merged head;
- the branch still points to that exact SHA;
- the branch is not the default branch;
- no other open PR uses the branch.

Example:

```text
/reporelay
{"v":1,"request_id":"cleanup-42","action":"branch.delete_merged","repository":"target/example","pr":42,"expected_head_sha":"<40-char-head-sha>"}
```

## Example: fenced merge

```text
/reporelay
{"v":1,"request_id":"merge-42","action":"pr.merge","repository":"target/example","pr":42,"expected_head_sha":"<40-char-head-sha>","expected_base_sha":"<40-char-base-sha>","method":"merge"}
```

RepoRelay refetches live authority immediately before destructive or state-transitioning mutations and fails closed when preconditions change.

## Setup

See [`docs/GITHUB_APP.md`](docs/GITHUB_APP.md).
