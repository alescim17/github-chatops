# RepoRelay operator authority protocol

This document defines the operational contract for ChatGPT/web orchestrators that use GitHub native access together with RepoRelay.

It is intentionally separate from the RepoRelay command schema: the command schema defines what RepoRelay can mutate, while this protocol defines how an orchestrator establishes authority, chooses a mutation path, and verifies the resulting repository state.

## Scope

This protocol applies to ChatGPT/web orchestration sessions that operate repositories configured behind RepoRelay.

It does not replace normal local development workflows. Codex local or another trusted local operator with full GitHub access should normally use `git`/`gh` directly unless a task explicitly requires RepoRelay.

## Authority model

### 1. GitHub native is the authoritative read plane

Use native GitHub reads for repository state, including:

- default branch and branch refs;
- commits, trees and changed files;
- issues and pull requests;
- reviews and unresolved review threads;
- commit checks/statuses and workflow runs;
- RepoRelay command-bus state and receipts.

Prefer exact GitHub REST resource reads when a higher-level connector wrapper is ambiguous, truncated, or rejects otherwise valid arguments.

A RepoRelay receipt is execution evidence, not the final source of truth for target state.

### 2. RepoRelay is the fenced write/control plane

For a target repository configured to use RepoRelay, route mutations through RepoRelay unless the user explicitly authorizes a native-write recovery path.

Use a direct public command only for actions explicitly allowed on the public command bus. If an action is not in the public allowlist, or if its payload contains source code, file content, issue/PR body content, private repository identity, or other sensitive material, use `relay.private` immediately.

`PRIVATE_RELAY_REQUIRED` is a policy decision, not a GitHub outage. Re-submit through the private relay path instead of declaring the write plane unavailable.

### 3. Native target writes are a recovery path, not a silent fallback

The existence of native GitHub write primitives does not override the configured control-plane policy.

Do not silently switch a RepoRelay-managed target repository to native writes because one RepoRelay command fails. Native target writes may be used only when explicitly authorized by the user or by a pre-declared emergency/recovery policy.

## Fresh authoritative freeze

Before every state-changing mutation, perform a fresh GitHub-native freeze of the state that the mutation depends on.

Capture, as applicable:

- current default-branch SHA;
- target branch SHA;
- PR head SHA and base SHA;
- issue/PR open, closed, draft or merged state;
- exact-head checks/statuses and relevant workflow runs;
- review decision and unresolved review threads;
- command-bus open/unlocked state when RepoRelay is required.

Do not reuse an old freeze after another mutation or after a material delay when the relevant ref may have changed.

## Expected-state fences

Every RepoRelay mutation that supports an expected-state fence must use it.

Examples include:

- `expected_parent_sha` for atomic commits;
- `expected_head_sha` for PR state transitions, merge and merged-branch cleanup;
- `expected_base_sha` for merge when the base SHA is known;
- `expected_sha` for branch ref updates or deletion.

If a fence fails, stop and re-freeze. Never weaken, remove or rewrite the fence merely to make the command succeed.

## Mutation path selection

Use this order:

1. Establish a fresh native GitHub freeze.
2. Determine whether the action is explicitly public-command safe.
3. If yes, send the fenced public RepoRelay command.
4. Otherwise, post the complete private command in the private target conversation and send only the `relay.private` envelope through the public bus.
5. Wait for the terminal RepoRelay receipt/evidence for that request.
6. Perform native GitHub read-after-write verification before considering the mutation complete.

Do not publish private repository names, source code, file contents, secrets, tokens, or private issue/PR bodies in the public command bus.

## Read-after-write verification

A `SUCCESS` receipt is necessary evidence but is not sufficient completion evidence.

After every successful mutation, re-read the affected target through GitHub native and verify the intended invariant, for example:

- branch exists at the expected SHA;
- commit parent/tree and branch ref match;
- PR state/head/base match;
- merge commit is present on the default branch;
- issue state changed as intended;
- deleted branch returns not found;
- workflow/check state is tied to the exact expected SHA.

Only the verified target state may be carried forward as the next authoritative freeze.

## Anti-false-blockage rule

Do not declare GitHub or RepoRelay unavailable from a single wrapper/tool failure.

The following are not, by themselves, evidence of a read-plane outage:

- invalid connector argument shape;
- a wrapper-specific validation error;
- a response returned as a resource URI that still needs to be read;
- output truncation;
- an unsupported high-level wrapper when an exact REST GET is available;
- `PRIVATE_RELAY_REQUIRED` from RepoRelay.

When a native read wrapper fails, retry the same authority question through an exact GitHub REST resource read where possible. Declare the native read plane unavailable only after independent authoritative reads needed for the operation also fail.

When RepoRelay fails, distinguish policy rejection, expected-state fence failure, target/API failure, and transport failure. Only transport/runtime failure should be described as RepoRelay availability failure.

## Contradiction handling

If RepoRelay receipt evidence and a subsequent native GitHub read disagree:

1. stop further mutations;
2. perform a new native freeze of the affected refs/resources;
3. inspect the corresponding RepoRelay request and receipt;
4. reconcile before issuing any dependent command.

Never resolve a contradiction by guessing which state is newer.

## Final-state reporting

The final user-visible status must be derived from the latest successful authoritative GitHub-native freeze.

Transient errors encountered earlier in the session must not override later verified state. Likewise, a RepoRelay receipt must not be reported as completed target state until read-after-write verification succeeds.

For ordered work such as `A -> B -> C`, advance to the next item only after the previous item is merged/closed as required, post-merge state is verified, and required cleanup is verified.

## Minimal completion record

For consequential mutations, retain enough information in the session to identify the exact transition:

- repository target alias;
- operation/action;
- request ID;
- pre-mutation authoritative SHA/state;
- expected-state fence values;
- terminal RepoRelay status;
- post-mutation authoritative SHA/state.

This record is the basis for recovery if the session is interrupted or a later read disagrees with an earlier summary.
