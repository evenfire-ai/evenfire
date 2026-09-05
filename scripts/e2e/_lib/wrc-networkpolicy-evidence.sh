#!/usr/bin/env bash

# Evidence helpers shared by the WRC journey and its hermetic contracts.
# Kubernetes operations use the caller's context-bound kctl function.
WRC_EVIDENCE_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wrc-networkpolicy-evidence.py"

is_kubernetes_deletion_timestamp() {
  python3 "$WRC_EVIDENCE_PY" timestamp "$1"
}

wait_for_resource_absent() {
  local kind=$1 namespace=$2 name=$3 timeout=$4 elapsed=0 observed
  while [ "$elapsed" -lt "$timeout" ]; do
    # kubectl suppresses only NotFound here. Forbidden, transport and server
    # failures remain nonzero and must never certify absence.
    if ! observed="$(kctl get "$kind" "$name" -n "$namespace" --ignore-not-found -o json)"; then
      fail "Could not observe ${kind} ${namespace}/${name}"
      return 1
    fi
    [ "$(classify_kubernetes_get_observation 0 "$observed")" = "absent" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

release_held_policy_finalizer() {
  [ -n "$HELD_POLICY_NS" ] && [ -n "$HELD_POLICY_NAME" ] && [ -n "$HELD_POLICY_UID" ] || return 0
  local observed patch
  observed="$(kctl get networkpolicy "$HELD_POLICY_NAME" -n "$HELD_POLICY_NS" -o json)" || return 1
  patch="$(python3 "$WRC_EVIDENCE_PY" barrier-patch release "$HELD_POLICY_UID" "$observed" "$FINALIZER_HOLD")" || return 1
  # UID/RV tests bind removal to the observed incarnation and preserve every
  # foreign finalizer. A concurrent edit fails closed rather than being erased.
  kctl patch networkpolicy "$HELD_POLICY_NAME" -n "$HELD_POLICY_NS" --type=json -p "$patch" >/dev/null || return 1
  HELD_POLICY_NS=""
  HELD_POLICY_NAME=""
  HELD_POLICY_UID=""
}

probe_tcp_result() {
  local target=$1 host=$2 port=$3 result
  # The remote shell always reports a completed probe with exit zero. An exec
  # transport failure or a missing nc cannot impersonate a connect timeout.
  # BusyBox nc -z exits after connect, without waiting for an HTTP response.
  # -v is required by NC_110_COMPAT to report ETIMEDOUT; otherwise a refused
  # connection and a timeout both produce silent exit 1. -n avoids reverse DNS.
  # Variables belong to the remote shell.
  # shellcheck disable=SC2016
  if ! result="$(kctl exec "$target" -n "$SANDBOX_NS" -- sh -c '
    command -v nc >/dev/null 2>&1 || { printf "WRC_TCP_ERROR\n"; exit 0; }
    if output=$(LC_ALL=C nc -n -z -v -w "$1" "$2" "$3" 2>&1); then
      printf "WRC_TCP_CONNECTED\n"
    else
      case "$output" in
        *"timed out"*) printf "WRC_TCP_CONNECT_TIMEOUT\n" ;;
        *) printf "WRC_TCP_ERROR\n" ;;
      esac
    fi
  ' sh "$CONNECT_TIMEOUT" "$host" "$port")"; then
    return 1
  fi
  case "$result" in
    WRC_TCP_CONNECTED|WRC_TCP_CONNECT_TIMEOUT) printf '%s\n' "$result" ;;
    *) return 1 ;;
  esac
}

finalizer_failure_count() {
  local since=$1 logs
  # Only the count leaves this function. Raw controller logs may contain
  # unrelated runtime data and must not be emitted into E2E evidence.
  logs="$(kctl logs -n "$CONTROL_NS" -l app=workflow-recipes -c workflow-recipes \
    --since-time="$since" --timestamps=true --tail=-1 --limit-bytes=1048576 2>/dev/null)" || return 1
  printf '%s\n' "$logs" | python3 "$WRC_EVIDENCE_PY" finalizer-failure-count "$RECIPE_NAME" "$since"
}

classify_kubernetes_get_observation() {
  local status=$1 output=$2
  if [ "$status" -ne 0 ]; then
    printf '%s\n' error
  elif [ -z "$output" ]; then
    printf '%s\n' absent
  else
    printf '%s\n' present
  fi
}
