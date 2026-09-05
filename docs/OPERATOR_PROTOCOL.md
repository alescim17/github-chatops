# RepoRelay operator authority protocol

This is the normative contract for ChatGPT Web / Codex Web orchestration of configured RepoRelay targets. Native GitHub remains the preferred authoritative read path. RepoRelay is the normal fenced WRITE/control plane and an authoritative GitHub-backed READ **fallback**, not a peer read path.

Local trusted development with full `git`/`gh` access is outside this Web routing contract unless a task explicitly requires RepoRelay.

## Required priority model

READ PRIORITY:

1. native GitHub read;
2. exact native GitHub REST read;
3. RepoRelay read.freeze/read.query fallback;
4. only then declare read plane unavailable.

WRITE PRIORITY:

RepoRelay remains the normal fenced mutation plane for configured targets.

POST-WRITE PRIORITY:

1. new native GitHub read;
2. exact native GitHub REST read;
3. new independent RepoRelay read.freeze;
4. only then report inability to verify.

Do NOT call RepoRelay reads if native GitHub already produced sufficient fresh authority, except for contradiction/recovery diagnostics.

Mutation SUCCESS receipt != post-mutation state verification.

## Native-first selection

Start with native GitHub for branches, commits, trees, files, Issues, PRs, reviews, comments, exact-head checks/statuses, workflow runs/jobs/logs and RepoRelay receipts. A complete, current, consultable native result is sufficient: use it without a redundant RepoRelay command or Actions run.

If a high-level wrapper rejects an argument, truncates data, returns ambiguous metadata or only a resource URI, inspect that resource and retry the exact native GitHub REST/resource GET where available. Do not confuse a wrapper's contract with a GitHub service outage.

Use the RepoRelay fallback only if the authority question remains operationally unanswerable: omitted/empty/Skipped output, no consultable payload, a result that cannot be propagated into the session, or incomplete SHA/tree/state after native retries. `read.capabilities` discovers the installed protocol; `read.freeze` supplies bounded metadata/fences; `read.query` via `relay.private` supplies private content and diagnostics.

Successful typed reads are fresh GitHub-backed observations made directly using the installation token, not cached state, inferred state, or recycled mutation receipts. Request and result digests identify intent and result bytes respectively; neither is a Git object SHA.

A single Skipped message, discovery failure, wrapper failure, resource reference, truncated response or PRIVATE_RELAY_REQUIRED must never by itself become "GitHub unavailable". PRIVATE_RELAY_REQUIRED means use the private channel. READ_RESULT_TOO_LARGE means narrow the explicit page/range or freeze scope. READ_FREEZE_MOVED means re-observe, never weaken a fence.

Only declare READ_PLANE_BLOCKED after BOTH the native read paths and the required typed RepoRelay fallback have failed or are unavailable. Report the actual failed authority question and independent attempts, not an inferred global outage.

## Fresh observations and expected-state fences

Before a consequential mutation, follow READ PRIORITY and capture the default/target branch SHA and tree, PR head/base SHA and lifecycle, relevant Issue state, current exact-head checks/statuses/workflows, review decision/unresolved threads, and command-bus OPEN/UNLOCKED state as needed.

`read.freeze` collects and re-collects the default branch, requested branches, PR head/base/lifecycle, Issue state/update marker and requested review/check/workflow evidence. If any observed authority differs it returns READ_FREEZE_MOVED and safe before/after snapshot digests. SUCCESS always has stable=true for that bounded observation interval. This is an optimistic double-read consistency check, not a GitHub transaction, lock, or guarantee against an unobserved change-and-revert. It does not imply that refs stay unchanged after observed_at_end.

Use a new request_id for every fresh observation. Duplicate suppression is not a new observation; use another ID rather than replaying a completed read. Never reuse a freeze after a mutation or material delay.

Use every supported expected-state fence: expected_parent_sha for atomic commits/patches, expected_head_sha for PR transitions/merge/merged-branch cleanup, expected_base_sha for merge, expected_sha for branch updates/deletion, and expected_blob_sha plus expected_count for exact patches. A fence failure requires re-freezing, not removing or changing a fence merely to make the action pass.

## Writes and private transport

Native read degradation does NOT authorize native writes to configured targets. RepoRelay remains required for those mutations unless the owner explicitly authorizes a narrowly scoped recovery exception. A one-time RepoRelay self-upgrade exception must not be generalized to StreamForge, Aether, Home Assistant or other targets.

Use direct public commands only for allowlisted metadata-only actions. Use relay.private for content-bearing commands. Stage the complete `/reporelay-private` command in an Issue/PR conversation on the private target; post only its target alias, matching request_id and source_comment_id on the public command bus. Staging and receipt comments are transport operations, not product changes. Never publish private repository mappings, bodies, source, paths, logs, tokens or credentials on Issue #3.

The runner authenticates the private comment author, checks envelope binding and same-target receipt destination. The read.query handler separately requires server-owned private-relay context and a private target repository. GET and one fixed GraphQL QUERY document are the only read-handler requests; no caller REST path, URL, HTTP method, GraphQL or generic proxy is accepted. Receipt writes are separate transport operations.

## Read-after-write verification

A mutation SUCCESS receipt proves execution evidence only. Follow POST-WRITE PRIORITY and verify the actual resulting target state independently: ref/commit/tree, PR lifecycle, merge on main, Issue state, deleted branch absence, or exact-head run/check state. An independent read.freeze must have a new request_id and observation interval after the mutation. Sensitive post-write file/log questions still require native content reads or a fresh private read.query.

Only a successful independent observation may be carried forward as the next fence. Do not report completion from a receipt alone, and do not automatically run both native and RepoRelay reads when native verification suffices.

## Contradiction handling

If valid native GitHub and RepoRelay typed observations disagree, STOP mutations. Do not choose native merely by preference and do not automatically trust the newest timestamp. Re-observe the authority-bearing refs and reconcile observation intervals, branch/PR movement, workflow timing, request IDs and receipts. Establish that the relevant refs were stable during the accepted observation before continuing.

An explicit contradiction/recovery diagnostic may intentionally compare both planes. Required commissioning live proofs are such diagnostics; this exception does not turn duplicate reads into routine policy.

## Codex Web recovery recipe

WHEN A GITHUB READ IS NEEDED:

1. Try native @GitHub read.
2. If insufficient, try exact native GitHub REST/resource read.
3. If still unusable, use RepoRelay read.freeze.
4. For private content/logs/diffs use RepoRelay read.query via relay.private.
5. Use a new request_id for every fresh observation.
6. Never reuse a mutation SUCCESS receipt as target-state verification.
7. After mutation, repeat the same read priority with a fresh observation.
8. Only if native reads AND RepoRelay reads fail may the task report
    READ_PLANE_BLOCKED.

WHEN NATIVE READ IS HEALTHY:

Do NOT call RepoRelay read fallback unnecessarily.

For the PUBLIC control repository only, direct public GitHub HTTPS/raw/API reads can recover protocol/code inspection when native output cannot be consulted. Do not depend on attachment paths or old local handoffs. This does not authorize public transport of private target content.

## Final-state reporting

Derive the final state from the latest successful independent observation selected through the required priorities. Preserve target alias, operation, request ID, pre-state SHA/tree, fence values, terminal receipt, post-state SHA/tree, observation times and result digest. Earlier transient failures must not override later verified state.

For ordered work, proceed only after the preceding item is verified complete and any required cleanup is independently verified. Keep permanent command-bus Issue #3 OPEN and UNLOCKED.

See [READ_PLANE.md](READ_PLANE.md) for strict schemas, bounds, pagination, public/private result policy and examples.
