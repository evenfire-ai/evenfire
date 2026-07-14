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
source "${SCRIPT_DIR}/e2e-lib.sh"

RECIPE_FILE="workflow-recipes/samples/sandbox-ui-oauth-hello.yaml"
RECIPE_NAME="sandbox-ui-oauth-hello"
WORKLOAD_ID="hello"
SANDBOX_UI_NS="sandbox-ui"
OAUTH_SECRET_NAME="slack-oauth-creds"
TIMEOUT_RECIPE_ACTIVE="${TIMEOUT_RECIPE_ACTIVE:-180}"

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

cleanup() {
  header "Cleanup"
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false 2>/dev/null || true
  # WRC GC follows ownerReferences inside the recipe namespace, but UI
  # workloads are reconciled cross-namespace (sandbox-recipes →
  # sandbox-ui) so K8s GC can't follow the link. Force-delete leftovers.
  kctl delete deployment "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy "ui-egress-${RECIPE_NAME}" -n "$SANDBOX_UI_NS" \
    --ignore-not-found 2>/dev/null || true
  kctl delete secret "$OAUTH_SECRET_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found 2>/dev/null || true
}

if [[ "${1:-}" == "--cleanup-only" ]]; then
  cleanup
  exit 0
fi

trap cleanup EXIT

# ─── Phase 0: Prerequisites ──────────────────────────────────────────
check_prerequisites

# ─── Phase 1: Clean Slate ────────────────────────────────────────────
header "Phase 1 — Clean Slate"
cleanup

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

if kctl get deployment "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "Deployment '${WORKLOAD_ID}' created in '${SANDBOX_UI_NS}'"
else
  fail "Deployment '${WORKLOAD_ID}' not found in '${SANDBOX_UI_NS}'"
fi

if kctl get deployment "$WORKLOAD_ID" -n "$WORKFLOW_RECIPE_NS" &>/dev/null; then
  fail "Deployment '${WORKLOAD_ID}' leaked into '${WORKFLOW_RECIPE_NS}' (three-way split broken)"
else
  ok "Deployment '${WORKLOAD_ID}' is NOT in '${WORKFLOW_RECIPE_NS}' (split correct)"
fi

if wait_for_deployment "$SANDBOX_UI_NS" "$WORKLOAD_ID" "$TIMEOUT_POD"; then
  ok "Deployment '${WORKLOAD_ID}' reached Ready"
else
  fail "Deployment '${WORKLOAD_ID}' did not reach Ready within ${TIMEOUT_POD}s"
  kctl describe deployment "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" || true
  kctl get pods -n "$SANDBOX_UI_NS" -l "clerum.io/workload-id=${WORKLOAD_ID}" || true
fi

if kctl get svc "$WORKLOAD_ID" -n "$SANDBOX_UI_NS" &>/dev/null; then
  ok "Service '${WORKLOAD_ID}' created in '${SANDBOX_UI_NS}'"
else
  fail "Service '${WORKLOAD_ID}' not found in '${SANDBOX_UI_NS}'"
fi

# ─── Phase 7: UI lifecycle assets serve correctly ────────────────────
header "Phase 7 — index.html + app.js exercise the full OAuth lifecycle"
pod_name=$(kctl get pods -n "$SANDBOX_UI_NS" \
  -l "clerum.io/workload-id=${WORKLOAD_ID}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$pod_name" ]; then
  pod_name=$(kctl get pods -n "$SANDBOX_UI_NS" -l "app=${WORKLOAD_ID}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
fi

if [ -n "$pod_name" ]; then
  html=$(kctl exec "$pod_name" -n "$SANDBOX_UI_NS" -- \
    sh -c 'wget -qO- http://localhost:8080/' 2>/dev/null || echo "")
  if echo "$html" | grep -q '<script src="app.js">'; then
    ok "index.html loads app.js as an external script (CSP-compliant)"
  else
    fail "index.html does not load an external app.js — inline script would be blocked by rpc-proxy CSP"
  fi

  # nginx must serve .js with application/javascript; default_type
  # would make Chromium refuse the script under CSP.
  ctype=$(kctl exec "$pod_name" -n "$SANDBOX_UI_NS" -- \
    sh -c 'wget -qS -O /dev/null http://localhost:8080/app.js 2>&1 | grep -i "Content-Type"' 2>/dev/null || echo "")
  if echo "$ctype" | grep -qi 'application/javascript'; then
    ok "app.js is served with Content-Type: application/javascript"
  else
    fail "app.js Content-Type is not application/javascript (got '${ctype}')"
  fi

  app_js=$(kctl exec "$pod_name" -n "$SANDBOX_UI_NS" -- \
    sh -c 'wget -qO- http://localhost:8080/app.js' 2>/dev/null || echo "")
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
else
  warn "Could not locate UI pod — skipping HTML / app.js content checks"
fi

# ─── Phase 8: Pod runs as non-root ───────────────────────────────────
header "Phase 8 — UI pod runs as non-root"
if [ -n "$pod_name" ]; then
  run_as_user=$(kctl get pod "$pod_name" -n "$SANDBOX_UI_NS" \
    -o jsonpath='{.spec.containers[0].securityContext.runAsUser}' 2>/dev/null || echo "")
  run_as_non_root=$(kctl get pod "$pod_name" -n "$SANDBOX_UI_NS" \
    -o jsonpath='{.spec.containers[0].securityContext.runAsNonRoot}' 2>/dev/null || echo "")
  if [ "$run_as_user" != "0" ] && [ "$run_as_user" != "" ]; then
    ok "Pod '${pod_name}' container runAsUser=${run_as_user} (non-zero)"
  elif [ "$run_as_non_root" = "true" ]; then
    ok "Pod '${pod_name}' container runAsNonRoot=true"
  else
    fail "Pod '${pod_name}' may be running as root (runAsUser='${run_as_user}', runAsNonRoot='${run_as_non_root}')"
  fi
else
  warn "Could not locate UI pod by workload-id or app label — skipping non-root check"
fi

# ─── Summary ─────────────────────────────────────────────────────────
header "Summary"
echo -e "  ${GREEN}Passed:${NC} $e2e_pass"
echo -e "  ${RED}Failed:${NC} $e2e_fail"
echo -e "  ${BOLD}Total:${NC}  $e2e_total"

if [ "$e2e_fail" -gt 0 ]; then
  exit 1
fi
echo -e "${GREEN}${BOLD}E2E sandbox-ui-oauth PASSED${NC}"
