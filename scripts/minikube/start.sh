#!/usr/bin/env bash
# Start a Clerum minikube profile. Single-node is the default; multi-node is
# opt-in via MINIKUBE_MULTI_NODE=true or MINIKUBE_NODES=<n>.

set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
MINIKUBE_MULTI_NODE="${MINIKUBE_MULTI_NODE:-false}"
MINIKUBE_NODES="${MINIKUBE_NODES:-}"
MINIKUBE_MEMORY="${MINIKUBE_MEMORY:-10240}"
MINIKUBE_CPUS="${MINIKUBE_CPUS:-6}"
VALIDATE_ONLY=false
KC=(kubectl --context="${PROFILE}")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[MINIKUBE]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*"; }

is_true() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes|y|Y|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validate-only)
      VALIDATE_ONLY=true
      shift
      ;;
    *)
      err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "${MINIKUBE_NODES}" ]]; then
  if is_true "${MINIKUBE_MULTI_NODE}"; then
    MINIKUBE_NODES=2
  else
    MINIKUBE_NODES=1
  fi
fi

if ! [[ "${MINIKUBE_NODES}" =~ ^[0-9]+$ ]] || [[ "${MINIKUBE_NODES}" -lt 1 ]]; then
  err "MINIKUBE_NODES must be a positive integer; got '${MINIKUBE_NODES}'"
  exit 1
fi

if is_true "${MINIKUBE_MULTI_NODE}" && [[ "${MINIKUBE_NODES}" -lt 2 ]]; then
  err "MINIKUBE_MULTI_NODE=true requires MINIKUBE_NODES>=2"
  exit 1
fi

if [[ "${MINIKUBE_NODES}" -gt 1 ]]; then
  MINIKUBE_MULTI_NODE=true
fi

wait_for_ready_nodes() {
  local expected="$1"
  local ready

  for _ in $(seq 1 60); do
    ready="$("${KC[@]}" get nodes --no-headers 2>/dev/null \
      | awk '$2 == "Ready" { count++ } END { print count + 0 }')"
    if [[ "${ready}" -ge "${expected}" ]]; then
      ok "${ready} Ready node(s) available"
      return 0
    fi
    sleep 2
  done

  err "Timed out waiting for ${expected} Ready node(s)"
  "${KC[@]}" get nodes -o wide || true
  return 1
}

ensure_storage_addons() {
  log "Ensuring minikube storage addons are enabled"
  minikube -p "${PROFILE}" addons enable default-storageclass >/dev/null
  minikube -p "${PROFILE}" addons enable storage-provisioner >/dev/null

  for _ in $(seq 1 30); do
    if "${KC[@]}" get storageclass standard >/dev/null 2>&1; then
      ok "StorageClass standard is available"
      break
    fi
    sleep 2
  done

  if ! "${KC[@]}" get storageclass standard >/dev/null 2>&1; then
    err "StorageClass standard is not available after enabling minikube addons"
    "${KC[@]}" get storageclass || true
    return 1
  fi

  for _ in $(seq 1 30); do
    if "${KC[@]}" -n kube-system get pod storage-provisioner >/dev/null 2>&1; then
      "${KC[@]}" -n kube-system wait pod/storage-provisioner \
        --for=condition=Ready \
        --timeout=120s >/dev/null
      ok "storage-provisioner pod is Ready"
      return 0
    fi
    sleep 2
  done

  err "storage-provisioner pod did not appear after enabling the addon"
  "${KC[@]}" -n kube-system get pods -o wide || true
  return 1
}

ensure_calico_ready() {
  local calico_count
  calico_count="$("${KC[@]}" -n kube-system get pods -l k8s-app=calico-node --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${calico_count}" -gt 0 ]]; then
    "${KC[@]}" -n kube-system wait pod -l k8s-app=calico-node \
      --for=condition=Ready \
      --timeout=180s >/dev/null
    ok "Calico node pods are Ready"
  else
    err "Calico node pods not found; NetworkPolicy-backed gates require Calico"
    return 1
  fi
}

start_args=(
  start
  -p "${PROFILE}"
  --memory="${MINIKUBE_MEMORY}"
  --cpus="${MINIKUBE_CPUS}"
  --cni=calico
  --driver=docker
)

if [[ "${MINIKUBE_NODES}" -gt 1 ]]; then
  start_args+=(--nodes="${MINIKUBE_NODES}")
  if [[ "${VALIDATE_ONLY}" == "true" ]]; then
    log "Validating multi-node minikube profile '${PROFILE}' with ${MINIKUBE_NODES} expected nodes"
  else
    log "Starting multi-node minikube profile '${PROFILE}' with ${MINIKUBE_NODES} nodes"
  fi
else
  if [[ "${VALIDATE_ONLY}" == "true" ]]; then
    log "Validating single-node minikube profile '${PROFILE}'"
  else
    log "Starting single-node minikube profile '${PROFILE}'"
  fi
fi

if [[ "${VALIDATE_ONLY}" != "true" ]]; then
  minikube "${start_args[@]}"
fi

if [[ "${MINIKUBE_NODES}" -gt 1 ]]; then
  wait_for_ready_nodes "${MINIKUBE_NODES}"
else
  wait_for_ready_nodes 1
fi

ensure_storage_addons
ensure_calico_ready

if ! minikube -p "${PROFILE}" status >/dev/null; then
  err "Native minikube status failed for '${PROFILE}'"
  minikube -p "${PROFILE}" status || true
  exit 1
fi

ok "Minikube profile '${PROFILE}' is healthy"
