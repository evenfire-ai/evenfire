#!/usr/bin/env bash
# Restart the already-owned local profile under the caller's existing lease.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROFILE="${MINIKUBE_PROFILE:-}"

if [[ ! "$PROFILE" =~ ^clerum-[a-z0-9][a-z0-9._-]*-[0-9a-f]{7,8}$ ]] ||
   [[ "${CONTROL_API_REAL_PG_CONTEXT:-}" != "$PROFILE" ]] ||
   [[ "${T2_PROFILE:-}" != "$PROFILE" || "${T2_CONTEXT:-}" != "$PROFILE" ]] ||
   [[ "${T2_GATE_ID:-}" != issue628-profile-restart ]] ||
   [[ "${T2_MUTATION_LOCK_WRAPPED:-}" != true || "${T2_SKIP_LOCK:-}" != true ]]; then
  printf 'ISSUE628_RESTART_SCOPE_REQUIRED: an owned local profile and its restart lease are required\n' >&2
  exit 1
fi

require_lease() {
  T2_PROJECT_DIR="$ROOT" T2_PROFILE="$PROFILE" T2_CONTEXT="$PROFILE" \
    bash "$ROOT/scripts/minikube/require-t2-mutation-lock.sh"
}

branch_profile() {
  make -f "$ROOT/scripts/minikube-profiles/branch.mk" "$1"
}

minikube_check() {
  node "$ROOT/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 30 --label issue628-minikube-check -- \
    minikube -p "$PROFILE" "$@"
}

require_lease
branch_profile branch-profile-health
before_ip="$(minikube_check ip)"
[[ -n "$before_ip" ]] || { printf 'ISSUE628_RESTART_IP_UNKNOWN\n' >&2; exit 1; }
printf 'NODE_IP_BEFORE=%s\n' "$before_ip"

printf 'RESTART_PHASE=stop-requested\n'
if ! branch_profile branch-profile-stop; then
  printf 'ISSUE628_RESTART_STOP_FAILED: the profile may already be stopped\n' >&2
  exit 1
fi
status_json="$(minikube_check status -o json 2>/dev/null)" || true
stopped_observed=false
if jq -e '.Host == "Stopped"' <<<"$status_json" >/dev/null 2>&1; then
  stopped_observed=true
  printf 'RESTART_PHASE=stopped\n'
fi

# The outer wrapper remains alive while the profile is stopped. Its ordinary
# status-checking wrapper cannot be re-entered until after the profile starts.
require_lease
printf 'RESTART_PHASE=start-requested\n'
if ! branch_profile branch-profile-start; then
  printf 'ISSUE628_RESTART_START_FAILED: preserve the profile for diagnosis\n' >&2
  exit 1
fi
after_ip="$(minikube_check ip)"
printf 'NODE_IP_AFTER=%s\n' "$after_ip"
if [[ -z "$after_ip" || "$after_ip" != "$before_ip" ]]; then
  printf 'ISSUE628_RESTART_IP_CHANGED: do not repair during the persistence observation\n' >&2
  exit 1
fi
printf 'RESTART_PHASE=running\n'
branch_profile branch-profile-pf
branch_profile branch-profile-health
if [[ "$stopped_observed" != true ]]; then
  printf 'ISSUE628_RESTART_STOP_UNOBSERVED: profile restarted but stopped state was not verified\n' >&2
  exit 1
fi
