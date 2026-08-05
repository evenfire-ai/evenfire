#!/usr/bin/env bash
# Proves that HCC readiness is independent from the exact McpServer ->
# external-egress -> runtime -> Context NetworkPolicy initial convergence path.
#
# The gate runs only on an exact-HEAD, branch-owned Minikube profile. It routes
# HCC DNS through an isolated in-cluster proxy that forwards every query except
# one fixture hostname. The gate first lets HCC create a real external-egress
# policy. A same-intent restart then proves the safety pass revokes that
# DNS-derived allow without attempting DNS and certifies global readiness while
# the affected runtime stays blocked. DNS release lets the additive lane create
# the current TCP policy and runtime. A second phase changes that binding's
# protocol while HCC is stopped and proves the same contract for TCP-to-UDP
# replacement. A real Context watch update still converges its three
# NetworkPolicies. The fleet is wider than the bounded worker width, covering
# the original large-fleet symptom.
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
  echo "Refusing HCC MCP readiness fault injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
[ "${E2E_HCC_MCP_READINESS_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_HCC_MCP_READINESS_FAULT_INJECTION=1 to acknowledge temporary HCC DNS fault injection." >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}

HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
MCP_NS="${MCP_SERVER_NS:-mcp-server}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
RPC_PROXY_NS="${RPC_PROXY_NS:-rpc-proxy}"
RUN_ID="$(date +%s)-$$"
SUITE_NAME="hcc-mcp-readiness"
RUN_LABEL="$(truncate_rfc1123 "$RUN_ID")"
MCP_NAME="$(truncate_rfc1123 "e2e-hcc-mcp-${RUN_ID}")"
CONTEXT_NAME="$(truncate_rfc1123 "e2e-hcc-context-${RUN_ID}")"
CONTEXT_ID="$CONTEXT_NAME"
MCP_FLEET_SIZE="${E2E_HCC_MCP_FLEET_SIZE:-11}"
TARGET_DNS="$(truncate_rfc1123 "hcc-readiness-${RUN_ID}").example.com"
DNS_BLOCKER_NAME="$(truncate_rfc1123 "e2e-hcc-dns-${RUN_ID}")"
DNS_BLOCKER_POLICY="$(truncate_rfc1123 "${DNS_BLOCKER_NAME}-policy")"
HCC_DNS_POLICY="$(truncate_rfc1123 "${DNS_BLOCKER_NAME}-from-hcc")"
CONTEXT_POLICY="ctx-${CONTEXT_ID}-${MCP_NAME}"
CONTEXT_EGRESS_POLICY="${CONTEXT_POLICY}-egress"
RPC_EGRESS_POLICY="rpc-egress-${CONTEXT_ID}-${MCP_NAME}"
MANAGED_BY_LABEL="clerum.io/managed-by"
MANAGED_BY_VALUE="host-context-controller"
MCP_SERVER_LABEL="clerum.io/mcpserver"
POLICY_TYPE_LABEL="clerum.io/policy-type"
CONTEXT_LABEL="clerum.io/context"
EXTERNAL_EGRESS_CIDR="93.184.216.34/32"
EXTERNAL_EGRESS_PORT=443
INITIAL_EXTERNAL_EGRESS_PROTOCOL=TCP
EXTERNAL_EGRESS_PROTOCOL=UDP
ORIGINAL_REPLICAS=""
ORIGINAL_DNS_POLICY=""
ORIGINAL_DNS_CONFIG=""
DNS_BLOCKER_IP=""
DNS_RELEASE_COUNT_AT_HOLD=0
DNS_HOLD_COUNT_AT_ARM=0
DNS_HOLD_COUNT_AT_RETRY_SCHEDULE=0
UPSTREAM_DNS_IP=""
NEW_HCC_POD=""
HCC_UID=""
HCC_RESTARTS=""
HCC_PORT=""
HCC_MUTATED=0
DNS_BLOCKER_CREATED=0
MCP_CREATED=0
CONTEXT_CREATED=0
PEER_FLEET_CREATED=0
MCP_FLEET_NAMES=("$MCP_NAME")
CONTEXT_FLEET_NAMES=("$CONTEXT_NAME")
# Read and mutated by the sourced compare-and-swap lock helper.
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0
# shellcheck disable=SC2034
HCC_GATE_LOCK_NAME=""
# shellcheck disable=SC2034
HCC_GATE_LOCK_UID=""
# shellcheck disable=SC2034
HCC_GATE_FINALIZATION_FAILURE=""
HCC_READY_PROBE_DIAGNOSTIC=""
BASELINE_POLICY_SNAPSHOT=""

# Clean-window negative markers. Consumed ONLY while the DNS fault injection is
# NOT applied (pre-injection pre-checks, post-restore cleanup): under the
# injection the additive NetworkPolicy lane legitimately fails and schedules
# retries, so these negatives false-fail inside the injected window (removed
# there by 1abcfb1/15997353/e7064a7f). Inventoried in
# scripts/tests/test-hcc-watch-recovery-gate.sh marker_bindings.
NETPOL_INITIAL_FAILED_MARKER='Initial NetworkPolicy background reconciliation failed:'
NETPOL_ADDITIVE_FAILED_MARKER='Initial NetworkPolicy post-certification additive reconciliation failed:'
NETPOL_RETRY_SCHEDULED_MARKER='Scheduling initial NetworkPolicy background convergence retry'
NETPOL_CONTEXT_FAILED_MARKER='NetworkPolicy reconciliation failed for context '
clean_window_checks_run=0

[[ "$MCP_FLEET_SIZE" =~ ^[0-9]+$ ]] && [ "$MCP_FLEET_SIZE" -gt 10 ] &&
  [ "$MCP_FLEET_SIZE" -le 24 ] || {
  echo "E2E_HCC_MCP_FLEET_SIZE must be an integer from 11 through 24; got ${MCP_FLEET_SIZE}." >&2
  exit 1
}
for ((index = 2; index <= MCP_FLEET_SIZE; index++)); do
  MCP_FLEET_NAMES+=("$(truncate_rfc1123 "e2e-hcc-mcp-${RUN_ID}-${index}")")
  CONTEXT_FLEET_NAMES+=("$(truncate_rfc1123 "e2e-hcc-context-${RUN_ID}-${index}")")
done

die() {
  if [ -n "$NEW_HCC_POD" ]; then
    echo "Recent HCC logs from ${NEW_HCC_POD}:" >&2
    kctl logs "pod/${NEW_HCC_POD}" -n "$HCC_NS" -c host-context-controller \
      --tail=300 >&2 || true
  fi
  if [ "$DNS_BLOCKER_CREATED" = 1 ]; then
    echo "Recent DNS blocker logs:" >&2
    kctl logs "deployment/${DNS_BLOCKER_NAME}" -n "$HCC_NS" --tail=120 >&2 || true
  fi
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

wait_until_fast() {
  local timeout=$1 description=$2
  shift 2
  local deadline now rc
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    "$@" && return 0
    rc=$?
    # rc=2 is a fatal, non-retryable ordering violation (e.g. 200 observed with
    # a stale policy still present): stop polling immediately so a later clean
    # poll cannot mask it. rc=1 is benign "not ready yet".
    if [ "$rc" -eq 2 ]; then
      echo "FATAL ordering violation while waiting for ${description}: ${HCC_READY_PROBE_DIAGNOSTIC:-unset}" >&2
      return 2
    fi
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    sleep 0.5
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

running_hcc_pod() {
  local rows
  rows="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null)" || return 1
  awk -F '\t' '$1 != "" && $4 == "" { print $1; exit }' <<<"$rows"
}

capture_hcc() {
  NEW_HCC_POD="$(running_hcc_pod)"
  [ -n "$NEW_HCC_POD" ]
}

hcc_pods_absent() {
  local pods
  pods="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o name 2>/dev/null)" ||
    return 1
  [ -z "$pods" ]
}

hcc_log_contains() {
  local marker=$1 logs
  [ -n "$NEW_HCC_POD" ] || return 1
  logs="$(kctl logs "pod/${NEW_HCC_POD}" -n "$HCC_NS" \
    -c host-context-controller 2>/dev/null)" || return 1
  grep -Fq "$marker" <<<"$logs"
}

dns_log_contains() {
  local marker=$1 logs
  logs="$(kctl logs "deployment/${DNS_BLOCKER_NAME}" -n "$HCC_NS" 2>/dev/null)" ||
    return 1
  grep -Fq "$marker" <<<"$logs"
}

dns_release_count() {
  local marker="released DNS A ${TARGET_DNS}" logs
  logs="$(kctl logs "deployment/${DNS_BLOCKER_NAME}" -n "$HCC_NS" 2>/dev/null)" ||
    return 1
  grep -Fc "$marker" <<<"$logs" || true
}

dns_hold_count() {
  local marker="holding DNS A ${TARGET_DNS}" logs
  logs="$(kctl logs "deployment/${DNS_BLOCKER_NAME}" -n "$HCC_NS" 2>/dev/null)" ||
    return 1
  grep -Fc "$marker" <<<"$logs" || true
}

dns_hold_observed_since_arm() {
  [ "$(dns_hold_count)" -gt "$DNS_HOLD_COUNT_AT_ARM" ]
}

dns_has_not_released_since_hold() {
  [ "$(dns_release_count)" = "$DNS_RELEASE_COUNT_AT_HOLD" ]
}

dns_released_since_hold() {
  [ "$(dns_release_count)" -gt "$DNS_RELEASE_COUNT_AT_HOLD" ]
}

external_egress_retry_progress_is_observed() {
  local logs marker
  [ -n "$NEW_HCC_POD" ] || return 1
  logs="$(kctl logs "pod/${NEW_HCC_POD}" -n "$HCC_NS" \
    -c host-context-controller 2>/dev/null)" || return 1
  marker="Scheduling external egress retry "
  grep -Fq \
    "Initial external egress reconciliation failed for ${MCP_NS}/${MCP_NAME};" <<<"$logs" &&
    awk \
      -v marker="$marker" \
      -v server="for McpServer \"${MCP_NAME}\"" '
        index($0, marker) && index($0, server) { found = 1 }
        END { exit found ? 0 : 1 }
      ' <<<"$logs"
}

dns_retry_query_observed_since_schedule() {
  [ "$(dns_hold_count)" -gt "$DNS_HOLD_COUNT_AT_RETRY_SCHEDULE" ]
}

hcc_identity_is_stable() {
  local row uid restarts
  row="$(kctl get pod "$NEW_HCC_POD" -n "$HCC_NS" \
    -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}' \
    2>/dev/null)" || return 1
  read -r uid restarts <<<"$row"
  [ "$uid" = "$HCC_UID" ] && [ "$restarts" = "$HCC_RESTARTS" ]
}

hcc_kubernetes_readiness_is_exact() {
  [ -n "$NEW_HCC_POD" ] && [ -n "$HCC_UID" ] || return 1
  kctl get pod "$NEW_HCC_POD" -n "$HCC_NS" -o json 2>/dev/null |
    jq -e --arg uid "$HCC_UID" '
      .metadata.uid == $uid and
      any(.status.conditions[]?; .type == "Ready" and .status == "True") and
      any(.status.containerStatuses[]?;
        .name == "host-context-controller" and .ready == true
      )
    ' >/dev/null || return 1
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json 2>/dev/null |
    jq -e '
      .status.observedGeneration == .metadata.generation and
      (.spec.replicas // 0) == 1 and
      (.status.updatedReplicas // 0) == 1 and
      (.status.readyReplicas // 0) == 1 and
      (.status.availableReplicas // 0) == 1 and
      (.status.unavailableReplicas // 0) == 0
    ' >/dev/null
}

resource_absent() {
  local kind=$1 name=$2 namespace=$3 found
  found="$(
    kctl get "$kind" "$name" -n "$namespace" --ignore-not-found -o name 2>/dev/null
  )" || return 1
  [ -z "$found" ]
}

fixture_mcp_runtime_absent() {
  local external_egress_policies
  fixture_runtime_absent || return 1
  external_egress_policies="$(
    kctl get networkpolicy -n "$MCP_NS" \
      -l "${MCP_SERVER_LABEL}=${MCP_NAME},${POLICY_TYPE_LABEL}=external-egress" \
      -o name 2>/dev/null
  )" || return 1
  [ -z "$external_egress_policies" ]
}

fixture_runtime_absent() {
  resource_absent deployment "$MCP_NAME" "$MCP_NS" &&
    resource_absent service "$MCP_NAME" "$MCP_NS"
}

mcpserver_current_ready() {
  local name=$1
  kctl get mcpserver "$name" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e '
      .metadata.generation as $generation |
      any(
        .status.conditions[]?;
        .type == "Ready" and .status == "True" and
        (.observedGeneration // -1) == $generation
      )
    ' >/dev/null
}

mcpserver_current_ready_absent() {
  local name=$1 resource
  resource="$(kctl get mcpserver "$name" -n "$MCP_NS" -o json 2>/dev/null)" ||
    return 1
  jq -e '
    .metadata.generation as $generation |
    any(
      .status.conditions[]?;
      .type == "Ready" and .status == "True" and
      (.observedGeneration // -1) == $generation
    ) | not
  ' <<<"$resource" >/dev/null
}

fixture_runtime_and_ready_absent() {
  fixture_runtime_absent && mcpserver_current_ready_absent "$MCP_NAME"
}

context_policies_absent() {
  resource_absent networkpolicy "$CONTEXT_POLICY" "$MCP_NS" &&
    resource_absent networkpolicy "$CONTEXT_EGRESS_POLICY" "$HOST_NS" &&
    resource_absent networkpolicy "$RPC_EGRESS_POLICY" "$RPC_PROXY_NS"
}

context_policies_converged() {
  local context_id=${1:-$CONTEXT_ID}
  local context_name=${2:-$CONTEXT_NAME}
  local server=${3:-$MCP_NAME}
  local ingress_policy="ctx-${context_id}-${server}"
  local host_egress_policy="${ingress_policy}-egress"
  local rpc_egress_policy="rpc-egress-${context_id}-${server}"
  kctl get networkpolicy "$ingress_policy" -n "$MCP_NS" -o json |
    jq -e \
      --arg contextId "$context_id" \
      --arg contextName "$context_name" \
      --arg server "$server" \
      --arg hostNs "$HOST_NS" \
      --arg rpcNs "$RPC_PROXY_NS" \
      --arg mcpNs "$MCP_NS" \
      --arg managedByLabel "$MANAGED_BY_LABEL" \
      --arg managedByValue "$MANAGED_BY_VALUE" \
      --arg contextLabel "$CONTEXT_LABEL" \
      --arg serverLabel "$MCP_SERVER_LABEL" \
      --arg policyTypeLabel "$POLICY_TYPE_LABEL" '
      .metadata.labels[$managedByLabel] == $managedByValue and
      .metadata.labels[$policyTypeLabel] == "context-allow" and
      .metadata.labels[$contextLabel] == $contextId and
      .metadata.labels[$serverLabel] == $server and
      .spec.podSelector.matchLabels[$serverLabel] == $server and
      .spec.policyTypes == ["Ingress"] and
      (.spec.ingress | length) == 1 and
      .spec.ingress[0].ports == [{port: 3000, protocol: "TCP"}] and
      (.spec.ingress[0].from | length) == 3 and
      any(.spec.ingress[0].from[];
        .namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == $hostNs and
        .podSelector.matchLabels[$managedByLabel] == $managedByValue and
        .podSelector.matchLabels[$contextLabel] == $contextName
      ) and
      any(.spec.ingress[0].from[];
        .namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == $rpcNs and
        .podSelector.matchLabels.app == "rpc-proxy"
      ) and
      any(.spec.ingress[0].from[];
        .namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == $mcpNs and
        .podSelector.matchLabels.app == "mcp-proxy"
      )
    ' >/dev/null || return 1
  kctl get networkpolicy "$host_egress_policy" -n "$HOST_NS" -o json |
    jq -e \
      --arg contextId "$context_id" \
      --arg contextName "$context_name" \
      --arg server "$server" \
      --arg mcpNs "$MCP_NS" \
      --arg managedByLabel "$MANAGED_BY_LABEL" \
      --arg managedByValue "$MANAGED_BY_VALUE" \
      --arg contextLabel "$CONTEXT_LABEL" \
      --arg serverLabel "$MCP_SERVER_LABEL" \
      --arg policyTypeLabel "$POLICY_TYPE_LABEL" '
      .metadata.labels[$managedByLabel] == $managedByValue and
      .metadata.labels[$policyTypeLabel] == "context-allow" and
      .metadata.labels[$contextLabel] == $contextId and
      .metadata.labels[$serverLabel] == $server and
      .spec.podSelector.matchLabels[$managedByLabel] == $managedByValue and
      .spec.podSelector.matchLabels[$contextLabel] == $contextName and
      .spec.policyTypes == ["Egress"] and
      (.spec.egress | length) == 1 and
      .spec.egress[0].ports == [{port: 3000, protocol: "TCP"}] and
      (.spec.egress[0].to | length) == 1 and
      .spec.egress[0].to[0].namespaceSelector.matchLabels[
        "kubernetes.io/metadata.name"
      ] == $mcpNs and
      .spec.egress[0].to[0].podSelector.matchLabels[$serverLabel] == $server
    ' >/dev/null || return 1
  kctl get networkpolicy "$rpc_egress_policy" -n "$RPC_PROXY_NS" -o json |
    jq -e \
      --arg contextId "$context_id" \
      --arg server "$server" \
      --arg mcpNs "$MCP_NS" \
      --arg managedByLabel "$MANAGED_BY_LABEL" \
      --arg managedByValue "$MANAGED_BY_VALUE" \
      --arg contextLabel "$CONTEXT_LABEL" \
      --arg serverLabel "$MCP_SERVER_LABEL" \
      --arg policyTypeLabel "$POLICY_TYPE_LABEL" '
      .metadata.labels[$managedByLabel] == $managedByValue and
      .metadata.labels[$policyTypeLabel] == "rpc-proxy-egress" and
      .metadata.labels[$contextLabel] == $contextId and
      .metadata.labels[$serverLabel] == $server and
      .spec.podSelector.matchLabels.app == "rpc-proxy" and
      .spec.policyTypes == ["Egress"] and
      (.spec.egress | length) == 1 and
      .spec.egress[0].ports == [{port: 3000, protocol: "TCP"}] and
      (.spec.egress[0].to | length) == 1 and
      .spec.egress[0].to[0].namespaceSelector.matchLabels[
        "kubernetes.io/metadata.name"
      ] == $mcpNs and
      .spec.egress[0].to[0].podSelector.matchLabels[$serverLabel] == $server
    ' >/dev/null
}

external_egress_policy_converged_with_protocol() {
  local protocol=$1
  kctl get networkpolicy -n "$MCP_NS" \
    -l "${MCP_SERVER_LABEL}=${MCP_NAME},${POLICY_TYPE_LABEL}=external-egress" \
    -o json |
    jq -e \
      --arg server "$MCP_NAME" \
      --arg cidr "$EXTERNAL_EGRESS_CIDR" \
      --arg managedByLabel "$MANAGED_BY_LABEL" \
      --arg managedByValue "$MANAGED_BY_VALUE" \
      --arg serverLabel "$MCP_SERVER_LABEL" \
      --arg policyTypeLabel "$POLICY_TYPE_LABEL" \
      --arg protocol "$protocol" \
      --argjson port "$EXTERNAL_EGRESS_PORT" '
      (.items | length) == 1 and
      .items[0].metadata.labels[$managedByLabel] == $managedByValue and
      .items[0].metadata.labels[$policyTypeLabel] == "external-egress" and
      .items[0].metadata.labels[$serverLabel] == $server and
      .items[0].spec.podSelector.matchLabels[$serverLabel] == $server and
      .items[0].spec.policyTypes == ["Egress"] and
      (.items[0].spec.egress | length) == 1 and
      .items[0].spec.egress[0].ports == [{port: $port, protocol: $protocol}] and
      (.items[0].spec.egress[0].to | length) == 1 and
      .items[0].spec.egress[0].to[0].ipBlock == {cidr: $cidr}
    ' >/dev/null
}

external_egress_policy_converged() {
  external_egress_policy_converged_with_protocol "$EXTERNAL_EGRESS_PROTOCOL"
}

external_egress_policy_absent() {
  local policies
  policies="$(
    kctl get networkpolicy -n "$MCP_NS" \
      -l "${MCP_SERVER_LABEL}=${MCP_NAME},${POLICY_TYPE_LABEL}=external-egress" \
      -o name 2>/dev/null
  )" || return 1
  [ -z "$policies" ]
}

clean_window_netpol_log_negatives_hold() {
  # Family 1, fail-closed snapshot: read ONE authoritative log snapshot so a
  # kubectl logs failure cannot make the negative assertions pass vacuously.
  local pod=$1 logs
  [ -n "$pod" ] || return 1
  logs="$(kctl logs "pod/${pod}" -n "$HCC_NS" \
    -c host-context-controller 2>/dev/null)" || return 1
  ! grep -Fq "$NETPOL_INITIAL_FAILED_MARKER" <<<"$logs" &&
    ! grep -Fq "$NETPOL_ADDITIVE_FAILED_MARKER" <<<"$logs" &&
    ! grep -Fq "$NETPOL_RETRY_SCHEDULED_MARKER" <<<"$logs" &&
    ! grep -Fq "${NETPOL_CONTEXT_FAILED_MARKER}${CONTEXT_NAME}:" <<<"$logs"
}

clean_window_runtime_and_ready_absent() {
  # Family 3, clean-window form. fixture_runtime_and_ready_absent requires the
  # McpServer object to EXIST (mcpserver_current_ready_absent fails on a missing
  # object); in clean windows the fixture may not exist at all, which is the
  # strongest form of absence. An API error still fails closed.
  fixture_runtime_absent || return 1
  if ! resource_absent mcpserver "$MCP_NAME" "$MCP_NS"; then
    mcpserver_current_ready_absent "$MCP_NAME" || return 1
  fi
  external_egress_policy_absent
}

fixture_runtime_converged_with_protocol() {
  local protocol=$1 desired available
  desired="$(kctl get deployment "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null)" || return 1
  available="$(kctl get deployment "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null)" || return 1
  [ "${desired:-0}" -ge 1 ] && [ "${available:-0}" -ge 1 ] || return 1
  kctl get service "$MCP_NAME" -n "$MCP_NS" >/dev/null 2>&1 || return 1
  mcpserver_current_ready "$MCP_NAME" || return 1
  external_egress_policy_converged_with_protocol "$protocol"
}

fixture_resources_absent() {
  fixture_mcp_runtime_absent &&
    context_policies_absent &&
    peer_fleet_runtime_absent &&
    peer_fleet_policies_absent
}

fixture_inputs_absent() {
  resource_absent context "$CONTEXT_NAME" "$MCP_NS" &&
    resource_absent mcpserver "$MCP_NAME" "$MCP_NS" && peer_fleet_inputs_absent
}

peer_fleet_inputs_absent() {
  local index
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    resource_absent context "${CONTEXT_FLEET_NAMES[index]}" "$MCP_NS" || return 1
    resource_absent mcpserver "${MCP_FLEET_NAMES[index]}" "$MCP_NS" || return 1
  done
}

peer_fleet_runtime_absent() {
  local index server
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    server="${MCP_FLEET_NAMES[index]}"
    resource_absent deployment "$server" "$MCP_NS" || return 1
    resource_absent service "$server" "$MCP_NS" || return 1
  done
}

peer_fleet_policies_absent() {
  local index server context context_policy external_policies
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    server="${MCP_FLEET_NAMES[index]}"
    context="${CONTEXT_FLEET_NAMES[index]}"
    context_policy="ctx-${context}-${server}"
    resource_absent networkpolicy "$context_policy" "$MCP_NS" || return 1
    resource_absent networkpolicy "${context_policy}-egress" "$HOST_NS" || return 1
    resource_absent networkpolicy "rpc-egress-${context}-${server}" "$RPC_PROXY_NS" || return 1
    external_policies="$(
      kctl get networkpolicy -n "$MCP_NS" \
        -l "${MCP_SERVER_LABEL}=${server},${POLICY_TYPE_LABEL}=external-egress" \
        -o name 2>/dev/null
    )" || return 1
    [ -z "$external_policies" ] || return 1
  done
}

peer_fleet_converged() {
  local index server context desired available
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    server="${MCP_FLEET_NAMES[index]}"
    context="${CONTEXT_FLEET_NAMES[index]}"
    desired="$(kctl get deployment "$server" -n "$MCP_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null)" || return 1
    available="$(kctl get deployment "$server" -n "$MCP_NS" -o jsonpath='{.status.availableReplicas}' 2>/dev/null)" || return 1
    [ "${desired:-0}" -ge 1 ] && [ "${available:-0}" -ge 1 ] || return 1
    kctl get service "$server" -n "$MCP_NS" >/dev/null 2>&1 || return 1
    mcpserver_current_ready "$server" || return 1
    context_policies_converged "$context" "$context" "$server" || return 1
  done
}

baseline_policy_snapshot() {
  kctl get \
    "networkpolicy/deny-all-${MCP_NS}" \
    "networkpolicy/allow-dns-egress-${MCP_NS}" \
    networkpolicy/allow-host-context-controller-api \
    -n "$MCP_NS" -o json 2>/dev/null |
    jq -ceS \
      --arg managedBy "$MANAGED_BY_VALUE" \
      --arg deny "deny-all-${MCP_NS}" \
      --arg dns "allow-dns-egress-${MCP_NS}" '
      [.items[] | {
        name: .metadata.name,
        managedBy: .metadata.labels["clerum.io/managed-by"],
        policyType: .metadata.labels["clerum.io/policy-type"],
        spec
      }]
      | sort_by(.name)
      | select(length == 3)
      | select(all(.[];
          .managedBy == $managedBy and
          ((.name == $deny and .policyType == "default-deny") or
           (.name == $dns and .policyType == "infrastructure") or
           (.name == "allow-host-context-controller-api" and .policyType == "allow-api"))))
    '
}

baseline_policies_unchanged() {
  local current
  [ -n "$BASELINE_POLICY_SNAPSHOT" ] || return 1
  current="$(baseline_policy_snapshot)" || return 1
  [ "$current" = "$BASELINE_POLICY_SNAPSHOT" ]
}

context_watch_has_latest_spec() {
  kctl get context "$CONTEXT_NAME" -n "$MCP_NS" -o json |
    jq -e --arg server "$MCP_NAME" '.spec.mcpServers == [$server]' >/dev/null
}

mcp_egress_binding_is_udp() {
  kctl get mcpserver "$MCP_NAME" -n "$MCP_NS" -o json |
    jq -e --arg dns "$TARGET_DNS" '
      (.spec.egressBindings | length) == 1 and
      .spec.egressBindings[0].egressClass == "exact-host" and
      .spec.egressBindings[0].dns == $dns and
      .spec.egressBindings[0].port == 443 and
      .spec.egressBindings[0].protocol == "UDP"
    ' >/dev/null
}

create_peer_fleet() {
  local index server context
  # Arm cleanup before the first write so a partial apply cannot strand input
  # CRDs or leave HCC deliberately scaled down during failure recovery.
  PEER_FLEET_CREATED=1
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    server="${MCP_FLEET_NAMES[index]}"
    context="${CONTEXT_FLEET_NAMES[index]}"
    kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${context}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextId: ${context}
  description: Gate-owned peer Context for HCC readiness fleet coverage.
  mcpServers: [${server}]
---
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${server}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextRef: ${context}
  description: Gate-owned peer McpServer for bounded HCC fleet coverage.
  image: clerum/mock-mcp-server:test
  imagePullPolicy: IfNotPresent
  transport:
    type: streamableHttp
    url: http://${server}.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
EOF
  done
}

fixture_converged() {
  local desired available
  desired="$(kctl get deployment "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null)" || return 1
  available="$(kctl get deployment "$MCP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null)" || return 1
  [ "${desired:-0}" -ge 1 ] && [ "${available:-0}" -ge 1 ] || return 1
  kctl get service "$MCP_NAME" -n "$MCP_NS" >/dev/null 2>&1 || return 1
  mcpserver_current_ready "$MCP_NAME" || return 1
  external_egress_policy_converged || return 1
  context_policies_converged
}

probe_hcc_final_context() {
  local probe_script
  probe_script="$(cat <<'NODE'
const http = require('http');
const context = process.argv[1];
const expected = process.argv[2];
function get(path) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port: Number(process.env.HCC_E2E_PORT),
      path
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({status: response.statusCode, body}));
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.once('error', reject);
  });
}
(async () => {
  const ready = await get('/ready');
  const scoped = await get('/api/v1/mcpservers/context/' + encodeURIComponent(context));
  const body = JSON.parse(scoped.body);
  const fixture = body.servers?.find(server => server.name === expected);
  if (ready.status !== 200 || JSON.parse(ready.body).ready !== true) {
    throw new Error('readiness regressed: ' + ready.status + ' ' + ready.body);
  }
  if (scoped.status !== 200 || !fixture || fixture.status?.ready !== true) {
    throw new Error('latest Context did not converge in discovery: ' + scoped.status + ' ' + scoped.body);
  }
  console.log(JSON.stringify({
    readyStatus: ready.status,
    scopedDiscoveryStatus: scoped.status,
    contextRef: body.contextRef,
    fixture: fixture.name,
    fixtureReady: fixture.status.ready
  }));
})().catch(error => { console.error(error.message); process.exit(1); });
NODE
)"
  kctl exec "pod/${NEW_HCC_POD}" -n "$HCC_NS" -c host-context-controller -- \
    env "HCC_E2E_PORT=${HCC_PORT}" \
    node -e "$probe_script" "$CONTEXT_NAME" "$MCP_NAME"
}

probe_hcc_ready_pod() {
  local pod
  pod="$(ready_pod_name "$HCC_NS" "app=${HCC_DEPLOY}")" || return 1
  kctl exec "pod/${pod}" -n "$HCC_NS" -c host-context-controller -- \
    env "HCC_E2E_PORT=${HCC_PORT}" \
    node -e '
      const http = require("node:http");
      const request = http.get(
        {host: "127.0.0.1", port: Number(process.env.HCC_E2E_PORT), path: "/ready"},
        response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { process.exit(2); }
            process.exit(response.statusCode === 200 && parsed?.ready === true ? 0 : 3);
          });
        }
      );
      request.setTimeout(5000, () => request.destroy(new Error("timeout")));
      request.once("error", () => process.exit(4));
    ' >/dev/null 2>&1
}

probe_new_hcc_ready_endpoint() {
  local output first_line
  HCC_READY_PROBE_DIAGNOSTIC="HCC_READY_PROBE category=pod-not-selected"
  [ -n "$NEW_HCC_POD" ] || return 1
  if output="$(
    kctl exec "pod/${NEW_HCC_POD}" -n "$HCC_NS" -c host-context-controller -- \
      env "HCC_E2E_PORT=${HCC_PORT}" \
      node -e '
      const http = require("node:http");
      let finished = false;
      const finish = (code, category, detail = "") => {
        if (finished) return;
        finished = true;
        if (category) {
          console.error(`HCC_READY_PROBE category=${category}${detail}`);
        }
        process.exitCode = code;
      };
      const request = http.get(
        {host: "127.0.0.1", port: Number(process.env.HCC_E2E_PORT), path: "/ready"},
        response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            if (response.statusCode !== 200) {
              finish(3, "http-status", ` status=${response.statusCode ?? "unknown"}`);
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(body);
            } catch {
              finish(2, "json-invalid");
              return;
            }
            if (parsed?.ready !== true) {
              finish(3, "json-ready-false");
              return;
            }
            finish(0);
          });
        }
      );
      request.setTimeout(2000, () => {
        finish(4, "timeout");
        request.destroy();
      });
      request.once("error", () => finish(5, "transport"));
    ' 2>&1
  )"; then
    HCC_READY_PROBE_DIAGNOSTIC=""
    return 0
  fi
  first_line="${output%%$'\n'*}"
  case "$first_line" in
    "HCC_READY_PROBE category="*)
      printf -v HCC_READY_PROBE_DIAGNOSTIC '%.240s' "$first_line"
      ;;
    *)
      HCC_READY_PROBE_DIAGNOSTIC="HCC_READY_PROBE category=kubectl-exec"
      ;;
  esac
  return 1
}

# Third, independent signal of the safety contract (M6): the authoritative pass
# must actually have MEASURED and REVOKED. The unit tests assert the readiness
# predicate over vi.fn() mocks, so a metric rename would leave them green; these
# family-name literals live in the gate, so a rename turns the REAL gate red.
# Pure adjudication over a /metrics scrape — unit-testable without a cluster.
safety_pass_metrics_are_certified() {
  local metrics=$1
  grep -Fq -- 'clerum_hcc_networkpolicy_safety_pass_duration_seconds' <<<"$metrics" || return 1
  # At least one policy revoked by an authoritative pass ($NF is the sample
  # value; tolerant of extra/reordered labels).
  awk '$0 ~ /^clerum_hcc_networkpolicy_safety_pass_policies_total\{/ && /operation="revoked"/ { if ($NF + 0 >= 1) found = 1 } END { exit(found ? 0 : 1) }' <<<"$metrics"
}

# Scrapes the running replacement pod's /metrics over the same in-pod node/http
# channel the /ready probes use, then adjudicates. The sub-0.5s window B4 leaves
# unobservable on /ready is covered here: the counter is monotonic.
safety_pass_metrics_certify() {
  local metrics
  metrics="$(kctl exec "pod/${NEW_HCC_POD}" -n "$HCC_NS" -c host-context-controller -- \
    env "HCC_E2E_PORT=${HCC_PORT}" \
    node -e '
      const http = require("node:http");
      const request = http.get(
        {host: "127.0.0.1", port: Number(process.env.HCC_E2E_PORT), path: "/metrics"},
        response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            process.stdout.write(body);
            process.exit(response.statusCode === 200 ? 0 : 1);
          });
        }
      );
      request.setTimeout(2000, () => { request.destroy(); process.exit(1); });
      request.on("error", () => process.exit(1));
    ')" || return 1
  safety_pass_metrics_are_certified "$metrics"
}

hcc_ready_after_stale_policy_revoked() {
  # A single poll that sees 200 WHILE the stale policy is still present is a
  # safety-contract violation and must be FATAL, never retried: retrying lets a
  # later poll (policy already revoked) turn the violation into a false PASS.
  # rc=2 signals that fatal ordering violation to wait_until_fast; rc=1 is a
  # benign "not ready yet, keep polling". The sub-0.5s window where revocation
  # races the probe inside one poll stays unobservable on THIS signal — the
  # third signal (M6, /metrics) covers it.
  local policy_absent_before=0
  external_egress_policy_absent && policy_absent_before=1
  probe_new_hcc_ready_endpoint || return 1
  if external_egress_policy_absent; then
    [ "$policy_absent_before" -eq 1 ] && return 0
    # Revocation raced the probe inside this poll: the final state is clean but
    # this poll cannot adjudicate the order. Retry to adjudicate cleanly.
    return 1
  fi
  HCC_READY_PROBE_DIAGNOSTIC="HCC_READY_PROBE category=ready-200-with-stale-policy-present"
  return 2
}

hcc_restore_is_verified() {
  local deployment
  deployment="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json)" || return 1
  jq -e \
    --arg dnsPolicy "$ORIGINAL_DNS_POLICY" \
    --argjson replicas "${ORIGINAL_REPLICAS:-1}" '
      .spec.replicas == $replicas and
      (.status.readyReplicas // 0) == $replicas and
      (.status.availableReplicas // 0) == $replicas and
      (.spec.template.spec.dnsPolicy // "ClusterFirst") == $dnsPolicy and
      (.spec.template.spec.dnsConfig // null) == null
    ' <<<"$deployment" >/dev/null || return 1
  probe_hcc_ready_pod
}

release_dns_blocker() {
  local release_script
  release_script="$(cat <<'NODE'
const http = require('http');
const request = http.request(
  {host: '127.0.0.1', port: 8090, path: '/release', method: 'POST'},
  response => {
    response.resume();
    response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 2));
  }
);
request.setTimeout(5000, () => request.destroy(new Error('timeout')));
request.once('error', error => { console.error(error.message); process.exit(3); });
request.end();
NODE
)"
  kctl exec "deployment/${DNS_BLOCKER_NAME}" -n "$HCC_NS" -c dns-blocker -- \
    node -e "$release_script"
}

hold_dns_blocker() {
  local hold_script
  DNS_HOLD_COUNT_AT_ARM="$(dns_hold_count)" ||
    return 1
  hold_script="$(cat <<'NODE'
const http = require('http');
const request = http.request(
  {host: '127.0.0.1', port: 8090, path: '/hold', method: 'POST'},
  response => {
    response.resume();
    response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 2));
  }
);
request.setTimeout(5000, () => request.destroy(new Error('timeout')));
request.once('error', error => { console.error(error.message); process.exit(3); });
request.end();
NODE
)"
  kctl exec "deployment/${DNS_BLOCKER_NAME}" -n "$HCC_NS" -c dns-blocker -- \
    node -e "$hold_script"
}

delete_fixture_runtime_leaving_dns_policy_for_safety() {
  local failed=0
  kctl delete deployment "$MCP_NAME" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete service "$MCP_NAME" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete configmap "${MCP_NAME}-nginx-conf" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  [ "$failed" = 0 ] && fixture_runtime_absent
}

delete_dns_blocker_fixture() {
  local failed=0
  kctl delete networkpolicy "$HCC_DNS_POLICY" "$DNS_BLOCKER_POLICY" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete service "$DNS_BLOCKER_NAME" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete deployment "$DNS_BLOCKER_NAME" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  [ "$failed" = 0 ]
}

delete_residual_fixture_runtime() {
  local failed=0
  kctl delete deployment "$MCP_NAME" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete service "$MCP_NAME" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete configmap "${MCP_NAME}-nginx-conf" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete networkpolicy "$CONTEXT_POLICY" -n "$MCP_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete networkpolicy "$CONTEXT_EGRESS_POLICY" -n "$HOST_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete networkpolicy "$RPC_EGRESS_POLICY" -n "$RPC_PROXY_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete networkpolicy -n "$MCP_NS" -l "${MCP_SERVER_LABEL}=${MCP_NAME}" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  delete_peer_fleet_runtime || failed=1
  [ "$failed" = 0 ]
}

delete_peer_fleet_runtime() {
  local index server context context_policy failed=0
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    server="${MCP_FLEET_NAMES[index]}"
    context="${CONTEXT_FLEET_NAMES[index]}"
    context_policy="ctx-${context}-${server}"
    kctl delete deployment "$server" -n "$MCP_NS" --ignore-not-found --wait=true --timeout=60s \
      >/dev/null 2>&1 || failed=1
    kctl delete service "$server" -n "$MCP_NS" --ignore-not-found --wait=true --timeout=60s \
      >/dev/null 2>&1 || failed=1
    kctl delete configmap "${server}-nginx-conf" -n "$MCP_NS" --ignore-not-found --wait=true --timeout=60s \
      >/dev/null 2>&1 || failed=1
    kctl delete networkpolicy -n "$MCP_NS" -l "${MCP_SERVER_LABEL}=${server}" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
    kctl delete networkpolicy "${context_policy}-egress" -n "$HOST_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
    kctl delete networkpolicy "rpc-egress-${context}-${server}" -n "$RPC_PROXY_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done
  [ "$failed" = 0 ]
}

delete_peer_fleet_inputs() {
  local index failed=0
  for ((index = 1; index < ${#MCP_FLEET_NAMES[@]}; index++)); do
    kctl delete context "${CONTEXT_FLEET_NAMES[index]}" -n "$MCP_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
    kctl delete mcpserver "${MCP_FLEET_NAMES[index]}" -n "$MCP_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done
  [ "$failed" = 0 ]
}

suite_resources_absent() {
  local namespaced cluster_crds
  namespaced="$(kctl get deployment,service,networkpolicy -A \
    -l "e2e.clerum.io/suite=${SUITE_NAME}" -o name 2>/dev/null)" || return 1
  cluster_crds="$(
    kctl get mcpserver,context -A -l "e2e.clerum.io/suite=${SUITE_NAME}" \
      -o name 2>/dev/null
  )" || return 1
  [ -z "$namespaced$cluster_crds" ]
}

print_repair_instructions() {
  cat >&2 <<EOF
HCC MCP readiness gate cleanup could not restore a verified clean state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
DNS blocker: ${HCC_NS}/${DNS_BLOCKER_NAME}
Fixtures: ${MCP_NS}/${MCP_NAME}, ${MCP_NS}/${CONTEXT_NAME}

Inspect before changing anything:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment ${HCC_DEPLOY} -o yaml
  kubectl --context=${E2E_KUBECONTEXT} get deployment,service,networkpolicy -A -l e2e.clerum.io/suite=${SUITE_NAME}
  kubectl --context=${E2E_KUBECONTEXT} get mcpserver,context -A -l e2e.clerum.io/suite=${SUITE_NAME}

Do not remove the HCC gate lock until HCC health and fixture absence are verified.

Restore the original HCC replica count before verifying rollout and /ready:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} rollout status deployment/${HCC_DEPLOY} --timeout=240s
EOF
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1 fixture_inputs_removed=1 restore_patch
  local clean_window_pod
  trap - EXIT
  set +e

  if [ "$HCC_MUTATED" = 1 ]; then
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null 2>&1 ||
      restore_ok=0
    if [ "$restore_ok" = 1 ]; then
      wait_until 120 "HCC pods to stop before fixture cleanup" \
        hcc_pods_absent >/dev/null 2>&1 || restore_ok=0
    fi
  fi

  if [ "$CONTEXT_CREATED" = 1 ]; then
    kctl delete context "$CONTEXT_NAME" -n "$MCP_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 ||
      {
        cleanup_failed=1
        fixture_inputs_removed=0
      }
  fi
  if [ "$MCP_CREATED" = 1 ]; then
    kctl delete mcpserver "$MCP_NAME" -n "$MCP_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 ||
      {
        cleanup_failed=1
        fixture_inputs_removed=0
      }
  fi
  if [ "$PEER_FLEET_CREATED" = 1 ]; then
    delete_peer_fleet_inputs || {
      cleanup_failed=1
      fixture_inputs_removed=0
    }
  fi
  if ! wait_until 60 "gate-owned Context and McpServer inputs to disappear" \
    fixture_inputs_absent >/dev/null 2>&1; then
    cleanup_failed=1
    fixture_inputs_removed=0
  fi

  if [ "$HCC_MUTATED" = 1 ]; then
    if [ "$fixture_inputs_removed" = 1 ] && [ "$restore_ok" = 1 ]; then
      restore_patch="$(jq -cn --arg dnsPolicy "$ORIGINAL_DNS_POLICY" \
        '{spec:{template:{spec:{dnsPolicy:$dnsPolicy,dnsConfig:null}}}}')"
      kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=strategic \
        -p "$restore_patch" >/dev/null 2>&1 || restore_ok=0
      kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" \
        --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1 || restore_ok=0
      kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" \
        --timeout=240s >/dev/null 2>&1 || restore_ok=0
      if [ "$restore_ok" = 1 ]; then
        wait_until 60 "restored HCC DNS, replicas, Ready pod, and /ready endpoint" \
          hcc_restore_is_verified >/dev/null 2>&1 || restore_ok=0
      fi
    else
      restore_ok=0
    fi
  fi

  if [ "$restore_ok" = 1 ]; then
    if ! wait_until 180 "HCC to remove all MCP/Context fixture runtime resources" \
      fixture_resources_absent >/dev/null 2>&1; then
      cleanup_failed=1
      delete_residual_fixture_runtime || cleanup_failed=1
    fi
    if [ "$DNS_BLOCKER_CREATED" = 1 ]; then
      delete_dns_blocker_fixture || cleanup_failed=1
    fi
    wait_until 60 "all HCC MCP readiness suite resources to disappear" \
      suite_resources_absent >/dev/null 2>&1 || cleanup_failed=1

    # Clean window B: DNS restored and fixture inputs gone. The restored pod is
    # new (scale-0 preceded the restore), so its log is scoped to this window.
    clean_window_pod="$(running_hcc_pod)"
    if [ -n "$clean_window_pod" ] &&
      clean_window_netpol_log_negatives_hold "$clean_window_pod"; then
      clean_window_checks_run=$((clean_window_checks_run + 1))
    else
      fail "post-restore clean-window NetworkPolicy log negatives did not hold"
      cleanup_failed=1
    fi
    if fixture_mcp_runtime_absent; then
      clean_window_checks_run=$((clean_window_checks_run + 1))
    else
      fail "post-restore fixture runtime or external-egress policy survived"
      cleanup_failed=1
    fi
    if clean_window_runtime_and_ready_absent; then
      clean_window_checks_run=$((clean_window_checks_run + 1))
    else
      fail "post-restore McpServer Ready status or external-egress policy survived"
      cleanup_failed=1
    fi
  else
    cleanup_failed=1
  fi

  if ! finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"; then
    cleanup_failed=1
  fi

  if [ "$status" = 0 ]; then
    [ "${clean_window_checks_run:-0}" -gt 0 ] ||
      die "no clean-window negative checks ran (clean_window_checks_run=0)"
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    echo "HCC MCP readiness gate cleanup failed on context ${E2E_KUBECONTEXT}." >&2
    [ "$restore_ok" = 1 ] || print_repair_instructions
    [ "$status" = 0 ] && status=1
  fi
  if [ "$status" = 0 ] && [ "$cleanup_failed" = 0 ] && [ "$restore_ok" = 1 ]; then
    header "HCC McpServer/Context readiness gate passed"
    echo "$final_probe"
  fi
  exit "$status"
}
trap cleanup EXIT

header "HCC readiness during initial McpServer and Context convergence"

require_branch_owned_hcc_gate "$HCC_NS"
kctl get nodes -o json |
  jq -e --arg context "$E2E_KUBECONTEXT" \
    'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $context)' >/dev/null ||
  die "target context is not a minikube cluster"
suite_resources_absent ||
  die "stale ${SUITE_NAME} resources exist; inspect them before starting a new fault injection"
acquire_hcc_watch_gate_lock ||
  die "another disruptive HCC gate owns context ${E2E_KUBECONTEXT}"
ok "branch helper, profile, exact HEAD/fingerprint/gate, and exclusive HCC lock verified"

# Clean window A: the DNS fault injection is not applied yet. The branch-deployed
# HCC must show a clean NetworkPolicy lane and zero fixture residue before the
# gate mutates anything.
clean_window_pod="$(running_hcc_pod)" && [ -n "$clean_window_pod" ] ||
  die "no Running HCC pod before fault injection"
clean_window_netpol_log_negatives_hold "$clean_window_pod" ||
  die "pre-injection HCC logs already contain NetworkPolicy-lane failure or retry markers"
clean_window_checks_run=$((clean_window_checks_run + 1))
fixture_mcp_runtime_absent ||
  die "pre-injection fixture runtime or external-egress policy already exists"
clean_window_checks_run=$((clean_window_checks_run + 1))
clean_window_runtime_and_ready_absent ||
  die "pre-injection McpServer Ready status or external-egress policy already exists"
clean_window_checks_run=$((clean_window_checks_run + 1))
ok "all three clean-window negative families hold before DNS fault injection"

ORIGINAL_REPLICAS="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.replicas}')"
[ "$ORIGINAL_REPLICAS" = 1 ] ||
  die "expected exactly one HCC replica, found ${ORIGINAL_REPLICAS:-unknown}"
ORIGINAL_DNS_POLICY="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.dnsPolicy}')"
ORIGINAL_DNS_POLICY="${ORIGINAL_DNS_POLICY:-ClusterFirst}"
[ "$ORIGINAL_DNS_POLICY" = ClusterFirst ] ||
  die "HCC already has non-default dnsPolicy ${ORIGINAL_DNS_POLICY}; refusing a non-restorable fixture"
ORIGINAL_DNS_CONFIG="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json |
  jq -c '.spec.template.spec.dnsConfig // null')"
[ "$ORIGINAL_DNS_CONFIG" = null ] ||
  die "HCC already has dnsConfig ${ORIGINAL_DNS_CONFIG}; refusing a non-restorable fixture"
HCC_IMAGE="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
[ -n "$HCC_IMAGE" ] || die "could not resolve the running HCC image"
HCC_PORT="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json | jq -r '
  .spec.template.spec.containers[]? |
  select(.name == "host-context-controller") as $container |
  (
    [$container.env[]? | select(.name == "CONTEXT_MAPPER_PORT") | .value][0] //
    [$container.ports[]? | select(.name == "http") | .containerPort][0] //
    empty
  )
')"
[[ "$HCC_PORT" =~ ^[0-9]+$ ]] && [ "$HCC_PORT" -ge 1 ] && [ "$HCC_PORT" -le 65535 ] ||
  die "could not resolve a valid HCC HTTP port from the Deployment"
UPSTREAM_DNS_IP="$(kctl get service kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}')"
[ -n "$UPSTREAM_DNS_IP" ] || die "could not resolve kube-system/kube-dns ClusterIP"
running_dns_pods="$(kctl get pods -n kube-system -l k8s-app=kube-dns \
  --field-selector=status.phase=Running -o name)"
[ -n "$running_dns_pods" ] ||
  die "no Running kube-dns pod is available"

DNS_BLOCKER_CREATED=1
kctl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DNS_BLOCKER_NAME}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${DNS_BLOCKER_NAME}
  template:
    metadata:
      labels:
        app: ${DNS_BLOCKER_NAME}
        e2e.clerum.io/suite: ${SUITE_NAME}
        e2e.clerum.io/run: "${RUN_LABEL}"
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
      - name: dns-blocker
        image: ${HCC_IMAGE}
        imagePullPolicy: IfNotPresent
        command: [node, -e]
        args:
        - >-
          const dgram=require('node:dgram'),http=require('node:http'),
          net=require('node:net');
          const target=process.env.TARGET_DNS,upstream=process.env.UPSTREAM_DNS;
          const udp=dgram.createSocket('udp4');let released=process.env.START_RELEASED==='1';const held=[];
          function question(message){let offset=12,labels=[];while(offset<message.length){
          const length=message[offset++];if(length===0)break;if(offset+length>message.length)
          return null;labels.push(message.subarray(offset,offset+length).toString('ascii'));
          offset+=length;}if(offset+4>message.length)return null;return
          {name:labels.join('.'),type:message.readUInt16BE(offset),end:offset+4};}
          function answer(message,parsed){const header=Buffer.from(message.subarray(0,12));
          header.writeUInt16BE(0x8180,2);header.writeUInt16BE(1,6);
          header.writeUInt16BE(0,8);header.writeUInt16BE(0,10);
          const record=Buffer.from([0xc0,0x0c,0x00,0x01,0x00,0x01,0x00,0x00,
          0x00,0x1e,0x00,0x04,93,184,216,34]);
          return Buffer.concat([header,message.subarray(12,parsed.end),record]);}
          function tcpFrame(message){const frame=Buffer.alloc(message.length+2);
          frame.writeUInt16BE(message.length,0);message.copy(frame,2);return frame;}
          function respond(entry){const response=answer(entry.message,entry.parsed);
          if(entry.transport==='udp'){udp.send(response,entry.rinfo.port,
          entry.rinfo.address);console.log('released DNS A '+target+' via UDP');return;}
          if(!entry.socket.destroyed){entry.socket.write(tcpFrame(response));
          console.log('released DNS A '+target+' via TCP');}}
          function forwardUdp(message,rinfo){const relay=dgram.createSocket('udp4');
          const timer=setTimeout(()=>relay.close(),5000);relay.once('message',response=>{
          clearTimeout(timer);udp.send(response,rinfo.port,rinfo.address);relay.close();});
          relay.once('error',()=>{clearTimeout(timer);relay.close();});
          relay.send(message,53,upstream);}
          function forwardTcp(message,socket){const relay=net.createConnection(
          {host:upstream,port:53},()=>relay.write(tcpFrame(message)));
          let pending=Buffer.alloc(0);relay.setTimeout(5000,()=>relay.destroy());
          relay.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);
          if(pending.length<2)return;const length=pending.readUInt16BE(0);
          if(pending.length<length+2)return;if(!socket.destroyed)
          socket.write(pending.subarray(0,length+2));relay.destroy();});
          relay.once('error',()=>relay.destroy());}
          function handle(message,entry){const parsed=question(message);
          if(parsed&&parsed.name===target&&parsed.type===1){entry.message=message;
          entry.parsed=parsed;if(released)respond(entry);else{held.push(entry);
          console.log('holding DNS A '+target+' via '+entry.transport.toUpperCase());}
          return;}if(entry.transport==='udp')forwardUdp(message,entry.rinfo);
          else forwardTcp(message,entry.socket);}
          let listeners=0;function listening(){listeners+=1;if(listeners===2)
          console.log('dns hold proxy ready for '+target+' over UDP and TCP');}
          udp.on('message',(message,rinfo)=>handle(message,{transport:'udp',rinfo}));
          udp.bind(8053,'0.0.0.0',listening);
          const tcp=net.createServer(socket=>{let pending=Buffer.alloc(0);
          socket.on('data',chunk=>{pending=Buffer.concat([pending,chunk]);
          while(pending.length>=2){const length=pending.readUInt16BE(0);
          if(pending.length<length+2)return;const message=pending.subarray(2,length+2);
          pending=pending.subarray(length+2);handle(message,{transport:'tcp',socket});}});
          });tcp.listen(8053,'0.0.0.0',listening);
          http.createServer((request,response)=>{if(request.method==='POST'&&
          request.url==='/release'){released=true;while(held.length)respond(held.shift());
          response.writeHead(200);response.end('released');return;}if(request.method==='POST'&&
          request.url==='/hold'){released=false;response.writeHead(200);response.end('holding');return;}
          response.writeHead(404);response.end();}).listen(8090,'127.0.0.1');
        env:
        - name: TARGET_DNS
          value: ${TARGET_DNS}
        - name: START_RELEASED
          value: "1"
        - name: UPSTREAM_DNS
          value: ${UPSTREAM_DNS_IP}
        resources:
          requests: {cpu: 5m, memory: 20Mi}
          limits: {cpu: 75m, memory: 64Mi}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          runAsGroup: 1000
          seccompProfile: {type: RuntimeDefault}
---
apiVersion: v1
kind: Service
metadata:
  name: ${DNS_BLOCKER_NAME}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  selector:
    app: ${DNS_BLOCKER_NAME}
  ports:
  - name: dns-udp
    protocol: UDP
    port: 53
    targetPort: 8053
  - name: dns-tcp
    protocol: TCP
    port: 53
    targetPort: 8053
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${DNS_BLOCKER_POLICY}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  podSelector:
    matchLabels:
      app: ${DNS_BLOCKER_NAME}
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ${HCC_DEPLOY}
    ports:
    - {protocol: UDP, port: 8053}
    - {protocol: UDP, port: 53}
    - {protocol: TCP, port: 8053}
    - {protocol: TCP, port: 53}
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - {protocol: UDP, port: 53}
    - {protocol: TCP, port: 53}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${HCC_DNS_POLICY}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  podSelector:
    matchLabels:
      app: ${HCC_DEPLOY}
  policyTypes: [Egress]
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: ${DNS_BLOCKER_NAME}
    ports:
    - {protocol: UDP, port: 53}
    - {protocol: UDP, port: 8053}
    - {protocol: TCP, port: 53}
    - {protocol: TCP, port: 8053}
EOF
kctl rollout status deployment "$DNS_BLOCKER_NAME" -n "$HCC_NS" \
  --timeout=90s >/dev/null || die "DNS blocker did not become ready"
wait_until 30 "DNS blocker process to listen" \
  dns_log_contains "dns hold proxy ready for ${TARGET_DNS}" ||
  die "DNS blocker process did not start"
DNS_BLOCKER_IP="$(kctl get service "$DNS_BLOCKER_NAME" -n "$HCC_NS" \
  -o jsonpath='{.spec.clusterIP}')"
[ -n "$DNS_BLOCKER_IP" ] || die "DNS blocker Service has no ClusterIP"
ok "isolated DNS hold proxy is ready and forwards non-fixture UDP/TCP queries to CoreDNS"

[ "${clean_window_checks_run:-0}" -ge 3 ] ||
  die "pre-injection clean-window negatives did not run before the DNS mutation"

HCC_MUTATED=1
dns_patch="$(jq -cn --arg nameserver "$DNS_BLOCKER_IP" '
  {spec:{template:{spec:{
    dnsPolicy:"None",
    dnsConfig:{
      nameservers:[$nameserver],
      options:[
        {name:"ndots",value:"1"},
        {name:"timeout",value:"30"},
        {name:"attempts",value:"1"}
      ]
    }
  }}}}
')"
kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=strategic \
  -p "$dns_patch" >/dev/null
kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null ||
  die "HCC did not become Ready with the deterministic DNS proxy"
wait_until 60 "HCC /ready endpoint with the released DNS proxy" probe_hcc_ready_pod ||
  die "HCC readiness was unavailable before the stale-policy fixture"

CONTEXT_CREATED=1
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
  contextId: ${CONTEXT_ID}
  description: E2E HCC readiness Context updated while initial MCP convergence is blocked.
  mcpServers: []
EOF

MCP_CREATED=1
kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_NAME}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextRef: ${CONTEXT_NAME}
  description: E2E MCP fixture for initial fleet readiness.
  image: clerum/mock-mcp-server:test
  imagePullPolicy: IfNotPresent
  transport:
    type: streamableHttp
    url: http://${MCP_NAME}.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
  - dns: ${TARGET_DNS}
    port: 443
    protocol: ${INITIAL_EXTERNAL_EGRESS_PROTOCOL}
EOF

wait_until 180 "HCC to create the real initial TCP external-egress policy" \
  external_egress_policy_converged_with_protocol "$INITIAL_EXTERNAL_EGRESS_PROTOCOL" ||
  die "HCC never created the initial external-egress policy for the stale-policy fixture"
ok "HCC created a real initial TCP external-egress policy"
BASELINE_POLICY_SNAPSHOT="$(baseline_policy_snapshot)" ||
  die "could not capture canonical baseline NetworkPolicy ownership and specs"

# Same-intent safety phase: restart with the exact same desired binding. The
# safety pass must revoke the DNS-derived policy without resolving DNS, certify
# global readiness, and leave the affected runtime blocked for the additive
# lane.
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null
wait_until 120 "existing HCC pods to stop" hcc_pods_absent ||
  die "existing HCC pod did not stop"
delete_fixture_runtime_leaving_dns_policy_for_safety ||
  die "could not remove the initial MCP runtime while retaining its external-egress policy"
external_egress_policy_converged_with_protocol "$INITIAL_EXTERNAL_EGRESS_PROTOCOL" ||
  die "the initial TCP policy disappeared before the same-intent safety pass"
create_peer_fleet || die "could not create the gate-owned MCP/Context peer fleet"
ok "created ${#MCP_FLEET_NAMES[@]} gate-owned MCP/Context fixtures before fleet bootstrap"

hold_dns_blocker || die "could not hold the next fixture DNS query"
DNS_RELEASE_COUNT_AT_HOLD="$(dns_release_count)" ||
  die "could not capture the DNS release baseline before the same-intent restart"
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1 >/dev/null
wait_until 120 "same-intent HCC pod to enter Running" capture_hcc ||
  die "same-intent HCC pod did not start"
identity="$(kctl get pod "$NEW_HCC_POD" -n "$HCC_NS" \
  -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}')"
read -r HCC_UID HCC_RESTARTS <<<"$identity"
[ -n "$HCC_UID" ] && [ -n "$HCC_RESTARTS" ] ||
  die "could not capture same-intent HCC pod identity"
wait_until 120 "same-intent external-egress refresh to reach the DNS hold" \
  dns_hold_observed_since_arm ||
  die "same-intent external-egress refresh never reached the DNS hold"
wait_until_fast 60 "HCC readiness after revoking the same-intent DNS policy" \
  hcc_ready_after_stale_policy_revoked ||
  die "HCC did not revoke the same-intent DNS policy before global readiness (${HCC_READY_PROBE_DIAGNOSTIC:-HCC_READY_PROBE category=unknown})"
fixture_runtime_and_ready_absent ||
  die "the affected runtime or Ready status escaped the held same-intent DNS boundary"
wait_until 30 "Kubernetes to corroborate same-intent HCC readiness" \
  hcc_kubernetes_readiness_is_exact ||
  die "Kubernetes did not corroborate same-intent HCC readiness"
external_egress_policy_absent ||
  die "the same-intent DNS policy reappeared before additive retry"
wait_until 120 "a real same-intent external-egress retry to be scheduled" \
  external_egress_retry_progress_is_observed ||
  die "the held same-intent refresh did not schedule a real retry"
DNS_HOLD_COUNT_AT_RETRY_SCHEDULE="$(dns_hold_count)" ||
  die "could not snapshot DNS hold evidence after the same-intent retry was scheduled"
wait_until 180 "the scheduled same-intent external-egress retry to execute" \
  dns_retry_query_observed_since_schedule ||
  die "the scheduled same-intent external-egress retry did not execute"
probe_new_hcc_ready_endpoint ||
  die "HCC lost readiness after a same-intent DNS retry (${HCC_READY_PROBE_DIAGNOSTIC:-HCC_READY_PROBE category=unknown})"
external_egress_policy_absent ||
  die "a held same-intent retry recreated the DNS policy without current resolution"
dns_has_not_released_since_hold ||
  die "the DNS blocker released before the retry revocation assertion"
ok "same-intent safety revoked the DNS policy while HCC stayed Ready and runtime stayed blocked"

release_dns_blocker || die "could not release the same-intent DNS query"
wait_until 30 "DNS blocker to answer the same-intent query" \
  dns_released_since_hold ||
  die "DNS blocker did not answer the same-intent query"
wait_until 120 "current TCP external-egress policy after same-intent DNS release" \
  external_egress_policy_converged_with_protocol "$INITIAL_EXTERNAL_EGRESS_PROTOCOL" ||
  die "the current TCP external-egress policy did not converge after DNS release"
wait_until 180 "same-intent runtime convergence after DNS release" \
  fixture_runtime_converged_with_protocol "$INITIAL_EXTERNAL_EGRESS_PROTOCOL" ||
  die "same-intent runtime did not converge after DNS release"

# Security phase: a protocol change invalidates the current TCP policy. The old
# TCP allow must be revoked even when DNS prevents constructing the UDP policy.
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null
wait_until 120 "same-intent HCC pod to stop" hcc_pods_absent ||
  die "same-intent HCC pod did not stop"
delete_fixture_runtime_leaving_dns_policy_for_safety ||
  die "could not remove the same-intent runtime before the divergent revision"
external_egress_policy_converged_with_protocol "$INITIAL_EXTERNAL_EGRESS_PROTOCOL" ||
  die "the current TCP policy disappeared before the divergent safety pass"
hold_dns_blocker || die "could not hold the divergent fixture DNS query"
DNS_RELEASE_COUNT_AT_HOLD="$(dns_release_count)" ||
  die "could not capture the DNS release baseline before the divergent revision"
egress_patch="$(jq -cn --arg dns "$TARGET_DNS" \
  '{spec:{egressBindings:[{dns:$dns,port:443,protocol:"UDP"}]}}')"
kctl patch mcpserver "$MCP_NAME" -n "$MCP_NS" --type=merge \
  -p "$egress_patch" >/dev/null
wait_until 60 "McpServer API to expose the revised UDP external-egress binding" \
  mcp_egress_binding_is_udp ||
  die "McpServer external-egress revision did not persist"

kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1 >/dev/null
wait_until 120 "replacement HCC pod to enter Running" capture_hcc ||
  die "replacement HCC pod did not start"
identity="$(kctl get pod "$NEW_HCC_POD" -n "$HCC_NS" \
  -o jsonpath='{.metadata.uid}{" "}{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}')"
read -r HCC_UID HCC_RESTARTS <<<"$identity"
[ -n "$HCC_UID" ] && [ -n "$HCC_RESTARTS" ] ||
  die "could not capture replacement HCC pod identity"

wait_until 120 "fixture external-egress DNS query to reach the hold proxy" \
  dns_hold_observed_since_arm ||
  die "NetworkPolicy safety convergence never reached the divergent DNS hold"
wait_until_fast 120 "HCC readiness after revoking the divergent stale policy" \
  hcc_ready_after_stale_policy_revoked ||
  die "HCC did not become globally ready after revoking the divergent stale policy (${HCC_READY_PROBE_DIAGNOSTIC:-HCC_READY_PROBE category=unknown})"
wait_until 30 "Kubernetes to corroborate HCC readiness during divergent DNS hold" \
  hcc_kubernetes_readiness_is_exact ||
  die "Kubernetes did not corroborate HCC readiness during divergent DNS hold"
dns_log_contains "holding DNS A ${TARGET_DNS}" ||
  die "DNS hold ended before the fail-closed revocation assertion"
if ! dns_has_not_released_since_hold; then
  die "DNS blocker released before the fail-closed revocation assertion"
fi
fixture_runtime_and_ready_absent ||
  die "fixture runtime or Ready status appeared while divergent DNS remained held"
external_egress_policy_absent ||
  die "a divergent external-egress policy survived the fail-closed revocation"
context_policies_absent ||
  die "Context policy existed before the Context watch update"
baseline_policies_unchanged ||
  die "baseline safety NetworkPolicy ownership or specs changed during safety convergence"
hcc_identity_is_stable ||
  die "HCC restarted while the MCP external-egress query was held"
wait_until_fast 30 "authoritative safety pass metrics to certify the revocation" \
  safety_pass_metrics_certify ||
  die "safety_pass_* metrics did not corroborate the stale-policy revocation (families renamed or pass never measured?)"
ok "/ready is 200 while the divergent stale policy and affected runtime remain absent"
ok "safety_pass_* metrics corroborate an authoritative pass revoked the stale policy"
ok "baseline NetworkPolicies remain present throughout fail-closed safety convergence"

initial_empty_context_log="[NetPol] Reconciling context \"${CONTEXT_ID}\" — allowed servers: []"
wait_until 120 "initial NetworkPolicy pass to reconcile the fixture's empty Context snapshot" \
  hcc_log_contains "$initial_empty_context_log" ||
  die "initial NetworkPolicy pass never reconciled the fixture's empty Context"
wait_until 120 "a real divergent external-egress retry to be scheduled" \
  external_egress_retry_progress_is_observed ||
  die "the held divergent refresh did not schedule a real retry"
DNS_HOLD_COUNT_AT_RETRY_SCHEDULE="$(dns_hold_count)" ||
  die "could not snapshot DNS hold evidence after the divergent retry was scheduled"
wait_until 180 "the scheduled divergent external-egress retry to execute" \
  dns_retry_query_observed_since_schedule ||
  die "the scheduled divergent external-egress retry did not execute"
context_policies_absent ||
  die "Context policy appeared before the isolated MODIFIED event"

context_patch="$(jq -cn --arg server "$MCP_NAME" '{spec:{mcpServers:[$server]}}')"
kctl patch context "$CONTEXT_NAME" -n "$MCP_NS" --type=merge \
  -p "$context_patch" >/dev/null
wait_until 60 "Context API to expose the latest server membership" context_watch_has_latest_spec ||
  die "Context update did not persist"
wait_until 60 "HCC Context watch to observe the update during the blocked fleet pass" \
  hcc_log_contains "Context watch event: MODIFIED for ${CONTEXT_NAME}" ||
  die "HCC did not observe the real Context update while initial MCP convergence was blocked"
wait_until 120 "all three latest-Context NetworkPolicies to converge during the MCP hold" \
  context_policies_converged ||
  die "Context policies remained blocked behind the held McpServer convergence"
fixture_runtime_and_ready_absent ||
  die "McpServer runtime or Ready status escaped the deterministic DNS hold boundary"
external_egress_policy_absent ||
  die "a divergent external-egress policy reappeared while DNS remained held"
dns_log_contains "holding DNS A ${TARGET_DNS}" ||
  die "DNS hold evidence disappeared before Context policy convergence"
if ! dns_has_not_released_since_hold; then
  die "DNS blocker released the McpServer query before the Context isolation assertion"
fi
probe_new_hcc_ready_endpoint ||
  die "HCC lost global readiness while the affected runtime remained safely blocked (${HCC_READY_PROBE_DIAGNOSTIC:-HCC_READY_PROBE category=unknown})"
hcc_kubernetes_readiness_is_exact ||
  die "Kubernetes lost HCC readiness during isolated Context convergence"
hcc_identity_is_stable ||
  die "HCC restarted while Context policies converged around the held MCP entity"
ok "the MODIFIED handler, not the initial empty-Context pass, converged all three policies"
ok "global readiness and Context progress continued while the affected runtime stayed blocked"

release_dns_blocker ||
  die "could not release the fixture DNS query"
wait_until 30 "DNS blocker to answer the held query" \
  dns_released_since_hold ||
  die "DNS blocker did not answer the held query"
wait_until 120 "current UDP external-egress policy after DNS release" \
  external_egress_policy_converged_with_protocol UDP ||
  die "the current UDP external-egress policy did not converge after DNS release"
probe_new_hcc_ready_endpoint ||
  die "HCC lost readiness while the released UDP policy converged (${HCC_READY_PROBE_DIAGNOSTIC:-HCC_READY_PROBE category=unknown})"
wait_until 300 "McpServer runtime, status, and latest Context NetworkPolicies to converge" \
  fixture_converged ||
  die "McpServer/Context/NetworkPolicy convergence did not complete after DNS release"
wait_until 300 "all peer MCP/Context runtimes to converge after releasing the held primary egress" \
  peer_fleet_converged ||
  die "peer MCP/Context fleet did not converge after the held primary egress was released"
hcc_identity_is_stable ||
  die "HCC restarted instead of completing the released background convergence"
final_probe="$(probe_hcc_final_context)" ||
  die "HCC final Context-scoped discovery did not expose the converged fixture"
echo "$final_probe" | jq -e \
  --arg fixture "$MCP_NAME" --arg context "$CONTEXT_NAME" '
    .readyStatus == 200 and .scopedDiscoveryStatus == 200 and
    .fixture == $fixture and .fixtureReady == true and .contextRef == $context
  ' >/dev/null ||
  die "HCC final probe returned an invalid result: ${final_probe}"
baseline_policies_unchanged ||
  die "baseline safety NetworkPolicy ownership or specs changed before final convergence"
ok "DNS release created the current UDP policy and affected runtime without gating HCC readiness"
ok "the full worker-width-crossing peer fleet converged after releasing the held primary egress"
ok "Context ingress, mcp-host egress, and rpc-proxy egress policies reflect the latest watch state"
ok "HCC stayed Ready through divergent revocation while the affected runtime remained fail-closed"

header "HCC McpServer/Context assertions complete; restoring branch-owned runtime"
