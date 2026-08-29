# RepoRelay

RepoRelay is a private, repository-agnostic GitHub ChatOps control plane designed to keep ChatGPT-based development workflows deterministic when a native GitHub write action is missing, temporarily unavailable, or broken.

## Model

Native GitHub actions remain the preferred path. RepoRelay is the compatibility and safety layer:

```text
ChatGPT
  ├─ native GitHub mutation (when healthy)
  └─ GitHub comment: /reporelay { ... }
             ↓
      github-chatops Issue #1
             ↓ issue_comment
      RepoRelay GitHub Action
             ↓ short-lived GitHub App token
      allowlisted target repository
```

The `issue_comment` workflow lives on this repository's default branch. Target repositories do not need a RepoRelay workflow for the central-control V1.

## Safety properties

- typed JSON commands only; no arbitrary shell or generic HTTP proxy
- command versioning
- authenticated GitHub actor allowlist
- target repository allowlist
- idempotency receipt keyed by source comment ID
- exact `expected_head_sha` fence for Ready/Draft/Merge
- optional `expected_base_sha` fence for Merge
- fresh checks, review decision, unresolved-thread and mergeability checks before Merge
- merge refetched immediately before mutation
- atomic multi-file commit with `expected_parent_sha` and non-force branch update
- direct default-branch commits disabled by policy
- size/file-count limits for comment-carried commits

## V1 actions

### Pull requests

- `pr.create`
- `pr.update`
- `pr.ready`
- `pr.draft`
- `pr.merge`
- `pr.reviewers.request`
- `pr.reviewers.remove`
- `pr.review`
- `pr.review.dismiss`
- `pr.thread.resolve`
- `pr.thread.unresolve`

### Issues and comments

- `issue.create`
- `issue.update`
- `issue.labels.add`
- `issue.labels.remove`
- `issue.assignees.add`
- `issue.assignees.remove`
- `issue.lock`
- `issue.unlock`
- `comment.create`
- `comment.update`

### Milestones

- `milestone.create`
- `milestone.update`
- `milestone.delete`

### Actions

- `workflow.dispatch`
- `workflow.rerun`
- `workflow.rerun_failed`
- `workflow.cancel`
- `workflow.job.rerun`

### Git

- `branch.create`
- `branch.update`
- `branch.delete`
- `git.commit.atomic`

## Example: Ready

```text
/reporelay
{"v":1,"request_id":"aether-108-ready-ba457d6","action":"pr.ready","repository":"alescim17/aether-factory","pr":108,"expected_head_sha":"ba457d654a622723b90c72ac8d7c00ec4a301c5c"}
```

## Example: fenced merge

```text
/reporelay
{"v":1,"request_id":"aether-108-merge-ba457d6","action":"pr.merge","repository":"alescim17/aether-factory","pr":108,"expected_head_sha":"ba457d654a622723b90c72ac8d7c00ec4a301c5c","expected_base_sha":"a84c983ed352e246322fdfcfbefee227fc962900","method":"merge"}
```

RepoRelay fetches the live PR again immediately before merge and fails closed if the head or base no longer matches.

## Setup

See [`docs/GITHUB_APP.md`](docs/GITHUB_APP.md).
