#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="${KUBECONTEXT:-${MINIKUBE_PROFILE:-clerum-test}}"
PF_LOG="${TMPDIR:-/tmp}/clerum-workflow-runtime-gate-pf-${PROFILE//[^A-Za-z0-9_.-]/_}.log"
PF_PID=""

cleanup() {
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

export MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-$PROFILE}"
export KUBECONTEXT="${KUBECONTEXT:-$PROFILE}"
export E2E_CONTROL_API_URL="${E2E_CONTROL_API_URL:-${CONTROL_API_BASE_URL:-http://127.0.0.1:${CONTROL_API_PORT:-8090}}}"

cd "$PROJECT_DIR"

suites=(
  e2e-637-secret-ownership-bypass.sh
  e2e-agentic-workflow-baseline.sh
  e2e-snippet-runtime-smoke.sh
  e2e-snippet-runtime.sh
  e2e-custom-coordinator-sdk.sh
  e2e-workflow-token-rotation.sh
)

if [ "${1:-}" = "--cleanup" ]; then
  for suite in "${suites[@]}"; do
    "${SCRIPT_DIR}/${suite}" --cleanup-only || true
  done
  exit 0
fi

if [ "${E2E_USE_EXISTING_PORT_FORWARDS:-false}" != "true" ]; then
  echo "==> starting workflow runtime gate port-forwards (${PROFILE}; log: ${PF_LOG})"
  scripts/minikube/pf-all-stack.sh --hold >"$PF_LOG" 2>&1 &
  PF_PID=$!
  sleep 1
  if ! kill -0 "$PF_PID" 2>/dev/null; then
    echo "port-forward setup failed; see ${PF_LOG}" >&2
    sed -n '1,120p' "$PF_LOG" >&2 || true
    exit 1
  fi
fi

control_api_ready=false
for _ in $(seq 1 60); do
  if curl -sf -m 2 "${E2E_CONTROL_API_URL}/health" >/dev/null 2>&1; then
    control_api_ready=true
    break
  fi
  sleep 1
done
if [ "$control_api_ready" != "true" ]; then
  echo "control-api did not become reachable at ${E2E_CONTROL_API_URL}/health" >&2
  [ -f "$PF_LOG" ] && sed -n '1,160p' "$PF_LOG" >&2 || true
  exit 1
fi

failed=()
for suite in "${suites[@]}"; do
  echo "==> ${suite}"
  if ! "${SCRIPT_DIR}/${suite}"; then
    failed+=("$suite")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'failed suites:\n'
  printf '  %s\n' "${failed[@]}"
  exit 1
fi

echo "workflow runtime gate passed"
