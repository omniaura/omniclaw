# Slack Agent Setup

OmniClaw's Slack channel ships with native [Slack AI-app](https://docs.slack.dev/ai) integration: the assistant pane, suggested prompts, "is thinking…" status, response streaming, and markdown blocks. These features are live in `src/channels/slack.ts` but stay dormant until the Slack app on your workspace is configured for them.

This guide is the missing config step.

## TL;DR

1. Create a Slack app from the manifest at [`config-examples/slack-app-manifest.json`](../config-examples/slack-app-manifest.json).
2. Enable **Socket Mode** and generate an app-level token (`xapp-…`) with `connections:write`.
3. Install to your workspace, copy the bot token (`xoxb-…`) and app token into `.env`.

## Why a manifest?

The new agent capabilities require three coupled things on the Slack side:

- **Scope** — `assistant:write` (in addition to the existing `chat:write` / `*:history` / `reactions:*` set).
- **Events** — `assistant_thread_started` and `assistant_thread_context_changed`, so Bolt's `Assistant` middleware fires.
- **Feature flag** — the `features.assistant_view` block, which is what makes Slack render your app in the _AI Apps_ picker and give you a dedicated assistant pane.

Without all three, the code paths in `src/channels/slack.ts` (`registerAssistant`, `setStatus`, suggested prompts, streaming) compile and run but Slack never invokes them. Same binary, no visible agent UI.

## Manifest walkthrough

The file at `config-examples/slack-app-manifest.json` is the reference. Highlights:

- `features.assistant_view.assistant_description` — one-line tagline Slack shows in the AI Apps directory.
- `features.assistant_view.suggested_prompts` — initial prompts in a new assistant thread. The runtime in `slack.ts` re-sends these via `setSuggestedPrompts` on `threadStarted`; the manifest copy is the fallback Slack uses before the bot connects.
- `oauth_config.scopes.bot` — superset of what `.env.example` documents. Trim if your install doesn't need a particular channel type.
- `settings.event_subscriptions.bot_events` — keep `assistant_thread_started` and `assistant_thread_context_changed` even if you don't think you need them; the Bolt `Assistant` class subscribes implicitly and will warn at startup if they're missing.
- `settings.socket_mode_enabled: true` — OmniClaw runs Socket Mode; do not flip this without also providing a public request URL.

## Create the app

1. Open [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**.
2. Pick your workspace, paste the JSON manifest, review, create.
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**. Add the `connections:write` scope and copy the resulting `xapp-…` token.
4. **Install App → Install to Workspace**. Copy the bot user OAuth token (`xoxb-…`).
5. Fill in `.env`:

   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

6. Restart OmniClaw. The startup log should show `Slack bot connected` with your bot's user ID.

## Updating an existing app

If you already have a Slack app from before PR #829 landed:

1. Open the app on [api.slack.com/apps](https://api.slack.com/apps) → **App Manifest**.
2. Diff your current manifest against `config-examples/slack-app-manifest.json` and merge in the deltas — primarily the `features.assistant_view` block, the `assistant:write` scope, and the two `assistant_thread_*` events.
3. **Save Changes** → reinstall when Slack prompts for the new scopes.

The non-assistant code paths keep working with the old manifest; you just won't see the agent pane until you reinstall.

## Multi-bot installs

For workspaces running multiple OmniClaw bots (the `SLACK_BOT_IDS` / `SLACK_BOT_*_TOKEN` mode in `.env.example`), create one Slack app per bot from the same manifest. Tweak `display_information.name`, `features.bot_user.display_name`, and `features.assistant_view.assistant_description` per bot so each shows up distinctly in the AI Apps picker.

## Verifying it worked

After install, open Slack and:

- The bot should appear under **Apps → AI Apps** in the left sidebar.
- Clicking it opens a dedicated assistant pane with your three suggested prompts.
- Sending a message shows the rotating "is thinking…" status below the input.
- The reply renders rich markdown (lists, code blocks, links) instead of escaped `*literal asterisks*`.
- Replies stream in with Slack's native AI "generating" treatment, and the agent's intermediate tool activity renders as a task timeline panel on the message (the same UI Cursor/CodeRabbit use) — not a regular message whose text gets edited over and over. This works in the assistant pane and in channel threads where the bot was mentioned; the only places that still fall back to plain messages are un-threaded sends with no one to attribute the run to (e.g. scheduled task output posted top-level into a channel).

If any of those are missing, check the bot's OAuth scopes page — Slack silently drops events the bot isn't scoped for.
