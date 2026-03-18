## Summary
- let `CI` run via `workflow_dispatch` so automation can explicitly kick it off for bot-created branches
- use a GitHub App token in the dependency-update workflows when available so auto-created PRs trigger normal `pull_request` checks
- fall back to dispatching `ci.yml` manually when only the default `GITHUB_TOKEN` is available, and grant the workflows `actions: write` for that path

## Testing
- `for f in .github/workflows/*.yml; do yq eval '.' "$f" > /dev/null || exit 1; done`
