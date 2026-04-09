#!/bin/sh
set -eu

REAL_BIN="/usr/local/bin/agent-browser-real"
SYSTEM_CHROMIUM="/usr/bin/chromium"

# Chrome for Testing is not published for Linux ARM64, so force agent-browser
# onto the distro Chromium package when present.
if [ -x "$SYSTEM_CHROMIUM" ] && [ "$(uname -m)" = "aarch64" ]; then
  exec "$REAL_BIN" --executable-path "$SYSTEM_CHROMIUM" "$@"
fi

exec "$REAL_BIN" "$@"
