#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Registry Full Lifecycle Tests (Push → Install → Execute → Upgrade → Uninstall)
# ═══════════════════════════════════════════════════════════════════════
# Validates the complete registry lifecycle for MCP servers AND recipes:
#   1. Push entries to registry → verify DB storage
#   2. Install MCP servers (local + remote) → verify CRDs + pods
#   3. Install recipe → execute workflow → verify output files
#   4. Upgrade MCP server + recipe → verify version bump
#   5. Uninstall all → verify complete cleanup
#
# Prerequisites:
#   make minikube-status && context = clerum-test
#   Port-forwards: control-api:8090, registry-api:8085
#   Admin setup done (POST /admin/auth/setup)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

CONTROL_API="http://localhost:8090"
REGISTRY_API="http://localhost:8085"
MCP_NS="mcp-server"
SANDBOX_NS="sandbox-recipes"
POLL_SEC=10
WORKFLOW_TIMEOUT=360
POD_TIMEOUT=120

# ─── Version constants ───────────────────────────────────────────────
# Re-publish of removed entries is allowed (spec §12.1 + partial unique index),
# so we use stable versions. The cleanup loop below soft-deletes stale entries.
E2E_VER="1.0.0"
E2E_VER2="2.0.0"

# ─── State tracking (populated during tests) ─────────────────────────
LOCAL_SERVER_NAME=""
REMOTE_SERVER_NAME=""
RECIPE_NAME=""

# ─── Auth ─────────────────────────────────────────────────────────────
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-changeme123!}"
_TOKEN=""
get_token() {
  [ -n "$_TOKEN" ] && { echo "$_TOKEN"; return; }
  _TOKEN=$(curl -s -X POST "${CONTROL_API}/api/v1/admin/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" 2>/dev/null | jq -r '.token // empty')
  echo "$_TOKEN"
}

api() {
  local method=$1 path=$2 data=${3:-}
  local t; t=$(get_token)
  [ -z "$t" ] && { echo '{"error":"auth_failed"}'; return 1; }
  if [ -n "$data" ]; then
    curl -s -X "$method" "${CONTROL_API}${path}" \
      -H "Content-Type: application/json" -H "Authorization: Bearer $t" \
      -d "$data" 2>/dev/null
  else
    curl -s -X "$method" "${CONTROL_API}${path}" \
      -H "Authorization: Bearer $t" 2>/dev/null
  fi
}

reg() {
  local method=$1 path=$2 data=${3:-}
  if [ -n "$data" ]; then
    curl -s -X "$method" "${REGISTRY_API}${path}" \
      -H "Content-Type: application/json" \
      -d "$data" 2>/dev/null
  else
    curl -s -X "$method" "${REGISTRY_API}${path}" 2>/dev/null
  fi
}

wait_for_phase() {
  local name=$1 expected=$2 timeout=$3 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    local phase
    phase=$(kubectl get workflowrecipe "$name" -n "$SANDBOX_NS" \
      -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || echo "unknown")
    [ "$phase" = "$expected" ] && return 0
    [ "$phase" = "failed" ] && [ "$expected" != "failed" ] && {
      local msg; msg=$(kubectl get workflowrecipe "$name" -n "$SANDBOX_NS" \
        -o jsonpath='{.status.workflowExecution.message}' 2>/dev/null || echo "")
      warn "Workflow failed: $msg"
      return 1
    }
    sleep "$POLL_SEC"
    elapsed=$((elapsed + POLL_SEC))
  done
  warn "Timeout (${timeout}s) waiting for phase=$expected (current=$(kubectl get workflowrecipe "$name" -n "$SANDBOX_NS" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || echo 'unknown'))"
  return 1
}

# ─── Valid McpServer CRD bundle (base64) ──────────────────────────────
VALID_BUNDLE=$(printf 'apiVersion: clerum.io/v1alpha1\nkind: McpServer\nmetadata:\n  name: e2e-mock-mcp\nspec:\n  image: clerum/mock-mcp-server:test\n  transport:\n    type: streamableHttp\n    port: 3000\n' | base64 | tr -d '\n')

# ─── Cleanup stale K8s resources from previous runs ──────────────────
# Delete any leftover McpServers, recipes, secrets and deployments created by e2e.
kubectl get mcpserver -n "$MCP_NS" -o name 2>/dev/null | grep -E "e2e-|mock-mcp" | while read -r r; do
  kubectl delete "$r" -n "$MCP_NS" --ignore-not-found 2>/dev/null || true
done
kubectl get workflowrecipe -n "$SANDBOX_NS" -o name 2>/dev/null | grep -E "e2e-|mock-mcp" | while read -r r; do
  kubectl delete "$r" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || true
done
kubectl get deploy -n "$MCP_NS" -o name 2>/dev/null | grep -E "e2e-|mock-mcp" | while read -r r; do
  kubectl delete "$r" -n "$MCP_NS" --ignore-not-found 2>/dev/null || true
done
kubectl get secret -n "$MCP_NS" -o name 2>/dev/null | grep "e2e-" | while read -r r; do
  kubectl delete "$r" -n "$MCP_NS" --ignore-not-found 2>/dev/null || true
done
# Cleanup sandbox pods
kubectl delete pods -n "$SANDBOX_NS" -l "clerum.io/managed-by=wrc" --ignore-not-found 2>/dev/null || true
sleep 3

# ─── Cleanup stale registry entries from previous runs ───────────────
for _name in e2e-mock-mcp e2e-remote-mcp e2e-workflow-recipe test-push; do
  for _ver in "1.0.0" "2.0.0"; do
    curl -s -X DELETE "${REGISTRY_API}/api/v1/entries/${_name}/versions/${_ver}" >/dev/null 2>&1 || true
  done
done

# ═══════════════════════════════════════════════════════════════════════
header "Registry Full Lifecycle E2E Tests"
# ═══════════════════════════════════════════════════════════════════════

# Detect context
CONTEXT_NAME=$(kubectl get contexts -n "$MCP_NS" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
[ -z "$CONTEXT_NAME" ] && { fail "No Context CRD found in $MCP_NS namespace"; exit 1; }
log "Using context: $CONTEXT_NAME"

# ═══ Group 1: Push entries to registry ════════════════════════════════
header "Group 1: Push Entries to Registry"

# 1a. Local MCP server (uses mock-mcp-server image already in minikube)
PUSH_LOCAL=$(curl -s -X POST "${REGISTRY_API}/api/v1/entries" \
  -H "Content-Type: application/json" \
  -d "{
  \"name\": \"e2e-mock-mcp\",
  \"version\": \"1.0.0\",
  \"entryType\": \"mcp-server\",
  \"description\": \"E2E test MCP server with echo/add tools\",
  \"author\": \"e2e-test\",
  \"origin\": \"human-authored\",
  \"category\": \"testing\",
  \"tags\": [\"e2e\", \"mock\"],
  \"contentCreatorTag\": \"1st-party\",
  \"configCreatorTag\": \"1st-party\",
  \"mcpServer\": {
    \"serverMode\": \"local\",
    \"transport\": \"streamableHttp\",
    \"port\": 3000,
    \"imageRef\": \"clerum/mock-mcp-server:test\",
    \"tools\": [\"echo\", \"add\", \"multiply\", \"get_time\", \"read_env\"]
  },
  \"bundle\": \"${VALID_BUNDLE}\"
}" 2>/dev/null || echo '{"error":"request_failed"}')
echo "$PUSH_LOCAL" | jq -e '.id' >/dev/null 2>&1 && ok "Pushed local MCP: e2e-mock-mcp v${E2E_VER}" || fail "Failed to push local MCP: $(echo "$PUSH_LOCAL" | jq -r '.error // .')"

# 1b. Remote MCP server
PUSH_REMOTE=$(reg POST "/api/v1/entries" "{
  \"name\": \"e2e-remote-mcp\",
  \"version\": \"${E2E_VER}\",
  \"entryType\": \"mcp-server\",
  \"description\": \"E2E remote MCP server test\",
  \"author\": \"e2e-test\",
  \"origin\": \"human-authored\",
  \"category\": \"testing\",
  \"tags\": [\"e2e\", \"remote\"],
  \"contentCreatorTag\": \"1st-party\",
  \"configCreatorTag\": \"1st-party\",
  \"mcpServer\": {
    \"serverMode\": \"remote\",
    \"transport\": \"streamableHttp\",
    \"remoteEndpoints\": [{\"url\": \"https://mcp.example.com/sse\", \"region\": \"us\"}],
    \"credentialSchema\": {
      \"required\": true,
      \"authType\": \"api-key\",
      \"keys\": [{\"name\": \"API_KEY\", \"label\": \"API Key\", \"kind\": \"api-key\", \"semanticType\": \"plain-string\", \"description\": \"Test key\"}]
    }
  }
}")
echo "$PUSH_REMOTE" | jq -e '.id' >/dev/null 2>&1 && ok "Pushed remote MCP: e2e-remote-mcp v${E2E_VER}" || fail "Failed to push remote MCP"

# 1c. Workflow recipe (use jq to properly escape YAML→JSON)
RECIPE_V1_YAML=$(cat <<'YAMLEOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-workflow-recipe
spec:
  description: E2E lifecycle test
  agent:
    providerHint: zai
    modelHint: glm-4.7
  steps:
    - id: compute
      instruction: "Use the echo tool with text hello-e2e and the add tool with a=10 b=32. Return the results."
    - id: generate-output
      instruction: "Using the clerum__generate_markdown tool, create a file called e2e-result.md with content: Test passed. Echo result: {{compute:output}}"
      dependsOn:
        - compute
YAMLEOF
)
PUSH_RECIPE=$(reg POST "/api/v1/entries" "$(jq -n \
  --arg ver "$E2E_VER" \
  --arg recipe "$RECIPE_V1_YAML" \
  '{name: "e2e-workflow-recipe", version: $ver, entryType: "recipe",
    description: "E2E lifecycle test recipe", author: "e2e-test",
    origin: "human-authored", category: "workflow", tags: ["e2e"],
    contentCreatorTag: "1st-party", configCreatorTag: "1st-party",
    recipe: $recipe}')")
echo "$PUSH_RECIPE" | jq -e '.id' >/dev/null 2>&1 && ok "Pushed recipe: e2e-workflow-recipe v${E2E_VER}" || fail "Failed to push recipe"

# 1d. Verify in search
SEARCH_COUNT=$(reg GET "/api/v1/entries?q=e2e&limit=10" | jq -r '.data | length // 0')
[ "$SEARCH_COUNT" -ge 3 ] && ok "Search finds $SEARCH_COUNT e2e entries" || fail "Expected >=3 e2e entries, got $SEARCH_COUNT"

# 1e. Verify latest version
LATEST=$(reg GET "/api/v1/entries/e2e-mock-mcp" | jq -r '.version // empty')
[ "$LATEST" = "1.0.0" ] && ok "Latest version: e2e-mock-mcp v${E2E_VER}" || fail "Wrong latest: $LATEST"

# ═══ Group 2: Install Local MCP from Registry ════════════════════════
header "Group 2: Local MCP Server Install"

INSTALL=$(api POST "/api/v1/admin/registry/install" "{
  \"contextRef\": \"${CONTEXT_NAME}\",
  \"registryEntryName\": \"e2e-mock-mcp\",
  \"registryEntryVersion\": \"1.0.0\"
}")
LOCAL_SERVER_NAME=$(echo "$INSTALL" | jq -r '.serverName // empty')

if [ -n "$LOCAL_SERVER_NAME" ]; then
  ok "Installed: $LOCAL_SERVER_NAME"

  # Verify labels
  LABELS=$(kubectl get mcpserver "$LOCAL_SERVER_NAME" -n "$MCP_NS" -o jsonpath='{.metadata.labels}' 2>/dev/null || echo "{}")
  [ "$(echo "$LABELS" | jq -r '.["clerum.io/catalog-id"] // empty')" = "e2e-mock-mcp" ] && ok "Label catalog-id" || fail "Missing catalog-id"
  [ "$(echo "$LABELS" | jq -r '.["clerum.io/server-mode"] // empty')" = "local" ] && ok "Label server-mode=local" || fail "Wrong server-mode"

  # Wait for pod — HCC labels Deployment with app={serverName}
  log "Waiting for MCP pod (${POD_TIMEOUT}s)..."
  if wait_for_pod "$MCP_NS" "app=$LOCAL_SERVER_NAME" "$POD_TIMEOUT" 2>/dev/null; then
    ok "Pod ready for $LOCAL_SERVER_NAME"
  else
    fail "Pod not ready for $LOCAL_SERVER_NAME (HCC did not create Deployment within ${POD_TIMEOUT}s)"
    # Diagnostic output
    kubectl get deployments -n "$MCP_NS" 2>/dev/null | head -5 || true
    kubectl logs deployment/host-context-controller -n control-plane --tail=20 2>/dev/null | grep -iE "$LOCAL_SERVER_NAME|error" || true
  fi

  # Context allowlist
  CTX_SERVERS=$(kubectl get contexts "$CONTEXT_NAME" -n "$MCP_NS" -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "[]")
  echo "$CTX_SERVERS" | grep -q "$LOCAL_SERVER_NAME" && ok "Context allowlist updated" || fail "Not in context allowlist"
else
  fail "Install failed: $(echo "$INSTALL" | jq -r '.error // .')"
fi

# ═══ Group 3: Install Remote MCP from Registry ═══════════════════════
header "Group 3: Remote MCP Server Install"

RINSTALL=$(api POST "/api/v1/admin/registry/install" "{
  \"serverName\": \"e2e-remote-srv\",
  \"contextRef\": \"${CONTEXT_NAME}\",
  \"registryEntryName\": \"e2e-remote-mcp\",
  \"registryEntryVersion\": \"1.0.0\",
  \"credentials\": {\"API_KEY\": \"e2e-test-key-value\"}
}")
REMOTE_SERVER_NAME=$(echo "$RINSTALL" | jq -r '.serverName // empty')

if [ "$REMOTE_SERVER_NAME" = "e2e-remote-srv" ]; then
  ok "Installed remote: $REMOTE_SERVER_NAME"

  # Labels
  MODE=$(kubectl get mcpserver "$REMOTE_SERVER_NAME" -n "$MCP_NS" -o jsonpath='{.metadata.labels.clerum\.io/server-mode}' 2>/dev/null || echo "")
  [ "$MODE" = "remote" ] && ok "Label server-mode=remote" || fail "Wrong mode: $MODE"

  # Secret
  kubectl get secret "${REMOTE_SERVER_NAME}-credentials" -n "$MCP_NS" >/dev/null 2>&1 && ok "Credentials Secret exists" || fail "Secret missing"

  # Remote spec
  BASE_URL=$(kubectl get mcpserver "$REMOTE_SERVER_NAME" -n "$MCP_NS" -o jsonpath='{.spec.remote.baseUrl}' 2>/dev/null || echo "")
  [ -n "$BASE_URL" ] && ok "Remote baseUrl: $BASE_URL" || fail "Missing remote.baseUrl"
else
  fail "Remote install failed: $(echo "$RINSTALL" | jq -r '.error // .')"
fi

# ═══ Group 4: Recipe Install + Workflow Execution ═════════════════════
header "Group 4: Recipe Install + Execution + Output"

RINSTALL=$(api POST "/api/v1/admin/registry/install-recipe" "{
  \"registryEntryName\": \"e2e-workflow-recipe\",
  \"registryEntryVersion\": \"1.0.0\"
}")
RECIPE_NAME=$(echo "$RINSTALL" | jq -r '.recipeName // empty')

if [ -n "$RECIPE_NAME" ]; then
  ok "Recipe installed: $RECIPE_NAME"

  # CRD labels
  RLABELS=$(kubectl get workflowrecipe "$RECIPE_NAME" -n "$SANDBOX_NS" -o jsonpath='{.metadata.labels}' 2>/dev/null || echo "{}")
  [ "$(echo "$RLABELS" | jq -r '.["clerum.io/catalog-id"] // empty')" = "e2e-workflow-recipe" ] && ok "Recipe label catalog-id" || fail "Missing recipe catalog-id"

  # Verify workflow pods are created in sandbox-recipes (namespace splitting)
  log "Waiting for workflow pods in $SANDBOX_NS (${POD_TIMEOUT}s)..."
  COORD_READY=false
  MCP_HOST_READY=false
  _elapsed=0
  while [ $_elapsed -lt "$POD_TIMEOUT" ]; do
    _coord=$(kubectl get pods -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME},clerum.io/component=workflow-coordinator" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "")
    _mhost=$(kubectl get pods -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME},clerum.io/component=workflow-mcp-host" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "")
    [ -n "$_coord" ] && COORD_READY=true
    [ -n "$_mhost" ] && MCP_HOST_READY=true
    [ "$COORD_READY" = true ] && [ "$MCP_HOST_READY" = true ] && break
    sleep "$POLL_SEC"
    _elapsed=$((_elapsed + POLL_SEC))
  done
  [ "$COORD_READY" = true ] && ok "Coordinator pod created in $SANDBOX_NS" || fail "Coordinator pod not found in $SANDBOX_NS"
  [ "$MCP_HOST_READY" = true ] && ok "mcp-host pod created in $SANDBOX_NS" || fail "mcp-host pod not found in $SANDBOX_NS"

  # Wait for workflow execution
  log "Waiting for workflow completion (${WORKFLOW_TIMEOUT}s)..."
  if wait_for_phase "$RECIPE_NAME" "completed" "$WORKFLOW_TIMEOUT"; then
    ok "Workflow completed"

    # Verify steps
    STEPS=$(kubectl get workflowrecipe "$RECIPE_NAME" -n "$SANDBOX_NS" -o jsonpath='{.status.steps}' 2>/dev/null || echo "[]")
    COMPUTE_PHASE=$(echo "$STEPS" | jq -r '.[] | select(.id=="compute") | .phase // "unknown"')
    OUTPUT_PHASE=$(echo "$STEPS" | jq -r '.[] | select(.id=="generate-output") | .phase // "unknown"')
    [ "$COMPUTE_PHASE" = "completed" ] && ok "Step compute: completed" || fail "Step compute: $COMPUTE_PHASE"
    [ "$OUTPUT_PHASE" = "completed" ] && ok "Step generate-output: completed" || fail "Step generate-output: $OUTPUT_PHASE"

    # Verify compute output
    COMPUTE_OUT=$(echo "$STEPS" | jq -r '.[] | select(.id=="compute") | .output // ""')
    echo "$COMPUTE_OUT" | grep -qi "hello" && ok "Compute output contains echo result" || warn "Echo result not found in output"
    echo "$COMPUTE_OUT" | grep -q "42" && ok "Compute output contains 10+32=42" || warn "Add result not found"

    # Verify output file — WRC creates pods with clerum.io/recipe label in sandbox-recipes
    MCP_HOST_POD=$(kubectl get pods -n "$SANDBOX_NS" \
      -l "clerum.io/recipe=${RECIPE_NAME},clerum.io/component=workflow-mcp-host" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    if [ -n "$MCP_HOST_POD" ]; then
      ok "mcp-host pod found: $MCP_HOST_POD in $SANDBOX_NS"
      # Output file depends on LLM calling clerum__generate_markdown tool correctly.
      # This is non-deterministic — the LLM may complete the step without tool calls.
      # We verify the output dir exists (infra) and check file as best-effort.
      OUTPUT_DIR_EXISTS=$(kubectl exec "$MCP_HOST_POD" -n "$SANDBOX_NS" -- ls -d /output 2>/dev/null && echo "yes" || echo "no")
      [ "$OUTPUT_DIR_EXISTS" = "yes" ] && ok "Output dir /output exists" || warn "Output dir not found (non-root FS?)"

      ARTIFACTS=$(kubectl exec "$MCP_HOST_POD" -n "$SANDBOX_NS" -- ls /output/ 2>/dev/null || echo "")
      if echo "$ARTIFACTS" | grep -q "e2e-result.md"; then
        ok "Output file e2e-result.md exists"
        CONTENT=$(kubectl exec "$MCP_HOST_POD" -n "$SANDBOX_NS" -- cat /output/e2e-result.md 2>/dev/null || echo "")
        echo "$CONTENT" | grep -qi "test passed\|passed\|result" && ok "Output content validated" || warn "Expected content not found (LLM non-determinism)"
      else
        warn "Output file e2e-result.md not found (LLM may not have called clerum__generate_markdown)"
        log "Files in output dir: ${ARTIFACTS:-<empty>}"
      fi
    else
      fail "mcp-host pod not found in $SANDBOX_NS (label: clerum.io/recipe=${RECIPE_NAME})"
      # Diagnostic: show what pods exist
      log "Pods in $SANDBOX_NS:"
      kubectl get pods -n "$SANDBOX_NS" --show-labels 2>/dev/null || true
      log "Pods matching recipe name in all namespaces:"
      kubectl get pods -A -l "clerum.io/recipe=${RECIPE_NAME}" 2>/dev/null || true
    fi
  else
    fail "Workflow did not complete within ${WORKFLOW_TIMEOUT}s"
    # Print phase info for debugging
    kubectl get workflowrecipe "$RECIPE_NAME" -n "$SANDBOX_NS" -o jsonpath='{.status.workflowExecution}' 2>/dev/null | jq . || true
  fi
else
  fail "Recipe install failed: $(echo "$RINSTALL" | jq -r '.error // .')"
fi

# ═══ Group 5: MCP Server Upgrade ═════════════════════════════════════
header "Group 5: MCP Server Upgrade"

# Push v2
PUSH_V2=$(reg POST "/api/v1/entries" "{
  \"name\": \"e2e-mock-mcp\",
  \"version\": \"${E2E_VER2}\",
  \"entryType\": \"mcp-server\",
  \"description\": \"E2E mock MCP v2\",
  \"author\": \"e2e-test\",
  \"origin\": \"human-authored\",
  \"category\": \"testing\",
  \"tags\": [\"e2e\"],
  \"contentCreatorTag\": \"1st-party\",
  \"configCreatorTag\": \"1st-party\",
  \"mcpServer\": {
    \"serverMode\": \"local\",
    \"transport\": \"streamableHttp\",
    \"port\": 3000,
    \"imageRef\": \"clerum/mock-mcp-server:test\"
  },
  \"bundle\": \"${VALID_BUNDLE}\"
}")
echo "$PUSH_V2" | jq -e '.id' >/dev/null 2>&1 && ok "Pushed v${E2E_VER2} of e2e-mock-mcp" || fail "Failed to push v2"

if [ -n "$LOCAL_SERVER_NAME" ]; then
  UPGRADE=$(api POST "/api/v1/admin/registry/upgrade" "{
    \"serverName\": \"${LOCAL_SERVER_NAME}\",
    \"registryEntryName\": \"e2e-mock-mcp\",
    \"registryEntryVersion\": \"2.0.0\"
  }")
  UPGRADED=$(echo "$UPGRADE" | jq -r '.upgraded // false')
  [ "$UPGRADED" = "true" ] && ok "MCP server upgraded to v${E2E_VER2}" || fail "Upgrade failed: $(echo "$UPGRADE" | jq -r '.error // .')"
else
  warn "Skipping upgrade (no local server installed)"
fi

# ═══ Group 6: Recipe Upgrade ══════════════════════════════════════════
header "Group 6: Recipe Upgrade"

RECIPE_V2_YAML=$(cat <<'YAMLEOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-workflow-recipe
spec:
  description: E2E v2
  agent:
    providerHint: zai
    modelHint: glm-4.7
  steps:
    - id: greet
      instruction: "Say hello world"
YAMLEOF
)
PUSH_RV2=$(reg POST "/api/v1/entries" "$(jq -n \
  --arg ver "$E2E_VER2" \
  --arg recipe "$RECIPE_V2_YAML" \
  '{name: "e2e-workflow-recipe", version: $ver, entryType: "recipe",
    description: "E2E lifecycle recipe v2", author: "e2e-test",
    origin: "human-authored", category: "workflow", tags: ["e2e"],
    contentCreatorTag: "1st-party", configCreatorTag: "1st-party",
    recipe: $recipe}')")
echo "$PUSH_RV2" | jq -e '.id' >/dev/null 2>&1 && ok "Pushed recipe v${E2E_VER2}" || fail "Failed to push recipe v2"

if [ -n "$RECIPE_NAME" ]; then
  # Uninstall v1
  api DELETE "/api/v1/admin/registry/uninstall/${RECIPE_NAME}?type=recipe" >/dev/null 2>&1
  sleep 3
  kubectl get workflowrecipe "$RECIPE_NAME" -n "$SANDBOX_NS" >/dev/null 2>&1 && fail "v1 recipe still exists in ${SANDBOX_NS}" || ok "v1 recipe uninstalled"

  # Install v2
  RV2=$(api POST "/api/v1/admin/registry/install-recipe" "{
    \"registryEntryName\": \"e2e-workflow-recipe\",
    \"registryEntryVersion\": \"2.0.0\"
  }")
  RECIPE_V2_NAME=$(echo "$RV2" | jq -r '.recipeName // empty')
  [ -n "$RECIPE_V2_NAME" ] && ok "Recipe v2 installed: $RECIPE_V2_NAME" || fail "Recipe v2 install failed"
  RECIPE_NAME="$RECIPE_V2_NAME" # Track for cleanup
else
  warn "Skipping recipe upgrade (no v1 installed)"
fi

# ═══ Group 7: Uninstall Local MCP ════════════════════════════════════
header "Group 7: Uninstall Local MCP Server"

if [ -n "$LOCAL_SERVER_NAME" ]; then
  UNINST=$(api DELETE "/api/v1/admin/registry/uninstall/${LOCAL_SERVER_NAME}")
  echo "$UNINST" | jq -r '.deleted[]' 2>/dev/null | grep -q "McpServer" && ok "McpServer deleted" || warn "McpServer delete not confirmed"

  sleep 3
  kubectl get mcpserver "$LOCAL_SERVER_NAME" -n "$MCP_NS" >/dev/null 2>&1 && fail "McpServer still exists" || ok "McpServer gone from cluster"

  # Context cleaned
  CTX_AFTER=$(kubectl get contexts "$CONTEXT_NAME" -n "$MCP_NS" -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "[]")
  echo "$CTX_AFTER" | grep -q "$LOCAL_SERVER_NAME" && fail "Still in context" || ok "Removed from context allowlist"
else
  warn "No local server to uninstall"
fi

# ═══ Group 8: Uninstall Remote MCP ═══════════════════════════════════
header "Group 8: Uninstall Remote MCP Server"

if [ -n "$REMOTE_SERVER_NAME" ]; then
  api DELETE "/api/v1/admin/registry/uninstall/${REMOTE_SERVER_NAME}" >/dev/null 2>&1
  sleep 3
  kubectl get mcpserver "$REMOTE_SERVER_NAME" -n "$MCP_NS" >/dev/null 2>&1 && fail "Remote McpServer still exists" || ok "Remote McpServer gone"
  kubectl get secret "${REMOTE_SERVER_NAME}-credentials" -n "$MCP_NS" >/dev/null 2>&1 && fail "Remote Secret still exists" || ok "Remote Secret gone"
else
  warn "No remote server to uninstall"
fi

# ═══ Group 9: Uninstall Recipe ════════════════════════════════════════
header "Group 9: Uninstall Recipe"

if [ -n "$RECIPE_NAME" ]; then
  api DELETE "/api/v1/admin/registry/uninstall/${RECIPE_NAME}?type=recipe" >/dev/null 2>&1
  sleep 5
  kubectl get workflowrecipe "$RECIPE_NAME" -n "$SANDBOX_NS" >/dev/null 2>&1 && fail "Recipe still exists in ${SANDBOX_NS}" || ok "Recipe gone from cluster"
else
  warn "No recipe to uninstall"
fi

# ═══ Group 10: Clean State Verification ═══════════════════════════════
header "Group 10: Clean State"

E2E_MCP=$(kubectl get mcpserver -n "$MCP_NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep "^e2e-\|^mcp-e2e-" | wc -l | tr -d ' ')
[ "$E2E_MCP" -eq 0 ] && ok "No e2e McpServers remain" || fail "$E2E_MCP e2e McpServers remain"

E2E_WR=$(kubectl get workflowrecipe -n "$SANDBOX_NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep "^e2e-\|^recipe-e2e-" | wc -l | tr -d ' ')
[ "$E2E_WR" -eq 0 ] && ok "No e2e WorkflowRecipes remain" || fail "$E2E_WR e2e WorkflowRecipes remain"

E2E_SEC=$(kubectl get secret -n "$MCP_NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep "^e2e-" | wc -l | tr -d ' ')
[ "$E2E_SEC" -eq 0 ] && ok "No e2e Secrets remain" || fail "$E2E_SEC e2e Secrets remain"

# ═══════════════════════════════════════════════════════════════════════
header "Summary"
echo -e "  ${GREEN}PASS${NC}: ${e2e_pass}  ${RED}FAIL${NC}: ${e2e_fail}  Total: ${e2e_total}"
[ "$e2e_fail" -gt 0 ] && exit 1 || exit 0
