#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

STATE_DIR="${TMP_DIR}/state"
LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_FILE="${TMP_DIR}/sync-auth-key.out"
mkdir -p "${STATE_DIR}"

cat >"${TMP_DIR}/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH

cat >"${TMP_DIR}/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

while [[ "${1:-}" == --context* ]]; do
  if [[ "${1}" == "--context" ]]; then
    shift 2
  else
    shift
  fi
done

printf '%s\n' "$*" >>"${TEST_KUBECTL_LOG}"

has_output_flag() {
  local arg
  for arg in "$@"; do
    [[ "${arg}" == "-o" || "${arg}" == -o=* || "${arg}" == jsonpath=* ]] && return 0
  done
  return 1
}

restart_count() {
  local deployment="$1"
  local file="${TEST_STATE_DIR}/${deployment}.restart-count"
  local count=0
  [[ -f "${file}" ]] && count="$(cat "${file}")"
  count="$((count + 1))"
  printf '%s' "${count}" >"${file}"
  printf '%s' "${count}"
}

if [[ "${1:-}" == "get" && "${2:-}" == "secret" && "${3:-}" == "rpc-proxy-secrets" ]]; then
  [[ "${TEST_SOURCE_SECRET_PRESENT:-1}" == "1" ]] || exit 1
  if has_output_flag "$@"; then
    [[ "${TEST_SOURCE_KEY_EMPTY:-0}" == "1" ]] || printf 'cHVibGljLWtleQ=='
  fi
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" && "${3:-}" == "mcp-host-config" ]]; then
  if has_output_flag "$@"; then
    printf 'old-key'
  fi
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" && "${3:-}" == "gfs-config" ]]; then
  if [[ "${TEST_GFS_CONFIG_PRESENT:-}" != "1" ]]; then
    printf 'Error from server (NotFound): configmaps "gfs-config" not found\n' >&2
    exit 1
  fi
  if has_output_flag "$@"; then
    printf 'old-gfs-key'
  fi
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "configmap" && "${3:-}" == "mcp-host-config" ]]; then
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "configmap" && "${3:-}" == "gfs-config" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" && "${3:-}" == "gfs-controller-db" ]]; then
  if [[ "${TEST_GFS_CONFIG_PRESENT:-}" != "1" ]]; then
    printf 'Error from server (NotFound): secrets "gfs-controller-db" not found\n' >&2
    exit 1
  fi
  if has_output_flag "$@"; then
    [[ "${TEST_GFS_DSN_PRESENT:-0}" == "1" ]] && printf 'ZHNuLXZhbHVl'
  fi
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "deployment" && "${3:-}" == "-l" ]]; then
  [[ "${TEST_GFS_DEPLOYMENTS:-0}" == "1" ]] || exit 0
  printf 'deployment.apps/gfsc-writer\ndeployment.apps/gfsc-reader\n'
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == deployment/* ]]; then
  exit 0
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "restart" && "${3:-}" == "deployment" && "${4:-}" == "-l" ]]; then
  [[ "${TEST_GFS_DSN_PRESENT:-0}" == "1" ]] || {
    echo "unexpected gfsc rollout restart before DSN provisioning" >&2
    exit 98
  }
  exit "${TEST_GFS_RESTART_STATUS:-0}"
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "restart" && "${3:-}" == "deployment/chatllm" ]]; then
  count="$(restart_count chatllm)"
  if [[ "${count}" == "1" ]]; then
    echo 'failed to create patch: the object has been modified within the past second' >&2
    exit 1
  fi
  echo 'deployment.apps/chatllm restarted'
  exit 0
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "restart" && "${3:-}" == "deployment/mcp-host" ]]; then
  restart_count mcp-host >/dev/null
  echo 'deployment.apps/mcp-host restarted'
  exit 0
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "status" && "${3:-}" == deployment/* ]]; then
  if [[ "${3:-}" == *gfsc-writer* && "${TEST_GFS_STATUS_FAILURE:-0}" != "0" ]]; then
    echo 'simulated gfsc writer rollout failure' >&2
    exit "${TEST_GFS_STATUS_FAILURE}"
  fi
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 99
SH

chmod +x "${TMP_DIR}/kubectl" "${TMP_DIR}/sleep"

if ! TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" PATH="${TMP_DIR}:$PATH" \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

if [[ "$(cat "${STATE_DIR}/chatllm.restart-count")" != "2" ]]; then
  echo "FAIL: chatllm rollout restart was not retried after recent-restart race" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi

if [[ "$(cat "${STATE_DIR}/mcp-host.restart-count")" != "1" ]]; then
  echo "FAIL: mcp-host rollout restart count changed unexpectedly" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi

grep -q 'patch configmap mcp-host-config' "${LOG_FILE}"
grep -q 'rollout status deployment/chatllm -n mcp-host --timeout=180s' "${LOG_FILE}"
grep -q 'rollout status deployment/mcp-host -n mcp-host --timeout=180s' "${LOG_FILE}"

: >"${LOG_FILE}"
if ! TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_GFS_CONFIG_PRESENT=1 PATH="${TMP_DIR}:$PATH" \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

grep -q 'patch configmap gfs-config' "${LOG_FILE}"
grep -q 'Skipping gfsc restart after auth key drift (gfs-controller-db.connection-string not populated yet)' "${OUT_FILE}"
if grep -q 'rollout restart deployment -l' "${LOG_FILE}"; then
  echo "FAIL: gfsc restarted before gfs-controller-db DSN was populated" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi

: >"${LOG_FILE}"
if ! TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_SOURCE_SECRET_PRESENT=0 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake >"${OUT_FILE}" 2>&1; then
  echo "FAIL: optional bootstrap auth sync no longer skips an absent source Secret" >&2
  exit 1
fi
grep -q 'Skipping auth key sync (rpc-proxy-secrets not found)' "${OUT_FILE}"

: >"${LOG_FILE}"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_SOURCE_SECRET_PRESENT=0 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: strict GFS auth sync accepted a missing source Secret" >&2
  exit 1
fi
grep -q 'required GFS auth source rpc-proxy/rpc-proxy-secrets is missing or unreadable' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: strict GFS auth sync did not diagnose its missing source Secret" >&2
  exit 1
}
if grep -Eq '^(patch|rollout restart)' "${LOG_FILE}"; then
  echo "FAIL: missing required GFS source mutated consumers" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

: >"${LOG_FILE}"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_SOURCE_KEY_EMPTY=1 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: strict GFS auth sync accepted an empty source key" >&2
  exit 1
fi
grep -q 'required GFS auth source key RPC_PROXY_JWT_PUBLIC_KEY is empty' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: strict GFS auth sync did not diagnose its empty source key" >&2
  exit 1
}

: >"${LOG_FILE}"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_SOURCE_KEY_EMPTY=1 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --skip-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: optional auth sync accepted an empty source key" >&2
  exit 1
fi
grep -q 'auth source key RPC_PROXY_JWT_PUBLIC_KEY is empty; refusing to mutate consumers' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: optional auth sync did not fail closed on an empty source key" >&2
  exit 1
}
if grep -Eq '^(patch|rollout restart)' "${LOG_FILE}"; then
  echo "FAIL: empty source key mutated an auth consumer in optional mode" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

: >"${LOG_FILE}"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: strict GFS auth sync accepted a missing gfs-config target" >&2
  exit 1
fi
grep -q 'required GFS auth target gfs/gfs-config is missing or unreadable' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: strict GFS auth sync did not diagnose its missing target" >&2
  exit 1
}
if grep -Eq '^(patch|rollout restart)' "${LOG_FILE}"; then
  echo "FAIL: missing required GFS target mutated another auth consumer" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

: >"${LOG_FILE}"
if ! TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_GFS_CONFIG_PRESENT=1 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: strict GFS auth sync rejected complete authority inputs" >&2
  exit 1
fi
grep -q 'patch configmap gfs-config' "${LOG_FILE}"

: >"${LOG_FILE}"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
  TEST_GFS_CONFIG_PRESENT=1 TEST_GFS_DSN_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 TEST_GFS_STATUS_FAILURE=42 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: GFS auth sync swallowed a failed rollout status" >&2
  exit 1
fi
grep -q 'gfsc deployment deployment.apps/gfsc-writer did not become Ready after auth key drift' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: GFS rollout failure did not produce a stable diagnostic" >&2
  exit 1
}

echo "PASS: auth-key sync retries transient rollout restart race and skips gfsc restart until DSN provisioning"
