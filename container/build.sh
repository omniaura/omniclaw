#!/bin/bash
# Build the OmniClaw agent container image with Docker (OrbStack on macOS).
#
# Apple Container was removed in the OrbStack migration — see PR notes for why
# (kernel panics + 619 GB of orphaned snapshot storage on the reference host).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# CONTAINER_CMD override is kept for backwards compat in case someone has it
# pinned in their environment, but the only supported value is 'docker'.
CONTAINER_CMD="${CONTAINER_CMD:-docker}"
if [ "$CONTAINER_CMD" != "docker" ]; then
    echo "Warning: CONTAINER_CMD=$CONTAINER_CMD is not supported. Forcing 'docker'."
    CONTAINER_CMD="docker"
fi

if ! command -v "$CONTAINER_CMD" &>/dev/null; then
    echo "Error: 'docker' not found in PATH."
    echo "On macOS: install OrbStack via 'brew install --cask orbstack' and open OrbStack.app once."
    echo "On Linux: install Docker (curl -fsSL https://get.docker.com | sh) and start the daemon."
    exit 1
fi

if ! "$CONTAINER_CMD" info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running."
    echo "On macOS: open OrbStack.app (or Docker Desktop) and wait for it to start."
    echo "On Linux: sudo systemctl start docker"
    exit 1
fi

BASE_IMAGE_NAME="omniclaw-agent-base"
IMAGE_NAME="omniclaw-agent"
TAG="${1:-latest}"

echo "Building OmniClaw agent base image (using $CONTAINER_CMD)..."
echo "Image: ${BASE_IMAGE_NAME}:${TAG}"

$CONTAINER_CMD build -t "${BASE_IMAGE_NAME}:${TAG}" -f Dockerfile.base .

echo ""
echo "Building OmniClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
$CONTAINER_CMD build -t "${IMAGE_NAME}:${TAG}" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE_NAME}:${TAG}" \
    -f Dockerfile .

echo ""
echo "Build complete!"
echo "Base image: ${BASE_IMAGE_NAME}:${TAG}"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | $CONTAINER_CMD run -i ${IMAGE_NAME}:${TAG}"
