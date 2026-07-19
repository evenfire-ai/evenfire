#!/usr/bin/env bash
# ======================================================================
# Generate JWT Signing Keys for Minikube
# ======================================================================
#
# Creates RSA-4096 key pairs for:
#   1. WRC signing (workflow coordinator <-> mcp_host <-> WRC)
#   2. Session JWT (control-api sessions)
#   3. RPC JWT (rpc-proxy authentication)
#   4. Admin JWT (control-ui admin authentication)
#   5. OAuth state HMAC and encryption secrets used by control-api
#   6. Control UI public token CSRF secret
#   7. Approval prompt-history encryption key used by governed tracing
#
# Writes generated keys into deploy/minikube/secrets/jwt-signing-keys.yaml
# and applies them to the cluster.
#
# Usage:
#   ./scripts/minikube/generate-keys.sh [--apply]
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[GENERATE-KEYS]${NC} $*"; }
ok()  { echo -e "${GREEN}  OK${NC} — $*"; }

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

ensure_control_ui_secret() {
  if $KC get secret control-ui-secrets -n control-plane >/dev/null 2>&1; then
    ok "control-ui-secrets already exists"
    return
  fi

  local csrf_secret="${CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET:-$(openssl rand -hex 32)}"
  log "Creating control-ui-secrets..."
  $KC create secret generic control-ui-secrets \
    --namespace=control-plane \
    --from-literal="CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET=${csrf_secret}" \
    --dry-run=client -o yaml | $KC apply -f -
  ok "control-ui-secrets created"
}

ensure_prompt_history_encryption_key() {
  local present key encoded patch_file
  present=$($KC get secret control-api-secrets -n control-plane \
    -o go-template='{{if index .data "TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY"}}present{{end}}' \
    2>/dev/null || true)
  if [ "$present" = "present" ]; then
    ok "tracing approval prompt-history encryption key already exists"
    return
  fi

  log "Adding missing tracing approval prompt-history encryption key..."
  key=$(openssl rand -hex 32)
  encoded=$(printf '%s' "$key" | base64 | tr -d '\n')
  patch_file="$TMPDIR/control-api-prompt-history-key-patch.json"
  (umask 077; printf '{"data":{"TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY":"%s"}}' \
    "$encoded" > "$patch_file")
  $KC patch secret control-api-secrets -n control-plane \
    --type=merge --patch-file="$patch_file" >/dev/null
  rm -f "$patch_file"
  unset key encoded
  ok "tracing approval prompt-history encryption key added"
}

# ── ANTI-PATTERN GUARD ──────────────────────────────────────────────────
# Generating NEW keys invalidates ALL existing JWT tokens and breaks
# admin login (password hash was signed with old key). Only generate
# keys if the Secret does NOT already exist in the cluster.
# ───────────────────────────────────────────────────────────────────────
EXISTING_SECRET=$($KC get secret control-api-secrets -n control-plane -o name 2>/dev/null || true)
if [ -n "$EXISTING_SECRET" ] && [ "${FORCE_REGEN:-}" != "true" ]; then
  log "JWT signing keys already exist in cluster (control-api-secrets)."
  log "Skipping key generation to preserve existing tokens and sessions."
  ensure_prompt_history_encryption_key
  ensure_control_ui_secret
  log "To force regeneration: FORCE_REGEN=true ./scripts/minikube/generate-keys.sh"
  # Extract existing keys from cluster for the yaml manifest
  for name in wrc session rpc admin; do
    KEY_MAP_PRIVATE=("wrc:CLERUM_WRC_SIGNING_KEY" "session:CONTROL_API_SESSION_JWT_PRIVATE_KEY" "rpc:CONTROL_API_RPC_JWT_PRIVATE_KEY" "admin:CONTROL_API_ADMIN_JWT_PRIVATE_KEY")
    # We still need to generate the yaml, so read from existing secrets or skip
    :
  done
  ok "Using existing keys (no regeneration)"
  exit 0
fi

# Generate 4 RSA-4096 key pairs (only on first run or FORCE_REGEN=true)
KEY_NAMES=("wrc" "session" "rpc" "admin")
for name in "${KEY_NAMES[@]}"; do
  log "Generating RSA-4096 key pair: ${name}..."
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$TMPDIR/${name}-private.pem" 2>/dev/null
  openssl rsa -in "$TMPDIR/${name}-private.pem" -pubout -out "$TMPDIR/${name}-public.pem" 2>/dev/null
  ok "${name} key pair generated"
done

# Bcrypt hash of "changeme123!" (cost 12) — matches DEV_ADMIN_PASSWORD_HASH in control-api/src/config.ts
log "Generating admin bootstrap password hash..."
ADMIN_HASH='$2b$12$9QdfGGp5KYg8osGa1n0.DuwQiB1RopCWIDJhmsuK4ygjTmIT8pvgy'
log "Generating OAuth state HMAC and encryption keys..."
OAUTH_STATE_HMAC_SECRET=$(openssl rand -hex 32)
OAUTH_ENCRYPTION_KEY=$(openssl rand -hex 32)
log "Generating tracing approval prompt-history encryption key..."
TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY=$(openssl rand -hex 32)
log "Generating Control UI public token CSRF secret..."
CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET=$(openssl rand -hex 32)

# Write the jwt-signing-keys.yaml manifest
OUTPUT="${PROJECT_DIR}/deploy/minikube/secrets/jwt-signing-keys.yaml"
mkdir -p "$(dirname "$OUTPUT")"
log "Writing ${OUTPUT}..."

WRC_PRIVATE=$(cat "$TMPDIR/wrc-private.pem")
WRC_PUBLIC=$(cat "$TMPDIR/wrc-public.pem")
SESSION_PRIVATE=$(cat "$TMPDIR/session-private.pem")
SESSION_PUBLIC=$(cat "$TMPDIR/session-public.pem")
RPC_PRIVATE=$(cat "$TMPDIR/rpc-private.pem")
RPC_PUBLIC=$(cat "$TMPDIR/rpc-public.pem")
ADMIN_PRIVATE=$(cat "$TMPDIR/admin-private.pem")
ADMIN_PUBLIC=$(cat "$TMPDIR/admin-public.pem")

cat > "$OUTPUT" <<YAMLEOF
# AUTO-GENERATED by scripts/minikube/generate-keys.sh — do not edit manually
apiVersion: v1
kind: Secret
metadata:
  name: clerum-wrc-signing-key
  namespace: control-plane
type: Opaque
stringData:
  private.pem: |
$(echo "$WRC_PRIVATE" | sed 's/^/    /')
  public.pem: |
$(echo "$WRC_PUBLIC" | sed 's/^/    /')
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: clerum-wrc-public-key
  namespace: control-plane
data:
  CLERUM_WRC_SIGNING_PUBLIC_KEY: |
$(echo "$WRC_PUBLIC" | sed 's/^/    /')
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: clerum-wrc-public-key
  namespace: sandbox-recipes
data:
  CLERUM_WRC_SIGNING_PUBLIC_KEY: |
$(echo "$WRC_PUBLIC" | sed 's/^/    /')
---
# control-api public key — used by WRC to verify delegation JWTs (iss=control-api)
# for artifact download/delete operations. Derived from the admin JWT private key.
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-public-key
  namespace: control-plane
data:
  CONTROL_API_PUBLIC_KEY_PEM: |
$(echo "$ADMIN_PUBLIC" | sed 's/^/    /')
---
apiVersion: v1
kind: Secret
metadata:
  name: control-api-secrets
  namespace: control-plane
type: Opaque
stringData:
  CONTROL_API_SESSION_JWT_PRIVATE_KEY: |
$(echo "$SESSION_PRIVATE" | sed 's/^/    /')
  CONTROL_API_RPC_JWT_PRIVATE_KEY: |
$(echo "$RPC_PRIVATE" | sed 's/^/    /')
  CONTROL_API_ADMIN_JWT_PRIVATE_KEY: |
$(echo "$ADMIN_PRIVATE" | sed 's/^/    /')
  CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH: "${ADMIN_HASH}"
  CONTROL_API_OAUTH_STATE_HMAC_SECRET: "${OAUTH_STATE_HMAC_SECRET}"
  CONTROL_API_OAUTH_ENCRYPTION_KEY: "${OAUTH_ENCRYPTION_KEY}"
  TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY: "${TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY}"
---
apiVersion: v1
kind: Secret
metadata:
  name: control-ui-secrets
  namespace: control-plane
type: Opaque
stringData:
  CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET: "${CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET}"
---
apiVersion: v1
kind: Secret
metadata:
  name: external-rest-api-secrets
  namespace: profiles
type: Opaque
stringData:
  EXTERNAL_REST_API_JWT_PUBLIC_KEY: |
$(echo "$SESSION_PUBLIC" | sed 's/^/    /')
---
apiVersion: v1
kind: Secret
metadata:
  name: rpc-proxy-secrets
  namespace: rpc-proxy
type: Opaque
stringData:
  RPC_PROXY_JWT_PUBLIC_KEY: |
$(echo "$RPC_PUBLIC" | sed 's/^/    /')
  RPC_PROXY_CONTROL_API_SERVICE_TOKEN: "minikube-rpc-proxy-service-token"
YAMLEOF

ok "jwt-signing-keys.yaml written"

# Apply if --apply flag is provided
if [[ "${1:-}" == "--apply" ]]; then
  log "Applying secrets to cluster..."
  $KC apply -f "$OUTPUT"
  ok "Secrets applied to cluster"
fi

log "Done. Key pairs generated and written to deploy/minikube/secrets/jwt-signing-keys.yaml"
