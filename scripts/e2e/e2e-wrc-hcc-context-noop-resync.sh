#!/usr/bin/env bash
# Cross-controller T14 gate for PR #568.
#
# Proves the real WorkflowRecipe -> WRC -> Context -> HCC boundary, then
# removes one HCC-owned Context policy while Context/McpServer desired state is
# frozen. Recovery must come from HCC's periodic coordinated convergence, not a
# no-op WRC PUT, a direct Context patch, or an HCC restart.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-fixture.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"

[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT or E2E_K8S_CONTEXT must select an explicit branch-scoped minikube context." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing WRC/HCC Context fault injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
[ "${E2E_WRC_HCC_CONTEXT_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_WRC_HCC_CONTEXT_FAULT_INJECTION=1 to acknowledge temporary HCC resync and NetworkPolicy fault injection." >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "node is required" >&2
  exit 1
}

HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
WRC_DEPLOY="${WRC_DEPLOY:-workflow-recipes}"
MCP_NS="${MCP_SERVER_NAMESPACE:-mcp-server}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
RPC_PROXY_NS="${RPC_PROXY_NS:-rpc-proxy}"
WORKFLOW_NS="${WORKFLOW_RECIPE_NS:-sandbox-recipes}"
RUN_ID="$(date +%s)-$$"
RUN_LABEL="$(truncate_rfc1123 "$RUN_ID")"
SUITE_NAME="wrc-hcc-context-noop-resync"
RECIPE_NAME="$(truncate_rfc1123 "e2e-pr568-${RUN_LABEL}")"
CONTEXT_NAME="$(truncate_rfc1123 "e2e-pr568-context-${RUN_LABEL}")"
MCP_NAME="$(truncate_rfc1123 "${RECIPE_NAME}-mock-tools")"
PROBE_NAME="$(truncate_rfc1123 "e2e-pr568-probe-${RUN_LABEL}")"
CONTEXT_POLICY="ctx-${CONTEXT_NAME}-${MCP_NAME}"
CONTEXT_EGRESS_POLICY="${CONTEXT_POLICY}-egress"
RPC_EGRESS_POLICY="rpc-egress-${CONTEXT_NAME}-${MCP_NAME}"
RESYNC_SECONDS="${E2E_WRC_HCC_NETPOL_RESYNC_SEC:-120}"
RESYNC_TIMEOUT_SECONDS="${E2E_WRC_HCC_RESYNC_TIMEOUT_SEC:-360}"

[[ "$RESYNC_SECONDS" =~ ^[0-9]+$ ]] && [ "$RESYNC_SECONDS" -ge 5 ] &&
  [ "$RESYNC_SECONDS" -le 120 ] || {
  echo "E2E_WRC_HCC_NETPOL_RESYNC_SEC must be an integer from 5 through 120." >&2
  exit 1
}
[[ "$RESYNC_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] &&
  [ "$RESYNC_TIMEOUT_SECONDS" -gt "$RESYNC_SECONDS" ] || {
  echo "E2E_WRC_HCC_RESYNC_TIMEOUT_SEC must be an integer greater than the resync interval." >&2
  exit 1
}

HCC_IMAGE=""
HCC_PORT=""
HCC_UID=""
HCC_RESTARTS=""
ORIGINAL_RESYNC_PRESENT=0
ORIGINAL_RESYNC_VALUE=""
HCC_CONFIG_CAPTURED=0
HCC_ENV_MUTATED=0
RECIPE_CREATED=0
CONTEXT_CREATED=0
PROBE_CREATED=0
ORIGINAL_CONTEXT_RV=""
ORIGINAL_CONTEXT_GENERATION=""
ORIGINAL_MCP_GENERATION=""
ORIGINAL_POLICY_UID=""
ORIGINAL_POLICY_SNAPSHOT=""
FINAL_SUMMARY=""
# Read and mutated by the sourced compare-and-swap lock helper.
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0
# shellcheck disable=SC2034
HCC_GATE_LOCK_NAME=""
# shellcheck disable=SC2034
HCC_GATE_LOCK_UID=""
# shellcheck disable=SC2034
HCC_GATE_FINALIZATION_FAILURE=""

die() {
  fail "$*"
  exit 1
}

wait_until() {
  local timeout=$1 description=$2
  shift 2
  local deadline now
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    "$@" && return 0
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

resource_absent() {
  local kind=$1 name=$2 namespace=$3
  ! kctl get "$kind" "$name" -n "$namespace" >/dev/null 2>&1
}

running_hcc_pod() {
  ready_pod_name "$HCC_NS" "app=${HCC_DEPLOY}"
}

hcc_identity_is_stable() {
  local pod uid restarts deleting
  pod="$(running_hcc_pod)" || return 1
  read -r uid restarts deleting <<<"$(
    kctl get pod "$pod" -n "$HCC_NS" \
      -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}{" "}{.metadata.deletionTimestamp}'
  )"
  [ "$uid" = "$HCC_UID" ] && [ "$restarts" = "$HCC_RESTARTS" ] && [ -z "$deleting" ]
}

probe_hcc_ready() {
  local pod
  pod="$(running_hcc_pod)" || return 1
  kctl exec "pod/${pod}" -n "$HCC_NS" -c host-context-controller -- \
    env "HCC_E2E_PORT=${HCC_PORT}" node -e '
      const http = require("node:http");
      const request = http.get(
        {host:"127.0.0.1",port:Number(process.env.HCC_E2E_PORT),path:"/ready"},
        response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              process.exit(response.statusCode === 200 && parsed?.ready === true ? 0 : 2);
            } catch { process.exit(3); }
          });
        }
      );
      request.setTimeout(5000, () => request.destroy(new Error("timeout")));
      request.once("error", () => process.exit(4));
    ' >/dev/null 2>&1
}

hcc_log_contains() {
  local marker=$1 pod
  pod="$(running_hcc_pod)" || return 1
  kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller --since=10m 2>/dev/null |
    grep -Fq "$marker"
}

mcpserver_current_ready() {
  kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e '
      .metadata.generation as $generation |
      any(.status.conditions[]?;
        .type == "Ready" and .status == "True" and
        (.observedGeneration // -1) == $generation)
    ' >/dev/null
}

mcp_runtime_still_ready() {
  local deployment_ready endpoint_addresses
  mcpserver_current_ready || return 1
  deployment_ready="$(kctl get deployment "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" || return 1
  [ "${deployment_ready:-0}" -ge 1 ] || return 1
  endpoint_addresses="$(kctl get endpoints "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)" || return 1
  [ -n "$endpoint_addresses" ]
}

policy_has_identity() {
  local namespace=$1 name=$2 policy_type=$3
  kctl get networkpolicy "$name" -n "$namespace" -o json 2>/dev/null |
    jq -e \
      --arg context "$CONTEXT_NAME" \
      --arg server "$MCP_NAME" \
      --arg policyType "$policy_type" '
      .metadata.labels["clerum.io/managed-by"] == "host-context-controller" and
      .metadata.labels["clerum.io/policy-type"] == $policyType and
      .metadata.labels["clerum.io/context"] == $context and
      .metadata.labels["clerum.io/mcpserver"] == $server
    ' >/dev/null
}

context_projection_converged() {
  local context deployment_ready
  context="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" -o json 2>/dev/null)" || return 1
  jq -e --arg server "$MCP_NAME" '
    .spec.contextId == .metadata.name and
    .spec.mcpServers == [$server] and
    .metadata.labels["clerum.io/managed-by"] == "wrc" and
    (.metadata.labels["clerum.io/recipe"] // "") == ""
  ' <<<"$context" >/dev/null || return 1
  kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e --arg context "$CONTEXT_NAME" '.spec.contextRef == $context' >/dev/null || return 1
  mcpserver_current_ready || return 1
  deployment_ready="$(kctl get deployment "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" || return 1
  [ "${deployment_ready:-0}" -ge 1 ] || return 1
  kctl get service "$MCP_NAME" -n "$MCP_NS" >/dev/null 2>&1 || return 1
  policy_has_identity "$MCP_NS" "$CONTEXT_POLICY" context-allow || return 1
  policy_has_identity "$HOST_NS" "$CONTEXT_EGRESS_POLICY" context-allow || return 1
  policy_has_identity "$RPC_PROXY_NS" "$RPC_EGRESS_POLICY" rpc-proxy-egress
}

wrc_reconcile_count() {
  local logs
  logs="$(kctl logs deployment/"$WRC_DEPLOY" -n "$HCC_NS" --since=15m 2>/dev/null)" || return 1
  grep -Fc "[WR-Reconciler] Reconciling \"${RECIPE_NAME}\"" <<<"$logs" || true
}

wrc_reconciled_after() {
  local before=$1 current
  current="$(wrc_reconcile_count)" || return 1
  [ "$current" -gt "$before" ]
}

context_identity_is_original() {
  local identity
  identity="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}' 2>/dev/null)" || return 1
  [ "$identity" = "${ORIGINAL_CONTEXT_RV} ${ORIGINAL_CONTEXT_GENERATION}" ]
}

mcp_generation_is_original() {
  [ "$(kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.generation}' 2>/dev/null)" = "$ORIGINAL_MCP_GENERATION" ]
}

context_policy_snapshot() {
  kctl get networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" -o json 2>/dev/null |
    jq -ceS '{labels:{
      managedBy:.metadata.labels["clerum.io/managed-by"],
      policyType:.metadata.labels["clerum.io/policy-type"],
      context:.metadata.labels["clerum.io/context"],
      mcpserver:.metadata.labels["clerum.io/mcpserver"]},spec}'
}

context_policy_recreated_from_snapshot() {
  local live uid snapshot
  live="$(kctl get networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" -o json 2>/dev/null)" || return 1
  uid="$(jq -r '.metadata.uid // ""' <<<"$live")"
  [ -n "$uid" ] && [ "$uid" != "$ORIGINAL_POLICY_UID" ] || return 1
  snapshot="$(jq -ceS '{labels:{
    managedBy:.metadata.labels["clerum.io/managed-by"],
    policyType:.metadata.labels["clerum.io/policy-type"],
    context:.metadata.labels["clerum.io/context"],
    mcpserver:.metadata.labels["clerum.io/mcpserver"]},spec}' <<<"$live")" || return 1
  [ "$snapshot" = "$ORIGINAL_POLICY_SNAPSHOT" ]
}

probe_mcp_tcp_connectivity() {
  kctl exec deployment/"$PROBE_NAME" -n "$HOST_NS" -c probe -- \
    node -e '
      const net = require("node:net");
      const socket = net.connect(3000, process.argv[1]);
      const timer = setTimeout(() => { socket.destroy(); process.exit(42); }, 4000);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(0); });
      socket.once("error", () => { clearTimeout(timer); process.exit(43); });
    ' "${MCP_NAME}.${MCP_NS}.svc.cluster.local" >/dev/null 2>&1
}

probe_mcp_business_signal() {
  # shellcheck disable=SC2016 # JavaScript is intentionally literal.
  kctl exec deployment/"$PROBE_NAME" -n "$HOST_NS" -c probe -- \
    node -e '
      function parse(text) {
        try { return JSON.parse(text); } catch {
          const lines = text.split("\n").filter(line => line.startsWith("data: "));
          return lines.length ? JSON.parse(lines.at(-1).slice(6)) : null;
        }
      }
      async function post(body, sessionId) {
        const headers = {"content-type":"application/json",accept:"application/json, text/event-stream"};
        if (sessionId) headers["mcp-session-id"] = sessionId;
        const response = await fetch(process.argv[1], {
          method:"POST", headers, body:JSON.stringify(body), signal:AbortSignal.timeout(7000)
        });
        const text = await response.text();
        if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${text}`);
        return {response, parsed:parse(text), text};
      }
      (async () => {
        const initialized = await post({jsonrpc:"2.0",id:1,method:"initialize",params:{
          protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"pr568-t14",version:"1"}
        }});
        const sessionId = initialized.response.headers.get("mcp-session-id");
        if (!sessionId) throw new Error("missing mcp-session-id");
        const called = await post({jsonrpc:"2.0",id:2,method:"tools/call",params:{
          name:"add",arguments:{a:19,b:23}
        }}, sessionId);
        if (called.parsed?.error || called.parsed?.result?.isError === true) {
          throw new Error(`tool call failed: ${called.text}`);
        }
        if (!JSON.stringify(called.parsed?.result).includes("42")) {
          throw new Error(`add result did not contain 42: ${called.text}`);
        }
      })().then(() => process.exit(0)).catch(error => {
        console.error(error.message); process.exit(1);
      });
    ' "http://${MCP_NAME}.${MCP_NS}.svc.cluster.local:3000/mcp" >/dev/null
}

hcc_resync_config_is_expected() {
  [ "$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json |
    jq -r --arg key CONTEXT_MAPPER_NETPOL_RESYNC_SEC '
      [.spec.template.spec.containers[] | select(.name == "host-context-controller") |
       .env[]? | select(.name == $key) | .value][0] // ""')" = "$RESYNC_SECONDS" ]
}

hcc_resync_config_is_original() {
  local deployment count value
  deployment="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json)" || return 1
  count="$(jq -r --arg key CONTEXT_MAPPER_NETPOL_RESYNC_SEC '
    [.spec.template.spec.containers[] | select(.name == "host-context-controller") |
     .env[]? | select(.name == $key)] | length' <<<"$deployment")" || return 1
  [ "$count" = "$ORIGINAL_RESYNC_PRESENT" ] || return 1
  if [ "$ORIGINAL_RESYNC_PRESENT" = 1 ]; then
    value="$(jq -r --arg key CONTEXT_MAPPER_NETPOL_RESYNC_SEC '
      [.spec.template.spec.containers[] | select(.name == "host-context-controller") |
       .env[]? | select(.name == $key) | .value][0] // ""' <<<"$deployment")" || return 1
    [ "$value" = "$ORIGINAL_RESYNC_VALUE" ] || return 1
  fi
  [ "$(jq -r '.status.readyReplicas // 0' <<<"$deployment")" = 1 ] && probe_hcc_ready
}

restore_hcc_resync_config() {
  [ "$HCC_CONFIG_CAPTURED" = 1 ] || return 0
  if [ "$HCC_ENV_MUTATED" != 1 ]; then
    hcc_resync_config_is_original
    return
  fi
  if [ "$ORIGINAL_RESYNC_PRESENT" = 1 ]; then
    kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
      "CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${ORIGINAL_RESYNC_VALUE}" >/dev/null || return 1
  else
    kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
      CONTEXT_MAPPER_NETPOL_RESYNC_SEC- >/dev/null || return 1
  fi
  kctl rollout status deployment/"$HCC_DEPLOY" -n "$HCC_NS" --timeout=240s >/dev/null || return 1
  wait_until 60 "HCC readiness after restoring NetworkPolicy resync config" \
    hcc_resync_config_is_original
}

fixture_resources_absent() {
  resource_absent workflowrecipe "$RECIPE_NAME" "$WORKFLOW_NS" &&
    resource_absent context "$CONTEXT_NAME" "$MCP_NS" &&
    resource_absent mcpserver "$MCP_NAME" "$MCP_NS" &&
    resource_absent deployment "$MCP_NAME" "$MCP_NS" &&
    resource_absent service "$MCP_NAME" "$MCP_NS" &&
    resource_absent deployment "$PROBE_NAME" "$HOST_NS" &&
    resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" &&
    resource_absent networkpolicy "$CONTEXT_EGRESS_POLICY" "$HOST_NS" &&
    resource_absent networkpolicy "$RPC_EGRESS_POLICY" "$RPC_PROXY_NS"
}

print_repair_instructions() {
  cat >&2 <<EOF
WRC/HCC Context no-op resync gate cleanup could not restore a verified clean state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
Fixture: ${WORKFLOW_NS}/${RECIPE_NAME}, ${MCP_NS}/${CONTEXT_NAME}, ${MCP_NS}/${MCP_NAME}

Inspect before changing anything:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment ${HCC_DEPLOY} -o yaml
  kubectl --context=${E2E_KUBECONTEXT} get workflowrecipe,context,mcpserver -A -l e2e.clerum.io/suite=${SUITE_NAME}
  kubectl --context=${E2E_KUBECONTEXT} get deployment,service,networkpolicy -A -l e2e.clerum.io/suite=${SUITE_NAME}

Do not remove the HCC gate lock until the HCC config, readiness, and fixture cleanup are verified.
EOF
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1
  trap - EXIT
  set +e

  if [ "$PROBE_CREATED" = 1 ]; then
    kctl delete deployment "$PROBE_NAME" -n "$HOST_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$RECIPE_CREATED" = 1 ]; then
    kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_NS" --ignore-not-found \
      --wait=false >/dev/null 2>&1 || cleanup_failed=1
    wait_for_workflowrecipe_deleted "$WORKFLOW_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" \
      >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$CONTEXT_CREATED" = 1 ]; then
    kctl delete context "$CONTEXT_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$RECIPE_CREATED" = 1 ] || [ "$CONTEXT_CREATED" = 1 ]; then
    kctl delete mcpserver "$MCP_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete deployment "$MCP_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete service "$MCP_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$CONTEXT_EGRESS_POLICY" -n "$HOST_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$RPC_EGRESS_POLICY" -n "$RPC_PROXY_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    wait_until 90 "all WRC/HCC Context no-op fixtures to disappear" fixture_resources_absent \
      >/dev/null 2>&1 || cleanup_failed=1
  fi
  restore_hcc_resync_config >/dev/null 2>&1 || restore_ok=0

  if ! finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"; then
    cleanup_failed=1
  fi
  if [ "$cleanup_failed" -ne 0 ] || [ "$restore_ok" != 1 ]; then
    print_repair_instructions
    [ "$status" = 0 ] && status=1
  fi
  if [ "$status" = 0 ] && [ "$cleanup_failed" = 0 ] && [ "$restore_ok" = 1 ]; then
    header "WRC/HCC Context no-op and periodic resync gate passed"
    echo "$FINAL_SUMMARY"
    print_results
  fi
  exit "$status"
}
trap cleanup EXIT

header "WRC to HCC Context no-op and periodic NetworkPolicy resync"

require_branch_owned_hcc_gate "$HCC_NS"
kctl get nodes -o json |
  jq -e --arg context "$E2E_KUBECONTEXT" \
    'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $context)' >/dev/null ||
  die "target context is not a minikube cluster"
fixture_resources_absent ||
  die "stale ${SUITE_NAME} resources exist; inspect them before starting a new fault injection"
acquire_hcc_watch_gate_lock ||
  die "another disruptive HCC gate owns context ${E2E_KUBECONTEXT}"
ok "branch helper, profile, exact HEAD/fingerprint/gate, and exclusive HCC lock verified"

hcc_deployment="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json)"
resync_entries="$(jq -c --arg key CONTEXT_MAPPER_NETPOL_RESYNC_SEC '
  [.spec.template.spec.containers[] | select(.name == "host-context-controller") |
   .env[]? | select(.name == $key)]' <<<"$hcc_deployment")"
ORIGINAL_RESYNC_PRESENT="$(jq -r 'length' <<<"$resync_entries")"
[ "$ORIGINAL_RESYNC_PRESENT" -le 1 ] ||
  die "HCC Deployment has duplicate CONTEXT_MAPPER_NETPOL_RESYNC_SEC entries"
if [ "$ORIGINAL_RESYNC_PRESENT" = 1 ]; then
  jq -e '.[0].value | type == "string"' <<<"$resync_entries" >/dev/null ||
    die "HCC resync env uses valueFrom or a non-string shape that this gate cannot restore"
  ORIGINAL_RESYNC_VALUE="$(jq -r '.[0].value' <<<"$resync_entries")"
fi
HCC_CONFIG_CAPTURED=1
HCC_IMAGE="$(jq -r '
  [.spec.template.spec.containers[] | select(.name == "host-context-controller") | .image][0] // ""
' <<<"$hcc_deployment")"
HCC_PORT="$(jq -r '
  [.spec.template.spec.containers[] | select(.name == "host-context-controller") |
   ([.env[]? | select(.name == "CONTEXT_MAPPER_PORT") | .value][0] //
    [.ports[]? | select(.name == "http") | .containerPort][0] // "")][0]
' <<<"$hcc_deployment")"
[ -n "$HCC_IMAGE" ] || die "could not resolve HCC image for the data-plane probe"
[[ "$HCC_PORT" =~ ^[0-9]+$ ]] || die "could not resolve HCC HTTP port"

wait_until 60 "baseline HCC /ready" probe_hcc_ready ||
  die "HCC /ready was unavailable before the cross-controller fixture"
read -r HCC_UID HCC_RESTARTS <<<"$(
  kctl get pod "$(running_hcc_pod)" -n "$HCC_NS" \
    -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}'
)"
[ -n "$HCC_UID" ] && [ -n "$HCC_RESTARTS" ] || die "could not capture baseline HCC pod identity"
ok "baseline HCC process is Ready before WRC creates the fixture"

CONTEXT_CREATED=1
RECIPE_CREATED=1
kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${CONTEXT_NAME}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextId: ${CONTEXT_NAME}
  description: Shared Context entry point for the PR 568 cross-controller gate.
  mcpServers: []
---
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${WORKFLOW_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  description: Initial WRC to HCC Context projection.
  contextRef: ${CONTEXT_NAME}
  workloads:
    - id: mock-tools
      type: deployment
      image: clerum/mock-mcp-server:test
      imagePullPolicy: IfNotPresent
      port: 3000
      transport:
        type: streamableHttp
        path: /mcp
      healthCheck:
        type: tcp
        port: 3001
      resources:
        requests: {cpu: 20m, memory: 48Mi}
        limits: {cpu: 150m, memory: 128Mi}
  security:
    isolationLevel: minimal
EOF

wait_until 300 "WRC projection, MCP runtime, status, and all three HCC policies" \
  context_projection_converged ||
  die "WorkflowRecipe did not converge through WRC, Context watch, HCC policies, and MCP runtime"
ok "real WorkflowRecipe converged through WRC, apiserver, Context watch, HCC, and MCP runtime"

PROBE_CREATED=1
kctl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${PROBE_NAME}
  namespace: ${HOST_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  replicas: 1
  selector:
    matchLabels: {app: ${PROBE_NAME}}
  template:
    metadata:
      labels:
        app: ${PROBE_NAME}
        clerum.io/managed-by: host-context-controller
        clerum.io/context: ${CONTEXT_NAME}
        e2e.clerum.io/suite: ${SUITE_NAME}
        e2e.clerum.io/run: "${RUN_LABEL}"
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
        - name: probe
          image: ${HCC_IMAGE}
          imagePullPolicy: IfNotPresent
          command: [node, -e, "setInterval(()=>{},60000)"]
          resources:
            requests: {cpu: 5m, memory: 16Mi}
            limits: {cpu: 50m, memory: 48Mi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            seccompProfile: {type: RuntimeDefault}
EOF
kctl rollout status deployment/"$PROBE_NAME" -n "$HOST_NS" --timeout=120s >/dev/null ||
  die "mcp-host data-plane probe did not become ready"
wait_until 60 "baseline MCP add(19,23) business signal" probe_mcp_business_signal ||
  die "baseline MCP business signal did not return 42 through Context policies"
ok "baseline mcp-host-labelled probe invoked add(19,23) and received 42"

ORIGINAL_CONTEXT_RV="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.resourceVersion}')"
ORIGINAL_CONTEXT_GENERATION="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.generation}')"
ORIGINAL_MCP_GENERATION="$(kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.generation}')"
reconciles_before="$(wrc_reconcile_count)" || die "could not establish WRC reconcile log baseline"
description_patch="$(jq -cn --arg description \
  'PR 568 no-op projection after a real recipe-only change.' '{spec:{description:$description}}')"
kctl patch workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_NS" --type=merge \
  -p "$description_patch" >/dev/null
wait_until 90 "WRC to process the recipe-only description change" \
  wrc_reconciled_after "$reconciles_before" ||
  die "WRC did not visibly reconcile the recipe-only change"
context_identity_is_original ||
  die "a recipe-only change emitted a no-op Context PUT"
mcp_generation_is_original ||
  die "a recipe-only change unexpectedly changed McpServer desired generation"
hcc_identity_is_stable || die "HCC restarted during the WRC no-op projection proof"
ok "WRC processed a real recipe change without moving Context resourceVersion"

# Arm the timer only after the WRC no-op proof. A final rollout to the requested
# interval creates a fresh, bounded observation window for the policy-delete
# phase before periodic convergence runs.
HCC_ENV_MUTATED=1
if [ "$ORIGINAL_RESYNC_PRESENT" = 1 ] && [ "$ORIGINAL_RESYNC_VALUE" = "$RESYNC_SECONDS" ]; then
  arm_interval=$((RESYNC_SECONDS + 1))
  kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    "CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${arm_interval}" >/dev/null
  kctl rollout status deployment/"$HCC_DEPLOY" -n "$HCC_NS" --timeout=240s >/dev/null ||
    die "HCC did not complete the timer re-arm rollout"
fi
kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
  "CONTEXT_MAPPER_NETPOL_RESYNC_SEC=${RESYNC_SECONDS}" >/dev/null
kctl rollout status deployment/"$HCC_DEPLOY" -n "$HCC_NS" --timeout=240s >/dev/null ||
  die "HCC did not roll out with the bounded NetworkPolicy resync interval"
wait_until 60 "HCC resync config and readiness" hcc_resync_config_is_expected ||
  die "HCC did not expose the requested NetworkPolicy resync interval"
wait_until 60 "HCC /ready after arming periodic convergence" probe_hcc_ready ||
  die "HCC /ready did not recover after arming periodic convergence"
read -r HCC_UID HCC_RESTARTS <<<"$(
  kctl get pod "$(running_hcc_pod)" -n "$HCC_NS" \
    -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}'
)"
[ -n "$HCC_UID" ] && [ -n "$HCC_RESTARTS" ] || die "could not capture armed HCC pod identity"
context_identity_is_original || die "arming HCC changed Context desired identity"
mcp_generation_is_original || die "arming HCC changed McpServer desired generation"
wait_until 120 "Context policies after the HCC timer rollout" context_projection_converged ||
  die "Context policies did not remain converged after the HCC timer rollout"
wait_until 60 "MCP business signal after the HCC timer rollout" probe_mcp_business_signal ||
  die "MCP business signal failed before policy fault injection"
wait_until 180 "the armed HCC startup NetworkPolicy pass to complete" \
  hcc_log_contains "[NetPol] Full reconciliation complete" ||
  die "HCC startup NetworkPolicy pass did not complete before policy fault injection"
ok "HCC periodic NetworkPolicy resync is freshly armed at ${RESYNC_SECONDS}s on a stable pod"

ORIGINAL_POLICY_UID="$(kctl get networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" \
  -o jsonpath='{.metadata.uid}')"
ORIGINAL_POLICY_SNAPSHOT="$(context_policy_snapshot)" ||
  die "could not capture the canonical Context ingress policy"
[ -n "$ORIGINAL_POLICY_UID" ] && [ -n "$ORIGINAL_POLICY_SNAPSHOT" ] ||
  die "Context ingress policy baseline was empty"

kctl delete networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" --wait=true --timeout=60s >/dev/null
resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" ||
  die "fault injection did not remove the Context ingress policy"
if probe_mcp_tcp_connectivity; then
  die "MCP data plane remained reachable after deleting its only Context ingress policy"
fi
resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" ||
  die "Context ingress policy was recreated before the isolation failure could be attributed"
mcp_runtime_still_ready ||
  die "MCP workload or Service endpoints became unhealthy during the policy fault"
ok "policy deletion produced a real fail-closed MCP data-plane interruption"

wait_until "$RESYNC_TIMEOUT_SECONDS" \
  "HCC periodic convergence to recreate the canonical Context policy" \
  context_policy_recreated_from_snapshot ||
  die "HCC periodic convergence did not recreate the deleted Context policy"
context_identity_is_original ||
  die "Context desired state changed while waiting for periodic policy recovery"
mcp_generation_is_original ||
  die "McpServer desired state changed while waiting for periodic policy recovery"
hcc_identity_is_stable ||
  die "HCC restarted instead of healing the deleted policy in process"
wait_until 60 "MCP business signal after periodic policy recovery" probe_mcp_business_signal ||
  die "recreated policy did not restore the MCP add(19,23) business signal"
probe_hcc_ready || die "HCC lost readiness after periodic policy recovery"
ok "HCC recreated the policy without a Context/McpServer change or process restart"
ok "the restored data plane again returned 42 from the MCP add tool"

FINAL_SUMMARY="$(jq -cn \
  --arg recipe "$RECIPE_NAME" --arg context "$CONTEXT_NAME" --arg server "$MCP_NAME" \
  --arg oldPolicyUid "$ORIGINAL_POLICY_UID" \
  --arg newPolicyUid "$(kctl get networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" -o jsonpath='{.metadata.uid}')" \
  --arg contextResourceVersion "$ORIGINAL_CONTEXT_RV" \
  --arg hccPodUid "$HCC_UID" --argjson resyncSeconds "$RESYNC_SECONDS" \
  '{recipe:$recipe,context:$context,server:$server,resyncSeconds:$resyncSeconds,
    contextResourceVersion:$contextResourceVersion,hccPodUid:$hccPodUid,
    oldPolicyUid:$oldPolicyUid,newPolicyUid:$newPolicyUid,businessSignal:"add(19,23)=42"}')"

header "WRC/HCC Context assertions complete; restoring branch-owned runtime"
