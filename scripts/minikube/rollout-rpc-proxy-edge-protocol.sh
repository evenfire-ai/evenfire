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
    --restart-host) HOST_DEPLOYMENTS+=("${2:?missing Host Deployment}"); shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ ("$MODE" != "restart-targets" && "$MODE" != "rollback-proxy") ]] || [[ -z "$CONTEXT" ]] ||
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
  --timeout-seconds "$TIMEOUT_SECONDS")

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

wait_hosts_legacy() {
  bash "$GATE" wait-hosts-legacy "${GATE_ARGS[@]}"
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

hcc_protocol="$("${KC[@]}" get deployment host-context-controller -n "$CONTROL_PLANE_NAMESPACE" \
  -o json | jq -er '
    [.spec.template.spec.containers[]?.env[]? |
      select(.name == "CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL") | .value] |
      if length == 1 then .[0] else error("protocol selector must be explicit") end
  ')"
if [[ "$hcc_protocol" != "dedicated-header-v1" && "$hcc_protocol" != "legacy-headers" ]]; then
  echo "ERROR: unsupported or missing HCC Host edge protocol selector" >&2
  exit 1
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
