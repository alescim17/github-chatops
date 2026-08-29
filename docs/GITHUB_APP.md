# RepoRelay GitHub App setup

Create a private GitHub App named **RepoRelay** under the account that owns the target repositories.

## Repository permissions

Grant only:

- Actions: Read and write
- Contents: Read and write
- Issues: Read and write
- Pull requests: Read and write
- Metadata: Read-only (automatic)

Do not grant Administration, Secrets, Environments, Deployments, Members, or organization administration permissions for V1.

Install RepoRelay only on repositories that are also listed in `config/policy.json`.

Initial repositories:

- `alescim17/github-chatops`
- `alescim17/aether-factory`
- `alescim17/streamforge`
- `alescim17/homeassistant`

## Control repository configuration

In `alescim17/github-chatops` configure:

- Repository variable `REPORELAY_APP_CLIENT_ID`: the GitHub App Client ID.
- Actions secret `REPORELAY_APP_PRIVATE_KEY`: the complete PEM private key generated for RepoRelay.

The workflow uses `actions/create-github-app-token@v3` to mint a short-lived installation token at run time. The token is scoped by the App installation and requested permissions and is revoked by the action after the job.

## Control channel

V1 accepts commands only from Issue #1 of `alescim17/github-chatops`, only when GitHub reports the comment author as `alescim17`.

No token, password, or signature is ever placed in a command comment.
