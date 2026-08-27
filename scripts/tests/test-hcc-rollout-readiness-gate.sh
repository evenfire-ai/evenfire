#!/usr/bin/env bash
# Offline contract gate for the HCC rollout readiness e2e (the `strategy:
# Recreate` + `replicas: 1` node-upgrade / rollout window behind decision D1/c4
# of PR #382). Runs in CI: no cluster. Pins the gate's fail-loud, branch-scoped,
# restorable shape — the measured-window assertion, the pod-replacement
# anti-vacuity, the botched-rollout (D1b) mode, and the guard/lock/restore
# contract — so a refactor cannot quietly gut the only test that MEASURES the
# Recreate downtime window instead of estimating it.
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-hcc-rollout-readiness.sh"
SAMPLER="${ROOT}/scripts/e2e/_lib/hcc-ready-series.sh"
pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

for s in "$GATE" "$SAMPLER"; do
  bash -n "$s" && pass "$(basename "$s") valid bash" || fail "$(basename "$s") invalid bash"
done

# 1. Premise pinning: the gate refuses to measure anything but Recreate with a
#    single replica — a RollingUpdate or multi-replica HCC would make every
#    number it reports meaningless for D1/c4.
grep -Fq 'expected strategy Recreate' "$GATE" &&
  grep -Fq 'rollingUpdate' "$GATE" &&
  grep -Fq 'expected exactly one HCC replica' "$GATE" &&
  pass "gate pins the Recreate + replicas:1 premise before mutating anything" ||
  fail "gate can run against a deployment that is not the D1/c4 scenario"

# 2. The healthy rollout is driven through the Deployment machinery (rollout
#    restart respects Recreate), never a bare pod delete that bypasses it.
grep -Fq 'rollout restart' "$GATE" &&
  pass "healthy mode drives a real Recreate rollout (kubectl rollout restart)" ||
  fail "gate does not trigger the rollout through the Deployment controller"

# 3. Measured window: the wall-clock 503 streak across the rollout is asserted
#    against a budget that is parameterized with an explicit default.
grep -Eq 'roll_maxstreak.*-le.*ROLLOUT_DOWNTIME_BUDGET_SEC' "$GATE" &&
  grep -Eq 'ROLLOUT_DOWNTIME_BUDGET_SEC:-[0-9]{2,4}' "$GATE" &&
  pass "downtime window is measured and bounded by a parameterized budget" ||
  fail "gate lost the measured-window assertion or hardcodes the budget"

# 4. Anti-vacuity: the rollout must bite (>= 1 in-rollout 503 sample) and the
#    pod must be REPLACED (new uid, fresh restartCount) — the inverse of the
#    churn gate's in-situ pin: here a NON-replaced pod means nothing rolled.
grep -Eq 'roll_503.*-ge.*1' "$GATE" &&
  grep -Eq 'NEW_POD_UID.*!=.*OLD_POD_UID' "$GATE" &&
  grep -Fq 'restartCount' "$GATE" &&
  pass "anti-vacuity: 503 bite + pod replacement (uid) + fresh-boot restartCount" ||
  fail "the window claim can pass vacuously (no cut, or the same pod re-certifying)"

# 5. Baseline gating + zero-sample guards (zero-tests-is-never-success): the
#    measurement must start from a clean 200 baseline, and an empty series can
#    never pass — print_results carries the shared total>0 fence.
grep -Eq 'baseline_503.*-eq.*0' "$GATE" &&
  grep -Eq 'roll_total.*-gt.*0' "$GATE" &&
  grep -Eq 'stuck_total.*-gt.*0' "$GATE" &&
  grep -Fq 'e2e-lib.sh' "$GATE" &&
  grep -Fq 'print_results' "$GATE" &&
  pass "baseline must be clean and zero-sample runs can never pass" ||
  fail "gate can measure from a dirty baseline or pass over an empty series"

# 6. Botched-rollout (D1b) mode: bounded observation, the outage pinned to the
#    injected ImagePull failure, sustained past the healthy budget, and NEVER
#    self-healing (zero 503->200 transitions).
grep -Fq 'EXPECT_STUCK' "$GATE" &&
  grep -Fq 'STUCK_OBSERVE_SEC' "$GATE" &&
  grep -Eq 'stuck_transitions.*-eq.*0' "$GATE" &&
  grep -Fq '"$stuck_maxstreak" -gt "$ROLLOUT_DOWNTIME_BUDGET_SEC"' "$GATE" &&
  grep -Fq 'ErrImagePull|ImagePullBackOff' "$GATE" &&
  pass "D1b mode: bounded, pinned to ImagePull, sustained outage with zero recoveries" ||
  fail "the botched-rollout mode lost its outage evidence or can hang unbounded"

# 7. Branch-scope + fault-injection ack + single-writer lock + restore, like the
#    sibling HCC gates. Restore is image + rollout status + repair instructions.
grep -Fq 'is_branch_scoped_e2e_context' "$GATE" &&
  grep -Fq 'require_safe_kube_context' "$GATE" &&
  grep -Fq 'E2E_HCC_ROLLOUT_FAULT_INJECTION' "$GATE" &&
  grep -Fq 'require_branch_owned_hcc_gate' "$GATE" &&
  grep -Fq 'acquire_hcc_watch_gate_lock' "$GATE" &&
  grep -Fq 'finalize_hcc_watch_gate_lock' "$GATE" &&
  grep -Fq 'set image' "$GATE" &&
  grep -Fq 'rollout status' "$GATE" &&
  grep -Fq 'print_repair_instructions' "$GATE" &&
  pass "gate keeps branch-scope, ack, single-writer lock and restore contract" ||
  fail "gate drops a branch-scope / ack / lock / restore guard"

# 8. The branch-owned proof is DELEGATED to the shared authority in
#    _lib/hcc-watch-recovery-fixture.sh, never inlined (mirror of the recovery
#    harness's delegation sweep over its GATES).
[ "$(grep -Fc 'kctl get configmap clerum-pre-gate-sync-state' "$GATE")" = 0 ] &&
  ! grep -Fq 'profile_env=' "$GATE" &&
  ! grep -Fq 'cluster_fingerprint_file=' "$GATE" &&
  pass "gate delegates its branch-owned proof to the shared authority" ||
  fail "gate duplicates or bypasses the shared branch-owned proof"

# 9. The node label is bound to the explicit profile (no non-null wildcard).
grep -Fq 'minikube.k8s.io/name"] == $c' "$GATE" &&
  ! grep -Fq 'minikube.k8s.io/name"] != null' "$GATE" &&
  pass "gate binds the minikube node label to the explicit profile" ||
  fail "gate can accept a node owned by another profile"

# 10. Sampler reuse: the 1Hz /ready series machinery comes from the shared
#     _lib helper — the gate must not carry its own definitions of it.
grep -Fq '_lib/hcc-ready-series.sh' "$GATE" &&
  [ "$(grep -Fc 'sample_ready_series()' "$GATE")" = 0 ] &&
  [ "$(grep -Fc 'series_metrics()' "$GATE")" = 0 ] &&
  grep -Fq 'sample_ready_series()' "$SAMPLER" &&
  grep -Fq 'series_metrics()' "$SAMPLER" &&
  pass "gate reuses the shared 1Hz sampler instead of duplicating it" ||
  fail "gate duplicates (or lost) the shared /ready series machinery"

# 11. Realistic load: the measured window runs over the synthetic
#     clerum-dev-scale fleet (initial LISTs + the NetworkPolicy revocation pass
#     are part of the window being measured), and the fleet is cleaned up.
grep -Fq 'create_synthetic_fleet' "$GATE" &&
  grep -Fq 'delete_synthetic_fleet' "$GATE" &&
  pass "measured window includes the synthetic clerum-dev-scale fleet" ||
  fail "gate measures a bare cluster and calls it the production window"


# 12. evenfire#391 recovery mode: exclusive with EXPECT_STUCK, undo is the test
#     action (not cleanup), last-good revision is captured, the pre-undo outage
#     is the same sustained D1b pin as EXPECT_STUCK, IMAGE_BROKEN is cleared
#     only AFTER every post-undo proof, and a no-op undo fails.
recovery_block="$(awk '/FASE D \(recovery, evenfire#391\)/,0' "$GATE")"
stuck_block="$(awk '/FASE D \(botched, D1b\)/,/^else$/' "$GATE")"
# The sustained-outage comparison lives in the shared assert_botched_outage
# helper; pin the LITERAL test expression in the helper body (a comment
# mentioning the variables must never satisfy this check) plus the recovery
# block's invocation of that helper.
outage_helper="$(awk '/^assert_botched_outage\(\) \{/,/^\}/' "$GATE")"
image_clear_line="$(grep -n 'IMAGE_BROKEN=0' <<<"$recovery_block" | head -1 | cut -d: -f1)"
hold_assert_line="$(grep -n 'post-undo hold' <<<"$recovery_block" | head -1 | cut -d: -f1)"
grep -Fq 'EXPECT_RECOVERY' "$GATE" &&
  grep -Fq 'EXPECT_STUCK=1 and EXPECT_RECOVERY=1 are exclusive' "$GATE" &&
  grep -Fq 'TEST ACTION' "$GATE" &&
  grep -Fq -- '--to-revision' "$GATE" &&
  grep -Fq 'LAST_GOOD_REVISION' "$GATE" &&
  grep -Fq 'assert_botched_outage recovery' <<<"$recovery_block" &&
  grep -Fq '"$stuck_maxstreak" -gt "$ROLLOUT_DOWNTIME_BUDGET_SEC"' <<<"$outage_helper" &&
  grep -Fq '[ "$e2e_fail" -eq 0 ] && IMAGE_BROKEN=0' <<<"$recovery_block" &&
  [ -n "$image_clear_line" ] && [ -n "$hold_assert_line" ] &&
  [ "$image_clear_line" -gt "$hold_assert_line" ] &&
  grep -Fq 'undo was a no-op' "$GATE" &&
  ! grep -q 'EXPECT_RECOVERY=1' <<<"$(awk '/^cleanup\(\)/,/^}/' "$GATE")" &&
  pass "EXPECT_RECOVERY undoes to last-good outside cleanup and fails a no-op" ||
  fail "EXPECT_RECOVERY is missing, shares cleanup, skips sustained outage, or clears IMAGE_BROKEN before proofs"

# 13. The stuck and recovery modes share one implementation of every D1b
#     predicate. Only their explanatory messages differ, so one mode cannot
#     silently lose a correctness pin while the other keeps it.
[ "$(grep -Fc '[ "$deployed_image_now" = "$BOTCHED_IMAGE" ]' <<<"$outage_helper")" = 1 ] &&
  [ "$(grep -Fc '[ "$old_uid_live" = 0 ]' <<<"$outage_helper")" = 1 ] &&
  [ "$(grep -Fc "grep -Eq 'ErrImagePull|ImagePullBackOff'" <<<"$outage_helper")" = 1 ] &&
  [ "$(grep -Fc '[ "$stuck_503" -ge 1 ]' <<<"$outage_helper")" = 1 ] &&
  [ "$(grep -Fc '[ "$stuck_transitions" -eq 0 ]' <<<"$outage_helper")" = 1 ] &&
  [ "$(grep -Fc '[ "$stuck_maxstreak" -gt "$ROLLOUT_DOWNTIME_BUDGET_SEC" ]' <<<"$outage_helper")" = 1 ] &&
  grep -Fq 'assert_botched_outage stuck' <<<"$stuck_block" &&
  grep -Fq 'assert_botched_outage recovery' <<<"$recovery_block" &&
  pass "stuck and recovery modes share one complete D1b assertion implementation" ||
  fail "assert_botched_outage duplicates a predicate or one mode bypasses the shared D1b pins"

# 14. Evidence is mode-aware: each mode emits only the samples it collected,
#     and an unavailable restart count is explicit rather than the ambiguous
#     `restarts=?` placeholder.
evidence_helper="$(awk '/^write_evidence_artifact\(\) \{/,/^\}/' "$GATE")"
render_evidence_mode() (
  local mode="$1"
  eval "$evidence_helper"
  EXPECT_STUCK=0 EXPECT_RECOVERY=0
  case "$mode" in
    stuck) EXPECT_STUCK=1 ;;
    recovery) EXPECT_RECOVERY=1 ;;
  esac
  WITH_SYNTHETIC_FLEET=0 FLEET_CONTEXTS=24 FLEET_MCPSERVERS=115 FLEET_HOSTS=8
  HCC_DEPLOY=host-context-controller HCC_NS=control-plane
  OLD_POD_NAME=old-pod OLD_POD_UID=uid-old
  NEW_POD_NAME=new-pod NEW_POD_UID=uid-new NEW_POD_RESTARTS=0
  LAST_GOOD_REVISION=7 live_revision_before_undo=8 recovered_revision=9
  replacement_row=$'botched-pod\tuid-botched\tPending\tImagePullBackOff'
  baseline_total=10 baseline_200=10 baseline_503=0
  roll_total=3 roll_200=2 roll_503=1 roll_maxstreak=1 roll_transitions=1
  stuck_total=4 stuck_200=0 stuck_503=4 stuck_maxstreak=4 stuck_transitions=0
  hold_total=2 hold_503=0
  ROLLOUT_DOWNTIME_BUDGET_SEC=120 STUCK_OBSERVE_SEC=210
  rollout_t0=100 rollout_recovered_at=103
  READY_SERIES=/dev/null
  LOG_ARTIFACT="$(mktemp "${TMPDIR:-/tmp}/hcc-rollout-evidence-test.XXXXXX")"
  trap 'rm -f "$LOG_ARTIFACT"' EXIT
  kctl() { return 0; }
  write_evidence_artifact
  cat "$LOG_ARTIFACT"
)
healthy_evidence="$(render_evidence_mode healthy)"
stuck_evidence="$(render_evidence_mode stuck)"
recovery_evidence="$(render_evidence_mode recovery)"
grep -Fq 'pre-undo outage: samples=' <<<"$recovery_evidence" &&
  grep -Fq 'post-undo hold: samples=' <<<"$recovery_evidence" &&
  grep -Fq 'restarts=0' <<<"$recovery_evidence" &&
  ! grep -Fq '=== rollout: samples=' <<<"$recovery_evidence" &&
  grep -Fq 'stuck outage: samples=' <<<"$stuck_evidence" &&
  ! grep -Fq 'restarts=' <<<"$stuck_evidence" &&
  ! grep -Fq '=== rollout: samples=' <<<"$stuck_evidence" &&
  grep -Fq '=== rollout: samples=' <<<"$healthy_evidence" &&
  grep -Fq 'post-rollout hold: samples=' <<<"$healthy_evidence" &&
  grep -Fq 'restarts=0' <<<"$healthy_evidence" &&
  ! grep -Fq 'stuck outage: samples=' <<<"$healthy_evidence" &&
  ! grep -Fq 'samples=0' <<<"${healthy_evidence}${stuck_evidence}${recovery_evidence}" &&
  ! grep -Fq 'restarts=?' <<<"${healthy_evidence}${stuck_evidence}${recovery_evidence}" &&
  ! grep -Fq 'restarts=${NEW_POD_RESTARTS:-?}' <<<"$evidence_helper" &&
  pass "evidence reports only mode-relevant samples and never emits restarts=?" ||
  fail "evidence mixes uncollected mode counters or retains an ambiguous restart placeholder"

# 15. Recovery-only state stays in the recovery branch: capture last-good
#     before injecting the bad image, then record the recovered pod's restart
#     count after undo and before writing evidence.
last_good_capture='LAST_GOOD_REVISION="$(kctl get deployment "$HCC_DEPLOY"'
capture_line="$(grep -nF "$last_good_capture" <<<"$recovery_block" | head -1 | cut -d: -f1)"
botch_line="$(grep -nF 'kctl set image deployment/"$HCC_DEPLOY"' <<<"$recovery_block" | head -1 | cut -d: -f1)"
undo_line="$(grep -nF 'kctl rollout undo deployment/"$HCC_DEPLOY"' <<<"$recovery_block" | head -1 | cut -d: -f1)"
restart_line="$(grep -nF 'NEW_POD_RESTARTS="$(hcc_restart_count "$NEW_POD_NAME" || true)"' <<<"$recovery_block" | head -1 | cut -d: -f1)"
evidence_line="$(grep -nF 'write_evidence_artifact' <<<"$recovery_block" | head -1 | cut -d: -f1)"
[ "$(grep -Fc "$last_good_capture" "$GATE")" = 1 ] &&
  [ -n "$capture_line" ] && [ -n "$botch_line" ] && [ "$capture_line" -lt "$botch_line" ] &&
  [ -n "$undo_line" ] && [ -n "$restart_line" ] && [ -n "$evidence_line" ] &&
  [ "$restart_line" -gt "$undo_line" ] && [ "$restart_line" -lt "$evidence_line" ] &&
  pass "recovery alone captures last-good and records recovered pod restarts after undo" ||
  fail "last-good/restart evidence escaped recovery scope or occurs on the wrong side of undo"

# 16. Makefile entry point: the gate is reachable through the same shaped
#     target as the sibling HCC gates — fault-injection ack + pre-gate-sync
#     expectation + explicit profile=context pin, with the exclusive
#     EXPECT_STUCK/EXPECT_RECOVERY modes surfaced (and documented as
#     exclusive) rather than hardcoded.
MAKEFILE="${ROOT}/Makefile"
make_target_block="$(awk '/^test-e2e-hcc-rollout-readiness:/,/^$/' "$MAKEFILE")"
grep -Fq '.PHONY: test-e2e-hcc-rollout-readiness' "$MAKEFILE" &&
  grep -Fq 'E2E_HCC_ROLLOUT_FAULT_INJECTION=1' <<<"$make_target_block" &&
  grep -Fq 'E2E_EXPECTED_PRE_GATE_GATE' <<<"$make_target_block" &&
  grep -Fq 'MINIKUBE_PROFILE=$(E2E_KUBECONTEXT)' <<<"$make_target_block" &&
  grep -Fq 'KUBECONTEXT=$(E2E_KUBECONTEXT)' <<<"$make_target_block" &&
  grep -Fq 'EXPECT_STUCK=$(EXPECT_STUCK)' <<<"$make_target_block" &&
  grep -Fq 'EXPECT_RECOVERY=$(EXPECT_RECOVERY)' <<<"$make_target_block" &&
  grep -Fq 'scripts/e2e/e2e-hcc-rollout-readiness.sh' <<<"$make_target_block" &&
  grep -Fq 'EXCLUSIVE' <<<"$make_target_block" &&
  pass "Makefile target test-e2e-hcc-rollout-readiness keeps ack + profile=context + modes + gate invocation" ||
  fail "Makefile target test-e2e-hcc-rollout-readiness is missing or lost its ack/profile/mode/gate contract"

# 17. Executable guard suite: CI must RUN the cluster-free guard tests (not
#     only this grep contract), and that suite must actually EXECUTE the gate
#     — a guards script degraded back to grep would be this file twice.
GUARDS="${ROOT}/scripts/tests/test-hcc-rollout-readiness-guards.sh"
CI_WORKFLOW="${ROOT}/.github/workflows/ci-public.yml"
[ -x "$GUARDS" ] &&
  bash -n "$GUARDS" &&
  grep -Fq '"$BASH_BIN" "$GATE"' "$GUARDS" &&
  grep -Fq 'EXPECT_STUCK=1 and EXPECT_RECOVERY=1 are exclusive.' "$GUARDS" &&
  grep -Fq 'scripts/tests/test-hcc-rollout-readiness-guards.sh' "$CI_WORKFLOW" &&
  pass "executable guard suite exists, executes the gate, and is wired into CI" ||
  fail "guard suite missing/non-executable, no longer executes the gate, or dropped from CI"

exit "$FAIL"
