#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

STATE_DIR="${TMP_DIR}/state"
LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_FILE="${TMP_DIR}/sync-auth-key.out"
mkdir -p "${STATE_DIR}"
printf 'old-key' >"${STATE_DIR}/mcp.key"
printf 'old-gfs-key' >"${STATE_DIR}/gfs.key"

# The production helper requires a live parent T2 lease. Keep the behavior
# tests isolated with a lease owned by this test shell rather than adding a
# production-only bypass.
T2_LOCK_ROOT="${TMP_DIR}/locks"
T2_LOCK_TOKEN='auth-sync-test-token'
T2_LOCK_DIR="${T2_LOCK_ROOT}/fake.lock"
T2_PROCESS_START=unavailable
# GitHub Actions checks out a detached commit.  The fixture still needs a
# non-empty logical lane name because the production lease contract rejects
# owner records without a branch identity; use the PR source ref when it is
# available and a test-only identity otherwise.
T2_TEST_BRANCH="$(git -C "${ROOT}" branch --show-current)"
if [[ -z "${T2_TEST_BRANCH}" ]]; then
  T2_TEST_BRANCH="${GITHUB_HEAD_REF:-detached-ci-test}"
fi
T2_TEST_HEAD="$(git -C "${ROOT}" rev-parse --verify HEAD)"
T2_TEST_WORKTREE_ID="$(printf '%s' "${ROOT}" | shasum | awk '{print $1}')"
T2_TEST_LOCK_KEY="$(printf '%s\0%s\0%s\0%s\0%s' "${ROOT}" "${T2_TEST_BRANCH}" "${T2_TEST_HEAD}" fake fake | shasum | awk '{print $1}')"
mkdir -p "${T2_LOCK_DIR}"
cat >"${T2_LOCK_DIR}/owner.env" <<EOF
REPOSITORY=${ROOT}
BRANCH=${T2_TEST_BRANCH}
HEAD=${T2_TEST_HEAD}
PROFILE=fake
CONTEXT=fake
WORKTREE_ID=${T2_TEST_WORKTREE_ID}
LOCK_KEY=${T2_TEST_LOCK_KEY}
TOKEN=${T2_LOCK_TOKEN}
PID=$$
PROCESS_START=${T2_PROCESS_START}
EOF
export T2_PROJECT_DIR="${ROOT}" T2_PROFILE=fake T2_CONTEXT=fake T2_LOCK_ROOT T2_LOCK_TOKEN

cat >"${TMP_DIR}/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH

cat >"${TMP_DIR}/ps" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *' -o state='*) printf 'R\n' ;;
  *' -o lstart='*) printf 'unavailable\n' ;;
  *) exit 1 ;;
esac
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
  if [[ "$*" == *'.metadata.resourceVersion'* ]]; then
    printf '42'
  elif [[ "$*" == *'-o json' ]]; then
    source_b64='cHVibGljLWtleQ=='
    [[ "${TEST_SOURCE_KEY_EMPTY:-0}" == "1" ]] && source_b64=''
    printf '{"metadata":{"resourceVersion":"42"},"data":{"RPC_PROXY_JWT_PUBLIC_KEY":"%s"}}' "$source_b64"
  elif has_output_flag "$@"; then
    [[ "${TEST_SOURCE_KEY_EMPTY:-0}" == "1" ]] || printf 'cHVibGljLWtleQ=='
  fi
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" && "${3:-}" == "mcp-host-config" ]]; then
  if has_output_flag "$@"; then
    if [[ "$*" == *'-o json' ]]; then
      printf '{"metadata":{"name":"mcp-host-config","namespace":"mcp-host","uid":"mcp-host-config-uid","resourceVersion":"42","annotations":{}},"data":{"CLERUM_AUTH_JWT_PUBLIC_KEY":"%s"}}' \
        "$(cat "${TEST_STATE_DIR}/mcp.key")"
    elif [[ "$*" == *auth-key-applied-sha256* ]]; then
      printf '%s' "${TEST_MCP_APPLIED_HASH:-old-hash}"
    else
      cat "${TEST_STATE_DIR}/mcp.key"
    fi
  fi
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" && "${3:-}" == "gfs-config" ]]; then
  if [[ "${TEST_GFS_CONFIG_PRESENT:-}" != "1" ]]; then
    printf 'Error from server (NotFound): configmaps "gfs-config" not found\n' >&2
    exit 1
  fi
  if has_output_flag "$@"; then
    if [[ "$*" == *'-o json' ]]; then
      printf '{"metadata":{"resourceVersion":"42","annotations":{}},"data":{"jwt-public-key":"%s"}}' \
        "$(cat "${TEST_STATE_DIR}/gfs.key")"
    elif [[ "$*" == *auth-key-applied-sha256* ]]; then
      printf '%s' "${TEST_GFS_APPLIED_HASH:-old-hash}"
    else
      cat "${TEST_STATE_DIR}/gfs.key"
    fi
  fi
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "configmap" && "${3:-}" == "mcp-host-config" ]]; then
  [[ "$*" == *'"data"'* ]] && printf 'public-key' >"${TEST_STATE_DIR}/mcp.key"
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "configmap" && "${3:-}" == "gfs-config" ]]; then
  [[ "$*" == *'"data"'* ]] && printf 'public-key' >"${TEST_STATE_DIR}/gfs.key"
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

if [[ "${1:-}" == "get" && ( "${2:-}" == "deployment" || "${2:-}" == "deployments" ) && "$*" == *'-o json'* ]]; then
  printf '%s' '{"apiVersion":"v1","kind":"List","items":[
    {"metadata":{"name":"chatllm","namespace":"mcp-host","uid":"chatllm-uid","resourceVersion":"30"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"chatllm"}},"template":{"spec":{"containers":[{"name":"mcp-host","envFrom":[{"configMapRef":{"name":"mcp-host-config"}}]}]}}}},
    {"metadata":{"name":"mcp-host","namespace":"mcp-host","uid":"mcp-host-uid","resourceVersion":"30"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"mcp-host"}},"template":{"spec":{"containers":[{"name":"mcp-host","envFrom":[{"configMapRef":{"name":"mcp-host-config"}}]}]}}}},
    {"metadata":{"name":"custom-host","namespace":"mcp-host","uid":"custom-host-uid","resourceVersion":"30"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"custom-host"}},"template":{"spec":{"containers":[{"name":"mcp-host","envFrom":[{"configMapRef":{"name":"mcp-host-config"}}]}]}}}}
  ]}'
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == deployment/* ]]; then
  if [[ "${2:-}" == "deployment/gfsc-writer" || "${2:-}" == "deployment/gfsc-reader" ]]; then
    if [[ "${TEST_GFS_DEPLOYMENTS:-0}" != "1" ]]; then
      printf 'Error from server (NotFound): deployments.apps "%s" not found\n' "${2#deployment/}" >&2
      exit 1
    fi
  fi
  [[ "$*" == *'.spec.replicas'* ]] && printf '1'
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "pods" ]]; then
  case "$*" in
    *app=chatllm*) printf 'chatllm-pod|True|\n' ;;
    *app=mcp-host*) printf 'mcp-host-pod|True|\n' ;;
    *app=custom-host*) printf 'custom-host-pod|True|\n' ;;
    *gfsc-role=writer*) printf 'gfsc-writer-pod|True|\n' ;;
    *gfsc-role=reader*) printf 'gfsc-reader-pod|True|\n' ;;
    *) exit 99 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  payload="$(cat)"
  if [[ "$*" == *chatllm-pod* ]]; then
    [[ -f "${TEST_STATE_DIR}/chatllm.restart-count" && "${payload}" == "public-key" ]]
  elif [[ "$*" == *mcp-host-pod* ]]; then
    [[ -f "${TEST_STATE_DIR}/mcp-host.restart-count" && "${payload}" == "public-key" ]]
  elif [[ "$*" == *custom-host-pod* ]]; then
    [[ -f "${TEST_STATE_DIR}/custom-host.restart-count" && "${payload}" == "public-key" ]]
  else
    [[ "${TEST_CONSUMER_KEY_MATCH:-1}" == "1" && "${payload}" == "public-key" ]]
  fi
  exit
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "restart" && \
      ( "${3:-}" == "deployment/gfsc-writer" || "${3:-}" == "deployment/gfsc-reader" ) ]]; then
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

if [[ "${1:-}" == "rollout" && "${2:-}" == "restart" && "${3:-}" == "deployment/custom-host" ]]; then
  restart_count custom-host >/dev/null
  echo 'deployment.apps/custom-host restarted'
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

chmod +x "${TMP_DIR}/kubectl" "${TMP_DIR}/sleep" "${TMP_DIR}/ps"

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

if [[ "$(cat "${STATE_DIR}/custom-host.restart-count")" != "1" ]]; then
  echo "FAIL: managed custom mcp-host deployment was not restarted" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi

grep -q 'patch configmap mcp-host-config' "${LOG_FILE}"
grep -q 'rollout status deployment/chatllm -n mcp-host --timeout=180s' "${LOG_FILE}"
grep -q 'rollout status deployment/mcp-host -n mcp-host --timeout=180s' "${LOG_FILE}"
grep -q 'rollout status deployment/custom-host -n mcp-host --timeout=180s' "${LOG_FILE}"

: >"${LOG_FILE}"
if ! TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" TEST_GFS_CONFIG_PRESENT=1 PATH="${TMP_DIR}:$PATH" \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

grep -q 'patch configmap gfs-config' "${LOG_FILE}"
grep -q 'No gfsc deployments exist yet; auth key is synced for future pods' "${OUT_FILE}"
if grep -q 'rollout restart deployment/gfsc-' "${LOG_FILE}"; then
  echo "FAIL: absent gfsc deployments were restarted" >&2
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
printf 'old-gfs-key' >"${STATE_DIR}/gfs.key"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
  TEST_GFS_CONFIG_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: strict GFS auth sync accepted an empty DSN before reconciliation" >&2
  exit 1
fi
grep -q 'gfs-controller-db.connection-string is empty' "${OUT_FILE}"

: >"${LOG_FILE}"
printf 'old-gfs-key' >"${STATE_DIR}/gfs.key"
if ! TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
  TEST_GFS_CONFIG_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 \
  GFS_AUTH_SYNC_ALLOW_STAGED=true \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: staged GFS auth sync did not defer proof until reconciliation" >&2
  exit 1
fi
grep -q 'Deferring active gfsc auth proof until GFS credentials are reconciled' "${OUT_FILE}"
if grep -q 'rollout restart deployment/gfsc-' "${LOG_FILE}"; then
  echo "FAIL: staged GFS auth sync restarted a consumer before DSN provisioning" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

: >"${LOG_FILE}"
printf 'old-gfs-key' >"${STATE_DIR}/gfs.key"
if TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
  TEST_GFS_CONFIG_PRESENT=1 TEST_GFS_DSN_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 TEST_GFS_STATUS_FAILURE=42 \
  PATH="${TMP_DIR}:$PATH" bash "${ROOT}/scripts/minikube/sync-auth-key.sh" \
    --context fake --require-gfs >"${OUT_FILE}" 2>&1; then
  echo "FAIL: GFS auth sync swallowed a failed rollout status" >&2
  exit 1
fi
grep -q 'gfsc deployment deployment/gfsc-writer did not become Ready after auth key drift' "${OUT_FILE}" || {
  cat "${OUT_FILE}" >&2
  echo "FAIL: GFS rollout failure did not produce a stable diagnostic" >&2
  exit 1
}

echo "PASS: auth-key sync retries transient rollout restart race and handles absent gfsc consumers safely"
