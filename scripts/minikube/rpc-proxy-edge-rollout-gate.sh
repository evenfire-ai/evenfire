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
PROTOCOL_LABEL='clerum.io/rpc-proxy-edge-protocol'
STRICT_PROTOCOL='dedicated-header-v1'

usage() {
  echo "usage: $0 {wait-proxy|wait-proxy-legacy|wait-hosts-legacy} --context NAME [options]" >&2
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

if [[ "$MODE" != "wait-proxy" && "$MODE" != "wait-proxy-legacy" &&
      "$MODE" != "wait-hosts-legacy" ]] ||
   [[ -z "$CONTEXT" ]] ||
   ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
   ! [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] ||
   (( TIMEOUT_SECONDS > 900 || POLL_SECONDS > TIMEOUT_SECONDS )); then
  usage
  exit 2
fi

proxy_cohort_ready() {
  local deployment pods
  deployment="$("$KUBECTL_BIN" --context="$CONTEXT" get deployment rpc-proxy \
    -n "$RPC_PROXY_NAMESPACE" -o json 2>/dev/null)" || return 1
  pods="$("$KUBECTL_BIN" --context="$CONTEXT" get pods -n "$RPC_PROXY_NAMESPACE" \
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

proxy_cohort_legacy() {
  local deployment pods
  deployment="$("$KUBECTL_BIN" --context="$CONTEXT" get deployment rpc-proxy \
    -n "$RPC_PROXY_NAMESPACE" -o json 2>/dev/null)" || return 1
  pods="$("$KUBECTL_BIN" --context="$CONTEXT" get pods -n "$RPC_PROXY_NAMESPACE" \
    -l app=rpc-proxy -o json 2>/dev/null)" || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg protocol "$STRICT_PROTOCOL" '
    (.spec.replicas // 1) as $desired |
    (.metadata.generation // 0) as $generation |
    ($desired > 0) and
    ((.status.observedGeneration // 0) >= $generation) and
    ((.status.updatedReplicas // 0) == $desired) and
    ((.status.readyReplicas // 0) == $desired) and
    ((.status.availableReplicas // 0) == $desired) and
    (.spec.template.metadata.labels[$label] != $protocol)
  ' <<<"$deployment" >/dev/null || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg protocol "$STRICT_PROTOCOL" \
    --argjson desired "$(jq -r '.spec.replicas // 1' <<<"$deployment")" '
      (.items | length) == $desired and
      all(.items[];
        .metadata.deletionTimestamp == null and
        .metadata.labels[$label] != $protocol and
        .status.phase == "Running" and
        any(.status.conditions[]?; .type == "Ready" and .status == "True")
      )
    ' <<<"$pods" >/dev/null
}

host_cohort_legacy() {
  local hcc hcc_pods deployments strict_pods
  hcc="$("$KUBECTL_BIN" --context="$CONTEXT" get deployment host-context-controller \
    -n "$CONTROL_PLANE_NAMESPACE" -o json 2>/dev/null)" || return 1
  hcc_pods="$("$KUBECTL_BIN" --context="$CONTEXT" get pods \
    -n "$CONTROL_PLANE_NAMESPACE" -l app=host-context-controller -o json 2>/dev/null)" || return 1
  deployments="$("$KUBECTL_BIN" --context="$CONTEXT" get deployments \
    -n "$HOST_NAMESPACE" -l clerum.io/managed-by=host-context-controller \
    -o json 2>/dev/null)" || return 1
  strict_pods="$("$KUBECTL_BIN" --context="$CONTEXT" get pods -n "$HOST_NAMESPACE" \
    -l "$PROTOCOL_LABEL=$STRICT_PROTOCOL" -o json 2>/dev/null)" || return 1
  jq -e --arg protocolKey 'CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL' \
    --arg markerKey 'clerum.io/host-runtime-edge-protocol' \
    --arg strict "$STRICT_PROTOCOL" '
    (.spec.replicas // 1) as $desired |
    (.metadata.generation // 0) as $generation |
    ($desired > 0) and
    ((.status.observedGeneration // 0) >= $generation) and
    ((.status.updatedReplicas // 0) == $desired) and
    ((.status.readyReplicas // 0) == $desired) and
    ((.status.availableReplicas // 0) == $desired) and
    (.spec.template.metadata.labels[$markerKey] != $strict) and
    ([.spec.template.spec.containers[]?.env[]?
      | select(.name == $protocolKey)
      | .value] |
      (length <= 1) and (length == 0 or .[0] == "legacy-headers"))
  ' <<<"$hcc" >/dev/null || return 1
  jq -e --argjson desired "$(jq -r '.spec.replicas // 1' <<<"$hcc")" '
    (.items | length) == $desired and
    all(.items[];
      .metadata.deletionTimestamp == null and
      .status.phase == "Running" and
      any(.status.conditions[]?; .type == "Ready" and .status == "True")
    )
  ' <<<"$hcc_pods" >/dev/null || return 1
  jq -e --arg label "$PROTOCOL_LABEL" --arg protocol "$STRICT_PROTOCOL" '
    all(.items[];
      (.spec.replicas // 1) as $desired |
      (.metadata.generation // 0) as $generation |
      ((.status.observedGeneration // 0) >= $generation) and
      ((.status.updatedReplicas // 0) == $desired) and
      ((.status.readyReplicas // 0) == $desired) and
      ((.status.availableReplicas // 0) == $desired) and
      (.spec.template.metadata.labels[$label] != $protocol)
    )
  ' <<<"$deployments" >/dev/null || return 1
  jq -e '.items | length == 0' <<<"$strict_pods" >/dev/null
}

deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS <= deadline )); do
  if [[ "$MODE" == "wait-proxy" ]] && proxy_cohort_ready; then
    echo "RPC Proxy dedicated-header cohort is fully Ready in $RPC_PROXY_NAMESPACE"
    exit 0
  fi
  if [[ "$MODE" == "wait-proxy-legacy" ]] && proxy_cohort_legacy; then
    echo "RPC Proxy legacy-compatible cohort is fully Ready in $RPC_PROXY_NAMESPACE"
    exit 0
  fi
  if [[ "$MODE" == "wait-hosts-legacy" ]] && host_cohort_legacy; then
    echo "HCC and MCP Host legacy-compatible cohort is fully Ready"
    exit 0
  fi
  if (( SECONDS >= deadline )); then break; fi
  sleep "$POLL_SECONDS"
done

if [[ "$MODE" == "wait-proxy" ]]; then
  echo "ERROR: RPC Proxy cohort did not reach the strict authenticated protocol within ${TIMEOUT_SECONDS}s" >&2
elif [[ "$MODE" == "wait-proxy-legacy" ]]; then
  echo "ERROR: RPC Proxy legacy-compatible cohort did not become fully Ready within ${TIMEOUT_SECONDS}s" >&2
else
  echo "ERROR: strict MCP Host workloads remain or legacy HCC/Host cohort is not Ready within ${TIMEOUT_SECONDS}s" >&2
fi
exit 1
