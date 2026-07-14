#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Registry Install Flow Tests
# ═══════════════════════════════════════════════════════════════════════
# Validates: registry health, catalog seeding, local/remote MCP install,
#            recipe install, naming convention, labels, context allowlist,
#            and report-install quality promotion.
#
# Prerequisites:
#   make minikube-status  (all services OK)
#   kubectl --context=clerum-test port-forward -n control-plane svc/control-api 8090:8090 &
#   kubectl --context=clerum-test port-forward -n registry svc/registry-api 8085:8085 &

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

CONTROL_API="${CONTROL_API_BASE_URL:-http://127.0.0.1:8090}"
REGISTRY_API="${REGISTRY_API_BASE_URL:-http://127.0.0.1:8085}"
REGISTRY_NS="registry"
MCP_NS="mcp-server"
SANDBOX_NS="sandbox-recipes"
KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-${MINIKUBE_PROFILE:-clerum-test}}"
KC=(kubectl --context="${KUBECTL_CONTEXT}")

# ─── Auth ─────────────────────────────────────────────────────────────
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-changeme123!}"
_CACHED_TOKEN=""
get_admin_token() {
  if [ -n "$_CACHED_TOKEN" ]; then
    echo "$_CACHED_TOKEN"
    return
  fi
  local resp
  resp=$(curl -sf -X POST "${CONTROL_API}/api/v1/admin/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" 2>/dev/null || echo "")
  _CACHED_TOKEN=$(echo "$resp" | jq -r '.token // empty')
  echo "$_CACHED_TOKEN"
}

api() {
  local method=$1 path=$2 data=${3:-}
  local token
  token=$(get_admin_token)
  if [ -z "$token" ]; then
    echo '{"error":"auth_failed"}'
    return 1
  fi
  if [ -n "$data" ]; then
    curl -sf -X "$method" "${CONTROL_API}${path}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$data" 2>/dev/null || echo '{"error":"request_failed"}'
  else
    curl -sf -X "$method" "${CONTROL_API}${path}" \
      -H "Authorization: Bearer $token" 2>/dev/null || echo '{"error":"request_failed"}'
  fi
}

cleanup_registry_resource() {
  local resource_name=$1
  local resource_type=${2:-mcp-server}
  local result

  result=$(api DELETE "/api/v1/admin/registry/uninstall/${resource_name}?type=${resource_type}")
  if echo "$result" | jq -e --arg n "$resource_name" --arg t "$resource_type" \
    '.resourceName == $n and .resourceType == $t and ((.warnings // []) | length == 0) and ((.deleted // []) | length > 0)' >/dev/null 2>&1; then
    ok "Cleanup via uninstall API completed for ${resource_type} ${resource_name}"
  else
    echo "$result" >&2
    fail "Cleanup via uninstall API failed for ${resource_type} ${resource_name}"
  fi
}

if [[ "${E2E_REGISTRY_INSTALL_LIB_ONLY:-}" == "true" ]]; then
  return 0 2>/dev/null || exit 0
fi

# ═══════════════════════════════════════════════════════════════════════
header "Registry Install E2E Tests"
# ═══════════════════════════════════════════════════════════════════════

# ── Test 1: Registry health ────────────────────────────────────────────
header "Test 1: Registry Health"
HEALTH=$(curl -sf "${REGISTRY_API}/health" 2>/dev/null || echo "")
if echo "$HEALTH" | jq -e '.status' >/dev/null 2>&1; then
  ok "Registry service is healthy"
else
  fail "Registry service not responding at ${REGISTRY_API}/health"
fi

# ── Test 2: Seed catalog ──────────────────────────────────────────────
header "Test 2: Seed Catalog"
ENTRY_COUNT=$(curl -sf "${REGISTRY_API}/api/v1/entries?limit=1" 2>/dev/null | jq -r '.meta.total // 0')
if [ "$ENTRY_COUNT" -gt 0 ]; then
  ok "Registry has $ENTRY_COUNT entries (already seeded)"
else
  "${KC[@]}" exec -n "$REGISTRY_NS" deploy/registry-api -- npm run seed 2>/dev/null || true
  sleep 2
  ENTRY_COUNT=$(curl -sf "${REGISTRY_API}/api/v1/entries?limit=1" 2>/dev/null | jq -r '.meta.total // 0')
  if [ "$ENTRY_COUNT" -gt 0 ]; then
    ok "Seeded $ENTRY_COUNT entries"
  else
    fail "Failed to seed registry catalog"
  fi
fi

# ── Test 3: Search via control-api ────────────────────────────────────
header "Test 3: Search Catalog via control-api"
SEARCH=$(api GET "/api/v1/admin/registry/entries?entryType=mcp-server&limit=5")
SEARCH_COUNT=$(echo "$SEARCH" | jq -r '.data | length // 0')
if [ "$SEARCH_COUNT" -gt 0 ]; then
  ok "Found $SEARCH_COUNT MCP servers via control-api proxy"
else
  fail "No MCP servers found via control-api"
fi

# ── Test 4: Local MCP Server Install (auto-naming) ────────────────────
header "Test 4: Local MCP Install + Auto-naming + Labels"
LOCAL_ENTRY=$(curl -sf "${REGISTRY_API}/api/v1/entries?entryType=mcp-server&serverMode=local&limit=1" 2>/dev/null | jq -r '.data[0].name // empty')
LOCAL_VERSION=""
if [ -z "$LOCAL_ENTRY" ]; then
  warn "No local MCP server in registry, skipping"
else
  LOCAL_VERSION=$(curl -sf "${REGISTRY_API}/api/v1/entries/${LOCAL_ENTRY}" 2>/dev/null | jq -r '.version // "1.0.0"')
  CONTEXT_EXISTS=$(api GET "/api/v1/admin/contexts" | jq -r '.items[0].metadata.name // empty')

  if [ -z "$CONTEXT_EXISTS" ]; then
    warn "No context found, skipping (create a context first)"
  else
    INSTALL_RESULT=$(api POST "/api/v1/admin/registry/install" "{
      \"contextRef\": \"${CONTEXT_EXISTS}\",
      \"registryEntryName\": \"${LOCAL_ENTRY}\",
      \"registryEntryVersion\": \"${LOCAL_VERSION}\"
    }")

    SERVER_NAME=$(echo "$INSTALL_RESULT" | jq -r '.serverName // empty')
    if [ -n "$SERVER_NAME" ]; then
      ok "Local MCP installed: $SERVER_NAME"

      # Verify name follows spec pattern
      if echo "$SERVER_NAME" | grep -qE '^mcp-.*-v[0-9].*-[a-f0-9]{8}$'; then
        ok "Name follows spec pattern mcp-{slug}-v{ver}-{hash8}"
      else
        fail "Name doesn't match pattern: $SERVER_NAME"
      fi

      # Verify labels
      LABELS=$("${KC[@]}" get mcpserver "$SERVER_NAME" -n "$MCP_NS" -o jsonpath='{.metadata.labels}' 2>/dev/null || echo "{}")
      CATALOG_ID=$(echo "$LABELS" | jq -r '.["clerum.io/catalog-id"] // empty')
      [ "$CATALOG_ID" = "$LOCAL_ENTRY" ] && ok "Label clerum.io/catalog-id=$CATALOG_ID" || fail "Wrong catalog-id label: $CATALOG_ID"

      MANAGED=$(echo "$LABELS" | jq -r '.["clerum.io/managed-by"] // empty')
      [ "$MANAGED" = "control-api" ] && ok "Label clerum.io/managed-by=control-api" || fail "Missing managed-by label"

      MODE=$(echo "$LABELS" | jq -r '.["clerum.io/server-mode"] // empty')
      [ "$MODE" = "local" ] && ok "Label clerum.io/server-mode=local" || fail "Wrong server-mode: $MODE"

      # Verify context allowlist
      CTX_SERVERS=$(api GET "/api/v1/admin/contexts" | jq -r --arg n "$CONTEXT_EXISTS" '.items[] | select(.metadata.name==$n) | .spec.mcpServers[]' 2>/dev/null || echo "")
      echo "$CTX_SERVERS" | grep -q "$SERVER_NAME" && ok "Context allowlist includes $SERVER_NAME" || fail "Not in context allowlist"

      # Cleanup
      cleanup_registry_resource "$SERVER_NAME" "mcp-server"
    else
      fail "Local install failed: $(echo "$INSTALL_RESULT" | jq -r '.error // "unknown"')"
    fi
  fi
fi

# ── Test 5: Remote MCP Server Install ─────────────────────────────────
header "Test 5: Remote MCP Install + Egress Proxy"
REMOTE_ENTRY=$(curl -sf "${REGISTRY_API}/api/v1/entries?entryType=mcp-server&serverMode=remote&limit=1" 2>/dev/null | jq -r '.data[0].name // empty')
if [ -z "$REMOTE_ENTRY" ]; then
  warn "No remote MCP server in registry, skipping"
else
  REMOTE_VERSION=$(curl -sf "${REGISTRY_API}/api/v1/entries/${REMOTE_ENTRY}" 2>/dev/null | jq -r '.version // "1.0.0"')
  CONTEXT_EXISTS=$(api GET "/api/v1/admin/contexts" | jq -r '.items[0].metadata.name // empty')

  if [ -z "$CONTEXT_EXISTS" ]; then
    warn "No context, skipping"
  else
    CRED_SCHEMA=$(curl -sf "${REGISTRY_API}/api/v1/entries/${REMOTE_ENTRY}/versions/${REMOTE_VERSION}/credential-schema" 2>/dev/null || echo "{}")
    CRED_REQUIRED=$(echo "$CRED_SCHEMA" | jq -r '.required // false')

    INSTALL_BODY="{\"serverName\":\"e2e-remote-test\",\"contextRef\":\"${CONTEXT_EXISTS}\",\"registryEntryName\":\"${REMOTE_ENTRY}\",\"registryEntryVersion\":\"${REMOTE_VERSION}\"}"
    if [ "$CRED_REQUIRED" = "true" ]; then
      CREDS="{}"
      for key in $(echo "$CRED_SCHEMA" | jq -r '.keys[].name' 2>/dev/null); do
        CREDS=$(echo "$CREDS" | jq --arg k "$key" --arg v "e2e-test-value" '.[$k] = $v')
      done
      INSTALL_BODY=$(echo "$INSTALL_BODY" | jq --argjson c "$CREDS" '. + {credentials: $c}')
    fi

    RESULT=$(api POST "/api/v1/admin/registry/install" "$INSTALL_BODY")
    RNAME=$(echo "$RESULT" | jq -r '.serverName // empty')

    if [ "$RNAME" = "e2e-remote-test" ]; then
      ok "Remote MCP installed: $RNAME"

      MODE=$("${KC[@]}" get mcpserver "$RNAME" -n "$MCP_NS" -o jsonpath='{.metadata.labels.clerum\.io/server-mode}' 2>/dev/null || echo "")
      [ "$MODE" = "remote" ] && ok "Label server-mode=remote" || fail "Wrong mode: $MODE"

      # Cleanup
      cleanup_registry_resource "$RNAME" "mcp-server"
    else
      fail "Remote install failed: $(echo "$RESULT" | jq -r '.error // "unknown"')"
    fi
  fi
fi

# ── Test 6: Recipe Install ────────────────────────────────────────────
header "Test 6: Recipe Install from Registry"
RECIPE_ENTRY=$(curl -sf "${REGISTRY_API}/api/v1/entries?entryType=recipe&limit=1" 2>/dev/null | jq -r '.data[0].name // empty')
if [ -z "$RECIPE_ENTRY" ]; then
  warn "No recipes in registry, skipping"
else
  RECIPE_VERSION=$(curl -sf "${REGISTRY_API}/api/v1/entries/${RECIPE_ENTRY}" 2>/dev/null | jq -r '.version // "1.0.0"')
  RESULT=$(api POST "/api/v1/admin/registry/install-recipe" "{
    \"registryEntryName\": \"${RECIPE_ENTRY}\",
    \"registryEntryVersion\": \"${RECIPE_VERSION}\"
  }")

  RNAME=$(echo "$RESULT" | jq -r '.recipeName // empty')
  if [ -n "$RNAME" ]; then
    ok "Recipe installed: $RNAME"
    "${KC[@]}" get workflowrecipe "$RNAME" -n "$SANDBOX_NS" >/dev/null 2>&1 && ok "WorkflowRecipe CRD exists in ${SANDBOX_NS}" || fail "WorkflowRecipe CRD not found in ${SANDBOX_NS}"
    cleanup_registry_resource "$RNAME" "recipe"
  else
    fail "Recipe install failed: $(echo "$RESULT" | jq -r '.error // "unknown"')"
  fi
fi

# ── Test 7: Report-install ────────────────────────────────────────────
header "Test 7: Report-Install"
if [ -n "$LOCAL_ENTRY" ] && [ -n "$LOCAL_VERSION" ]; then
  REPORT=$(api POST "/api/v1/admin/registry/entries/${LOCAL_ENTRY}/report-install" "{
    \"correlationId\": \"e2e-$(date +%s)\",
    \"version\": \"${LOCAL_VERSION}\"
  }")
  echo "$REPORT" | jq -e '.acknowledged' >/dev/null 2>&1 && ok "Report-install acknowledged" || fail "Report-install failed"
else
  warn "Skipping (no local entry)"
fi

# ═══════════════════════════════════════════════════════════════════════
print_results
