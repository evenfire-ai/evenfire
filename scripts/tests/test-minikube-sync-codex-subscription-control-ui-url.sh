#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

STATE_DIR="${TMP_DIR}/state"
LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_FILE="${TMP_DIR}/sync.out"
mkdir -p "${STATE_DIR}"

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

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" && "${3:-}" == "control-api-config" ]]; then
  if printf '%s\n' "$@" | grep -q 'jsonpath='; then
    printf '%s' "${TEST_CURRENT_CONTROL_UI_URL:-http://127.0.0.1:3000}"
  fi
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "configmap" && "${3:-}" == "control-api-config" ]]; then
  next_is_patch=false
  for arg in "$@"; do
    if [[ "${next_is_patch}" == "true" ]]; then
      printf '%s' "${arg}" >"${TEST_STATE_DIR}/last-patch.json"
      exit 0
    fi
    if [[ "${arg}" == "-p" ]]; then
      next_is_patch=true
    elif [[ "${arg}" == -p=* ]]; then
      printf '%s' "${arg#-p=}" >"${TEST_STATE_DIR}/last-patch.json"
      exit 0
    fi
  done
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "deployment/control-api" ]]; then
  exit 0
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "restart" && "${3:-}" == "deployment/control-api" ]]; then
  printf '1' >"${TEST_STATE_DIR}/restarted"
  exit 0
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "status" ]]; then
  exit 0
fi

echo "unexpected kubectl: $*" >&2
exit 99
SH
chmod +x "${TMP_DIR}/kubectl"

PORTS_ENV="${TMP_DIR}/ports.env"
cat >"${PORTS_ENV}" <<'EOF'
CONTROL_UI_URL=http://127.0.0.1:36148
CONTROL_API_URL=http://127.0.0.1:36238
EOF

export TEST_KUBECTL_LOG="${LOG_FILE}"
export TEST_STATE_DIR="${STATE_DIR}"
export TEST_CURRENT_CONTROL_UI_URL='http://127.0.0.1:3000'
export PATH="${TMP_DIR}:${PATH}"

if ! PATH="${TMP_DIR}:${PATH}" bash "${ROOT}/scripts/minikube/sync-codex-subscription-control-ui-url.sh" \
  --context 'clerum-feat-codex-deadbeef' \
  --ports-env "${PORTS_ENV}" >"${OUT_FILE}" 2>&1; then
  echo 'FAIL: sync script exited non-zero' >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi

grep -Fq 'Control UI origin: http://127.0.0.1:36148' "${OUT_FILE}" || {
  echo 'FAIL: resolved URL missing from output' >&2
  cat "${OUT_FILE}" >&2
  exit 1
}

grep -Fq '/control-api/api/v1/auth/codex-subscription/callback' "${OUT_FILE}" || {
  echo 'FAIL: redirect_uri missing from output' >&2
  cat "${OUT_FILE}" >&2
  exit 1
}

[[ -f "${STATE_DIR}/last-patch.json" ]] || {
  echo 'FAIL: expected configmap patch' >&2
  exit 1
}

grep -Fq 'CONTROL_API_CONTROL_UI_BASE_URL' "${STATE_DIR}/last-patch.json" || {
  echo 'FAIL: patch missing target key' >&2
  cat "${STATE_DIR}/last-patch.json" >&2
  exit 1
}

[[ -f "${STATE_DIR}/restarted" ]] || {
  echo 'FAIL: expected control-api rollout restart' >&2
  exit 1
}

if PATH="${TMP_DIR}:${PATH}" bash "${ROOT}/scripts/minikube/sync-codex-subscription-control-ui-url.sh" \
  --context 'clerum-feat-codex-deadbeef' \
  --ports-env "${PORTS_ENV}" \
  --dry-run >"${TMP_DIR}/dry-run.out" 2>&1; then
  :
else
  echo 'FAIL: dry-run exited non-zero' >&2
  cat "${TMP_DIR}/dry-run.out" >&2
  exit 1
fi

grep -Fq 'Dry run complete' "${TMP_DIR}/dry-run.out" || {
  echo 'FAIL: dry-run banner missing' >&2
  cat "${TMP_DIR}/dry-run.out" >&2
  exit 1
}

echo 'PASS: sync-codex-subscription-control-ui-url resolves profile URL and patches control-api'
