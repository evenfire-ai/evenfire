#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T2="$ROOT/scripts/minikube/t2.sh"

# shellcheck source=scripts/minikube/t2.sh
source "$T2"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

T2_EVIDENCE_STATUS=''
t2_evidence_write() {
  T2_EVIDENCE_STATUS="$2"
}

T2_PLAN_STATE=targeted-sync
T2_HEALTHCHECK_COMMAND=''
T2_HEALTHCHECK_TIMEOUT_SECONDS=5
if validate_healthcheck_contract >/dev/null 2>&1; then
  fail 'targeted sync accepted a missing user-facing health command'
fi
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY ]] || \
  fail "missing targeted health returned ${T2_ERROR_CODE:-<empty>}"

T2_PLAN_STATE=already-synced
T2_HEALTHCHECK_COMMAND=''
validate_healthcheck_contract
run_healthcheck_if_requested
[[ "$T2_HEALTHCHECK_REQUIRED" == false && "$T2_HEALTH_STATUS" == NOT_RUN && \
  "$T2_EVIDENCE_STATUS" == NOT_RUN ]] || \
  fail 'an optional absent health check was not recorded as NOT_RUN'

T2_PLAN_STATE=targeted-sync
T2_HEALTHCHECK_COMMAND='printf "health-ok\\n" >/dev/null'
T2_HEALTHCHECK_TIMEOUT_SECONDS=5
validate_healthcheck_contract
run_healthcheck_if_requested
[[ "$T2_HEALTHCHECK_REQUIRED" == true && "$T2_HEALTH_STATUS" == PASS ]] || \
  fail 'a bounded targeted health check did not pass'

T2_PLAN_STATE=targeted-sync
T2_HEALTHCHECK_COMMAND='sleep 10'
T2_HEALTHCHECK_TIMEOUT_SECONDS=1
validate_healthcheck_contract
started="$SECONDS"
if run_healthcheck_if_requested >/dev/null 2>&1; then
  fail 'timed-out targeted health check unexpectedly passed'
fi
elapsed=$((SECONDS - started))
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY && "$T2_HEALTH_STATUS" == FAIL ]] || \
  fail 'timed-out targeted health check did not fail closed'
(( elapsed < 8 )) || fail "targeted health deadline took ${elapsed}s"

T2_HEALTHCHECK_TIMEOUT_SECONDS=0
if validate_healthcheck_contract >/dev/null 2>&1; then
  fail 'invalid health timeout was accepted'
fi
[[ "$T2_ERROR_CODE" == DEVELOPMENT_SCOPE_REQUIRED ]] || \
  fail 'invalid health timeout returned the wrong stable code'

printf 'PASS: targeted T2 requires a bounded user-facing health check\n'
