#!/usr/bin/env bash
set -euo pipefail

PROFILE="clerum-test"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      PROFILE="${2:-}"
      shift 2
      ;;
    --context=*)
      PROFILE="${1#--context=}"
      shift
      ;;
    -h|--help)
      echo "Usage: scripts/minikube/sync-auth-key.sh [--context <kubectl-context>]" >&2
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

KCTL=(kubectl --context="${PROFILE}")
SOURCE_SECRET="rpc-proxy-secrets"
SOURCE_NAMESPACE="rpc-proxy"
CONFIGMAP="mcp-host-config"
CONFIG_NAMESPACE="mcp-host"
SOURCE_KEY="RPC_PROXY_JWT_PUBLIC_KEY"
TARGET_KEY="CLERUM_AUTH_JWT_PUBLIC_KEY"
MCP_HOST_ROLLOUT_TIMEOUT="180s"

# gfsc verifies gfs access tokens with the SAME platform public key (open core
# reuses one keypair). gfsc fails closed without it (empty key ⇒ no read serving),
# so the key must be synced into gfs-config exactly like mcp-host-config.
GFS_CONFIGMAP="gfs-config"
GFS_NAMESPACE="gfs"
GFS_TARGET_KEY="jwt-public-key"
GFS_DEPLOY_SELECTOR="clerum.io/managed-by=host-context-controller"

log() { printf '[sync-auth-key] %s\n' "$*"; }

rollout_restart_with_retry() {
  local deployment="$1"
  local attempt
  local output

  for attempt in 1 2 3; do
    if output="$("${KCTL[@]}" rollout restart "deployment/${deployment}" -n "${CONFIG_NAMESPACE}" 2>&1)"; then
      [[ -n "${output}" ]] && printf '%s\n' "${output}"
      return 0
    fi

    if [[ "${output}" == *"within the past second"* && "${attempt}" != "3" ]]; then
      log "Retrying rollout restart for ${CONFIG_NAMESPACE}/${deployment} after recent restart" >&2
      sleep 2
      continue
    fi

    printf '%s\n' "${output}" >&2
    return 1
  done
}

# Build a merge patch that sets one ConfigMap data key to a value.
make_patch() {
  SOURCE_VALUE="$1" TARGET_KEY="$2" python3 - <<'PY'
import json
import os

print(json.dumps({"data": {os.environ["TARGET_KEY"]: os.environ["SOURCE_VALUE"]}}))
PY
}

# The public key is the SAME for every consumer (one platform keypair), so it is
# fetched once and synced into each consumer's ConfigMap below.
if ! "${KCTL[@]}" get secret "${SOURCE_SECRET}" -n "${SOURCE_NAMESPACE}" >/dev/null 2>&1; then
  log "Skipping auth key sync (${SOURCE_SECRET} not found)"
  exit 0
fi
source_key="$("${KCTL[@]}" get secret "${SOURCE_SECRET}" -n "${SOURCE_NAMESPACE}" -o "jsonpath={.data.${SOURCE_KEY}}" | base64 -d)"

# ── Target 1: mcp-host-config (restart named chatllm/mcp-host with retry) ──────
sync_mcp_host() {
  if ! "${KCTL[@]}" get configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" >/dev/null 2>&1; then
    log "Skipping ${CONFIGMAP} sync (not found)"
    return 0
  fi
  local current_key
  current_key="$("${KCTL[@]}" get configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" -o "jsonpath={.data.${TARGET_KEY}}" 2>/dev/null || true)"
  if [[ "${source_key}" == "${current_key}" ]]; then
    log "${CONFIGMAP}.${TARGET_KEY} already matches source; no patch needed"
    return 0
  fi
  log "Patching ${CONFIGMAP}.${TARGET_KEY}"
  "${KCTL[@]}" patch configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" --type=merge -p "$(make_patch "${source_key}" "${TARGET_KEY}")" >/dev/null
  local found=0 deployment
  for deployment in chatllm mcp-host; do
    if "${KCTL[@]}" get "deployment/${deployment}" -n "${CONFIG_NAMESPACE}" >/dev/null 2>&1; then
      found=1
      log "Restarting ${CONFIG_NAMESPACE}/${deployment} after auth key drift"
      rollout_restart_with_retry "${deployment}" >/dev/null
      "${KCTL[@]}" rollout status "deployment/${deployment}" -n "${CONFIG_NAMESPACE}" --timeout="${MCP_HOST_ROLLOUT_TIMEOUT}"
    fi
  done
  if [[ "${found}" == "0" ]]; then
    log "No mcp-host deployments exist yet; auth key is synced for future pods"
  fi
}

# ── Target 2: gfs-config (gfsc fails closed without the verification key) ──────
sync_gfs() {
  if ! "${KCTL[@]}" get configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" >/dev/null 2>&1; then
    log "Skipping ${GFS_CONFIGMAP} sync (not found)"
    return 0
  fi
  local current_key
  current_key="$("${KCTL[@]}" get configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" -o "jsonpath={.data.${GFS_TARGET_KEY}}" 2>/dev/null || true)"
  if [[ "${source_key}" == "${current_key}" ]]; then
    log "${GFS_CONFIGMAP}.${GFS_TARGET_KEY} already matches source; no patch needed"
    return 0
  fi
  log "Patching ${GFS_CONFIGMAP}.${GFS_TARGET_KEY}"
  "${KCTL[@]}" patch configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" --type=merge -p "$(make_patch "${source_key}" "${GFS_TARGET_KEY}")" >/dev/null
  local dsn
  dsn="$("${KCTL[@]}" get secret gfs-controller-db -n "${GFS_NAMESPACE}" -o 'jsonpath={.data.connection-string}' 2>/dev/null | base64 -d || true)"
  if [[ -z "${dsn}" ]]; then
    log "Skipping gfsc restart after auth key drift (gfs-controller-db.connection-string not populated yet)"
    return 0
  fi
  # gfsc reads the key at boot; restart the writer+reader so the new key takes
  # effect (label-based — the reconciler owns the deployment names).
  if "${KCTL[@]}" get deployment -l "${GFS_DEPLOY_SELECTOR}" -n "${GFS_NAMESPACE}" -o name 2>/dev/null | grep -q .; then
    log "Restarting gfsc (${GFS_DEPLOY_SELECTOR}) after auth key drift"
    "${KCTL[@]}" rollout restart deployment -l "${GFS_DEPLOY_SELECTOR}" -n "${GFS_NAMESPACE}" >/dev/null
    "${KCTL[@]}" rollout status deployment -l "${GFS_DEPLOY_SELECTOR}" -n "${GFS_NAMESPACE}" --timeout=90s || true
  else
    log "No gfsc deployments exist yet; auth key is synced for future pods"
  fi
}

sync_mcp_host
sync_gfs

log "Auth key synced"
