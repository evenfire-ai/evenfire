#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

STATE_DIR="${TMP_DIR}/state"
LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_FILE="${TMP_DIR}/sync.out"
SOURCE_HASH="$(printf 'public-key' | shasum -a 256 | awk '{print $1}')"
mkdir -p "${STATE_DIR}"
printf 'old-mcp-key' >"${STATE_DIR}/mcp.key"

cat >"${TMP_DIR}/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

while [[ "${1:-}" == --context* ]]; do
  if [[ "${1}" == "--context" ]]; then shift 2; else shift; fi
done
while [[ "${1:-}" == -n || "${1:-}" == --namespace ]]; do shift 2; done
printf '%s\n' "$*" >>"${TEST_KUBECTL_LOG}"

increment() {
  local name="$1" file count=0
  file="${TEST_STATE_DIR}/${name}.count"
  [[ -f "${file}" ]] && count="$(cat "${file}")"
  printf '%s' "$((count + 1))" >"${file}"
}

if [[ "${1:-}" == get && "${2:-}" == secret && "${3:-}" == rpc-proxy-secrets ]]; then
  [[ "$*" == *jsonpath* ]] && printf 'cHVibGljLWtleQ=='
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == configmap && "${3:-}" == mcp-host-config ]]; then
  if [[ "$*" == *auth-key-applied-sha256* ]]; then
    [[ -f "${TEST_STATE_DIR}/mcp.applied" ]] && cat "${TEST_STATE_DIR}/mcp.applied"
  elif [[ "$*" == *jsonpath* ]]; then
    cat "${TEST_STATE_DIR}/mcp.key"
  fi
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == configmap && "${3:-}" == gfs-config ]]; then
  [[ "${TEST_GFS_PRESENT:-0}" == 1 ]] || {
    echo 'Error from server (NotFound): configmaps "gfs-config" not found' >&2
    exit 1
  }
  if [[ "$*" == *auth-key-applied-sha256* ]]; then
    [[ -f "${TEST_STATE_DIR}/gfs.applied" ]] && cat "${TEST_STATE_DIR}/gfs.applied"
  elif [[ "$*" == *jsonpath* ]]; then
    cat "${TEST_STATE_DIR}/gfs.key"
  fi
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == deployment && "${3:-}" == -l ]]; then
  case "${TEST_MCP_DEPLOYMENTS:-chatllm}" in
    none) ;;
    custom) printf 'deployment.apps/custom-host\n' ;;
    *) printf 'deployment.apps/chatllm\n' ;;
  esac
  exit 0
fi

if [[ "${1:-}" == patch && "${2:-}" == configmap ]]; then
  target="${3}"
  patch_payload=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == -p ]]; then patch_payload="${2:-}"; break; fi
    shift
  done
  case "${target}:${patch_payload}" in
    mcp-host-config:*'"data"'*) printf 'public-key' >"${TEST_STATE_DIR}/mcp.key"; increment mcp-data-patch ;;
    mcp-host-config:*auth-key-applied-sha256*) printf '%s' "${TEST_SOURCE_HASH}" >"${TEST_STATE_DIR}/mcp.applied"; increment mcp-marker-patch ;;
    gfs-config:*'"data"'*) printf 'public-key' >"${TEST_STATE_DIR}/gfs.key"; increment gfs-data-patch ;;
    gfs-config:*auth-key-applied-sha256*) printf '%s' "${TEST_SOURCE_HASH}" >"${TEST_STATE_DIR}/gfs.applied"; increment gfs-marker-patch ;;
    *) echo "unexpected ConfigMap patch: ${target}" >&2; exit 91 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == deployment/* ]]; then
  case "${2}" in
    deployment/chatllm|deployment/custom-host) exit 0 ;;
    deployment/mcp-host) echo 'Error from server (NotFound): deployments.apps "mcp-host" not found' >&2; exit 1 ;;
    deployment/gfsc-writer|deployment/gfsc-reader)
      if [[ "${TEST_GFS_DEPLOYMENTS:-0}" == 1 ]]; then exit 0; fi
      printf 'Error from server (NotFound): deployments.apps "%s" not found\n' "${2#deployment/}" >&2
      exit 1 ;;
    *) exit 1 ;;
  esac
fi

if [[ "${1:-}" == get && "${2:-}" == deployment && "${3:-}" == gfsc-reader ]]; then
  if [[ "$*" == *'.spec.replicas'* || "$*" == *'.status.readyReplicas'* ]]; then
    printf '1'
    exit 0
  fi
fi

if [[ "${1:-}" == get && "${2:-}" == secret && "${3:-}" == gfs-controller-db ]]; then
  printf 'ZHNuLXZhbHVl'
  exit 0
fi

if [[ "${1:-}" == rollout && "${2:-}" == restart && "${3:-}" == deployment/* ]]; then
  increment "${3#deployment/}-restart"
  exit 0
fi

if [[ "${1:-}" == rollout && "${2:-}" == status && "${3:-}" == deployment/* ]]; then
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == pods ]]; then
  if [[ "$*" != *'.metadata.name'* && "$*" == *gfsc-role=reader* ]]; then
    printf 'True|\n'
    exit 0
  fi
  case "$*" in
    *app=chatllm*) printf 'chatllm-pod|True|\n' ;;
    *app=custom-host*) printf 'custom-host-pod|True|\n' ;;
    *gfsc-role=writer*) printf 'gfsc-writer-pod|True|\n' ;;
    *gfsc-role=reader*) printf 'gfsc-reader-pod|True|\n' ;;
    *) echo "unexpected pod selector: $*" >&2; exit 92 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == exec ]]; then
  payload="$(cat)"
  expected_key="${TEST_RUNTIME_KEY}"
  [[ "$*" == *GFS_JWT_PUBLIC_KEY* ]] && expected_key="${TEST_RUNTIME_KEY_GFS:-${expected_key}}"
  [[ "$*" == *CLERUM_AUTH_JWT_PUBLIC_KEY* ]] && expected_key="${TEST_RUNTIME_KEY_MCP:-${expected_key}}"
  [[ "${payload}" == "${expected_key}" ]]
  exit
fi

echo "unexpected kubectl invocation: $*" >&2
exit 99
SH
chmod +x "${TMP_DIR}/kubectl"

run_sync() {
  TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
    TEST_SOURCE_HASH="${SOURCE_HASH}" PATH="${TMP_DIR}:$PATH" \
    "$@"
}

# Fault after the ConfigMap patch: the active pod still has the old key. The
# durable marker must remain absent so a retry cannot misclassify this as done.
if run_sync env TEST_RUNTIME_KEY=old-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo "FAIL: MCP sync accepted a pod that had not consumed the target key" >&2
  exit 1
fi
[[ "$(cat "${STATE_DIR}/mcp.key")" == public-key ]]
[[ ! -e "${STATE_DIR}/mcp.applied" ]]
grep -q 'has not consumed the target auth key' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: interrupted MCP sync did not report failed consumer proof" >&2
  exit 1
}

# The key now matches, but the absent marker must resume—not skip—consumer
# convergence. A live pod that already consumed the target key need not restart.
: >"${LOG_FILE}"
run_sync env TEST_RUNTIME_KEY=public-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
[[ "$(cat "${STATE_DIR}/mcp.applied")" == "${SOURCE_HASH}" ]]
[[ "$(cat "${STATE_DIR}/mcp-data-patch.count")" == 1 ]]
[[ "$(cat "${STATE_DIR}/chatllm-restart.count")" == 1 ]]
grep -q 'matches source but consumer attestation is pending; resuming convergence' "${OUT_FILE}"

# A fully attested rerun is idempotent and must not touch the deployment.
: >"${LOG_FILE}"
# A converged pod must report the target key; an arbitrary value would
# correctly trigger a recovery rollout rather than exercise idempotence.
run_sync env TEST_RUNTIME_KEY=public-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
[[ "$(cat "${STATE_DIR}/chatllm-restart.count")" == 1 ]]
if grep -Eq '^(rollout|patch)' "${LOG_FILE}"; then
  echo "FAIL: converged MCP sync was not idempotent" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

# A previous run may have attested the ConfigMap before HCC created a new
# managed deployment. A later run must inspect that new pod instead of
# returning on the old ConfigMap annotation alone.
: >"${LOG_FILE}"
if run_sync env TEST_RUNTIME_KEY=old-key TEST_MCP_DEPLOYMENTS=custom \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo "FAIL: newly created MCP consumer with stale key was accepted" >&2
  exit 1
fi
[[ "$(cat "${STATE_DIR}/custom-host-restart.count")" == 1 ]]
grep -q 'has not consumed the target auth key' "${OUT_FILE}"

run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=custom \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
[[ "$(cat "${STATE_DIR}/custom-host-restart.count")" == 1 ]]

# Repeat the interrupted-then-resumed contract for the two real GFSC
# deployments. This also prevents a regression to deployment/gfs-controller.
printf 'old-gfs-key' >"${STATE_DIR}/gfs.key"
: >"${LOG_FILE}"
if run_sync env TEST_RUNTIME_KEY=public-key TEST_RUNTIME_KEY_MCP=public-key TEST_RUNTIME_KEY_GFS=old-key \
  TEST_GFS_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo "FAIL: GFS sync accepted a writer that had not consumed the target key" >&2
  exit 1
fi
[[ "$(cat "${STATE_DIR}/gfs.key")" == public-key ]] || {
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: GFS ConfigMap was not patched before consumer proof" >&2
  exit 1
}
[[ ! -e "${STATE_DIR}/gfs.applied" ]]

: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_RUNTIME_KEY_MCP=public-key TEST_RUNTIME_KEY_GFS=public-key \
  TEST_GFS_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: GFS sync did not resume after an interrupted consumer proof" >&2
  exit 1
fi
[[ "$(cat "${STATE_DIR}/gfs.applied")" == "${SOURCE_HASH}" ]]
[[ "$(cat "${STATE_DIR}/gfsc-writer-restart.count")" == 1 ]]
[[ ! -e "${STATE_DIR}/gfsc-reader-restart.count" ]]
if grep -q 'rollout restart deployment/gfsc-' "${LOG_FILE}"; then
  echo "FAIL: already-converged GFSC pods were restarted unnecessarily" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
if grep -q 'deployment/gfs-controller' "${LOG_FILE}"; then
  echo "FAIL: GFS auth sync targeted the nonexistent deployment/gfs-controller" >&2
  exit 1
fi

echo "PASS: auth-key convergence is durable, resumable, consumer-proven, and idempotent"
