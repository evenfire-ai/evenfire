#!/usr/bin/env bash
# Restart the already-owned local profile under the caller's existing lease.
# After return, the caller must restore forwards with branch-profile-pf and run
# branch-profile-health outside the restart command's bounded process group.
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

wait_for_service_pod() {
  local namespace="$1" service="$2" required="$3" service_json selector pods readiness
  SERVICE_PRESENT=false
  if ! service_json="$(kubectl --context="$PROFILE" --request-timeout=20s -n "$namespace" \
    get svc "$service" --ignore-not-found -o json)"; then
    printf 'ISSUE628_RESTART_READINESS_FAILED: cannot inspect service %s/%s\n' "$namespace" "$service" >&2
    return 1
  fi
  if [[ -z "$service_json" ]]; then
    if [[ "$required" == true ]]; then
      printf 'ISSUE628_RESTART_READINESS_FAILED: required service %s/%s is absent\n' "$namespace" "$service" >&2
      return 1
    fi
    return 0
  fi
  SERVICE_PRESENT=true
  if ! selector="$(jq -er '(.spec.selector // {}) | select(type == "object" and length > 0) | to_entries | map("\(.key)=\(.value)") | join(",")' <<<"$service_json")"; then
    printf 'ISSUE628_RESTART_READINESS_FAILED: service %s/%s has no selector\n' "$namespace" "$service" >&2
    return 1
  fi
  while :; do
    if ! pods="$(kubectl --context="$PROFILE" --request-timeout=20s -n "$namespace" \
      get pods -l "$selector" -o json)"; then
      printf 'ISSUE628_RESTART_READINESS_FAILED: cannot inspect Pods for %s/%s\n' "$namespace" "$service" >&2
      return 1
    fi
    if ! readiness="$(jq -er '
      if (.items | type) != "array" then error("invalid Pod list")
      elif any(.items[]; .metadata.deletionTimestamp == null and .status.phase == "Running" and any(.status.conditions[]?; .type == "Ready" and .status == "True")) then "ready"
      else "waiting" end' <<<"$pods")"; then
      printf 'ISSUE628_RESTART_READINESS_FAILED: invalid Pod list for %s/%s\n' "$namespace" "$service" >&2
      return 1
    fi
    if [[ "$readiness" == ready ]]; then
      return 0
    fi
    if (( SECONDS >= readiness_deadline )); then
      printf 'ISSUE628_RESTART_READINESS_FAILED: no ready Pod for %s/%s\n' "$namespace" "$service" >&2
      return 1
    fi
    sleep 2
  done
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

# Minikube can report a running node before its service Pods are usable. Wait
# for the same services the caller will forward with branch-profile-pf, without
# treating a failed API read as an absent optional service.
readiness_deadline=$((SECONDS + 300))
wait_for_service_pod control-plane control-ui true
wait_for_service_pod profiles profile-ui false
wait_for_service_pod control-plane control-api true
wait_for_service_pod profiles external-rest-api true
wait_for_service_pod profiles member-registration-service false
wait_for_service_pod rpc-proxy rpc-proxy true
wait_for_service_pod registry registry-api false
wait_for_service_pod channels workflow-approval-request-reader false
wait_for_service_pod mcp-host chatllm false
if [[ "$SERVICE_PRESENT" != true ]]; then
  wait_for_service_pod mcp-host mcp-host false
fi
printf 'RESTART_PHASE=workloads-ready\n'
if [[ "$stopped_observed" != true ]]; then
  printf 'ISSUE628_RESTART_STOP_UNOBSERVED: profile restarted but stopped state was not verified\n' >&2
  exit 1
fi
