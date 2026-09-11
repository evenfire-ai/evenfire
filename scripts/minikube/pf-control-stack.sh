#!/usr/bin/env bash
# Port-forwards required for Playwright e2e tests
# - control-ui on :3000
# - control-api on :8090
# Writes PIDs to /tmp/pf-*.pid for later cleanup.

set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-${KUBECONTEXT:-}}"
if [ -z "$PROFILE" ]; then
  echo 'ERROR: MINIKUBE_PROFILE or KUBECONTEXT is required; refusing a context-less port-forward' >&2
  exit 1
fi
KC=(kubectl --context="$PROFILE")
SAFE_PROFILE="$(printf '%s' "$PROFILE" | tr -c 'A-Za-z0-9_.-' '_')"
CONTROL_UI_PORT="${CONTROL_UI_PORT:-3000}"
CONTROL_API_PORT="${CONTROL_API_PORT:-8090}"
LOCALHOST="localhost"
if [[ "$PROFILE" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]] && {
  [ "$CONTROL_UI_PORT" = 3000 ] || [ "$CONTROL_API_PORT" = 8090 ];
}; then
  echo "ERROR: branch-owned profile $PROFILE requires profile-owned CONTROL_UI_PORT and CONTROL_API_PORT" >&2
  exit 1
fi

start_pf() {
  local name=$1 ns=$2 svc=$3 ports=$4
  local log=/tmp/pf-${SAFE_PROFILE}-${name}.log
  local pidfile=/tmp/pf-${SAFE_PROFILE}-${name}.pid
  local pid expected_start actual_start process_start

  # Kill previous only when both the command identity and process-start
  # signature match; a recycled PID must never be treated as ours.
  if [[ -f "$pidfile" ]]; then
    pid="$(sed -n '1p' "$pidfile" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
      command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      expected_start="$(sed -n 's/^PROCESS_START=//p' "$pidfile" 2>/dev/null | head -1 || true)"
      if [[ "$command_line" != *port-forward* || "$command_line" != *"svc/$svc"* ||
            "$command_line" != *"$PROFILE"* || -z "$expected_start" ]]; then
        echo "ERROR: refusing to kill PID $pid from $pidfile; it is not the signed $PROFILE $svc port-forward" >&2
        exit 1
      fi
      if [[ "$expected_start" != unavailable ]]; then
        actual_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
        [[ -n "$actual_start" && "$actual_start" == "$expected_start" ]] || {
          echo "ERROR: refusing to kill PID $pid from $pidfile; its process-start signature changed" >&2
          exit 1
        }
      fi
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi

  "${KC[@]}" -n "$ns" port-forward --address=127.0.0.1 "svc/$svc" "$ports" > "$log" 2>&1 &
  pid=$!
  process_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  [ -n "$process_start" ] || process_start=unavailable
  printf '%s\nPROCESS_START=%s\n' "$pid" "$process_start" > "$pidfile"
  echo "  $name: pid=$(cat "$pidfile") ns=$ns svc=$svc ports=$ports"
}

echo "=== Starting port-forwards ==="
start_pf control-ui  control-plane control-ui   "${CONTROL_UI_PORT}:3000"
start_pf control-api control-plane control-api  "${CONTROL_API_PORT}:8090"

echo "=== Waiting 5s for tunnels to warm up ==="
sleep 5

echo "=== Health checks ==="
if curl -sf -m 3 "http://${LOCALHOST}:${CONTROL_UI_PORT}" >/dev/null 2>&1; then
  echo "  control-ui: UP"
else
  echo "  control-ui: DOWN (may take longer, retry in a few seconds)"
fi
if curl -sf -m 3 "http://${LOCALHOST}:${CONTROL_API_PORT}/health" >/dev/null 2>&1; then
  echo "  control-api: UP"
else
  echo "  control-api: DOWN (may take longer, retry in a few seconds)"
fi

echo "=== DONE ==="
