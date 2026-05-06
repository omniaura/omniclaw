#!/usr/bin/env bash
set -euo pipefail

# Installs gitcrawl into the agent image and enables its gh-compatible shim.
# The real GitHub CLI remains at /usr/bin/gh and is used by gitcrawl for
# unsupported or mutating commands.

GITCRAWL_VERSION="${GITCRAWL_VERSION:-v0.2.1}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
REAL_GH_PATH="${GITCRAWL_GH_PATH:-/usr/bin/gh}"

if [ ! -x "$REAL_GH_PATH" ]; then
  echo "gitcrawl shim requires real gh at $REAL_GH_PATH" >&2
  exit 1
fi

tmp_gobin="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_gobin"
}
trap cleanup EXIT

GOBIN="$tmp_gobin" go install "github.com/openclaw/gitcrawl/cmd/gitcrawl@${GITCRAWL_VERSION}"

install -m 0755 "$tmp_gobin/gitcrawl" "$INSTALL_DIR/gitcrawl"
ln -sf "$INSTALL_DIR/gitcrawl" "$INSTALL_DIR/gitcrawl-gh"
ln -sf "$INSTALL_DIR/gitcrawl" "$INSTALL_DIR/gh"

"$INSTALL_DIR/gitcrawl" --version
