#!/usr/bin/env bash
# T1 Real PostgreSQL lane for a verified branch-owned Minikube profile.
# shellcheck disable=SC2034
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
source "$PROJECT_DIR/scripts/minikube/t2-common.sh"

PG_NAMESPACE="$T2_CONTROL_NAMESPACE"
PG_SERVICE=control-postgres
PG_SECRET=control-postgres
T1_TIMEOUT="$T2_TIMEOUT_SECONDS"
T1_TMP_ROOT="$T2_TMP_ROOT"
if [ -z "$T1_TMP_ROOT" ]; then T1_TMP_ROOT=/tmp; fi
T1_TMP_DIR=""
PORT_FORWARD_PID=""
LOCAL_PORT=""
ADMIN_DSN=""
THROWAY_CONTAINER=""
THROWAY_PORT=""
THROWAY_DSN=""
PG_USER=""
PG_PASSWORD=""
PG_DATABASE=""
T1_REDACT_PASSWORD=""
T1_STATUS=NOT_RUN
T1_NEXT_COMMAND='repair the first reported Real PostgreSQL precondition, then re-run T1'
T1_TOTAL_TESTS=0
T1_PASSED_TESTS=0
T1_PENDING_TESTS=0

# Cluster-global role mutations must never run against live control-postgres.
# CI uses an empty postgres:16-alpine for the same reason.
CONTROL_API_ROLE_RESET_SUITES=(
  test/db.realPostgresMigration.integration.test.ts
  test/gfsReaderRole.realPostgres.integration.test.ts
)

die_t1() {
  local code="$1"
  shift
  T1_STATUS=FAIL
  T2_ERROR_CODE="$code"
  t2_evidence_write failure FAIL "$code"
  printf '%s: %s\n' "$code" "$*" >&2
  printf 'next: %s\n' "$T1_NEXT_COMMAND" >&2
  return 1
}

restore_gfs_runtime_credentials() {
  # Role-reset suites use throwaway Postgres, but a leaked ALTER ROLE against
  # the shared cluster must not leave GFSC in NOLOGIN for the T2 journey.
  if [ -z "${T2_CONTEXT:-}" ]; then
    return 0
  fi
  if ! t2_kc -n gfs get secret gfs-controller-db >/dev/null 2>&1; then
    return 0
  fi
  if ! GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true \
    CONTEXT="$T2_CONTEXT" \
    bash "$PROJECT_DIR/deploy/scripts/reconcile-gfs-deploy-credentials.sh"; then
    printf '[minikube-t1] ERROR: failed to restore branch-profile GFS credentials\n' >&2
    return 1
  fi
}

stop_throwaway_postgres() {
  if [ -n "$THROWAY_CONTAINER" ]; then
    docker rm -f "$THROWAY_CONTAINER" >/dev/null 2>&1 || true
    THROWAY_CONTAINER=""
  fi
}

T1_CLEANUP_ENABLED=0

cleanup_t1() {
  local status=$?
  if [ "$T1_CLEANUP_ENABLED" != 1 ]; then
    return 0
  fi
  if [ -n "$PORT_FORWARD_PID" ] && kill -0 "$PORT_FORWARD_PID" >/dev/null 2>&1; then
    local command_line
    command_line="$(ps -p "$PORT_FORWARD_PID" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == *port-forward* && "$command_line" == *svc/control-postgres* ]]; then
      kill "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
      wait "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
    fi
  fi
  stop_throwaway_postgres
  if ! restore_gfs_runtime_credentials; then
    status=1
  fi
  if [ -n "$T1_TMP_DIR" ] && [ -d "$T1_TMP_DIR" ]; then rm -rf "$T1_TMP_DIR"; fi
  exit "$status"
}

require_t1_commands() {
  local command_name
  for command_name in npm node docker; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      T1_NEXT_COMMAND="install or enable $command_name, then re-run the Real PostgreSQL lane"
      die_t1 LOCAL_DEPENDENCY_MISSING "required local dependency is unavailable: $command_name"
    fi
  done
  if ! docker info >/dev/null 2>&1; then
    T1_NEXT_COMMAND='start Docker Desktop or the Docker daemon, then re-run the Real PostgreSQL lane'
    die_t1 LOCAL_DEPENDENCY_MISSING 'docker is not running; T1 needs it for throwaway postgres:16-alpine'
  fi
}

secret_field() {
  local key="$1" encoded
  encoded="$(t2_kc -n "$PG_NAMESPACE" get secret "$PG_SECRET" -o "jsonpath={.data.$key}" 2>/dev/null || true)"
  if [ -z "$encoded" ]; then
    T1_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    die_t1 SECRET_MISSING "required Secret key is missing: $PG_NAMESPACE/$PG_SECRET.$key"
  fi
  printf '%s' "$encoded" | python3 -c 'import base64,sys; print(base64.b64decode(sys.stdin.buffer.read(), validate=True).decode(), end="")'
}

wait_for_tcp() {
  local port="$1" deadline
  deadline=$((SECONDS + T1_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if python3 - "$port" <<'PY' >/dev/null 2>&1
import socket
import sys
with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1):
    pass
PY
    then return 0; fi
    sleep 1
  done
  return 1
}

choose_local_port() {
  python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

sanitize_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  T1_REDACT_PASSWORD="${T1_REDACT_PASSWORD:-${PG_PASSWORD:-}}" python3 - "$file" <<'PY'
from pathlib import Path
import os
import re
import sys
path = Path(sys.argv[1])
text = path.read_text(errors="replace")
password = os.environ.get("T1_REDACT_PASSWORD", "")
if password:
    text = text.replace(password, "<password-redacted>")
text = re.sub(r"postgres(?:ql)?://[^\s\"'<>]+", "<minikube-postgres-dsn-redacted>", text)
text = re.sub(r"(?i)(authorization:\s*bearer\s+)[^\s]+", r"\1<token-redacted>", text)
path.write_text(text)
PY
}

count_real_postgres_files() {
  local package="$1"
  find "$PROJECT_DIR/$package" -type f -name '*realPostgres*.test.ts' \
    ! -name 'realPostgres.requirement.ts' ! -path '*/node_modules/*' -print | wc -l | tr -d ' '
}

start_throwaway_postgres() {
  THROWAY_PORT="$(choose_local_port)"
  THROWAY_CONTAINER="evenfire-t1-pg16-$$"
  if ! docker image inspect postgres:16-alpine >/dev/null 2>&1; then
    printf '[minikube-t1] pulling postgres:16-alpine for role-reset suites\n'
    if ! docker pull postgres:16-alpine >/dev/null; then
      T1_NEXT_COMMAND='pull postgres:16-alpine, then re-run the Real PostgreSQL lane'
      die_t1 LOCAL_DEPENDENCY_MISSING 'postgres:16-alpine image is unavailable'
    fi
  fi
  if ! docker run -d --name "$THROWAY_CONTAINER" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_DB=postgres \
    -p "127.0.0.1:${THROWAY_PORT}:5432" \
    postgres:16-alpine >/dev/null; then
    T1_NEXT_COMMAND='repair Docker and re-run the Real PostgreSQL lane'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'failed to start throwaway postgres:16-alpine'
  fi
  if ! wait_for_tcp "$THROWAY_PORT"; then
    docker logs "$THROWAY_CONTAINER" >&2 || true
    T1_NEXT_COMMAND='repair Docker networking and re-run the Real PostgreSQL lane'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'throwaway postgres:16-alpine did not become reachable'
  fi
  THROWAY_DSN="$(python3 -c '
from urllib.parse import quote
import sys
print("postgresql://" + quote("postgres", safe="") + "@127.0.0.1:" + sys.argv[1] + "/postgres", end="")
' "$THROWAY_PORT")"
  printf '[minikube-t1] throwaway postgres:16-alpine ready for role-reset suites\n'
}

run_suite() {
  local package="$1" admin_dsn="$2" expected_files="$3"
  shift 3
  local log_file json_file stats
  if ! [[ "$expected_files" =~ ^[1-9][0-9]*$ ]]; then
    T1_NEXT_COMMAND='restore the Real PostgreSQL suite files, then re-run T1'
    die_t1 ZERO_TESTS_EXECUTED "no Real PostgreSQL suites were selected under $package"
  fi
  log_file="$T1_TMP_DIR/$(printf '%s' "$package" | tr / _).$$.$RANDOM.log"
  json_file="$T1_TMP_DIR/$(printf '%s' "$package" | tr / _).$$.$RANDOM.json"
  printf '[minikube-t1] running %s Real PostgreSQL suites (%s files)\n' "$package" "$expected_files"
  # Keep JSON for fail-loud counts. Also keep the default reporter so beforeAll
  # / hook errors are visible; JSON-only leaves those messages empty.
  if ! (
    cd "$PROJECT_DIR/$package"
    CONTROL_API_REAL_PG_ADMIN_URL="$admin_dsn" \
    CONTROL_API_REAL_PG_REQUIRED=1 FORCE_COLOR=0 NO_COLOR=1 \
      npm test -- --reporter=default --reporter=json --outputFile="$json_file" "$@"
  ) >"$log_file" 2>&1; then
    sanitize_file "$log_file"
    sanitize_file "$json_file"
    cat "$log_file" >&2 || true
    cat "$json_file" >&2 || true
    T1_NEXT_COMMAND='repair the first failing Real PostgreSQL suite, then re-run T1 on the same HEAD'
    die_t1 REAL_PG_SUITE_FAILED "Real PostgreSQL suite failed in $package"
  fi
  sanitize_file "$log_file"
  sanitize_file "$json_file"
  [ -s "$json_file" ] || {
    T1_NEXT_COMMAND='inspect the Vitest reporter output, then re-run T1'
    die_t1 ZERO_TESTS_EXECUTED "Real PostgreSQL reporter produced no result for $package"
  }
  stats="$(python3 - "$json_file" "$expected_files" <<'PY'
import json
import sys
result = json.loads(open(sys.argv[1]).read())
expected = int(sys.argv[2])
reported_files = len(result.get("testResults") or [])
passed_tests = int(result.get("numPassedTests") or 0)
failed_tests = int(result.get("numFailedTests") or 0)
pending_files = int(result.get("numPendingTestSuites") or 0)
pending_tests = int(result.get("numPendingTests") or 0)
total_tests = int(result.get("numTotalTests") or 0)
success = bool(result.get("success"))
print(reported_files, passed_tests, failed_tests, pending_files, pending_tests, total_tests, int(success), expected)
PY
  )"
  read -r reported_files passed_tests failed_tests pending_files pending_tests total_tests success expected <<< "$stats"
  T1_TOTAL_TESTS=$((T1_TOTAL_TESTS + total_tests))
  T1_PASSED_TESTS=$((T1_PASSED_TESTS + passed_tests))
  T1_PENDING_TESTS=$((T1_PENDING_TESTS + pending_tests))
  if [ "$success" -ne 1 ] || [ "$reported_files" -ne "$expected" ] || [ "$failed_tests" -ne 0 ]; then
    T1_NEXT_COMMAND='repair the failed or incomplete Real PostgreSQL lane, then re-run T1'
    die_t1 REAL_PG_SUITE_FAILED "Real PostgreSQL reporter did not pass every suite in $package"
  fi
  if [ "$total_tests" -le 0 ] || [ "$passed_tests" -le 0 ] || [ "$pending_files" -ne 0 ] || [ "$pending_tests" -ne 0 ]; then
    T1_NEXT_COMMAND='repair the test selection or database route; a T1 run cannot silently skip suites'
    die_t1 ZERO_TESTS_EXECUTED "Real PostgreSQL lane reported zero tests or skips in $package"
  fi
  printf '[minikube-t1] PASS %s files=%s tests=%s skipped=0\n' "$package" "$reported_files" "$passed_tests"
}

main() {
  local control_api_total control_api_shared suite_file exclude_args
  require_t1_commands
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
  if [ -z "$T2_CONTEXT" ]; then
    T1_NEXT_COMMAND='set CONTROL_API_REAL_PG_CONTEXT to the verified Kubernetes context'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'local Real PostgreSQL requires an explicit Minikube context'
  fi
  T1_CLEANUP_ENABLED=1
  trap cleanup_t1 EXIT INT TERM
  t2_profile_status
  if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
    T1_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'the selected profile is not bootstrapped'
  fi
  T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-t2-preflight"
  t2_marker_check
  if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'the selected profile has no validated exact-head marker'
  fi
  t2_process_check
  t2_evidence_init
  if ! t2_kc -n "$PG_NAMESPACE" rollout status deployment/control-postgres --timeout="${T1_TIMEOUT}s" >/dev/null 2>&1; then
    T1_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    die_t1 POSTGRES_NOT_READY 'control-postgres did not become Ready'
  fi

  T1_TMP_DIR="$(mktemp -d "$T1_TMP_ROOT/evenfire-t1.XXXXXX")"
  PG_USER="$(secret_field POSTGRES_USER)"
  PG_PASSWORD="$(secret_field POSTGRES_PASSWORD)"
  PG_DATABASE="$(secret_field POSTGRES_DB)"
  if [ -z "$PG_USER" ] || [ -z "$PG_PASSWORD" ] || [ -z "$PG_DATABASE" ]; then
    T1_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'control-postgres Secret is incomplete'
  fi
  T1_REDACT_PASSWORD="$PG_PASSWORD"

  LOCAL_PORT="$(choose_local_port)"
  t2_kc -n "$PG_NAMESPACE" port-forward --address=127.0.0.1 svc/"$PG_SERVICE" "$LOCAL_PORT:5432" \
    >"$T1_TMP_DIR/port-forward.log" 2>&1 &
  PORT_FORWARD_PID=$!
  if ! wait_for_tcp "$LOCAL_PORT"; then
    sanitize_file "$T1_TMP_DIR/port-forward.log"
    cat "$T1_TMP_DIR/port-forward.log" >&2 || true
    T1_NEXT_COMMAND='repair the profile-owned port-forward and re-run T1'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'control-postgres port-forward did not become reachable'
  fi
  if ! kill -0 "$PORT_FORWARD_PID" >/dev/null 2>&1; then
    sanitize_file "$T1_TMP_DIR/port-forward.log"
    cat "$T1_TMP_DIR/port-forward.log" >&2 || true
    T1_NEXT_COMMAND='repair the profile-owned port-forward and re-run T1'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'control-postgres port-forward exited before the T1 lane started'
  fi

  ADMIN_DSN="$(printf '%s\0%s\0%s' "$PG_USER" "$PG_PASSWORD" "$LOCAL_PORT" | python3 -c '
from urllib.parse import quote
import sys
user, password, port = sys.stdin.buffer.read().split(b"\0")[:3]
print("postgresql://" + quote(user.decode(), safe="") + ":" + quote(password.decode(), safe="") + "@127.0.0.1:" + port.decode() + "/postgres", end="")
')"

  control_api_total="$(count_real_postgres_files control-api)"
  for suite_file in "${CONTROL_API_ROLE_RESET_SUITES[@]}"; do
    if [ ! -f "$PROJECT_DIR/control-api/$suite_file" ]; then
      T1_NEXT_COMMAND='restore the role-reset Real PostgreSQL suite files, then re-run T1'
      die_t1 ZERO_TESTS_EXECUTED "role-reset suite is missing: $suite_file"
    fi
  done
  control_api_shared=$((control_api_total - ${#CONTROL_API_ROLE_RESET_SUITES[@]}))
  if [ "$control_api_shared" -le 0 ]; then
    T1_NEXT_COMMAND='restore the Real PostgreSQL suite files, then re-run T1'
    die_t1 ZERO_TESTS_EXECUTED 'role-reset isolation left no shared control-api Real PostgreSQL suites'
  fi

  start_throwaway_postgres
  run_suite control-api "$THROWAY_DSN" "${#CONTROL_API_ROLE_RESET_SUITES[@]}" \
    "${CONTROL_API_ROLE_RESET_SUITES[@]}"
  stop_throwaway_postgres
  unset THROWAY_DSN

  exclude_args=()
  for suite_file in "${CONTROL_API_ROLE_RESET_SUITES[@]}"; do
    exclude_args+=(--exclude "$suite_file")
  done
  run_suite control-api "$ADMIN_DSN" "$control_api_shared" \
    --run realPostgres "${exclude_args[@]}"
  run_suite gfs-controller "$ADMIN_DSN" "$(count_real_postgres_files gfs-controller)" \
    --run realPostgres
  unset PG_USER PG_PASSWORD PG_DATABASE T1_REDACT_PASSWORD
  unset ADMIN_DSN
  T1_STATUS=PASS
  t2_evidence_write T1 PASS "Real PostgreSQL suites passed; tests=$T1_TOTAL_TESTS passed=$T1_PASSED_TESTS pending=$T1_PENDING_TESTS"
  t2_evidence_write complete PASS "T1=PASS tests=$T1_TOTAL_TESTS passed=$T1_PASSED_TESTS pending=$T1_PENDING_TESTS"
  printf 'T1_TESTS=%s\n' "$T1_TOTAL_TESTS"
  printf 'T1_PASSED_TESTS=%s\n' "$T1_PASSED_TESTS"
  printf 'T1_PENDING_TESTS=%s\n' "$T1_PENDING_TESTS"
  printf 'T1_EVIDENCE=%s\n' "$T2_EVIDENCE_FILE"
  printf '[minikube-t1] T1 PASS: Real PostgreSQL executed against the verified local profile\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
