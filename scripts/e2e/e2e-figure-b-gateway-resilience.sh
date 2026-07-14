#!/usr/bin/env bash
# 1st-party AuthN, 3rd-party MCP-Host gateway resilience gate.
# This intentionally mutates only the workflow approval gateway deployment and a
# short-lived sandbox probe pod. It must fail if sandbox workflow mcp-host
# traffic can reach control-api directly while the gateway is healthy or down.
set -euo pipefail

if (($# > 0)); then
  echo "1st-party AuthN, 3rd-party MCP-Host gateway resilience gate accepts no optional shortcut flags." >&2
  exit 2
fi

resolved_context="${KUBECONTEXT:-${K8S_CONTEXT:-${E2E_K8S_CONTEXT:-}}}"
if [[ -z "$resolved_context" ]]; then
  cat >&2 <<'MSG'
1st-party AuthN, 3rd-party MCP-Host gateway resilience requires an explicit Kubernetes context.
Set KUBECONTEXT, K8S_CONTEXT, or E2E_K8S_CONTEXT to the branch/commit minikube profile resolved from .local-notes.
This runner intentionally has no shared legacy context fallback.
MSG
  exit 2
fi

KC=(kubectl --context "$resolved_context")
CONTROL_NS="control-plane"
SANDBOX_NS="sandbox-recipes"
GATEWAY_DEPLOY="nginx-workflow-approval-gateway"
GATEWAY_SVC="nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092"
CONTROL_API_SVC="control-api.control-plane.svc.cluster.local:8090"
CURL_IMAGE="${E2E_GATEWAY_CURL_IMAGE:-curlimages/curl:8.7.1}"
LOAD_COUNT="${E2E_FIGURE_B_GATEWAY_LOAD_COUNT:-10}"
GATEWAY_READY_TIMEOUT_SECONDS="${E2E_FIGURE_B_GATEWAY_READY_TIMEOUT_SECONDS:-60}"
PROBE_NAME="figb-gateway-probe-$(date +%s)-$$"
ORIGINAL_REPLICAS=""
RESTORE_GATEWAY=false
LOAD_CODES_DIR=""
PROBE_OVERRIDES=""

PASS=0
FAIL=0
TOTAL=0

log() { echo "[figure-b-gateway] $*"; }
pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  PASS $*"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  FAIL $*" >&2; exit 1; }

cleanup() {
  if [[ "$RESTORE_GATEWAY" == "true" && -n "$ORIGINAL_REPLICAS" ]]; then
    "${KC[@]}" -n "$CONTROL_NS" scale "deploy/${GATEWAY_DEPLOY}" --replicas="$ORIGINAL_REPLICAS" >/dev/null 2>&1 || true
    if [[ "$ORIGINAL_REPLICAS" != "0" ]]; then
      "${KC[@]}" -n "$CONTROL_NS" rollout status "deploy/${GATEWAY_DEPLOY}" --timeout=180s >/dev/null 2>&1 || true
    fi
  fi
  "${KC[@]}" -n "$SANDBOX_NS" delete pod "$PROBE_NAME" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
  if [[ -n "$LOAD_CODES_DIR" ]]; then
    rm -rf "$LOAD_CODES_DIR"
  fi
}
trap cleanup EXIT

curl_code_from_probe() {
  local url="$1"
  "${KC[@]}" -n "$SANDBOX_NS" exec "$PROBE_NAME" -- sh -c \
    'curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 5 "$1" || true' \
    _ "$url" 2>/dev/null
}

expect_gateway_up() {
  local code
  local deadline=$((SECONDS + GATEWAY_READY_TIMEOUT_SECONDS))
  while ((SECONDS <= deadline)); do
    code="$(curl_code_from_probe "http://${GATEWAY_SVC}/health")"
    if [[ "$code" == "200" ]]; then
      pass "sandbox workflow mcp-host probe reaches gateway health"
      return 0
    fi
    sleep 1
  done
  fail "gateway health expected 200, got ${code:-<empty>}"
}

expect_gateway_down_fail_closed() {
  local code
  code="$(curl_code_from_probe "http://${GATEWAY_SVC}/health")"
  [[ "$code" != "200" ]] || fail "gateway scaled down but probe still got HTTP 200"
  pass "gateway down fails closed from sandbox workflow mcp-host probe (HTTP ${code:-<empty>})"
}

expect_direct_control_api_blocked() {
  local code
  code="$(curl_code_from_probe "http://${CONTROL_API_SVC}/health")"
  [[ "$code" != "200" ]] || fail "direct sandbox workflow mcp-host -> control-api returned HTTP 200"
  pass "direct sandbox workflow mcp-host -> control-api remains blocked (HTTP ${code:-<empty>})"
}

log "Using KUBECONTEXT=${resolved_context}"
[[ "$LOAD_COUNT" =~ ^[1-9][0-9]*$ ]] || fail "E2E_FIGURE_B_GATEWAY_LOAD_COUNT must be a positive integer"
[[ "$GATEWAY_READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "E2E_FIGURE_B_GATEWAY_READY_TIMEOUT_SECONDS must be a positive integer"
"${KC[@]}" get namespace "$CONTROL_NS" >/dev/null
"${KC[@]}" get namespace "$SANDBOX_NS" >/dev/null

ORIGINAL_REPLICAS="$("${KC[@]}" -n "$CONTROL_NS" get "deploy/${GATEWAY_DEPLOY}" -o jsonpath='{.spec.replicas}')"
[[ -n "$ORIGINAL_REPLICAS" ]] || fail "could not resolve ${GATEWAY_DEPLOY} replica count"
[[ "$ORIGINAL_REPLICAS" != "0" ]] || fail "${GATEWAY_DEPLOY} starts at 0 replicas; restore a healthy baseline before this gate"
RESTORE_GATEWAY=true

log "Creating workflow-mcp-host labelled probe pod in ${SANDBOX_NS}"
PROBE_OVERRIDES="$(printf '{"apiVersion":"v1","spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"%s","image":"%s","command":["sleep","3600"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' "$PROBE_NAME" "$CURL_IMAGE")"
"${KC[@]}" -n "$SANDBOX_NS" run "$PROBE_NAME" \
  --image="$CURL_IMAGE" \
  --restart=Never \
  --labels="clerum.io/component=workflow-mcp-host,clerum.io/managed-by=workflow-recipes,app=${PROBE_NAME}" \
  --overrides="$PROBE_OVERRIDES" \
  --command -- sleep 3600 >/dev/null
"${KC[@]}" -n "$SANDBOX_NS" wait --for=condition=Ready "pod/${PROBE_NAME}" --timeout=180s >/dev/null
pass "probe pod is ready with workflow-mcp-host labels"

log "Baseline gateway and direct-control posture"
expect_gateway_up
expect_direct_control_api_blocked

log "Restarting ${GATEWAY_DEPLOY} and validating fail-closed posture"
"${KC[@]}" -n "$CONTROL_NS" rollout restart "deploy/${GATEWAY_DEPLOY}" >/dev/null
"${KC[@]}" -n "$CONTROL_NS" rollout status "deploy/${GATEWAY_DEPLOY}" --timeout=180s >/dev/null
expect_gateway_up
expect_direct_control_api_blocked

log "Scaling ${GATEWAY_DEPLOY} to zero"
"${KC[@]}" -n "$CONTROL_NS" scale "deploy/${GATEWAY_DEPLOY}" --replicas=0 >/dev/null
"${KC[@]}" -n "$CONTROL_NS" wait --for=delete pod -l "app=${GATEWAY_DEPLOY}" --timeout=180s >/dev/null 2>&1 || true
expect_gateway_down_fail_closed
expect_direct_control_api_blocked

log "Restoring ${GATEWAY_DEPLOY} to ${ORIGINAL_REPLICAS} replicas"
"${KC[@]}" -n "$CONTROL_NS" scale "deploy/${GATEWAY_DEPLOY}" --replicas="$ORIGINAL_REPLICAS" >/dev/null
"${KC[@]}" -n "$CONTROL_NS" rollout status "deploy/${GATEWAY_DEPLOY}" --timeout=180s >/dev/null
expect_gateway_up
expect_direct_control_api_blocked

log "Running ${LOAD_COUNT} concurrent gateway health probes through the sandbox path"
LOAD_CODES_DIR="$(mktemp -d)"
for probe_index in $(seq 1 "$LOAD_COUNT"); do
  (
    curl_code_from_probe "http://${GATEWAY_SVC}/health" >"${LOAD_CODES_DIR}/${probe_index}.code"
  ) &
done
wait
failed_probe_codes=0
for code_file in "${LOAD_CODES_DIR}"/*.code; do
  code="$(tr -d '\r\n' <"$code_file")"
  if [[ "$code" != "200" ]]; then
    echo "$code" >&2
    failed_probe_codes=$((failed_probe_codes + 1))
  fi
done
if ((failed_probe_codes > 0)); then
  fail "one or more concurrent gateway probes failed"
fi
rm -rf "$LOAD_CODES_DIR"
LOAD_CODES_DIR=""
pass "concurrent gateway probes all returned HTTP 200"

echo "TOTAL=${TOTAL} PASS=${PASS} FAIL=${FAIL}"
