#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGGREGATE="${ROOT}/scripts/e2e/e2e-wrc-networkpolicy-live-convergence.sh"
ROUTES="${ROOT}/scripts/e2e/e2e-wrc-networkpolicy-service-routes.sh"
INTDEP="${ROOT}/scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh"
OAUTH="${ROOT}/scripts/e2e/e2e-sandbox-ui-oauth.sh"
WEBHOOK="${ROOT}/scripts/e2e/e2e-webhooks-basic.sh"
HELPER="${ROOT}/scripts/e2e/_lib/wrc-networkpolicy-convergence.sh"
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=1; }

for script in "$AGGREGATE" "$ROUTES" "$INTDEP" "$OAUTH" "$WEBHOOK" "$HELPER"; do
  if bash -n "$script"; then
    pass "$(basename "$script") has valid bash syntax"
  else
    fail "$(basename "$script") has invalid bash syntax"
  fi
done

for suite in \
  e2e-wrc-networkpolicy-service-routes.sh \
  e2e-wrc-internal-dependency-networkpolicy.sh \
  e2e-sandbox-ui-oauth.sh \
  e2e-webhooks-basic.sh; do
  grep -Fq "$suite" "$AGGREGATE" || fail "aggregate omits $suite"
done
if grep -Fq 'WRC_NETWORKPOLICY_E2E_PASS' "$AGGREGATE" &&
   grep -Fq 'set -euo pipefail' "$AGGREGATE"; then
  pass "aggregate is fail-loud and emits a terminal suite count"
else
  fail "aggregate can pass without executing every suite"
fi

if grep -Fq 'e2e-wrc-networkpolicy-live-convergence.sh' "${ROOT}/Makefile"; then
  pass "canonical Make E2E aggregate includes the WRC NetworkPolicy gate"
else
  fail "canonical Make E2E aggregate omits the WRC NetworkPolicy gate"
fi

if grep -Fq 'patch workflowrecipe' "$HELPER" &&
   grep -Fq 'metadata.generation' "$HELPER" &&
   grep -Fq 'deployment/${controller_deployment}' "$HELPER"; then
  pass "reconcile trigger advances the parent spec and observes the real WRC pass"
else
  fail "reconcile trigger does not prove a parent recipe reconcile"
fi

for entry in \
  "$ROUTES:service-route" \
  "$INTDEP:internal-dependency" \
  "$OAUTH:OAuth broker" \
  "$WEBHOOK:webhook"; do
  script=${entry%%:*}
  label=${entry#*:}
  trigger_count=$(grep -Fc 'wrc_trigger_recipe_reconcile' "$script" || true)
  if [ "$trigger_count" -ge 2 ]; then
    pass "${label} E2E drives both repair and equivalent no-op reconciles"
  else
    fail "${label} E2E does not drive both required reconciles"
  fi
done

for family in UI_INGRESS_POLICY WL_EGRESS_POLICY WL_INGRESS_POLICY; do
  grep -Fq "$family" "$ROUTES" || fail "service-route E2E omits $family"
done
if grep -Fq 'correctly configured positive routes' "$ROUTES" &&
   grep -Fq 'negative controls' "$ROUTES" &&
   grep -Fq 'live drift repair' "$ROUTES" &&
   grep -Fq 'steady-state no-churn' "$ROUTES"; then
  pass "UI/workload route E2E proves positive, negative, repair, and no-churn signals"
else
  fail "UI/workload route E2E is missing a required signal"
fi

if grep -Fq 'Live drift repair and steady no-churn' "$INTDEP" &&
   grep -Fq 'Internal dependency traffic recovered' "$INTDEP"; then
  pass "internal-dependency E2E proves live repair and restored traffic"
else
  fail "internal-dependency E2E lacks repair or traffic evidence"
fi

if grep -Fq 'BACKGROUND_POLICY_NAME' "$OAUTH" &&
   grep -Fq 'Opted-in background workload reaches' "$OAUTH" &&
   grep -Fq 'Unlabelled sandbox workload cannot use' "$OAUTH" &&
   grep -Fq 'OAuth broker route recovered' "$OAUTH"; then
  pass "OAuth broker E2E proves allow, deny, repair, and no-churn behavior"
else
  fail "OAuth broker E2E lacks a required dataplane signal"
fi

for policy in PROXY_INGRESS_POLICY HANDLER_EGRESS_POLICY HANDLER_INGRESS_POLICY; do
  grep -Fq "$policy" "$WEBHOOK" || fail "webhook E2E omits $policy"
done
if grep -Fq 'live drift and owner repair' "$WEBHOOK" &&
   grep -Fq 'Signed webhook route recovered' "$WEBHOOK" &&
   grep -Fq 'stayed resourceVersion-stable' "$WEBHOOK"; then
  pass "webhook E2E proves all three policies, owner repair, route recovery, and no churn"
else
  fail "webhook E2E lacks a required convergence signal"
fi

exit "$FAIL"
