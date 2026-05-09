#!/usr/bin/env bash
set -euo pipefail

# Installs discrawl into the agent image so agents can query or sync local
# Discord archives from the same tool surface used by the host.

DISCRAWL_VERSION="${DISCRAWL_VERSION:-v0.7.0}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

tmp_gobin="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_gobin"
}
trap cleanup EXIT

GOBIN="$tmp_gobin" go install "github.com/openclaw/discrawl/cmd/discrawl@${DISCRAWL_VERSION}"

install -m 0755 "$tmp_gobin/discrawl" "$INSTALL_DIR/discrawl"

"$INSTALL_DIR/discrawl" --version
