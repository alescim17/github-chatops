# RepoRelay GitHub App setup

Create a private GitHub App named **RepoRelay** under the account that owns the target repositories.

The `github-chatops` repository itself is public; the GitHub App remains private and its credentials never belong in git, issues, comments, or workflow logs.

## Repository permissions

Grant only the permissions required by the V1 command surface:

- Actions: Read and write
- Checks: Read-only
- Contents: Read and write
- Issues: Read and write
- Pull requests: Read and write
- Commit statuses: Read-only
- Workflows: Read and write
- Metadata: Read-only (automatic)

Do not grant Administration, Secrets, Environments, Deployments, Members, organization administration, or other unrelated permissions.

Install RepoRelay only on repositories that RepoRelay is allowed to mutate.

## Control repository configuration

In `alescim17/github-chatops` configure:

- Repository variable `REPORELAY_APP_CLIENT_ID`: the GitHub App Client ID.
- Actions secret `REPORELAY_APP_PRIVATE_KEY`: the complete PEM private key generated for RepoRelay.
- Actions secret `REPORELAY_TARGETS_JSON`: private alias mapping, for example:

```json
{
  "target/reporelay": "OWNER/github-chatops",
  "target/aether": "OWNER/PRIVATE_REPOSITORY_1",
  "target/streamforge": "OWNER/PRIVATE_REPOSITORY_2",
  "target/homeassistant": "OWNER/PRIVATE_REPOSITORY_3"
}
```

Use the real owner/repository names only in this secret. Keep `config/policy.json` limited to target aliases so converting the control plane to public does not disclose private repository full names.

The privileged workflow uses `actions/create-github-app-token` pinned to a reviewed full commit SHA. It mints a short-lived installation token scoped to explicit permissions. The action revokes the token when the job finishes.

## Public command channel

V1 accepts public triggers only from permanent command-bus Issue #3 of `alescim17/github-chatops`, and only when GitHub reports the comment author as `alescim17`.

Keep Issue #3 open and unlocked.

Direct public commands are restricted to metadata-only actions. Never put source code, issue/PR body content, private repository full names, secrets, tokens, or sensitive branch/context information in Issue #3.

## Private relay for sensitive commands

For content-bearing commands:

1. Post `/reporelay-private { ... }` as a comment on an issue or PR in the private target repository.
2. Capture the resulting GitHub issue-comment ID.
3. Post a public `relay.private` command to Issue #3 containing only the target alias, matching `request_id`, and `source_comment_id`.
4. RepoRelay fetches the private source comment using its App token and verifies the private comment author before execution.
5. Detailed success/failure evidence is written back to the private source issue/PR; the public receipt is intentionally minimal.

No token, password, private key, or sensitive payload is ever placed in the public command bus.

## Public-repository Actions security

The privileged workflow checks out only the default-branch version of this public repository and is triggered by `issue_comment`; pull-request code never receives the RepoRelay private key. Keep privileged third-party/GitHub-owned actions pinned to reviewed full commit SHAs.
