# RepoRelay

RepoRelay is a repository-agnostic GitHub ChatOps control plane for deterministic, policy-gated mutations and typed authoritative fallback reads. Typed comments execute through GitHub Actions with a short-lived GitHub App installation token. The public control repository can operate allowlisted private targets without installing a workflow in each target.

## Native-first authority

For ChatGPT Web / Codex Web, use **native GitHub reads first**, then exact native GitHub REST/resource reads when a wrapper is insufficient. Use RepoRelay read fallback only when native output is operationally unusable: omitted/Skipped/empty results, unconsultable resources, truncated authority, or output that cannot be carried into the next fenced operation. Only if native and RepoRelay reads both fail may an orchestrator declare READ_PLANE_BLOCKED.

Do NOT call RepoRelay reads if native GitHub already produced sufficient fresh authority, except for contradiction/recovery diagnostics. This avoids duplicate command-bus noise, Actions runs and latency.

RepoRelay remains the normal fenced **write/control plane** for configured targets regardless of which read path supplied authority. Native target writes require explicit owner recovery authorization; a read failure never silently changes write routing.

After each mutation, obtain a **new independent** native observation, an exact native REST observation, or, only if those are unusable, a new read.freeze with a new request_id. Mutation SUCCESS receipt != post-mutation state verification.

The normative [operator protocol](docs/OPERATOR_PROTOCOL.md) defines the exact priorities, contradiction handling and eight-step Codex Web recovery recipe.

## Typed read surface

`read.capabilities` is public, metadata-only installed protocol discovery: versions, actions, query kinds, explicit limits and fallback/read-after-write support.

`read.freeze` is public, metadata-only authority: default/requested branch SHA/tree, PR head/base/lifecycle, Issue state, optional reviews and exact-SHA latest checks/workflow-event identities after a complete bounded paginated history scan. The SUCCESS receipt contains the actual sanitized result, timestamps, stable=true and a canonical result_sha256. If authority moves during collection it fails READ_FREEZE_MOVED. It is a fresh GitHub-backed observation, not cached state or a reused mutation receipt.

`read.query` is PRIVATE ONLY through `relay.private`. Its fixed typed kinds provide bounded repository, branch, commit, tree, UTF-8 file range, compare, search, Issue/PR/comment/review/thread/check and workflow/job/log/artifact-metadata reads. Direct public invocation fails PRIVATE_RELAY_REQUIRED before target content is fetched.

Every successful read has a canonical JSON result digest and UTF-8 result byte count. Results exceeding max_read_result_bytes (10 KiB) fail READ_RESULT_TOO_LARGE with safe range/pagination guidance; authoritative read results are never silently sliced. Explicit requested pages/ranges identify any intentionally partial coverage. The digest is result identity, not a Git SHA.

See [typed read schemas and examples](docs/READ_PLANE.md).

## Public/private channels

Direct public actions:

- read.capabilities, read.freeze;
- pr.ready, pr.draft, pr.merge, branch.delete_merged;
- workflow.rerun, workflow.rerun_failed, workflow.cancel, workflow.job.rerun.

Only the two public typed reads can put sanitized read data into public receipts. Existing mutation receipts remain minimal. Public read results exclude mapped private repository names, PR/Issue titles and bodies, comments/review text, file paths/source, logs/artifacts, credentials, emails and tokens. Unsafe free-form check/workflow labels are redacted with identity digests; exact sensitive labels require a private query.

For private queries or content-bearing mutations, put `/reporelay-private { ... }` in an Issue/PR conversation on the private target, then send only this envelope to permanent public Issue #3:

```text
/reporelay
{"v":1,"request_id":"diagnostic-1","action":"relay.private","repository":"target/example","source_comment_id":123456789}
```

The inner request_id and target alias must match. The runner verifies comment author and receipt destination. Private query results go only to that private conversation. Public query SUCCESS contains only completed, private_receipt, result_sha256, result_bytes and query_kind. A failed private read delivery is FAILED, never a successful but unavailable read result.

Keep Issue #3 permanently OPEN and UNLOCKED. Private repository mappings belong only in REPORELAY_TARGETS_JSON, never in public commands or policy.

## Mutation surface and fences

Pull requests: pr.create/update/ready/draft/merge, reviewers, reviews and review-thread mutations. Issues/milestones: create/update, labels, assignees, locks, comments and milestone deletion. Actions: dispatch, rerun, rerun_failed, cancel and job rerun. Git: branch.create/update/delete/delete_merged, git.commit.atomic and git.patch.atomic.

Example fenced merge:

```text
/reporelay
{"v":1,"request_id":"merge-42","action":"pr.merge","repository":"target/example","pr":42,"expected_head_sha":"<40-char-head-sha>","expected_base_sha":"<40-char-base-sha>","method":"squash"}
```

Atomic commits require expected_parent_sha and a non-force branch update. Atomic exact-text patches additionally read every source at that parent, require expected_blob_sha and an exact replacement expected_count, and validate all sources before creating replacement blobs. Both are private-only.

Routine cleanup uses branch.delete_merged with a merged PR number and expected_head_sha. It derives the same-repository branch, verifies terminal merged state, unchanged head, non-default branch and absence of other open PR users before deleting it. Verify deletion independently afterward.

## Safety properties

Typed/versioned commands; actor and target alias allowlists; secret alias mapping; canonical intent hashing and duplicate suppression; no arbitrary shell; no generic HTTP/API proxy or caller GraphQL; public/private payload separation; expected-head/base/parent/blob fences; current exact-head checks; mergeability/review/unresolved-thread gates; last-moment PR refetch; default-branch writes and force updates forbidden; pinned privileged Actions dependencies.

Read handlers use only target GETs and a fixed GraphQL QUERY with validated selectors, never target PUT/PATCH/DELETE or GraphQL mutation. Private command/receipt comments are separate transport operations. No App permission expansion is required.

## Setup and validation

See [GitHub App setup](docs/GITHUB_APP.md). Run `npm test` and `npm run check`; RepoRelay CI runs both. Existing mutation validation remains enabled alongside the typed-read security, race, transport and documentation tests.
