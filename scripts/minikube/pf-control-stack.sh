#!/usr/bin/env bash
# Port-forwards required for Playwright e2e tests
# - control-ui on :3000
# - control-api on :8090
# Writes PIDs to /tmp/pf-*.pid for later cleanup.

set -eo pipefail

start_pf() {
  local name=$1 ns=$2 svc=$3 ports=$4
  local log=/tmp/pf-$name.log
  local pidfile=/tmp/pf-$name.pid

  # Kill previous
  if [[ -f "$pidfile" ]]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi

  kubectl -n "$ns" port-forward "svc/$svc" "$ports" > "$log" 2>&1 &
  echo $! > "$pidfile"
  echo "  $name: pid=$(cat "$pidfile") ns=$ns svc=$svc ports=$ports"
}

echo "=== Starting port-forwards ==="
start_pf control-ui  control-plane control-ui   3000:3000
start_pf control-api control-plane control-api  8090:8090

echo "=== Waiting 5s for tunnels to warm up ==="
sleep 5

echo "=== Health checks ==="
if curl -sf -m 3 http://localhost:3000 >/dev/null 2>&1; then
  echo "  control-ui: UP"
else
  echo "  control-ui: DOWN (may take longer, retry in a few seconds)"
fi
if curl -sf -m 3 http://localhost:8090/health >/dev/null 2>&1; then
  echo "  control-api: UP"
else
  echo "  control-api: DOWN (may take longer, retry in a few seconds)"
fi

echo "=== DONE ==="
