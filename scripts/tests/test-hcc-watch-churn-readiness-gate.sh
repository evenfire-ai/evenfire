#!/usr/bin/env bash
# Offline contract gate for the HCC watch-churn readiness e2e. Runs in CI: no
# cluster. Proves the gate keeps its fail-loud, branch-scoped, restorable shape
# and its anti-vacuity assertions, so a refactor cannot quietly gut the one test
# that reproduces the clerum-dev livelock under real watch churn.
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-hcc-watch-churn-readiness.sh"
FIXTURE="${ROOT}/scripts/e2e/_lib/hcc-watch-churn-fixture.sh"
pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

for s in "$GATE" "$FIXTURE"; do
  bash -n "$s" && pass "$(basename "$s") valid bash" || fail "$(basename "$s") invalid bash"
done

# 1. Anti-vacuity: both regimes assert a minimum number of real watch cuts.
[ "$(grep -Ec 'cuts.*-ge.*CHURN_MIN_CUTS' "$GATE")" -ge 2 ] &&
  pass "both livelock and fix regimes assert >= CHURN_MIN_CUTS real cuts" ||
  fail "a regime can pass without proving churn actually cut the watches"

# 2. Livelock regime demands the divergent-generation evidence.
grep -Fq 'authority changed before .* admission' "$GATE" &&
  pass "livelock regime keys on the real generation-divergence log" ||
  fail "livelock regime does not check the generation-divergence signal"

# 3. Fix regime bounds in-churn recovery instead of banning transient 503s.
#    The fail-closed contract drops /ready to 503 TRANSIENTLY while a cut watch
#    re-syncs, so a zero-tolerance "no 503 after first 200" window fails the
#    CORRECT regime; the honest property is that every 503 streak closes within
#    the recovery budget.
grep -Eq 'churn_maxstreak.*-le.*RECOVERY_BUDGET_SEC' "$GATE" &&
  pass "fix regime bounds every in-churn 503 streak by RECOVERY_BUDGET_SEC" ||
  fail "fix regime lost the bounded-recovery streak assertion"

# 4. Post-churn absorbing-state detector: after the churn is paused the SAME
#    HCC pod must re-certify without a content change and hold with zero 503s.
grep -Fq 'pause_hcc_churn_proxy' "$GATE" &&
  grep -Fq 'did NOT converge' "$GATE" &&
  grep -Eq 'hold_503.*-eq.*0' "$GATE" &&
  pass "fix regime keeps the post-churn convergence + zero-503 hold detector" ||
  fail "fix regime lost the post-churn absorbing-state detector"

# 5. Sampler anti-vacuity: the proxy must bite (>= 1 in-churn 503), recovery
#    must repeat (>= MIN_CHURN_RECOVERIES 503->200 transitions), and a run
#    with zero samples must never pass (zero-tests-is-never-success).
grep -Eq 'churn_503.*-ge.*1' "$GATE" &&
  grep -Eq 'churn_transitions.*-ge.*MIN_CHURN_RECOVERIES' "$GATE" &&
  grep -Eq 'churn_total.*-gt.*0' "$GATE" &&
  pass "sampler anti-vacuity (503 bite, repeated recovery, nonzero samples) enforced" ||
  fail "sampler can pass vacuously (no 503s, a single recovery, or zero samples)"

# 6. In-situ guarantee: post-churn convergence must come from the same pod
#    with an unchanged restart count (fresh boot is a different gate's claim),
#    and the churn pause must be the restart-free flag mechanism.
grep -Fq 'in-situ' "$GATE" &&
  grep -Fq 'restartCount' "$GATE" &&
  grep -Fq 'churn-ctl/paused' "$FIXTURE" &&
  pass "post-churn convergence is pinned to the same non-restarted HCC pod" ||
  fail "a fresh-boot recovery could impersonate in-situ convergence"

# 7. Branch-scoped + fault-injection ack + single-writer + restorable, like siblings.
grep -Fq 'is_branch_scoped_e2e_context' "$GATE" &&
  grep -Fq 'E2E_HCC_WATCH_FAULT_INJECTION' "$GATE" &&
  grep -Fq 'require_branch_owned_hcc_gate' "$GATE" &&
  grep -Fq 'ORIGINAL_REPLICAS' "$GATE" &&
  grep -Fq 'restore_hcc_after_churn' "$GATE" &&
  pass "gate keeps branch-scope, ack, single-writer and restore contract" ||
  fail "gate drops a branch-scope / ack / single-writer / restore guard"

# 8. Churn cadence is parameterized with an explicit default.
grep -Eq 'CHURN_PERIOD_MS:-[0-9]{3,5}' "$GATE" &&
  pass "churn cadence is parameterized with an explicit default" ||
  fail "churn cadence is not parameterized"

# 9. The node label is bound to the explicit profile (no non-null wildcard).
grep -Fq 'minikube.k8s.io/name"] == $c' "$GATE" &&
  ! grep -Fq 'minikube.k8s.io/name"] != null' "$GATE" &&
  pass "gate binds the minikube node label to the explicit profile" ||
  fail "gate can accept a node owned by another profile"

# 10. The single-writer invariant is enforced (exactly one replica).
grep -Fq 'expected exactly one HCC replica' "$GATE" &&
  pass "gate refuses to run unless HCC is single-replica" ||
  fail "gate does not enforce the single-writer invariant"

exit "$FAIL"
