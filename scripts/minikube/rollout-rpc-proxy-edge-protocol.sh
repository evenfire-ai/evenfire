#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
shift || true
CONTEXT=""
PROXY_NAMESPACE="rpc-proxy"
HOST_NAMESPACE="mcp-host"
CONTROL_PLANE_NAMESPACE="control-plane"
TIMEOUT_SECONDS="120"
RESTART_PROXY=false
RESTART_HCC=false
RESTART_ALL_HOSTS=false
RESTART_ALL_NON_EDGE=false
HOST_DEPLOYMENTS=()
HCC_REVISION=""
PROXY_REVISION=""
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${SCRIPT_DIR}/rpc-proxy-edge-rollout-gate.sh"

usage() {
  echo "usage: $0 {restart-targets|rollback-proxy} --context NAME [options]" >&2
  echo "restart options: --restart-proxy --restart-hcc --restart-host NAME" >&2
  echo "                 --restart-all-hosts --restart-all-non-edge" >&2
  echo "rollback options: --to-hcc-revision N --to-proxy-revision N" >&2
  echo "common: --timeout-seconds N" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="${2:?missing context}"; shift 2 ;;
    --rpc-proxy-namespace) PROXY_NAMESPACE="${2:?missing namespace}"; shift 2 ;;
    --host-namespace) HOST_NAMESPACE="${2:?missing namespace}"; shift 2 ;;
    --control-plane-namespace) CONTROL_PLANE_NAMESPACE="${2:?missing namespace}"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="${2:?missing timeout}"; shift 2 ;;
    --to-hcc-revision) HCC_REVISION="${2:?missing HCC revision}"; shift 2 ;;
    --to-proxy-revision) PROXY_REVISION="${2:?missing RPC Proxy revision}"; shift 2 ;;
    --restart-proxy) RESTART_PROXY=true; shift ;;
    --restart-hcc) RESTART_HCC=true; shift ;;
    --restart-all-hosts) RESTART_ALL_HOSTS=true; shift ;;
    --restart-all-non-edge) RESTART_ALL_NON_EDGE=true; shift ;;
    --restart-host) HOST_DEPLOYMENTS+=("${2:?missing Host Deployment}"); shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ ("$MODE" != "restart-targets" && "$MODE" != "rollback-proxy" &&
      "$MODE" != "preflight") ]] || [[ -z "$CONTEXT" ]] ||
   ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || (( TIMEOUT_SECONDS > 900 )); then
  usage
  exit 2
fi

if [[ "$MODE" == "rollback-proxy" ]] &&
   { ! [[ "$HCC_REVISION" =~ ^[1-9][0-9]*$ ]] || ! [[ "$PROXY_REVISION" =~ ^[1-9][0-9]*$ ]]; }; then
  usage
  exit 2
fi

KC=("$KUBECTL_BIN" "--context=$CONTEXT")
GATE_ARGS=(--context "$CONTEXT" --rpc-proxy-namespace "$PROXY_NAMESPACE"
  --host-namespace "$HOST_NAMESPACE" --control-plane-namespace "$CONTROL_PLANE_NAMESPACE"
  --timeout-seconds "$TIMEOUT_SECONDS" --poll-seconds 1)

restart_and_wait() {
  local namespace="$1" deployment="$2"
  "${KC[@]}" rollout restart "deployment/$deployment" -n "$namespace" >/dev/null
  "${KC[@]}" rollout status "deployment/$deployment" -n "$namespace" \
    --timeout="${TIMEOUT_SECONDS}s" >/dev/null
}

restart_all_non_edge() {
  local namespace deployment names
  for namespace in control-plane mcp-host mcp-server profiles rpc-proxy channels; do
    names="$("${KC[@]}" get deployments -n "$namespace" \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"
    while IFS= read -r deployment; do
      [[ -n "$deployment" ]] || continue
      [[ "$namespace/$deployment" != "control-plane/host-context-controller" ]] || continue
      [[ "$namespace/$deployment" != "rpc-proxy/rpc-proxy" ]] || continue
      [[ "$namespace" != "mcp-host" ]] || continue
      restart_and_wait "$namespace" "$deployment"
    done <<<"$names"
  done
}

restart_host() {
  local deployment="$1"
  restart_and_wait "$HOST_NAMESPACE" "$deployment"
}

restart_host_targets() {
  local deployment
  if [[ "$RESTART_ALL_HOSTS" == true ]]; then
    while IFS= read -r deployment; do
      [[ -n "$deployment" ]] && restart_host "$deployment"
    done < <("${KC[@]}" get deployments -n "$HOST_NAMESPACE" \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
  else
    for deployment in "${HOST_DEPLOYMENTS[@]}"; do
      restart_host "$deployment"
    done
  fi
}

wait_proxy() {
  bash "$GATE" wait-proxy "${GATE_ARGS[@]}"
}

wait_proxy_legacy() {
  bash "$GATE" wait-proxy-legacy "${GATE_ARGS[@]}"
}

wait_hosts_legacy() {
  bash "$GATE" wait-hosts-legacy "${GATE_ARGS[@]}"
}

no_existing_edge_workloads() {
  local namespace namespace_result deployments pods
  for namespace in "$PROXY_NAMESPACE" "$HOST_NAMESPACE"; do
    if ! namespace_result="$("${KC[@]}" get namespace "$namespace" \
      -o name --request-timeout="${TIMEOUT_SECONDS}s" 2>&1)"; then
      if [[ "$namespace_result" == *"namespaces \"$namespace\" not found"* ]]; then
        continue
      fi
      echo "ERROR: unable to inspect $namespace before credential preparation" >&2
      return 1
    fi

    if [[ "$namespace" == "$PROXY_NAMESPACE" ]]; then
      if ! deployments="$("${KC[@]}" get deployments -n "$namespace" -l app=rpc-proxy \
        -o json --request-timeout="${TIMEOUT_SECONDS}s" 2>&1)" ||
         ! pods="$("${KC[@]}" get pods -n "$namespace" -l app=rpc-proxy \
        -o json --request-timeout="${TIMEOUT_SECONDS}s" 2>&1)"; then
        echo "ERROR: unable to inspect the RPC Proxy cohort before credential preparation" >&2
        return 1
      fi
    else
      if ! deployments="$("${KC[@]}" get deployments -n "$namespace" \
        -l clerum.io/managed-by=host-context-controller -o json \
        --request-timeout="${TIMEOUT_SECONDS}s" 2>&1)" ||
         ! pods="$("${KC[@]}" get pods -n "$namespace" \
        -l clerum.io/managed-by=host-context-controller -o json \
        --request-timeout="${TIMEOUT_SECONDS}s" 2>&1)"; then
        echo "ERROR: unable to inspect the managed Host cohort before credential preparation" >&2
        return 1
      fi
    fi

    if ! jq -e '.items | length == 0' <<<"$deployments" >/dev/null ||
       ! jq -e '.items | length == 0' <<<"$pods" >/dev/null; then
      echo "ERROR: HCC is absent while an RPC Proxy or managed Host workload exists" >&2
      return 1
    fi
  done
}

if [[ "$MODE" == "rollback-proxy" ]]; then
  # Roll back HCC first. Its selected Deployment revision owns the compatible
  # Host image/protocol and reconciles the Host fleet before the Proxy changes.
  "${KC[@]}" rollout undo deployment/host-context-controller -n "$CONTROL_PLANE_NAMESPACE" \
    --to-revision="$HCC_REVISION" >/dev/null
  "${KC[@]}" rollout status deployment/host-context-controller -n "$CONTROL_PLANE_NAMESPACE" \
    --timeout="${TIMEOUT_SECONDS}s" >/dev/null
  wait_hosts_legacy
  "${KC[@]}" rollout undo deployment/rpc-proxy -n "$PROXY_NAMESPACE" \
    --to-revision="$PROXY_REVISION" >/dev/null
  "${KC[@]}" rollout status deployment/rpc-proxy -n "$PROXY_NAMESPACE" \
    --timeout="${TIMEOUT_SECONDS}s" >/dev/null
  bash "$GATE" wait-proxy-legacy "${GATE_ARGS[@]}"
  exit 0
fi

if ! hcc_json="$("${KC[@]}" get deployment host-context-controller \
  -n "$CONTROL_PLANE_NAMESPACE" -o json --request-timeout="${TIMEOUT_SECONDS}s" 2>&1)"; then
  if [[ "$MODE" == "preflight" &&
        ( "$hcc_json" == *'deployments.apps "host-context-controller" not found'* ||
          "$hcc_json" == *"namespaces \"$CONTROL_PLANE_NAMESPACE\" not found"* ) ]]; then
    if no_existing_edge_workloads; then
      echo "No HCC or edge workloads exist; cold-start credential preflight passed"
      exit 0
    fi
    exit 1
  fi
  echo "ERROR: unable to inspect HCC edge protocol before credential preparation" >&2
  exit 1
fi

if ! jq -e '.spec.template.spec.containers | type == "array" and length > 0' \
  <<<"$hcc_json" >/dev/null; then
  echo "ERROR: HCC deployment has no usable container specification" >&2
  exit 1
fi

hcc_selectors="$(jq -c '[.spec.template.spec.containers[]?.env[]? |
  select(.name == "CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL")]' <<<"$hcc_json")"
hcc_selector_count="$(jq -r 'length' <<<"$hcc_selectors")"
hcc_selector_missing=false
if [[ "$hcc_selector_count" == "0" ]]; then
  hcc_selector_missing=true
  hcc_protocol="legacy-headers"
else
  if ! hcc_protocol="$(jq -er '
    if length == 1 and (.[0].value | type == "string") and
       (.[0] | has("valueFrom") | not)
    then .[0].value
    else error("protocol selector must be one explicit string value") end
  ' <<<"$hcc_selectors")"; then
    echo "ERROR: malformed, contradictory, or multiple HCC Host edge protocol selectors" >&2
    exit 1
  fi
fi
if [[ "$hcc_protocol" != "dedicated-header-v1" && "$hcc_protocol" != "legacy-headers" ]]; then
  echo "ERROR: unsupported HCC Host edge protocol selector" >&2
  exit 1
fi

if [[ "$MODE" == "preflight" ]]; then
  if ! jq -e '
    (.spec.replicas // 1) as $desired |
    (.metadata.generation // 0) as $generation |
    ($desired > 0) and
    ((.status.observedGeneration // 0) >= $generation) and
    ((.status.updatedReplicas // 0) == $desired) and
    ((.status.readyReplicas // 0) == $desired) and
    ((.status.availableReplicas // 0) == $desired)
  ' <<<"$hcc_json" >/dev/null; then
    echo "ERROR: existing HCC deployment is not Ready for credential preparation" >&2
    exit 1
  fi

  if [[ "$hcc_protocol" == "legacy-headers" ]]; then
    if ! wait_hosts_legacy || ! wait_proxy_legacy; then
      echo "ERROR: HCC legacy selector is not backed by a Ready legacy Proxy and Host cohort" >&2
      exit 1
    fi
    if [[ "$hcc_selector_missing" == true ]]; then
      echo "Credential preflight accepted the supported pre-selector legacy HCC cohort"
    else
      echo "Credential preflight accepted the explicit legacy HCC cohort"
    fi
    exit 0
  fi

  if ! wait_proxy; then
    echo "ERROR: strict HCC selection requires a Ready dedicated-header RPC Proxy cohort" >&2
    exit 1
  fi
  proxy_secret="$("${KC[@]}" get secret rpc-proxy-secrets -n "$PROXY_NAMESPACE" \
    -o json --request-timeout="${TIMEOUT_SECONDS}s" 2>/dev/null)" || {
    echo "ERROR: strict HCC selection requires the RPC Proxy edge credential Secret" >&2
    exit 1
  }
  host_secret="$("${KC[@]}" get secret rpc-proxy-edge-credentials -n "$HOST_NAMESPACE" \
    -o json --request-timeout="${TIMEOUT_SECONDS}s" 2>/dev/null)" || {
    echo "ERROR: strict HCC selection requires the managed Host edge credential Secret" >&2
    exit 1
  }
  proxy_edge_encoded="$(jq -er '.data.RPC_PROXY_MCP_HOST_EDGE_TOKEN |
    select(type == "string" and length > 0)' <<<"$proxy_secret")" || {
    echo "ERROR: strict HCC selection requires the RPC Proxy edge credential key" >&2
    exit 1
  }
  host_edge_encoded="$(jq -er '.data.RPC_PROXY_MCP_HOST_EDGE_TOKEN |
    select(type == "string" and length > 0)' <<<"$host_secret")" || {
    echo "ERROR: strict HCC selection requires the managed Host edge credential key" >&2
    exit 1
  }
  if [[ "$proxy_edge_encoded" != "$host_edge_encoded" ]]; then
    echo "ERROR: strict HCC selection requires matching RPC Proxy and Host credentials" >&2
    exit 1
  fi
  proxy_edge_value="$(printf '%s' "$proxy_edge_encoded" | base64 --decode 2>/dev/null)" || {
    echo "ERROR: strict HCC selection requires a valid RPC Proxy edge credential" >&2
    exit 1
  }
  if [[ "$proxy_edge_value" == replace-with-* ||
        ${#proxy_edge_value} -lt 16 || ${#proxy_edge_value} -gt 4096 ]]; then
    echo "ERROR: strict HCC selection requires a usable RPC Proxy edge credential" >&2
    exit 1
  fi
  echo "Credential preflight accepted the explicit strict HCC cohort and matching credentials"
  exit 0
fi

# A selector-free Deployment predates the explicit protocol field. Treat it as
# legacy only after both live cohorts prove the supported compatible state.
# This read-only check must finish before any coordinator restart begins.
if [[ "$hcc_selector_missing" == true ]]; then
  if ! wait_hosts_legacy || ! wait_proxy_legacy; then
    echo "ERROR: selector-free HCC is not backed by a Ready legacy Proxy and Host cohort" >&2
    exit 1
  fi
fi

if [[ "$RESTART_ALL_NON_EDGE" == true ]]; then
  restart_all_non_edge
fi

if [[ "$hcc_protocol" == "dedicated-header-v1" ]]; then
  # Strict Hosts are only advanced after the complete new Proxy cohort is
  # observed. HCC also checks this condition at each Host Deployment write.
  if [[ "$RESTART_PROXY" == true ]]; then
    restart_and_wait "$PROXY_NAMESPACE" rpc-proxy
  fi
  wait_proxy
  if [[ "$RESTART_HCC" == true ]]; then
    restart_and_wait "$CONTROL_PLANE_NAMESPACE" host-context-controller
  fi
  restart_host_targets
else
  # Rollback is the reverse: all HCC-managed Hosts must be compatible before
  # an old Proxy producer can serve again.
  if [[ "$RESTART_HCC" == true ]]; then
    restart_and_wait "$CONTROL_PLANE_NAMESPACE" host-context-controller
  fi
  restart_host_targets
  if [[ "$RESTART_PROXY" == true ]]; then
    wait_hosts_legacy
    restart_and_wait "$PROXY_NAMESPACE" rpc-proxy
  fi
fi
