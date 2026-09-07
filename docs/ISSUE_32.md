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
GETs versus App-token new-lookup receipt writes, and forbid all other routes.

Candidate tests and CI are not post-install live commissioning. Global readiness
remains NO until separate installation and four-target request recovery.
