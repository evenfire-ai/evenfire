#!/usr/bin/env bash
# shellcheck disable=SC2016  # literal source-contract assertions below
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-host-storm-gate.sh"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/host-storm-metric-test.XXXXXX")"
ADJUDICATOR="${WORK_DIR}/adjudicator.py"
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

extract_adjudicator() {
  awk '
    /python3 >"\$METRIC_VERDICTS" <<'\''PY'\''/ { capture = 1; next }
    capture && /^PY$/ { exit }
    capture { print }
  ' "$GATE" >"$ADJUDICATOR"
  [ -s "$ADJUDICATOR" ] || fail "could not extract host-storm metric adjudicator"
}

write_metrics() {
  local path=$1 le_05=$2 le_5=$3 le_15=$4 total=$5 fleet_started=${6:-0}
  cat >"$path" <<EOF
# TYPE clerum_hcc_host_delete_cleanup_total counter
clerum_hcc_host_delete_cleanup_total{outcome="queued"} 0
clerum_hcc_host_delete_cleanup_total{outcome="confirmed"} 0
clerum_hcc_host_delete_cleanup_total{outcome="completed"} 0
clerum_hcc_host_delete_cleanup_total{outcome="retried"} 0
clerum_hcc_host_delete_cleanup_total{outcome="superseded"} 0
clerum_hcc_host_fleet_requests_total{result="started"} ${fleet_started}
clerum_hcc_host_fleet_requests_total{result="coalesced"} 0
clerum_hcc_host_fleet_requests_total{result="trailing"} 0
clerum_hcc_host_fleet_requests_total{result="failed"} 0
clerum_hcc_host_reconcile_queue_wait_seconds_bucket{lane="urgent",outcome="success",le="0.5"} ${le_05}
clerum_hcc_host_reconcile_queue_wait_seconds_bucket{lane="urgent",outcome="success",le="5"} ${le_5}
clerum_hcc_host_reconcile_queue_wait_seconds_bucket{lane="urgent",outcome="success",le="15"} ${le_15}
clerum_hcc_host_reconcile_queue_wait_seconds_bucket{lane="urgent",outcome="success",le="+Inf"} ${total}
EOF
}

extract_adjudicator

for scrape in a b c1 c2 d wake_pre wake_post; do
  write_metrics "${WORK_DIR}/${scrape}.prom" 0 0 0 0
done

cat >>"${WORK_DIR}/c1.prom" <<'EOF'
clerum_hcc_host_watch_recovery_seconds_bucket{phase="total",outcome="success",le="15"} 1
clerum_hcc_host_watch_recovery_seconds_bucket{phase="total",outcome="success",le="+Inf"} 1
clerum_hcc_host_watch_recovery_seconds_bucket{phase="total",outcome="failure",le="+Inf"} 0
EOF

write_metrics "${WORK_DIR}/c2.prom" 0 0 0 0 1

# The post-recovery direct-watch window is healthy.
write_metrics "${WORK_DIR}/d.prom" 10 10 10 10

# The wake window contains one sample over the 5s hard gate plus nineteen
# fast samples. A combined p95 would be green (19/20 == 95%), but the
# supported wake journey violated its binding urgent queue budget.
write_metrics "${WORK_DIR}/wake_post.prom" 19 19 20 20

run_adjudicator() {
  local wake_post=$1
  SCRAPE_A="${WORK_DIR}/a.prom" \
  SCRAPE_B="${WORK_DIR}/b.prom" \
  SCRAPE_C1="${WORK_DIR}/c1.prom" \
  SCRAPE_C2="${WORK_DIR}/c2.prom" \
  SCRAPE_D="${WORK_DIR}/d.prom" \
  SCRAPE_WAKE_PRE="${WORK_DIR}/wake_pre.prom" \
  SCRAPE_WAKE_POST="$wake_post" \
  QUEUE_WAIT_METRIC=clerum_hcc_host_reconcile_queue_wait_seconds \
  WATCH_RECOVERY_METRIC=clerum_hcc_host_watch_recovery_seconds \
  FLEET_METRIC=clerum_hcc_host_fleet_requests_total \
  DELETE_CLEANUP_METRIC=clerum_hcc_host_delete_cleanup_total \
  P95_BUDGET_S=5 \
  RECOVERY_BUDGET_S=15 \
  MIN_URGENT_SAMPLES=10 \
  python3 "$ADJUDICATOR"
}

OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_post.prom")"

if ! grep -Fq 'VERDICT|A2-direct-watch-urgent-p95|PASS|' <<<"$OUTPUT" &&
   ! grep -Fq 'VERDICT|A2-urgent-queue-wait-p95|PASS|' <<<"$OUTPUT"; then
  fail "healthy post-recovery direct-watch window did not pass"
fi
grep -Fq 'VERDICT|A2-wake-urgent-hard-gate|FAIL|' <<<"$OUTPUT" ||
  fail "slow wake window was diluted into a false PASS"

write_metrics "${WORK_DIR}/wake_healthy.prom" 20 20 20 20
HEALTHY_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom")"
grep -Fq 'VERDICT|A2-wake-urgent-hard-gate|PASS|' <<<"$HEALTHY_OUTPUT" ||
  fail "healthy wake window did not pass its hard gate"

WAKE_EVIDENCE_FUNCTION="$(
  sed -n '/^_wake_urgent_evidence_recorded() {$/,/^}$/p' "$GATE"
)"
WAKE_GENERATION_FUNCTION="$(
  sed -n '/^wake_generation_is_handled() {$/,/^}$/p' "$GATE"
)"
POST_WAKE_FUNCTION="$(
  sed -n '/^post_wake() {$/,/^}$/p' "$GATE"
)"

[[ -n "$WAKE_GENERATION_FUNCTION" ]] ||
  fail "runtime wake evidence has no generation-correlation predicate"

# Exercise the exact pure predicate embedded in the E2E gate. The requested
# generation is the business identifier returned by the public wake route;
# an older handled generation must never satisfy that request.
eval "$WAKE_GENERATION_FUNCTION"
if wake_generation_is_handled 7 6; then
  fail "wake generation predicate accepted an older handled generation"
fi
wake_generation_is_handled 7 7 ||
  fail "wake generation predicate rejected the exact handled generation"
wake_generation_is_handled 7 8 ||
  fail "wake generation predicate rejected a newer handled generation"
if wake_generation_is_handled 0 8 || wake_generation_is_handled invalid 8 ||
   wake_generation_is_handled 7 invalid; then
  fail "wake generation predicate accepted malformed generation evidence"
fi

# Literal source assertions intentionally match unexpanded shell variables.
# shellcheck disable=SC2016
if ! grep -Fq '"$current_pod" == "$HCC_POD_WAKE"' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq '"$lifecycle_state" != '\''suspended'\''' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq 'handled_generation="$(wake_handled_generation)"' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq 'wake_generation_is_handled "$WAKE_GENERATION" "$handled_generation"' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq 'metric="${IN_FLIGHT_METRIC}"' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq '(after - before) >= 1 && active == 0' <<<"$WAKE_EVIDENCE_FUNCTION"; then
  fail "runtime wake evidence is not fenced to the same pod, requested generation, metric delta, and idle urgent lane"
fi
generation_check_line="$(
  grep -nF 'wake_generation_is_handled "$WAKE_GENERATION" "$handled_generation"' \
    <<<"$WAKE_EVIDENCE_FUNCTION" | cut -d: -f1
)"
metrics_scrape_line="$(
  grep -nF 'scrape_hcc_metrics "$SCRAPE_WAKE_POST" "$HCC_POD_WAKE"' \
    <<<"$WAKE_EVIDENCE_FUNCTION" | head -n1 | cut -d: -f1
)"
if [[ -z "$generation_check_line" || -z "$metrics_scrape_line" ]] ||
   (( generation_check_line >= metrics_scrape_line )); then
  fail "wake generation is not correlated before accepting shared urgent metrics"
fi
wake_scrape_count="$(
  grep -Fc 'scrape_hcc_metrics "$SCRAPE_WAKE_POST" "$HCC_POD_WAKE"' \
    <<<"$WAKE_EVIDENCE_FUNCTION"
)"
if (( wake_scrape_count < 2 )) ||
   ! grep -Fq 'fence_in_flight=' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq 'active == 0' <<<"$WAKE_EVIDENCE_FUNCTION"; then
  fail "wake evidence lacks a completed-lane fence followed by a fresh metric scrape"
fi

# shellcheck disable=SC2016
if ! grep -Fq 'WAKE_GENERATION=' <<<"$POST_WAKE_FUNCTION" ||
   ! grep -Fq '"$WAKE_STATUS" == '\''202'\''' <<<"$POST_WAKE_FUNCTION" ||
   ! grep -Fq '.status // empty' <<<"$POST_WAKE_FUNCTION" ||
   ! grep -Fq '.wakeGeneration // empty' <<<"$POST_WAKE_FUNCTION"; then
  fail "public wake response is not validated as an accepted wake-generation contract"
fi

# A7 must start from a fresh scrape immediately before the kill. Reusing the
# earlier wake-evidence scrape creates an unobserved interval in which a fleet
# failure could occur and escape the pre/post recovery counter delta.
# shellcheck disable=SC2016
if ! grep -Fq 'scrape_hcc_metrics "$SCRAPE_B" "$HCC_POD_B"' "$GATE" ||
   grep -Fq 'cp "$SCRAPE_WAKE_POST" "$SCRAPE_B"' "$GATE"; then
  fail "pre-kill scrape B is not freshly captured after wake adjudication"
fi
fresh_scrape_line="$(
  grep -nF 'scrape_hcc_metrics "$SCRAPE_B" "$HCC_POD_B"' "$GATE" | cut -d: -f1
)"
kill_line="$(grep -nF 'T_KILL_MS="$(now_ms)"' "$GATE" | cut -d: -f1)"
if [[ -z "$fresh_scrape_line" || -z "$kill_line" ]] ||
   (( fresh_scrape_line >= kill_line )); then
  fail "fresh scrape B does not precede the HCC kill"
fi

echo "PASS: host-storm oracle binds wake generation, fences metrics, and refreshes the pre-kill baseline"
