#!/usr/bin/env bash
# Send a message to the Docker Compose quickstart mcp-host (dev mode).
# Usage:
#   ./scripts/dev/quickstart-chat.sh "Hello!"
#   MSG="What can you do?" ./scripts/dev/quickstart-chat.sh
set -euo pipefail

command -v python3 >/dev/null || { echo "quickstart-chat.sh needs python3 (used to JSON-escape the message)" >&2; exit 1; }

BASE_URL="${CLERUM_QUICKSTART_URL:-http://localhost:8080}"
CONTENT="${1:-${MSG:-Hello from evenfire quickstart}}"
HOST_REF="${CLERUM_QUICKSTART_HOST_REF:-dev-host}"
CHANNEL_ID="${CLERUM_QUICKSTART_CHANNEL_ID:-dev-channel}"
SENDER="${CLERUM_QUICKSTART_SENDER:-123456789}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MESSAGE_ID="msg-$(date +%s)-$$"

# The x-clerum-edge-* trust headers are the app-layer auth for direct mcp-host
# runtime routes in BOTH dev and production (the route rejects Authorization/JWTs).
# In production, NetworkPolicy restricts who can send them to the platform's own
# edge services (channel-reader / rpc-proxy); short-lived JWTs authenticate the
# hops INTO those edge services, not this hop.
curl -sS -X POST "${BASE_URL}/v1/runtime/messages" \
  -H "Content-Type: application/json" \
  -H "x-clerum-edge-caller: channel-reader" \
  -H "x-clerum-edge-host-ref: ${HOST_REF}" \
  -H "x-clerum-edge-channel-type: telegram" \
  -H "x-clerum-edge-channel-id: ${CHANNEL_ID}" \
  -H "x-clerum-edge-sender: ${SENDER}" \
  -d "$(cat <<EOF
{
  "content": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$CONTENT"),
  "channelType": "telegram",
  "channelId": "${CHANNEL_ID}",
  "sender": "${SENDER}",
  "timestamp": "${TIMESTAMP}",
  "messageId": "${MESSAGE_ID}",
  "hostRef": "${HOST_REF}"
}
EOF
)"
echo
