#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROFILE="clerum-test"
REQUIRE_GFS=false
REQUIRE_MCP=false
SYNC_GFS=true
SHARED_PROFILE_BOOTSTRAP=false

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
    --shared-profile-bootstrap)
      # The documented shared local profile may be started before a
      # branch-owned T2 lease exists. This mode is intentionally limited to
      # MCP-only convergence; GFS and remote authorization stay forbidden.
      SHARED_PROFILE_BOOTSTRAP=true
      shift
      ;;
    -h|--help)
      echo "Usage: scripts/minikube/sync-auth-key.sh [--context <kubectl-context>] [--require-mcp] [--require-gfs|--skip-gfs] [--shared-profile-bootstrap]" >&2
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

if [[ "${SHARED_PROFILE_BOOTSTRAP}" == "true" ]]; then
  if [[ "${REQUIRE_MCP}" != "true" || "${SYNC_GFS}" != "false" || "${REQUIRE_GFS}" == "true" ]]; then
    echo "--shared-profile-bootstrap requires --require-mcp --skip-gfs and forbids --require-gfs" >&2
    exit 2
  fi
  if [[ "${GFS_REMOTE_RECONCILE_AUTHORIZED:-false}" == "true" ]]; then
    echo "--shared-profile-bootstrap cannot carry remote reconciliation authorization" >&2
    exit 2
  fi
fi

log() { printf '[sync-auth-key] %s\n' "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T2_PROJECT_DIR="${T2_PROJECT_DIR:-${ROOT}}"
T2_PROFILE="${T2_PROFILE:-${MINIKUBE_PROFILE:-${PROFILE}}}"
T2_CONTEXT="${T2_CONTEXT:-${CONTROL_API_REAL_PG_CONTEXT:-${PROFILE}}}"
T2_LOCK_ROOT="${T2_LOCK_ROOT:-${HOME}/.cache/evenfire/minikube-t2-locks}"
T2_LOCK_TOKEN="${T2_LOCK_TOKEN:-}"

remote_context_allowed() {
  local allowed_context
  local -a allowed_contexts=()
  [ "${GFS_REMOTE_RECONCILE_AUTHORIZED:-false}" = true ] || return 1
  [ -n "${ALLOWED_CONTEXTS:-}" ] || return 1
  IFS=',' read -r -a allowed_contexts <<<"${ALLOWED_CONTEXTS}"
  for allowed_context in "${allowed_contexts[@]}"; do
    [ "${allowed_context}" = "${PROFILE}" ] && return 0
  done
  return 1
}

# The non-local infra entrypoint has already made the explicit context
# authorization decision. A failed/empty Minikube status must never turn a
# local ambiguity into a remote write path.
REMOTE_RECONCILE=false
if [ "${GFS_REMOTE_RECONCILE_AUTHORIZED:-false}" = true ]; then
  remote_context_allowed || die "remote auth-key convergence requires an explicit allowlisted context"
  REMOTE_RECONCILE=true
fi

[[ "${PROFILE}" == "${T2_PROFILE}" && "${PROFILE}" == "${T2_CONTEXT}" ]] ||
  die "auth-key convergence target profile and Kubernetes context do not match"

if [ "${REMOTE_RECONCILE}" != true ] && [ "${SHARED_PROFILE_BOOTSTRAP}" != true ]; then
  # Auth-key convergence mutates runtime ConfigMaps and restarts consumers. It
  # is a child of the owning T2/full-setup transition, never an independent
  # writer. Validate the complete lease identity, including branch/HEAD and
  # worktree, so an opaque token alone cannot authorize a different target.
  # shellcheck source=scripts/minikube/t2-common.sh
  source "${ROOT}/scripts/minikube/t2-common.sh"
  actual_root="$(git -C "${T2_PROJECT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "${actual_root}" && "$(cd -- "${actual_root}" && pwd -P)" == "${T2_PROJECT_DIR}" ]] ||
    die "auth-key convergence worktree does not match the lease repository"
  T2_BRANCH="$(git -C "${T2_PROJECT_DIR}" branch --show-current 2>/dev/null || true)"
  T2_HEAD="$(git -C "${T2_PROJECT_DIR}" rev-parse --verify HEAD 2>/dev/null || true)"
  T2_WORKTREE_ID="$(t2_worktree_id "${T2_PROJECT_DIR}")"
  [[ -n "${T2_BRANCH}" && -n "${T2_HEAD}" ]] || die "auth-key convergence cannot resolve the current branch and HEAD"
  t2_lock_validate_inherited
fi

# Always use the verified effective context, not a stale caller-local alias.
KCTL=(kubectl --context="${T2_CONTEXT}")
SOURCE_SECRET="rpc-proxy-secrets"
SOURCE_NAMESPACE="rpc-proxy"
CONFIGMAP="mcp-host-config"
CONFIG_NAMESPACE="mcp-host"
SOURCE_KEY="RPC_PROXY_JWT_PUBLIC_KEY"
TARGET_KEY="CLERUM_AUTH_JWT_PUBLIC_KEY"
MCP_CONSUMER_ROLLOUT_TIMEOUT="180s"
# This ConfigMap annotation is the durable commit record for a completed
# rollout. It is written only after every active consumer proves its in-process
# environment contains the source key; matching data without this hash resumes.
APPLIED_HASH_ANNOTATION="clerum.io/auth-key-applied-sha256"
MCP_BINDING_DISCOVERY="${ROOT}/scripts/minikube/discover-configmap-key-consumers.py"

# gfsc verifies gfs access tokens with the SAME platform public key (open core
# reuses one keypair). gfsc fails closed without it (empty key ⇒ no read serving),
# so the key must be synced into gfs-config exactly like mcp-host-config.
GFS_CONFIGMAP="gfs-config"
GFS_NAMESPACE="gfs"
GFS_TARGET_KEY="jwt-public-key"
# During the T2 recovery transition, credential reconciliation is the producer
# of the GFS DSN. An explicitly staged sync may update gfs-config and defer
# active-pod proof until that producer has run; ordinary/full-setup callers
# remain fail-closed by default.
GFS_AUTH_SYNC_ALLOW_STAGED="${GFS_AUTH_SYNC_ALLOW_STAGED:-false}"

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
  SOURCE_VALUE_B64="$1" TARGET_KEY="$2" python3 - <<'PY'
import base64
import json
import os
import sys

try:
    source_value = base64.b64decode(os.environ["SOURCE_VALUE_B64"], validate=True).decode("utf-8")
except (ValueError, UnicodeDecodeError) as exc:
    print(f"invalid UTF-8 source auth key: {exc}", file=sys.stderr)
    raise SystemExit(1)

print(json.dumps({"data": {os.environ["TARGET_KEY"]: source_value}}))
PY
}

make_applied_hash_json_patch() {
  local namespace="$1" configmap="$2" target_key="$3" target_json
  target_json="$("${KCTL[@]}" get configmap "${configmap}" -n "${namespace}" -o json)" ||
    die "cannot snapshot auth target ${namespace}/${configmap} before attestation"
  TARGET_JSON="$target_json" TARGET_KEY="$target_key" SOURCE_KEY_B64="$source_key_b64" \
    APPLIED_HASH="$source_hash" APPLIED_HASH_ANNOTATION="$APPLIED_HASH_ANNOTATION" \
    python3 - <<'PY'
import base64
import json
import os

obj = json.loads(os.environ["TARGET_JSON"])
metadata = obj.get("metadata") or {}
data = obj.get("data") or {}
annotations = metadata.get("annotations") or {}
rv = str(metadata.get("resourceVersion") or "")
if not rv:
    raise SystemExit("auth target has no resourceVersion")
try:
    expected = base64.b64decode(os.environ["SOURCE_KEY_B64"], validate=True).decode("utf-8")
except (ValueError, UnicodeDecodeError) as exc:
    raise SystemExit(f"invalid source auth key: {exc}")
key = os.environ["TARGET_KEY"]
if data.get(key) != expected:
    raise SystemExit("auth target changed before attestation")
annotation = os.environ["APPLIED_HASH_ANNOTATION"]
ops = [
    {"op": "test", "path": "/metadata/resourceVersion", "value": rv},
    {"op": "test", "path": "/data/" + key.replace("~", "~0").replace("/", "~1"), "value": expected},
]
path = "/metadata/annotations/" + annotation.replace("~", "~0").replace("/", "~1")
if annotations:
    ops.append({"op": "replace" if annotation in annotations else "add", "path": path, "value": os.environ["APPLIED_HASH"]})
else:
    ops.append({"op": "add", "path": "/metadata/annotations", "value": {annotation: os.environ["APPLIED_HASH"]}})
print(json.dumps(ops))
PY
}

read_applied_hash() {
  local namespace="$1" configmap="$2"
  "${KCTL[@]}" get configmap "${configmap}" -n "${namespace}" \
    -o 'jsonpath={.metadata.annotations.clerum\.io/auth-key-applied-sha256}'
}

mark_key_applied() {
  local namespace="$1" configmap="$2" target_key="${3:-}"
  if [ -z "${target_key}" ]; then
    case "${configmap}" in
      "${CONFIGMAP}") target_key="${TARGET_KEY}" ;;
      "${GFS_CONFIGMAP}") target_key="${GFS_TARGET_KEY}" ;;
      *) die "cannot infer auth target key for ${namespace}/${configmap}" ;;
    esac
  fi
  assert_source_unchanged
  "${KCTL[@]}" patch configmap "${configmap}" -n "${namespace}" --type=json \
    -p "$(make_applied_hash_json_patch "${namespace}" "${configmap}" "${target_key}")" >/dev/null
}

configmap_key_hash() {
  local namespace="$1" configmap="$2" key="$3"
  "${KCTL[@]}" get configmap "${configmap}" -n "${namespace}" \
    -o "jsonpath={.data.${key}}" | shasum -a 256 | awk '{print $1}'
}

deployment_desired_replicas() {
  local namespace="$1" deployment="$2" desired
  desired="$("${KCTL[@]}" get "deployment/${deployment}" -n "${namespace}" \
    -o 'jsonpath={.spec.replicas}' 2>&1)" || {
    log "cannot read desired replicas for ${namespace}/deployment/${deployment}: ${desired}" >&2
    return 1
  }
  [[ "${desired}" =~ ^[0-9]+$ ]] || {
    log "deployment ${namespace}/deployment/${deployment} returned a non-numeric desired replica count" >&2
    return 1
  }
  printf '%s' "${desired}"
}

discover_mcp_consumer_snapshot() {
  local deployments_json references inventory_records="" snapshot
  local kind name required resource sanitized extra
  if ! deployments_json="$("${KCTL[@]}" get deployments -n "${CONFIG_NAMESPACE}" -o json 2>&1)"; then
    log "cannot enumerate Deployment pod templates in ${CONFIG_NAMESPACE}: ${deployments_json}" >&2
    return 1
  fi

  if ! references="$(printf '%s' "${deployments_json}" | python3 "${MCP_BINDING_DISCOVERY}" \
    --mode references --namespace "${CONFIG_NAMESPACE}" \
    --config-map "${CONFIGMAP}" --key "${TARGET_KEY}" 2>&1)"; then
    log "cannot enumerate references that affect ${CONFIGMAP}.${TARGET_KEY} bindings: ${references}" >&2
    return 1
  fi

  while IFS=$'\x1f' read -r kind name required extra; do
    [[ -n "${kind}" ]] || continue
    [[ -n "${name}" && ( "${required}" == "true" || "${required}" == "false" ) && -z "${extra}" ]] || {
      log "consumer reference discovery returned an incomplete object record" >&2
      return 1
    }
    case "${kind}" in
      ConfigMap) resource=configmap ;;
      Secret) resource=secret ;;
      *)
        log "consumer reference discovery returned unsupported object kind ${kind}" >&2
        return 1
        ;;
    esac
    if ! sanitized="$(
      "${KCTL[@]}" get "${resource}" "${name}" -n "${CONFIG_NAMESPACE}" \
        --ignore-not-found -o json |
        python3 "${MCP_BINDING_DISCOVERY}" --mode sanitize-object \
          --namespace "${CONFIG_NAMESPACE}" --config-map "${CONFIGMAP}" --key "${TARGET_KEY}" \
          --object-kind "${kind}" --object-name "${name}" --required "${required}" 2>&1
    )"; then
      log "cannot snapshot referenced ${kind} ${CONFIG_NAMESPACE}/${name}: ${sanitized}" >&2
      return 1
    fi
    if [[ -n "${inventory_records}" ]]; then
      inventory_records+=$'\n'
    fi
    inventory_records+="${sanitized}"
  done <<<"${references}"

  if ! snapshot="$(printf '%s' "${deployments_json}" | \
    CONSUMER_OBJECT_INVENTORY="${inventory_records}" \
      python3 "${MCP_BINDING_DISCOVERY}" --mode resolve \
        --namespace "${CONFIG_NAMESPACE}" --config-map "${CONFIGMAP}" --key "${TARGET_KEY}" 2>&1)"; then
    log "cannot derive ${CONFIGMAP}.${TARGET_KEY} consumer bindings: ${snapshot}" >&2
    return 1
  fi
  printf '%s' "${snapshot}"
}

write_source_key() {
  SOURCE_KEY_B64="${source_key_b64}" python3 - <<'PY'
import base64
import os
import sys

sys.stdout.buffer.write(base64.b64decode(os.environ["SOURCE_KEY_B64"], validate=True))
PY
}

assert_source_unchanged() {
  local current_snapshot current_rv ignored_b64 current_hash
  current_snapshot="$(read_source_snapshot)" || die "cannot re-read auth source snapshot"
  IFS=$'\t' read -r current_rv ignored_b64 current_hash <<<"${current_snapshot}"
  [[ -n "${current_rv}" && -n "${current_hash}" ]] ||
    die "auth source snapshot is incomplete during convergence"
  if [[ "${current_rv}" != "${source_resource_version}" || "${current_hash}" != "${source_hash}" ]]; then
    die "auth source rotated during convergence; refusing to attest a stale key"
  fi
}

read_source_snapshot() {
  local source_json
  source_json="$("${KCTL[@]}" get secret "${SOURCE_SECRET}" -n "${SOURCE_NAMESPACE}" -o json)" ||
    return 1
  SOURCE_JSON="${source_json}" SOURCE_KEY="${SOURCE_KEY}" python3 - <<'PY'
import base64
import hashlib
import json
import os
import sys

try:
    obj = json.loads(os.environ["SOURCE_JSON"])
    metadata = obj.get("metadata") or {}
    data = obj.get("data") or {}
    resource_version = str(metadata.get("resourceVersion") or "")
    source_key_b64 = data.get(os.environ["SOURCE_KEY"]) or ""
    source_value = base64.b64decode(source_key_b64, validate=True)
    source_value.decode("utf-8")
except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)

if not resource_version or not source_value:
    raise SystemExit(1)
print("%s\t%s\t%s" % (
    resource_version,
    source_key_b64,
    hashlib.sha256(source_value).hexdigest(),
))
PY
}

deployment_pods_use_key_bindings() {
  local namespace="$1" selector="$2" bindings="$3" consumer="$4"
  local rows pod ready deleting container env_name pod_count=0 binding_count=0

  [[ -n "${selector}" && -n "${bindings}" ]] || {
    log "${consumer} has no provable selector or environment binding" >&2
    return 1
  }

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
    while IFS=$'\x1f' read -r container env_name; do
      [[ -n "${container}" && -n "${env_name}" ]] || {
        log "${consumer} contains an incomplete environment binding" >&2
        return 1
      }
      binding_count=$((binding_count + 1))
      if ! write_source_key | "${KCTL[@]}" exec -i "${pod}" -n "${namespace}" -c "${container}" -- \
        node -e 'const fs=require("fs");const expected=fs.readFileSync(0,"utf8");process.exit(process.env[process.argv[1]]===expected?0:42)' \
        -- "${env_name}" >/dev/null; then
        log "${consumer} pod ${namespace}/${pod} binding ${container}/${env_name} has not consumed the target auth key" >&2
        return 1
      fi
    done <<<"${bindings}"
  done <<<"${rows}"

  if [[ "${pod_count}" -eq 0 ]]; then
    log "${consumer} has a deployment but no active pod proved consumption of the target auth key" >&2
    return 1
  fi
  if [[ "${binding_count}" -eq 0 ]]; then
    log "${consumer} has no environment binding that proved consumption of the target auth key" >&2
    return 1
  fi
}

consumer_pods_use_key() {
  local namespace="$1" selector="$2" container="$3" env_name="$4" consumer="$5"
  local binding="${container}"$'\x1f'"${env_name}"
  deployment_pods_use_key_bindings "${namespace}" "${selector}" "${binding}" "${consumer}"
}

verify_consumer_pods_use_key() {
  local namespace="$1" selector="$2" container="$3" env_name="$4" consumer="$5"
  if ! consumer_pods_use_key "${namespace}" "${selector}" "${container}" "${env_name}" "${consumer}"; then
    die "${consumer} did not prove consumption of the target auth key after rollout"
  fi
}

reconcile_mcp_consumer_deployment() {
  local namespace="$1" deployment="$2" desired_replicas="$3" selector="$4" bindings="$5"
  local consumer="auth-key consumer deployment/${deployment}" rollout_output

  if [[ "${desired_replicas}" == "0" ]]; then
    log "Skipping suspended ${namespace}/${deployment}; desired replicas=0"
    return 0
  fi
  [[ "${desired_replicas}" =~ ^[0-9]+$ ]] ||
    die "cannot determine desired replicas for ${namespace}/deployment/${deployment}"

  if deployment_pods_use_key_bindings "${namespace}" "${selector}" "${bindings}" "${consumer}"; then
    log "${namespace}/${deployment} already consumes the target auth key"
    return 0
  fi

  log "Restarting ${namespace}/${deployment} after auth key drift"
  if ! rollout_restart_with_retry "${namespace}" "${deployment}" >/dev/null; then
    die "cannot restart ${namespace}/deployment/${deployment} after auth key drift"
  fi
  if ! rollout_output="$("${KCTL[@]}" rollout status "deployment/${deployment}" -n "${namespace}" \
    --timeout="${MCP_CONSUMER_ROLLOUT_TIMEOUT}" 2>&1)"; then
    die "${namespace}/deployment/${deployment} did not become Ready after auth key drift: ${rollout_output}"
  fi
  if ! deployment_pods_use_key_bindings "${namespace}" "${selector}" "${bindings}" "${consumer}"; then
    die "${consumer} did not prove all target auth-key bindings after rollout"
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
source_snapshot="$(read_source_snapshot 2>/dev/null || true)"
if [[ -z "${source_snapshot}" ]]; then
  if [[ "${REQUIRE_GFS}" == "true" ]]; then
    die "required GFS auth source key ${SOURCE_KEY} is empty"
  fi
  die "auth source key ${SOURCE_KEY} is empty; refusing to mutate consumers"
fi
IFS=$'\t' read -r source_resource_version source_key_b64 source_hash <<<"${source_snapshot}"
[[ -n "${source_resource_version}" && -n "${source_key_b64}" && -n "${source_hash}" ]] ||
  die "source auth key ${SOURCE_KEY} is not a valid non-empty UTF-8 base64 value with a resourceVersion"
if [[ "${REQUIRE_GFS}" == "true" ]] && \
   ! gfs_target_probe="$("${KCTL[@]}" get configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" 2>&1)"; then
  die "required GFS auth target ${GFS_NAMESPACE}/${GFS_CONFIGMAP} is missing or unreadable: ${gfs_target_probe}"
fi
if [[ "${REQUIRE_MCP}" == "true" ]] && \
   ! mcp_target_probe="$("${KCTL[@]}" get configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" 2>&1)"; then
  die "required MCP auth target ${CONFIG_NAMESPACE}/${CONFIGMAP} is missing or unreadable: ${mcp_target_probe}"
fi

# ── Target 1: mcp-host-config (discover and prove effective pod bindings) ─────
sync_mcp_consumers() {
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
  local current_hash applied_hash
  if ! current_hash="$(configmap_key_hash "${CONFIG_NAMESPACE}" "${CONFIGMAP}" "${TARGET_KEY}" 2>&1)"; then
    die "cannot read auth target ${CONFIG_NAMESPACE}/${CONFIGMAP}: ${current_hash}"
  fi
  if ! applied_hash="$(read_applied_hash "${CONFIG_NAMESPACE}" "${CONFIGMAP}" 2>&1)"; then
    die "cannot read auth convergence marker from ${CONFIG_NAMESPACE}/${CONFIGMAP}: ${applied_hash}"
  fi
  if [[ "${source_hash}" != "${current_hash}" ]]; then
    log "Patching ${CONFIGMAP}.${TARGET_KEY}"
    "${KCTL[@]}" patch configmap "${CONFIGMAP}" -n "${CONFIG_NAMESPACE}" --type=merge -p "$(make_patch "${source_key_b64}" "${TARGET_KEY}")" >/dev/null
  else
    if [[ "${applied_hash}" == "${source_hash}" ]]; then
      log "${CONFIGMAP}.${TARGET_KEY} matches source; checking active consumers before declaring convergence"
    else
      log "${CONFIGMAP}.${TARGET_KEY} matches source but consumer attestation is pending; resuming convergence"
    fi
  fi

  # HCC can mutate mcp-host/chatllm while Host CRs are applied immediately
  # before this sync (token roll + host.clerum.io/chatllm). Attest only a
  # stable contract: if the snapshot changes, re-enumerate and prove the new
  # bindings instead of stamping the stale one.
  local attempt max_attempts="${MCP_CONSUMER_CONTRACT_ATTEMPTS:-8}"
  local retry_sleep="${MCP_CONSUMER_CONTRACT_RETRY_SLEEP:-3}"
  local consumer_snapshot snapshot_header snapshot_hash snapshot_tag snapshot_extra binding_records
  local final_consumer_snapshot final_hash
  [[ "${max_attempts}" =~ ^[1-9][0-9]*$ ]] ||
    die "MCP_CONSUMER_CONTRACT_ATTEMPTS must be a positive integer"
  [[ "${retry_sleep}" =~ ^[0-9]+$ ]] ||
    die "MCP_CONSUMER_CONTRACT_RETRY_SLEEP must be a non-negative integer"

  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    if ! consumer_snapshot="$(discover_mcp_consumer_snapshot)"; then
      die "cannot enumerate effective ${CONFIGMAP}.${TARGET_KEY} consumers before auth key rollout"
    fi
    snapshot_header="${consumer_snapshot%%$'\n'*}"
    IFS=$'\x1f' read -r snapshot_tag snapshot_hash snapshot_extra <<<"${snapshot_header}"
    [[ "${snapshot_tag}" == "@snapshot" && "${snapshot_hash}" =~ ^[0-9a-f]{64}$ && \
       -z "${snapshot_extra}" ]] ||
      die "consumer discovery returned an invalid contract snapshot"
    if [[ "${consumer_snapshot}" == *$'\n'* ]]; then
      binding_records="${consumer_snapshot#*$'\n'}"
    else
      binding_records=""
    fi
    if [[ -z "${binding_records}" ]]; then
      log "No effective Deployment bindings consume ${CONFIGMAP}.${TARGET_KEY}; auth key is synced for future consumers"
    else
      local namespace deployment desired_replicas selector container env_name
      local current_namespace="" current_deployment="" current_replicas="" current_selector=""
      local current_bindings=""
      while IFS=$'\x1f' read -r namespace deployment desired_replicas selector container env_name; do
        [[ -n "${namespace}" && -n "${deployment}" && -n "${desired_replicas}" && \
           -n "${container}" && -n "${env_name}" ]] ||
          die "consumer discovery returned an incomplete binding record"
        if [[ -n "${current_deployment}" && \
              ( "${namespace}" != "${current_namespace}" || "${deployment}" != "${current_deployment}" ) ]]; then
          reconcile_mcp_consumer_deployment "${current_namespace}" "${current_deployment}" \
            "${current_replicas}" "${current_selector}" "${current_bindings}"
          current_bindings=""
        fi
        if [[ -z "${current_bindings}" ]]; then
          current_namespace="${namespace}"
          current_deployment="${deployment}"
          current_replicas="${desired_replicas}"
          current_selector="${selector}"
        elif [[ "${namespace}" != "${current_namespace}" || \
                "${deployment}" != "${current_deployment}" || \
                "${desired_replicas}" != "${current_replicas}" || \
                "${selector}" != "${current_selector}" ]]; then
          die "consumer discovery returned inconsistent Deployment metadata for ${namespace}/${deployment}"
        fi
        if [[ -n "${current_bindings}" ]]; then
          current_bindings+=$'\n'
        fi
        current_bindings+="${container}"$'\x1f'"${env_name}"
      done <<<"${binding_records}"
      if [[ -n "${current_deployment}" ]]; then
        reconcile_mcp_consumer_deployment "${current_namespace}" "${current_deployment}" \
          "${current_replicas}" "${current_selector}" "${current_bindings}"
      fi
    fi

    if ! final_consumer_snapshot="$(discover_mcp_consumer_snapshot)"; then
      die "cannot re-enumerate effective ${CONFIGMAP}.${TARGET_KEY} consumers before attestation"
    fi
    if [[ "${final_consumer_snapshot}" == "${consumer_snapshot}" ]]; then
      break
    fi
    if [[ "${attempt}" -eq "${max_attempts}" ]]; then
      die "${CONFIGMAP}.${TARGET_KEY} consumer contracts changed during convergence"
    fi
    log "${CONFIGMAP}.${TARGET_KEY} consumer contracts changed during convergence; retrying (${attempt}/${max_attempts})"
    sleep "${retry_sleep}"
  done
  if ! final_hash="$(configmap_key_hash "${CONFIG_NAMESPACE}" "${CONFIGMAP}" "${TARGET_KEY}" 2>&1)"; then
    die "cannot re-read auth target ${CONFIG_NAMESPACE}/${CONFIGMAP} before attestation: ${final_hash}"
  fi
  [[ "${final_hash}" == "${source_hash}" ]] ||
    die "auth target ${CONFIG_NAMESPACE}/${CONFIGMAP}.${TARGET_KEY} changed before attestation"
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
  local current_hash applied_hash
  if ! current_hash="$(configmap_key_hash "${GFS_NAMESPACE}" "${GFS_CONFIGMAP}" "${GFS_TARGET_KEY}" 2>&1)"; then
    die "cannot read auth target ${GFS_NAMESPACE}/${GFS_CONFIGMAP}: ${current_hash}"
  fi
  if ! applied_hash="$(read_applied_hash "${GFS_NAMESPACE}" "${GFS_CONFIGMAP}" 2>&1)"; then
    die "cannot read auth convergence marker from ${GFS_NAMESPACE}/${GFS_CONFIGMAP}: ${applied_hash}"
  fi
  local force_rollout=false
  if [[ "${source_hash}" != "${current_hash}" ]]; then
    log "Patching ${GFS_CONFIGMAP}.${GFS_TARGET_KEY}"
    "${KCTL[@]}" patch configmap "${GFS_CONFIGMAP}" -n "${GFS_NAMESPACE}" --type=merge -p "$(make_patch "${source_key_b64}" "${GFS_TARGET_KEY}")" >/dev/null
    force_rollout=true
  else
    if [[ "${applied_hash}" == "${source_hash}" ]]; then
      log "${GFS_CONFIGMAP}.${GFS_TARGET_KEY} matches source; checking active consumers before declaring convergence"
    else
      log "${GFS_CONFIGMAP}.${GFS_TARGET_KEY} matches source but consumer attestation is pending; resuming convergence"
    fi
  fi

  local deployments=() rollout_deployments=() deployment deployment_probe role selector rollout_output dsn_encoded dsn desired_replicas
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
    desired_replicas="$(deployment_desired_replicas "${GFS_NAMESPACE}" "${deployment}")" ||
      die "cannot determine desired replicas for GFS deployment/${deployment}"
    if [[ "${desired_replicas}" == "0" ]]; then
      log "Skipping suspended ${GFS_NAMESPACE}/${deployment}; desired replicas=0"
      continue
    fi
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
    if [[ "${GFS_AUTH_SYNC_ALLOW_STAGED}" == "true" ]]; then
      log "Deferring active gfsc auth proof until GFS credentials are reconciled"
      return 0
    fi
    die "cannot inspect ${GFS_NAMESPACE}/gfs-controller-db before gfsc restart"
  fi
  if [[ -z "${dsn_encoded}" ]]; then
    if [[ "${GFS_AUTH_SYNC_ALLOW_STAGED}" == "true" ]]; then
      log "Deferring active gfsc auth proof until GFS credentials are reconciled"
      return 0
    fi
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
    if ! rollout_output="$(PATH="${SCRIPT_DIR}/gfs-rollout-shim:${PATH}" CONTEXT="${T2_CONTEXT}" \
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

sync_mcp_consumers
if [[ "${SYNC_GFS}" == "true" ]]; then
  sync_gfs
fi

assert_source_unchanged
log "Auth key synced"
