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
ENV_ARGS=()
for var in HOME PATH TZ NODE_OPTIONS GOMEMLIMIT GOPATH CGO_ENABLED \
           PLAYWRIGHT_BROWSERS_PATH GITHUB_TOKEN GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL; do
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
