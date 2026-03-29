# OmniClaw Agent Container
# Thin app layer on top of the shared OmniClaw agent base image.

ARG BASE_IMAGE=omniclaw-agent-base:latest
FROM ${BASE_IMAGE}

# Copy package files first for better caching
COPY agent-runner/package.json agent-runner/bun.lock* ./

# Install dependencies
RUN bun install

# Copy source code
COPY agent-runner/ ./

# Copy entrypoint scripts
# entrypoint.sh: legacy per-VM mode (sources env, configures git, buffers stdin, runs agent-runner)
# shared-entrypoint.sh: shared VM mode (minimal setup, sleeps forever)
# agent-exec.sh: per-agent wrapper for shared VM mode (invoked via container exec)
COPY entrypoint.sh /app/entrypoint.sh
COPY shared-entrypoint.sh /app/shared-entrypoint.sh
COPY agent-exec.sh /app/agent-exec.sh
RUN chmod +x /app/entrypoint.sh /app/shared-entrypoint.sh /app/agent-exec.sh

# Install bash shim for split-execution mode.
# Renames real bash to bash.real, installs shim at /usr/local/bin/bash.
# PATH has /usr/local/bin before /bin, so agent runtimes get the shim.
# The shim is a no-op unless EXEC_CONTAINER_NAME env var is set.
# Entrypoint uses #!/bin/bash.real to bypass the shim.
COPY exec-shim.sh /usr/local/bin/exec-shim.sh
RUN chmod +x /usr/local/bin/exec-shim.sh \
    && cp /bin/bash /bin/bash.real \
    && ln -sf /usr/local/bin/exec-shim.sh /usr/local/bin/bash

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
