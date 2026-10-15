#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTROL_API_DIR="$REPO_ROOT/control-api"
MODE="${1:-all}"

usage() {
  cat <<'EOF'
Usage: scripts/ci/run-password-recovery-private-postgres.sh [local|configured|all]

local      Run the R4-L1 test, which starts the local Member Registration producer.
configured Run the BUG-192 test against an already running Member Registration producer.
all        Run both producer-backed suites (default).
EOF
}

require_environment() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      printf 'Required environment variable is unset: %s\n' "$name" >&2
      return 1
    fi
  done
}

run_suite() {
  local suite="$1"
  local output
  if [[ -z "$suite" || "$suite" == *$'\n'* || ! -f "$CONTROL_API_DIR/$suite" || ! -s "$CONTROL_API_DIR/$suite" ]]; then
    printf 'Required producer-backed suite is missing or empty: %s\n' "$suite" >&2
    return 1
  fi
  if ! output="$(cd "$CONTROL_API_DIR" && CONTROL_API_REAL_PG_REQUIRED=1 \
    FORCE_COLOR=0 NO_COLOR=1 npm test -- --run "$suite" --reporter=default 2>&1)"; then
    printf '%s\n' "$output"
    return 1
  fi
  printf '%s\n' "$output"
  if ! grep -Eq 'Test Files[[:space:]]+1 passed' <<<"$output" ||
    ! grep -Eq 'Tests[[:space:]]+[1-9][0-9]* passed' <<<"$output" ||
    grep -Eq '(Test Files|Tests).*([1-9][0-9]*) skipped' <<<"$output"; then
    printf 'Producer-backed suite did not report passing, non-skipped tests: %s\n' "$suite" >&2
    return 1
  fi
}

run_local_producer_suite() {
  require_environment CONTROL_API_REAL_PG_ADMIN_URL EVENFIRE_MEMBER_REGISTRATION_ROOT
  local root="$(cd "$EVENFIRE_MEMBER_REGISTRATION_ROOT" && pwd)"
  if [[ ! -x "$root/node_modules/.bin/tsx" ]]; then
    printf 'Member Registration dependencies are missing under EVENFIRE_MEMBER_REGISTRATION_ROOT\n' >&2
    return 1
  fi
  test -s "$REPO_ROOT/external-rest-api/dist/app.js" || {
    printf 'Build External REST before the local composed producer suite\n' >&2
    return 1
  }
  local suite
  suite="$(node "$REPO_ROOT/scripts/ci/password-recovery-suite-contract.mjs" private local)" || return 1
  run_suite "$suite"
}

run_configured_producer_suite() {
  require_environment \
    CONTROL_API_REAL_PG_ADMIN_URL \
    CONTROL_API_REAL_MEMBER_REGISTRATION_PG_URL \
    CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL \
    CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
  local suite
  suite="$(node "$REPO_ROOT/scripts/ci/password-recovery-suite-contract.mjs" private configured)" || return 1
  run_suite "$suite"
}

case "$MODE" in
  local)
    run_local_producer_suite
    ;;
  configured)
    run_configured_producer_suite
    ;;
  all)
    run_local_producer_suite
    run_configured_producer_suite
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
