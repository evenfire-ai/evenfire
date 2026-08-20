#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROFILE="clerum-test"
REQUIRE_GFS=false
REQUIRE_MCP=false
SYNC_GFS=true

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
    --require-gfs)
      # Reset recovery cannot restore GFSC until the canonical platform key is
      # materialized in gfs-config. Generic bootstrap callers retain the
      # existing skip-if-absent behavior.
      REQUIRE_GFS=true
      shift
      ;;
    --require-mcp)
      REQUIRE_MCP=true
      shift
      ;;
    --skip-gfs)
      # Pre-gate security lanes need the MCP host key refresh without mutating
      # the optional GFS plane. The T2 GFS path uses --require-gfs instead.
      SYNC_GFS=false
      shift
      ;;
    -h|--help)
      echo "Usage: scripts/minikube/sync-auth-key.sh [--context <kubectl-context>] [--require-mcp] [--require-gfs|--skip-gfs]" >&2
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "${REQUIRE_GFS}" == "true" && "${SYNC_GFS}" != "true" ]]; then
  echo "--require-gfs cannot be combined with --skip-gfs" >&2
  exit 2
fi

KCTL=(kubectl --context="${PROFILE}")
SOURCE_SECRET="rpc-proxy-secrets"
SOURCE_NAMESPACE="rpc-proxy"
CONFIGMAP="mcp-host-config"
CONFIG_NAMESPACE="mcp-host"
SOURCE_KEY="RPC_PROXY_JWT_PUBLIC_KEY"
TARGET_KEY="CLERUM_AUTH_JWT_PUBLIC_KEY"
MCP_HOST_ROLLOUT_TIMEOUT="180s"
# This ConfigMap annotation is the durable commit record for a completed
# rollout. It is written only after every active consumer proves its in-process
# environment contains the source key; matching data without this hash resumes.
APPLIED_HASH_ANNOTATION="clerum.io/auth-key-applied-sha256"
MCP_DEPLOY_SELECTOR="clerum.io/managed-by=host-context-controller"

# gfsc verifies gfs access tokens with the SAME platform public key (open core
# reuses one keypair). gfsc fails closed without it (empty key ⇒ no read serving),
# so the key must be synced into gfs-config exactly like mcp-host-config.
GFS_CONFIGMAP="gfs-config"
GFS_NAMESPACE="gfs"
GFS_TARGET_KEY="jwt-public-key"

log() { printf '[sync-auth-key] %s\n' "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}

rollout_restart_with_retry() {
  local namespace="$1"
  local deployment="$2"
  local attempt
  local output

  for attempt in 1 2 3; do
    if output="$("${KCTL[@]}" rollout restart "deployment/${deployment}" -n "${namespace}" 2>&1)"; then
      [[ -n "${output}" ]] && printf '%s\n' "${output}"
      return 0
    fi

    if [[ "${output}" == *"within the past second"* && "${attempt}" != "3" ]]; then
      log "Retrying rollout restart for ${namespace}/${deployment} after recent restart" >&2
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

make_applied_hash_patch() {
  APPLIED_HASH="$1" APPLIED_HASH_ANNOTATION="${APPLIED_HASH_ANNOTATION}" python3 - <<'PY'
import json
import os

print(json.dumps({
    "metadata": {
        "annotations": {
            os.environ["APPLIED_HASH_ANNOTATION"]: os.environ["APPLIED_HASH"]
        }
    }
}))
PY
}

read_applied_hash() {
  local namespace="$1" configmap="$2"
  "${KCTL[@]}" get configmap "${configmap}" -n "${namespace}" \
    -o 'jsonpath={.metadata.annotations.clerum\.io/auth-key-applied-sha256}'
}

mark_key_applied() {
  local namespace="$1" configmap="$2"
  "${KCTL[@]}" patch configmap "${configmap}" -n "${namespace}" --type=merge \
    -p "$(make_applied_hash_patch "${source_hash}")" >/dev/null
}

consumer_pods_use_key() {
  local namespace="$1" selector="$2" container="$3" env_name="$4" consumer="$5"
  local rows pod ready deleting pod_count=0

  if ! rows="$("${KCTL[@]}" get pods -n "${namespace}" -l "${selector}" -o \
    'jsonpath={range .items[*]}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>&1)"; then
    log "cannot inspect ${consumer} pods while checking auth-key convergence: ${rows}" >&2
    return 1
  fi

  while IFS='|' read -r pod ready deleting; do
    [[ -n "${pod}" ]] || continue
    [[ -z "${deleting}" ]] || continue
    if [[ "${ready}" != "True" ]]; then
      log "${consumer} pod ${namespace}/${pod} is not Ready while checking auth-key convergence" >&2
      return 1
    fi
    pod_count=$((pod_count + 1))
    if ! printf '%s' "${source_key}" | "${KCTL[@]}" exec -i "${pod}" -n "${namespace}" -c "${container}" -- \
      node -e 'const fs=require("fs");const expected=fs.readFileSync(0,"utf8");process.exit(process.env[process.argv[1]]===expected?0:42)' \
      "${env_name}" >/dev/null; then
      log "${consumer} pod ${namespace}/${pod} has not consumed the target auth key" >&2
      return 1
    fi
  done <<<"${rows}"

  if [[ "${pod_count}" -eq 0 ]]; then
    log "${consumer} has a deployment but no active pod proved consumption of the target auth key" >&2
    return 1
  fi
}

verify_consumer_pods_use_key() {
  local namespace="$1" selector="$2" container="$3" env_name="$4" consumer="$5"
  if ! consumer_pods_use_key "${namespace}" "${selector}" "${container}" "${env_name}" "${consumer}"; then
    die "${consumer} did not prove consumption of the target auth key after rollout"
  fi
}

# The public key is the SAME for every consumer (one platform keypair), so it is
# fetched once and synced into each consumer's ConfigMap below.
source_probe=""
if ! source_probe="$("${KCTL[@]}" get secret "${SOURCE_SECRET}" -n "${SOURCE_NAMESPACE}" 2>&1)"; then
  if [[ "${REQUIRE_GFS}" == "true" || "${REQUIRE_MCP}" == "true" ]]; then
    if [[ "${REQUIRE_GFS}" == "true" ]]; then
      die "required GFS auth source ${SOURCE_NAMESPACE}/${SOURCE_SECRET} is missing or unreadable"
    fi
    die "required MCP auth source ${SOURCE_NAMESPACE}/${SOURCE_SECRET} is missing or unreadable"
  fi
  if [ -z "${source_probe}" ] || [[ "${source_probe}" == *NotFound* || "${source_probe}" == *"not found"* ]]; then
    log "Skipping auth key sync (${SOURCE_SECRET} not found)"
    exit 0
  fi
  die "cannot inspect auth source ${SOURCE_NAMESPACE}/${SOURCE_SECRET}: ${source_probe}"
fi
source_key="$("${KCTL[@]}" get secret "${SOURCE_SECRET}" -n "${SOURCE_NAMESPACE}" -o "jsonpath={.data.${SOURCE_KEY}}" | base64 -d)"
if [[ -z "${source_key}" ]]; then
  if [[ "${REQUIRE_GFS}" == "true" ]]; then
    die "required GFS auth source key ${SOURCE_KEY} is empty"
  fi
  die "auth source key ${SOURCE_KEY} is empty; refusing to mutate consumers"
fi
source_hash="$(printf '%s' "${source_key}" | shasum -a 256 | awk '{print $1}')"
if [[ "${REQUIRE_GFS}" == "true" ]] && \
   ! gfs_target_probe="$("${KCTL[@]}" get configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" 2>&1)"; then
  die "required GFS auth target ${GFS_NAMESPACE}/${GFS_CONFIGMAP} is missing or unreadable: ${gfs_target_probe}"
fi
if [[ "${REQUIRE_MCP}" == "true" ]] && \
   ! mcp_target_probe="$("${KCTL[@]}" get configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" 2>&1)"; then
  die "required MCP auth target ${CONFIG_NAMESPACE}/${CONFIGMAP} is missing or unreadable: ${mcp_target_probe}"
fi

# ── Target 1: mcp-host-config (restart named chatllm/mcp-host with retry) ──────
sync_mcp_host() {
  local target_probe=""
  if ! target_probe="$("${KCTL[@]}" get configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" 2>&1)"; then
    if [[ "${REQUIRE_MCP}" == "true" ]]; then
      die "required MCP auth target ${CONFIG_NAMESPACE}/${CONFIGMAP} disappeared or became unreadable during sync"
    fi
    if [[ "${target_probe}" == *NotFound* || "${target_probe}" == *"not found"* ]]; then
      log "Skipping ${CONFIGMAP} sync (not found)"
      return 0
    fi
    die "cannot inspect auth target ${CONFIG_NAMESPACE}/${CONFIGMAP}: ${target_probe}"
  fi
  local current_key applied_hash
  if ! current_key="$("${KCTL[@]}" get configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" -o "jsonpath={.data.${TARGET_KEY}}" 2>&1)"; then
    die "cannot read auth target ${CONFIG_NAMESPACE}/${CONFIGMAP}: ${current_key}"
  fi
  if ! applied_hash="$(read_applied_hash "${CONFIG_NAMESPACE}" "${CONFIGMAP}" 2>&1)"; then
    die "cannot read auth convergence marker from ${CONFIG_NAMESPACE}/${CONFIGMAP}: ${applied_hash}"
  fi
  local force_rollout=false
  if [[ "${source_key}" != "${current_key}" ]]; then
    log "Patching ${CONFIGMAP}.${TARGET_KEY}"
    "${KCTL[@]}" patch configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" --type=merge -p "$(make_patch "${source_key}" "${TARGET_KEY}")" >/dev/null
    force_rollout=true
  else
    if [[ "${applied_hash}" == "${source_hash}" ]]; then
      log "${CONFIGMAP}.${TARGET_KEY} matches source; checking active consumers before declaring convergence"
    else
      log "${CONFIGMAP}.${TARGET_KEY} matches source but consumer attestation is pending; resuming convergence"
    fi
  fi
  local deployment_resources deployment resource_name
  local deployments=()
  if ! deployment_resources="$("${KCTL[@]}" get deployment -l "${MCP_DEPLOY_SELECTOR}" \
    -n "${CONFIG_NAMESPACE}" -o name 2>&1)"; then
    die "cannot enumerate mcp-host consumers before auth key rollout: ${deployment_resources}"
  fi
  while IFS= read -r resource_name; do
    [[ -n "${resource_name}" ]] || continue
    case "${resource_name}" in
      deployment/*|deployment.apps/*) deployment="${resource_name#*/}" ;;
      *) die "unexpected mcp-host consumer resource from Kubernetes: ${resource_name}" ;;
    esac
    [[ -n "${deployment}" ]] || die "Kubernetes returned an empty mcp-host deployment name"
    deployments+=("${deployment}")
  done <<<"${deployment_resources}"

  if (( ${#deployments[@]} == 0 )); then
    log "No mcp-host deployments exist yet; auth key is synced for future pods"
  else
    for deployment in "${deployments[@]}"; do
      if [[ "${force_rollout}" != true ]] && \
         consumer_pods_use_key "${CONFIG_NAMESPACE}" "app=${deployment}" mcp-host \
           "${TARGET_KEY}" "mcp-host deployment/${deployment}"; then
        log "${CONFIG_NAMESPACE}/${deployment} already consumes the target auth key"
        continue
      fi
      log "Restarting ${CONFIG_NAMESPACE}/${deployment} after auth key drift"
      rollout_restart_with_retry "${CONFIG_NAMESPACE}" "${deployment}" >/dev/null
      "${KCTL[@]}" rollout status "deployment/${deployment}" -n "${CONFIG_NAMESPACE}" --timeout="${MCP_HOST_ROLLOUT_TIMEOUT}"
      verify_consumer_pods_use_key "${CONFIG_NAMESPACE}" "app=${deployment}" mcp-host \
        "${TARGET_KEY}" "mcp-host deployment/${deployment}"
    done
  fi
  if [[ "${applied_hash}" != "${source_hash}" ]]; then
    mark_key_applied "${CONFIG_NAMESPACE}" "${CONFIGMAP}"
  fi
}

# ── Target 2: gfs-config (gfsc fails closed without the verification key) ──────
sync_gfs() {
  local target_probe=""
  if ! target_probe="$("${KCTL[@]}" get configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" 2>&1)"; then
    if [[ "${REQUIRE_GFS}" == "true" ]]; then
      die "required GFS auth target ${GFS_NAMESPACE}/${GFS_CONFIGMAP} disappeared or became unreadable during sync: ${target_probe}"
    fi
    if [[ "${target_probe}" == *NotFound* || "${target_probe}" == *"not found"* ]]; then
      log "Skipping ${GFS_CONFIGMAP} sync (not found)"
      return 0
    fi
    die "cannot inspect auth target ${GFS_NAMESPACE}/${GFS_CONFIGMAP}: ${target_probe}"
  fi
  local current_key applied_hash
  if ! current_key="$("${KCTL[@]}" get configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" -o "jsonpath={.data.${GFS_TARGET_KEY}}" 2>&1)"; then
    die "cannot read auth target ${GFS_NAMESPACE}/${GFS_CONFIGMAP}: ${current_key}"
  fi
  if ! applied_hash="$(read_applied_hash "${GFS_NAMESPACE}" "${GFS_CONFIGMAP}" 2>&1)"; then
    die "cannot read auth convergence marker from ${GFS_NAMESPACE}/${GFS_CONFIGMAP}: ${applied_hash}"
  fi
  local force_rollout=false
  if [[ "${source_key}" != "${current_key}" ]]; then
    log "Patching ${GFS_CONFIGMAP}.${GFS_TARGET_KEY}"
    "${KCTL[@]}" patch configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" --type=merge -p "$(make_patch "${source_key}" "${GFS_TARGET_KEY}")" >/dev/null
    force_rollout=true
  else
    if [[ "${applied_hash}" == "${source_hash}" ]]; then
      log "${GFS_CONFIGMAP}.${GFS_TARGET_KEY} matches source; checking active consumers before declaring convergence"
    else
      log "${GFS_CONFIGMAP}.${GFS_TARGET_KEY} matches source but consumer attestation is pending; resuming convergence"
    fi
  fi

  local deployments=() rollout_deployments=() deployment deployment_probe role selector rollout_output dsn_encoded dsn
  for deployment in gfsc-writer gfsc-reader; do
    deployment_probe=""
    if deployment_probe="$("${KCTL[@]}" get "deployment/${deployment}" -n "${GFS_NAMESPACE}" 2>&1)"; then
      deployments+=("${deployment}")
    elif [[ "${deployment_probe}" != *NotFound* && "${deployment_probe}" != *"not found"* ]]; then
      die "cannot inspect ${GFS_NAMESPACE}/deployment/${deployment} before auth key rollout: ${deployment_probe}"
    fi
  done

  if (( ${#deployments[@]} == 0 )); then
    log "No gfsc deployments exist yet; auth key is synced for future pods"
    if [[ "${applied_hash}" != "${source_hash}" ]]; then
      mark_key_applied "${GFS_NAMESPACE}" "${GFS_CONFIGMAP}"
    fi
    return 0
  fi

  for deployment in "${deployments[@]}"; do
    role="${deployment#gfsc-}"
    selector="app=gfs-controller,clerum.io/gfsc-role=${role}"
    if [[ "${force_rollout}" != true ]] && \
       consumer_pods_use_key "${GFS_NAMESPACE}" "${selector}" gfsc \
         GFS_JWT_PUBLIC_KEY "gfsc deployment/${deployment}"; then
      log "${GFS_NAMESPACE}/${deployment} already consumes the target auth key"
      continue
    fi
    rollout_deployments+=("${deployment}")
  done

  if (( ${#rollout_deployments[@]} == 0 )); then
    log "All active gfsc deployments already consume the target auth key"
    if [[ "${applied_hash}" != "${source_hash}" ]]; then
      mark_key_applied "${GFS_NAMESPACE}" "${GFS_CONFIGMAP}"
    fi
    return 0
  fi

  if ! dsn_encoded="$("${KCTL[@]}" get secret gfs-controller-db -n "${GFS_NAMESPACE}" -o 'jsonpath={.data.connection-string}' 2>&1)"; then
    die "cannot inspect ${GFS_NAMESPACE}/gfs-controller-db before gfsc restart: ${dsn_encoded}"
  fi
  if [[ -z "${dsn_encoded}" ]]; then
    die "${GFS_NAMESPACE}/gfs-controller-db.connection-string is empty; refusing to attest gfsc auth convergence"
  fi
  if ! dsn="$(printf '%s' "${dsn_encoded}" | base64 -d 2>&1)"; then
    die "${GFS_NAMESPACE}/gfs-controller-db.connection-string is not valid base64"
  fi
  if [[ -z "${dsn}" ]]; then
    die "${GFS_NAMESPACE}/gfs-controller-db.connection-string decodes empty; refusing to attest gfsc auth convergence"
  fi
  unset dsn dsn_encoded

  for deployment in "${rollout_deployments[@]}"; do
    role="${deployment#gfsc-}"
    selector="app=gfs-controller,clerum.io/gfsc-role=${role}"
    log "Restarting ${GFS_NAMESPACE}/${deployment} after auth key drift"
    rollout_restart_with_retry "${GFS_NAMESPACE}" "${deployment}" >/dev/null
    if ! rollout_output="$(PATH="${SCRIPT_DIR}/gfs-rollout-shim:${PATH}" CONTEXT="${PROFILE}" \
      "${KCTL[@]}" rollout status "deployment/${deployment}" -n "${GFS_NAMESPACE}" --timeout=90s 2>&1)"; then
      die "gfsc deployment deployment/${deployment} did not become Ready after auth key drift: ${rollout_output}"
    fi
    verify_consumer_pods_use_key "${GFS_NAMESPACE}" "${selector}" gfsc \
      GFS_JWT_PUBLIC_KEY "gfsc deployment/${deployment}"
  done
  if [[ "${applied_hash}" != "${source_hash}" ]]; then
    mark_key_applied "${GFS_NAMESPACE}" "${GFS_CONFIGMAP}"
  fi
}

sync_mcp_host
if [[ "${SYNC_GFS}" == "true" ]]; then
  sync_gfs
fi

log "Auth key synced"
