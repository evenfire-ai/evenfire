#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
shift || true
CONTEXT=""
RPC_PROXY_NAMESPACE="rpc-proxy"
HOST_NAMESPACE="mcp-host"
CONTROL_PLANE_NAMESPACE="control-plane"
TIMEOUT_SECONDS="120"
POLL_SECONDS="2"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEADLINE_RUNNER="${RPC_PROXY_EDGE_GATE_DEADLINE_RUNNER:-${SCRIPT_DIR}/run-with-deadline.mjs}"
PROTOCOL_LABEL='clerum.io/rpc-proxy-edge-protocol'
STRICT_PROTOCOL='signed-assertion-v1'

usage() {
  echo "usage: $0 {wait-proxy|wait-hosts-unsigned} --context NAME [options]" >&2
  echo "options: --rpc-proxy-namespace NAME --host-namespace NAME" >&2
  echo "         --control-plane-namespace NAME --timeout-seconds N --poll-seconds N" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="${2:?missing context}"; shift 2 ;;
    --rpc-proxy-namespace) RPC_PROXY_NAMESPACE="${2:?missing namespace}"; shift 2 ;;
    --host-namespace) HOST_NAMESPACE="${2:?missing namespace}"; shift 2 ;;
    --control-plane-namespace) CONTROL_PLANE_NAMESPACE="${2:?missing namespace}"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="${2:?missing timeout}"; shift 2 ;;
    --poll-seconds) POLL_SECONDS="${2:?missing poll interval}"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ "$MODE" != "wait-proxy" && "$MODE" != "wait-hosts-unsigned" ]] ||
   [[ -z "$CONTEXT" ]] ||
   ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
   (( TIMEOUT_SECONDS > 900 || POLL_SECONDS > TIMEOUT_SECONDS )); then
  usage
  exit 2
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))

remaining_deadline_seconds() {
  local remaining=$((deadline - SECONDS))
  (( remaining > 0 )) || return 1
  printf '%s\n' "$remaining"
}

bounded_kubectl_get() {
  local label="$1"
  shift
  local remaining
  remaining="$(remaining_deadline_seconds)" || return 1
  node "$DEADLINE_RUNNER" --timeout-seconds "$remaining" --heartbeat-seconds 1 \
    --kill-grace-seconds 1 --label "rpc-proxy-edge-${label}" -- \
    "$KUBECTL_BIN" --context="$CONTEXT" get "$@"
}

proxy_cohort_ready() {
  local deployment pods
  deployment="$(bounded_kubectl_get proxy-deployment deployment rpc-proxy \
    -n "$RPC_PROXY_NAMESPACE" -o json 2>/dev/null)" || return 1
  pods="$(bounded_kubectl_get proxy-pods pods -n "$RPC_PROXY_NAMESPACE" \
    -l app=rpc-proxy -o json 2>/dev/null)" || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg protocol "$STRICT_PROTOCOL" '
    (.spec.replicas // 1) as $desired |
    (.metadata.generation // 0) as $generation |
    ($desired > 0) and
    ((.status.observedGeneration // 0) >= $generation) and
    ((.status.updatedReplicas // 0) == $desired) and
    ((.status.readyReplicas // 0) == $desired) and
    ((.status.availableReplicas // 0) == $desired) and
    (.spec.template.metadata.labels[$label] == $protocol)
  ' <<<"$deployment" >/dev/null || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg protocol "$STRICT_PROTOCOL" \
    --argjson desired "$(jq -r '.spec.replicas // 1' <<<"$deployment")" '
      (.items | length) == $desired and
      all(.items[];
        .metadata.deletionTimestamp == null and
        .metadata.labels[$label] == $protocol and
        .status.phase == "Running" and
        any(.status.conditions[]?; .type == "Ready" and .status == "True")
      )
    ' <<<"$pods" >/dev/null
}

# Rollback gate: HCC has been rolled back to a revision that does not select
# signed-assertion-v1, and no HCC-managed Host Deployment or Host pod
# (terminating pods included) still carries it. Only then may the RPC Proxy
# roll back to an image that does not forward the edge assertion.
host_cohort_unsigned() {
  local hcc hcc_pods deployments managed_pods strict_pods
  hcc="$(bounded_kubectl_get host-hcc-deployment deployment host-context-controller \
    -n "$CONTROL_PLANE_NAMESPACE" -o json 2>/dev/null)" || return 1
  hcc_pods="$(bounded_kubectl_get host-hcc-pods pods \
    -n "$CONTROL_PLANE_NAMESPACE" -l app=host-context-controller -o json 2>/dev/null)" || return 1
  deployments="$(bounded_kubectl_get host-deployments deployments \
    -n "$HOST_NAMESPACE" -l clerum.io/managed-by=host-context-controller \
    -o json 2>/dev/null)" || return 1
  managed_pods="$(bounded_kubectl_get host-managed-pods pods \
    -n "$HOST_NAMESPACE" -l clerum.io/managed-by=host-context-controller \
    -o json 2>/dev/null)" || return 1
  strict_pods="$(bounded_kubectl_get host-strict-pods pods -n "$HOST_NAMESPACE" \
    -l "$PROTOCOL_LABEL=$STRICT_PROTOCOL" -o json 2>/dev/null)" || return 1
  jq -e --arg protocolKey 'CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL' \
    --arg markerKey 'clerum.io/host-runtime-edge-protocol' --arg strict "$STRICT_PROTOCOL" '
    (.spec.replicas // 1) as $desired |
    (.metadata.generation // 0) as $generation |
    ($desired > 0) and
    ((.status.observedGeneration // 0) >= $generation) and
    ((.status.updatedReplicas // 0) == $desired) and
    ((.status.readyReplicas // 0) == $desired) and
    ((.status.availableReplicas // 0) == $desired) and
    (((.spec.template.metadata.labels // {}) as $labels |
      ((($labels | has($markerKey)) | not) or $labels[$markerKey] != $strict))) and
    ([.spec.template.spec.containers[]?.env[]?
      | select(.name == $protocolKey)
      | .value] |
      (length <= 1) and (length == 0 or .[0] != $strict))
  ' <<<"$hcc" >/dev/null || return 1
  jq -e --arg markerKey 'clerum.io/host-runtime-edge-protocol' --arg strict "$STRICT_PROTOCOL" \
    --argjson desired "$(jq -r '.spec.replicas // 1' <<<"$hcc")" '
    (.items | length) == $desired and
    all(.items[];
      .metadata.deletionTimestamp == null and
      .status.phase == "Running" and
      any(.status.conditions[]?; .type == "Ready" and .status == "True") and
      (((.metadata.labels // {}) as $labels |
        ((($labels | has($markerKey)) | not) or $labels[$markerKey] != $strict)))
    )
  ' <<<"$hcc_pods" >/dev/null || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg strict "$STRICT_PROTOCOL" '
    all(.items[];
      (.spec.replicas // 1) as $desired |
      (.metadata.generation // 0) as $generation |
      ((.status.observedGeneration // 0) >= $generation) and
      ((.status.updatedReplicas // 0) == $desired) and
      ((.status.readyReplicas // 0) == $desired) and
      ((.status.availableReplicas // 0) == $desired) and
      (((.spec.template.metadata.labels // {}) as $labels |
        ((($labels | has($label)) | not) or $labels[$label] != $strict)))
    )
  ' <<<"$deployments" >/dev/null || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg strict "$STRICT_PROTOCOL" '
    all(.items[];
      .metadata.deletionTimestamp == null and
      .status.phase == "Running" and
      any(.status.conditions[]?; .type == "Ready" and .status == "True") and
      (((.metadata.labels // {}) as $labels |
        ((($labels | has($label)) | not) or $labels[$label] != $strict)))
    )
  ' <<<"$managed_pods" >/dev/null || return 1
  jq -e '.items | length == 0' <<<"$strict_pods" >/dev/null
}

while (( SECONDS <= deadline )); do
  if [[ "$MODE" == "wait-proxy" ]] && proxy_cohort_ready; then
    echo "RPC Proxy signed-assertion cohort is fully Ready in $RPC_PROXY_NAMESPACE"
    exit 0
  fi
  if [[ "$MODE" == "wait-hosts-unsigned" ]] && host_cohort_unsigned; then
    echo "HCC and MCP Host cohort no longer selects signed-assertion-v1 and is fully Ready"
    exit 0
  fi
  if (( SECONDS >= deadline )); then break; fi
  sleep "$POLL_SECONDS"
done

if [[ "$MODE" == "wait-proxy" ]]; then
  echo "ERROR: RPC Proxy cohort did not reach the strict authenticated protocol within ${TIMEOUT_SECONDS}s" >&2
else
  echo "ERROR: signed-assertion MCP Host workloads remain or the rolled-back HCC/Host cohort is not Ready within ${TIMEOUT_SECONDS}s" >&2
fi
exit 1
