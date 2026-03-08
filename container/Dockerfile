# OmniClaw Agent Container
# Thin app layer on top of the shared OmniClaw agent base image.

ARG BASE_IMAGE=omniclaw-agent-base:latest
FROM ${BASE_IMAGE}

# Copy package files first for better caching
COPY container/agent-runner/package.json container/agent-runner/bun.lock* ./

# Install dependencies
RUN bun install

# Copy source code
COPY container/agent-runner/ ./

# Copy entrypoint script
# Sources env, configures git, pre-installs cross-platform deps for host mounts,
# buffers stdin, then runs agent-runner
COPY container/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
