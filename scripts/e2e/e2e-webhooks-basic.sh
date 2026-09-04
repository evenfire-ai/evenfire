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
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-convergence.sh"

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
STABILITY_SECONDS="${E2E_NP_STABILITY_SECONDS:-20}"

PROXY_INGRESS_POLICY="allow-webhook-proxy-ingress-wf-${RECIPE_NAME}"
HANDLER_EGRESS_POLICY="allow-gateway-egress-to-handler-wf-${RECIPE_NAME}"
HANDLER_INGRESS_POLICY="allow-gateway-ingress-to-handler-wf-${RECIPE_NAME}"

PORT_FWD_PORT=18095
PORT_FWD_PID=""

wait_for_workload_instance() {
  local workload_id=$1 timeout=${2:-120} elapsed=0 instance
  while [ "$elapsed" -lt "$timeout" ]; do
    instance="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$GATEWAY_NS" \
      -o "jsonpath={.status.workloadInstances.${workload_id}}" 2>/dev/null || true)"
    if [ -n "$instance" ]; then
      printf '%s\n' "$instance"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_recipe_active() {
  local timeout=${1:-120} elapsed=0 phase
  while [ "$elapsed" -lt "$timeout" ]; do
    phase="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$GATEWAY_NS" \
      -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [ "$phase" = "active" ]; then
      return 0
    fi
    case "$phase" in
      failed|rollback-failed|deprecated) return 1 ;;
    esac
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# shellcheck disable=SC2329
cleanup() {
  local rc=$?
  set +e
  [ -n "$PORT_FWD_PID" ] && kill "$PORT_FWD_PID" 2>/dev/null
  kctl -n "$GATEWAY_NS" delete -f "${SCRIPT_DIR}/../../${RECIPE_FILE}" --ignore-not-found --wait=false >/dev/null 2>&1
  kctl -n "$GATEWAY_NS" delete secret "$SECRET_NAME" --ignore-not-found >/dev/null 2>&1
  exit "$rc"
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
  kctl -n "$GATEWAY_NS" label secret "$SECRET_NAME" \
    "clerum.io/owner-recipe=${RECIPE_NAME}" --overwrite >/dev/null
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
HANDLER_DEPLOYMENT="$(wait_for_workload_instance handler 120)"
[ -n "$HANDLER_DEPLOYMENT" ] || {
  fail "Handler workload instance was not assigned"
  exit 1
}
if wait_for_deployment "$GATEWAY_NS" "$HANDLER_DEPLOYMENT" 60; then
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
    "networkpolicy ${PROXY_INGRESS_POLICY}" \
    "networkpolicy ${HANDLER_EGRESS_POLICY}" \
    "networkpolicy ${HANDLER_INGRESS_POLICY}"; do
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
if wait_for_recipe_active 120; then
  ok "WorkflowRecipe status.phase == active"
else
  phase=$(kctl -n "$GATEWAY_NS" get workflowrecipe "$RECIPE_NAME" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  fail "WorkflowRecipe status.phase == ${phase:-<empty>} (expected active)"
  exit 1
fi

# ─── Phase 6: POST a signed payload via webhook-proxy ───────────────
header "Phase 6 — port-forward webhook-proxy and POST signed payload"
kctl -n "$PROXY_NS" port-forward "deploy/${PROXY_DEPLOYMENT}" "${PORT_FWD_PORT}:${PROXY_PORT}" \
  >/dev/null 2>&1 &
PORT_FWD_PID=$!
proxy_ready=0
for _ in $(seq 1 30); do
  kill -0 "$PORT_FWD_PID" 2>/dev/null || break
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT_FWD_PORT}/healthz" >/dev/null; then
    proxy_ready=1
    break
  fi
  sleep 1
done
if [ "$proxy_ready" = "1" ]; then
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

wait_for_policy_owner_uid() {
  local name=$1 expected=$2 timeout=${3:-120} elapsed=0 actual
  while [ "$elapsed" -lt "$timeout" ]; do
    actual="$(kctl get networkpolicy "$name" -n "$GATEWAY_NS" -o jsonpath='{.metadata.ownerReferences[0].uid}' 2>/dev/null || true)"
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "NetworkPolicy ${GATEWAY_NS}/${name} did not converge to owner UID"
  return 1
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

# 7.2 Oversize body via Content-Length. Stream it so the fixture never places a
# multi-megabyte value in argv (which exceeds ARG_MAX on macOS/Linux runners).
status=$(head -c 2000000 </dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${PORT_FWD_PORT}${PUBLIC_PATH}" \
  -H "content-type: application/json" \
  -H "content-length: 2000000" \
  --data-binary @-)
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

# ─── Phase 8: live convergence + owner repair ──────────────────────
header "Phase 8 — live drift and owner repair"
recipe_uid="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$GATEWAY_NS" -o jsonpath='{.metadata.uid}')"
[ -n "$recipe_uid" ] || {
  fail "WorkflowRecipe UID is missing"
  exit 1
}

proxy_spec_hash="$(wrc_np_spec_hash "$GATEWAY_NS" "$PROXY_INGRESS_POLICY")"
wrc_inject_selector_drift "$GATEWAY_NS" "$PROXY_INGRESS_POLICY"
kctl patch networkpolicy "$HANDLER_EGRESS_POLICY" -n "$GATEWAY_NS" --type=json -p='[{"op":"replace","path":"/metadata/ownerReferences/0/uid","value":"00000000-0000-0000-0000-000000000580"}]' >/dev/null
kctl patch networkpolicy "$HANDLER_INGRESS_POLICY" -n "$GATEWAY_NS" --type=json -p='[{"op":"remove","path":"/metadata/ownerReferences"}]' >/dev/null
wrc_trigger_recipe_reconcile "$GATEWAY_NS" "$RECIPE_NAME" 120

wrc_wait_for_np_spec_hash "$GATEWAY_NS" "$PROXY_INGRESS_POLICY" "$proxy_spec_hash" 120
wait_for_policy_owner_uid "$PROXY_INGRESS_POLICY" "$recipe_uid" 120
wait_for_policy_owner_uid "$HANDLER_EGRESS_POLICY" "$recipe_uid" 120
wait_for_policy_owner_uid "$HANDLER_INGRESS_POLICY" "$recipe_uid" 120
ok "Webhook gateway policies repaired spec drift, stale owner and missing owner"

status=$(http_status POST "$PUBLIC_PATH" "$SIG" "$PAYLOAD")
if [ "$status" = "200" ]; then
  ok "Signed webhook route recovered after policy repair"
else
  fail "Signed webhook route returned ${status} after policy repair"
fi

proxy_rv="$(wrc_np_resource_version "$GATEWAY_NS" "$PROXY_INGRESS_POLICY")"
handler_egress_rv="$(wrc_np_resource_version "$GATEWAY_NS" "$HANDLER_EGRESS_POLICY")"
handler_ingress_rv="$(wrc_np_resource_version "$GATEWAY_NS" "$HANDLER_INGRESS_POLICY")"
wrc_trigger_recipe_reconcile "$GATEWAY_NS" "$RECIPE_NAME" 120
sleep "$STABILITY_SECONDS"
[ "$(wrc_np_resource_version "$GATEWAY_NS" "$PROXY_INGRESS_POLICY")" = "$proxy_rv" ] || fail "${PROXY_INGRESS_POLICY} churned"
[ "$(wrc_np_resource_version "$GATEWAY_NS" "$HANDLER_EGRESS_POLICY")" = "$handler_egress_rv" ] || fail "${HANDLER_EGRESS_POLICY} churned"
[ "$(wrc_np_resource_version "$GATEWAY_NS" "$HANDLER_INGRESS_POLICY")" = "$handler_ingress_rv" ] || fail "${HANDLER_INGRESS_POLICY} churned"
ok "All three webhook gateway policies stayed resourceVersion-stable"

# ─── Summary ────────────────────────────────────────────────────────
header "Summary"
# shellcheck disable=SC2154
echo "  passed: ${e2e_pass}/${e2e_total}"
# shellcheck disable=SC2154
echo "  failed: ${e2e_fail}"

if [ "$e2e_fail" -gt 0 ]; then
  exit 1
fi
exit 0
