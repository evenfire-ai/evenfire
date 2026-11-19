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

# The HCC k8sClient prints these lines through hccLogger, one JSON object per
# line. The Recovered line carries the lifecycle generation it starts as
# `ccLifecycleGeneration`; a Completed line carries `mode` and, when the pass
# applied a lifecycle, the generation it applied. The awk below reads the field
# with a POSIX match(), so it runs on BSD awk and on the CI awk.
HCC_LIFECYCLE_GENERATION_AWK='
  function lifecycle_generation(line) {
    if (match(line, /"ccLifecycleGeneration":[0-9]+/) == 0) return -1
    return substr(line, RSTART + 24, RLENGTH - 24) + 0
  }
'

# Succeeds when interruption <cycle> was followed, after a fresh Host LIST and
# the snapshot recovery, by a completed fleet pass over <expected_count> Hosts
# that applied the recovered lifecycle generation (or a later one), or by the
# completed Host-watch recovery convergence pass over that count.
recovery_cycle_used_fresh_host_inventory() {
  local cycle=$1 expected_count=$2
  hcc_recovery_logs | awk \
    -v target="$cycle" -v host_namespace="$HOST_NS" -v expected="$expected_count" \
    "${HCC_LIFECYCLE_GENERATION_AWK}"'
    BEGIN {
      expected_inventory = "Reconciling " expected " Host(s) "
      host_reason = "Host(s) after Host watch recovery convergence"
      succeeded = 0
    }
    /CommunicationChannel watch ended;/ {
      interruptions += 1
      inside = (interruptions == target)
      if (inside) {
        listed = 0
        recovered = 0
        recovered_generation = -1
        pass_ok = 0
        pass_is_host = 0
      }
      next
    }
    inside && index($0, "Listing all Hosts in namespace " host_namespace) > 0 {
      listed = 1
    }
    inside && /Recovered [0-9]+ CommunicationChannel\(s\) into cache/ {
      recovered = 1
      recovered_generation = lifecycle_generation($0)
    }
    # Fleet passes run one at a time and a pass prints its Reconciling line
    # before its Completed line, so each Reconciling line selects the pass the
    # next Completed line reports on. Selection is reset on every Reconciling
    # line: an earlier pass never lends its Host count to a later one.
    inside && /Reconciling [0-9]+ Host\(s\) / {
      pass_ok = listed && recovered && index($0, expected_inventory) > 0
      pass_is_host = index($0, host_reason) > 0
    }
    # The closing quote of the msg field pins the end of the message, as `$`
    # did for the old plain-text line. (This comment is inside the
    # single-quoted awk program: it must not contain a single quote.)
    inside && pass_ok && /"msg":"\[K8s\] Completed Host reconciliation after / {
      # Channel rule: the pass applied the recovered generation or a later one,
      # whatever reason label the scheduler kept for it.
      if (recovered_generation >= 0 &&
        lifecycle_generation($0) >= recovered_generation) {
        succeeded = 1
        exit
      }
      if (pass_is_host &&
        /"msg":"\[K8s\] Completed Host reconciliation after Host watch recovery convergence"/) {
        succeeded = 1
        exit
      }
    }
    END {
      exit succeeded ? 0 : 1
    }
  '
}

# Prints the number of successful fleet passes the recovery cycles in <logs>
# account for. Cycles are delimited by `CommunicationChannel watch ended;`.
# Every Host-watch recovery convergence completion counts 1, inside or outside a
# cycle, and is never counted a second time. After the Recovered line of a
# cycle, any other completion carrying that generation or a later one adds 1
# for the cycle, at most once. Later channel passes of the cycle are not
# counted again, whether they are retries (which resend the generation of the
# pass they retry) or later lifecycle passes. A bound on this count therefore
# limits only the Host-watch recovery passes.
recovery_fleet_pass_count() {
  local logs=$1
  awk "${HCC_LIFECYCLE_GENERATION_AWK}"'
    function close_cycle() {
      if (channel_covered) total += 1
      channel_covered = 0
      recovered_generation = -1
    }
    BEGIN {
      total = 0
      recovered_generation = -1
    }
    /CommunicationChannel watch ended;/ {
      close_cycle()
      inside = 1
      next
    }
    inside && /Recovered [0-9]+ CommunicationChannel\(s\) into cache/ {
      recovered_generation = lifecycle_generation($0)
      next
    }
    /"msg":"\[K8s\] Completed Host reconciliation after Host watch recovery convergence"/ {
      total += 1
      next
    }
    recovered_generation >= 0 &&
      /"msg":"\[K8s\] Completed Host reconciliation after / &&
      lifecycle_generation($0) >= recovered_generation {
      channel_covered = 1
    }
    END {
      close_cycle()
      print total
    }
  ' <<<"$logs"
}

wait_recovery_cycle_fresh_host_inventory() {
  local cycle=$1 expected_count=$2 timeout=$3 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    require_hcc_recovery_log_stream || return 1
    recovery_cycle_used_fresh_host_inventory "$cycle" "$expected_count" && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  hcc_recovery_logs >&2
  return 1
}
