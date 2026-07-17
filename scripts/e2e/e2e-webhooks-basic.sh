#!/usr/bin/env bash
# E2E: webhooks-basic — Fireflies-shaped hmac-sha256-body webhook (W1.1)
#
# Validates the path WorkflowRecipe(spec.webhooks[]) → reconciled
# resources → public POST → verify → forward → handler responds 200.
#
# Phases:
#   1. Clean slate (delete any leftover from prior runs).
#   2. Create the signing-secret Secret in sandbox-recipes.
#   3. Apply samples/webhook-hello.yaml.
#   4. Wait for the per-recipe webhook-gateway Deployment to be Ready.
#   5. Verify the supporting K8s objects exist (Service, ConfigMap,
#      proxy-ingress NetworkPolicy, handler-egress NetworkPolicy).
#   6. POST a signed payload to webhook-proxy via port-forward; expect 200.
#   7. Negative cases:
#       - Bad signature → 401.
#       - Body > maxBodyBytes → 413.
#       - Unknown webhookId → 404.
#       - Unknown recipeName → 404.
#       - Wrong namespace → 404.
#       - PUT instead of POST → 405.
#   8. Cleanup.
#
# Desktop App / mcp-host integration is OUT OF SCOPE here — the
# corresponding tests are vitest suites in webhook-gateway/test/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

require_safe_kube_context

RECIPE_FILE="workflow-recipes/samples/webhook-hello.yaml"
RECIPE_NAME="webhook-hello"
WEBHOOK_ID="hello"
SECRET_NAME="webhook-hello-creds"
SECRET_KEY="signing-secret"
SECRET_VALUE="e2e-fireflies-test-secret"

GATEWAY_NAME="wf-${RECIPE_NAME}-webhook-gateway"
GATEWAY_NS="sandbox-recipes"
PROXY_NS="webhook-ingress"
PROXY_DEPLOYMENT="webhook-proxy"
PROXY_PORT=8095

PORT_FWD_PORT=18095
PORT_FWD_PID=""

cleanup() {
  local rc=$?
  set +e
  [ -n "$PORT_FWD_PID" ] && kill "$PORT_FWD_PID" 2>/dev/null
  kctl -n "$GATEWAY_NS" delete -f "${SCRIPT_DIR}/../../${RECIPE_FILE}" --ignore-not-found --wait=false >/dev/null 2>&1
  kctl -n "$GATEWAY_NS" delete secret "$SECRET_NAME" --ignore-not-found >/dev/null 2>&1
  exit $rc
}
trap cleanup EXIT INT TERM

# ─── Phase 1: clean slate ───────────────────────────────────────────
header "Phase 1 — clean slate"
kctl -n "$GATEWAY_NS" delete workflowrecipe "$RECIPE_NAME" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
kctl -n "$GATEWAY_NS" delete deployment "$GATEWAY_NAME" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
kctl -n "$GATEWAY_NS" delete secret "$SECRET_NAME" --ignore-not-found >/dev/null 2>&1 || true
log "leftover state cleared"

# ─── Phase 2: create signing-secret ─────────────────────────────────
header "Phase 2 — provision signing-secret Secret"
if kctl -n "$GATEWAY_NS" create secret generic "$SECRET_NAME" \
    --from-literal="${SECRET_KEY}=${SECRET_VALUE}" >/dev/null 2>&1; then
  ok "Secret $SECRET_NAME/$SECRET_KEY created in $GATEWAY_NS"
else
  fail "Secret create failed"
  exit 1
fi

# ─── Phase 3: apply recipe ──────────────────────────────────────────
header "Phase 3 — apply WorkflowRecipe"
if kctl apply -f "${SCRIPT_DIR}/../../${RECIPE_FILE}" >/dev/null; then
  ok "WorkflowRecipe applied"
else
  fail "WorkflowRecipe apply failed"
  exit 1
fi

# ─── Phase 4: wait for gateway Deployment ──────────────────────────
header "Phase 4 — wait for webhook-gateway Deployment"
if wait_for_deployment "$GATEWAY_NS" "$GATEWAY_NAME" 180; then
  ok "Deployment $GATEWAY_NS/$GATEWAY_NAME is Ready"
else
  fail "Deployment $GATEWAY_NS/$GATEWAY_NAME never became Ready (180s)"
  kctl -n "$GATEWAY_NS" describe deployment "$GATEWAY_NAME" || true
  exit 1
fi

# Also wait for the handler workload (nginx).
if wait_for_deployment "$GATEWAY_NS" "handler" 60; then
  ok "Handler Deployment is Ready"
else
  fail "Handler Deployment never became Ready"
  exit 1
fi

# ─── Phase 5: verify supporting resources ───────────────────────────
header "Phase 5 — verify supporting resources"
for kind_name in \
    "service ${GATEWAY_NAME}" \
    "configmap wf-${RECIPE_NAME}-webhook-gateway-config" \
    "networkpolicy allow-webhook-proxy-ingress-wf-${RECIPE_NAME}" \
    "networkpolicy allow-gateway-egress-to-handler-wf-${RECIPE_NAME}"; do
  kind="${kind_name%% *}"
  name="${kind_name##* }"
  if kctl -n "$GATEWAY_NS" get "$kind" "$name" >/dev/null 2>&1; then
    ok "$kind/$name exists"
  else
    fail "$kind/$name missing"
    exit 1
  fi
done

# Status condition assertions.
phase=$(kctl -n "$GATEWAY_NS" get workflowrecipe "$RECIPE_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
if [ "$phase" = "active" ]; then
  ok "WorkflowRecipe status.phase == active"
else
  warn "WorkflowRecipe status.phase == ${phase:-<empty>} (allowed: degraded → active on next reconcile)"
fi

# ─── Phase 6: POST a signed payload via webhook-proxy ───────────────
header "Phase 6 — port-forward webhook-proxy and POST signed payload"
kctl -n "$PROXY_NS" port-forward "deploy/${PROXY_DEPLOYMENT}" "${PORT_FWD_PORT}:${PROXY_PORT}" \
  >/dev/null 2>&1 &
PORT_FWD_PID=$!
# Give port-forward time to settle.
sleep 4

# /healthz smoke check on the proxy.
if curl -sf "http://127.0.0.1:${PORT_FWD_PORT}/healthz" >/dev/null; then
  ok "webhook-proxy /healthz reachable via port-forward"
else
  fail "webhook-proxy /healthz unreachable"
  exit 1
fi

PUBLIC_PATH="/api/v1/webhook/${GATEWAY_NS}/${RECIPE_NAME}/${WEBHOOK_ID}"
PAYLOAD='{"event":"meeting.created","id":"e2e-test-1"}'

sign() {
  local secret=$1 body=$2
  printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -hex \
    | awk '{print $NF}'
}

SIG="sha256=$(sign "$SECRET_VALUE" "$PAYLOAD")"

http_status() {
  local method=$1 path=$2 sig=${3:-} body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method"
    "http://127.0.0.1:${PORT_FWD_PORT}${path}"
    -H "content-type: application/json")
  [ -n "$sig" ] && args+=(-H "x-hub-signature-256: ${sig}")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}"
}

status=$(http_status POST "$PUBLIC_PATH" "$SIG" "$PAYLOAD")
if [ "$status" = "200" ]; then
  ok "POST with valid signature → 200"
else
  fail "POST with valid signature → ${status} (expected 200)"
  kctl -n "$GATEWAY_NS" logs deploy/"$GATEWAY_NAME" --tail=50 || true
  exit 1
fi

# ─── Phase 7: negative cases ────────────────────────────────────────
header "Phase 7 — negative cases"

# 7.1 Bad signature → 401
BAD_SIG="sha256=$(printf '%s' "deadbeef0123456789abcdef" | tr -d '\n' | head -c 64; for _ in 1 2 3 4; do printf 'a'; done)"
status=$(http_status POST "$PUBLIC_PATH" "$BAD_SIG" "$PAYLOAD")
if [ "$status" = "401" ]; then
  ok "POST with forged signature → 401 invalid_signature"
else
  fail "POST with forged signature → ${status} (expected 401)"
fi

# 7.2 Oversize body via Content-Length
big=$(head -c 2000000 </dev/zero | tr '\0' 'x')
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PORT_FWD_PORT}${PUBLIC_PATH}" \
  -H "content-type: application/json" \
  -H "content-length: 2000000" \
  --data "$big")
if [ "$status" = "413" ]; then
  ok "POST with oversize body → 413 body_too_large"
else
  fail "POST with oversize body → ${status} (expected 413)"
fi

# 7.3 Unknown webhookId → 404
status=$(http_status POST "/api/v1/webhook/${GATEWAY_NS}/${RECIPE_NAME}/unknown-webhook" "$SIG" "$PAYLOAD")
if [ "$status" = "404" ]; then
  ok "Unknown webhook id → 404 webhook_not_found"
else
  fail "Unknown webhook id → ${status} (expected 404)"
fi

# 7.4 Unknown recipeName → 404
status=$(http_status POST "/api/v1/webhook/${GATEWAY_NS}/no-such-recipe/${WEBHOOK_ID}" "$SIG" "$PAYLOAD")
if [ "$status" = "404" ]; then
  ok "Unknown recipe → 404"
else
  fail "Unknown recipe → ${status} (expected 404)"
fi

# 7.5 Wrong namespace → 404
status=$(http_status POST "/api/v1/webhook/wrong-ns/${RECIPE_NAME}/${WEBHOOK_ID}" "$SIG" "$PAYLOAD")
if [ "$status" = "404" ]; then
  ok "Wrong namespace → 404"
else
  fail "Wrong namespace → ${status} (expected 404)"
fi

# 7.6 PUT instead of POST → 405
status=$(http_status PUT "$PUBLIC_PATH" "$SIG" "$PAYLOAD")
if [ "$status" = "405" ]; then
  ok "PUT method → 405 method_not_allowed"
else
  fail "PUT method → ${status} (expected 405)"
fi

# ─── Summary ────────────────────────────────────────────────────────
header "Summary"
echo "  passed: ${e2e_pass}/${e2e_total}"
echo "  failed: ${e2e_fail}"

if [ "$e2e_fail" -gt 0 ]; then
  exit 1
fi
exit 0
