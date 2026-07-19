#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/e2e/e2e-plugin-workload-sdk.sh"
E2E_LIB="$ROOT_DIR/scripts/e2e/e2e-lib.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../e2e/e2e-lib.sh
source "$E2E_LIB"

FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAIL=1
}

# Load only the production auth helpers. Sourcing the complete E2E gate would
# run cluster operations, while copying the functions here would let the test
# drift from the behavior it is intended to protect.
awk '
  /^# ─── control-api admin helpers/ { capture = 1 }
  capture && /^# session_curl / { exit }
  capture { print }
' "$SCRIPT" >"$TMP_ROOT/auth-helpers.sh"

# shellcheck source=/dev/null
source "$TMP_ROOT/auth-helpers.sh"

for helper in \
  is_local_default_operator_context \
  operator_session_gate; do
  if declare -F "$helper" >/dev/null; then
    pass "production auth block exposes $helper"
  else
    fail "production auth block does not expose $helper"
  fi
done

reset_auth_environment() {
  unset E2E_ADMIN_TOKEN E2E_ADMIN_PASSWORD ADMIN_PASSWORD ADMIN_PASS TEST_ADMIN_PASSWORD
  unset KUBECONTEXT E2E_KUBECONTEXT E2E_K8S_CONTEXT
  E2E_ALLOWED_CONTEXTS='minikube,clerum-test'
}

set_test_context() {
  KUBECONTEXT=$1
  # shellcheck disable=SC2034
  E2E_KUBECONTEXT=$1
}

gate_status() {
  operator_session_gate >/dev/null 2>&1
  printf '%s' "$?"
}

if declare -F is_local_default_operator_context >/dev/null; then
  for context in \
    clerum-test \
    clerum-codex-auth-bootstrap-deadbeef \
    clerum-cursor-auth-bootstrap-deadbeef \
    clerum-detached-auth-bootstrap-deadbeef; do
    reset_auth_environment
    set_test_context "$context"
    if is_local_default_operator_context "$KUBECONTEXT"; then
      pass "$context qualifies for the local credential default"
    else
      fail "$context did not qualify for the local credential default"
    fi
  done
fi

if declare -F operator_session_gate >/dev/null; then
  # shellcheck disable=SC2329
  ensure_operator_session() { return 0; }

  reset_auth_environment
  set_test_context 'clerum-codex-auth-bootstrap-deadbeef'
  status="$(gate_status)"
  if [[ "$status" == '0' ]]; then
    pass 'successful acquisition returns success from the operator session gate'
  else
    fail "successful acquisition returned $status instead of 0"
  fi

  # shellcheck disable=SC2329
  ensure_operator_session() { return 1; }

  for context in clerum-codex-auth-bootstrap-deadbeef gke_staging_audit; do
    reset_auth_environment
    set_test_context "$context"
    status="$(gate_status)"
    if [[ "$status" == '1' ]]; then
      pass "failed acquisition on $context fails instead of skipping"
    else
      fail "failed acquisition on $context returned $status instead of 1"
    fi
  done
fi

if declare -F is_local_default_operator_context >/dev/null; then
  for context in \
    example-production-deadbeef \
    clerum-codex-production-deadbeef \
    clerum-staging-audit-deadbeef \
    clerum-gke-dev-deadbeef; do
    reset_auth_environment
    set_test_context "$context"
    # shellcheck disable=SC2034
    E2E_ALLOWED_CONTEXTS="minikube,clerum-test,$KUBECONTEXT"
    if is_local_default_operator_context "$KUBECONTEXT"; then
      fail "$context qualified for the local default"
    else
      pass "$context never qualifies for the local credential default"
    fi
  done
fi

awk '
  /^# ─── authorized happy path/ { capture = 1 }
  capture && /^header "Admin grant guardrails"/ { exit }
  capture { print }
' "$SCRIPT" >"$TMP_ROOT/auth-call-site.sh"
if grep -Eq 'exit[[:space:]]+0|[Ss]kipping authenticated' "$TMP_ROOT/auth-call-site.sh"; then
  fail 'authenticated gate call site can still convert missing authentication into success'
else
  pass 'authenticated gate call site has no successful skip path'
fi

# shellcheck disable=SC2016
if grep -En 'jq .*--arg[[:space:]]+(p|password|admin_password)([[:space:]]|$)|jq .*--arg[[:space:]]+[^[:space:]]+[[:space:]]+"?\$admin_password' "$SCRIPT"; then
  fail 'operator password is passed through a jq command argument'
else
  pass 'operator password is not passed through jq command arguments'
fi

if grep -En '^[[:space:]]*export[[:space:]]+(E2E_ADMIN_TOKEN|[A-Z_]*ADMIN[A-Z_]*(COOKIE|TOKEN))([[:space:]]|$)' "$SCRIPT"; then
  fail 'auto-acquired admin session material is exported'
else
  pass 'auto-acquired admin session material is not exported'
fi

if grep -En "kctl exec.*\\\$(E2E_ADMIN_TOKEN|[A-Z_]*ADMIN[A-Z_]*(COOKIE|TOKEN)|session_cookie)|^[[:space:]]*'[^']*\\\$(E2E_ADMIN_TOKEN|[A-Z_]*ADMIN[A-Z_]*(COOKIE|TOKEN)|session_cookie)" "$SCRIPT"; then
  fail 'admin session material is passed as a kubectl/node process argument'
else
  pass 'admin session material is not passed as a kubectl/node process argument'
fi

exit "$FAIL"
