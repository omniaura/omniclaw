#!/bin/bash
# Build the OmniClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BASE_IMAGE_NAME="omniclaw-agent-base"
IMAGE_NAME="omniclaw-agent"
TAG="${1:-latest}"

echo "Building OmniClaw agent base image..."
echo "Image: ${BASE_IMAGE_NAME}:${TAG}"

# Build with Apple Container (context = container/)
container build -t "${BASE_IMAGE_NAME}:${TAG}" -f Dockerfile.base .

echo ""
echo "Building OmniClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
container build -t "${IMAGE_NAME}:${TAG}" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE_NAME}:${TAG}" \
    -f Dockerfile .

echo ""
echo "Build complete!"
echo "Base image: ${BASE_IMAGE_NAME}:${TAG}"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | container run -i ${IMAGE_NAME}:${TAG}"
