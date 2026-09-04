#!/usr/bin/env bash
# E2E: sandbox-ui-oauth — Recipe with spec.oauthClients[] reconciles end to end.
#
# Validates the cluster-side half of the OAuth Connect button pipeline
# (spec §9.9). The OAuth flow itself requires a real Slack app + a human
# completing the redirect in their browser; this gate covers the
# platform plumbing that has to be in place before that flow can run:
#
#   1. WorkflowRecipe with spec.oauthClients[] applies cleanly.
#   2. UI workload Deployment + Service land in `sandbox-ui` namespace.
#   3. spec.oauthClients[] is preserved on the WorkflowRecipe (not stripped
#      by validation).
#   4. The dependent K8s Secret can be referenced (we create a dummy one).
#   5. UI pod runs as non-root and is Ready.
#
# What this DOES NOT cover (manual + desktop-app vitest territory):
#   - Embed click → desktop main intercept → rpc-proxy → control-api flow
#   - Provider redirect → control-api callback → grant store
#   - clerum:// completion deep link → embed JS receives onOauthCompleted
#
# To exercise those manually:
#   1. Replace the dummy Secret with real Slack OAuth app credentials.
#   2. Open the desktop app, navigate to this recipe's UI, click Connect.
#   3. Complete OAuth in your browser. Confirm the embed flips to
#      "Connected to slack" via the onOauthCompleted listener.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-convergence.sh"

RECIPE_FILE="workflow-recipes/samples/sandbox-ui-oauth-hello.yaml"
RECIPE_NAME="sandbox-ui-oauth-hello"
WORKLOAD_ID="hello"
SANDBOX_UI_NS="sandbox-ui"
OAUTH_SECRET_NAME="slack-oauth-creds"
BACKGROUND_RECIPE_NAME="e2e-wrc-oauth-broker"
BACKGROUND_WORKLOAD_ID="background-worker"
BACKGROUND_POLICY_NAME="wf-${BACKGROUND_RECIPE_NAME}-oauth-broker-egress"
BACKGROUND_PROBE_POD="e2e-wrc-oauth-unlabelled"
STABILITY_SECONDS="${E2E_NP_STABILITY_SECONDS:-20}"
TIMEOUT_RECIPE_ACTIVE="${TIMEOUT_RECIPE_ACTIVE:-180}"
UI_DEPLOYMENT=""
BACKGROUND_DEPLOYMENT=""
UI_PORT_FWD_PORT="${E2E_OAUTH_UI_PORT:-18096}"
UI_PORT_FWD_PID=""
CREATED=0

wait_for_recipe_phase() {
  local name=$1 ns=$2 want=$3 timeout=$4 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local phase
    phase=$(kctl get workflowrecipe "$name" -n "$ns" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "$phase" = "$want" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_workload_instance() {
  local recipe_name=$1 workload_id=$2 timeout=${3:-120} elapsed=0 instance
  while [ "$elapsed" -lt "$timeout" ]; do
    instance="$(kctl get workflowrecipe "$recipe_name" -n "$WORKFLOW_RECIPE_NS" -o "jsonpath={.status.workloadInstances.${workload_id}}" 2>/dev/null || true)"
    if [ -n "$instance" ]; then
      printf '%s\n' "$instance"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

http_response_from_target() {
  local target=$1 host=$2 port=$3
  # shellcheck disable=SC2016
  kctl exec "$target" -n "$WORKFLOW_RECIPE_NS" -- sh -c 'printf "GET /health HTTP/1.0\r\nHost: e2e\r\nConnection: close\r\n\r\n" | nc -w 6 "$1" "$2"' -- "$host" "$port" 2>/dev/null || true
}

create_background_probe() {
  cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${BACKGROUND_PROBE_POD}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    e2e.clerum.io/probe: wrc-oauth-unlabelled
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: probe
      image: busybox:1.36.1
      command: ["sh", "-c", "trap 'exit 0' TERM INT; while true; do sleep 3600; done"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
YAML
  wait_for_pod "$WORKFLOW_RECIPE_NS" "e2e.clerum.io/probe=wrc-oauth-unlabelled" 60
}

cleanup() {
  local cleanup_status=0
  header "Cleanup"
  if [ -n "$UI_PORT_FWD_PID" ]; then
    if kill -0 "$UI_PORT_FWD_PID" 2>/dev/null; then
      kill "$UI_PORT_FWD_PID" 2>/dev/null || cleanup_status=1
    fi
    wait "$UI_PORT_FWD_PID" 2>/dev/null || true
    UI_PORT_FWD_PID=""
  fi
  kctl delete pod "$BACKGROUND_PROBE_POD" -n "$WORKFLOW_RECIPE_NS" --ignore-not-found \
    --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_status=1
  kctl delete workflowrecipe "$BACKGROUND_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$BACKGROUND_RECIPE_NAME" \
    "$TIMEOUT_DELETE" >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" \
    "$TIMEOUT_DELETE" >/dev/null 2>&1 || cleanup_status=1
  # WRC GC follows ownerReferences inside the recipe namespace, but UI
  # workloads are reconciled cross-namespace (sandbox-recipes →
  # sandbox-ui) so K8s GC can't follow the link. Force-delete leftovers.
  if [ -n "$UI_DEPLOYMENT" ]; then
    kctl delete deployment "$UI_DEPLOYMENT" -n "$SANDBOX_UI_NS" \
      --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
    kctl delete svc "$UI_DEPLOYMENT" -n "$SANDBOX_UI_NS" \
      --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  fi
  kctl delete deployment,service -n "$SANDBOX_UI_NS" -l "clerum.io/recipe=${RECIPE_NAME}" \
    --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  kctl delete deployment,service,networkpolicy -n "$WORKFLOW_RECIPE_NS" \
    -l "clerum.io/recipe=${BACKGROUND_RECIPE_NAME}" --ignore-not-found \
    >/dev/null 2>&1 || cleanup_status=1
  kctl delete networkpolicy "ui-egress-${RECIPE_NAME}" -n "$SANDBOX_UI_NS" \
    --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  kctl delete networkpolicy "$BACKGROUND_POLICY_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found >/dev/null 2>&1 || cleanup_status=1
  kctl delete secret "$OAUTH_SECRET_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found >/dev/null 2>&1 || cleanup_status=1

  return "$cleanup_status"
}

on_exit() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  if [ "${E2E_KEEP_RESOURCES:-0}" = "1" ]; then
    warn "E2E_KEEP_RESOURCES=1; preserving OAuth fixtures for inspection"
    exit "$status"
  fi
  if [ "$CREATED" = "1" ]; then
    cleanup || cleanup_status=$?
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    if [ "$status" -eq 0 ]; then
      fail "OAuth E2E cleanup left resources or processes behind"
      status=1
    else
      warn "OAuth E2E cleanup also failed while preserving the original test failure"
    fi
  fi
  exit "$status"
}

if [[ "${1:-}" == "--cleanup-only" ]]; then
  cleanup
  exit $?
fi

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ─── Phase 0: Prerequisites ──────────────────────────────────────────
check_prerequisites

# ─── Phase 1: Clean Slate ────────────────────────────────────────────
header "Phase 1 — Clean Slate"
cleanup >/dev/null 2>&1 || true
CREATED=1

# ─── Phase 2: Create dummy OAuth credentials Secret ──────────────────
header "Phase 2 — Create dummy slack-oauth-creds Secret"
kctl create secret generic "$OAUTH_SECRET_NAME" \
  -n "$WORKFLOW_RECIPE_NS" \
  --from-literal=client-id="dummy-client-id-for-platform-test" \
  --from-literal=client-secret="dummy-client-secret-for-platform-test" \
  >/dev/null
ok "Secret '${OAUTH_SECRET_NAME}' created in '${WORKFLOW_RECIPE_NS}'"

# ─── Phase 3: Apply Recipe ───────────────────────────────────────────
apply_recipe "$RECIPE_FILE" "$RECIPE_NAME"
cat <<YAML | kctl apply -f - >/dev/null
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${BACKGROUND_RECIPE_NAME}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    e2e.clerum.io/suite: wrc-oauth-broker-networkpolicy
spec:
  description: "Background OAuth NetworkPolicy route fixture."
  oauthClients:
    - id: slack-background
      provider: slack
      clientIdRef:
        name: ${OAUTH_SECRET_NAME}
        key: client-id
      clientSecretRef:
        name: ${OAUTH_SECRET_NAME}
        key: client-secret
      scopes: ["users:read"]
      backgroundAccess: true
  workloads:
    - id: ${BACKGROUND_WORKLOAD_ID}
      type: deployment
      image: busybox:1.36.1
      oauthClientRefs: ["slack-background"]
      command: ["sh", "-c"]
      args:
        - "trap 'exit 0' TERM INT; while true; do sleep 3600; done"
YAML
ok "Background OAuth fixture applied"

# ─── Phase 4: Reconciliation reaches active ──────────────────────────
header "Phase 4 — WorkflowRecipe reconciles to phase=active"
if wait_for_recipe_phase "$RECIPE_NAME" "$WORKFLOW_RECIPE_NS" "active" \
    "$TIMEOUT_RECIPE_ACTIVE"; then
  ok "WorkflowRecipe '${RECIPE_NAME}' reached phase=active"
else
  phase=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "unknown")
  fail "WorkflowRecipe '${RECIPE_NAME}' did not reach phase=active (got '${phase}')"
  kctl describe workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" || true
  exit 1
fi

UI_DEPLOYMENT="$(wait_for_workload_instance "$RECIPE_NAME" "$WORKLOAD_ID" 120)"
[ -n "$UI_DEPLOYMENT" ] || {
  fail "UI workload instance was not assigned"
  exit 1
}

# ─── Phase 4b: background OAuth NetworkPolicy route ─────────────────
header "Phase 4b — background OAuth broker NetworkPolicy"
if ! wait_for_recipe_phase "$BACKGROUND_RECIPE_NAME" "$WORKFLOW_RECIPE_NS" "active" "$TIMEOUT_RECIPE_ACTIVE"; then
  phase=$(kctl get workflowrecipe "$BACKGROUND_RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "unknown")
  fail "Background OAuth recipe did not reach active (got '${phase}')"
  exit 1
fi

BACKGROUND_DEPLOYMENT="$(
  wait_for_workload_instance "$BACKGROUND_RECIPE_NAME" "$BACKGROUND_WORKLOAD_ID" 120
)"
[ -n "$BACKGROUND_DEPLOYMENT" ] || {
  fail "Background OAuth workload instance was not assigned"
  exit 1
}
wait_for_deployment "$WORKFLOW_RECIPE_NS" "$BACKGROUND_DEPLOYMENT" "$TIMEOUT_POD"
wrc_wait_for_np "$WORKFLOW_RECIPE_NS" "$BACKGROUND_POLICY_NAME" 120

control_api_ip="$(kctl get service control-api -n "$CONTROL_NS" -o jsonpath='{.spec.clusterIP}')"
[ -n "$control_api_ip" ] || {
  fail "Control API Service address discovery failed"
  exit 1
}

response="$(http_response_from_target "deploy/${BACKGROUND_DEPLOYMENT}" "$control_api_ip" 8090)"
if printf '%s' "$response" | grep -Eq 'HTTP/1\.[01] [2345][0-9][0-9]'; then
  ok "Opted-in background workload reaches the OAuth broker network boundary"
else
    fail "Opted-in background workload cannot reach the OAuth broker network boundary"
    exit 1
fi

create_background_probe
response="$(http_response_from_target "$BACKGROUND_PROBE_POD" "$control_api_ip" 8090)"
if printf '%s' "$response" | grep -Eq 'HTTP/1\.[01] [2345][0-9][0-9]'; then
  fail "Unlabelled sandbox workload reached Control API through the OAuth policy"
  exit 1
fi
ok "Unlabelled sandbox workload cannot use the OAuth broker egress"

oauth_policy_hash="$(wrc_np_spec_hash "$WORKFLOW_RECIPE_NS" "$BACKGROUND_POLICY_NAME")"
wrc_inject_selector_drift "$WORKFLOW_RECIPE_NS" "$BACKGROUND_POLICY_NAME"
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$BACKGROUND_RECIPE_NAME" 120
wrc_wait_for_np_spec_hash "$WORKFLOW_RECIPE_NS" "$BACKGROUND_POLICY_NAME" "$oauth_policy_hash" 120
response="$(http_response_from_target "deploy/${BACKGROUND_DEPLOYMENT}" "$control_api_ip" 8090)"
if printf '%s' "$response" | grep -Eq 'HTTP/1\.[01] [2345][0-9][0-9]'; then
  ok "OAuth broker route recovered after live NetworkPolicy repair"
else
    fail "OAuth broker route did not recover after live NetworkPolicy repair"
    exit 1
fi
wrc_trigger_recipe_reconcile "$WORKFLOW_RECIPE_NS" "$BACKGROUND_RECIPE_NAME" 120
wrc_wait_for_np_noop_witness "$WORKFLOW_RECIPE_NS" "$BACKGROUND_POLICY_NAME" oauth-broker-egress apply 120
wrc_assert_np_stable "$WORKFLOW_RECIPE_NS" "$BACKGROUND_POLICY_NAME" "$STABILITY_SECONDS"

# ─── Phase 5: spec.oauthClients[] survives the round-trip ────────────
header "Phase 5 — spec.oauthClients[] preserved on the WorkflowRecipe"
oauth_id=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.spec.oauthClients[0].id}' 2>/dev/null || echo "")
oauth_provider=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.spec.oauthClients[0].provider}' 2>/dev/null || echo "")
client_id_secret=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.spec.oauthClients[0].clientIdRef.name}' 2>/dev/null || echo "")

if [ "$oauth_id" = "slack-bot" ]; then
  ok "spec.oauthClients[0].id is 'slack-bot'"
else
  fail "spec.oauthClients[0].id is '${oauth_id}' (want 'slack-bot')"
fi
if [ "$oauth_provider" = "slack" ]; then
  ok "spec.oauthClients[0].provider is 'slack'"
else
  fail "spec.oauthClients[0].provider is '${oauth_provider}' (want 'slack')"
fi
if [ "$client_id_secret" = "$OAUTH_SECRET_NAME" ]; then
  ok "spec.oauthClients[0].clientIdRef.name points at '${OAUTH_SECRET_NAME}'"
else
  fail "spec.oauthClients[0].clientIdRef.name is '${client_id_secret}' (want '${OAUTH_SECRET_NAME}')"
fi

# ─── Phase 6: UI workload lands in sandbox-ui ────────────────────────
header "Phase 6 — UI workload in sandbox-ui namespace"

if kctl get deployment "$UI_DEPLOYMENT" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "Deployment '${UI_DEPLOYMENT}' created in '${SANDBOX_UI_NS}'"
else
  fail "Deployment '${UI_DEPLOYMENT}' not found in '${SANDBOX_UI_NS}'"
fi

if kctl get deployment "$UI_DEPLOYMENT" -n "$WORKFLOW_RECIPE_NS" &>/dev/null; then
  fail "Deployment '${UI_DEPLOYMENT}' leaked into '${WORKFLOW_RECIPE_NS}' (three-way split broken)"
else
  ok "Deployment '${UI_DEPLOYMENT}' is NOT in '${WORKFLOW_RECIPE_NS}' (split correct)"
fi

if wait_for_deployment "$SANDBOX_UI_NS" "$UI_DEPLOYMENT" "$TIMEOUT_POD"; then
  ok "Deployment '${UI_DEPLOYMENT}' reached Ready"
else
  fail "Deployment '${UI_DEPLOYMENT}' did not reach Ready within ${TIMEOUT_POD}s"
  kctl describe deployment "$UI_DEPLOYMENT" -n "$SANDBOX_UI_NS" || true
  kctl get pods -n "$SANDBOX_UI_NS" -l "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload-id=${WORKLOAD_ID}" || true
fi

if kctl get svc "$UI_DEPLOYMENT" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "Service '${UI_DEPLOYMENT}' created in '${SANDBOX_UI_NS}'"
else
  fail "Service '${UI_DEPLOYMENT}' not found in '${SANDBOX_UI_NS}'"
fi

kctl port-forward -n "$SANDBOX_UI_NS" "service/${UI_DEPLOYMENT}" \
  "${UI_PORT_FWD_PORT}:8080" >/dev/null 2>&1 &
UI_PORT_FWD_PID=$!
ui_base_url="http://127.0.0.1:${UI_PORT_FWD_PORT}"
elapsed=0
while [ "$elapsed" -lt 30 ]; do
  if curl -fsS --max-time 2 "${ui_base_url}/" >/dev/null 2>&1; then
    break
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done
if ! kill -0 "$UI_PORT_FWD_PID" 2>/dev/null ||
   ! curl -fsS --max-time 2 "${ui_base_url}/" >/dev/null 2>&1; then
  fail "Scoped OAuth UI Service did not become reachable through its port-forward"
  exit 1
fi
ok "Scoped OAuth UI Service serves its visible route"

# ─── Phase 7: UI lifecycle assets serve correctly ────────────────────
header "Phase 7 — index.html + app.js exercise the full OAuth lifecycle"
pod_name=$(kctl get pods -n "$SANDBOX_UI_NS" \
  -l "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload-id=${WORKLOAD_ID}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$pod_name" ]; then
  pod_name=$(kctl get pods -n "$SANDBOX_UI_NS" -l "app=${UI_DEPLOYMENT}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
fi

if [ -z "$pod_name" ]; then
  fail "Could not locate the scoped UI pod"
  exit 1
fi

html=$(curl -fsS --max-time 5 "${ui_base_url}/" 2>/dev/null || echo "")
if echo "$html" | grep -q '<script src="app.js">'; then
  ok "index.html loads app.js as an external script (CSP-compliant)"
else
  fail "index.html does not load an external app.js — inline script would be blocked by rpc-proxy CSP"
fi

# nginx must serve .js with application/javascript; default_type
# would make Chromium refuse the script under CSP.
ctype=$(curl -sS --max-time 5 -D - -o /dev/null "${ui_base_url}/app.js" 2>/dev/null |
  grep -i '^content-type:' || true)
if echo "$ctype" | grep -qi 'application/javascript'; then
  ok "app.js is served with Content-Type: application/javascript"
else
  fail "app.js Content-Type is not application/javascript (got '${ctype}')"
fi

app_js=$(curl -fsS --max-time 5 "${ui_base_url}/app.js" 2>/dev/null || echo "")
if echo "$app_js" | grep -q 'clerum://oauth?clientId='; then
  ok "app.js renders the clerum:// connect href"
else
  fail "app.js is missing the clerum:// connect href"
fi
if echo "$app_js" | grep -q "/oauth/token"; then
  ok "app.js probes /oauth/token on load"
else
  fail "app.js is missing the /oauth/token probe call"
fi
if echo "$app_js" | grep -q "/oauth/grant"; then
  ok "app.js calls /oauth/grant for the Disconnect button"
else
  fail "app.js is missing the /oauth/grant DELETE call"
fi
if echo "$app_js" | grep -q 'clerum.onOauthCompleted'; then
  ok "app.js subscribes to clerum.onOauthCompleted"
else
  fail "app.js is missing the clerum.onOauthCompleted subscription"
fi
# ─── Phase 8: Pod runs as non-root ───────────────────────────────────
header "Phase 8 — UI pod runs as non-root"
runtime_uid=$(kctl exec "$pod_name" -n "$SANDBOX_UI_NS" -- id -u 2>/dev/null || echo "")
if [[ "$runtime_uid" =~ ^[0-9]+$ ]] && [ "$runtime_uid" -ne 0 ]; then
  ok "Pod '${pod_name}' runs as effective UID ${runtime_uid}"
else
  fail "Pod '${pod_name}' effective UID is '${runtime_uid:-unknown}' (expected non-root)"
fi

# ─── Summary ─────────────────────────────────────────────────────────
header "Summary"
# shellcheck disable=SC2154
echo -e "  ${GREEN}Passed:${NC} $e2e_pass"
# shellcheck disable=SC2154
echo -e "  ${RED}Failed:${NC} $e2e_fail"
# shellcheck disable=SC2154
echo -e "  ${BOLD}Total:${NC}  $e2e_total"

if [ "$e2e_fail" -gt 0 ]; then
  exit 1
fi
echo -e "${GREEN}${BOLD}E2E sandbox-ui-oauth PASSED${NC}"
