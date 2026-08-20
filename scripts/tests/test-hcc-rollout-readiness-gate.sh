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
  grep -Eq 'stuck_maxstreak.*-gt.*ROLLOUT_DOWNTIME_BUDGET_SEC' "$GATE" &&
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

exit "$FAIL"
