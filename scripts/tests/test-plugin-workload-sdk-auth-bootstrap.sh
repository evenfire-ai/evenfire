#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/e2e/e2e-plugin-workload-sdk.sh"
E2E_LIB="$ROOT_DIR/scripts/e2e/e2e-lib.sh"
DOTENV_LIB="$ROOT_DIR/scripts/e2e/load-dotenv.sh"
ADMIN_CREDENTIAL_LIB="$ROOT_DIR/scripts/e2e/admin-credentials.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../e2e/e2e-lib.sh
source "$E2E_LIB"
# shellcheck source=../e2e/load-dotenv.sh
source "$DOTENV_LIB"
# shellcheck source=../e2e/admin-credentials.sh
source "$ADMIN_CREDENTIAL_LIB"

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
  /^is_local_default_operator_context\(\)/ { capture = 1 }
  capture { print }
  capture && /^}/ { exit }
' "$SCRIPT" >"$TMP_ROOT/auth-helpers.sh"

awk '
  /^# ─── control-api admin helpers/ { capture = 1 }
  capture && /^# session_curl / { exit }
  capture { print }
' "$SCRIPT" >>"$TMP_ROOT/auth-helpers.sh"

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

assert_admin_resolution_contract() {
  local main_repo="$TMP_ROOT/main-repo"
  local worktree="$TMP_ROOT/branch-worktree"
  local canonical_main_repo
  local resolved

  git init -q -b main "$main_repo"
  git -C "$main_repo" config user.name 'E2E Contract Test'
  git -C "$main_repo" config user.email 'e2e-contract@example.invalid'
  printf '%s\n' fixture >"$main_repo/tracked.txt"
  git -C "$main_repo" add tracked.txt
  git -C "$main_repo" commit -q -m fixture
  git -C "$main_repo" worktree add -q -b credential-test "$worktree"
  canonical_main_repo="$(cd "$main_repo" && pwd -P)"

  printf '%s\n' \
    'ADMIN_PASSWORD=canonical-fixture-value' \
    'TEST_ADMIN_PASSWORD=canonical-secondary-value' \
    'E2E_ADMIN_PASSWORD=canonical-e2e-alias-value' \
    >"$main_repo/.env"
  printf '%s\n' 'ADMIN_PASSWORD=worktree-decoy-value' >"$worktree/.env"

  if [[ "$(dotenv_canonical_root "$worktree")" == "$canonical_main_repo/.env" ]]; then
    pass 'worktree resolution prefers the primary checkout .env through git-common-dir'
  else
    fail 'worktree resolution did not find the primary checkout .env'
  fi

  # shellcheck disable=SC2034 # consumed through intentional indirect expansion
  E2E_ADMIN_PASSWORD='process-e2e-value'
  # shellcheck disable=SC2034 # consumed through intentional indirect expansion
  ADMIN_PASSWORD='process-admin-value'
  # shellcheck disable=SC2034 # consumed through intentional indirect expansion
  TEST_ADMIN_PASSWORD='process-test-value'
  resolved="$(e2e_resolve_admin_password "$worktree" 'fallback-value')"
  if [[ "$resolved" == 'canonical-fixture-value' ]]; then
    pass 'canonical .env wins over every explicit process alias'
  else
    fail 'canonical .env did not win over the process environment'
  fi

  printf '%s\n' 'TEST_ADMIN_PASSWORD=canonical-test-only' >"$main_repo/.env"
  resolved="$(e2e_resolve_admin_password "$worktree" 'fallback-value')"
  if [[ "$resolved" == 'canonical-test-only' ]]; then
    pass 'a canonical TEST_ADMIN_PASSWORD wins over an inherited E2E_ADMIN_PASSWORD'
  else
    fail 'canonical TEST_ADMIN_PASSWORD was shadowed by a process alias'
  fi

  rm -f "$main_repo/.env"
  resolved="$(e2e_resolve_admin_password "$worktree" 'fallback-value')"
  if [[ "$resolved" == 'process-e2e-value' ]]; then
    pass 'explicit aliases are used when the canonical .env has no admin value'
  else
    fail 'explicit alias precedence is incorrect without a canonical value'
  fi

  unset E2E_ADMIN_PASSWORD
  resolved="$(e2e_resolve_admin_password "$worktree" 'fallback-value')"
  if [[ "$resolved" == 'process-admin-value' ]]; then
    pass 'ADMIN_PASSWORD is retained when no higher-precedence value exists'
  else
    fail 'ADMIN_PASSWORD was overwritten by a lower-precedence value or fallback'
  fi

  unset ADMIN_PASSWORD TEST_ADMIN_PASSWORD ADMIN_PASS
  resolved="$(e2e_resolve_admin_password "$worktree" 'fallback-value')"
  if [[ "$resolved" == 'fallback-value' ]]; then
    pass 'the local fallback is used only when no configured value exists'
  else
    fail 'fallback resolution failed when every configured value was absent'
  fi
}

assert_nul_credential_transport() {
  local result
  result="$(
    e2e_write_nul_credentials 'fixture-admin' '007d8-fixture-value!' |
      node --no-warnings -e '
        const chunks = []
        process.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)))
        process.stdin.on("end", () => {
          const input = Buffer.concat(chunks)
          const separator = input.indexOf(0)
          const secondSeparator = input.indexOf(0, separator + 1)
          const username = input.subarray(0, separator).toString("utf8")
          const password = input.subarray(separator + 1).toString("utf8")
          process.stdout.write(
            separator > 0 && secondSeparator === -1 &&
            username === "fixture-admin" && password === "007d8-fixture-value!"
              ? "ok"
              : "invalid"
          )
        })
      '
  )"
  if [[ "$result" == 'ok' ]]; then
    pass 'admin login handoff preserves exact credentials with one NUL delimiter'
  else
    fail 'admin login handoff corrupted the NUL-delimited credential payload'
  fi
}

assert_admin_resolution_contract
assert_nul_credential_transport

if grep -Fq 'e2e_write_nul_credentials "$admin_username" "$admin_password"' "$SCRIPT"; then
  pass 'Plugin Workload SDK login uses the shared NUL-safe transport helper'
else
  fail 'Plugin Workload SDK login bypasses the shared NUL-safe transport helper'
fi

if grep -Fq 'ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-changeme123!}"' "$ROOT_DIR/scripts/minikube/full-setup.sh"; then
  fail 'full-setup still overwrites the canonical admin password with the fallback'
else
  pass 'full-setup no longer overwrites a configured admin password'
fi

GENERATOR="$ROOT_DIR/scripts/minikube/generate-keys.sh"
if grep -Fq 'hashSync(process.env.ADMIN_PASSWORD, 12)' "$GENERATOR" &&
   grep -Fq "ADMIN_HASH='\$2b\$12\$9QdfGGp5KYg8osGa1n0.DuwQiB1RopCWIDJhmsuK4ygjTmIT8pvgy'" "$GENERATOR"; then
  pass 'admin bootstrap hash follows ADMIN_PASSWORD and keeps the fallback only for an absent value'
else
  fail 'admin bootstrap hash can still ignore the configured ADMIN_PASSWORD'
fi

if grep -Fq 'E2E_HARD_MAX_GATE_SECONDS=600' "$SCRIPT" &&
   grep -Fq 'E2E_GATE_MAX_SECONDS="${E2E_GATE_MAX_SECONDS:-600}"' "$SCRIPT" &&
   grep -Fq 'E2E_HARD_MAX_PHASE_WAIT_SECONDS=180' "$SCRIPT" &&
   grep -Fq 'E2E_HARD_MAX_POLL_INTERVAL_SECONDS=5' "$SCRIPT" &&
   grep -Fq 'validate_bounded_seconds E2E_GATE_MAX_SECONDS' "$SCRIPT" &&
   grep -Fq 'validate_bounded_seconds TIMEOUT_POD' "$SCRIPT"; then
  pass 'Plugin Workload SDK E2E rejects human-scale waits before creating resources'
else
  fail 'Plugin Workload SDK E2E lacks fail-closed wait ceilings'
fi

make_line="$(make -n MINIKUBE_PROFILE=clerum-codex-context-test test-e2e-plugin-workload-sdk 2>&1 || true)"
if [[ "$make_line" == *'KUBECONTEXT="${KUBECONTEXT:-clerum-codex-context-test}"'* ]]; then
  pass 'Plugin Workload SDK Make target propagates the explicit branch context'
else
  fail 'Plugin Workload SDK Make target lost the explicit branch context'
fi

if [[ "$make_line" != *'KUBECONTEXT="${KUBECONTEXT:-${E2E_KUBECONTEXT:-}}"'* ]]; then
  pass 'Plugin Workload SDK Make target does not fall back to global kubectl context'
else
  fail 'Plugin Workload SDK Make target still permits global kubectl context fallback'
fi

exit "$FAIL"
