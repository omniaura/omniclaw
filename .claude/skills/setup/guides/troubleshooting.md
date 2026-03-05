# Troubleshooting Guide

## Service not starting

Check `logs/omniclaw.error.log`. Common causes:
- Wrong Node/bun path in plist → re-run step 10 of fresh install
- Missing `.env` → re-run step 4
- Missing WhatsApp auth → re-run step 5

## Container agent fails ("Claude Code process exited with code 1")

Ensure container runtime is running:
- Apple Container: `container system start`
- Docker: `open -a Docker`

Check container logs: `groups/main/logs/container-*.log`

## No response to messages

- Verify the trigger pattern matches (main channel / personal / solo chats don't need a prefix)
- Check registered JID: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
- Check `logs/omniclaw.log`

## Messages sent but not received (DMs)

WhatsApp may use LID (Linked Identity) JIDs. Check logs for LID translation. Verify registered JID has no device suffix — should be `number@s.whatsapp.net`, not `number:0@s.whatsapp.net`.

## WhatsApp disconnected

```bash
bun run auth   # re-authenticate
bun run build && launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

## Auto-update not running

Check `logs/auto-update.log`. Then verify the scheduler is loaded:

**macOS:**
```bash
launchctl list | grep omniclaw.autoupdate
# If missing, load it:
launchctl load ~/Library/LaunchAgents/com.omniclaw.autoupdate.plist
```

**Linux:**
```bash
systemctl --user status omniclaw-autoupdate.timer
systemctl --user list-timers | grep omniclaw
# If missing, re-enable:
systemctl --user enable --now omniclaw-autoupdate.timer
# To trigger immediately:
systemctl --user start omniclaw-autoupdate.service
```

If the scheduler is missing entirely: re-run step 10b of fresh install.

Test the script directly (both platforms):
```bash
bash container/auto-update.sh
```

## Useful commands

```bash
# Unload service
launchctl unload ~/Library/LaunchAgents/com.omniclaw.plist

# Restart service
launchctl kickstart -k gui/$(id -u)/com.omniclaw

# Tail main log
tail -f logs/omniclaw.log

# Tail auto-update log
tail -f logs/auto-update.log
```
