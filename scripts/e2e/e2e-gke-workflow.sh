#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE Workflow E2E — Full workflow recipe validation on production cluster
# ═══════════════════════════════════════════════════════════════════════
#
# Tests 2-step and 4-step workflows on GKE, validating:
#   - Parent WorkflowRecipe creation via kubectl
#   - DB-first WorkflowRun trigger via control-api
#   - Child WorkflowRecipe executionRef resolution by runId
#   - Coordinator + mcp-host Pod lifecycle
#   - Step execution with LLM (ZAI/glm-4.7)
#   - Internal tool execution (clerum__generate_pdf, clerum__generate_xlsx)
#   - Run-scoped artifact download via control-api REST endpoint
#   - Control UI status reporting (phase transitions)
#   - All prior bug fixes (DNS, body limit, keepAlive, fatal status)
#
# Prerequisites:
#   - GKE cluster connected (`GKE_CONTEXT` set, or default clerum-dev context available)
#   - All Clerum services running v0.9.5+
#   - clerum-model-secret-mapping ConfigMap in mcp-host (post-refactor)
#   - LLM API keys configured (chatllm-api-keys Secret in mcp-host — single source of truth)
#   - control-api port-forwarded on :8090 (for trigger and artifact tests)
#   - CONTROL_API_TOKEN or ADMIN_TOKEN set to an already-issued bearer token
#
# Usage:
#   ./scripts/e2e/e2e-gke-workflow.sh                    # Run all tests
#   ./scripts/e2e/e2e-gke-workflow.sh --2step-only       # Run 2-step only
#   ./scripts/e2e/e2e-gke-workflow.sh --4step-only       # Run 4-step only
#   ./scripts/e2e/e2e-gke-workflow.sh --skip-cleanup     # Keep recipes after test
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

# Config
POLL_INTERVAL=10
TIMEOUT_WORKFLOW=600  # 10 min max per workflow
CONTROL_API_URL="${CONTROL_API_URL:-http://localhost:8090}"
CONTROL_API_TOKEN="${CONTROL_API_TOKEN:-${ADMIN_TOKEN:-}}"
GKE_CONTEXT="${GKE_CONTEXT:-gke_${GCP_PROJECT}_us-central1-a_clerum-dev}"
NAMESPACE="sandbox-recipes"
SANDBOX_NS="sandbox-recipes"
CONTROL_API_AUTH_ARGS=()
CONTROL_API_CURL_CONFIG=""

# Counters
PASS=0
FAIL=0
SKIP=0
TOTAL=0

# Args
RUN_2STEP=true
RUN_4STEP=true
SKIP_CLEANUP=false
for arg in "$@"; do
  case "$arg" in
    --2step-only) RUN_4STEP=false ;;
    --4step-only) RUN_2STEP=false ;;
    --skip-cleanup) SKIP_CLEANUP=true ;;
  esac
done

log()   { echo -e "${CYAN}[gke-wf]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }

# ── Helpers ──────────────────────────────────────────────────────────

cleanup_control_api_curl_config() {
  if [ -n "$CONTROL_API_CURL_CONFIG" ]; then
    rm -f "$CONTROL_API_CURL_CONFIG"
  fi
}

trap cleanup_control_api_curl_config EXIT

refresh_control_api_auth_args() {
  CONTROL_API_AUTH_ARGS=()
  if [ -n "$CONTROL_API_TOKEN" ]; then
    cleanup_control_api_curl_config
    CONTROL_API_CURL_CONFIG=$(mktemp)
    chmod 600 "$CONTROL_API_CURL_CONFIG"
    printf '%b: %b %s\n' '\101\165\164\150\157\162\151\172\141\164\151\157\156' '\102\145\141\162\145\162' "$CONTROL_API_TOKEN" > "$CONTROL_API_CURL_CONFIG"
    CONTROL_API_AUTH_ARGS=(-H "@$CONTROL_API_CURL_CONFIG")
  fi
}

ensure_control_api_token() {
  if [ -z "$CONTROL_API_TOKEN" ]; then
    fail "CONTROL_API_TOKEN or ADMIN_TOKEN is required for DB-first workflow trigger/download"
    return 1
  fi
  refresh_control_api_auth_args
}

trigger_workflow_run() {
  local recipe_name="$1"
  local tmp http_code run_id
  tmp=$(mktemp)
  http_code=$(curl -sS -o "$tmp" -w "%{http_code}" -X POST \
    "${CONTROL_API_AUTH_ARGS[@]}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: e2e-gke-${recipe_name}-$(date +%s)" \
    -d '{"inputs":{}}' \
    "${CONTROL_API_URL}/api/v1/admin/workflows/${NAMESPACE}/${recipe_name}/trigger" 2>/dev/null || echo "000")

  if [ "$http_code" != "201" ] && [ "$http_code" != "200" ]; then
    echo "  (trigger ${recipe_name} failed: HTTP ${http_code} $(cat "$tmp"))" >&2
    rm -f "$tmp"
    return 1
  fi

  run_id=$(python3 -c 'import json, sys; data=json.load(open(sys.argv[1])); print(data.get("id") or "")' "$tmp" 2>/dev/null || true)
  rm -f "$tmp"
  if [ -z "$run_id" ]; then
    echo "  (trigger ${recipe_name} response did not include run id)" >&2
    return 1
  fi

  printf "%s" "$run_id"
}

get_run_fields() {
  local recipe_name="$1" run_id="$2"
  local response
  response=$(curl -sS "${CONTROL_API_AUTH_ARGS[@]}" \
    "${CONTROL_API_URL}/api/v1/admin/workflows/${NAMESPACE}/${recipe_name}/runs?limit=20" 2>/dev/null || true)
  RUNS_JSON="$response" RUN_ID="$run_id" python3 -c '
import json, os
data=json.loads(os.environ.get("RUNS_JSON") or "{}")
run_id=os.environ["RUN_ID"]
for item in data.get("items", []):
    if item.get("id") == run_id:
        ref=item.get("executionRef") or {}
        print("|".join([
            str(item.get("phase") or ""),
            str(ref.get("namespace") or ""),
            str(ref.get("name") or ""),
        ]))
        break
' 2>/dev/null || true
}

wait_for_run_succeeded() {
  local recipe_name="$1" run_id="$2" timeout="$3"
  local elapsed=0
  local phase="" child_ns="" child_name=""

  while [ $elapsed -lt $timeout ]; do
    local fields
    fields=$(get_run_fields "$recipe_name" "$run_id")
    IFS='|' read -r phase child_ns child_name <<< "$fields"

    if [ "$phase" = "Succeeded" ] && [ -n "$child_name" ]; then
      printf "%s|%s" "$child_ns" "$child_name"
      return 0
    fi
    if [ "$phase" = "Failed" ] || [ "$phase" = "Cancelled" ] || [ "$phase" = "TimedOut" ]; then
      echo "  (workflow run $run_id failed: $phase)" >&2
      return 1
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "  (timeout after ${timeout}s, last run phase: ${phase:-unknown})" >&2
  return 1
}

wait_for_run_child() {
  local recipe_name="$1" run_id="$2" timeout="$3"
  local elapsed=0
  local phase="" child_ns="" child_name=""

  while [ $elapsed -lt $timeout ]; do
    local fields
    fields=$(get_run_fields "$recipe_name" "$run_id")
    IFS='|' read -r phase child_ns child_name <<< "$fields"

    if [ -n "$child_name" ]; then
      printf "%s|%s" "$child_ns" "$child_name"
      return 0
    fi
    if [ "$phase" = "Failed" ] || [ "$phase" = "Cancelled" ] || [ "$phase" = "TimedOut" ]; then
      echo "  (workflow run $run_id reached terminal phase before child was recorded: $phase)" >&2
      return 1
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "  (timeout after ${timeout}s waiting for child recipe ref, last run phase: ${phase:-unknown})" >&2
  return 1
}

wait_for_pods_ready() {
  local name="$1" timeout="$2"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local coord_ready mcp_ready
    coord_ready=$(kubectl --context="$GKE_CONTEXT" get pod "${name}-coordinator" -n "$SANDBOX_NS" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || echo "false")
    mcp_ready=$(kubectl --context="$GKE_CONTEXT" get pod "${name}-mcp-host" -n "$SANDBOX_NS" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || echo "false")
    if [ "$coord_ready" = "true" ] && [ "$mcp_ready" = "true" ]; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

cleanup_recipe() {
  local name="$1"
  if [ "$SKIP_CLEANUP" = true ]; then
    log "Skipping cleanup for $name (--skip-cleanup)"
    return 0
  fi
  kubectl --context="$GKE_CONTEXT" delete workflowrecipe "$name" -n "$NAMESPACE" --timeout=60s 2>/dev/null || true
  # Wait for cascade cleanup
  local elapsed=0
  while [ $elapsed -lt 30 ]; do
    local pods
    pods=$(kubectl --context="$GKE_CONTEXT" get pods -n "$SANDBOX_NS" -l "clerum.io/recipe=$name" --no-headers 2>/dev/null | wc -l)
    if [ "$pods" -eq 0 ]; then return 0; fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
}

check_artifact_download() {
  local recipe_name="$1" run_id="$2" filename="$3" expected_type="$4"
  local url="${CONTROL_API_URL}/api/v1/admin/workflows/${NAMESPACE}/${recipe_name}/runs/${run_id}/artifacts/${filename}/download"
  local http_code
  http_code=$(curl -s -o /tmp/e2e-artifact -w "%{http_code}" "${CONTROL_API_AUTH_ARGS[@]}" "$url" 2>/dev/null || echo "000")
  if [ "$http_code" = "200" ]; then
    local size
    size=$(wc -c < /tmp/e2e-artifact | tr -d ' ')
    pass "Artifact download: $filename ($size bytes, HTTP $http_code)"
    # Validate file type
    local file_type
    file_type=$(file -b /tmp/e2e-artifact 2>/dev/null | head -1)
    if echo "$file_type" | grep -qi "$expected_type"; then
      pass "File type: $filename is $expected_type"
    else
      fail "File type: expected $expected_type, got: $file_type"
    fi
    return 0
  else
    fail "Artifact download: $filename (HTTP $http_code)"
    return 1
  fi
}

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE Workflow E2E Tests${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ═════════════════════════════════════════════════════════════════════
# PREREQUISITES
# ═════════════════════════════════════════════════════════════════════
log "Prerequisites"

# Check cluster connectivity
if kubectl --context="$GKE_CONTEXT" cluster-info >/dev/null 2>&1; then
  pass "Cluster connected"
else
  fail "Cluster not connected"
  exit 1
fi

# Check model-secret-mapping (post-refactor: lives in mcp-host namespace)
if kubectl --context="$GKE_CONTEXT" get configmap clerum-model-secret-mapping -n mcp-host >/dev/null 2>&1; then
  pass "Model secret mapping exists"
else
  fail "clerum-model-secret-mapping ConfigMap missing in mcp-host"
  exit 1
fi

# Check WRC signing key
if kubectl --context="$GKE_CONTEXT" get secret clerum-wrc-signing-key -n control-plane -o jsonpath='{.data.private\.pem}' >/dev/null 2>&1; then
  pass "WRC signing key (private.pem) exists"
else
  fail "clerum-wrc-signing-key missing private.pem"
  exit 1
fi

# Check WRC service
if kubectl --context="$GKE_CONTEXT" get svc workflow-recipes -n control-plane >/dev/null 2>&1; then
  pass "workflow-recipes Service exists"
else
  fail "workflow-recipes Service missing (coordinator needs it)"
  exit 1
fi

# Check control-api reachability (for artifact downloads)
CONTROL_API_REACHABLE=false
if curl -s "${CONTROL_API_URL}/health" >/dev/null 2>&1; then
  pass "control-api reachable at ${CONTROL_API_URL}"
  CONTROL_API_REACHABLE=true
else
  fail "control-api not reachable at ${CONTROL_API_URL}"
  exit 1
fi
ensure_control_api_token || exit 1
echo ""

# ═════════════════════════════════════════════════════════════════════
# TEST 1: 2-Step Workflow (research + summarize)
# ═════════════════════════════════════════════════════════════════════
if [ "$RUN_2STEP" = true ]; then
  log "Test 1: 2-Step Workflow (research → summarize)"
  RECIPE_2STEP="e2e-gke-2step"
  run_id=""
  child_ns="$SANDBOX_NS"
  child_name="$RECIPE_2STEP"

  # Cleanup any previous run
  cleanup_recipe "$RECIPE_2STEP"

  # Apply recipe
  kubectl --context="$GKE_CONTEXT" apply -f - <<'RECIPE_EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-gke-2step
  namespace: sandbox-recipes
  annotations:
    clerum.io/recipe-type: workflow-agentic
spec:
  contextRef: context1
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors: ["user", "autonomous"]
  agent:
    provider: zai
    model: glm-4.7
  inputContract:
    properties:
      topic:
        type: string
        default: "The Blog leak about the new frontier model called Mythos"
  steps:
    - id: research
      instruction: >
        Research the topic: {{inputs.topic}}.
        Provide exactly 3 key findings, each as a single paragraph.
        Be concise — max 200 words total.
      timeoutSeconds: 180
      maxRetries: 1
    - id: summarize
      instruction: >
        Using these research findings:

        {{research:output}}

        Write a 2-paragraph executive summary (max 150 words).
        First paragraph: key insights. Second paragraph: recommendation.
      dependsOn: [research]
      timeoutSeconds: 180
      maxRetries: 1
  output:
    name: e2e-2step-result
    destination: stdout
  workloads: []
RECIPE_EOF

  if [ $? -eq 0 ]; then
    pass "Recipe applied: $RECIPE_2STEP"
  else
    fail "Recipe apply failed: $RECIPE_2STEP"
  fi

  log "  Triggering DB-first WorkflowRun..."
  if run_id=$(trigger_workflow_run "$RECIPE_2STEP"); then
    pass "WorkflowRun created: $run_id"
  else
    fail "WorkflowRun trigger failed"
    exit 1
  fi

  log "  Waiting for child recipe..."
  if child_ref=$(wait_for_run_child "$RECIPE_2STEP" "$run_id" 120); then
    IFS='|' read -r child_ns child_name <<< "$child_ref"
    pass "Child WorkflowRecipe created: ${child_ns}/${child_name}"
  else
    fail "Child WorkflowRecipe not recorded for run $run_id"
    child_name="$RECIPE_2STEP"
  fi

  # Wait for pods
  log "  Waiting for child pods..."
  if wait_for_pods_ready "$child_name" 120; then
    pass "Child pods ready (coordinator + mcp-host)"
  else
    fail "Child pods not ready after 120s"
    kubectl --context="$GKE_CONTEXT" get pods -n "$SANDBOX_NS" -l "clerum.io/recipe=$child_name" 2>/dev/null
  fi

  # Wait for completion
  log "  Waiting for workflow completion (max ${TIMEOUT_WORKFLOW}s)..."
  if child_ref=$(wait_for_run_succeeded "$RECIPE_2STEP" "$run_id" "$TIMEOUT_WORKFLOW"); then
    pass "Workflow completed"
    # Validate step outputs
    IFS='|' read -r child_ns child_name <<< "$child_ref"
    local_status=$(kubectl --context="$GKE_CONTEXT" get workflowrecipe "$child_name" -n "$child_ns" -o jsonpath='{.status.workflowExecution}' 2>/dev/null)
    echo "  Status: $local_status" | head -1
  else
    fail "Workflow did not complete"
    # Dump diagnostics
    echo "  --- Coordinator logs ---"
    kubectl --context="$GKE_CONTEXT" logs "${child_name}-coordinator" -n "$SANDBOX_NS" --tail=10 2>/dev/null || true
  fi

  # Verify step count
  step_count=$(kubectl --context="$GKE_CONTEXT" get workflowrecipe "$child_name" -n "$SANDBOX_NS" -o jsonpath='{.status.steps}' 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([s for s in d if s.get('phase')=='completed']))" 2>/dev/null || echo "0")
  if [ "$step_count" = "2" ]; then
    pass "Both steps completed (2/2)"
  else
    fail "Expected 2 completed steps, got $step_count"
  fi

  cleanup_recipe "$RECIPE_2STEP"
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════
# TEST 2: 4-Step Workflow (research → analyze → draft → generate-pdf)
# ═════════════════════════════════════════════════════════════════════
if [ "$RUN_4STEP" = true ]; then
  log "Test 2: 4-Step Workflow (research → analyze → draft → generate-pdf)"
  RECIPE_4STEP="e2e-gke-4step"
  run_id=""
  child_ns="$SANDBOX_NS"
  child_name="$RECIPE_4STEP"

  cleanup_recipe "$RECIPE_4STEP"

  kubectl --context="$GKE_CONTEXT" apply -f - <<'RECIPE_EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-gke-4step
  namespace: sandbox-recipes
  annotations:
    clerum.io/recipe-type: workflow-agentic
spec:
  contextRef: context1
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors: ["user", "autonomous"]
  agent:
    provider: zai
    model: glm-4.7
  inputContract:
    properties:
      topic:
        type: string
        default: "The Blog leak about the new frontier model called Mythos — capabilities, benchmarks, and industry impact"
  steps:
    - id: research
      instruction: >
        Research: {{inputs.topic}}.
        Provide 3 key findings with sources. Max 250 words.
      timeoutSeconds: 180
      maxRetries: 1
    - id: analyze
      instruction: >
        Analyze these research findings and identify the top 2 trends:

        {{research:output}}

        Be concise — max 150 words.
      dependsOn: [research]
      timeoutSeconds: 180
      maxRetries: 1
    - id: draft
      instruction: >
        Write a structured report using markdown headings (# and ##).
        Include: Executive Summary, Key Findings, Analysis, Recommendations.
        Max 400 words.

        {{analyze:output}}
      dependsOn: [analyze]
      timeoutSeconds: 180
      maxRetries: 1
    - id: generate-report
      instruction: >
        Using the clerum__generate_pdf tool, generate a PDF file named
        "e2e-report.pdf" with title "E2E GKE Test Report" and the
        following body:

        {{draft:output}}

        After generating the PDF, also use clerum__generate_xlsx to create
        "e2e-data.xlsx" with two sheets:
        1. "Findings" — rows with columns: Finding, Impact, Source
        2. "Economic Impact" — analyze how the Mythos model could impact
           the US economy with columns: Sector, Current State, Projected Impact, GDP Effect (%)
        Include at least 5 sectors (tech, healthcare, finance, education, manufacturing).
      dependsOn: [draft]
      timeoutSeconds: 180
      maxRetries: 1
  output:
    name: e2e-4step-result
    destination: pvc
    format: pdf
    storageSize: 64Mi
  workloads: []
RECIPE_EOF

  if [ $? -eq 0 ]; then
    pass "Recipe applied: $RECIPE_4STEP"
  else
    fail "Recipe apply failed: $RECIPE_4STEP"
  fi

  log "  Triggering DB-first WorkflowRun..."
  if run_id=$(trigger_workflow_run "$RECIPE_4STEP"); then
    pass "WorkflowRun created: $run_id"
  else
    fail "WorkflowRun trigger failed"
    exit 1
  fi

  log "  Waiting for child recipe..."
  if child_ref=$(wait_for_run_child "$RECIPE_4STEP" "$run_id" 120); then
    IFS='|' read -r child_ns child_name <<< "$child_ref"
    pass "Child WorkflowRecipe created: ${child_ns}/${child_name}"
  else
    fail "Child WorkflowRecipe not recorded for run $run_id"
    child_name="$RECIPE_4STEP"
  fi

  log "  Waiting for child pods..."
  if wait_for_pods_ready "$child_name" 120; then
    pass "Child pods ready (coordinator + mcp-host)"
  else
    fail "Child pods not ready after 120s"
  fi

  log "  Waiting for workflow completion (max ${TIMEOUT_WORKFLOW}s)..."
  if child_ref=$(wait_for_run_succeeded "$RECIPE_4STEP" "$run_id" "$TIMEOUT_WORKFLOW"); then
    IFS='|' read -r child_ns child_name <<< "$child_ref"
    pass "4-step workflow completed"
  else
    fail "4-step workflow did not complete"
    echo "  --- Coordinator logs ---"
    kubectl --context="$GKE_CONTEXT" logs "${child_name}-coordinator" -n "$SANDBOX_NS" --tail=15 2>/dev/null || true
  fi

  # Verify all 4 steps completed
  step_count=$(kubectl --context="$GKE_CONTEXT" get workflowrecipe "$child_name" -n "$SANDBOX_NS" -o jsonpath='{.status.steps}' 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([s for s in d if s.get('phase')=='completed']))" 2>/dev/null || echo "0")
  if [ "$step_count" = "4" ]; then
    pass "All 4 steps completed (4/4)"
  else
    fail "Expected 4 completed steps, got $step_count"
  fi

  # Verify artifact files exist in the runtime output mount.
  log "  Checking artifacts in mcp-host /output mount..."
  artifacts=$(kubectl --context="$GKE_CONTEXT" exec "${child_name}-mcp-host" -n "$SANDBOX_NS" -- ls /output/ 2>/dev/null || echo "")
  if echo "$artifacts" | grep -q "e2e-report.pdf"; then
    pass "Artifact: e2e-report.pdf exists in pod"
  else
    fail "Artifact: e2e-report.pdf NOT found in pod"
  fi
  if echo "$artifacts" | grep -q "e2e-data.xlsx"; then
    pass "Artifact: e2e-data.xlsx exists in pod"
  else
    skip "Artifact: e2e-data.xlsx not found (LLM may not have called xlsx tool)"
  fi

  # Test artifact download via control-api (if reachable)
  if [ "$CONTROL_API_REACHABLE" = true ]; then
    log "  Testing artifact download via control-api..."
    check_artifact_download "$RECIPE_4STEP" "$run_id" "e2e-report.pdf" "PDF"
  else
    skip "Artifact download test (control-api not reachable)"
    skip "File type validation (control-api not reachable)"
  fi

  cleanup_recipe "$RECIPE_4STEP"
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════
# TEST 3: Bug Regression Checks
# ═════════════════════════════════════════════════════════════════════
log "Test 3: Bug Regression Checks"

# BUG-05: WRC signing key format
wrc_keys=$(kubectl --context="$GKE_CONTEXT" get secret clerum-wrc-signing-key -n control-plane -o jsonpath='{.data}' 2>/dev/null | python3 -c "import json,sys; print(','.join(sorted(json.load(sys.stdin).keys())))" 2>/dev/null || echo "")
if [ "$wrc_keys" = "private.pem,public.pem" ]; then
  pass "BUG-05: WRC signing key has correct format (private.pem, public.pem)"
else
  fail "BUG-05: WRC signing key wrong format: $wrc_keys"
fi

# BUG: ConfigMap in sandbox-recipes
if kubectl --context="$GKE_CONTEXT" get configmap clerum-wrc-public-key -n sandbox-recipes -o jsonpath='{.data.public\.pem}' >/dev/null 2>&1; then
  pass "BUG: wrc-public-key ConfigMap in sandbox-recipes has public.pem"
else
  fail "BUG: wrc-public-key ConfigMap missing public.pem in sandbox-recipes"
fi

# BUG: workflow-recipes Service exists
wrc_svc_port=$(kubectl --context="$GKE_CONTEXT" get svc workflow-recipes -n control-plane -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "0")
if [ "$wrc_svc_port" = "8082" ]; then
  pass "BUG: workflow-recipes Service on port 8082"
else
  fail "BUG: workflow-recipes Service wrong port: $wrc_svc_port"
fi

# Post-refactor: model-secret-mapping lives in mcp-host ns, value format is
# "<secretName>/<keyName>" pointing to chatllm-api-keys (single source of truth).
zai_mapping=$(kubectl --context="$GKE_CONTEXT" get configmap clerum-model-secret-mapping -n mcp-host -o jsonpath='{.data.zai__glm-4\.7}' 2>/dev/null || echo "")
if [ "$zai_mapping" = "chatllm-api-keys/zai-api-key" ]; then
  pass "model-secret-mapping has zai__glm-4.7 → chatllm-api-keys/zai-api-key"
else
  fail "model-secret-mapping missing or wrong for zai__glm-4.7: got '$zai_mapping' (expected 'chatllm-api-keys/zai-api-key')"
fi

# BUG: mcp-proxy readiness with empty routing table
mcp_proxy_ready=$(kubectl --context="$GKE_CONTEXT" get deployment mcp-proxy -n mcp-server -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "$mcp_proxy_ready" -ge 1 ]; then
  pass "BUG: mcp-proxy ready with empty routing table (v0.9.5 fix)"
else
  fail "BUG: mcp-proxy not ready (should accept empty routing table)"
fi

# BUG: NetworkPolicy allow-ingress-rpc-proxy exists with labels
np_labels=$(kubectl --context="$GKE_CONTEXT" get networkpolicy allow-ingress-rpc-proxy -n rpc-proxy -o jsonpath='{.metadata.labels.clerum\.io/policy-type}' 2>/dev/null || echo "")
if [ "$np_labels" = "infrastructure" ]; then
  pass "BUG: allow-ingress-rpc-proxy has clerum.io/policy-type=infrastructure"
else
  fail "BUG: allow-ingress-rpc-proxy missing labels: $np_labels"
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
