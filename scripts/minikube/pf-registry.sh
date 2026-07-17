#!/usr/bin/env bash
# Port-forward registry-api for E2E tests.

set -eo pipefail

KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-${MINIKUBE_PROFILE:-clerum-test}}"
KC=(kubectl --context="${KUBECTL_CONTEXT}")
SAFE_CONTEXT="${KUBECTL_CONTEXT//[^A-Za-z0-9_.-]/_}"
LOG="/tmp/pf-${SAFE_CONTEXT}-registry.log"
PIDFILE="/tmp/pf-${SAFE_CONTEXT}-registry.pid"
HOLD=false
HAS_PROFILE_OWNED_PORTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hold)
      HOLD=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

load_branch_profile_ports_env() {
  local ports_env="${CLERUM_PROFILE_PORTS_ENV:-${HOME}/.cache/clerum/minikube-profiles/${KUBECTL_CONTEXT}/ports.env}"
  local line
  if [[ ! -f "${ports_env}" ]]; then
    if [[ "${KUBECTL_CONTEXT}" =~ ^clerum-(codex|detached)- ]]; then
      echo "ERROR: missing branch-scoped port cache for minikube profile: ${KUBECTL_CONTEXT}" >&2
      echo "Expected ${ports_env}" >&2
      exit 1
    fi
    return 0
  fi
  HAS_PROFILE_OWNED_PORTS=true
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*$ || "${line}" =~ ^[[:space:]]*# ]] && continue
    if [[ "${line}" =~ ^REGISTRY_API_PORT=([0-9]{2,5})$ ]]; then
      REGISTRY_API_PORT="${BASH_REMATCH[1]}"
      return 0
    fi
  done < "${ports_env}"
}

load_branch_profile_ports_env
REGISTRY_API_PORT="${REGISTRY_API_PORT:-8085}"

if [[ "${REGISTRY_API_PORT}" == "8085" && ( "${HAS_PROFILE_OWNED_PORTS}" == "true" || "${KUBECTL_CONTEXT}" =~ ^clerum-(codex|detached)- ) ]]; then
  echo "ERROR: ${KUBECTL_CONTEXT} must use its profile-owned registry port; REGISTRY_API_PORT=8085 is the shared default." >&2
  exit 1
fi

# Kill any previous forwarder
if [[ -f "$PIDFILE" ]]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi

nohup "${KC[@]}" -n registry port-forward --address=127.0.0.1 svc/registry-api "${REGISTRY_API_PORT}:8085" > "$LOG" 2>&1 </dev/null &
echo $! > "$PIDFILE"

# Wait up to 5s for the tunnel to come up
for i in $(seq 1 10); do
  if curl -sf -m 1 "http://127.0.0.1:${REGISTRY_API_PORT}/health" > /dev/null 2>&1; then
    echo "ready"
    if [[ "${HOLD}" == "true" ]]; then
      trap 'kill "$(cat "$PIDFILE")" 2>/dev/null || true; exit 0' INT TERM EXIT
      while true; do
        sleep 3600 &
        wait $!
      done
    fi
    exit 0
  fi
  sleep 0.5
done

echo "failed_to_ready"
exit 1
