# GitHub Webhooks (Fast Follow to #192)

GitHub context injection (#192) uses polling. This adds an optional webhook server so agents can react quickly to review feedback and CI updates while polling remains the fallback.

## Enable

Set these environment variables in `.env`:

```bash
GITHUB_WEBHOOK_PORT=8787
GITHUB_WEBHOOK_SECRET=your_webhook_secret
# optional
GITHUB_WEBHOOK_PATH=/webhooks/github
```

`GITHUB_WEBHOOK_SECRET` is required whenever the webhook server is enabled.

## Endpoint

- Method: `POST`
- Path: `GITHUB_WEBHOOK_PATH` (default `/webhooks/github`)
- Signature: `x-hub-signature-256` HMAC SHA-256 verification

## Supported events

- `pull_request_review_comment`
- `pull_request_review`
- `issues`
- `issue_comment`
- `check_suite`

Only watched repositories from `data/github-watches.json` are routed. Events for unwatched repos are ignored.

## Runtime behavior

- deduplicates deliveries by `x-github-delivery` (10-minute in-memory window)
- invalidates cached GitHub context for affected agents immediately
- posts a synthetic system message into each affected agent's primary subscribed channel
- enqueues the agent run so it can react without waiting for the next manual prompt

Polling from #192 remains active as a resilience path if webhook delivery is delayed or unavailable.
