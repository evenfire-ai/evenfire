#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/deploy/scripts/provision-control-api-runtime-roles.sh"
TEST_CONTEXT="clerum-runtime-role-test"
CASE_CONTEXT="$TEST_CONTEXT"
PASSWORD_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PASSWORD_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

cat >"$TMP_DIR/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

: "${TEST_LOG:?}"
: "${TEST_MODE:?}"
: "${TEST_CONTEXT:?}"
: "${PASSWORD_A:?}"
: "${PASSWORD_B:?}"

printf '%s\n' "$*" >>"$TEST_LOG"
[[ "${1:-}" == "--context=$TEST_CONTEXT" ]] || exit 90
shift

if [[ "$*" == "-n control-plane rollout status deployment/control-postgres --timeout=180s" ]]; then
  exit 0
fi

if [[ "${1:-}" == "-n" && "${3:-}" == "get" && "${4:-}" == "secret" ]]; then
  secret_name="${5:-}"
  if [[ "$TEST_MODE" == "api-failure" ]]; then
    exit 1
  fi
  if [[ "$TEST_MODE" == "generate" ]]; then
    exit 0
  fi
  if [[ "$*" == *" -o name --ignore-not-found"* ]]; then
    printf 'secret/%s\n' "$secret_name"
    exit 0
  fi
  if [[ "$*" == *" -o json --ignore-not-found"* ]]; then
    dsn=''
    if [[ "$TEST_MODE" == "invalid" ]]; then
      dsn='postgresql://wrong-role:not-valid@wrong-host:5432/wrong-db'
    elif [[ "$TEST_MODE" == "empty" ]]; then
      dsn=''
    elif [[ "$secret_name" == "control-api-postgres-runtime" ]]; then
      dsn="postgresql://control_api_runtime:${PASSWORD_A}@control-postgres.control-plane.svc.cluster.local:5432/profiles"
    else
      dsn="postgresql://trace_maintenance_runtime:${PASSWORD_B}@control-postgres.control-plane.svc.cluster.local:5432/profiles"
    fi
    encoded="$(printf '%s' "$dsn" | base64 | tr -d '\n')"
    printf '{"metadata":{"name":"%s"},"data":{"connection-string":"%s"}}\n' "$secret_name" "$encoded"
    exit 0
  fi
fi

if [[ "${1:-}" == "-n" && "${3:-}" == "create" && "${4:-}" == "secret" ]]; then
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n' "${6:-unknown}"
  exit 0
fi

if [[ "${1:-}" == "apply" && "${2:-}" == "-f" && "${3:-}" == "-" ]]; then
  cat >/dev/null
  exit 0
fi

if [[ "${1:-}" == "-n" && "${3:-}" == "exec" ]]; then
  cat >>"$TEST_SQL"
  printf '\n-- statement boundary --\n' >>"$TEST_SQL"
  exit 0
fi

if [[ "${1:-}" == "-n" && "${3:-}" == "patch" && "${4:-}" == "secret" ]]; then
  cat >>"$TEST_PATCHES"
  printf '\n' >>"$TEST_PATCHES"
  exit 0
fi

printf 'unexpected kubectl invocation: %s\n' "$*" >&2
exit 91
STUB

cat >"$TMP_DIR/openssl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${TEST_MODE:?}"
: "${TEST_OPENSSL_COUNT:?}"
: "${PASSWORD_A:?}"
: "${PASSWORD_B:?}"
[[ "$*" == "rand -hex 32" ]] || exit 92
[[ "$TEST_MODE" == "generate" || "$TEST_MODE" == "empty" ]] || exit 93
count=0
[[ -f "$TEST_OPENSSL_COUNT" ]] && count="$(cat "$TEST_OPENSSL_COUNT")"
count=$((count + 1))
printf '%s' "$count" >"$TEST_OPENSSL_COUNT"
[[ "$count" == "1" ]] && printf '%s\n' "$PASSWORD_A" || printf '%s\n' "$PASSWORD_B"
STUB

chmod +x "$TMP_DIR/kubectl" "$TMP_DIR/openssl"

run_case() {
  local mode="$1"
  local output_file="$TMP_DIR/output-$mode"
  : >"$TMP_DIR/kubectl-$mode.log"
  : >"$TMP_DIR/sql-$mode.log"
  : >"$TMP_DIR/patches-$mode.jsonl"
  rm -f "$TMP_DIR/openssl-$mode.count"
  if ! TEST_MODE="$mode" \
    TEST_CONTEXT="$CASE_CONTEXT" \
    TEST_LOG="$TMP_DIR/kubectl-$mode.log" \
    TEST_SQL="$TMP_DIR/sql-$mode.log" \
    TEST_PATCHES="$TMP_DIR/patches-$mode.jsonl" \
    TEST_OPENSSL_COUNT="$TMP_DIR/openssl-$mode.count" \
    PASSWORD_A="$PASSWORD_A" \
    PASSWORD_B="$PASSWORD_B" \
    PATH="$TMP_DIR:$PATH" \
    CONTEXT="$CASE_CONTEXT" \
    ALLOWED_CONTEXTS="$CASE_CONTEXT" \
    PROVISION_WORKFLOW_RECIPES_RUNTIME=false \
    bash "$SCRIPT" >"$output_file" 2>&1; then
    cat "$output_file" >&2
    fail "runtime role provisioning case failed: $mode"
  fi
}

if CONTEXT=blocked ALLOWED_CONTEXTS="$TEST_CONTEXT" PATH="$TMP_DIR:$PATH" \
  bash "$SCRIPT" >"$TMP_DIR/disallowed.out" 2>&1; then
  fail "disallowed context was accepted"
fi
grep -q 'is not in ALLOWED_CONTEXTS' "$TMP_DIR/disallowed.out" || \
  fail "disallowed context did not fail with the expected reason"
pass "context allowlist fails closed"

run_case generate
[[ "$(cat "$TMP_DIR/openssl-generate.count")" == "2" ]] || \
  fail "first provisioning did not generate exactly two credentials"
[[ "$(grep -c ' patch secret ' "$TMP_DIR/kubectl-generate.log")" == "2" ]] || \
  fail "first provisioning did not patch exactly two runtime Secrets"
grep -q 'ALTER ROLE control_api_runtime' "$TMP_DIR/sql-generate.log" || \
  fail "control-api role password was not reconciled through stdin"
grep -q 'ALTER ROLE trace_maintenance_runtime' "$TMP_DIR/sql-generate.log" || \
  fail "maintenance role password was not reconciled through stdin"
if grep -q "$PASSWORD_A\|$PASSWORD_B" "$TMP_DIR/output-generate"; then
  fail "generated credential leaked to script output"
fi
pass "first provisioning generates, applies, and patches without output leakage"

run_case empty
[[ "$(cat "$TMP_DIR/openssl-empty.count")" == "2" ]] || \
  fail "empty placeholder Secrets did not generate exactly two credentials"
[[ "$(grep -c ' patch secret ' "$TMP_DIR/kubectl-empty.log")" == "2" ]] || \
  fail "empty placeholder Secrets were not provisioned"
pass "empty placeholder Secrets are treated as unprovisioned"

run_case reuse
[[ ! -e "$TMP_DIR/openssl-reuse.count" ]] || fail "idempotent reuse rotated credentials"
[[ "$(grep -c ' patch secret ' "$TMP_DIR/kubectl-reuse.log")" == "2" ]] || \
  fail "idempotent reuse did not reconcile both Secrets"
if grep -q "$PASSWORD_A\|$PASSWORD_B" "$TMP_DIR/output-reuse"; then
  fail "reused credential leaked to script output"
fi
pass "valid runtime DSNs are reused without rotation"

if TEST_MODE=invalid \
  TEST_CONTEXT="$CASE_CONTEXT" \
  TEST_LOG="$TMP_DIR/kubectl-invalid.log" \
  TEST_SQL="$TMP_DIR/sql-invalid.log" \
  TEST_PATCHES="$TMP_DIR/patches-invalid.jsonl" \
  TEST_OPENSSL_COUNT="$TMP_DIR/openssl-invalid.count" \
  PASSWORD_A="$PASSWORD_A" \
  PASSWORD_B="$PASSWORD_B" \
  PATH="$TMP_DIR:$PATH" \
  CONTEXT="$CASE_CONTEXT" \
  ALLOWED_CONTEXTS="$CASE_CONTEXT" \
  PROVISION_WORKFLOW_RECIPES_RUNTIME=false \
  bash "$SCRIPT" >"$TMP_DIR/output-invalid" 2>&1; then
  fail "invalid existing runtime DSN was accepted"
fi
grep -q 'contains an invalid runtime DSN' "$TMP_DIR/output-invalid" || \
  fail "invalid runtime DSN did not fail with the expected reason"
[[ ! -s "$TMP_DIR/sql-invalid.log" ]] || fail "invalid DSN reached Postgres"
[[ ! -s "$TMP_DIR/patches-invalid.jsonl" ]] || fail "invalid DSN patched a Secret"
pass "invalid existing runtime DSN fails closed before mutation"

: >"$TMP_DIR/kubectl-api-failure.log"
: >"$TMP_DIR/sql-api-failure.log"
: >"$TMP_DIR/patches-api-failure.jsonl"
if TEST_MODE=api-failure \
  TEST_CONTEXT="$CASE_CONTEXT" \
  TEST_LOG="$TMP_DIR/kubectl-api-failure.log" \
  TEST_SQL="$TMP_DIR/sql-api-failure.log" \
  TEST_PATCHES="$TMP_DIR/patches-api-failure.jsonl" \
  TEST_OPENSSL_COUNT="$TMP_DIR/openssl-api-failure.count" \
  PASSWORD_A="$PASSWORD_A" \
  PASSWORD_B="$PASSWORD_B" \
  PATH="$TMP_DIR:$PATH" \
  CONTEXT="$CASE_CONTEXT" \
  ALLOWED_CONTEXTS="$CASE_CONTEXT" \
  PROVISION_WORKFLOW_RECIPES_RUNTIME=false \
  bash "$SCRIPT" >"$TMP_DIR/output-api-failure" 2>&1; then
  fail "Kubernetes Secret read failure was treated as absence"
fi
[[ ! -e "$TMP_DIR/openssl-api-failure.count" ]] || fail "API failure generated a credential"
[[ ! -s "$TMP_DIR/sql-api-failure.log" ]] || fail "API failure reached Postgres"
[[ ! -s "$TMP_DIR/patches-api-failure.jsonl" ]] || fail "API failure patched a Secret"
pass "Kubernetes API and RBAC failures abort before credential mutation"

! grep -q 'DSN=' "$SCRIPT" || fail "runtime DSN is exposed through a child environment"
grep -q 'sys.stdin.read()' "$SCRIPT" || fail "runtime DSN parser does not consume stdin"
pass "runtime DSNs are parsed through stdin, not child environments"

if grep -v -- "--context=$TEST_CONTEXT" "$TMP_DIR/kubectl-generate.log" | grep -q .; then
  fail "a kubectl invocation omitted the explicit context"
fi
pass "every kubectl invocation uses the explicit allowed context"

grep -q 'PROVISION_WORKFLOW_RECIPES_RUNTIME="${PROVISION_WORKFLOW_RECIPES_RUNTIME:-true}"' "$SCRIPT" || \
  fail "workflow-recipes runtime provisioning is not enabled by default"
grep -q 'reconcile_role workflow_recipes_runtime workflow-recipes-postgres-runtime' "$SCRIPT" || \
  fail "workflow-recipes runtime role is not reconciled"
pass "workflow-recipes runtime role provisioning is wired by default"
