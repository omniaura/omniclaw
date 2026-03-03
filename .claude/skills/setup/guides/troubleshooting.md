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
npm run auth   # re-authenticate
bun run build && launchctl kickstart -k gui/$(id -u)/com.omniclaw
```

## Auto-update not running

Check `logs/auto-update.log`. Verify the launchd job is loaded:
```bash
launchctl list | grep omniclaw.autoupdate
```

If missing: re-run step 10b of fresh install, or load manually:
```bash
launchctl load ~/Library/LaunchAgents/com.omniclaw.autoupdate.plist
```

Test the script directly:
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
