#!/usr/bin/env bash
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
# Literal source assertions intentionally match unexpanded shell variables.
# shellcheck disable=SC2016
if ! grep -Fq '"$current_pod" == "$HCC_POD_WAKE"' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq '"$lifecycle_state" != '\''suspended'\''' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq 'metric="${IN_FLIGHT_METRIC}"' <<<"$WAKE_EVIDENCE_FUNCTION" ||
   ! grep -Fq '(after - before) >= 1 && active == 0' <<<"$WAKE_EVIDENCE_FUNCTION"; then
  fail "runtime wake evidence is not fenced to the same pod, completed lifecycle, metric delta, and idle urgent lane"
fi

echo "PASS: host-storm metric oracle rejects a slow wake hidden by later fast probes"
