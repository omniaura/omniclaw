# Migrating from NanoClaw to OmniClaw

This guide covers everything needed to migrate an existing NanoClaw installation to OmniClaw.

## Quick Path (Recommended)

Pull latest, open Claude Code in the project directory, and paste:

```
/setup migrate me from nanoclaw to omniclaw — see @docs/MIGRATING-TO-OMNICLAW.md
```

The setup skill will use this doc as instructions and handle everything automatically.

## Manual Migration

### 1. Pull Latest

```bash
git pull
```

### 2. Rebuild Container

The old `nanoclaw-agent:latest` image won't work — IPC markers changed from `NANOCLAW_OUTPUT_START/END` to `OMNICLAW_OUTPUT_START/END`. You must rebuild.

```bash
# Full cache bust (required — buildkit caches stale files)
container builder stop && container builder rm && container builder start
./container/build.sh
```

Verify the new image:
```bash
container run -i --rm --entrypoint wc omniclaw-agent:latest -l /app/src/index.ts
```

### 3. Migrate Config Directory

The mount-allowlist moved from `~/.config/nanoclaw/` to `~/.config/omniclaw/`.

```bash
mkdir -p ~/.config/omniclaw
cp ~/.config/nanoclaw/mount-allowlist.json ~/.config/omniclaw/mount-allowlist.json
```

### 4. Swap Launchd Service

Unload the old service and install the new one:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
rm ~/Library/LaunchAgents/com.nanoclaw.plist
just install
```

Or manually:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
cp launchd/com.omniclaw.plist ~/Library/LaunchAgents/com.omniclaw.plist
launchctl load ~/Library/LaunchAgents/com.omniclaw.plist
```

### 5. Update Runtime CLAUDE.md Files

The MCP tool names changed from `mcp__nanoclaw__*` to `mcp__omniclaw__*`. Runtime CLAUDE.md files (gitignored) still reference the old names.

**To preserve agent context** (goals, memory, conversation history), do an in-place rename:

```bash
sed -i '' 's/mcp__nanoclaw__/mcp__omniclaw__/g' groups/*/CLAUDE.md
```

**Or to start fresh**, delete them so they regenerate from updated templates on next agent run:

```bash
rm groups/*/CLAUDE.md
```

### 6. Update Environment Variables

Environment variable prefixes changed:

| Old | New |
|-----|-----|
| `NANOCLAW_BRANCH` | `OMNICLAW_BRANCH` |
| `NANOCLAW_SERVICE` | `OMNICLAW_SERVICE` |
| `NANOCLAW_IDLE_THRESHOLD` | `OMNICLAW_IDLE_THRESHOLD` |
| `NANOCLAW_MAX_WAIT` | `OMNICLAW_MAX_WAIT` |

**Backwards compatibility:** The old names still work as fallback in `auto-update.sh`. Update at your convenience.

Container-internal env vars (`OMNICLAW_CHANNELS`, etc.) are set automatically by the host — no manual changes needed.

### 7. Update Git Remote (After GitHub Repo Rename)

After the GitHub repo is renamed from `omniaura/nanoclaw` to `omniaura/omniclaw`:

```bash
git remote set-url origin https://github.com/omniaura/omniclaw.git
```

GitHub auto-redirects old URLs, so this isn't urgent but keeps things clean.

### 8. Clean Up

```bash
# Remove old container image
container rmi nanoclaw-agent:latest 2>/dev/null || true

# Remove old config directory (after confirming omniclaw config works)
rm -rf ~/.config/nanoclaw
```

## What Changed

- **IPC markers**: `NANOCLAW_OUTPUT_START/END` → `OMNICLAW_OUTPUT_START/END`
- **Container image**: `nanoclaw-agent:latest` → `omniclaw-agent:latest`
- **MCP server name**: `nanoclaw` → `omniclaw` (tool prefix: `mcp__omniclaw__*`)
- **Container env vars**: `NANOCLAW_*` → `OMNICLAW_*`
- **Launchd service**: `com.nanoclaw` → `com.omniclaw`
- **Config directory**: `~/.config/nanoclaw/` → `~/.config/omniclaw/`
- **Container names**: `nanoclaw-{group}-*` → `omniclaw-{group}-*`
- **Git author**: `NanoClaw Agent` → `OmniClaw Agent`

## Troubleshooting

**Agent output not appearing:** Host and container IPC markers must match. Rebuild both host (`bun run build`) and container (`./container/build.sh`).

**MCP tools not found:** Run `sed -i '' 's/mcp__nanoclaw__/mcp__omniclaw__/g' groups/*/CLAUDE.md` to update tool names in runtime files. The agent needs `mcp__omniclaw__*` in its allowedTools list.

**Launchd not starting:** Check `launchctl list | grep omniclaw` and verify the plist is installed at `~/Library/LaunchAgents/com.omniclaw.plist`.
