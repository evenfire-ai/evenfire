#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Shared Library — Common functions for composite WorkflowRecipe tests
# ═══════════════════════════════════════════════════════════════════════
#
# Source this from any E2E script:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "${SCRIPT_DIR}/e2e-lib.sh"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# ─── Counters ────────────────────────────────────────────────────────
e2e_pass=0
e2e_fail=0
e2e_total=0

# ─── Configurable defaults ───────────────────────────────────────────
RECIPE_NS="${RECIPE_NS:-mcp-server}"
WORKFLOW_RECIPE_NS="${WORKFLOW_RECIPE_NS:-sandbox-recipes}"
SANDBOX_NS="${SANDBOX_NS:-sandbox-recipes}"
MCP_HOST_NS="${MCP_HOST_NS:-mcp-host}"
CONTROL_NS="${CONTROL_NS:-control-plane}"
TIMEOUT_POD="${TIMEOUT_POD:-120}"
TIMEOUT_DELETE="${TIMEOUT_DELETE:-90}"
TIMEOUT_DISCOVERY="${TIMEOUT_DISCOVERY:-60}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"
CONTEXT_NAME="${CONTEXT_NAME:-context1}"
E2E_KUBECONTEXT="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-}}"
E2E_ALLOWED_CONTEXTS="${E2E_ALLOWED_CONTEXTS:-minikube,clerum-test}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"

is_branch_scoped_e2e_context() {
  local context=$1
  case "$context" in
    *prod*|*production*) return 1 ;;
  esac
  printf "%s\n" "$context" | grep -Eq '^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$'
}

is_allowed_e2e_context() {
  local context=$1
  case ",${E2E_ALLOWED_CONTEXTS}," in
    *",${context},"*) return 0 ;;
  esac
  is_branch_scoped_e2e_context "$context"
}

current_e2e_context() {
  if [ -n "$E2E_KUBECONTEXT" ]; then
    printf "%s\n" "$E2E_KUBECONTEXT"
  else
    "$KUBECTL_BIN" config current-context 2>/dev/null
  fi
}

kctl() {
  if [ -n "$E2E_KUBECONTEXT" ]; then
    "$KUBECTL_BIN" --context "$E2E_KUBECONTEXT" "$@"
  else
    "$KUBECTL_BIN" "$@"
  fi
}

truncate_rfc1123() {
  printf "%.63s" "$1" | sed -E 's/[^a-z0-9]+$//'
}

require_safe_kube_context() {
  local context
  context="$(current_e2e_context || true)"
  if [ -z "$context" ]; then
    echo "Refusing to run E2E cleanup: Kubernetes context is empty" >&2
    return 1
  fi
  is_allowed_e2e_context "$context" && return 0
  echo "Refusing to run E2E cleanup on context '${context}'." >&2
  echo "Allowed contexts: ${E2E_ALLOWED_CONTEXTS}" >&2
  echo "Generated branch-scoped contexts matching clerum-*-<8hex> are also allowed." >&2
  echo "Set KUBECONTEXT or E2E_ALLOWED_CONTEXTS explicitly if this target is intentional." >&2
  return 1
}

# Detect minikube context (Calico CNI has partial NP enforcement)
_is_minikube() {
  local context
  context="$(current_e2e_context || true)"
  printf "%s\n" "$context" | grep -qi "minikube\|clerum-test" || is_branch_scoped_e2e_context "$context"
}

# MCP Host deployment name: auto-detect (chatllm or mcp-host)
_MCP_HOST_DEPLOY=""
_detect_mcp_host_deploy() {
  if [ -n "$_MCP_HOST_DEPLOY" ]; then echo "$_MCP_HOST_DEPLOY"; return; fi
  for name in mcp-host chatllm; do
    if kctl get deploy "$name" -n "$MCP_HOST_NS" &>/dev/null; then
      _MCP_HOST_DEPLOY="$name"
      echo "$name"
      return
    fi
  done
  echo ""
}

# ─── Logging helpers ─────────────────────────────────────────────────
log()    { echo -e "${CYAN}[E2E]${NC} $*"; }
ok()     { e2e_pass=$((e2e_pass+1)); e2e_total=$((e2e_total+1)); echo -e "${GREEN}  ✅ PASS${NC} — $*"; }
fail()   { e2e_fail=$((e2e_fail+1)); e2e_total=$((e2e_total+1)); echo -e "${RED}  ❌ FAIL${NC} — $*"; }
warn()   { echo -e "${YELLOW}  ⚠️  WARN${NC} — $*"; }
header() { echo -e "\n${BOLD}═══ $* ═══${NC}"; }

# ─── Wait helpers ────────────────────────────────────────────────────

ready_pod_name() {
  local ns=$1 label=$2
  local rows name ready deleting
  rows=$(kctl get pods -n "$ns" -l "$label" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null || echo "")
  while IFS=$'\t' read -r name ready deleting; do
    if [ -n "$name" ] && [ "$ready" = "True" ] && [ -z "$deleting" ]; then
      printf "%s\n" "$name"
      return 0
    fi
  done <<< "$rows"
  return 1
}

# Count every Running pod, including unready or terminating pods. Suspend
# assertions use this instead of ready_pod_name so an unready pod cannot be
# mistaken for a fully terminated workload.
running_pod_count() {
  local ns=$1 label=$2 rows
  if ! rows="$(kctl get pods -n "$ns" -l "$label" \
    --field-selector=status.phase=Running -o name)"; then
    echo "running_pod_count: failed to list Running pods in ${ns} for selector ${label}" >&2
    return 1
  fi
  printf '%s\n' "$rows" | awk 'NF { count++ } END { print count + 0 }'
}

wait_for_pod() {
  local ns=$1 label=$2 timeout=$3 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    ready_pod_name "$ns" "$label" >/dev/null && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_statefulset() {
  local ns=$1 name=$2 timeout=$3 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    local ready
    ready=$(kctl get statefulset "$name" -n "$ns" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    [ "${ready:-0}" -ge 1 ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_deployment() {
  local ns=$1 name=$2 timeout=$3 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    local ready
    ready=$(kctl get deployment "$name" -n "$ns" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    [ "${ready:-0}" -ge 1 ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_cronjob() {
  local ns=$1 name=$2 timeout=$3 elapsed=0
  while [ $elapsed -lt "$timeout" ]; do
    if kctl get cronjob "$name" -n "$ns" &>/dev/null; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_workflowrecipe_deleted() {
  local ns=$1 name=$2 timeout=$3 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if ! kctl get workflowrecipe "$name" -n "$ns" &>/dev/null; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

any_named_resource_exists() {
  local ns=$1 kind=$2
  shift 2
  local name output
  for name in "$@"; do
    if output=$(kctl get "$kind" "$name" -n "$ns" 2>&1 >/dev/null); then
      return 0
    fi
    if printf "%s" "$output" | grep -Eqi "notfound|not found"; then
      continue
    fi
    warn "could not check ${kind}/${name} in ${ns}: ${output}"
    return 2
  done
  return 1
}

any_sandbox_resource_exists() {
  local kind=$1
  shift
  any_named_resource_exists "$SANDBOX_NS" "$kind" "$@"
}

wait_for_named_resources_deleted() {
  local ns=$1 kind=$2 timeout=$3
  shift 3
  local elapsed=0 rc=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if any_named_resource_exists "$ns" "$kind" "$@"; then
      rc=0
    else
      rc=$?
    fi
    if [ "$rc" -eq 1 ]; then
      return 0
    fi
    if [ "$rc" -eq 2 ]; then
      return 1
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# ─── Phase 0: Prerequisites ─────────────────────────────────────────

check_prerequisites() {
  header "Phase 0 — Prerequisites"

  if kctl cluster-info &>/dev/null; then
    ok "Kubernetes cluster reachable"
  else
    fail "Cannot reach Kubernetes cluster"
    exit 1
  fi

  local seen_namespaces=""
  for ns in "$WORKFLOW_RECIPE_NS" "$RECIPE_NS" "$SANDBOX_NS" "$MCP_HOST_NS" "$CONTROL_NS"; do
    case " ${seen_namespaces} " in
      *" ${ns} "*) continue ;;
    esac
    seen_namespaces="${seen_namespaces} ${ns}"
    if kctl get ns "$ns" &>/dev/null; then ok "Namespace '$ns' exists"
    else fail "Namespace '$ns' not found"; fi
  done

  for crd in workflowrecipes.clerum.io mcpservers.clerum.io contexts.clerum.io hosts.clerum.io; do
    if kctl get crd "$crd" &>/dev/null; then ok "CRD '$crd' installed"
    else fail "CRD '$crd' not found"; fi
  done

  for deploy in host-context-controller host-context-controller-api-gateway workflow-recipes; do
    if kctl get deploy "$deploy" -n "$CONTROL_NS" &>/dev/null; then
      ok "Deployment '$deploy' in control-plane"
    else
      fail "Deployment '$deploy' not found"
    fi
  done

  # Call directly (NOT in subshell) so _MCP_HOST_DEPLOY persists for Phase 7-8
  _detect_mcp_host_deploy
  if [ -n "$_MCP_HOST_DEPLOY" ]; then
    ok "MCP Host deployment '${_MCP_HOST_DEPLOY}' exists"
  else
    fail "MCP Host not found (tried: mcp-host, chatllm)"
  fi

  if kctl get context "$CONTEXT_NAME" -n "$RECIPE_NS" &>/dev/null; then
    ok "Context '${CONTEXT_NAME}' exists"
  else
    fail "Context '${CONTEXT_NAME}' not found"
  fi
}

# ─── Phase 1: Cleanup ───────────────────────────────────────────────

cleanup_recipe() {
  local recipe_name=$1 backend_id=$2 mcp_id=$3
  local backend_type=${4:-statefulset}
  local cleanup_status=0
  local mcp_server_name="${recipe_name}-${mcp_id}"
  local mcp_ingress_np
  mcp_ingress_np="$(truncate_rfc1123 "${recipe_name}-wf-mcp-ingress-${mcp_server_name}")"

  header "Phase 1 — Clean Slate"
  log "Deleting WorkflowRecipe ${recipe_name} from ${WORKFLOW_RECIPE_NS}..."
  kctl delete workflowrecipe "$recipe_name" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false 2>/dev/null || cleanup_status=1
  if ! wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$recipe_name" "$TIMEOUT_DELETE"; then
    fail "WorkflowRecipe '${recipe_name}' still exists in ${WORKFLOW_RECIPE_NS} after cleanup timeout"
    kctl get workflowrecipe "$recipe_name" -n "$WORKFLOW_RECIPE_NS" -o yaml 2>/dev/null || true
    cleanup_status=1
  fi
  if [ "$RECIPE_NS" != "$WORKFLOW_RECIPE_NS" ]; then
    kctl delete workflowrecipe "$recipe_name" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || cleanup_status=1
  fi

  # Backend resources in sandbox
  kctl delete "$backend_type" "$backend_id" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || cleanup_status=1
  kctl delete svc "$backend_id" "${backend_id}-headless" -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || cleanup_status=1

  # MCP resources
  kctl delete deployment "$mcp_id" "$mcp_server_name" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || cleanup_status=1
  kctl delete svc "$mcp_id" "$mcp_server_name" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || cleanup_status=1
  kctl delete mcpserver "$mcp_id" "$mcp_server_name" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || cleanup_status=1

  # NetworkPolicies: keep cleanup scoped to exact policy names generated by WRC.
  kctl delete networkpolicy \
    "${recipe_name}-coord-to-mcp-host" \
    "${recipe_name}-coord-to-mcp-host-ingress" \
    "${recipe_name}-coord-to-wrc" \
    "${recipe_name}-wrc-to-mcp-host" \
    "${recipe_name}-mcp-host-to-servers" \
    "${recipe_name}-mcp-host-to-llm-api" \
    "${recipe_name}-mcp-host-to-approval-gateway" \
    -n "$SANDBOX_NS" --ignore-not-found 2>/dev/null || cleanup_status=1
  kctl delete networkpolicy \
    "$mcp_ingress_np" \
    "${recipe_name}-mcp-servers-egress-internet" \
    -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || cleanup_status=1

  log "Cleanup complete"
  return "$cleanup_status"
}

# ─── Phase 2: Apply ─────────────────────────────────────────────────

apply_recipe() {
  local recipe_file=$1 recipe_name=$2

  header "Phase 2 — Apply Composite WorkflowRecipe"
  log "Applying ${recipe_file}..."
  if kctl apply -f "$recipe_file" 2>&1; then
    ok "WorkflowRecipe '${recipe_name}' applied"
  else
    fail "Failed to apply WorkflowRecipe"
    exit 1
  fi

  if kctl get workflowrecipe "$recipe_name" -n "$WORKFLOW_RECIPE_NS" &>/dev/null; then
    ok "WorkflowRecipe '${recipe_name}' exists in ${WORKFLOW_RECIPE_NS}"
  else
    fail "WorkflowRecipe '${recipe_name}' not found in ${WORKFLOW_RECIPE_NS}"
    exit 1
  fi
}

# ─── Phase 3: Verify backend workload ───────────────────────────────

verify_backend_statefulset() {
  local backend_id=$1 backend_port=$2
  header "Phase 3 — Backend StatefulSet (sandbox-recipes)"

  log "Waiting for ${backend_id} StatefulSet (${TIMEOUT_POD}s)..."
  if wait_for_statefulset "$SANDBOX_NS" "$backend_id" "$TIMEOUT_POD"; then
    ok "${backend_id} StatefulSet ready"
  else
    fail "${backend_id} StatefulSet not ready (timeout)"
    kctl get statefulset -n "$SANDBOX_NS" 2>/dev/null || true
    kctl get pods -n "$SANDBOX_NS" -l "app=${backend_id}" 2>/dev/null || true
    kctl describe pod -n "$SANDBOX_NS" -l "app=${backend_id}" 2>/dev/null | tail -20 || true
  fi

  if kctl get svc "${backend_id}-headless" -n "$SANDBOX_NS" &>/dev/null || \
     kctl get svc "${backend_id}" -n "$SANDBOX_NS" &>/dev/null; then
    ok "${backend_id} Service exists"
  else
    fail "No ${backend_id} Service found"
  fi
}

verify_backend_deployment() {
  local backend_id=$1 backend_port=$2
  header "Phase 3 — Backend Deployment (sandbox-recipes)"

  log "Waiting for ${backend_id} Deployment (${TIMEOUT_POD}s)..."
  if wait_for_deployment "$SANDBOX_NS" "$backend_id" "$TIMEOUT_POD"; then
    ok "${backend_id} Deployment ready"
  else
    fail "${backend_id} Deployment not ready (timeout)"
    kctl get deployment -n "$SANDBOX_NS" 2>/dev/null || true
    kctl get pods -n "$SANDBOX_NS" -l "app=${backend_id}" 2>/dev/null || true
    kctl describe pod -n "$SANDBOX_NS" -l "app=${backend_id}" 2>/dev/null | tail -20 || true
  fi

  if kctl get svc "${backend_id}" -n "$SANDBOX_NS" &>/dev/null; then
    ok "${backend_id} Service exists"
  else
    fail "No ${backend_id} Service found"
  fi
}

# ─── Phase 4: Verify MCP Delegation ─────────────────────────────────

verify_mcp_context_allowlist() {
  local mcp_server_name=$1
  local timeout=${2:-${TIMEOUT_CONTEXT:-180}}
  local context_ref context_servers elapsed=0

  context_ref=$(kctl get mcpserver "$mcp_server_name" -n "$RECIPE_NS" \
    -o jsonpath='{.spec.contextRef}' 2>/dev/null || echo "")
  if [ -z "$context_ref" ]; then
    fail "McpServer '${mcp_server_name}' has no spec.contextRef"
    return
  fi

  while [ "$elapsed" -lt "$timeout" ]; do
    context_servers=$(kctl get context "$context_ref" -n "$RECIPE_NS" \
      -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "")
    if printf "%s" "$context_servers" | tr '[],"' '    ' | tr ' ' '\n' | grep -Fxq "$mcp_server_name"; then
      ok "Context '${context_ref}' allowlist includes '${mcp_server_name}'"
      return
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "Context '${context_ref}' does not include '${mcp_server_name}' after ${timeout}s"
}

verify_mcp_delegation() {
  local recipe_name=$1 mcp_id=$2 binding_port=${3:-}
  local mcp_server_name="${recipe_name}-${mcp_id}"

  header "Phase 4 — MCP Delegation (McpServer CRD + Service)"

  if kctl get mcpserver "$mcp_server_name" -n "$RECIPE_NS" &>/dev/null; then
    ok "McpServer CRD '${mcp_server_name}' auto-created"
  else
    fail "McpServer CRD '${mcp_server_name}' not found"
  fi

  local managed
  managed=$(kctl get mcpserver "$mcp_server_name" -n "$RECIPE_NS" \
    -o jsonpath='{.spec.managed}' 2>/dev/null || echo "")
  if [ "$managed" = "false" ]; then
    ok "McpServer managed=false (WRC manages deployment)"
  else
    fail "McpServer managed='$managed' (expected: false)"
  fi

  # Check recipe-bindings annotation if port provided
  if [ -n "$binding_port" ]; then
    local bindings_ann
    bindings_ann=$(kctl get mcpserver "$mcp_server_name" -n "$RECIPE_NS" \
      -o jsonpath='{.metadata.annotations.clerum\.io/recipe-bindings}' 2>/dev/null || echo "")
    if echo "$bindings_ann" | grep -q "\"port\":${binding_port}"; then
      ok "McpServer has recipe-bindings (port ${binding_port})"
    else
      fail "McpServer recipe-bindings annotation incomplete"
    fi
  fi

  if kctl get svc "$mcp_server_name" -n "$RECIPE_NS" &>/dev/null; then
    ok "Transport Service '${mcp_server_name}' created"
  else
    fail "Transport Service not found"
  fi

  verify_mcp_context_allowlist "$mcp_server_name"
}

# ─── Phase 5: Verify MCP Server Pod ─────────────────────────────────

verify_mcp_server_pod() {
  local mcp_id=$1
  header "Phase 5 — MCP Server Pod (mcp-server namespace)"

  log "Waiting for MCP Server pod (${TIMEOUT_POD}s)..."
  if wait_for_pod "$RECIPE_NS" "app=${mcp_id}" "$TIMEOUT_POD"; then
    ok "MCP Server pod '${mcp_id}' ready"
  else
    fail "MCP Server pod not ready (timeout)"
    kctl get pods -n "$RECIPE_NS" -l "app=${mcp_id}" 2>/dev/null || true
    kctl describe pod -n "$RECIPE_NS" -l "app=${mcp_id}" 2>/dev/null | tail -20 || true
  fi

  local mcp_logs
  mcp_logs=$(kctl logs -n "$RECIPE_NS" -l "app=${mcp_id}" --tail=30 2>/dev/null || echo "")
  if echo "$mcp_logs" | grep -qi "listening\|started\|transport\|StreamableHTTP"; then
    ok "MCP Server transport started"
  else
    fail "MCP Server transport not detected in logs"
  fi
}

# ─── Phase 5b: Verify stdio MCP Server Pod (sidecar pattern) ─────────

verify_stdio_mcp_server_pod() {
  local mcp_id=$1
  local mcp_server_name=$2
  header "Phase 5 — stdio MCP Server Pod (stdio-bridge sidecar)"

  log "Waiting for stdio MCP Server pod '${mcp_server_name}' (${TIMEOUT_POD}s)..."
  if wait_for_pod "$RECIPE_NS" "app=${mcp_server_name}" "$TIMEOUT_POD"; then
    ok "stdio MCP Server pod '${mcp_server_name}' ready"
  else
    fail "stdio MCP Server pod not ready (timeout)"
    kctl get pods -n "$RECIPE_NS" -l "app=${mcp_server_name}" 2>/dev/null || true
    kctl describe pod -n "$RECIPE_NS" -l "app=${mcp_server_name}" 2>/dev/null | tail -30 || true
    return
  fi

  # Verify pod has stdio-bridge container (injected by HCC)
  local containers
  containers=$(kctl get pods -n "$RECIPE_NS" -l "app=${mcp_server_name}" \
    -o jsonpath='{.items[0].spec.containers[*].name}' 2>/dev/null || echo "")
  if echo "$containers" | grep -q "stdio-bridge"; then
    ok "Pod has 'stdio-bridge' sidecar container"
  else
    fail "Pod missing 'stdio-bridge' container (found: ${containers})"
  fi

  # Verify init container exists (copies binary)
  local init_containers
  init_containers=$(kctl get pods -n "$RECIPE_NS" -l "app=${mcp_server_name}" \
    -o jsonpath='{.items[0].spec.initContainers[*].name}' 2>/dev/null || echo "")
  if [ -n "$init_containers" ]; then
    ok "Pod has init container for binary copy"
  else
    warn "No init container found (may use different binary delivery method)"
  fi

  # Check stdio-bridge logs for startup
  local bridge_logs
  bridge_logs=$(kctl logs -n "$RECIPE_NS" -l "app=${mcp_server_name}" \
    -c stdio-bridge --tail=20 2>/dev/null || echo "")
  if echo "$bridge_logs" | grep -qi "started\|listening\|bridge\|ready\|health"; then
    ok "stdio-bridge sidecar started successfully"
  else
    warn "Could not confirm stdio-bridge startup from logs"
  fi
}

# ─── Phase 6: NetworkPolicy Enforcement ──────────────────────────────

verify_networkpolicy() {
  local mcp_id=$1 backend_id=$2 backend_port=$3
  header "Phase 6 — NetworkPolicy Enforcement"

  # Test deny-all: generic pod → backend
  log "Testing deny-all enforcement..."
  kctl delete pod np-test-deny -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  if kctl run np-test-deny --image=busybox --rm -i --restart=Never -n "$RECIPE_NS" \
     --timeout=10s -- nc -z -w3 "${backend_id}.${SANDBOX_NS}.svc.cluster.local" "$backend_port" &>/dev/null 2>&1; then
    if _is_minikube; then
      warn "Deny-all NOT enforced (expected on minikube/Calico — ${backend_id} reachable)"
    else
      fail "Deny-all NOT enforced: generic pod reached ${backend_id}"
    fi
  else
    ok "Deny-all enforced: generic pod cannot reach ${backend_id}"
  fi

  # Test MCP server → backend connectivity
  log "Testing MCP server → ${backend_id}:${backend_port}..."
  local mcp_pod
  mcp_pod=$(ready_pod_name "$RECIPE_NS" "app=${mcp_id}" || echo "")
  if [ -n "$mcp_pod" ]; then
    local connect_result
    local connected=false
    local attempt
    for attempt in 1 2 3; do
      mcp_pod=$(ready_pod_name "$RECIPE_NS" "app=${mcp_id}" || echo "")
      if [ -z "$mcp_pod" ]; then
        connect_result="no ready pod"
        sleep "$POLL_INTERVAL"
        continue
      fi
      connect_result=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- node -e "
        const net = require('net');
        const s = new net.Socket();
        s.setTimeout(5000);
        s.connect(${backend_port}, '${backend_id}.${SANDBOX_NS}.svc.cluster.local', () => {
          console.log('CONNECTED'); s.destroy();
        });
        s.on('error', e => { console.log('ERROR:' + e.message); s.destroy(); });
        s.on('timeout', () => { console.log('TIMEOUT'); s.destroy(); });
      " 2>&1 || echo "ERROR")
      if echo "$connect_result" | grep -q "CONNECTED"; then
        connected=true
        break
      fi
      if echo "$connect_result" | grep -Eqi 'container not found|unable to upgrade connection|not found'; then
        sleep "$POLL_INTERVAL"
        continue
      fi
      break
    done
    if [ "$connected" = "true" ]; then
      ok "MCP server → ${backend_id}:${backend_port} (binding NP works)"
    else
      if [ "${E2E_STRICT_BACKEND_CONNECTIVITY:-false}" = "true" ]; then
        fail "MCP server cannot reach ${backend_id} (${connect_result})"
      else
        warn "MCP server cannot reach ${backend_id} (${connect_result})"
      fi
    fi
  else
    if [ "${E2E_STRICT_BACKEND_CONNECTIVITY:-false}" = "true" ]; then
      fail "Cannot test backend connectivity: MCP server pod not found"
    else
      warn "Cannot test: MCP server pod not found"
    fi
  fi

  # Test internet egress blocked
  log "Testing internet egress blocked..."
  if [ -n "$mcp_pod" ]; then
    local egress_result
    egress_result=$(kctl exec "$mcp_pod" -n "$RECIPE_NS" -- node -e "
      const net = require('net');
      const s = new net.Socket();
      s.setTimeout(3000);
      s.connect(80, '1.1.1.1', () => { console.log('OPEN'); s.destroy(); });
      s.on('error', e => { console.log('BLOCKED'); s.destroy(); });
      s.on('timeout', () => { console.log('BLOCKED'); s.destroy(); });
    " 2>&1 || echo "BLOCKED")
    if echo "$egress_result" | grep -q "BLOCKED"; then
      ok "Internet egress blocked"
    else
      if _is_minikube; then
        warn "Internet egress NOT blocked (expected on minikube/Calico)"
      else
        fail "Internet egress NOT blocked"
      fi
    fi
  fi
}

# ─── Phase 7: MCP Host Discovery ────────────────────────────────────

verify_mcp_host_discovery() {
  local recipe_name=$1 mcp_id=$2
  local mcp_server_name="${recipe_name}-${mcp_id}"
  header "Phase 7 — MCP Host Discovery"

  log "Waiting for MCP Host to discover '${mcp_server_name}' (${TIMEOUT_DISCOVERY}s)..."
  local elapsed=0 discovered=false
  while [ $elapsed -lt "$TIMEOUT_DISCOVERY" ]; do
    local host_logs
    host_logs=$(kctl logs -n "$MCP_HOST_NS" "deploy/${_MCP_HOST_DEPLOY}" --tail=80 2>/dev/null || echo "")
    if echo "$host_logs" | grep -q "MCP server added: ${mcp_server_name}\|Connected successfully.*${mcp_server_name}\|Added server: ${mcp_server_name}"; then
      discovered=true
      break
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  if [ "$discovered" = true ]; then
    ok "MCP Host discovered '${mcp_server_name}'"
  else
    fail "MCP Host did not discover '${mcp_server_name}'"
  fi

  local tool_count
  tool_count=$(kctl logs -n "$MCP_HOST_NS" "deploy/${_MCP_HOST_DEPLOY}" --tail=200 2>/dev/null \
    | grep -c "${mcp_server_name}__" 2>/dev/null || true)
  tool_count=${tool_count:-0}
  if [ "$tool_count" -gt 0 ]; then
    ok "MCP Host registered ${tool_count} tools from ${mcp_server_name}"
  else
    fail "MCP Host registered no tools from ${mcp_server_name}"
  fi
}

# ─── Phase 7b: mcp-proxy tools/list + tools/call ───────────────────

verify_mcp_proxy_tool_call() {
  local recipe_name=$1 mcp_id=$2 tool_name=$3 tool_args_json=$4 expected_output=$5
  local mcp_server_name="${recipe_name}-${mcp_id}"
  header "Phase 7 — mcp-proxy Tool Contract"

  if ! kctl get deploy mcp-proxy -n "$RECIPE_NS" &>/dev/null; then
    fail "mcp-proxy deployment not found"
    return
  fi

  log "Verifying ${mcp_server_name}.${tool_name} through mcp-proxy..."
  local result="" ok_value="" tools_value="" output_value="" stage_value="" status_value=""
  local elapsed=0 timeout="${MCP_PROXY_ROUTING_TIMEOUT:-$TIMEOUT_DISCOVERY}"

  while [ "$elapsed" -lt "$timeout" ]; do
    result=$(kctl exec -i -n "$RECIPE_NS" deploy/mcp-proxy \
      -- node - "$mcp_server_name" "$tool_name" "$tool_args_json" "$expected_output" <<'NODE' 2>/dev/null || echo '{"ok":false,"stage":"exec","error":"kctl exec failed"}'
const http = require('http');
const serverName = process.argv[2];
const toolName = process.argv[3];
const argsJson = process.argv[4];
const expectedOutput = process.argv[5];

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('data: ')) {
        return JSON.parse(lines[i].slice(6));
      }
    }
    return { raw: text };
  }
}

function postMcp(id, method, params, sessionId) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  return new Promise(resolve => {
    const req = http.request({
      hostname: 'localhost',
      port: 8083,
      path: `/servers/${serverName}/mcp`,
      method: 'POST',
      headers,
    }, res => {
      let text = '';
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        sessionId: res.headers['mcp-session-id'],
        body: text,
        parsed: parseBody(text),
      }));
    });
    req.on('error', error => resolve({ status: 0, error: error.message, body: '' }));
    req.write(body);
    req.end();
  });
}

(async () => {
  let toolArgs;
  try {
    toolArgs = JSON.parse(argsJson);
  } catch {
    console.log(JSON.stringify({ ok: false, stage: 'args', status: 0, body: argsJson }));
    return;
  }

  const init = await postMcp(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'e2e-workflow-backend-compat', version: '1.0.0' },
  });
  if (init.status !== 200 && init.status !== 201) {
    console.log(JSON.stringify({ ok: false, stage: 'initialize', status: init.status, body: init.body }));
    return;
  }
  const sessionId = init.sessionId || null;

  const listed = await postMcp(2, 'tools/list', {}, sessionId);
  if (listed.status !== 200) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/list', status: listed.status, body: listed.body }));
    return;
  }
  const tools = listed.parsed?.result?.tools || [];
  const names = tools.map(tool => tool.name);
  if (!names.includes(toolName)) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/list', status: listed.status, tools: names }));
    return;
  }

  const called = await postMcp(3, 'tools/call', {
    name: toolName,
    arguments: toolArgs,
  }, sessionId);
  if (called.status !== 200) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/call', status: called.status, body: called.body }));
    return;
  }
  const text = (called.parsed?.result?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
  if (!text.includes(expectedOutput)) {
    console.log(JSON.stringify({ ok: false, stage: 'tools/call', status: called.status, output: text }));
    return;
  }

  console.log(JSON.stringify({ ok: true, tools: names, output: text }));
})();
NODE
)

    ok_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || echo "")
    tools_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(','.join(json.load(sys.stdin).get('tools',[])))" 2>/dev/null || echo "")
    output_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('output',''))" 2>/dev/null || echo "")
    stage_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stage',''))" 2>/dev/null || echo "")
    status_value=$(printf "%s" "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

    if [ "$ok_value" = "True" ]; then
      ok "mcp-proxy listed ${tool_name} and tools/call returned expected output"
      log "tools: ${tools_value}; output chars=${#output_value}; expected signal matched"
      return
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "mcp-proxy tool contract failed at ${stage_value:-unknown} HTTP ${status_value:-unknown}: $(printf "%s" "$result" | head -c 260)"
}

# ─── Print Results ───────────────────────────────────────────────────

print_results() {
  header "Results"
  echo ""
  echo -e "${BOLD}Total: ${e2e_total}  |  ${GREEN}Pass: ${e2e_pass}${NC}  |  ${RED}Fail: ${e2e_fail}${NC}"
  echo ""
  # Zero tests executed is never success: a gate whose fixture never
  # materialized (missing Host, aborted setup, empty filter) reaches here with
  # e2e_total == 0 and, checking only e2e_fail, would print "All tests passed!"
  # over an empty result set. Assert something actually ran before green.
  if [ "$e2e_total" -eq 0 ]; then
    echo -e "${RED}${BOLD}FAIL: zero tests executed — the harness never reached a real assertion${NC}" >&2
    return 1
  fi
  if [ "$e2e_fail" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All tests passed!${NC}"
    return 0
  else
    echo -e "${RED}${BOLD}${e2e_fail} test(s) failed${NC}"
    return 1
  fi
}
