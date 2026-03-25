# GitHub App Setup for Auto-Update PRs

OmniClaw ships GitHub Actions workflows that open dependency update PRs for:

- OpenCode CLI and SDK
- Claude Agent SDK
- repository token-count badge refreshes

Those workflows can fall back to the default `GITHUB_TOKEN`, but GitHub often suppresses downstream `pull_request` workflow runs for branches and PRs created by that token. The workflows now include a CI backstop, but the most reliable setup is still a dedicated GitHub App token.

## What you need

- Admin access to the owner of `omniaura/omniclaw`
- Permission to create or install a GitHub App
- Access to repository secrets for `omniaura/omniclaw`

## Create the GitHub App

1. Go to GitHub Settings -> Developer settings -> GitHub Apps.
2. Click `New GitHub App`.
3. Use a name that makes the purpose obvious, such as `omniclaw-update-bot`.
4. Set a homepage URL. The repository URL is fine.
5. Leave webhook handling disabled for this use case.

## Required permissions

Grant these repository permissions:

- `Actions`: Read and write
- `Contents`: Read and write
- `Pull requests`: Read and write
- `Metadata`: Read-only

No organization permissions are required for the current workflows.

## Install the app

1. Open the app settings page.
2. Click `Install App`.
3. Install it on `omniaura/omniclaw`.
4. If GitHub asks which repositories the app can access, limit it to `omniaura/omniclaw` unless you intentionally want broader reuse.

## Generate credentials

1. From the app settings page, copy the numeric App ID.
2. Under `Private keys`, generate a new private key.
3. Save the downloaded `.pem` file immediately. GitHub only shows it once.

## Add repository secrets

In `omniaura/omniclaw` -> `Settings` -> `Secrets and variables` -> `Actions`, add:

- `APP_ID`: the numeric GitHub App ID
- `APP_PRIVATE_KEY`: the full PEM contents, including the `BEGIN` and `END` lines

Paste the private key as a multi-line secret exactly as downloaded.

## Verify the setup

1. Run `Update OpenCode` or `Update Claude Agent SDK` with `workflow_dispatch` from the Actions tab.
2. Confirm the workflow log shows `Create GitHub App token` running instead of the fallback path.
3. Confirm the workflow pushes an `update/...` branch and opens a PR.
4. Confirm `ci.yml` appears on the PR automatically, or that the workflow log shows the manual backstop dispatching it.

If you want to verify the token path without waiting for a real dependency bump, temporarily rerun after editing the workflow on a branch or trigger the job when a new upstream version exists.

## Expected behavior after setup

- update workflows create branches and PRs with the GitHub App token
- PRs can trigger follow-up workflows more reliably than the default `GITHUB_TOKEN`
- if GitHub still does not enqueue `ci.yml`, the workflow now checks for an existing run and dispatches one manually

## Troubleshooting

### `GitHub App secrets not configured`

At least one of `APP_ID` or `APP_PRIVATE_KEY` is missing from repository secrets.

### `Resource not accessible by integration`

The app is installed, but it does not have the required repository permissions or is not installed on `omniaura/omniclaw`.

### PR opens but no CI run appears

Check the `Ensure CI is queued for update PR` step in the workflow logs. If that step fails, verify that the app has `Actions: Read and write` and that `gh workflow run ci.yml --ref <branch>` works for the installation token.

### Invalid private key errors

Re-copy the entire PEM file into `APP_PRIVATE_KEY`, including line breaks and the header/footer lines.
