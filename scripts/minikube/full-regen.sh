#!/usr/bin/env bash
# Full cluster regen: kill PFs → minikube delete → minikube-setup
# Used by Phase 2 final validation after rename

set -eo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== STEP 1: Kill existing port-forwards ==="
for pidfile in /tmp/pf-*.pid; do
  [[ -f "$pidfile" ]] || continue
  pid=$(cat "$pidfile" 2>/dev/null || echo "")
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "  killed PF pid=$pid from $(basename "$pidfile")"
  fi
  rm -f "$pidfile"
done

# Also kill any stray kubectl port-forward procs
pkill -f "kubectl.*port-forward" 2>/dev/null || true

echo "=== STEP 2: Minikube delete (profile=$PROFILE) ==="
minikube delete -p "$PROFILE" 2>&1 | tail -5 || true

echo "=== STEP 3: Fresh minikube setup (make minikube-setup) ==="
cd "$REPO_ROOT"
make minikube-setup 2>&1 | tail -40

echo "=== STEP 4: Verify registry namespace (new) ==="
kubectl get namespaces 2>&1 | grep -E "^(registry|clerum-registry)" || echo "  (no matches)"
kubectl -n registry get pods --no-headers 2>&1 | head -5

echo "=== DONE ==="
