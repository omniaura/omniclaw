#!/bin/bash.real
# exec-shim.sh — Transparently proxies bash invocations to an execution sidecar container.
#
# When EXEC_CONTAINER_NAME is set, all `bash -c "..."` calls are routed to the
# execution container via `docker exec`. This separates heavy workloads (builds,
# browsers, tests) from the agent runtime to prevent resource starvation.
#
# When EXEC_CONTAINER_NAME is unset, falls back to real bash (no-op shim).
# Installed at /usr/local/bin/bash to shadow /bin/bash via PATH priority.

REAL_BASH="/bin/bash.real"
EXEC_RUNTIME="${EXEC_RUNTIME:-docker}"
REQUEST_DIR="${EXEC_BROKER_REQUEST_DIR:-/workspace/ipc/exec-requests}"
RESPONSE_DIR="${EXEC_BROKER_RESPONSE_DIR:-/workspace/ipc/exec-responses}"
FORWARD_VARS=(
  HOME
  PATH
  TZ
  NODE_OPTIONS
  GOMEMLIMIT
  GOPATH
  CGO_ENABLED
  PLAYWRIGHT_BROWSERS_PATH
  GH_TOKEN
  GITHUB_TOKEN
  GIT_AUTHOR_NAME
  GIT_AUTHOR_EMAIL
)

# No exec container configured — passthrough to real bash
if [ -z "$EXEC_CONTAINER_NAME" ]; then
  exec "$REAL_BASH" "$@"
fi

# Interactive/login shells and no-arg invocations stay local (entrypoint, etc.)
if [ $# -eq 0 ]; then
  exec "$REAL_BASH" "$@"
fi

# Build env forwarding flags for the exec container.
# Forward key variables so the execution environment matches the agent's.
if [ "$EXEC_RUNTIME" = "docker" ]; then
  ENV_ARGS=()
  for var in "${FORWARD_VARS[@]}"; do
    if [ -n "${!var+x}" ]; then
      ENV_ARGS+=("-e" "${var}=${!var}")
    fi
  done

  # Route to execution container via docker exec.
  # -i preserves stdin for piped commands.
  # -w forwards the working directory so relative paths resolve correctly.
  exec docker exec -i \
    -w "$(pwd)" \
    "${ENV_ARGS[@]}" \
    "$EXEC_CONTAINER_NAME" \
    "$REAL_BASH" "$@"
fi

if [ "$EXEC_RUNTIME" != "apple-container" ]; then
  exec "$REAL_BASH" "$@"
fi

mkdir -p "$REQUEST_DIR" "$RESPONSE_DIR"

REQUEST_ID="exec-$(date +%s)-$$-$(head -c4 /dev/urandom | od -An -tu4 | tr -d ' ')"
REQUEST_FILE="$REQUEST_DIR/$REQUEST_ID.json"
REQUEST_TMP="$REQUEST_FILE.tmp"
STDOUT_FILE="$RESPONSE_DIR/$REQUEST_ID.stdout"
STDERR_FILE="$RESPONSE_DIR/$REQUEST_ID.stderr"
EXITCODE_FILE="$RESPONSE_DIR/$REQUEST_ID.exitcode"

FORWARD_VARS_CSV=$(IFS=,; echo "${FORWARD_VARS[*]}")
export FORWARD_VARS_CSV

bun -e '
const fs = require("fs");
const [requestFile, requestId, cwd, ...args] = process.argv.slice(1);
const env = {};
for (const key of (process.env.FORWARD_VARS_CSV || "").split(",")) {
  if (!key) continue;
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    env[key] = process.env[key] ?? "";
  }
}
fs.writeFileSync(
  requestFile,
  JSON.stringify({ id: requestId, cwd, args, env }) + "\n",
);
' "$REQUEST_TMP" "$REQUEST_ID" "$(pwd)" "$@"
mv "$REQUEST_TMP" "$REQUEST_FILE"

while [ ! -f "$EXITCODE_FILE" ]; do
  sleep 0.05
done

if [ -f "$STDOUT_FILE" ]; then
  cat "$STDOUT_FILE"
fi
if [ -f "$STDERR_FILE" ]; then
  cat "$STDERR_FILE" >&2
fi

EXIT_CODE=$(cat "$EXITCODE_FILE" 2>/dev/null || echo 125)
rm -f "$REQUEST_FILE" "$STDOUT_FILE" "$STDERR_FILE" "$EXITCODE_FILE"
exit "$EXIT_CODE"
