#!/usr/bin/env bash
# 1Hz /ready sampling and wall-clock series metrics for the HCC readiness gates.
#
# Extracted verbatim from scripts/e2e/e2e-hcc-watch-churn-readiness.sh (the
# sampler that certified the watch-churn gate) so sibling gates can reuse the
# IDENTICAL measurement semantics without duplicating them. The churn gate still
# carries its own inline copy on purpose: it is live-certified and its contract
# gate pins its file, so it stays byte-stable; NEW gates must source this file
# instead of copying the functions again.
#
# Contract (globals owned by the sourcing gate):
#   HCC_NS, HCC_DEPLOY  — namespace / deployment under observation
#   READY_SERIES        — file collecting "<epoch> <status> <phase>" lines
#   last_status         — global updated by sample_ready_series on every sample
#   kctl                — context-pinned kubectl wrapper (from e2e-lib.sh)

wait_until() {
  local timeout=$1 description=$2
  shift 2
  local deadline now
  deadline=$(($(date +%s) + timeout))
  while :; do
    "$@" && return 0
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

running_hcc_pod() {
  local rows
  rows="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null)" || return 1
  awk -F '\t' '$1 != "" && $2 == "" { print $1; exit }' <<<"$rows"
}

hcc_pods_absent() {
  local pods
  pods="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o name 2>/dev/null)" || return 1
  [ -z "$pods" ]
}

ready_status() {
  local pod=$1
  kctl exec "pod/$pod" -n "$HCC_NS" -c host-context-controller -- \
    wget -T 10 -t 1 -qO- http://127.0.0.1:8081/ready >/dev/null 2>&1 && echo 200 || echo 503
}

hcc_restart_count() {
  local pod=$1
  kctl get pod "$pod" -n "$HCC_NS" \
    -o jsonpath='{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}' 2>/dev/null
}

# sample_ready_series DURATION_SEC PHASE STOP_ON_READY
# Appends "<epoch> <status> <phase>" lines to READY_SERIES at ~1Hz (each probe
# is an exec round-trip, so real spacing is 1-2s; all streak math uses the
# recorded timestamps, never sample counts). A missing or terminating pod is
# recorded as 503: a crash-looping or unscheduled HCC is DOWN, and hiding that
# would let an outage impersonate recovery. STOP_ON_READY=1 returns at the
# first 200 sample (readiness search); 0 runs the full duration (observation).
sample_ready_series() {
  local duration=$1 phase=$2 stop_on_ready=$3
  local s_deadline t0 now pod status
  s_deadline=$(($(date +%s) + duration))
  while t0="$(date +%s)"; [ "$t0" -lt "$s_deadline" ]; do
    status=503
    if pod="$(running_hcc_pod)" && [ -n "$pod" ]; then
      status="$(ready_status "$pod")"
    fi
    printf '%s %s %s\n' "$t0" "$status" "$phase" >>"$READY_SERIES"
    last_status="$status"
    if [ "$status" = 200 ] && [ "$stop_on_ready" = 1 ]; then
      return 0
    fi
    now="$(date +%s)"
    [ $((now - t0)) -ge 1 ] || sleep 1
  done
  return 0
}

# series_metrics PHASE -> prints "total n200 n503 max503streak_sec transitions"
# for that phase slice. A 503 streak is measured in wall seconds from its first
# 503 sample to the next 200 sample (or to end-of-slice + 1s if it never
# closed); transitions counts distinct 503->200 recoveries.
series_metrics() {
  awk -v phase="$1" '
    $3 == phase {
      total += 1
      if ($2 == 200) {
        n200 += 1
        if (in503) {
          streak = $1 - streak_start
          if (streak > max_streak) max_streak = streak
          transitions += 1
          in503 = 0
        }
      } else {
        n503 += 1
        if (!in503) { in503 = 1; streak_start = $1 }
      }
      last_ts = $1
    }
    END {
      if (in503) {
        streak = last_ts + 1 - streak_start
        if (streak > max_streak) max_streak = streak
      }
      printf "%d %d %d %d %d\n", total + 0, n200 + 0, n503 + 0, max_streak + 0, transitions + 0
    }' "$READY_SERIES"
}

# first_200_epoch PHASE -> epoch of the first 200 sample in that phase, if any.
first_200_epoch() {
  awk -v phase="$1" '$3 == phase && $2 == 200 { print $1; exit }' "$READY_SERIES"
}
