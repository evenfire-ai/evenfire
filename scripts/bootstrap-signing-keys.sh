#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Bootstrap WRC Signing Keys
# ═══════════════════════════════════════════════════════════════════════
#
# Creates the RSA-4096 key pair used by WRC to sign JWT tokens for
# workflow coordinator ↔ mcp_host ↔ WRC communication.
#
# Idempotent: if the Secret already exists, does nothing.
#
# Objects created:
#   - Secret  clerum-wrc-signing-key   (control-plane) — private + public PEM
#   - ConfigMap clerum-wrc-public-key   (control-plane) — public PEM only
#
# Usage:
#   ./scripts/bootstrap-signing-keys.sh [--profile clerum-test]
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

PROFILE="${1:-clerum-test}"
NAMESPACE="control-plane"
SECRET_NAME="clerum-wrc-signing-key"
CONFIGMAP_NAME="clerum-wrc-public-key"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[SIGNING-KEYS]${NC} $*"; }
warn() { echo -e "${YELLOW}[SIGNING-KEYS]${NC} $*"; }

# Check if Secret already exists
if kubectl --context="$PROFILE" get secret "$SECRET_NAME" -n "$NAMESPACE" &>/dev/null; then
  warn "Secret '$SECRET_NAME' already exists in $NAMESPACE — skipping key generation"
  exit 0
fi

log "Generating RSA-4096 key pair..."
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$TMPDIR/private.pem" 2>/dev/null
openssl rsa -in "$TMPDIR/private.pem" -pubout -out "$TMPDIR/public.pem" 2>/dev/null

log "Creating Secret '$SECRET_NAME' in $NAMESPACE..."
kubectl --context="$PROFILE" create secret generic "$SECRET_NAME" \
  --namespace="$NAMESPACE" \
  --from-file=private.pem="$TMPDIR/private.pem" \
  --from-file=public.pem="$TMPDIR/public.pem"

log "Creating ConfigMap '$CONFIGMAP_NAME' in $NAMESPACE..."
kubectl --context="$PROFILE" create configmap "$CONFIGMAP_NAME" \
  --namespace="$NAMESPACE" \
  --from-file=public.pem="$TMPDIR/public.pem"

log "Done. Key pair created and stored."
