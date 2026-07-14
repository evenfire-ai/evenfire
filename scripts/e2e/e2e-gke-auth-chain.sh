#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE Auth Chain E2E — JWT auth chain validation for production clusters
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the full JWT authentication chain:
#   control-api (signs JWT) → Desktop App → rpc-proxy (validates) → mcp-host (validates)
#
# Token invariants:
#   iss = control-api
#   aud = rpc-proxy
#   TTL = 300s
#   Algorithm = RSA (public key in PEM format)
#
# Tests: ConfigMap/Secret auth fields, key sync between services,
# unauthenticated rejection, invalid token rejection, service reachability.
#
# Usage:
#   ./scripts/e2e/e2e-gke-auth-chain.sh
#   ./scripts/e2e/e2e-gke-auth-chain.sh --verbose
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

log()   { echo -e "${CYAN}[auth-chain]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }
detail(){ [[ "$VERBOSE" == "--verbose" ]] && echo -e "       $*" || true; }

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE Auth Chain E2E${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ── Prerequisite: cluster connectivity ─────────────────────────────────
log "Prerequisite: Cluster connectivity"

if kubectl cluster-info >/dev/null 2>&1; then
  pass "Cluster connected"
else
  fail "Cluster not connected"
  exit 1
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 1: Auth Config Presence (mcp-host-config ConfigMap)
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: Auth Config Presence (mcp-host-config)"

# 1a. CLERUM_ENABLE_AUTH is declared (accepts "true" or "false" — dev/prod
#     overlays intentionally set this to "false"; only minikube enables auth).
#     The auth chain must still be wired (issuer/audience/public key) so the
#     feature can be flipped on without additional config work.
enable_auth=$(kubectl get configmap mcp-host-config -n mcp-host \
  -o jsonpath='{.data.CLERUM_ENABLE_AUTH}' 2>/dev/null || echo "")
if [ "$enable_auth" = "true" ] || [ "$enable_auth" = "false" ]; then
  pass "CLERUM_ENABLE_AUTH declared: '$enable_auth'"
else
  fail "CLERUM_ENABLE_AUTH unset or invalid (got '$enable_auth', expected 'true' or 'false')"
fi

# 1b. CLERUM_AUTH_JWT_ISSUER=control-api
jwt_issuer=$(kubectl get configmap mcp-host-config -n mcp-host \
  -o jsonpath='{.data.CLERUM_AUTH_JWT_ISSUER}' 2>/dev/null || echo "")
if [ "$jwt_issuer" = "control-api" ]; then
  pass "CLERUM_AUTH_JWT_ISSUER=control-api"
else
  fail "CLERUM_AUTH_JWT_ISSUER expected 'control-api', got '$jwt_issuer'"
fi

# 1c. CLERUM_AUTH_JWT_AUDIENCE=rpc-proxy
jwt_audience=$(kubectl get configmap mcp-host-config -n mcp-host \
  -o jsonpath='{.data.CLERUM_AUTH_JWT_AUDIENCE}' 2>/dev/null || echo "")
if [ "$jwt_audience" = "rpc-proxy" ]; then
  pass "CLERUM_AUTH_JWT_AUDIENCE=rpc-proxy"
else
  fail "CLERUM_AUTH_JWT_AUDIENCE expected 'rpc-proxy', got '$jwt_audience'"
fi

# 1d. CLERUM_AUTH_JWT_PUBLIC_KEY is non-empty and starts with PEM header
jwt_public_key=$(kubectl get configmap mcp-host-config -n mcp-host \
  -o jsonpath='{.data.CLERUM_AUTH_JWT_PUBLIC_KEY}' 2>/dev/null || echo "")
if [ -z "$jwt_public_key" ]; then
  fail "CLERUM_AUTH_JWT_PUBLIC_KEY is empty"
elif echo "$jwt_public_key" | head -1 | grep -q "^-----BEGIN PUBLIC KEY-----"; then
  pass "CLERUM_AUTH_JWT_PUBLIC_KEY is non-empty and starts with -----BEGIN PUBLIC KEY-----"
  detail "Key length: ${#jwt_public_key} chars"
else
  fail "CLERUM_AUTH_JWT_PUBLIC_KEY does not start with '-----BEGIN PUBLIC KEY-----'"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 2: rpc-proxy Secrets (RPC_PROXY_JWT_PUBLIC_KEY)
# ═════════════════════════════════════════════════════════════════════
# Canonical Secret key is RPC_PROXY_JWT_PUBLIC_KEY (see rpc-proxy/src/config.ts).
# The legacy name JWT_PUBLIC_KEY still exists in some minikube fixtures; we
# prefer the canonical name but fall back for backwards compatibility.
log "Phase 2: rpc-proxy Secrets"

# 2a. rpc-proxy-secrets exists and has the JWT public key
rpc_proxy_key_b64=$(kubectl get secret rpc-proxy-secrets -n rpc-proxy \
  -o jsonpath='{.data.RPC_PROXY_JWT_PUBLIC_KEY}' 2>/dev/null || echo "")
rpc_key_field="RPC_PROXY_JWT_PUBLIC_KEY"
if [ -z "$rpc_proxy_key_b64" ]; then
  rpc_proxy_key_b64=$(kubectl get secret rpc-proxy-secrets -n rpc-proxy \
    -o jsonpath='{.data.JWT_PUBLIC_KEY}' 2>/dev/null || echo "")
  rpc_key_field="JWT_PUBLIC_KEY (legacy)"
fi
if [ -z "$rpc_proxy_key_b64" ]; then
  fail "rpc-proxy-secrets JWT public key is missing (checked RPC_PROXY_JWT_PUBLIC_KEY and JWT_PUBLIC_KEY)"
  rpc_proxy_key=""
else
  rpc_proxy_key=$(echo "$rpc_proxy_key_b64" | base64 -d 2>/dev/null || echo "")
  if echo "$rpc_proxy_key" | head -1 | grep -q "^-----BEGIN PUBLIC KEY-----"; then
    pass "rpc-proxy-secrets.$rpc_key_field is a valid PEM public key"
    detail "Key length: ${#rpc_proxy_key} chars"
  else
    fail "rpc-proxy-secrets.$rpc_key_field is not a valid PEM key"
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 3: Key Sync (mcp-host-config == rpc-proxy-secrets)
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: Key Sync Validation"

if [ -z "$jwt_public_key" ] || [ -z "$rpc_proxy_key" ]; then
  skip "Key sync check (one or both keys are missing)"
else
  # Normalize whitespace for comparison (trim trailing newlines/spaces)
  normalized_cm_key=$(echo "$jwt_public_key" | sed 's/[[:space:]]*$//' | sed '/^$/d')
  normalized_rpc_key=$(echo "$rpc_proxy_key" | sed 's/[[:space:]]*$//' | sed '/^$/d')

  if [ "$normalized_cm_key" = "$normalized_rpc_key" ]; then
    pass "Public key in mcp-host-config matches rpc-proxy-secrets"
  else
    fail "Public key MISMATCH between mcp-host-config and rpc-proxy-secrets"
    detail "This causes 401 errors. Run: make gcp-sync-auth-key"
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 4: rpc-proxy Rejects Unauthenticated Requests
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: Unauthenticated Request Rejection"

# Find a pod to exec into for in-cluster curl. Use control-api since it
# has wget/curl and is always present.
EXEC_POD=""
EXEC_NS=""
for pair in "control-plane/control-api" "rpc-proxy/rpc-proxy" "mcp-host/chatllm"; do
  ns="${pair%%/*}"
  dep="${pair##*/}"
  if kubectl get deployment "$dep" -n "$ns" >/dev/null 2>&1; then
    EXEC_POD="deployment/$dep"
    EXEC_NS="$ns"
    break
  fi
done

if [ -z "$EXEC_POD" ]; then
  skip "No exec-capable pod found for in-cluster HTTP tests"
  skip "rpc-proxy unauthenticated rejection (no exec pod)"
  skip "rpc-proxy invalid token rejection (no exec pod)"
else
  detail "Using $EXEC_NS/$EXEC_POD for in-cluster HTTP tests"

  # 4a. No token — expect 401
  no_auth_code=$(kubectl exec -n "$EXEC_NS" "$EXEC_POD" -- \
    wget -qO- --timeout=5 -S \
    "http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/api/v1/rpc/hosts/chatllm/activity/stream" \
    2>&1 | grep -o "HTTP/[0-9.]* [0-9]*" | tail -1 | grep -o "[0-9]*$" || echo "")

  # wget returns non-zero for 4xx, so also check stderr for status code
  if [ -z "$no_auth_code" ]; then
    no_auth_result=$(kubectl exec -n "$EXEC_NS" "$EXEC_POD" -- \
      wget -qO- --timeout=5 -S \
      "http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/api/v1/rpc/hosts/chatllm/activity/stream" \
      2>&1 || true)
    if echo "$no_auth_result" | grep -q "401\|Unauthorized"; then
      pass "rpc-proxy rejects unauthenticated requests (401)"
    elif echo "$no_auth_result" | grep -qi "timed out\|ETIMEDOUT"; then
      fail "rpc-proxy unreachable (timeout — NetworkPolicy blocking?)"
    else
      fail "rpc-proxy did not return 401 for unauthenticated request"
      detail "Response: $(echo "$no_auth_result" | head -3)"
    fi
  elif [ "$no_auth_code" = "401" ]; then
    pass "rpc-proxy rejects unauthenticated requests (401)"
  else
    fail "rpc-proxy returned HTTP $no_auth_code instead of 401 for unauthenticated request"
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 5: rpc-proxy Rejects Invalid Token
# ═════════════════════════════════════════════════════════════════════
log "Phase 5: Invalid Token Rejection"

if [ -z "$EXEC_POD" ]; then
  skip "rpc-proxy invalid token rejection (no exec pod)"
else
  # 5a. Bogus token — expect 401
  invalid_result=$(kubectl exec -n "$EXEC_NS" "$EXEC_POD" -- \
    wget -qO- --timeout=5 -S \
    --header="Authorization: Bearer invalid-token-e2e-test" \
    "http://rpc-proxy.rpc-proxy.svc.cluster.local:8094/api/v1/rpc/hosts/chatllm/activity/stream" \
    2>&1 || true)

  if echo "$invalid_result" | grep -q "401\|Unauthorized"; then
    pass "rpc-proxy rejects invalid token (401)"
  elif echo "$invalid_result" | grep -q "403\|Forbidden"; then
    pass "rpc-proxy rejects invalid token (403)"
  elif echo "$invalid_result" | grep -qi "timed out\|ETIMEDOUT"; then
    fail "rpc-proxy unreachable (timeout)"
  else
    fail "rpc-proxy did not reject invalid token"
    detail "Response: $(echo "$invalid_result" | head -3)"
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 6: control-api Health Reachable (in-cluster)
# ═════════════════════════════════════════════════════════════════════
log "Phase 6: control-api Health Reachable"

if [ -z "$EXEC_POD" ]; then
  skip "control-api health check (no exec pod)"
else
  health_result=$(kubectl exec -n "$EXEC_NS" "$EXEC_POD" -- \
    wget -qO- --timeout=5 \
    "http://control-api.control-plane.svc.cluster.local:8090/health" \
    2>&1 || echo "UNREACHABLE")

  if [ "$health_result" = "UNREACHABLE" ]; then
    fail "control-api /health unreachable from $EXEC_NS/$EXEC_POD"
  elif echo "$health_result" | grep -qi "ok\|healthy\|{"; then
    pass "control-api /health reachable from cluster"
    detail "Response: $(echo "$health_result" | head -1)"
  else
    # If we got any response, the service is reachable
    pass "control-api /health reachable (response received)"
    detail "Response: $(echo "$health_result" | head -1)"
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# PHASE 7: Token Issuer/Audience Match (cross-check)
# ═════════════════════════════════════════════════════════════════════
log "Phase 7: Token Issuer/Audience Consistency"

# The control-api signs with iss=control-api, aud=rpc-proxy.
# mcp-host-config must match these values exactly.

# 7a. Issuer must be 'control-api' (what control-api signs as)
if [ "$jwt_issuer" = "control-api" ]; then
  pass "Issuer matches control-api signing identity (iss=control-api)"
else
  fail "Issuer mismatch: mcp-host expects '$jwt_issuer' but control-api signs 'control-api'"
fi

# 7b. Audience must be 'rpc-proxy' (NOT 'mcp-host')
if [ "$jwt_audience" = "rpc-proxy" ]; then
  pass "Audience matches control-api signing claim (aud=rpc-proxy)"
else
  fail "Audience mismatch: mcp-host expects '$jwt_audience' but tokens carry aud=rpc-proxy"
  detail "CRITICAL: If aud=mcp-host, all tokens will be rejected by mcp-host"
fi

# 7c. Verify the auth chain is internally consistent. CLERUM_ENABLE_AUTH is a
#     deliberate design toggle (dev/prod overlays ship it "false"); what must
#     hold in every environment is that issuer and audience are wired
#     correctly so the feature can be flipped without redeploy of ConfigMap.
if [ "$jwt_issuer" = "control-api" ] && [ "$jwt_audience" = "rpc-proxy" ]; then
  pass "Auth chain wiring consistent: iss=control-api, aud=rpc-proxy (enable_auth=$enable_auth)"
else
  fail "Auth chain wiring inconsistent"
  detail "enable_auth=$enable_auth, issuer=$jwt_issuer, audience=$jwt_audience"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ALL PASSED: $PASS/$TOTAL tests passed ($SKIP skipped)${NC}"
else
  echo -e "${RED}${BOLD}  FAILURES: $FAIL/$TOTAL tests failed ($PASS passed, $SKIP skipped)${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"

exit $FAIL
