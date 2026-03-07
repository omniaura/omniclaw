# OmniClaw Auto-Update

## Quick Update

```bash
./container/auto-update.sh
```

The script checks for upstream changes, pulls, rebuilds the host app + container image, waits for active agents to finish (up to 10 min), then restarts the service.

## Manual Update

```bash
git pull origin main
bun run build
./container/build.sh
# Restart service:
launchctl kickstart -k gui/$(id -u)/com.omniclaw   # macOS
systemctl --user restart omniclaw                    # Linux
```

## Automated Updates

### macOS (launchd)

The setup skill (step 10b) creates `~/Library/LaunchAgents/com.omniclaw.autoupdate.plist` that runs nightly at 3 AM.

```bash
# Check status
launchctl list | grep omniclaw.autoupdate

# Load/unload
launchctl load ~/Library/LaunchAgents/com.omniclaw.autoupdate.plist
launchctl unload ~/Library/LaunchAgents/com.omniclaw.autoupdate.plist
```

### Linux (systemd timer)

The setup skill (step 10b) creates `~/.config/systemd/user/omniclaw-autoupdate.{service,timer}`.

```bash
# Check status
systemctl --user status omniclaw-autoupdate.timer
systemctl --user list-timers | grep omniclaw

# Enable/disable
systemctl --user enable --now omniclaw-autoupdate.timer
systemctl --user disable --now omniclaw-autoupdate.timer

# Trigger immediately
systemctl --user start omniclaw-autoupdate.service
```

## Safety Features

- Only updates if remote has newer commits
- Stashes local changes before pulling
- Waits for active agent containers to drain before restarting
- Exits on any error (`set -e`)
- Cannot run from inside a container

## Rollback

```bash
git log --oneline -5            # Find previous good commit
git checkout <commit> -- .      # Restore files
bun run build
./container/build.sh
# Restart service (see above)
```

## Logs

```bash
tail -f logs/auto-update.log
```

## Troubleshooting

- **Timer not firing:** Re-run `/setup` step 10b or check `systemctl --user list-timers` / `launchctl list`
- **Build fails:** Check `logs/auto-update.log`, ensure network connectivity for package downloads
- **Service not restarting:** Check disk space (`df -h`), verify service config
