#!/usr/bin/env bash
set -euo pipefail

# Generate all JWT signing keys and secrets for Clerum auth chain.
# Works for any K8s cluster. By default uses the current kubectl context.
# Set CONTEXT=<kubeconfig-context> to pin every kubectl call explicitly
# (used by `make gcp-dev-gen-keys` / `make gcp-prod-gen-keys`).
#
# Creates:
#   1. 4 RSA-4096 key pairs (wrc, session, rpc, admin)
#   2. control-api-secrets (session/rpc/admin private keys + admin password hash)
#   3. rpc-proxy-secrets (RPC public key + desktop tokens)
#   4. external-rest-api-secrets (session public key)
#   5. control-postgres (DB credentials)
#   6. inter-service-tokens (placeholder tokens + desktop-api-token)
#   7. WRC signing key + configmaps
#   8. control-api-public-key ConfigMap (admin JWT public key for WRC verification)
# (#273: legacy clerum-channel-reader-credentials Secret retired — per-Host
#  channel-reader-<host>-credentials Secrets are written by control-api's
#  /admin/channel-secrets, not bootstrap-time.)

kctl() {
  if [ -n "${CONTEXT:-}" ]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== Generating 4 RSA-4096 key pairs ==="

for KEY_NAME in wrc session rpc admin; do
  echo "  Generating $KEY_NAME key pair..."
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$TMPDIR/${KEY_NAME}-private.pem" 2>/dev/null
  openssl rsa -in "$TMPDIR/${KEY_NAME}-private.pem" -pubout -out "$TMPDIR/${KEY_NAME}-public.pem" 2>/dev/null
done

echo "=== Generating desktop service token + cookie secret ==="
DESKTOP_API_TOKEN=$(openssl rand -hex 32)
DESKTOP_COOKIE_SECRET=$(openssl rand -hex 32)
SANDBOX_UI_COOKIE_SECRET=$(openssl rand -hex 32)
echo "  desktop-api-token, desktop + sandbox-ui cookie secrets generated."

echo "=== Generating control-ui public token CSRF secret ==="
CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET=$(openssl rand -hex 32)
echo "  control-ui public token CSRF secret generated."

echo "=== Generating control-api OAuth state HMAC + encryption key ==="
OAUTH_STATE_HMAC_SECRET=$(openssl rand -hex 32)
OAUTH_ENCRYPTION_KEY=$(openssl rand -hex 32)
echo "  oauth-state-hmac and oauth-encryption-key generated."

echo "=== Generating tracing approval prompt-history encryption key ==="
TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY=$(openssl rand -hex 32)
echo "  tracing prompt-history encryption key generated."

WRC_PRIVATE_KEY=$(cat "$TMPDIR/wrc-private.pem")
WRC_PUBLIC_KEY=$(cat "$TMPDIR/wrc-public.pem")
SESSION_PRIVATE_KEY=$(cat "$TMPDIR/session-private.pem")
SESSION_PUBLIC_KEY=$(cat "$TMPDIR/session-public.pem")
RPC_PRIVATE_KEY=$(cat "$TMPDIR/rpc-private.pem")
RPC_PUBLIC_KEY=$(cat "$TMPDIR/rpc-public.pem")
ADMIN_PRIVATE_KEY=$(cat "$TMPDIR/admin-private.pem")
ADMIN_PUBLIC_KEY=$(cat "$TMPDIR/admin-public.pem")

# Admin password hash — production must override via ADMIN_BOOTSTRAP_PASSWORD_HASH env var
# Default is a placeholder; minikube scripts set the real dev hash (changeme123!) separately.
ADMIN_HASH="${ADMIN_BOOTSTRAP_PASSWORD_HASH:-\$2b\$10\$minikubeTestHashPlaceholderForLocalDevelopmentOnly000}"

echo ""
if [ -n "${CONTEXT:-}" ]; then
  echo "=== Creating K8s secrets in context: $CONTEXT ==="
else
  echo "=== Creating K8s secrets in current context ==="
fi

# --- 1. control-api-secrets (control-plane namespace) ---
echo "  [1/11] control-api-secrets (control-plane)"
kctl create secret generic control-api-secrets \
  --namespace=control-plane \
  --from-literal="CONTROL_API_SESSION_JWT_PRIVATE_KEY=$SESSION_PRIVATE_KEY" \
  --from-literal="CONTROL_API_RPC_JWT_PRIVATE_KEY=$RPC_PRIVATE_KEY" \
  --from-literal="CONTROL_API_ADMIN_JWT_PRIVATE_KEY=$ADMIN_PRIVATE_KEY" \
  --from-literal="CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH=$ADMIN_HASH" \
  --from-literal="CONTROL_API_OAUTH_STATE_HMAC_SECRET=$OAUTH_STATE_HMAC_SECRET" \
  --from-literal="CONTROL_API_OAUTH_ENCRYPTION_KEY=$OAUTH_ENCRYPTION_KEY" \
  --from-literal="TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY=$TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 2. control-ui-secrets (control-plane namespace) ---
echo "  [2/11] control-ui-secrets (control-plane)"
kctl create secret generic control-ui-secrets \
  --namespace=control-plane \
  --from-literal="CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET=$CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 3. rpc-proxy-secrets (rpc-proxy namespace) ---
# NOTE: RPC_PROXY_CONTROL_API_SERVICE_TOKEN is intentionally omitted here. It
# is written by `deploy/scripts/apply-inter-service-tokens.sh` (kubectl patch)
# so it survives the CI `kubectl apply -k` three-way merge without wiping.
echo "  [3/11] rpc-proxy-secrets (rpc-proxy)"
kctl create secret generic rpc-proxy-secrets \
  --namespace=rpc-proxy \
  --from-literal="RPC_PROXY_JWT_PUBLIC_KEY=$RPC_PUBLIC_KEY" \
  --from-literal="RPC_PROXY_DESKTOP_API_TOKEN=$DESKTOP_API_TOKEN" \
  --from-literal="RPC_PROXY_DESKTOP_COOKIE_SECRET=$DESKTOP_COOKIE_SECRET" \
  --from-literal="RPC_PROXY_SANDBOX_UI_COOKIE_SECRET=$SANDBOX_UI_COOKIE_SECRET" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 4. external-rest-api-secrets (profiles namespace) ---
echo "  [4/11] external-rest-api-secrets (profiles)"
kctl create secret generic external-rest-api-secrets \
  --namespace=profiles \
  --from-literal="EXTERNAL_REST_API_JWT_PUBLIC_KEY=$SESSION_PUBLIC_KEY" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 5. control-postgres (control-plane namespace) ---
echo "  [5/11] control-postgres (control-plane)"
kctl create secret generic control-postgres \
  --namespace=control-plane \
  --from-literal="POSTGRES_DB=profiles" \
  --from-literal="POSTGRES_USER=postgres" \
  --from-literal="POSTGRES_PASSWORD=postgres" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 6. inter-service-tokens (control-plane namespace) ---
echo "  [6/11] inter-service-tokens (control-plane)"
kctl create secret generic inter-service-tokens \
  --namespace=control-plane \
  --from-literal="external-rest-api-token=replace-with-external-rest-api-token" \
  --from-literal="rpc-proxy-token=replace-with-rpc-proxy-token" \
  --from-literal="desktop-api-token=$DESKTOP_API_TOKEN" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 7. (retired) clerum-channel-reader-credentials ---
# The static `clerum-channel-reader-credentials` Secret used to be minted
# here with placeholder tokens for the legacy static channel-reader
# Deployment. With #273 retiring the static Deployment, channel credentials
# are now per-Host (`channel-reader-<host>-credentials`), written via
# control-api's `/admin/channel-secrets` from the Control UI. No
# placeholder Secret is needed at bootstrap.

# --- 8. WRC signing key (control-plane namespace) ---
# Code reads Secret keys as "private.pem" and "public.pem" via K8s API (k8sClient.ts:66)
echo "  [8/11] clerum-wrc-signing-key (control-plane)"
kctl create secret generic clerum-wrc-signing-key \
  --namespace=control-plane \
  --from-literal="private.pem=$WRC_PRIVATE_KEY" \
  --from-literal="public.pem=$WRC_PUBLIC_KEY" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 9. WRC public key ConfigMap (control-plane + sandbox-recipes) ---
echo "  [9/11] clerum-wrc-public-key ConfigMap (control-plane)"
kctl create configmap clerum-wrc-public-key \
  --namespace=control-plane \
  --from-literal="CLERUM_WRC_SIGNING_PUBLIC_KEY=$WRC_PUBLIC_KEY" \
  --dry-run=client -o yaml | kctl apply -f -

echo "  [10/11] clerum-wrc-public-key ConfigMap (sandbox-recipes)"
kctl create configmap clerum-wrc-public-key \
  --namespace=sandbox-recipes \
  --from-literal="CLERUM_WRC_SIGNING_PUBLIC_KEY=$WRC_PUBLIC_KEY" \
  --dry-run=client -o yaml | kctl apply -f -

# --- 10. control-api public key ConfigMap (control-plane) ---
# Exposes the admin JWT public key to WRC so it can verify delegation tokens
# (iss=control-api, aud=clerum-wrc) sent by control-api during artifact
# downloads. Mirror of the clerum-wrc-public-key pattern above — public keys
# need no secret protection, so a ConfigMap is used.
echo "  [11/11] control-api-public-key ConfigMap (control-plane)"
kctl create configmap control-api-public-key \
  --namespace=control-plane \
  --from-literal="CONTROL_API_PUBLIC_KEY_PEM=$ADMIN_PUBLIC_KEY" \
  --dry-run=client -o yaml | kctl apply -f -

echo ""
echo "=== All secrets and configmaps created ==="

# --- Auto-sync RPC public key to mcp-host-config ---
echo ""
echo "=== Syncing JWT public key to mcp-host-config ==="
if kctl get configmap mcp-host-config -n mcp-host >/dev/null 2>&1; then
  echo "  Patching existing mcp-host-config..."
  kctl get configmap mcp-host-config -n mcp-host -o json \
    | python3 -c "
import sys, json
cm = json.load(sys.stdin)
cm['data']['CLERUM_AUTH_JWT_PUBLIC_KEY'] = '''$RPC_PUBLIC_KEY'''
# Strip metadata that prevents apply
for key in ['resourceVersion', 'uid', 'creationTimestamp', 'managedFields']:
    cm.get('metadata', {}).pop(key, None)
json.dump(cm, sys.stdout)
" | kctl apply -f -
  echo "  mcp-host-config patched with new RPC public key."
  # Restart mcp-host deployments to pick up the new key
  kctl rollout restart deploy -n mcp-host 2>/dev/null || true
  echo "  mcp-host namespace deployments restarted."
else
  echo "  WARNING: mcp-host-config ConfigMap not found in mcp-host namespace."
  echo "  Deploy services first (make gcp-prod-deploy-all or gcp-dev-deploy-all),"
  echo "  then re-run this script or manually create mcp-host-config."
fi

echo ""
echo "=== Post-deploy validation ==="
VALIDATION_FAILED=0
for ns in control-plane sandbox-recipes; do
  val=$(kctl get cm clerum-wrc-public-key -n "$ns" -o jsonpath='{.data.CLERUM_WRC_SIGNING_PUBLIC_KEY}' 2>/dev/null || true)
  if [[ "$val" == "REPLACE_WITH_PUBLIC_KEY" || -z "$val" ]]; then
    echo "  ERROR: ConfigMap clerum-wrc-public-key in $ns has placeholder or empty value"
    VALIDATION_FAILED=1
  else
    echo "  OK: clerum-wrc-public-key in $ns has valid PEM key"
  fi
done
if [[ "$VALIDATION_FAILED" -eq 1 ]]; then
  echo ""
  echo "VALIDATION FAILED: One or more ConfigMaps still have placeholder values."
  echo "This will cause model-config-failed errors in workflow pods."
  exit 1
fi

echo ""
echo "=== Done ==="
echo ""
echo "All secrets created, JWT public key synced, and validation passed."
