#!/usr/bin/env bash

# Log capture and causal recovery-cycle assertions for the HCC watch gate.

hcc_log_snapshot_contains() {
  local snapshot=$1 marker=$2
  grep -Fq -- "$marker" <<<"$snapshot"
}

hcc_initial_pass_snapshot_is_active() {
  local snapshot=$1 start_marker=$2 complete_marker=$3 fail_marker=$4
  hcc_log_snapshot_contains "$snapshot" "$start_marker" &&
    ! hcc_log_snapshot_contains "$snapshot" "$complete_marker" &&
    ! hcc_log_snapshot_contains "$snapshot" "$fail_marker"
}

hcc_recovery_logs() {
  [ -n "$START_TIME" ] || return 0
  grep -E 'CommunicationChannel|Listing all Hosts|Reconciling [0-9]+ Host|Completed Host reconciliation|Periodic resync' \
    "$HCC_LOG_BUFFER" || true
}

start_hcc_recovery_log_stream() {
  : >"$HCC_LOG_BUFFER"
  "$KUBECTL_BIN" --context "$E2E_KUBECONTEXT" logs -f "deployment/${HCC_DEPLOY}" \
    -n "$HCC_NS" --since-time="$START_TIME" >"$HCC_LOG_BUFFER" 2>&1 &
  HCC_LOG_STREAM_PID=$!
}

stop_hcc_recovery_log_stream() {
  [ -n "$HCC_LOG_STREAM_PID" ] || return 0
  kill "$HCC_LOG_STREAM_PID" >/dev/null 2>&1 || true
  wait "$HCC_LOG_STREAM_PID" 2>/dev/null || true
  HCC_LOG_STREAM_PID=""
}

require_hcc_recovery_log_stream() {
  local stream_status
  [ -n "$HCC_LOG_STREAM_PID" ] || {
    echo "HCC log stream is not initialized" >&2
    return 1
  }
  kill -0 "$HCC_LOG_STREAM_PID" >/dev/null 2>&1 && return 0
  if wait "$HCC_LOG_STREAM_PID" 2>/dev/null; then
    stream_status=0
  else
    stream_status=$?
  fi
  HCC_LOG_STREAM_PID=""
  echo "HCC log stream exited before gate completion (exit=${stream_status})" >&2
  return 1
}

log_count() { hcc_recovery_logs | grep -Ec "$1" || true; }
log_count_from() { grep -Ec "$2" <<<"$1" || true; }

wait_log_count() {
  local pattern=$1 expected=$2 timeout=$3 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    require_hcc_recovery_log_stream || return 1
    [ "$(log_count "$pattern")" -ge "$expected" ] && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  hcc_recovery_logs >&2
  return 1
}

recovery_cycle_used_fresh_host_inventory() {
  local cycle=$1 expected_count=$2
  hcc_recovery_logs | awk \
    -v target="$cycle" -v host_namespace="$HOST_NS" -v expected="$expected_count" '
    BEGIN {
      inventory_line = "Reconciling " expected " Host(s) for lifecycle after CommunicationChannel recovery"
      succeeded = 0
    }
    /CommunicationChannel watch ended;/ {
      interruptions += 1
      inside = (interruptions == target)
      if (inside) {
        listed = 0
        recovered = 0
        inventory_matched = 0
      }
      next
    }
    inside && index($0, "Listing all Hosts in namespace " host_namespace) > 0 {
      listed = 1
    }
    inside && /Recovered [0-9]+ CommunicationChannel\(s\) into cache/ {
      recovered = 1
    }
    inside && index($0, inventory_line) > 0 {
      inventory_matched = 1
    }
    inside && /Completed Host reconciliation after CommunicationChannel recovery$/ {
      succeeded = listed && recovered && inventory_matched
      exit
    }
    END {
      exit succeeded ? 0 : 1
    }
  '
}
