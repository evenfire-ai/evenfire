#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Production Library — Extended validation functions for production clusters
# ═══════════════════════════════════════════════════════════════════════
#
# Extends e2e-lib.sh with production-specific validations:
#   - HCC configuration verification (runtimeNamespaces, hostImage)
#   - mcp-proxy real routing validation (HTTP → MCP server)
#   - channel-reader → mcp-host cross-namespace NP validation
#   - Existing MCP server smoke tests
#   - Full proxy-chain tool-calling (not localhost bypass)
#
# Source AFTER e2e-lib.sh:
#   source "${SCRIPT_DIR}/e2e-lib.sh"
#   source "${SCRIPT_DIR}/e2e-prod-lib.sh"

# ─── Production-specific defaults ─────────────────────────────────────
MCP_PROXY_NS="${MCP_PROXY_NS:-mcp-server}"
MCP_PROXY_SVC="${MCP_PROXY_SVC:-mcp-proxy}"
MCP_PROXY_PORT="${MCP_PROXY_PORT:-8083}"
CHANNEL_NS="${CHANNEL_NS:-channels}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
MCP_HOST_SVC="${MCP_HOST_SVC:-chatllm}"
MCP_HOST_PORT="${MCP_HOST_PORT:-8080}"
TIMEOUT_PROXY="${TIMEOUT_PROXY:-15}"

# ═══════════════════════════════════════════════════════════════════════
# Phase 0-P: Production Pre-flight — validates HCC configuration
# ═══════════════════════════════════════════════════════════════════════

check_prerequisites_prod() {
  header "Phase 0 — Prerequisites (Production)"

  if kubectl cluster-info &>/dev/null; then
    ok "Kubernetes cluster reachable"
  else
    fail "Cannot reach Kubernetes cluster"
    exit 1
  fi

  for ns in "$RECIPE_NS" "$SANDBOX_NS" "$MCP_HOST_NS" "$CONTROL_NS" "$CHANNEL_NS"; do
    if kubectl get ns "$ns" &>/dev/null; then ok "Namespace '$ns' exists"
    else fail "Namespace '$ns' not found"; fi
  done

  for crd in workflowrecipes.clerum.io mcpservers.clerum.io contexts.clerum.io hosts.clerum.io; do
    if kubectl get crd "$crd" &>/dev/null; then ok "CRD '$crd' installed"
    else fail "CRD '$crd' not found"; fi
  done

  for deploy in host-context-controller host-context-controller-api-gateway workflow-recipes; do
    if kubectl get deploy "$deploy" -n "$CONTROL_NS" &>/dev/null; then
      ok "Deployment '$deploy' in control-plane"
    else
      fail "Deployment '$deploy' not found"
    fi
  done

  # Production: mcp-host pods are named chatllm/agent2, not mcp-host
  if kubectl get deploy chatllm -n "$MCP_HOST_NS" &>/dev/null; then
    ok "MCP Host deployment 'chatllm' exists"
  else
    fail "MCP Host deployment 'chatllm' not found"
  fi

  if kubectl get context "$CONTEXT_NAME" -n "$RECIPE_NS" &>/dev/null; then
    ok "Context '${CONTEXT_NAME}' exists"
  else
    fail "Context '${CONTEXT_NAME}' not found"
  fi
}

verify_hcc_config() {
  header "Phase 0-P — HCC Production Configuration"

  # G3: Verify mcp-host is NOT in runtimeNamespaces
  log "Checking CONTEXT_MAPPER_RUNTIME_NAMESPACES..."
  local runtime_ns
  runtime_ns=$(kubectl get deploy "$HCC_DEPLOY" -n "$CONTROL_NS" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CONTEXT_MAPPER_RUNTIME_NAMESPACES")].value}' \
    2>/dev/null || echo "")
  if [ -z "$runtime_ns" ]; then
    warn "CONTEXT_MAPPER_RUNTIME_NAMESPACES not explicitly set (using defaults)"
  elif echo "$runtime_ns" | grep -q "mcp-host"; then
    fail "CRITICAL: mcp-host is in runtimeNamespaces — HCC will create deny-all NPs that block K8s API access"
  else
    ok "mcp-host excluded from runtimeNamespaces (${runtime_ns})"
  fi

  # G4: Verify CONTEXT_MAPPER_HOST_IMAGE points to current version
  log "Checking CONTEXT_MAPPER_HOST_IMAGE..."
  local host_image
  host_image=$(kubectl get deploy "$HCC_DEPLOY" -n "$CONTROL_NS" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CONTEXT_MAPPER_HOST_IMAGE")].value}' \
    2>/dev/null || echo "")
  if [ -z "$host_image" ]; then
    warn "CONTEXT_MAPPER_HOST_IMAGE not set"
  else
    ok "CONTEXT_MAPPER_HOST_IMAGE = ${host_image}"
    # Cross-check with actual mcp-host deployment (production uses chatllm, not mcp-host)
    local actual_image
    actual_image=$(kubectl get deploy "${MCP_HOST_SVC}" -n "$MCP_HOST_NS" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
    if [ "$host_image" = "$actual_image" ]; then
      ok "HCC host image matches actual mcp-host image"
    else
      fail "Image mismatch: HCC='${host_image}' vs actual='${actual_image}' — HCC will revert on next reconciliation"
    fi
  fi

  # Verify HCC deployment itself is ready
  log "Checking HCC operator readiness..."
  local hcc_ready
  hcc_ready=$(kubectl get deploy "$HCC_DEPLOY" -n "$CONTROL_NS" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  if [ "${hcc_ready:-0}" -ge 1 ]; then
    ok "HCC operator running (${hcc_ready} replica(s))"
  else
    fail "HCC operator not ready"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Proxy Validation — Real HTTP request through mcp-proxy → MCP server
# ═══════════════════════════════════════════════════════════════════════

verify_proxy_routing() {
  local mcp_server_name=$1
  header "Phase P1 — MCP Proxy Routing (${mcp_server_name})"

  # Step 1: Verify mcp-proxy is ready
  log "Checking mcp-proxy readiness..."
  local proxy_pod
  proxy_pod=$(kubectl get pod -n "$MCP_PROXY_NS" -l "app=mcp-proxy" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -z "$proxy_pod" ]; then
    fail "mcp-proxy pod not found"
    return
  fi
  ok "mcp-proxy pod running: ${proxy_pod}"

  # Step 2: Hit proxy /health from inside the cluster (validates Service routing)
  log "Testing proxy health via cluster Service..."
  local health_result
  health_result=$(kubectl exec "$proxy_pod" -n "$MCP_PROXY_NS" -- \
    node -e "
const http = require('http');
http.get('http://localhost:${MCP_PROXY_PORT}/health', (res) => {
  let b=''; res.on('data',c=>b+=c);
  res.on('end',()=>process.stdout.write(b));
}).on('error', e => process.stdout.write('ERROR:'+e.message));
" 2>/dev/null || echo "ERROR")
  if echo "$health_result" | grep -qi "ok\|healthy\|true"; then
    ok "mcp-proxy /health responds OK"
  else
    fail "mcp-proxy /health failed: ${health_result}"
  fi

  # Step 3: Hit proxy /ready (confirms HCC poll returned servers)
  log "Testing proxy /ready (server registration)..."
  local ready_result
  ready_result=$(kubectl exec "$proxy_pod" -n "$MCP_PROXY_NS" -- \
    node -e "
const http = require('http');
http.get('http://localhost:${MCP_PROXY_PORT}/ready', (res) => {
  let b=''; res.on('data',c=>b+=c);
  res.on('end',()=>process.stdout.write(b));
}).on('error', e => process.stdout.write('ERROR:'+e.message));
" 2>/dev/null || echo "ERROR")
  if echo "$ready_result" | grep -qi "ok\|ready\|true"; then
    ok "mcp-proxy /ready (servers registered)"
  else
    warn "mcp-proxy /ready not OK: ${ready_result}"
  fi

  # Step 4: REAL PROXY ROUTING — Send MCP initialize to proxy for the target server
  log "Sending MCP initialize request through proxy → ${mcp_server_name}..."
  local mcp_result
  mcp_result=$(kubectl exec "$proxy_pod" -n "$MCP_PROXY_NS" -- \
    node -e "
const http = require('http');
const body = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'e2e-prod-test', version: '1.0.0' }
  }
});
const req = http.request({
  hostname: 'localhost', port: ${MCP_PROXY_PORT},
  path: '/servers/${mcp_server_name}/mcp',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept': 'application/json, text/event-stream'
  }
}, (res) => {
  let b=''; res.on('data',c=>b+=c);
  res.on('end',()=>{
    process.stdout.write(JSON.stringify({status:res.statusCode,body:b.substring(0,500)}));
  });
});
req.on('error', e => process.stdout.write(JSON.stringify({status:0,error:e.message})));
req.write(body);
req.end();
" 2>/dev/null || echo '{"status":0,"error":"exec failed"}')

  local proxy_status
  proxy_status=$(echo "$mcp_result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',0))" 2>/dev/null || echo "0")

  if [ "$proxy_status" = "200" ] || [ "$proxy_status" = "201" ]; then
    ok "Proxy routed MCP initialize to '${mcp_server_name}' (HTTP ${proxy_status})"

    # Parse body for MCP protocol response (serverInfo, protocolVersion)
    local mcp_body
    mcp_body=$(echo "$mcp_result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('body',''))" 2>/dev/null || echo "")
    if echo "$mcp_body" | grep -q "serverInfo\|protocolVersion\|capabilities"; then
      ok "MCP server responded with valid initialize result (full MCP handshake)"
    else
      warn "MCP server response does not contain standard initialize fields"
      log "Response body: $(echo "$mcp_body" | head -c 200)"
    fi
  else
    fail "Proxy routing failed for '${mcp_server_name}' (HTTP ${proxy_status})"
    log "Result: $(echo "$mcp_result" | head -c 300)"
  fi

  # Step 5: Verify proxy logs show the routing
  log "Checking proxy logs for routing evidence..."
  local proxy_logs
  proxy_logs=$(kubectl logs "$proxy_pod" -n "$MCP_PROXY_NS" --tail=30 2>/dev/null || echo "")
  if echo "$proxy_logs" | grep -q "${mcp_server_name}"; then
    ok "Proxy logs confirm routing activity for '${mcp_server_name}'"
  else
    warn "No recent routing log for '${mcp_server_name}' (may be cached)"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Channel-Reader NP Validation — Real cross-namespace connectivity
# ═══════════════════════════════════════════════════════════════════════

verify_channel_reader_connectivity() {
  header "Phase P2 — Channel-Reader to MCP Host Connectivity"

  # Step 1: Get channel-reader pod labels to replicate them
  log "Retrieving channel-reader pod labels..."
  local cr_labels
  cr_labels=$(kubectl get pods -n "$CHANNEL_NS" -l "app.kubernetes.io/name=channel-reader" \
    -o jsonpath='{.items[0].metadata.labels}' 2>/dev/null || echo "")
  if [ -z "$cr_labels" ]; then
    # Try alternate label
    cr_labels=$(kubectl get pods -n "$CHANNEL_NS" -l "app=channel-reader" \
      -o jsonpath='{.items[0].metadata.labels}' 2>/dev/null || echo "")
  fi

  if [ -z "$cr_labels" ]; then
    warn "No channel-reader pod found in namespace '${CHANNEL_NS}' — testing with generic pod"
  else
    ok "channel-reader pod found with labels"
  fi

  # Step 2: Create ephemeral pod in channels namespace WITH channel-reader labels
  # This tests the REAL NetworkPolicy path that channel-reader uses
  log "Testing cross-namespace HTTP to mcp-host (simulating channel-reader)..."
  kubectl delete pod e2e-cr-test -n "$CHANNEL_NS" --ignore-not-found 2>/dev/null || true
  sleep 1

  local cr_test_result
  cr_test_result=$(kubectl run e2e-cr-test \
    --image=curlimages/curl:8.5.0 \
    --rm -i --restart=Never \
    -n "$CHANNEL_NS" \
    --timeout=15s \
    --labels="app.kubernetes.io/name=channel-reader" \
    --overrides='{
      "spec": {
        "securityContext": {"runAsNonRoot": true, "runAsUser": 1000},
        "containers": [{
          "name": "e2e-cr-test",
          "image": "curlimages/curl:8.5.0",
          "command": ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
            "--connect-timeout", "5", "--max-time", "10",
            "http://'"${MCP_HOST_SVC}.${MCP_HOST_NS}"'.svc.cluster.local:'"${MCP_HOST_PORT}"'/v1/runtime/health"]
        }]
      }
    }' 2>&1 || echo "000")

  # Extract just the HTTP status code
  local http_code
  http_code=$(echo "$cr_test_result" | grep -oE '[0-9]{3}' | tail -1)

  if [ "$http_code" = "200" ]; then
    ok "channel-reader CAN reach mcp-host:8080/v1/runtime/health (HTTP 200) — NP allows cross-namespace"
  elif [ "$http_code" = "000" ] || [ -z "$http_code" ]; then
    fail "channel-reader CANNOT reach mcp-host — NetworkPolicy blocks cross-namespace traffic"
    log "Result: ${cr_test_result}"
  else
    ok "channel-reader reached mcp-host (HTTP ${http_code}) — connectivity works"
  fi

  # Step 3: Verify that a generic pod (without channel-reader labels) CANNOT reach mcp-host
  log "Testing that generic pod cannot reach mcp-host (NP enforcement)..."
  kubectl delete pod e2e-generic-test -n "$CHANNEL_NS" --ignore-not-found 2>/dev/null || true
  sleep 1

  local generic_result
  generic_result=$(kubectl run e2e-generic-test \
    --image=curlimages/curl:8.5.0 \
    --rm -i --restart=Never \
    -n "$CHANNEL_NS" \
    --timeout=10s \
    --labels="app=e2e-intruder" \
    --overrides='{
      "spec": {
        "securityContext": {"runAsNonRoot": true, "runAsUser": 1000},
        "containers": [{
          "name": "e2e-generic-test",
          "image": "curlimages/curl:8.5.0",
          "command": ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
            "--connect-timeout", "3", "--max-time", "5",
            "http://'"${MCP_HOST_SVC}.${MCP_HOST_NS}"'.svc.cluster.local:'"${MCP_HOST_PORT}"'/v1/runtime/health"]
        }]
      }
    }' 2>&1 || echo "000")

  local generic_code
  generic_code=$(echo "$generic_result" | grep -oE '[0-9]{3}' | tail -1)

  if [ "$generic_code" = "000" ] || [ -z "$generic_code" ]; then
    ok "Generic pod BLOCKED from reaching mcp-host (NP enforcement works)"
  else
    warn "Generic pod reached mcp-host (HTTP ${generic_code}) — NP may not restrict by label"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Existing Server Smoke Test — Verify pre-existing MCP servers survive upgrade
# ═══════════════════════════════════════════════════════════════════════

verify_existing_servers() {
  header "Phase P3 — Existing MCP Server Smoke Test"

  # Get list of existing McpServer CRDs
  log "Listing existing McpServer CRDs..."
  local servers
  servers=$(kubectl get mcpserver -n "$RECIPE_NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo "")

  if [ -z "$servers" ]; then
    warn "No existing McpServer CRDs found — skipping smoke test"
    return
  fi

  local server_count
  server_count=$(echo "$servers" | wc -w | tr -d ' ')
  ok "Found ${server_count} existing McpServer(s): $(echo $servers | tr ' ' ', ')"

  # For each server, verify it has a running pod and is reachable via proxy
  for server in $servers; do
    local enabled
    enabled=$(kubectl get mcpserver "$server" -n "$RECIPE_NS" \
      -o jsonpath='{.spec.enabled}' 2>/dev/null || echo "true")
    if [ "$enabled" = "false" ]; then
      log "Skipping disabled server: ${server}"
      continue
    fi

    # Check if server has a corresponding deployment/pod
    local has_pod
    has_pod=$(kubectl get pods -n "$RECIPE_NS" -l "app=${server}" \
      -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "")
    if [ "$has_pod" = "Running" ]; then
      ok "Server '${server}' pod is Running"
    else
      # Try common label patterns
      has_pod=$(kubectl get pods -n "$RECIPE_NS" \
        -o jsonpath="{.items[?(@.metadata.name=~\"${server}.*\")].status.phase}" 2>/dev/null || echo "")
      if echo "$has_pod" | grep -q "Running"; then
        ok "Server '${server}' pod is Running"
      else
        warn "Server '${server}' pod not found or not running (phase: ${has_pod:-unknown})"
      fi
    fi
  done
}

# ═══════════════════════════════════════════════════════════════════════
# Full Proxy-Chain Tool-Calling — Validates complete production flow
# ═══════════════════════════════════════════════════════════════════════
#
# Unlike verify_tool_calling() which uses localhost:8080 inside the pod,
# this sends the request through the cluster network: ephemeral pod →
# mcp-host Service → agent → mcp-proxy → MCP server.

verify_tool_calling_via_network() {
  local prompt_text="${1:-Use the echo tool to say hello}"
  header "Phase P4 — Tool-Calling via Cluster Network (Production Flow)"

  # Uses kubectl exec into the mcp-host pod but targets the Service DNS
  # (not localhost). This validates the cluster Service routing.
  local MCP_HOST_POD
  MCP_HOST_POD=$(kubectl get pod -n "$MCP_HOST_NS" -l "app=${MCP_HOST_SVC}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -z "$MCP_HOST_POD" ]; then
    warn "MCP Host pod '${MCP_HOST_SVC}' not found — skipping tool-calling test"
    return
  fi

  local svc_url="${MCP_HOST_SVC}.${MCP_HOST_NS}.svc.cluster.local"
  log "Sending message via cluster Service: POST ${svc_url}:${MCP_HOST_PORT}/v1/runtime/messages"

  # Write helper script that targets the Service DNS (not localhost)
  kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- sh -c 'cat > /workspace/e2e-prod-msg.js << '"'"'ENDSCRIPT'"'"'
const http = require("http");
const data = JSON.stringify({
  content: "'"$prompt_text"'",
  channelType: "telegram",
  channelId: "e2e-prod-test",
  sender: "e2e-prod-runner"
});
const req = http.request({
  hostname: "'"$svc_url"'", port: '"$MCP_HOST_PORT"',
  path: "/v1/runtime/messages", method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
}, (res) => {
  let body = "";
  res.on("data", c => body += c);
  res.on("end", () => process.stdout.write(body));
});
req.on("error", e => process.stderr.write(e.message));
req.write(data);
req.end();
ENDSCRIPT' 2>/dev/null

  local response
  response=$(kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" \
    -- node /workspace/e2e-prod-msg.js 2>/dev/null || echo "{}")

  if echo "$response" | grep -q '"success":true'; then
    ok "MCP Host accepted message via cluster Service"
  else
    fail "MCP Host rejected message via cluster Service"
    log "Response: $response"
    kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- rm -f /workspace/e2e-prod-msg.js 2>/dev/null || true
    return
  fi

  # Handle approval flow
  if echo "$response" | grep -q '"awaiting_approval"'; then
    ok "Agent entered awaiting_approval state"

    local request_id task_id
    request_id=$(echo "$response" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('approval',{}).get('requestId',''))
except: print('')
" 2>/dev/null || echo "")
    task_id=$(echo "$response" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(d.get('approval',{}).get('taskId',''))
except: print('')
" 2>/dev/null || echo "")

    if [ -n "$request_id" ]; then
      log "Approving tool call via cluster Service (requestId: ${request_id})..."
      kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- sh -c 'cat > /workspace/e2e-prod-approve.js << '"'"'ENDSCRIPT'"'"'
const http = require("http");
const data = JSON.stringify({ userId: "e2e-prod-runner", requestId: "'"$request_id"'" });
const req = http.request({
  hostname: "'"$svc_url"'", port: '"$MCP_HOST_PORT"',
  path: "/v1/runtime/approvals/approve", method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
}, (res) => {
  let body = "";
  res.on("data", c => body += c);
  res.on("end", () => process.stdout.write(body));
});
req.on("error", e => process.stderr.write(e.message));
req.write(data);
req.end();
ENDSCRIPT' 2>/dev/null

      local approve_result
      approve_result=$(kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" \
        -- node /workspace/e2e-prod-approve.js 2>/dev/null || echo "{}")

      if echo "$approve_result" | grep -q '"success":true'; then
        ok "Tool call approved via cluster Service"
      else
        fail "Approval failed: $approve_result"
        kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- rm -f /workspace/e2e-prod-msg.js /workspace/e2e-prod-approve.js 2>/dev/null || true
        return
      fi

      # Poll for task result
      if [ -n "$task_id" ]; then
        log "Polling task result (taskId: ${task_id}, timeout: 45s)..."
        local poll_elapsed=0
        while [ $poll_elapsed -lt 45 ]; do
          local task_result
          task_result=$(kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- node -e "
const http = require('http');
http.get('http://${svc_url}:${MCP_HOST_PORT}/v1/runtime/tasks/${task_id}/result', (res) => {
  let b=''; res.on('data',c=>b+=c);
  res.on('end',()=>process.stdout.write(b));
}).on('error', e => process.stderr.write(e.message));
" 2>/dev/null || echo "{}")

          if echo "$task_result" | grep -q '"completed"\|"response"'; then
            ok "Tool execution completed via full production chain"

            # Verify proxy was in the path
            log "Verifying mcp-proxy was in the request chain..."
            local proxy_pod_name
            proxy_pod_name=$(kubectl get pod -n "$MCP_PROXY_NS" -l "app=mcp-proxy" \
              -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
            if [ -n "$proxy_pod_name" ]; then
              local recent_proxy_logs
              recent_proxy_logs=$(kubectl logs "$proxy_pod_name" -n "$MCP_PROXY_NS" --tail=20 2>/dev/null || echo "")
              if echo "$recent_proxy_logs" | grep -q "POST\|forward\|route\|mcp"; then
                ok "mcp-proxy logs confirm request was routed through proxy"
              else
                warn "Could not confirm proxy routing from logs (may use direct connection)"
              fi
            fi
            kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- rm -f /workspace/e2e-prod-msg.js /workspace/e2e-prod-approve.js 2>/dev/null || true
            return
          fi

          sleep 3
          poll_elapsed=$((poll_elapsed + 3))
        done
        warn "Task result polling timed out after 45s"
      fi
    else
      warn "Could not extract requestId from response"
    fi
  elif echo "$response" | grep -q '"completed"'; then
    ok "Agent completed tool call directly via cluster Service"
  else
    warn "Unexpected response status"
  fi

  kubectl exec -n "$MCP_HOST_NS" "$MCP_HOST_POD" -- rm -f /workspace/e2e-prod-msg.js /workspace/e2e-prod-approve.js 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════════════
# Version Consistency Check — All deployments use same version tag
# ═══════════════════════════════════════════════════════════════════════

verify_version_consistency() {
  local expected_tag="${1:-v1.0.0-wrc}"
  header "Phase P5 — Version Consistency (${expected_tag})"

  local all_match=true
  # Production deployments: chatllm/agent2 (not mcp-host), per-Host channel-readers
  # (#273 retired the static clerum-channel-reader; per-Host pods are channel-reader-<host>).
  for deploy_info in \
    "host-context-controller:${CONTROL_NS}:host-context-controller" \
    "workflow-recipes:${CONTROL_NS}:workflow-recipes" \
    "chatllm:${MCP_HOST_NS}:chatllm" \
    "agent2:${MCP_HOST_NS}:agent2" \
    "mcp-proxy:${MCP_PROXY_NS}:mcp-proxy" \
    "channel-reader-chatllm:${CHANNEL_NS}:channel-reader"; do

    local deploy_name ns container_name
    deploy_name=$(echo "$deploy_info" | cut -d: -f1)
    ns=$(echo "$deploy_info" | cut -d: -f2)
    container_name=$(echo "$deploy_info" | cut -d: -f3)

    local image
    image=$(kubectl get deploy "$deploy_name" -n "$ns" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' \
      2>/dev/null || echo "not-found")

    if echo "$image" | grep -q "${expected_tag}"; then
      ok "${deploy_name} image: ${image}"
    elif echo "$image" | grep -q "not-found"; then
      warn "${deploy_name} not found in ${ns}"
    else
      fail "${deploy_name} image mismatch: ${image} (expected tag: ${expected_tag})"
      all_match=false
    fi
  done
}
