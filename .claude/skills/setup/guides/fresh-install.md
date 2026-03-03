# OmniClaw Fresh Install Guide

Run setup scripts automatically. Only pause when user action is required (WhatsApp authentication, configuration choices). Scripts live in `.claude/skills/setup/scripts/` and emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

> **Upgrading an existing multi-agent Discord/Slack setup?** Run `/migrate-to-channels` first.

## 1. Check Environment

Run `./.claude/skills/setup/scripts/01-check-environment.sh` and parse the status block.

- If HAS_AUTH=true → note that WhatsApp auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record PLATFORM, APPLE_CONTAINER, and DOCKER values for step 3

**If NODE_OK=false:** Ask user if they'd like you to install it:
- macOS: `brew install node@22` or nvm → `nvm install 22`
- Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`

Install brew/nvm first if needed. Re-run environment check after to confirm NODE_OK=true.

## 2. Install Dependencies

Run `./.claude/skills/setup/scripts/02-install-deps.sh` and parse the status block.

**If failed:** Read `logs/setup.log` tail. Common fixes:
1. Delete `node_modules` and `package-lock.json`, re-run
2. Permission errors: suggest corrected permissions
3. Native module build fail: install `xcode-select --install` (macOS) or `build-essential` (Linux), retry

## 2b. Database Schema

Schema + migrations run automatically on service startup via `initDatabase()`. No action needed — just ensure `bun run build` succeeds. If startup fails with DB errors, check `logs/omniclaw.error.log`.

## 3. Container Runtime

Use environment check results:

- PLATFORM=linux → Docker. If source references Apple Container, run `/convert-to-docker` first.
- PLATFORM=macos + APPLE_CONTAINER=installed → apple-container
- PLATFORM=macos + DOCKER=running + APPLE_CONTAINER=not_found → Docker, run `/convert-to-docker` if needed
- PLATFORM=macos + DOCKER=installed_not_running → `open -a Docker`, wait 15s, re-check
- Neither → AskUserQuestion: Apple Container (recommended for macOS) vs Docker?
  - Docker: install then run `/convert-to-docker`
  - Apple Container: download from https://github.com/apple/container/releases

Run `./.claude/skills/setup/scripts/03-setup-container.sh --runtime <chosen>` and parse.

**If BUILD_OK=false:** Check `logs/setup.log`.
- Cache issue: `container builder stop && container builder rm && container builder start` (Apple) or `docker builder prune -f` (Docker), retry.

**If TEST_OK=false but BUILD_OK=true:** Runtime not fully started. Wait and retry.

## 4. Claude Authentication

If HAS_ENV=true, check `.env` for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm to keep or reconfigure.

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user:
1. Open another terminal: `claude setup-token`
2. Copy the token
3. Add to `.env`: `CLAUDE_CODE_OAUTH_TOKEN=<token>`
4. Let you know when done

Do NOT ask user to paste the token into chat. Once confirmed, verify the key exists in `.env`.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`, confirm when done.

## 4b. GitHub Integration (Optional)

Ask: Do you want the agent to push branches and create pull requests?

If yes: user needs a classic GitHub token with `repo` scope from https://github.com/settings/tokens. Once they provide it, use the Write tool to append to `.env` (never echo tokens via shell). Optionally collect `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`.

## 5. WhatsApp Authentication

If HAS_AUTH=true, confirm to keep or re-authenticate.

AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method qr-browser` (timeout: 150000ms)
- **Pairing code:** Ask for phone number first (country code, no + or spaces). `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method pairing-code --phone NUMBER` (timeout: 150000ms). Display PAIRING_CODE.
- **QR terminal:** Run script, tell user to run `cd PROJECT_PATH && npm run auth` in another terminal.

If AUTH_STATUS=already_authenticated → skip ahead.

**If failed:**
- qr_timeout → Re-run auth script automatically for fresh QR
- logged_out → Delete `store/auth/` and re-run
- 515 → Stream error; re-run if it persists
- timeout → Ask if they scanned/entered the code, offer to retry

## 6. Configure Trigger and Channel Type

Get bot's WhatsApp number: `node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Does the bot share your personal WhatsApp number, or does it have its own dedicated number?

AskUserQuestion: What trigger word? (default: Andy)

AskUserQuestion: Main channel type?

**Shared number:** Self-chat (recommended) or Solo group (just you).

**Dedicated number:** DM with the bot (recommended) or Solo group with the bot.

## 7. Sync and Select Group (If Group Channel)

**Personal chat / DM:** Construct JID as `NUMBER@s.whatsapp.net`.

**Group:**
1. `./.claude/skills/setup/scripts/05-sync-groups.sh` (timeout: 60000ms)
2. If BUILD=failed: fix TS error, re-run
3. If GROUPS_IN_DB=0: check `logs/setup.log` — auth expired or timeout
4. `./.claude/skills/setup/scripts/05b-list-groups.sh` — do NOT show raw output to user
5. Present likely candidates (groups with trigger word or "OmniClaw" in name) as AskUserQuestion

## 8. Register Channel

`./.claude/skills/setup/scripts/06-register-channel.sh` with:
- `--jid "JID"`
- `--name "main"`
- `--trigger "@TriggerWord"`
- `--folder "main"`
- `--no-trigger-required` (if personal chat, DM, or solo group)
- `--assistant-name "Name"` (if trigger differs from "Andy")

## 9. Mount Allowlist

AskUserQuestion: Want the agent to access directories outside OmniClaw? (Git repos, project folders, etc.)

**No:** `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty`

**Yes:** Collect paths + permissions. Build JSON and pipe to script:
`echo '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}' | ./.claude/skills/setup/scripts/07-configure-mounts.sh`

## 10. Start Service

Check if already running and unload if so:
- **macOS:** `launchctl list | grep omniclaw` — if running, `launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist`
- **Linux:** `systemctl --user is-active --quiet omniclaw` — if running, `systemctl --user stop omniclaw && systemctl --user disable omniclaw`

Run `./.claude/skills/setup/scripts/08-setup-service.sh` and parse.

**If SERVICE_LOADED=false:** Check `logs/setup.log`. Common fix: old plist loaded. Unload it, re-run. If crashing: check `logs/omniclaw.error.log` for crash reason (wrong Node path, missing .env, missing auth). On Linux: `systemctl --user status omniclaw`.

## 10b. Auto-Updates (Optional)

AskUserQuestion: Do you want OmniClaw to automatically update itself nightly?

When enabled, `container/auto-update.sh` runs nightly at 3 AM. It fetches `origin/main`, exits immediately if already up to date, otherwise rebuilds host + container, waits up to 10 min for agents to go idle, then restarts.

**macOS — if yes:**

```bash
REPO_DIR=$(pwd)
BUN_PATH=$(which bun || echo "$HOME/.bun/bin/bun")
BUN_DIR=$(dirname "$BUN_PATH")
```

Write `~/Library/LaunchAgents/com.omniclaw.autoupdate.plist` (replacing REPO_DIR, HOME_DIR, BUN_DIR with actual paths):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>com.omniclaw.autoupdate</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>REPO_DIR/container/auto-update.sh</string>
	</array>
	<key>WorkingDirectory</key><string>REPO_DIR</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key><string>HOME_DIR</string>
		<key>PATH</key><string>BUN_DIR:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
	<key>StandardOutPath</key><string>REPO_DIR/logs/auto-update.log</string>
	<key>StandardErrorPath</key><string>REPO_DIR/logs/auto-update.log</string>
	<key>RunAtLoad</key><false/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.omniclaw.autoupdate.plist
launchctl list | grep omniclaw.autoupdate   # '-' PID is correct
```

**Linux — if yes:**

Write `~/.config/systemd/user/omniclaw-autoupdate.service` and `omniclaw-autoupdate.timer`, then:
```bash
systemctl --user daemon-reload
systemctl --user enable --now omniclaw-autoupdate.timer
```

**If no:** Skip. Run `bash container/auto-update.sh` manually anytime.

Logs: `logs/auto-update.log`

## 11. Verify

Run `./.claude/skills/setup/scripts/09-verify.sh` and parse.

**Fix each failure:**
- SERVICE=stopped → `bun run build`, then `launchctl kickstart -k gui/$(id -u)/com.omniclaw` (macOS) or `systemctl --user restart omniclaw` (Linux). Re-check.
- SERVICE=not_found → re-run step 10
- CREDENTIALS=missing → re-run step 4
- WHATSAPP_AUTH=not_found → re-run step 5
- REGISTERED_GROUPS=0 → re-run steps 7-8
- MOUNT_ALLOWLIST=missing → `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty`

Re-run `09-verify.sh` after fixes to confirm all pass.

Tell user to test: send a message in their registered chat. Log tail: `tail -f logs/omniclaw.log`

## Discord Agent Setup (Optional)

See [advanced-setup.md](advanced-setup.md) for adding a Discord agent bot.
