# RepoRelay GitHub App setup

RepoRelay uses a private GitHub App to execute allowlisted mutations against target repositories with short-lived installation tokens.

The control repository may be public. The GitHub App remains private, and its credentials must never be stored in git, issues, comments, or workflow logs.

## Repository permissions

Grant only the permissions required by the enabled command surface:

- Actions: Read and write
- Checks: Read-only
- Contents: Read and write
- Issues: Read and write
- Pull requests: Read and write
- Commit statuses: Read-only
- Workflows: Read and write
- Metadata: Read-only (automatic)

Do not grant Administration, Secrets, Environments, Deployments, Members, organization administration, or unrelated permissions.

Install RepoRelay only on repositories it is explicitly allowed to mutate.

## Control repository configuration

Configure these values in the control repository:

- repository variable `REPORELAY_APP_CLIENT_ID`: GitHub App Client ID;
- Actions secret `REPORELAY_APP_PRIVATE_KEY`: complete PEM private key generated for the App;
- Actions secret `REPORELAY_TARGETS_JSON`: target-alias mapping.

Example target map:

```json
{
  "target/control": "OWNER/control-repository",
  "target/example": "OWNER/private-target-repository"
}
```

Real private repository names belong only in this secret. Public commands and `config/policy.json` should use target aliases.

The privileged workflow uses `actions/create-github-app-token` pinned to a reviewed full commit SHA. It mints a short-lived installation token scoped to the requested permissions and revokes it after the job.

## Command bus

RepoRelay is triggered by comments on the configured command-bus issue.

The workflow must verify at least:

- event type is `issue_comment`;
- comment author is allowlisted;
- issue number matches the configured command bus;
- command starts with `/reporelay`;
- target alias is allowlisted.

Keep the command-bus issue open and unlocked.

## Public and private commands

Direct public commands are restricted to metadata-only actions. Do not put source code, issue/PR body content, private repository full names, secrets, tokens, or other sensitive payloads in the public command bus.

For content-bearing commands:

1. post `/reporelay-private { ... }` as a comment on an issue or PR in the private target repository;
2. capture the GitHub issue-comment ID;
3. post a public `relay.private` envelope containing only the target alias, matching `request_id`, and `source_comment_id`;
4. RepoRelay fetches the private source comment with its App token and verifies its author;
5. detailed success/failure evidence is written back to the private source conversation while the public receipt stays minimal.

No token, password, private key, or sensitive payload should appear in the public command bus.

## Public-repository Actions security

For a public control repository:

- privileged `issue_comment` jobs must execute the workflow/code from the default branch;
- pull-request code must never receive the RepoRelay private key;
- keep the workflow `GITHUB_TOKEN` permissions minimal;
- pin privileged action dependencies to reviewed full commit SHAs;
- keep target selection and command authorization server-side and fail closed.

## Post-merge branch cleanup

Use `branch.delete_merged` for routine cleanup instead of deleting branch refs directly.

The action accepts a merged PR number and `expected_head_sha`. RepoRelay derives the head branch from GitHub and deletes it only if the PR is merged, the branch belongs to the same repository, the ref is unchanged, the branch is not the default branch, and no other open PR still uses it.
