# Typed authoritative read fallback — v1

These actions are fallback tools for Web orchestrators, not a replacement for healthy native GitHub reads. Follow [OPERATOR_PROTOCOL.md](OPERATOR_PROTOCOL.md) first. Commissioning/recovery diagnostics may explicitly compare both planes; normal reads must not duplicate sufficient native authority.

## Envelope and public actions

All commands use v=1, a fresh bounded request_id, a policy-allowlisted `target/<alias>` repository and one exact action. Unknown fields are rejected. No URL, HTTP method, REST path, caller GraphQL, api_path, rest_path or query_text is accepted.

```text
/reporelay
{"v":1,"request_id":"read-capabilities-unique","action":"read.capabilities","repository":"target/example"}
```

Capabilities contain schema_version, observed_at, read_plane_version, public_read_actions, private_read_actions, read_query_kinds, limits, supports_fallback_freeze and supports_read_after_write_freeze. No target repository mappings or private content appear.

```text
/reporelay
{"v":1,"request_id":"freeze-unique","action":"read.freeze","repository":"target/example","branches":["main","issue-42"],"prs":[42],"issues":[41],"include_checks":true,"include_workflows":true,"include_reviews":true}
```

The six freeze options are optional (collections default empty, flags false). Branches accept safe branch names or refs/heads names; duplicate normalized branches are rejected. Each of branches/prs/issues is bounded to 8, as is the union of default/requested/PR head/base commit SHAs. Missing requested branches return exists=false and null SHA/tree; a missing default branch, Issue or PR fails rather than inventing authority.

The public result contains observed_at_start/end, stable=true, repository.default_branch/default_branch_sha/default_branch_tree_sha; requested branches with ref/exists/sha/tree_sha; requested PRs with number/state/draft/merged/mergeable/mergeable_state/head_ref/head_sha/head_tree_sha/base_ref/base_sha/base_tree_sha/commit_count/changed_file_count; Issues with number/state/state_reason/locked/comments_count/updated_at; relevant_shas and explicit includes flags. Review requests add review_decision/unresolved_review_thread_count. Checks/statuses and workflow runs are grouped by every relevant exact SHA, including base/default SHAs. No workflow logs appear.

Checks contain latest app/name identities and id/status/conclusion; statuses contain latest context/state/id and combined_status. Workflow runs contain id/name/status/conclusion/event/run_number/run_attempt/head_sha. If complete bounded evidence cannot fit, the read fails; it does not silently drop checks, runs or SHAs. Unknown/pending mergeability is preserved, not asserted mergeable.

All authority is collected twice. A difference in default/requested branches, PR metadata/head/base/update marker, Issue metadata/update marker or requested review/check/workflow evidence fails READ_FREEZE_MOVED with safe before/after snapshot digests. This detects observed movement; it is not a transactional lock or a guarantee against undetectable ABA changes. A timestamp is observation evidence only, never a promise about future state.

## Private query

Stage this only in the private target conversation, then submit a matching relay.private envelope to Issue #3:

```text
/reporelay-private
{"v":1,"request_id":"file-read-unique","action":"read.query","repository":"target/example","kind":"file","ref":"<exact-40-character-commit-sha>","path":"README.md","start_line":1,"end_line":10}
```

Every list requires an explicit page and per_page (both positive integers); they have no implicit unbounded/default page. `pr.threads` uses per_page and an optional opaque after cursor instead. SHA fields require full lowercase 40-character SHAs. Ref fields accept safe explicit refs; file/commit-history/tree refs resolve to a pinned commit before content reads. File paths must be relative NFC UTF-8 without `..`, absolute forms, controls, bidi/control formatting, backslashes, colon, empty segments or excessive length/depth. Symlinks and submodules are rejected for file reads. File results carry verified blob SHA and pinned commit/tree authority and contain UTF-8 text only.

| kind | Typed selectors beyond the envelope and kind | Returned scope |
| --- | --- | --- |
| repository | none | Bounded repository metadata |
| branch | ref | Exact branch commit/tree |
| branches.list | page, per_page | Explicit branch page |
| commit | sha; optional body_start_line/body_end_line | Commit, parents, tree, optional message range |
| commits.list | ref, page, per_page | History page pinned to resolved ref SHA |
| tree | exactly one ref or tree_sha; page, per_page; optional recursive boolean | Explicit entry page of a complete bounded tree |
| file | ref, path, start_line, end_line | Verified UTF-8 blob line range |
| compare | base_sha, head_sha, page, per_page | Commit comparison statistics and commit page; files intentionally excluded |
| code.search | terms array, page, per_page | Target-default-branch indexed search only |
| issue | issue; optional body_start_line/body_end_line | Issue metadata/body or requested body range |
| issue.comments | issue, page, per_page; optional body_start_line/body_end_line | Conversation comment page (also usable on a PR number) |
| pr | pr; optional body_start_line/body_end_line | PR metadata/body or requested body range |
| pr.files | pr, page, per_page; optional expected_head_sha | File metadata page, no implicit patch truncation |
| pr.diff | pr, start_line, end_line; optional expected_head_sha | Explicit unified-diff line range |
| pr.comments | pr, page, per_page; optional expected_head_sha and body_start_line/body_end_line | Inline review comment page |
| pr.reviews | pr, page, per_page; optional expected_head_sha and body_start_line/body_end_line | Review submission page |
| pr.threads | pr, per_page; optional after and expected_head_sha | Thread metadata/resolution/path; comment text via pr.comments |
| checks | sha, page, per_page | Exact-SHA check/status pages and combined status |
| workflow.runs | page, per_page; optional sha | Run metadata page, optionally exact-SHA scoped |
| workflow.run | run | One target run |
| workflow.jobs | run, page, per_page; optional attempt | Attempt-pinned jobs with bounded step metadata |
| workflow.job.log | job; either start_line/end_line or tail_lines | One validated target job's bounded log range |
| workflow.artifacts | run, page, per_page | Artifact metadata only, never binary content |

`terms` are bounded literal search words, not GitHub query syntax. RepoRelay appends the already-resolved target repo scope server-side, disallows qualifiers/OR/AND/NOT and validates every returned repository. A caller cannot broaden search to another repo/org/user. Search is GitHub's current indexed default branch, **not** exact-commit source authority; use file/tree for exact-ref evidence.

PR files/diff/comments/reviews/threads re-read PR authority and fail if it moved. Optional expected_head_sha adds an explicit input fence. Jobs use a pinned attempt; logs validate the target-scoped job, owning run and head SHA before fetching. The only allowed log redirect is a GitHub-issued HTTPS Actions/blob storage URL; the installation token and original headers are never forwarded. No arbitrary URL can be supplied by a caller.

Pages return page/per_page/has_more/next_page (or a GraphQL cursor), and total_count when GitHub supplies it. Line results return start_line/end_line/requested_end_line/total_lines/has_more/text; an end beyond EOF is explicitly reported. Out-of-range starts fail. Body ranges apply to each returned body; a page containing a shorter body can therefore require a different range/page. Metadata projections are intentional schemas, not claims to mirror every GitHub API field.

## Bounds and result identity

Policy centralizes all limits. Current maxima: freeze branches/PRs/Issues/distinct SHAs 8 each; canonical result 10,240 UTF-8 bytes; file/body lines 120; diff lines 160; comments/reviews 20; search results 20; workflow runs/jobs 30; log lines 120. Generic page size <=100, page <=1000; checks/statuses <=100 each; review threads <=300; tree source entries <=10,000; source response <=4 MiB; requests <=160 per handler; per-request timeout 20 seconds. Paths <=512 bytes/16 segments; refs <=200 bytes. Capabilities publishes the complete installed limits, including all subsidiary bounds.

A large upstream source or incomplete GitHub tree/search/page fails closed even if a requested result range is small. For an upstream-source limit, use another typed diagnostic (for example jobs instead of logs) or native read transport; reducing output lines alone cannot reduce GitHub's unpaged log/diff/blob source. Limits are never silently raised to pass a read. Freeze overflow guidance is to narrow scope/use paged queries; query overflow guidance is to reduce page/line range. The requested page/range is never silently sliced to fit.

Successful handler envelopes contain `result`, `result_sha256` and `result_bytes`. Serialize result recursively with sorted object keys, preserved array order, JSON primitives only and no insignificant whitespace; hash those UTF-8 bytes with SHA-256. The hash does not include the envelope itself. Equal canonical data gives equal digests; a fresh timestamp normally changes the digest even if refs match. A result digest is not a Git object SHA.

Public read SUCCESS adds completed=true and contains the full sanitized envelope. Private read SUCCESS writes the full envelope to the private conversation; the public receipt includes only completed, private_receipt, result_sha256, result_bytes and query_kind. Both receipts identify the same result bytes. Typed receipts use complete compact JSON, not the legacy mutation-result slicing path. Failed private delivery fails the action rather than reporting inaccessible SUCCESS.

## Public result safety

An explicit projection and validator allow only typed public metadata. They exclude mapped private repository names, repository titles/descriptions, PR/Issue title/body, comments/review text, paths/source, logs/artifact content, commit messages, credentials, tokens, emails and secrets. Repositories are identified publicly only by target alias in receipt metadata. Branch/ref names are intentional authority fields; suspicious secret/control-bearing refs fail and require a private read.

Free-form check/status/workflow labels can themselves contain paths or secrets. Conservative validation redacts unsafe labels as `[redacted]` with a corresponding `*_sha256` identity digest; no potentially sensitive free-form text is published to preserve a cosmetic name. Use private checks/workflow queries when exact redacted names are needed. Numeric IDs and safe states remain usable publicly.

Mutation results from git.commit.atomic/git.patch.atomic/pr.update/issue.update/comment.create/workflow.dispatch and all existing actions stay minimal in public. Read handlers have no mutation methods, and the fixed GraphQL document is QUERY only. No App permissions, actor/target allowlists, default-branch/force-write policy or merge gates are relaxed.
