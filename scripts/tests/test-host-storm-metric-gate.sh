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
  local fleet_coalesced=${7:-0} fleet_trailing=${8:-0} fleet_failed=${9:-0}
  cat >"$path" <<EOF
# TYPE clerum_hcc_host_delete_cleanup_total counter
clerum_hcc_host_delete_cleanup_total{outcome="queued"} 0
clerum_hcc_host_delete_cleanup_total{outcome="confirmed"} 0
clerum_hcc_host_delete_cleanup_total{outcome="completed"} 0
clerum_hcc_host_delete_cleanup_total{outcome="retried"} 0
clerum_hcc_host_delete_cleanup_total{outcome="superseded"} 0
# TYPE clerum_hcc_host_fleet_requests_total counter
clerum_hcc_host_fleet_requests_total{result="started"} ${fleet_started}
clerum_hcc_host_fleet_requests_total{result="coalesced"} ${fleet_coalesced}
clerum_hcc_host_fleet_requests_total{result="trailing"} ${fleet_trailing}
clerum_hcc_host_fleet_requests_total{result="failed"} ${fleet_failed}
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
  local wake_post=$1 fleet_completion_proven=${2:-1}
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
  FLEET_COMPLETION_PROVEN="$fleet_completion_proven" \
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

# A7 is fenced to the replacement pod's explicit initial-fleet COMPLETED log.
# A second non-overlapping request can therefore be legitimate activity after
# recovery; an absolute started==1 assertion must not false-red it.
write_metrics "${WORK_DIR}/c2.prom" 0 0 0 0 2
TWO_STARTS_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom")"
grep -Fq 'VERDICT|A7-fleet-recovery-bounded|PASS|' <<<"$TWO_STARTS_OUTPUT" ||
  fail "healthy replacement-pod recovery false-reds when a second sequential fleet request starts"

write_metrics "${WORK_DIR}/c2.prom" 0 0 0 0 0
NO_START_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom")"
grep -Fq 'VERDICT|A7-fleet-recovery-bounded|PASS|' <<<"$NO_START_OUTPUT" ||
  fail "A7 still treats a scheduled counter as stronger than causal completion evidence"

NO_COMPLETION_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom" 0)"
grep -Fq 'VERDICT|A7-fleet-recovery-bounded|FAIL|' <<<"$NO_COMPLETION_OUTPUT" ||
  fail "A7 false-passed without replacement-pod fleet completion evidence"

write_metrics "${WORK_DIR}/c2.prom" 0 0 0 0 2 0 0 1
FAILED_PASS_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom")"
grep -Fq 'VERDICT|A7-fleet-recovery-bounded|FAIL|' <<<"$FAILED_PASS_OUTPUT" ||
  fail "A7 false-passed a failed replacement-pod fleet pass"

write_metrics "${WORK_DIR}/c2.prom" 0 0 0 0 2 1 2
UNBOUNDED_TRAILING_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom")"
grep -Fq 'VERDICT|A7-fleet-recovery-bounded|FAIL|' <<<"$UNBOUNDED_TRAILING_OUTPUT" ||
  fail "A7 false-passed trailing fleet work without a matching coalesced request"

# M8: without the FLEET_METRIC family registered on the running image, counter()
# returns 0 for every result label and A7 would pass vacuously (all-zero looks
# like "no failures"). Strip the family's # TYPE line so it drops out of
# c2_types (mirrors a metric rename / an image that never registered it) and
# assert A7 FAILs on the presence check, not vacuously passes.
write_metrics "${WORK_DIR}/c2.prom" 0 0 0 0 0
grep -v '^# TYPE clerum_hcc_host_fleet_requests_total ' "${WORK_DIR}/c2.prom" \
  >"${WORK_DIR}/c2.nofleet.prom"
mv "${WORK_DIR}/c2.nofleet.prom" "${WORK_DIR}/c2.prom"
MISSING_FAMILY_OUTPUT="$(run_adjudicator "${WORK_DIR}/wake_healthy.prom")"
grep -Fq 'VERDICT|A7-fleet-recovery-bounded|FAIL|' <<<"$MISSING_FAMILY_OUTPUT" ||
  fail "A7 vacuously passed with the FLEET_METRIC family absent from the scrape"
grep -Fq 'not registered on the running image' <<<"$MISSING_FAMILY_OUTPUT" ||
  fail "A7 failed for the wrong reason when the FLEET_METRIC family was absent"

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

# The destructive Host storm must use the same exact-HEAD/profile/fingerprint
# ownership contract and exclusive compare-and-swap lock as every HCC gate.
# shellcheck disable=SC2016
for required in \
  'source "${SCRIPT_DIR}/e2e-lib.sh"' \
  'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"' \
  'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"' \
  'require_branch_owned_hcc_gate "$CONTROL_NS"' \
  'acquire_hcc_watch_gate_lock' \
  'finalize_hcc_watch_gate_lock'; do
  grep -Fq "$required" "$GATE" ||
    fail "Host storm omits shared HCC gate contract: ${required}"
done
grep -Fq '.metadata.labels["minikube.k8s.io/name"] == $context' "$GATE" ||
  fail "Host storm does not bind the node's exact minikube profile label"
grep -Fq 'MINIKUBE_PROFILE must explicitly select context' \
  "${ROOT}/scripts/e2e/_lib/hcc-watch-recovery-fixture.sh" ||
  fail "shared profile ownership helper no longer binds MINIKUBE_PROFILE"

# Branch-owned URLs must come from the selected profile's ports.env. Fixed
# machine-global service or metrics ports are a cross-worktree false-green risk.
grep -Fq 'CLERUM_PROFILE_PORTS_ENV' "$GATE" ||
  fail "Host storm does not load branch-profile port evidence"
grep -Fq 'profile_env_value EXTERNAL_REST_API_URL' "$GATE" ||
  fail "Host storm does not derive External REST from branch ports.env"
grep -Fq 'profile_env_value RPC_PROXY_URL' "$GATE" ||
  fail "Host storm does not derive RPC proxy from branch ports.env"
if grep -Eq '127\.0\.0\.1:(8091|8094|18082)' "$GATE"; then
  fail "Host storm retains a fixed machine-global service or metrics port"
fi
grep -Fq '"pod/${pod}" ":${HCC_PORT}"' "$GATE" ||
  fail "HCC metric scrape no longer asks kubectl for a process-owned random port"

# KEEP_FIXTURES may be useful interactively, but it cannot produce PASS evidence
# or leave a lock-free mutated profile that could later be mistaken for T2.
keep_guard_line="$(grep -nF 'KEEP_FIXTURES=1 is diagnostic-only and cannot produce a probative T2 Host-storm result' "$GATE" | cut -d: -f1)"
branch_gate_line="$(grep -nF 'require_branch_owned_hcc_gate "$CONTROL_NS"' "$GATE" | cut -d: -f1)"
if [[ -z "$keep_guard_line" || -z "$branch_gate_line" ]] ||
   (( keep_guard_line >= branch_gate_line )); then
  fail "KEEP_FIXTURES is not rejected before branch verification and mutation"
fi
if grep -Fq 'leaving fixtures in place' "$GATE"; then
  fail "Host storm can still report through the fixture-retention path"
fi

# Completion must be read from the exact replacement pod and established
# before C1/C2 metric adjudication. Merely observing `started` is not proof.
FLEET_COMPLETION_FUNCTION="$(
  sed -n '/^_replacement_fleet_completed_probe() {$/,/^}$/p' "$GATE"
)"
grep -Fq '"$current_pod" == "$HCC_POD_C"' <<<"$FLEET_COMPLETION_FUNCTION" ||
  fail "fleet completion probe is not fenced to the replacement pod"
grep -Fq '"pod/${HCC_POD_C}"' <<<"$FLEET_COMPLETION_FUNCTION" ||
  fail "fleet completion probe reads a deployment aggregate instead of the replacement pod"
grep -Fq '$HCC_PASS_COMPLETED_MARKER' <<<"$FLEET_COMPLETION_FUNCTION" ||
  fail "fleet completion probe does not require the explicit COMPLETED marker"
grep -Fq '$HCC_PASS_FAILED_MARKER' <<<"$FLEET_COMPLETION_FUNCTION" ||
  fail "fleet completion probe does not fail loud on the explicit FAILED marker"
completion_wait_line="$(grep -nF '"replacement HCC initial Host fleet reconciliation completion"' "$GATE" | cut -d: -f1)"
c1_line="$(grep -nF 'scrape_hcc_metrics "$SCRAPE_C1" "$HCC_POD_C"' "$GATE" | head -n1 | cut -d: -f1)"
if [[ -z "$completion_wait_line" || -z "$c1_line" ]] ||
   (( completion_wait_line >= c1_line )); then
  fail "replacement fleet completion is not causally established before post-recovery metrics"
fi

echo "PASS: host-storm oracle binds exact branch/profile ownership, shared fault locking, random endpoints, wake generation, and causal fleet completion"
