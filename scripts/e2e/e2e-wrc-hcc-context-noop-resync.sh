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
SECOND_MCP_NAME="$(truncate_rfc1123 "${RECIPE_NAME}-mock-tools-2")"
PROBE_NAME="$(truncate_rfc1123 "e2e-pr568-probe-${RUN_LABEL}")"
HOST_NAME="$(truncate_rfc1123 "e2e-pr568-host-${RUN_LABEL}")"
SOURCE_HOST_NAME="${E2E_WRC_HCC_SOURCE_HOST:-chatllm}"
CONTEXT_POLICY="ctx-${CONTEXT_NAME}-${MCP_NAME}"
CONTEXT_EGRESS_POLICY="${CONTEXT_POLICY}-egress"
RPC_EGRESS_POLICY="rpc-egress-${CONTEXT_NAME}-${MCP_NAME}"
SECOND_CONTEXT_POLICY="ctx-${CONTEXT_NAME}-${SECOND_MCP_NAME}"
SECOND_CONTEXT_EGRESS_POLICY="${SECOND_CONTEXT_POLICY}-egress"
SECOND_RPC_EGRESS_POLICY="rpc-egress-${CONTEXT_NAME}-${SECOND_MCP_NAME}"
WORKLOAD_SELECTOR="clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=mock-tools"
SECOND_WORKLOAD_SELECTOR="clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=mock-tools-2"
WRC_CLEANUP_KINDS="deployment,statefulset,daemonset,job,cronjob,replicaset,pod,service,serviceaccount,role,rolebinding,configmap,secret,persistentvolumeclaim,networkpolicy"
RESYNC_SECONDS="${E2E_WRC_HCC_NETPOL_RESYNC_SEC:-120}"
RESYNC_TIMEOUT_SECONDS="${E2E_WRC_HCC_RESYNC_TIMEOUT_SEC:-360}"

[[ "$RESYNC_SECONDS" =~ ^[1-9][0-9]*$ ]] && [ "$RESYNC_SECONDS" -ge 30 ] &&
  [ "$RESYNC_SECONDS" -le 120 ] || {
  echo "E2E_WRC_HCC_NETPOL_RESYNC_SEC must be an integer from 30 through 120." >&2
  exit 1
}
[[ "$RESYNC_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] &&
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
HOST_CREATED=0
ORIGINAL_CONTEXT_RV=""
ORIGINAL_CONTEXT_GENERATION=""
ORIGINAL_MCP_GENERATION=""
ORIGINAL_SECOND_MCP_GENERATION=""
PROBE_BASELINE_IDENTITY=""
PRIMARY_MCP_BASELINE_IDENTITY=""
SECOND_MCP_BASELINE_IDENTITY=""
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

utc_now() {
  node -e 'process.stdout.write(new Date().toISOString())'
}

resource_absent() {
  local kind=$1 name=$2 namespace=$3 found
  found="$(kctl get "$kind" "$name" -n "$namespace" --ignore-not-found -o name 2>/dev/null)" ||
    return 1
  [ -z "$found" ]
}

resource_collection_absent() {
  local kind=$1 namespace=$2 selector=$3 count
  count="$(kctl get "$kind" -n "$namespace" -l "$selector" -o json 2>/dev/null |
    jq -r '.items | length')" || return 1
  [ "$count" = 0 ]
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
  local marker=$1 pod logs
  pod="$(running_hcc_pod)" || return 1
  logs="$(kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller \
    --since=10m 2>/dev/null)" || return 1
  grep -Fq "$marker" <<<"$logs"
}

mcpserver_named_current_ready() {
  local server=$1
  kctl get mcpserver "$server" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e '
      .metadata.generation as $generation |
      any(.status.conditions[]?;
        .type == "Ready" and .status == "True" and
        (.observedGeneration // -1) == $generation)
    ' >/dev/null
}

mcp_workload_deployment_named_json() {
  local selector=$1 deployments
  deployments="$(kctl get deployments -n "$MCP_NS" -l "$selector" -o json 2>/dev/null)" ||
    return 1
  jq -ce 'if (.items | length) == 1 then .items[0] else empty end' <<<"$deployments"
}

mcp_named_runtime_still_ready() {
  local server=$1 selector=$2 deployment deployment_ready endpoint_addresses
  mcpserver_named_current_ready "$server" || return 1
  deployment="$(mcp_workload_deployment_named_json "$selector")" || return 1
  deployment_ready="$(jq -r '.status.readyReplicas // 0' <<<"$deployment")" || return 1
  [ "${deployment_ready:-0}" -ge 1 ] || return 1
  endpoint_addresses="$(kctl get endpoints "$server" -n "$MCP_NS" \
    -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)" || return 1
  [ -n "$endpoint_addresses" ]
}

mcp_runtime_still_ready() {
  mcp_named_runtime_still_ready "$MCP_NAME" "$WORKLOAD_SELECTOR"
}

selector_runtime_identity() {
  local namespace=$1 selector=$2 deployment_name=${3:-} deployment_object deployment pods
  if [ -n "$deployment_name" ]; then
    deployment_object="$(kctl get deployment "$deployment_name" -n "$namespace" -o json 2>/dev/null)" ||
      return 1
  else
    deployment_object="$(kctl get deployments -n "$namespace" -l "$selector" -o json 2>/dev/null |
      jq -ce 'if (.items | length) == 1 then .items[0] else empty end')" || return 1
  fi
  deployment="$(jq -ce \
    '[.metadata.uid, .metadata.generation, .spec.replicas, .spec.selector, .spec.template]' \
    <<<"$deployment_object")" || return 1
  pods="$(kctl get pods -n "$namespace" -l "$selector" -o json 2>/dev/null |
    jq -ceS '[.items[] |
      select(.status.phase == "Running" and .metadata.deletionTimestamp == null) |
      select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
      {uid:.metadata.uid,containers:([.status.containerStatuses[]? |
        {name,restartCount}] | sort_by(.name))}] | sort_by(.uid)')" || return 1
  [ "$(jq -r 'length' <<<"$pods")" -ge 1 ] || return 1
  printf '%s | %s\n' "$deployment" "$pods"
}

policy_has_identity() {
  local namespace=$1 name=$2 policy_type=$3 server=$4
  kctl get networkpolicy "$name" -n "$namespace" -o json 2>/dev/null |
    jq -e \
      --arg context "$CONTEXT_NAME" \
      --arg server "$server" \
      --arg policyType "$policy_type" '
      .metadata.labels["clerum.io/managed-by"] == "host-context-controller" and
      .metadata.labels["clerum.io/policy-type"] == $policyType and
      .metadata.labels["clerum.io/context"] == $context and
      .metadata.labels["clerum.io/mcpserver"] == $server
    ' >/dev/null
}

context_projection_converged() {
  local context deployment deployment_ready
  context="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" -o json 2>/dev/null)" || return 1
  jq -e --arg server "$MCP_NAME" '
    .spec.contextId == .metadata.name and
    .spec.mcpServers == [$server] and
    .metadata.labels["clerum.io/managed-by"] == "wrc" and
    (.metadata.labels["clerum.io/recipe"] // "") == "" and
    ((.metadata.ownerReferences // []) | length) == 0
  ' <<<"$context" >/dev/null || return 1
  kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e --arg context "$CONTEXT_NAME" '.spec.contextRef == $context' >/dev/null || return 1
  mcpserver_named_current_ready "$MCP_NAME" || return 1
  deployment="$(mcp_workload_deployment_named_json "$WORKLOAD_SELECTOR")" || return 1
  deployment_ready="$(jq -r '.status.readyReplicas // 0' <<<"$deployment")" || return 1
  [ "${deployment_ready:-0}" -ge 1 ] || return 1
  kctl get service "$MCP_NAME" -n "$MCP_NS" >/dev/null 2>&1 || return 1
  policy_has_identity "$MCP_NS" "$CONTEXT_POLICY" context-allow "$MCP_NAME" || return 1
  policy_has_identity "$HOST_NS" "$CONTEXT_EGRESS_POLICY" context-allow "$MCP_NAME" || return 1
  policy_has_identity "$RPC_PROXY_NS" "$RPC_EGRESS_POLICY" rpc-proxy-egress "$MCP_NAME"
}

expanded_context_projection_converged() {
  local context
  context="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" -o json 2>/dev/null)" || return 1
  jq -e --arg first "$MCP_NAME" --arg second "$SECOND_MCP_NAME" '
    .spec.contextId == .metadata.name and
    ((.spec.mcpServers | sort) == ([$first, $second] | sort)) and
    .metadata.labels["clerum.io/managed-by"] == "wrc" and
    (.metadata.labels["clerum.io/recipe"] // "") == "" and
    ((.metadata.ownerReferences // []) | length) == 0
  ' <<<"$context" >/dev/null || return 1
  kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e --arg context "$CONTEXT_NAME" '.spec.contextRef == $context' >/dev/null || return 1
  kctl get mcpserver "$SECOND_MCP_NAME" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e --arg context "$CONTEXT_NAME" '.spec.contextRef == $context' >/dev/null || return 1
  mcp_named_runtime_still_ready "$MCP_NAME" "$WORKLOAD_SELECTOR" || return 1
  mcp_named_runtime_still_ready "$SECOND_MCP_NAME" "$SECOND_WORKLOAD_SELECTOR" || return 1
  policy_has_identity "$MCP_NS" "$CONTEXT_POLICY" context-allow "$MCP_NAME" || return 1
  policy_has_identity "$HOST_NS" "$CONTEXT_EGRESS_POLICY" context-allow "$MCP_NAME" || return 1
  policy_has_identity "$RPC_PROXY_NS" "$RPC_EGRESS_POLICY" rpc-proxy-egress "$MCP_NAME" ||
    return 1
  policy_has_identity "$MCP_NS" "$SECOND_CONTEXT_POLICY" context-allow "$SECOND_MCP_NAME" ||
    return 1
  policy_has_identity "$HOST_NS" "$SECOND_CONTEXT_EGRESS_POLICY" context-allow \
    "$SECOND_MCP_NAME" || return 1
  policy_has_identity "$RPC_PROXY_NS" "$SECOND_RPC_EGRESS_POLICY" rpc-proxy-egress \
    "$SECOND_MCP_NAME"
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

host_runtime_ready() {
  local deployment ready desired pod_rows ready_pods endpoint_addresses
  deployment="$(kctl get deployment "$HOST_NAME" -n "$HOST_NS" -o json 2>/dev/null)" ||
    return 1
  jq -e --arg host "$HOST_NAME" --arg context "$CONTEXT_NAME" '
    .metadata.labels["clerum.io/managed-by"] == "host-context-controller" and
    .metadata.labels["clerum.io/host"] == $host and
    .spec.template.metadata.labels["clerum.io/context"] == $context
  ' <<<"$deployment" >/dev/null || return 1
  ready="$(jq -r '.status.readyReplicas // 0' <<<"$deployment")"
  desired="$(jq -r '.spec.replicas // 0' <<<"$deployment")"
  [ "$desired" = 1 ] && [ "$ready" = 1 ] || return 1
  pod_rows="$(kctl get pods -n "$HOST_NS" -l "clerum.io/host=${HOST_NAME}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.uid}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null)" || return 1
  ready_pods="$(awk -F '\t' '$1 != "" && $2 == "True" && $3 == "" { count++ } END { print count + 0 }' \
    <<<"$pod_rows")"
  [ "$ready_pods" = 1 ] || return 1
  endpoint_addresses="$(kctl get endpoints "$HOST_NAME" -n "$HOST_NS" \
    -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)" || return 1
  [ -n "$endpoint_addresses" ]
}

host_deployment_identity() {
  selector_runtime_identity "$HOST_NS" \
    "clerum.io/managed-by=host-context-controller,clerum.io/host=${HOST_NAME}" "$HOST_NAME"
}

probe_host_runtime_health() {
  local port
  port="$(kctl get deployment "$HOST_NAME" -n "$HOST_NS" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-host")].ports[?(@.name=="http")].containerPort}' \
    2>/dev/null)" || return 1
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  # shellcheck disable=SC2016 # JavaScript is intentionally literal.
  kctl exec deployment/"$HOST_NAME" -n "$HOST_NS" -c mcp-host -- \
    env "MCP_HOST_E2E_PORT=${port}" node -e '
      const http = require("node:http");
      const request = http.get(
        {host:"127.0.0.1",port:Number(process.env.MCP_HOST_E2E_PORT),path:"/v1/runtime/health"},
        response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              process.exit(response.statusCode === 200 && parsed?.status === "ok" ? 0 : 2);
            } catch { process.exit(3); }
          });
        }
      );
      request.setTimeout(5000, () => request.destroy(new Error("timeout")));
      request.once("error", () => process.exit(4));
    ' >/dev/null 2>&1
}

host_reconcile_witness_count() {
  local logs
  logs="$(kctl logs deployment/"$HCC_DEPLOY" -n "$HCC_NS" --since=15m 2>/dev/null)" ||
    return 1
  jq -Rr --arg host "$HOST_NAME" '
    fromjson? |
    select(.host == $host) |
    (.msg // .message // "") |
    select(test("mcp-host-runtime-token Secret")) |
    1
  ' <<<"$logs" | awk 'NF { count++ } END { print count + 0 }'
}

host_reconcile_witness_count_since() {
  local since_time=$1 host=${2:-} logs
  logs="$(kctl logs deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    --since-time="$since_time" 2>/dev/null)" || return 1
  jq -Rr --arg host "$host" '
    fromjson? |
    select($host == "" or .host == $host) |
    (.msg // .message // "") |
    select(test("mcp-host-runtime-token Secret")) |
    1
  ' <<<"$logs" | awk 'NF { count++ } END { print count + 0 }'
}

host_reconcile_witness_exists() {
  local current
  current="$(host_reconcile_witness_count)" || return 1
  [ "$current" -gt 0 ]
}

host_fleet_reconcile_count_since() {
  local since_time=$1 logs
  logs="$(kctl logs deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    --since-time="$since_time" 2>/dev/null)" || return 1
  grep -Ec '\[K8s\] Reconciling [0-9]+ Host\(s\)' <<<"$logs" || true
}

context_netpol_failure_count_since() {
  local since_time=$1 logs
  logs="$(kctl logs deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    --since-time="$since_time" 2>/dev/null)" || return 1
  grep -Fc "[K8s] NetworkPolicy reconciliation failed for context ${CONTEXT_NAME}:" \
    <<<"$logs" || true
}

hcc_metric_value() {
  local metric=$1 required_labels=${2:-} pod
  pod="$(running_hcc_pod)" || return 1
  # shellcheck disable=SC2016 # JavaScript template interpolation is intentional.
  kctl exec "pod/${pod}" -n "$HCC_NS" -c host-context-controller -- \
    env "HCC_E2E_PORT=${HCC_PORT}" "HCC_E2E_METRIC=${metric}" \
      "HCC_E2E_REQUIRED_LABELS=${required_labels}" node -e '
      const http = require("node:http");
      const request = http.get({host:"127.0.0.1",port:Number(process.env.HCC_E2E_PORT),path:"/metrics"}, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => {
          if (response.statusCode !== 200) process.exit(4);
          const metric = process.env.HCC_E2E_METRIC;
          const labels = (process.env.HCC_E2E_REQUIRED_LABELS || "")
            .split("|").filter(Boolean);
          const line = body.split("\n").find(value =>
            (value.startsWith(`${metric} `) || value.startsWith(`${metric}{`)) &&
            labels.every(label => value.includes(label)));
          if (!line) process.exit(2);
          process.stdout.write(line.trim().split(/\s+/).at(-1));
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error("timeout")));
      request.once("error", () => process.exit(3));
    ' 2>/dev/null
}

hcc_metadata_only_event_count() {
  hcc_metric_value clerum_hcc_context_metadata_only_events_total
}

hcc_metadata_only_event_after() {
  local before=$1 current
  current="$(hcc_metadata_only_event_count)" || return 1
  awk -v current="$current" -v before="$before" 'BEGIN { exit(current >= before + 1 ? 0 : 1) }'
}

hcc_netpol_certified_count() {
  hcc_metric_value clerum_hcc_initial_convergence_pass_results_total \
    'lane="NetworkPolicy"|result="certified"'
}

hcc_netpol_certified_after() {
  local before=$1 current
  current="$(hcc_netpol_certified_count)" || return 1
  awk -v current="$current" -v before="$before" 'BEGIN { exit(current > before ? 0 : 1) }'
}

hcc_netpol_last_success_epoch() {
  hcc_metric_value clerum_hcc_initial_convergence_last_success_timestamp_seconds \
    'lane="NetworkPolicy"'
}

hcc_netpol_timer_arm_epoch() {
  local pod logs timestamp
  pod="$(running_hcc_pod)" || return 1
  logs="$(kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller \
    --since=10m --timestamps=true 2>/dev/null)" || return 1
  timestamp="$(awk -v marker="NetworkPolicy periodic resync enabled (every ${RESYNC_SECONDS}s)" \
    'index($0, marker) { value=$1 } END { print value }' <<<"$logs")"
  [ -n "$timestamp" ] || return 1
  node -e '
    const value = Date.parse(process.argv[1]);
    if (!Number.isFinite(value)) process.exit(2);
    process.stdout.write(String(Math.floor(value / 1000)));
  ' "$timestamp"
}

netpol_desired_inventory_snapshot() {
  local contexts servers
  contexts="$(kctl get context -A -o json 2>/dev/null)" || return 1
  servers="$(kctl get mcpserver -A -o json 2>/dev/null)" || return 1
  jq -ceS -n --argjson contexts "$contexts" --argjson servers "$servers" '
    {contexts:([$contexts.items[] |
       {namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid,
        generation:.metadata.generation,spec:.spec}] | sort_by(.namespace,.name)),
     servers:([$servers.items[] |
       {namespace:.metadata.namespace,name:.metadata.name,uid:.metadata.uid,
        generation:.metadata.generation,spec:.spec,
        labels:(.metadata.labels // {}),
        annotations:((.metadata.annotations // {}) | del(."clerum.io/network-ready"))}] |
       sort_by(.namespace,.name))}
  '
}

netpol_watch_recovery_count_since() {
  local since_time=$1 logs
  logs="$(kctl logs deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    --since-time="$since_time" 2>/dev/null)" || return 1
  grep -Ec '\[K8s\] (Context|McpServer) watch ended; recovering authoritative inventory' \
    <<<"$logs" || true
}

hcc_host_urgent_success_count() {
  hcc_metric_value clerum_hcc_host_reconcile_duration_seconds_count \
    'source="urgent"|outcome="success"'
}

wait_for_positive_host_fanout() {
  local timeout=$1 since_time=$2 urgent_before=$3 deadline
  local target_witnesses all_witnesses urgent fleet failures urgent_delta
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    target_witnesses="$(host_reconcile_witness_count_since "$since_time" "$HOST_NAME")" ||
      return 1
    all_witnesses="$(host_reconcile_witness_count_since "$since_time")" || return 1
    urgent="$(hcc_host_urgent_success_count)" || return 1
    fleet="$(host_fleet_reconcile_count_since "$since_time")" || return 1
    failures="$(context_netpol_failure_count_since "$since_time")" || return 1
    urgent_delta="$(awk -v current="$urgent" -v before="$urgent_before" \
      'BEGIN { print current - before }')"
    if [ "$target_witnesses" -gt 1 ] || [ "$all_witnesses" -gt 1 ] ||
      [ "$all_witnesses" -gt "$target_witnesses" ] || [ "$fleet" -gt 0 ] ||
      [ "$failures" -gt 0 ] || awk -v delta="$urgent_delta" \
        -v target="$target_witnesses" \
        'BEGIN { exit(delta > 1 || (delta > 0 && target == 0) ? 0 : 1) }'; then
      echo "Host activity outside the fixture made fan-out attribution inconclusive" >&2
      return 2
    fi
    if [ "$target_witnesses" = 1 ] && [ "$all_witnesses" = 1 ] &&
      awk -v delta="$urgent_delta" 'BEGIN { exit(delta == 1 ? 0 : 1) }'; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out after ${timeout}s waiting for one isolated Host fan-out" >&2
  return 1
}

host_activity_stays() {
  local expected_witnesses=$1 expected_urgent=$2 seconds=$3 deadline witnesses urgent
  deadline=$(( $(date +%s) + seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    witnesses="$(host_reconcile_witness_count)" || return 1
    urgent="$(hcc_host_urgent_success_count)" || return 1
    [ "$witnesses" = "$expected_witnesses" ] || return 1
    [ "$urgent" = "$expected_urgent" ] || return 1
    sleep 1
  done
}

target_host_activity_stays_absent() {
  local since_time=$1 seconds=$2 deadline witnesses
  deadline=$(( $(date +%s) + seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    witnesses="$(host_reconcile_witness_count_since "$since_time" "$HOST_NAME")" || return 1
    [ "$witnesses" = 0 ] || return 1
    sleep 1
  done
}

context_identity_is_original() {
  local identity
  identity="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}' 2>/dev/null)" || return 1
  [ "$identity" = "${ORIGINAL_CONTEXT_RV} ${ORIGINAL_CONTEXT_GENERATION}" ]
}

mcp_generation_is_original() {
  [ "$(kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.generation}' 2>/dev/null)" = "$ORIGINAL_MCP_GENERATION" ] &&
    [ "$(kctl get mcpserver "$SECOND_MCP_NAME" -n "$MCP_NS" \
      -o jsonpath='{.metadata.generation}' 2>/dev/null)" = "$ORIGINAL_SECOND_MCP_GENERATION" ]
}

policy_snapshot() {
  local namespace=$1 name=$2
  kctl get networkpolicy "$name" -n "$namespace" -o json 2>/dev/null |
    jq -ceS '{labels:{
      managedBy:.metadata.labels["clerum.io/managed-by"],
      policyType:.metadata.labels["clerum.io/policy-type"],
      context:.metadata.labels["clerum.io/context"],
      mcpserver:.metadata.labels["clerum.io/mcpserver"]},spec}'
}

policy_recreated_from_snapshot() {
  local namespace=$1 name=$2 original_uid=$3 original_snapshot=$4 live uid snapshot
  live="$(kctl get networkpolicy "$name" -n "$namespace" -o json 2>/dev/null)" || return 1
  uid="$(jq -r '.metadata.uid // ""' <<<"$live")"
  [ -n "$uid" ] && [ "$uid" != "$original_uid" ] || return 1
  snapshot="$(jq -ceS '{labels:{
    managedBy:.metadata.labels["clerum.io/managed-by"],
    policyType:.metadata.labels["clerum.io/policy-type"],
    context:.metadata.labels["clerum.io/context"],
    mcpserver:.metadata.labels["clerum.io/mcpserver"]},spec}' <<<"$live")" || return 1
  [ "$snapshot" = "$original_snapshot" ]
}

context_policy_snapshot() {
  policy_snapshot "$MCP_NS" "$CONTEXT_POLICY"
}

context_policy_recreated_from_snapshot() {
  policy_recreated_from_snapshot \
    "$MCP_NS" "$CONTEXT_POLICY" "$ORIGINAL_POLICY_UID" "$ORIGINAL_POLICY_SNAPSHOT"
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

mcp_data_plane_is_policy_blocked() {
  local connectivity_rc
  resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" || return 1
  mcp_runtime_still_ready || return 1
  [ "$(selector_runtime_identity "$HOST_NS" "app=${PROBE_NAME}" "$PROBE_NAME")" = \
    "$PROBE_BASELINE_IDENTITY" ] || return 1
  [ "$(selector_runtime_identity "$MCP_NS" "$WORKLOAD_SELECTOR")" = \
    "$PRIMARY_MCP_BASELINE_IDENTITY" ] || return 1
  [ "$(selector_runtime_identity "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR")" = \
    "$SECOND_MCP_BASELINE_IDENTITY" ] || return 1
  if probe_mcp_tcp_connectivity; then
    return 1
  else
    connectivity_rc=$?
  fi
  # The remote Node probe reserves 42 for a TCP timeout. DNS, connection
  # refusal, kubectl/API failures, or an unhealthy probe return a different code.
  [ "$connectivity_rc" = 42 ] || return 1
  # Same pod, DNS, namespace, and CNI path; only the deleted primary policy
  # differs. A successful exact tool call rules out a cluster-wide timeout.
  probe_mcp_business_signal "$SECOND_MCP_NAME"
}

probe_mcp_business_signal_from() {
  local target=$1 namespace=$2 container=$3 server=$4
  # shellcheck disable=SC2016 # JavaScript is intentionally literal.
  kctl exec "$target" -n "$namespace" -c "$container" -- \
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
        const content = called.parsed?.result?.content;
        if (!Array.isArray(content) || content.length !== 1 ||
            content[0]?.type !== "text" || content[0]?.text !== "42") {
          throw new Error(`add result was not exactly one text value 42: ${called.text}`);
        }
      })().then(() => process.exit(0)).catch(error => {
        console.error(error.message); process.exit(1);
      });
    ' "http://${server}.${MCP_NS}.svc.cluster.local:3000/mcp" >/dev/null
}

probe_mcp_business_signal() {
  probe_mcp_business_signal_from deployment/"$PROBE_NAME" "$HOST_NS" probe "${1:-$MCP_NAME}"
}

probe_host_mcp_business_signal() {
  probe_mcp_business_signal_from deployment/"$HOST_NAME" "$HOST_NS" mcp-host "${1:-$MCP_NAME}"
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
    resource_absent host "$HOST_NAME" "$HOST_NS" &&
    resource_absent mcpserver "$MCP_NAME" "$MCP_NS" &&
    resource_absent mcpserver "$SECOND_MCP_NAME" "$MCP_NS" &&
    resource_collection_absent deployment "$MCP_NS" "$WORKLOAD_SELECTOR" &&
    resource_collection_absent replicaset "$MCP_NS" "$WORKLOAD_SELECTOR" &&
    resource_collection_absent pod "$MCP_NS" "$WORKLOAD_SELECTOR" &&
    resource_collection_absent deployment "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR" &&
    resource_collection_absent replicaset "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR" &&
    resource_collection_absent pod "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR" &&
    resource_absent service "$MCP_NAME" "$MCP_NS" &&
    resource_absent service "$SECOND_MCP_NAME" "$MCP_NS" &&
    resource_absent deployment "$PROBE_NAME" "$HOST_NS" &&
    resource_collection_absent replicaset "$HOST_NS" "app=${PROBE_NAME}" &&
    resource_collection_absent pod "$HOST_NS" "app=${PROBE_NAME}" &&
    resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" &&
    resource_absent networkpolicy "$CONTEXT_EGRESS_POLICY" "$HOST_NS" &&
    resource_absent networkpolicy "$RPC_EGRESS_POLICY" "$RPC_PROXY_NS" &&
    resource_absent networkpolicy "$SECOND_CONTEXT_POLICY" "$MCP_NS" &&
    resource_absent networkpolicy "$SECOND_CONTEXT_EGRESS_POLICY" "$HOST_NS" &&
    resource_absent networkpolicy "$SECOND_RPC_EGRESS_POLICY" "$RPC_PROXY_NS" &&
    wrc_managed_resources_absent &&
    host_managed_resources_absent
}

wrc_managed_resources_absent() {
  local resources
  resources="$(kctl get "$WRC_CLEANUP_KINDS" -A \
    -l "clerum.io/recipe=${RECIPE_NAME}" -o name 2>/dev/null)" || return 1
  [ -z "$resources" ]
}

host_managed_resources_absent() {
  local resources
  resources="$(kctl get \
    deployment,replicaset,pod,service,serviceaccount,role,rolebinding,secret,persistentvolumeclaim,networkpolicy \
    -A -l "clerum.io/managed-by=host-context-controller,clerum.io/host=${HOST_NAME}" \
    -o name 2>/dev/null)" || return 1
  [ -z "$resources" ]
}

print_repair_instructions() {
  cat >&2 <<EOF
WRC/HCC Context no-op resync gate cleanup could not restore a verified clean state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
Fixture: ${WORKFLOW_NS}/${RECIPE_NAME}, ${MCP_NS}/${CONTEXT_NAME}, ${MCP_NS}/${MCP_NAME}, ${HOST_NS}/${HOST_NAME}

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
  if [ "$HOST_CREATED" = 1 ]; then
    kctl delete host "$HOST_NAME" -n "$HOST_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete \
      deployment,replicaset,pod,service,serviceaccount,role,rolebinding,secret,persistentvolumeclaim,networkpolicy \
      -A -l "clerum.io/managed-by=host-context-controller,clerum.io/host=${HOST_NAME}" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || cleanup_failed=1
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
    kctl delete mcpserver "$SECOND_MCP_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete deployment -n "$MCP_NS" -l "$WORKLOAD_SELECTOR" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete deployment -n "$MCP_NS" -l "$SECOND_WORKLOAD_SELECTOR" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete service "$MCP_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete service "$SECOND_MCP_NAME" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$CONTEXT_EGRESS_POLICY" -n "$HOST_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$RPC_EGRESS_POLICY" -n "$RPC_PROXY_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$SECOND_CONTEXT_POLICY" -n "$MCP_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$SECOND_CONTEXT_EGRESS_POLICY" -n "$HOST_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete networkpolicy "$SECOND_RPC_EGRESS_POLICY" -n "$RPC_PROXY_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    kctl delete "$WRC_CLEANUP_KINDS" -A -l "clerum.io/recipe=${RECIPE_NAME}" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || cleanup_failed=1
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
ok "WRC created the absent shared Context without a recipe label or cross-namespace ownerReference"

source_host="$(kctl get host "$SOURCE_HOST_NAME" -n "$HOST_NS" -o json 2>/dev/null)" ||
  die "source Host ${HOST_NS}/${SOURCE_HOST_NAME} is unavailable"
source_secret="$(jq -r '.spec.secretRef // ""' <<<"$source_host")"
source_provider="$(jq -r '.spec.model.provider // ""' <<<"$source_host")"
source_model="$(jq -r '.spec.model.name // ""' <<<"$source_host")"
[ -n "$source_secret" ] && [ -n "$source_provider" ] && [ -n "$source_model" ] ||
  die "source Host does not expose a reusable secretRef/provider/model contract"
kctl get secret "$source_secret" -n "$HOST_NS" >/dev/null 2>&1 ||
  die "source Host Secret ${HOST_NS}/${source_secret} is unavailable"
ok "source Host and its existing Secret/provider/model contract passed preflight without reading Secret data"

HOST_CREATED=1
jq -n --arg name "$HOST_NAME" --arg namespace "$HOST_NS" --arg context "$CONTEXT_NAME" \
  --arg secret "$source_secret" --arg provider "$source_provider" --arg model "$source_model" \
  --arg suite "$SUITE_NAME" --arg run "$RUN_LABEL" '
  {apiVersion:"clerum.io/v1alpha1",kind:"Host",
   metadata:{name:$name,namespace:$namespace,
     labels:{"e2e.clerum.io/suite":$suite,"e2e.clerum.io/run":$run}},
   spec:{host:$name,contextRef:$context,secretRef:$secret,
     lifecycle:{stateless:false},model:{provider:$provider,name:$model}}}
  ' | kctl apply -f - >/dev/null
wait_until 240 "gate-owned Host runtime to become Ready" host_runtime_ready ||
  die "gate-owned Host did not converge from the real Host CRD"
wait_until 60 "initial Host reconcile witness" host_reconcile_witness_exists ||
  die "gate-owned Host reached Ready without a host-specific reconcile witness"
wait_until 60 "gate-owned Host runtime health" probe_host_runtime_health ||
  die "gate-owned Host pod was Ready but its runtime health endpoint was not"
HOST_BASELINE_IDENTITY="$(host_deployment_identity)" ||
  die "could not capture the gate-owned Host deployment identity"
initial_host_reconciles="$(host_reconcile_witness_count)" ||
  die "could not capture the initial host-specific reconcile count"
initial_host_urgent="$(hcc_host_urgent_success_count)" ||
  die "could not capture the initial urgent Host reconcile metric"
host_activity_stays "$initial_host_reconciles" "$initial_host_urgent" 5 ||
  die "gate-owned Host did not reach a quiet baseline before the Context fan-out proof"
wait_until 60 "primary MCP signal from the real Host" probe_host_mcp_business_signal "$MCP_NAME" ||
  die "the correctly configured Host could not invoke the primary MCP tool"
ok "real gate-owned Host is Ready on the WRC-created shared Context"

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
          command: [sh, -c, "exec tail -f /dev/null"]
          resources:
            requests: {cpu: 5m, memory: 24Mi}
            limits: {cpu: 50m, memory: 128Mi}
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

read -r context_before_real_rv context_before_real_generation <<<"$(
  kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}'
)"
host_urgent_before="$(hcc_host_urgent_success_count)" ||
  die "could not establish the urgent Host reconcile metric baseline"
fanout_window_start="$(utc_now)" || die "could not timestamp the positive Host fan-out window"
reconciles_before="$(wrc_reconcile_count)" || die "could not establish WRC reconcile log baseline"
second_workload_patch="$(jq -cn '[{op:"add",path:"/spec/workloads/-",value:{
  id:"mock-tools-2",type:"deployment",image:"clerum/mock-mcp-server:test",
  imagePullPolicy:"IfNotPresent",port:3000,
  transport:{type:"streamableHttp",path:"/mcp"},
  healthCheck:{type:"tcp",port:3001},
  resources:{requests:{cpu:"20m",memory:"48Mi"},limits:{cpu:"150m",memory:"128Mi"}}
}}]')"
kctl patch workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_NS" --type=json \
  -p "$second_workload_patch" >/dev/null
wait_until 90 "WRC to process the real second-workload change" \
  wrc_reconciled_after "$reconciles_before" ||
  die "WRC did not visibly reconcile the real recipe change"
wait_until 300 "the two-server WRC/Context/HCC projection" expanded_context_projection_converged ||
  die "the real recipe change did not converge both MCP runtimes and six Context policies"
read -r context_after_real_rv context_after_real_generation <<<"$(
  kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}'
)"
[ "$context_after_real_rv" != "$context_before_real_rv" ] ||
  die "the real recipe change did not move Context resourceVersion"
if ! [[ "$context_before_real_generation" =~ ^[0-9]+$ ]] ||
  ! [[ "$context_after_real_generation" =~ ^[0-9]+$ ]] ||
  [ "$context_after_real_generation" -ne $((context_before_real_generation + 1)) ]; then
  die "the real recipe change did not produce exactly one Context spec transition"
fi
wait_for_positive_host_fanout 90 "$fanout_window_start" "$host_urgent_before" ||
  die "the Context change lacked one isolated, successful Host fan-out after NetworkPolicy convergence"
host_reconciles_after_real_change="$(
  host_reconcile_witness_count_since "$fanout_window_start" "$HOST_NAME"
)" ||
  die "could not capture the post-change Host reconcile witness"
host_urgent_after_real_change="$(hcc_host_urgent_success_count)" ||
  die "could not capture the post-change urgent Host reconcile metric"
host_runtime_ready || die "the bound Host degraded after a real Context change"
[ "$(host_deployment_identity)" = "$HOST_BASELINE_IDENTITY" ] ||
  die "a no-mount Context server change unnecessarily restarted or rewrote the bound Host"
probe_host_runtime_health || die "the Host runtime health signal failed after the real Context change"
wait_until 60 "primary MCP add(19,23) signal from the real Host after the change" \
  probe_host_mcp_business_signal "$MCP_NAME" ||
  die "the primary MCP signal from the real Host regressed after the Context change"
wait_until 60 "second MCP add(19,23) signal from the real Host after the change" \
  probe_host_mcp_business_signal "$SECOND_MCP_NAME" ||
  die "the real Host could not invoke the second WRC-projected MCP tool"
probe_hcc_ready || die "HCC lost readiness after the real Context change"
ok "real WRC Context change fanned out to a stable, Ready Host and both MCP tools returned 42"

ORIGINAL_CONTEXT_RV="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.resourceVersion}')"
ORIGINAL_CONTEXT_GENERATION="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.generation}')"
ORIGINAL_MCP_GENERATION="$(kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.generation}')"
ORIGINAL_SECOND_MCP_GENERATION="$(kctl get mcpserver "$SECOND_MCP_NAME" -n "$MCP_NS" \
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
host_runtime_ready || die "the bound Host degraded during the WRC no-op projection proof"
ok "WRC processed a recipe-only change without moving Context resourceVersion"

metadata_events_before="$(hcc_metadata_only_event_count)" ||
  die "could not establish the HCC metadata-only counter baseline"
host_identity_before_metadata="$(host_deployment_identity)" ||
  die "could not capture Host identity before metadata-only MODIFIED"
metadata_context_before_rv="$ORIGINAL_CONTEXT_RV"
metadata_context_before_generation="$ORIGINAL_CONTEXT_GENERATION"
metadata_policy_uid="$(kctl get networkpolicy "$SECOND_RPC_EGRESS_POLICY" -n "$RPC_PROXY_NS" \
  -o jsonpath='{.metadata.uid}')"
metadata_policy_snapshot="$(policy_snapshot "$RPC_PROXY_NS" "$SECOND_RPC_EGRESS_POLICY")" ||
  die "could not capture the metadata-only scoped NetworkPolicy fixture"
[ -n "$metadata_policy_uid" ] && [ -n "$metadata_policy_snapshot" ] ||
  die "metadata-only scoped NetworkPolicy fixture was empty"
kctl delete networkpolicy "$SECOND_RPC_EGRESS_POLICY" -n "$RPC_PROXY_NS" \
  --wait=true --timeout=60s >/dev/null
resource_absent networkpolicy "$SECOND_RPC_EGRESS_POLICY" "$RPC_PROXY_NS" ||
  die "metadata-only scoped NetworkPolicy fault was not observable"
metadata_window_start="$(utc_now)" || die "could not timestamp the metadata-only event window"
kctl annotate context "$CONTEXT_NAME" -n "$MCP_NS" \
  "e2e.clerum.io/metadata-touch=${RUN_LABEL}" --overwrite >/dev/null
wait_until 60 "HCC metadata-only Context counter to advance" \
  hcc_metadata_only_event_after "$metadata_events_before" ||
  die "HCC did not classify the annotation-only Context MODIFIED as metadata-only"
metadata_events_after="$(hcc_metadata_only_event_count)" ||
  die "could not capture the post-event HCC metadata-only counter"
wait_until 90 "metadata-only scoped NetworkPolicy repair" \
  policy_recreated_from_snapshot "$RPC_PROXY_NS" "$SECOND_RPC_EGRESS_POLICY" \
    "$metadata_policy_uid" "$metadata_policy_snapshot" ||
  die "metadata-only Context MODIFIED did not complete its scoped NetworkPolicy repair"
read -r metadata_context_after_rv metadata_context_after_generation <<<"$(
  kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
    -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}'
)"
[ "$metadata_context_after_rv" != "$metadata_context_before_rv" ] ||
  die "the annotation fault did not emit a real Context MODIFIED resourceVersion"
[ "$metadata_context_after_generation" = "$metadata_context_before_generation" ] ||
  die "the metadata-only Context event unexpectedly changed desired generation"
target_host_activity_stays_absent "$metadata_window_start" 30 ||
  die "metadata-only Context MODIFIED incorrectly fanned out to the bound Host"
[ "$(context_netpol_failure_count_since "$metadata_window_start")" = 0 ] ||
  die "metadata-only NetworkPolicy convergence failed and made the Host skip inconclusive"
[ "$(host_deployment_identity)" = "$host_identity_before_metadata" ] ||
  die "metadata-only Context MODIFIED rewrote or restarted the bound Host"
host_runtime_ready || die "the bound Host degraded after metadata-only Context MODIFIED"
probe_host_runtime_health || die "the Host runtime health signal failed after metadata-only MODIFIED"
expanded_context_projection_converged ||
  die "metadata-only Context MODIFIED disturbed MCP or NetworkPolicy desired state"
if ! probe_mcp_business_signal "$MCP_NAME" || ! probe_mcp_business_signal "$SECOND_MCP_NAME"; then
  die "metadata-only Context MODIFIED interrupted an MCP business signal"
fi
if ! probe_host_mcp_business_signal "$MCP_NAME" ||
  ! probe_host_mcp_business_signal "$SECOND_MCP_NAME"; then
  die "metadata-only Context MODIFIED interrupted the real Host-to-MCP path"
fi
hcc_identity_is_stable || die "HCC restarted during metadata-only Context handling"
probe_hcc_ready || die "HCC lost readiness during metadata-only Context handling"
[ "$(host_reconcile_witness_count_since "$metadata_window_start" "$HOST_NAME")" = 0 ] ||
  die "the bound Host reconciled after the metadata-only stability window"
ok "metadata-only Context MODIFIED kept the real Host stable while scoped NetworkPolicy and both MCP tools stayed live"

# The annotation-only event legitimately moves resourceVersion. Freeze the new
# identity for the periodic-policy recovery phase that follows.
ORIGINAL_CONTEXT_RV="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.resourceVersion}')"
ORIGINAL_CONTEXT_GENERATION="$(kctl get context "$CONTEXT_NAME" -n "$MCP_NS" \
  -o jsonpath='{.metadata.generation}')"

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
timer_arm_epoch="$(hcc_netpol_timer_arm_epoch)" ||
  die "could not timestamp the freshly armed NetworkPolicy periodic timer"
read -r HCC_UID HCC_RESTARTS <<<"$(
  kctl get pod "$(running_hcc_pod)" -n "$HCC_NS" \
    -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}'
)"
[ -n "$HCC_UID" ] && [ -n "$HCC_RESTARTS" ] || die "could not capture armed HCC pod identity"
context_identity_is_original || die "arming HCC changed Context desired identity"
mcp_generation_is_original || die "arming HCC changed McpServer desired generation"
wait_until 120 "Context policies after the HCC timer rollout" \
  expanded_context_projection_converged ||
  die "two-server Context policies did not remain converged after the HCC timer rollout"
wait_until 60 "primary MCP business signal after the HCC timer rollout" \
  probe_mcp_business_signal "$MCP_NAME" ||
  die "primary MCP business signal failed before policy fault injection"
wait_until 60 "second MCP business signal after the HCC timer rollout" \
  probe_mcp_business_signal "$SECOND_MCP_NAME" ||
  die "second MCP business signal failed before policy fault injection"
host_runtime_ready || die "the real Host degraded during the HCC timer rollout"
wait_until 180 "the armed HCC startup NetworkPolicy pass to complete" \
  hcc_log_contains "[NetPol] Full reconciliation complete" ||
  die "HCC startup NetworkPolicy pass did not complete before policy fault injection"

ORIGINAL_POLICY_UID="$(kctl get networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" \
  -o jsonpath='{.metadata.uid}')"
ORIGINAL_POLICY_SNAPSHOT="$(context_policy_snapshot)" ||
  die "could not capture the canonical Context ingress policy"
[ -n "$ORIGINAL_POLICY_UID" ] && [ -n "$ORIGINAL_POLICY_SNAPSHOT" ] ||
  die "Context ingress policy baseline was empty"
PROBE_BASELINE_IDENTITY="$(
  selector_runtime_identity "$HOST_NS" "app=${PROBE_NAME}" "$PROBE_NAME"
)" ||
  die "could not freeze the probe runtime identity before policy fault injection"
PRIMARY_MCP_BASELINE_IDENTITY="$(selector_runtime_identity "$MCP_NS" "$WORKLOAD_SELECTOR")" ||
  die "could not freeze the primary MCP runtime identity before policy fault injection"
SECOND_MCP_BASELINE_IDENTITY="$(selector_runtime_identity "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR")" ||
  die "could not freeze the second MCP runtime identity before policy fault injection"
probe_host_mcp_business_signal "$MCP_NAME" ||
  die "the real Host-to-MCP path was unavailable immediately before fault injection"

timer_now_epoch="$(date +%s)"
[ "$timer_arm_epoch" -le "$timer_now_epoch" ] || die "NetworkPolicy timer timestamp is in the future"
timer_tick_due_epoch=$((
  timer_arm_epoch + (((timer_now_epoch - timer_arm_epoch) / RESYNC_SECONDS) + 1) * RESYNC_SECONDS
))
if [ $((timer_tick_due_epoch - timer_now_epoch)) -lt 30 ]; then
  timer_window_passes="$(hcc_netpol_certified_count)" ||
    die "could not capture a NetworkPolicy pass before opening a fresh timer window"
  wait_until "$RESYNC_TIMEOUT_SECONDS" "the imminent timer pass to finish before fault injection" \
    hcc_netpol_certified_after "$timer_window_passes" ||
    die "could not establish a fresh post-pass timer window"
  timer_now_epoch="$(date +%s)"
  timer_tick_due_epoch=$((
    timer_arm_epoch + (((timer_now_epoch - timer_arm_epoch) / RESYNC_SECONDS) + 1) * RESYNC_SECONDS
  ))
fi
[ $((timer_tick_due_epoch - timer_now_epoch)) -ge 30 ] ||
  die "NetworkPolicy timer did not leave a 30-second fault-injection window"
netpol_certified_before_fault="$(hcc_netpol_certified_count)" ||
  die "could not capture the certified NetworkPolicy pass baseline"
netpol_last_success_before_fault="$(hcc_netpol_last_success_epoch)" ||
  die "could not capture the last NetworkPolicy success timestamp"
netpol_desired_before_fault="$(netpol_desired_inventory_snapshot)" ||
  die "could not freeze the NetworkPolicy desired inventory"
metadata_events_before_fault="$(hcc_metadata_only_event_count)" ||
  die "could not freeze the metadata-only event counter before the timer fault"
fault_window_start="$(utc_now)" || die "could not timestamp the timer fault window"
ok "HCC periodic NetworkPolicy resync is freshly armed at ${RESYNC_SECONDS}s on a stable pod"

kctl delete networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" --wait=true --timeout=60s >/dev/null
resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" ||
  die "fault injection did not remove the Context ingress policy"
fault_confirmed_epoch="$(date +%s)"
[ "$timer_tick_due_epoch" -gt "$fault_confirmed_epoch" ] ||
  die "the policy fault was not confirmed before the next periodic timer deadline"
wait_until 30 "Calico to enforce the missing Context ingress policy while MCP stays Ready" \
  mcp_data_plane_is_policy_blocked ||
  die "MCP did not become policy-isolated while its workload and Service endpoints stayed Ready"
ok "policy deletion produced a real fail-closed MCP data-plane interruption"

wait_until "$RESYNC_TIMEOUT_SECONDS" \
  "HCC periodic convergence to recreate the canonical Context policy" \
  context_policy_recreated_from_snapshot ||
  die "HCC periodic convergence did not recreate the deleted Context policy"
policy_recovery_epoch="$(date +%s)"
[ "$policy_recovery_epoch" -ge $((timer_tick_due_epoch - 2)) ] ||
  die "the policy recovered before the armed periodic tick and cannot be attributed to the timer"
wait_until "$RESYNC_TIMEOUT_SECONDS" "a post-fault certified NetworkPolicy pass" \
  hcc_netpol_certified_after "$netpol_certified_before_fault" ||
  die "policy recreation was not backed by a certified post-fault NetworkPolicy pass"
netpol_certified_after_fault="$(hcc_netpol_certified_count)" ||
  die "could not read the post-fault certified NetworkPolicy pass count"
awk -v after="$netpol_certified_after_fault" -v before="$netpol_certified_before_fault" \
  'BEGIN { exit(after == before + 1 ? 0 : 1) }' ||
  die "more than one NetworkPolicy pass ran in the timer attribution window"
netpol_last_success_after_fault="$(hcc_netpol_last_success_epoch)" ||
  die "could not read the post-fault NetworkPolicy success timestamp"
awk -v after="$netpol_last_success_after_fault" -v before="$netpol_last_success_before_fault" \
  -v fault="$fault_confirmed_epoch" -v due="$timer_tick_due_epoch" \
  'BEGIN { exit(after > before && after >= fault && after >= due - 2 ? 0 : 1) }' ||
  die "the certified NetworkPolicy pass timestamp does not belong to the post-fault timer window"
[ "$(netpol_desired_inventory_snapshot)" = "$netpol_desired_before_fault" ] ||
  die "Context/McpServer desired inventory changed during timer attribution"
[ "$(hcc_metadata_only_event_count)" = "$metadata_events_before_fault" ] ||
  die "a metadata-only Context event made timer attribution inconclusive"
[ "$(netpol_watch_recovery_count_since "$fault_window_start")" = 0 ] ||
  die "Context/McpServer watch recovery made timer attribution inconclusive"
policy_recovery_elapsed=$((policy_recovery_epoch - fault_confirmed_epoch))
[ "$policy_recovery_elapsed" -le "$RESYNC_TIMEOUT_SECONDS" ] ||
  die "periodic policy recovery exceeded the configured test timeout"
context_identity_is_original ||
  die "Context desired state changed while waiting for periodic policy recovery"
mcp_generation_is_original ||
  die "McpServer desired state changed while waiting for periodic policy recovery"
hcc_identity_is_stable ||
  die "HCC restarted instead of healing the deleted policy in process"
[ "$(selector_runtime_identity "$HOST_NS" "app=${PROBE_NAME}" "$PROBE_NAME")" = \
  "$PROBE_BASELINE_IDENTITY" ] || die "the probe changed identity during policy recovery"
[ "$(selector_runtime_identity "$MCP_NS" "$WORKLOAD_SELECTOR")" = \
  "$PRIMARY_MCP_BASELINE_IDENTITY" ] || die "the MCP runtime changed during policy recovery"
[ "$(selector_runtime_identity "$MCP_NS" "$SECOND_WORKLOAD_SELECTOR")" = \
  "$SECOND_MCP_BASELINE_IDENTITY" ] || die "the unaffected MCP runtime changed during recovery"
wait_until 60 "MCP business signal after periodic policy recovery" \
  probe_mcp_business_signal "$MCP_NAME" ||
  die "recreated policy did not restore the MCP add(19,23) business signal"
probe_mcp_business_signal "$SECOND_MCP_NAME" ||
  die "periodic recovery disturbed the unaffected second MCP business signal"
host_runtime_ready || die "the real Host degraded after periodic policy recovery"
probe_host_mcp_business_signal "$MCP_NAME" ||
  die "periodic recovery did not restore the real Host-to-primary-MCP business path"
probe_host_mcp_business_signal "$SECOND_MCP_NAME" ||
  die "periodic recovery disturbed the real Host-to-second-MCP business path"
probe_hcc_ready || die "HCC lost readiness after periodic policy recovery"
ok "HCC recreated the policy without a Context/McpServer change or process restart"
ok "the restored data plane again returned 42 from the MCP add tool"

FINAL_SUMMARY="$(jq -cn \
  --arg recipe "$RECIPE_NAME" --arg context "$CONTEXT_NAME" --arg server "$MCP_NAME" \
  --arg secondServer "$SECOND_MCP_NAME" --arg host "$HOST_NAME" \
  --arg oldPolicyUid "$ORIGINAL_POLICY_UID" \
  --arg newPolicyUid "$(kctl get networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" -o jsonpath='{.metadata.uid}')" \
  --arg contextResourceVersion "$ORIGINAL_CONTEXT_RV" \
  --arg hccPodUid "$HCC_UID" --argjson resyncSeconds "$RESYNC_SECONDS" \
  --argjson metadataOnlyBefore "$metadata_events_before" \
  --argjson metadataOnlyAfter "$metadata_events_after" \
  --argjson hostReconcilesAfterRealChange "$host_reconciles_after_real_change" \
  --argjson hostUrgentBeforeRealChange "$host_urgent_before" \
  --argjson hostUrgentAfterRealChange "$host_urgent_after_real_change" \
  --argjson timerTickDueEpoch "$timer_tick_due_epoch" \
  --argjson policyRecoveryElapsedSeconds "$policy_recovery_elapsed" \
  --argjson netpolCertifiedBeforeFault "$netpol_certified_before_fault" \
  --argjson netpolCertifiedAfterFault "$netpol_certified_after_fault" \
  '{recipe:$recipe,context:$context,servers:[$server,$secondServer],host:$host,
    resyncSeconds:$resyncSeconds,metadataOnlyBefore:$metadataOnlyBefore,
    metadataOnlyAfter:$metadataOnlyAfter,hostReconcilesAfterRealChange:$hostReconcilesAfterRealChange,
    hostUrgentBeforeRealChange:$hostUrgentBeforeRealChange,
    hostUrgentAfterRealChange:$hostUrgentAfterRealChange,timerTickDueEpoch:$timerTickDueEpoch,
    policyRecoveryElapsedSeconds:$policyRecoveryElapsedSeconds,
    netpolCertifiedBeforeFault:$netpolCertifiedBeforeFault,
    netpolCertifiedAfterFault:$netpolCertifiedAfterFault,
    contextResourceVersion:$contextResourceVersion,hccPodUid:$hccPodUid,
    oldPolicyUid:$oldPolicyUid,newPolicyUid:$newPolicyUid,
    businessSignal:"real-host-and-probe:add(19,23)=42"}')"

header "WRC/HCC Context assertions complete; restoring branch-owned runtime"
