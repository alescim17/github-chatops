# Issue #32: App authority and exact receipt continuity

## Proven R2 failure

Installed R1 main: `bfe8f32dec3a5ce31a45bfdb154ae86f93c01659`, tree
`45b735e0e668105b73903dd209516ed687ffb73d`.
Original public receipt: issue #3 comment `5567823124`, request
`rr-r2-20260907-k7m4-rr-freeze`, source `5567819415`.
Failed recovery receipt: `5567871548` (`RECEIPT_HISTORY_MOVED`).

A bounded, GET-only diagnostic reused the original receipt and the unchanged
R1 `core.mjs`, `receipt-authority.mjs` and `request-recovery.mjs` on `issue-32`.
Run: https://github.com/alescim17/github-chatops/actions/runs/34106954596
Job: `101694067107` (`diagnose-r2-receipt`).
Diagnostic commit: `06d985970dfe392332cddc8b13d558f899be7819`.
At 2026-09-07T09:36:37Z, the same GitHub Actions control-token read path reported:

| Primitive | Collection | Exact comment |
| --- | --- | --- |
| `performed_via_github_app` own property | true | true |
| `performed_via_github_app` type | object | null |
| `performed_via_github_app.id` type | number | undefined |
| App ID equals 4764725 | true | false |
| strict `isRepoRelayReceipt` | true | false |
| status | SUCCESS | SUCCESS |

`id`, `node_id`, `url`, `issue_url`, `created_at`, `updated_at`, and user
`login`, `id`, `type`, `node_id` were equal, with unchanged primitive types.
Body equality, body-hash equality and marker equality were all true;
`updated_at_relation=equal`. Calling unchanged R1 `lookupRequest` then reproduced
`RECEIPT_HISTORY_MOVED` at 09:36:48Z. This is not a moving receipt or a target
failure: `matchingReceipt` returns null because it repeats the strict App
projection requirement on the exact endpoint.

Credential wiring was not changed: original receipt writes use the existing
RepoRelay installation App token (`REPORELAY_TARGET_TOKEN`); collection scan and
exact reread both use `REPORELAY_CONTROL_TOKEN=${{ github.token }}`. Legacy proof
uses the runner-supplied App proof token through `ReadClient`, not user input.
The diagnostic job inherited the original workflow permissions: contents read,
issues write, metadata read. It did not create an App token, execute a command,
write a receipt, read any product repository, or print bodies/credentials.
Its temporary job and script are removed from the final candidate. The workflow
must be byte-for-byte equal to installed R1 before acceptance.

Native connector reads, using a different credential, showed App ID 4764725 in
both views. Their harmless `client_id` projection difference alone did NOT prove
the bug. The actual workflow-token diagnostic above is the root-cause evidence.

## Test-first proof on unchanged R1 production sources

Before the production correction, commit
`7ec4ef6505c6f8470510b5baefd0d03e46dc56f5` added the real `action: created`
issue-comment event shape to the isolated subprocess fixture. RepoRelay CI run
https://github.com/alescim17/github-chatops/actions/runs/34108902084
(job `101700269734`, Node 22.23.2) executed the complete `npm test` suite:
378 tests, 362 passed, 16 failed, zero skipped. All pre-existing tests passed.
The canonical R2 fixture and both actual `src/runner.mjs` subprocess cases
failed with `RECEIPT_HISTORY_MOVED`, not an event/setup failure. This verifies
that endpoint-projection regressions fail on installed R1 behavior.
The red checkpoint also exposes terminal body replacement and authority-class
switch cases that the continuity correction must reject. The 54 new behavior
tests remained unchanged for the initial production correction; the P1 follow-up
adds strict read-only proof plumbing and strengthens final-reread assertions.

## Independent review P1 and current-body writer proof

Independent review `5130681895`, comment `3948660168`, on candidate
`c0a3c17f18d21cec528bafe503968f00a42d2a2a` identified a real P1: App creation
identity alone does not authenticate an in-place STARTED-to-terminal body edit.
The initial 378-green candidate was NOT accepted.

A single harmless, marker-free comment on control Issue #32 (`5569031545`)
was created through RepoRelay for an isolated writer-authority experiment.
Run https://github.com/alescim17/github-chatops/actions/runs/34110216879
(job `101704461566`) proved that the ordinary workflow control token could
PATCH this probe with HTTP 200. The collection still had RepoRelay App authority;
control-token exact view still had app=null; App-token exact view still had the
original App authority. All retained the same immutable creator identity while
the body changed. The existing App then restored the harmless probe to phase
APP_UPDATED_PROBE_COMPLETE. No actual receipt or product comment was edited.
This rules out simply using the App token for the exact reread as a P1 fix.

A subsequent READ-ONLY run
https://github.com/alescim17/github-chatops/actions/runs/34110633572
(job `101705792639`) read GraphQL IssueComment metadata for the probe and
original R2 receipt with both existing credentials. For all four views:
node ID, fullDatabaseId, body, creation/update timestamps, URL and issue binding
matched REST. fullDatabaseId was a string; lastEditedAt was a string equal to
updatedAt. The diagnostic's guessed REST-style actor classification returned
OTHER; it does not establish a REST-to-GraphQL actor encoding and none is used.
A proposed additional diagnostic was tool-blocked and was NOT dispatched.
All temporary diagnostic jobs/scripts are removed from the candidate.

The correction verifies the current body of EVERY App receipt with a fixed
read-only GraphQL node query using the same control token. The node must be the
exact selected IssueComment, matching numeric ID, node ID, issue/repository,
URL, full body and creation/update timestamps. Its immutable GraphQL author is
already bound to the pinned REST App creator by that same physical comment.
For an edited body, editor and author must both be Bot and have the SAME opaque
GraphQL actor ID. No REST/GraphQL login or ID encoding is guessed. A generic
Actions editor or another App cannot inherit the original creator's actor ID.
An unedited body requires explicit null editor AND null lastEditedAt; missing
proof is never success. Edit timestamps must fall within the receipt lifetime.
GraphQL errors are sanitized to REQUEST_AUTHORITY_UNVERIFIED.

A final exact REST reread must retain the authenticated identity/body/update
snapshot after the GraphQL proof. Deletion, replacement or concurrent changes
remain errors. This covers edits before the scan as well as STARTED advancement
during the scan, without relaxing initial strict App authority or legacy proof.
No token, permission, workflow permission or product access expansion is needed.

The proof fixture keeps the live observed IssueComment shape/relations, including
string fullDatabaseId and exact R2 node IDs. Opaque actor IDs are explicitly
synthetic: only same-actor versus different-actor identity matters. Existing
recovery test cases/assertions remain; their mocks add a strictly checked
read-only GraphQL query and expect the additional final exact reread. The #29
permanent history test files and their assertions are untouched.

## Security boundary and state contract

Writer authority and state continuity are separate. A NEW App receipt still
requires the complete pinned RepoRelay user login/numeric ID/Bot tuple AND App
ID 4764725 from the complete-history collection scan. Missing initial App proof
cannot establish success. Generic Actions remains legacy-only and still needs
immutable authorized intent, exact command hash, real RepoRelay execution on
installed-main ancestry and source rereads. Legacy qualification is unchanged.

After initial App proof, exact reread must retain the same pinned writer,
comment ID, node identity, URL/issue binding and creation identity. Null/absent
exact App projection is not new authority; it is accepted only for continuity
of that already authenticated receipt. Explicit contradictory/malformed App
identity is rejected. The marker still binds request, source, action, target
and command hash. Terminal state cannot switch or regress, timestamps cannot
move backwards, and an unchanged status must retain the entire body. STARTED
may advance in place to SUCCESS or FAILED, including within the same second.

Complete scan, collision checks, all page-boundary and tail revalidations,
exact reread, alias binding, legacy proof and metadata-only redaction remain.
No policy, token, permission, alias, default-branch or merge-policy expansion.

## Fixture provenance and regression coverage

`test/fixtures/r2-receipt.mjs` retains exact safe public values and types from
R2 receipt 5567823124: pinned author/App identity, numeric comment/source IDs,
node IDs, control issue/URLs, creation/update times, marker, body and digest.
Unconsumed avatars, user links, App permissions and reaction objects are omitted.
The relevant observed runner difference is preserved exactly: own App property
with object in collection and null in exact, with all stable fields/body equal.
The extra absent-property and harmless-client-id cases are explicit synthetic
robustness vectors, not claims about additional live observations.

Stable authority: pinned user tuple plus collection App ID. Endpoint projection:
App metadata in exact (null observed), and non-authority client metadata. Mutable
receipt state: STARTED may change status/body/update time in place. Immutable
receipt identity: comment/creation/user/issue/marker identity. Terminal body is
frozen. Synthetic adversarial mutations are applied individually to real-shaped
fixtures; existing R1 and #29 tests and assertions are not weakened.

Existing successful R2 comment.create public receipts are additional vectors:

| Alias | Original request suffix | Public receipt | Existing diagnostic comment |
| --- | --- | --- | --- |
| target/reporelay | rr-write | 5567979951 | 5567980066 |
| target/aether | ae-write | 5567981698 | 5567981867 |
| target/streamforge | sf-write | 5567982987 | 5567983160 |
| target/homeassistant | ha-write | 5567985401 | 5567985599 |

All request IDs use prefix `rr-r2-20260907-k7m4-`. Their public marker identities,
command hashes, timestamps and redacted SUCCESS envelopes are retained. Their
null exact projections in tests model the proven control-token behavior; no
additional product writes or claims of post-install commissioning are made.
The isolated subprocess tests load actual `src/runner.mjs`, verify control-token
GETs/read-only GraphQL versus App-token new-lookup receipt writes, and forbid all
other routes. Generic Actions may never authenticate the current body of an
App-created receipt merely because creator metadata remains unchanged.

Candidate tests and CI are not post-install live commissioning. Global readiness
remains NO until separate installation and four-target request recovery.
