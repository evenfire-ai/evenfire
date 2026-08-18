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

# 3. Fix regime demands sustained stability, not a transient 200.
grep -Fq 'readiness oscillated 200->503' "$GATE" &&
  pass "fix regime asserts sustained readiness under continuous churn" ||
  fail "fix regime accepts a transient 200 between cuts"

# 4. Branch-scoped + fault-injection ack + single-writer + restorable, like siblings.
grep -Fq 'is_branch_scoped_e2e_context' "$GATE" &&
  grep -Fq 'E2E_HCC_WATCH_FAULT_INJECTION' "$GATE" &&
  grep -Fq 'require_branch_owned_hcc_gate' "$GATE" &&
  grep -Fq 'ORIGINAL_REPLICAS' "$GATE" &&
  grep -Fq 'restore_hcc_after_churn' "$GATE" &&
  pass "gate keeps branch-scope, ack, single-writer and restore contract" ||
  fail "gate drops a branch-scope / ack / single-writer / restore guard"

# 5. Churn cadence is parameterized with an explicit default.
grep -Eq 'CHURN_PERIOD_MS:-[0-9]{3,5}' "$GATE" &&
  pass "churn cadence is parameterized with an explicit default" ||
  fail "churn cadence is not parameterized"

# 6. The node label is bound to the explicit profile (no non-null wildcard).
grep -Fq 'minikube.k8s.io/name"] == $c' "$GATE" &&
  ! grep -Fq 'minikube.k8s.io/name"] != null' "$GATE" &&
  pass "gate binds the minikube node label to the explicit profile" ||
  fail "gate can accept a node owned by another profile"

# 7. The single-writer invariant is enforced (exactly one replica).
grep -Fq 'expected exactly one HCC replica' "$GATE" &&
  pass "gate refuses to run unless HCC is single-replica" ||
  fail "gate does not enforce the single-writer invariant"

exit "$FAIL"
