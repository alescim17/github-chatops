# Typed authoritative read fallback — v1

These actions are fallback tools for Web orchestrators, not a replacement for healthy native GitHub reads. Follow [OPERATOR_PROTOCOL.md](OPERATOR_PROTOCOL.md) first. Commissioning/recovery diagnostics may explicitly compare both planes; normal reads must not duplicate sufficient native authority.

## Envelope and public actions

All commands use v=1, a fresh bounded request_id, a policy-allowlisted `target/<alias>` repository and one exact action. Unknown fields are rejected. No URL, HTTP method, REST path, caller GraphQL, api_path, rest_path or query_text is accepted.

```text
/reporelay
{"v":1,"request_id":"read-capabilities-unique","action":"read.capabilities","repository":"target/example"}
```

Capabilities contain schema_version, observed_at, read_plane_version, public_read_actions, private_read_actions, public_mutation_actions, private_mutation_actions, transport_actions, read_query_kinds, limits, supports_fallback_freeze and supports_read_after_write_freeze. The four action lists are projected from the same immutable executable registry used by the dispatcher and public-channel guard. The serializer rejects a matrix inconsistent with that registration. transport_actions separately identifies the runner relay.private envelope. Every installed mutation is discoverable, including private comment/Issue/PR/review/milestone operations, workflow dispatch, atomic commits/patches and fenced branch merge; discovery does not authorize their execution. No target repository mappings or private content appear.

Read plane 1.1.0 is an additive extension of 1.0.1: command v=1 and result schema_version=1 are unchanged; prior read actions/selectors and mutation channel/authorization boundaries are unchanged. Consumers must tolerate the newly documented capability fields/action. Request lookup is available only after installation, not merely because candidate source exists.

```text
/reporelay
{"v":1,"request_id":"freeze-unique","action":"read.freeze","repository":"target/example","branches":["main","issue-42"],"prs":[42],"issues":[41],"include_checks":true,"include_workflows":true,"include_reviews":true}
```

The six freeze options are optional (collections default empty, flags false). Branches accept safe branch names or refs/heads names; duplicate normalized branches are rejected. Each of branches/prs/issues is bounded to 8, as is the union of default/requested/PR head/base commit SHAs. Missing requested branches return exists=false and null SHA/tree; a missing default branch, Issue or PR fails rather than inventing authority.

The public result contains observed_at_start/end, stable=true, repository.default_branch/default_branch_sha/default_branch_tree_sha; requested branches with ref/exists/sha/tree_sha; requested PRs with number/state/draft/merged/mergeable/mergeable_state/head_ref/head_sha/head_tree_sha/base_ref/base_sha/base_tree_sha/commit_count/changed_file_count; Issues with number/state/state_reason/locked/comments_count/updated_at; relevant_shas and explicit includes flags. Review requests add review_decision/unresolved_review_thread_count. Latest checks/statuses and workflow/event identities are grouped by every relevant exact SHA, including base/default SHAs. No workflow logs appear.

Checks contain latest app/name identities and id/status/conclusion; statuses contain latest context/state/id and combined_status. RepoRelay scans the complete bounded GitHub history across pages before selecting these identities: GitHub filter=latest alone does not deduplicate separate historical check suites. Check groups include observed_check_run_count and observed_status_count. Workflow groups explicitly declare selection=latest_per_workflow_event and observed_run_count; each returned latest workflow/event identity contains workflow_id/id/name/status/conclusion/event/run_number/run_attempt/head_sha. Every distinct workflow/event is represented; older executions of that same identity are history, not current snapshot authority. Use private workflow.runs pages for historical runs. If the full source scan, distinct latest identities or complete canonical result exceed their respective bounds, the read fails; no unseen pages are silently omitted. Unknown/pending mergeability is preserved, not asserted mergeable.

All authority is collected twice. A difference in default/requested branches, PR metadata/head/base/update marker, Issue metadata/update marker or requested review/check/workflow evidence fails READ_FREEZE_MOVED with safe before/after snapshot digests. This detects observed movement; it is not a transactional lock or a guarantee against undetectable ABA changes. A timestamp is observation evidence only, never a promise about future state.

## Public request recovery — read.request

Submit exactly these five fields to permanent Issue #3:

```text
/reporelay
{"v":1,"request_id":"lookup-unique","action":"read.request","repository":"target/example","lookup_request_id":"original-request-id"}
```

Both IDs use 1-120 characters from A-Z, a-z, digits, period, underscore, colon and hyphen. lookup_request_id must differ from request_id. No query string, arbitrary URL/path/API selector, caller control token/context, or alternate bus is accepted. The usual actor and alias policy still applies: PUBLIC describes metadata/channel safety, not anonymous authorization. The runner supplies the permanent control repository/Issue and control token independently of command JSON and binds the expected original alias before exposing matching metadata.

The successful result is one of these schema_version=1 variants, inside the usual sealed result/result_sha256/result_bytes envelope:

```typescript
type RequestNotFound = {
  schema_version: 1;
  observed_at: string; // UTC ISO timestamp
  lookup_request_id: string;
  repository: string; // exact target/<alias>, never mapped full name
  found: false;
};
type RequestFound = {
  schema_version: 1;
  observed_at: string;
  lookup_request_id: string;
  repository: string;
  found: true;
  action: string;
  status: 'STARTED' | 'SUCCESS' | 'FAILED';
  terminal: boolean; // exactly status !== STARTED
  source_comment_id: number | string; // positive safe integer, or legacy dispatch-<run-id>
  receipt_comment_id: number; // positive safe integer
  command_hash: string; // 64 lowercase hexadecimal characters
  receipt_created_at: string; // UTC ISO timestamp
  receipt_updated_at: string; // UTC ISO timestamp, >= created
  private_receipt?: boolean; // included only when delivery indicator is known
  result_sha256?: string; // original typed-read digest only
  result_bytes?: number; // original typed-read byte count, nonnegative safe integer
  query_kind?: string; // only the allowlisted kind of an original read.query
};
```

Optional digest/byte fields describe the ORIGINAL read result; the outer lookup envelope separately identifies the lookup result. private_relay in STARTED does not prove private receipt delivery, so no delivery indicator is fabricated. read.request never exposes private receipt bodies, source commands, target files, PR/Issue bodies, comment text, logs, credentials or mutation results. For new RepoRelay-App receipts it reads only the public permanent bus. Legacy authority verification may internally GET immutable authorized source comments (including a private staged command) and the actual RepoRelay job log using existing installation-token permissions; none of those contents are returned, logged or copied into public errors. It never executes the source command or fetches a private query result. It copies only allowlisted primitive fields from the authenticated PUBLIC receipt envelope, validates them again through public serialization, and drops nested result/error/payload fields. Mutation receipts never contribute result digests or query metadata. Results remain bounded to 10,240 canonical UTF-8 bytes.

### Complete-history authority

The shared #29 scanner pages the permanent bus with per_page=100 and no since filter or lifetime page/comment ceiling. It validates array shape and strictly increasing safe-integer IDs. The ordinary idempotency finder retains early receipt suppression; read.request uses complete mode, scanning even after a match so later conflicting identities cannot be missed. It retains a page of bodies, one boundary ID per full page and at most one candidate. Before returning success OR absence, every full-page boundary is re-read and checked; the terminal page is re-read and its IDs/length must be unchanged. API failures and workflow timeout never prove absence. Freeze/query max_read_page/max_read_requests/max_freeze_history_items do not cap permanent-bus recovery history.

New public receipt authority is the existing RepoRelay App: reporelay-control[bot], actor ID 322612842, type Bot, App ID 4764725. The runner writes STARTED and terminal receipts using that existing installation token; narrow control-token bus reads remain unchanged. No workflow/App permissions, authorized actors, aliases, merge policies or public/private action boundaries are expanded. An unrelated workflow with a generic GITHUB_TOKEN cannot mint this App identity. Human/copied/unrelated-App markers and private-receipt markers cannot impersonate a new public receipt. Matching is by an exact first-line request-id field, not a substring/prefix. Two candidate receipt comments claiming the same request remain conservatively ambiguous; no comment is selected arbitrarily.

Generic github-actions[bot] / actor ID 41898282 / App ID 15368 comments are LEGACY CANDIDATES, not authority by writer identity alone. For a terminal comment-triggered legacy request the recovery handler fetches the exact original control-bus source, checks its authorized owner, unchanged created/updated identity and target/request binding, and recomputes the command hash. A relay.private source additionally requires the exact immutable same-owner private staged command, scoped to the already-resolved target. It then obtains complete workflow-run/job proof pages for the source-to-receipt time interval, restricts them to .github/workflows/reporelay.yml, the control repository, main, authorized actor and verified current-main ancestry, and requires exactly one matching JSON execution-log record for the status/request/action/alias. Workflow conclusion alone never supplies status. Source comments and the exact legacy receipt are re-read after proof collection to reject movement. The receipt itself is never edited.

The permanent bus scan still has no lifetime or 1000-comment ceiling. Additional legacy proof reads use the existing bounded read client, its source/request limits and token-safe log redirect handling. Missing/expired logs, API limits, non-advancing/incomplete proof pages or absence of a unique proof are errors, never NOT_FOUND or accepted receipt authority. Legacy logs do not bind result bytes or private delivery: result_sha256/result_bytes/query_kind/private_receipt are omitted for legacy recovery rather than silently trusted. These optional fields remain retained for authenticated RepoRelay-App receipts.

Legacy STARTED receipts cannot be safely authenticated from the old runner, which did not log in-flight intent, and old workflow_dispatch requests lack an immutable comment source; they fail REQUEST_AUTHORITY_UNVERIFIED rather than fabricate state. An edited/deleted original source or expired historical log likewise prevents legacy proof. A terminal legacy comment-triggered request remains recoverable when its immutable intent and execution evidence are available. New App-authenticated STARTED/SUCCESS/FAILED and dispatch receipts do not depend on legacy source/log retention. This security compatibility limit is explicit; no installed execution or mutation is inferred absent from a proof failure.

After a unique target-bound match and complete stable scan, read.request GETs that exact receipt comment again. Immutable request/source/comment/action/alias/hash/creation identity must agree; update time cannot go backward and terminal SUCCESS/FAILED cannot regress or switch. A prior STARTED may advance to SUCCESS/FAILED in place. The exact current comment, not workflow conclusion, determines status. This is an observed snapshot, not a lock or a guarantee against subsequent changes; a new lookup request_id is required for another observation.

### Fail-closed recovery and replay

RECEIPT_PAGE_INVALID, RECEIPT_SCAN_NOT_ADVANCING, RECEIPT_HISTORY_MOVED and GITHUB_API_ERROR preserve failure rather than returning found=false. REQUEST_TARGET_MISMATCH rejects a request belonging to another alias without returning that alias or metadata. REQUEST_ID_AMBIGUOUS rejects duplicate identities. REQUEST_RECEIPT_INVALID rejects malformed matching receipt metadata/envelopes. REQUEST_AUTHORITY_UNVERIFIED rejects a generic/legacy writer without sufficient RepoRelay-specific proof; bounded legacy read transport failures preserve their typed READ_* codes. READ_REQUEST_ID_INVALID rejects invalid/self-referential selectors; READ_REQUEST_CONTEXT_INVALID rejects missing or incorrect server-owned bus context. Unknown fields are READ_FIELDS_UNKNOWN. Public errors remain codes/safe guidance, never private error details.

A stable found=false is not proof of non-execution: a source may be queued, a receipt may have been deleted, or execution/receipt delivery may be uncertain. Reconcile exact source/run/target evidence before retrying a mutation. STARTED is not proof that a mutation has not happened, and FAILED may follow a partially completed external operation. Never automatically replay the original action. Lookup uses its own normal intent hash/idempotency; re-submitting that identical lookup request is DUPLICATE_SUPPRESSED and does not execute the original command or mutate its receipt.

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

Policy centralizes all limits. Current maxima: freeze branches/PRs/Issues/distinct SHAs 8 each; canonical result 10,240 UTF-8 bytes; file/body lines 120; diff lines 160; comments/reviews 20; search results 20; workflow runs/jobs 30; log lines 120. Generic page size <=100, page <=1000; checks/statuses <=100 each; review threads <=300; tree source entries <=10,000; source response <=4 MiB; complete freeze history scan <=1,000 items per SHA/collection (max_freeze_history_items), independently of the smaller latest-result limits; requests <=160 per handler; per-request timeout 20 seconds. Paths <=512 bytes/16 segments; refs <=200 bytes. Capabilities publishes the complete installed limits, including all subsidiary bounds.

A large upstream source or incomplete GitHub tree/search/page fails closed even if a requested result range is small. For an upstream-source limit, use another typed diagnostic (for example jobs instead of logs) or native read transport; reducing output lines alone cannot reduce GitHub's unpaged log/diff/blob source. Limits are never silently raised to pass a read. Freeze overflow guidance is to narrow scope/use paged queries; query overflow guidance is to reduce page/line range. The requested page/range is never silently sliced to fit.

Successful handler envelopes contain `result`, `result_sha256` and `result_bytes`. Serialize result recursively with sorted object keys, preserved array order, JSON primitives only and no insignificant whitespace; hash those UTF-8 bytes with SHA-256. The hash does not include the envelope itself. Equal canonical data gives equal digests; a fresh timestamp normally changes the digest even if refs match. A result digest is not a Git object SHA.

Public read SUCCESS adds completed=true and contains the full sanitized envelope. Private read SUCCESS writes the full envelope to the private conversation; the public receipt includes only completed, private_receipt, result_sha256, result_bytes and query_kind. Both receipts identify the same result bytes. Typed receipts use complete compact JSON, not the legacy mutation-result slicing path. Failed private delivery fails the action rather than reporting inaccessible SUCCESS.

## Public result safety

An explicit projection and validator allow only typed public metadata. They exclude mapped private repository names, repository titles/descriptions, PR/Issue title/body, comments/review text, paths/source, logs/artifact content, commit messages, credentials, tokens, emails and secrets. Repositories are identified publicly only by target alias in receipt metadata. Branch/ref names are intentional authority fields; suspicious secret/control-bearing refs fail and require a private read.

Free-form check/status/workflow labels can themselves contain paths or secrets. Conservative validation redacts unsafe labels as `[redacted]` with a corresponding `*_sha256` identity digest; no potentially sensitive free-form text is published to preserve a cosmetic name. Use private checks/workflow queries when exact redacted names are needed. Numeric IDs and safe states remain usable publicly.

Mutation results from git.commit.atomic/git.patch.atomic/pr.update/issue.update/comment.create/workflow.dispatch and all existing actions stay minimal in public. Read handlers have no mutation methods, and the fixed GraphQL document is QUERY only. No App permissions, actor/target allowlists, default-branch/force-write policy or merge gates are relaxed.
