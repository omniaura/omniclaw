#!/bin/bash
# Build the OmniClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Use CONTAINER_CMD from env, or auto-detect (prefer 'container' CLI, fall back to 'docker')
if [ -z "$CONTAINER_CMD" ]; then
    if command -v container &>/dev/null; then
        CONTAINER_CMD="container"
    elif command -v docker &>/dev/null; then
        CONTAINER_CMD="docker"
    else
        echo "Error: neither 'container' nor 'docker' found in PATH"
        exit 1
    fi
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
