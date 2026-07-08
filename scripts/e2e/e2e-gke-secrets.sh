#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE Secrets & ConfigMaps Validation — E2E for production clusters
# ═══════════════════════════════════════════════════════════════════════
#
# Validates that all required Secrets and ConfigMaps exist, contain the
# expected keys, have no placeholder values, and that JWT keys are in
# sync across services. Also checks pod logs for leaked API keys.
#
# Tests:
#   Phase 1 — Required Secrets exist with expected keys
#   Phase 2 — Required ConfigMaps exist with expected keys
#   Phase 3 — JWT key sync (mcp-host-config ↔ rpc-proxy-secrets)
#   Phase 4 — No placeholder values in Secrets
#   Phase 5 — API key leak check in pod logs
#
# Usage:
#   ./scripts/e2e/e2e-gke-secrets.sh
#   ./scripts/e2e/e2e-gke-secrets.sh --verbose
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

VERBOSE="${1:-}"
PASS=0
FAIL=0
SKIP=0
TOTAL=0

log()   { echo -e "${CYAN}[secrets]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }
detail(){ [[ "$VERBOSE" == "--verbose" ]] && echo -e "       $*"; }

# ── Helper: check a Secret exists in a namespace ──────────────────────
check_secret_exists() {
  local ns="$1" name="$2"
  if kubectl get secret "$name" -n "$ns" >/dev/null 2>&1; then
    pass "Secret $ns/$name exists"
    return 0
  else
    fail "Secret $ns/$name NOT FOUND"
    return 1
  fi
}

# ── Helper: check a key exists within a Secret ────────────────────────
check_secret_key() {
  local ns="$1" name="$2" key="$3" optional="${4:-}"
  if kubectl get secret "$name" -n "$ns" -o jsonpath='{.data}' 2>/dev/null | grep -q "$key"; then
    pass "Secret $ns/$name has key '$key'"
    return 0
  else
    if [[ "$optional" == "optional" ]]; then
      skip "Secret $ns/$name key '$key' (optional, not present)"
    else
      fail "Secret $ns/$name MISSING key '$key'"
    fi
    return 1
  fi
}

# ── Helper: check a ConfigMap exists in a namespace ───────────────────
check_configmap_exists() {
  local ns="$1" name="$2"
  if kubectl get configmap "$name" -n "$ns" >/dev/null 2>&1; then
    pass "ConfigMap $ns/$name exists"
    return 0
  else
    fail "ConfigMap $ns/$name NOT FOUND"
    return 1
  fi
}

# ── Helper: check a key exists within a ConfigMap ─────────────────────
check_configmap_key() {
  local ns="$1" name="$2" key="$3"
  if kubectl get configmap "$name" -n "$ns" -o jsonpath="{.data.$key}" 2>/dev/null | grep -q .; then
    pass "ConfigMap $ns/$name has key '$key'"
    return 0
  else
    fail "ConfigMap $ns/$name MISSING or empty key '$key'"
    return 1
  fi
}

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE Secrets & ConfigMaps Validation${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 1: Required Secrets Exist with Expected Keys
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: Required Secrets"

# ── control-api-secrets (control-plane) ───────────────────────────────
log "  control-api-secrets (control-plane)"
if check_secret_exists control-plane control-api-secrets; then
  check_secret_key control-plane control-api-secrets CONTROL_API_SESSION_JWT_PRIVATE_KEY
  check_secret_key control-plane control-api-secrets CONTROL_API_RPC_JWT_PRIVATE_KEY
  check_secret_key control-plane control-api-secrets CONTROL_API_ADMIN_JWT_PRIVATE_KEY
  check_secret_key control-plane control-api-secrets CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH
fi

# ── rpc-proxy-secrets (rpc-proxy) ─────────────────────────────────────
log "  rpc-proxy-secrets (rpc-proxy)"
if check_secret_exists rpc-proxy rpc-proxy-secrets; then
  check_secret_key rpc-proxy rpc-proxy-secrets JWT_PUBLIC_KEY
fi

# ── external-rest-api-secrets (profiles) ──────────────────────────────
log "  external-rest-api-secrets (profiles)"
if check_secret_exists profiles external-rest-api-secrets; then
  check_secret_key profiles external-rest-api-secrets EXTERNAL_REST_API_JWT_PUBLIC_KEY
fi

# ── per-Host channel-reader credentials (channels ns) ─────────────────
# (#273) The legacy `clerum-channel-reader-credentials` Secret has been
# retired. Per-Host credentials are `channel-reader-<host>-credentials`,
# written via control-api's `/admin/channel-secrets` endpoint (Control UI),
# not at bootstrap. They're optional — a Host with no Telegram/Slack/email
# wired has no Secret. We log how many exist; absence is not a failure.
channel_secret_count=$(kubectl get secret -n channels \
  -l clerum.io/component=channel-reader \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -c . || true)
log "  per-Host channel-reader credentials: ${channel_secret_count} Secret(s)"

# ── clerum-wrc-signing-key (control-plane) ────────────────────────────
log "  clerum-wrc-signing-key (control-plane)"
if check_secret_exists control-plane clerum-wrc-signing-key; then
  check_secret_key control-plane clerum-wrc-signing-key private.pem
  check_secret_key control-plane clerum-wrc-signing-key public.pem
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 2: Required ConfigMaps Exist with Expected Keys
# ═════════════════════════════════════════════════════════════════════
log "Phase 2: Required ConfigMaps"

# ── mcp-host-config (mcp-host) ────────────────────────────────────────
log "  mcp-host-config (mcp-host)"
if check_configmap_exists mcp-host mcp-host-config; then
  check_configmap_key mcp-host mcp-host-config CLERUM_AUTH_JWT_ISSUER
  check_configmap_key mcp-host mcp-host-config CLERUM_AUTH_JWT_AUDIENCE
  check_configmap_key mcp-host mcp-host-config CLERUM_AUTH_JWT_PUBLIC_KEY
  check_configmap_key mcp-host mcp-host-config CLERUM_ENABLE_AUTH
fi

# ── control-api-config (control-plane) ────────────────────────────────
log "  control-api-config (control-plane)"
check_configmap_exists control-plane control-api-config

# ── clerum-model-secret-mapping (mcp-host) ────────────────────────────
# Post-refactor (WRC Secret Broker): ConfigMap co-located with the Secret
# it points to. Lives in mcp-host namespace alongside chatllm-api-keys.
log "  clerum-model-secret-mapping (mcp-host)"
check_configmap_exists mcp-host clerum-model-secret-mapping

# ── clerum-wrc-public-key (sandbox-recipes) ───────────────────────────
log "  clerum-wrc-public-key (sandbox-recipes)"
check_configmap_exists sandbox-recipes clerum-wrc-public-key
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 3: JWT Key Sync Validation
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: JWT Key Sync (mcp-host-config vs rpc-proxy-secrets)"

# Extract the JWT public key from mcp-host-config ConfigMap
MCP_HOST_KEY=$(kubectl get configmap mcp-host-config -n mcp-host \
  -o jsonpath='{.data.CLERUM_AUTH_JWT_PUBLIC_KEY}' 2>/dev/null || echo "")

# Extract the JWT public key from rpc-proxy-secrets Secret (base64-decoded)
RPC_PROXY_KEY=$(kubectl get secret rpc-proxy-secrets -n rpc-proxy \
  -o jsonpath='{.data.JWT_PUBLIC_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

if [[ -z "$MCP_HOST_KEY" ]]; then
  fail "JWT sync: mcp-host-config CLERUM_AUTH_JWT_PUBLIC_KEY is empty"
elif [[ -z "$RPC_PROXY_KEY" ]]; then
  fail "JWT sync: rpc-proxy-secrets JWT_PUBLIC_KEY is empty"
elif [[ "$MCP_HOST_KEY" == "$RPC_PROXY_KEY" ]]; then
  pass "JWT sync: mcp-host-config public key matches rpc-proxy-secrets"
  detail "Key fingerprint: $(echo "$MCP_HOST_KEY" | head -2 | tail -1 | cut -c1-40)..."
else
  fail "JWT sync: PUBLIC KEY MISMATCH between mcp-host-config and rpc-proxy-secrets"
  detail "Run 'make gcp-sync-auth-key' to fix"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 4: No Placeholder Values in Secrets
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: No Placeholder Values in Secrets"

PLACEHOLDER_PATTERNS="replace-me|replace-with|REPLACE|changeme|TODO"
SECRETS_TO_CHECK=(
  "control-plane/control-api-secrets"
  "rpc-proxy/rpc-proxy-secrets"
  "profiles/external-rest-api-secrets"
  "control-plane/clerum-wrc-signing-key"
  # (#273) clerum-channel-reader-credentials retired — per-Host Secrets
  # are written via control-api's /admin/channel-secrets and never contain
  # placeholder values (operators paste real bot tokens via Control UI).
)

for entry in "${SECRETS_TO_CHECK[@]}"; do
  ns="${entry%%/*}"
  name="${entry##*/}"

  # Get all base64-encoded values, decode them, and check for placeholders
  raw_data=$(kubectl get secret "$name" -n "$ns" -o jsonpath='{.data}' 2>/dev/null || echo "")
  if [[ -z "$raw_data" || "$raw_data" == "{}" ]]; then
    skip "Secret $ns/$name: no data keys to check"
    continue
  fi

  # Extract each base64 value, decode, and grep for placeholder patterns
  found_placeholder=false
  # Get individual keys and their values
  keys=$(kubectl get secret "$name" -n "$ns" -o json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); [print(k) for k in d]" 2>/dev/null || echo "")

  for key in $keys; do
    decoded=$(kubectl get secret "$name" -n "$ns" -o jsonpath="{.data.$key}" 2>/dev/null \
      | base64 -d 2>/dev/null || echo "")
    if echo "$decoded" | grep -qiE "$PLACEHOLDER_PATTERNS"; then
      fail "Secret $ns/$name key '$key' contains placeholder value"
      found_placeholder=true
    fi
  done

  if [[ "$found_placeholder" == "false" ]]; then
    pass "Secret $ns/$name: no placeholder values"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 5: API Key Leak Check in Pod Logs
# ═════════════════════════════════════════════════════════════════════
log "Phase 5: API Key Leak Check (pod logs)"

API_KEY_PATTERNS='sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]{20,}|zai-[A-Za-z0-9]{20,}'
DEPLOYMENTS_TO_CHECK=(
  "control-plane/control-api"
  "mcp-host/chatllm"
  "rpc-proxy/rpc-proxy"
  "profiles/external-rest-api"
  "control-plane/host-context-controller"
  "mcp-server/mcp-proxy"
)

for entry in "${DEPLOYMENTS_TO_CHECK[@]}"; do
  ns="${entry%%/*}"
  deploy="${entry##*/}"

  # Get pod name for this deployment (first pod)
  pod=$(kubectl get pods -n "$ns" -l "app=$deploy" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -z "$pod" ]]; then
    # Try without label selector — use deployment name match
    pod=$(kubectl get pods -n "$ns" --field-selector=status.phase=Running \
      -o jsonpath="{.items[?(@.metadata.labels.app=='$deploy')].metadata.name}" 2>/dev/null | awk '{print $1}' || echo "")
  fi

  if [[ -z "$pod" ]]; then
    skip "$ns/$deploy: no running pod found for log check"
    continue
  fi

  # Fetch last 500 lines of logs and scan for API key patterns
  logs=$(kubectl logs "$pod" -n "$ns" --tail=500 2>/dev/null || echo "")
  if [[ -z "$logs" ]]; then
    skip "$ns/$deploy: no logs available"
    continue
  fi

  if echo "$logs" | grep -oE "$API_KEY_PATTERNS" >/dev/null 2>&1; then
    leak_count=$(echo "$logs" | grep -oE "$API_KEY_PATTERNS" | wc -l | tr -d ' ')
    fail "$ns/$deploy: $leak_count API key pattern(s) found in logs!"
    detail "Patterns matched: $(echo "$logs" | grep -oE "$API_KEY_PATTERNS" | head -3 | sed 's/.\{8\}$/********/')"
  else
    pass "$ns/$deploy: no API keys leaked in logs"
  fi
done
echo ""

# ═════════════════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ALL PASSED: $PASS/$TOTAL tests passed ($SKIP skipped)${NC}"
else
  echo -e "${RED}${BOLD}  FAILURES: $FAIL/$TOTAL tests failed ($PASS passed, $SKIP skipped)${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"

exit $FAIL
