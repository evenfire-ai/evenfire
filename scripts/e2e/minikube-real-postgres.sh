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
# Suites that DROP/ALTER cluster-global roles cannot share live control-postgres
# (#412). They run against a throwaway Postgres 16 that matches CI.
T1_ISOLATED_PG_IMAGE="${T1_ISOLATED_PG_IMAGE:-postgres:16-alpine}"
T1_TIMEOUT="$T2_TIMEOUT_SECONDS"
T1_TMP_ROOT="$T2_TMP_ROOT"
if [ -z "$T1_TMP_ROOT" ]; then T1_TMP_ROOT=/tmp; fi
T1_TMP_DIR=""
PORT_FORWARD_PID=""
LOCAL_PORT=""
ADMIN_DSN=""
ISOLATED_DSN=""
ISOLATED_CONTAINER=""
ISOLATED_PORT=""
PG_USER=""
PG_PASSWORD=""
PG_DATABASE=""
T1_REDACT_PASSWORD=""
T1_STATUS=NOT_RUN
T1_NEXT_COMMAND='repair the first reported Real PostgreSQL precondition, then re-run T1'
T1_TOTAL_TESTS=0
T1_PASSED_TESTS=0
T1_PENDING_TESTS=0
# Armed just before the Real PostgreSQL suites run. The exit trap must not
# reconcile cluster credentials for a run that never reached the suites
# (e.g. a failed precondition, or this file being sourced by a harness test).
T1_GFS_RESTORE_REQUIRED=false

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

stop_isolated_postgres() {
  if [ -n "$ISOLATED_CONTAINER" ]; then
    docker rm -f "$ISOLATED_CONTAINER" >/dev/null 2>&1 || true
    ISOLATED_CONTAINER=""
  fi
}

restore_gfs_runtime_credentials() {
  # The gfs-controller shared suites exercise the production role names, which
  # are cluster-global even when their fixture databases are temporary.
  # Restore the branch profile before T1 exits — success, failure, or
  # interruption — so a T1 run cannot leave GFSC NOLOGIN and poison the
  # following exact-head T2 preflight. Same canonical restore contract as
  # scripts/e2e/gfs-real-pg-minikube-gate.sh; DSNs stay inside the helper.
  if [ "$T1_GFS_RESTORE_REQUIRED" != true ] || [ -z "$T2_CONTEXT" ]; then
    return 0
  fi
  if ! t2_kc -n gfs get secret gfs-controller-db >/dev/null 2>&1; then
    return 0
  fi
  # Settle a Ready reader's leftover rollout claim first so restore does not
  # rollout restart it, and let any wait reconcile still needs judge
  # readiness via the gfs-rollout-shim instead of the template generation
  # HCC's gfsReconciler keeps rewriting.
  if ! CONTEXT="$T2_CONTEXT" \
    bash "$PROJECT_DIR/scripts/minikube/settle-gfs-reader-rollout.sh"; then
    printf '[minikube-t1] WARN: could not settle a leftover gfsc-reader rollout claim before restore\n' >&2
  fi
  if ! PATH="$PROJECT_DIR/scripts/minikube/gfs-rollout-shim:$PATH" \
    GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true \
    CONTEXT="$T2_CONTEXT" \
    bash "$PROJECT_DIR/deploy/scripts/reconcile-gfs-deploy-credentials.sh"; then
    printf '[minikube-t1] ERROR: failed to restore branch-profile GFS credentials\n' >&2
    return 1
  fi
}

cleanup_t1() {
  local status=$?
  if [ -n "$PORT_FORWARD_PID" ] && kill -0 "$PORT_FORWARD_PID" >/dev/null 2>&1; then
    local command_line
    command_line="$(ps -p "$PORT_FORWARD_PID" -o command= 2>/dev/null || true)"
    if [[ "$command_line" == *port-forward* && "$command_line" == *svc/control-postgres* ]]; then
      kill "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
      wait "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
    fi
  fi
  stop_isolated_postgres
  if ! restore_gfs_runtime_credentials; then
    status=1
  fi
  if [ -n "$T1_TMP_DIR" ] && [ -d "$T1_TMP_DIR" ]; then rm -rf "$T1_TMP_DIR"; fi
  exit "$status"
}
trap cleanup_t1 EXIT INT TERM

require_t1_commands() {
  local command_name
  for command_name in npm node docker; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      T1_NEXT_COMMAND="install or enable $command_name, then re-run the Real PostgreSQL lane"
      die_t1 LOCAL_DEPENDENCY_MISSING "required local dependency is unavailable: $command_name"
    fi
  done
  if ! docker info >/dev/null 2>&1; then
    T1_NEXT_COMMAND='start Docker Desktop or the Docker daemon, then re-run T1'
    die_t1 LOCAL_DEPENDENCY_MISSING 'Docker is required to start the isolated T1 PostgreSQL'
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

list_real_pg_files() {
  local package="$1"
  find "$PROJECT_DIR/$package" -type f -name '*realPostgres*.test.ts' \
    ! -name 'realPostgres.requirement.ts' -print | sort
}

is_isolated_control_api_file() {
  local path="$1"
  case "$path" in
    */db.realPostgresMigration.integration.test.ts|*/gfsReaderRole.realPostgres.integration.test.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_isolated_control_api_files() {
  local relative path
  for relative in \
    test/db.realPostgresMigration.integration.test.ts \
    test/gfsReaderRole.realPostgres.integration.test.ts; do
    path="$PROJECT_DIR/control-api/$relative"
    if [ ! -f "$path" ]; then
      T1_NEXT_COMMAND='restore the isolated Real PostgreSQL suite files, then re-run T1'
      die_t1 ZERO_TESTS_EXECUTED "isolated suite file missing or renamed: $relative"
    fi
    is_isolated_control_api_file "$path" || {
      T1_NEXT_COMMAND='keep the isolated Real PostgreSQL suite filenames in the T1 harness'
      die_t1 ZERO_TESTS_EXECUTED "isolated suite file is no longer routed away from control-postgres: $relative"
    }
  done
}

start_isolated_postgres() {
  ISOLATED_PORT="$(choose_local_port)"
  ISOLATED_CONTAINER="evenfire-t1-isolated-pg-$$"
  if ! docker run -d --rm --name "$ISOLATED_CONTAINER" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_DB=postgres \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -p "127.0.0.1:${ISOLATED_PORT}:5432" \
    "$T1_ISOLATED_PG_IMAGE" >/dev/null; then
    ISOLATED_CONTAINER=""
    T1_NEXT_COMMAND='repair Docker image postgres:16-alpine, then re-run T1'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'isolated T1 PostgreSQL container failed to start'
  fi
  if ! wait_for_tcp "$ISOLATED_PORT"; then
    T1_NEXT_COMMAND='repair Docker networking for the isolated T1 PostgreSQL, then re-run T1'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'isolated T1 PostgreSQL did not become reachable'
  fi
  local deadline ready=false
  deadline=$((SECONDS + T1_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if docker exec "$ISOLATED_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [ "$ready" != true ]; then
    T1_NEXT_COMMAND='inspect the isolated T1 PostgreSQL container, then re-run T1'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'isolated T1 PostgreSQL did not become ready'
  fi
  ISOLATED_DSN="$(printf '%s' "$ISOLATED_PORT" | python3 -c '
from urllib.parse import quote
import sys
port = sys.stdin.read().strip()
print("postgresql://postgres@127.0.0.1:" + port + "/postgres", end="")
')"
}

run_suite() {
  local package="$1" lane="$2" admin_url="$3"
  local expected_files=0 file log_file json_file stats
  local -a files=() vitest_filters=()

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if [ "$package" = control-api ] && is_isolated_control_api_file "$file"; then
      [ "$lane" = isolated ] || continue
    else
      [ "$lane" = shared ] || continue
    fi
    files+=("$file")
    vitest_filters+=("${file#"$PROJECT_DIR/$package/"}")
  done < <(list_real_pg_files "$package")

  expected_files="${#files[@]}"
  if ! [[ "$expected_files" =~ ^[1-9][0-9]*$ ]]; then
    T1_NEXT_COMMAND='restore the Real PostgreSQL suite files, then re-run T1'
    die_t1 ZERO_TESTS_EXECUTED "no Real PostgreSQL suites were found under $package ($lane)"
  fi
  if [ -z "$admin_url" ]; then
    T1_NEXT_COMMAND='repair the T1 PostgreSQL DSN route, then re-run T1'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE "Real PostgreSQL $lane DSN is empty for $package"
  fi

  log_file="$T1_TMP_DIR/$(printf '%s' "$package-$lane" | tr / _).log"
  json_file="$T1_TMP_DIR/$(printf '%s' "$package-$lane" | tr / _).json"
  printf '[minikube-t1] running %s %s Real PostgreSQL suites (%s files)\n' \
    "$package" "$lane" "$expected_files"
  # T1 verdict is the JSON reporter (expected files, executed/passed, zero
  # failures, zero pending). Capture npm's exit but do not treat a leftover
  # process exit after a complete green reporter as a failed suite.
  suite_status=0
  (
    cd "$PROJECT_DIR/$package"
    CONTROL_API_REAL_PG_ADMIN_URL="$admin_url" \
    CONTROL_API_REAL_PG_REQUIRED=1 FORCE_COLOR=0 NO_COLOR=1 \
      npm test -- --run "${vitest_filters[@]}" --reporter=json --outputFile="$json_file"
  ) >"$log_file" 2>&1 || suite_status=$?
  sanitize_file "$log_file"
  sanitize_file "$json_file"
  [ -s "$json_file" ] || {
    cat "$log_file" >&2 || true
    T1_NEXT_COMMAND='inspect the Vitest reporter output, then re-run T1'
    die_t1 ZERO_TESTS_EXECUTED "Real PostgreSQL reporter produced no result for $package ($lane)"
  }
  # Vitest's suite counters include nested describe blocks, so they are not
  # comparable to the number of physical *realPostgres*.test.ts files above.
  # Validate the reporter's own total/passed suite counts instead; the file
  # discovery count remains a separate zero-selection guard.
  if ! stats="$(python3 - "$json_file" "$expected_files" <<'PY'
import json
import sys
result = json.loads(open(sys.argv[1]).read())
expected = int(sys.argv[2])
files = result.get("testResults") or []
passed_files = sum(1 for item in files if item.get("status") == "passed")
total_suites = int(result.get("numTotalTestSuites") or 0)
passed_suites = int(result.get("numPassedTestSuites") or 0)
failed_suites = int(result.get("numFailedTestSuites") or 0)
passed_tests = int(result.get("numPassedTests") or 0)
failed_tests = int(result.get("numFailedTests") or 0)
pending_files = int(result.get("numPendingTestSuites") or 0)
pending_tests = int(result.get("numPendingTests") or 0)
total_tests = int(result.get("numTotalTests") or 0)
success = bool(result.get("success"))
print(total_suites, passed_suites, failed_suites, passed_files, passed_tests,
      failed_tests, pending_files, pending_tests, total_tests, int(success),
      expected, len(files))
PY
  )"; then
    cat "$log_file" >&2 || true
    cat "$json_file" >&2 || true
    T1_NEXT_COMMAND='inspect the Vitest reporter output, then re-run T1'
    die_t1 ZERO_TESTS_EXECUTED "Real PostgreSQL reporter was unreadable for $package ($lane)"
  fi
  read -r total_suites passed_suites failed_suites passed_files passed_tests \
    failed_tests pending_files pending_tests total_tests success expected \
    reported_files <<< "$stats"
  T1_TOTAL_TESTS=$((T1_TOTAL_TESTS + total_tests))
  T1_PASSED_TESTS=$((T1_PASSED_TESTS + passed_tests))
  T1_PENDING_TESTS=$((T1_PENDING_TESTS + pending_tests))
  if [ "$success" -ne 1 ] || [ "$total_suites" -le 0 ] || \
     [ "$passed_suites" -ne "$total_suites" ] || [ "$failed_suites" -ne 0 ] || \
     [ "$passed_files" -ne "$expected" ] || [ "$reported_files" -ne "$expected" ] || \
     [ "$failed_tests" -ne 0 ]; then
    T1_NEXT_COMMAND='repair the failed or incomplete Real PostgreSQL lane, then re-run T1'
    die_t1 REAL_PG_SUITE_FAILED "Real PostgreSQL reporter did not pass every suite in $package ($lane)"
  fi
  if [ "$total_tests" -le 0 ] || [ "$passed_tests" -le 0 ] || [ "$pending_files" -ne 0 ] || [ "$pending_tests" -ne 0 ]; then
    cat "$log_file" >&2 || true
    cat "$json_file" >&2 || true
    T1_NEXT_COMMAND='repair the test selection or database route; a T1 run cannot silently skip suites'
    die_t1 ZERO_TESTS_EXECUTED "Real PostgreSQL lane reported zero tests or skips in $package ($lane)"
  fi
  if [ "$suite_status" -ne 0 ]; then
    printf '[minikube-t1] vitest process exited %s after a complete green reporter for %s %s; T1 follows the reporter\n' \
      "$suite_status" "$package" "$lane"
  fi
  printf '[minikube-t1] PASS %s %s files=%s tests=%s skipped=0\n' \
    "$package" "$lane" "$passed_files" "$passed_tests"
}

main() {
  require_t1_commands
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
  if [ -z "$T2_CONTEXT" ]; then
    T1_NEXT_COMMAND='set CONTROL_API_REAL_PG_CONTEXT to the verified Kubernetes context'
    die_t1 REAL_PG_REQUIRED_BUT_UNAVAILABLE 'local Real PostgreSQL requires an explicit Minikube context'
  fi
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
  # Background kubectl DIRECTLY, not the t2_kc function. Backgrounding a shell
  # function forks a subshell, so $! is the subshell's PID and its command line
  # is this script's name — cleanup_t1's `svc/control-postgres` guard never
  # matches it, so the kill is skipped and the port-forward (plus the subshell)
  # orphan (PPID=1) past T1 into the T2 final preflight, tripping a spurious
  # PORT_FORWARD_CONFLICT. Backgrounding kubectl directly makes PORT_FORWARD_PID
  # the real forward whose command line the guard (and the wait) can act on.
  kubectl --context="$T2_CONTEXT" -n "$PG_NAMESPACE" port-forward --address=127.0.0.1 svc/"$PG_SERVICE" "$LOCAL_PORT:5432" \
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
  if t2_kc -n gfs get secret gfs-controller-db >/dev/null 2>&1; then
    # Real role-contract suites intentionally leave their cluster-global GFS
    # roles NOLOGIN during teardown. Restore the branch profile before T1
    # exits so the following T2 gate observes the production-like runtime.
    T1_GFS_RESTORE_REQUIRED=true
  fi

  ADMIN_DSN="$(printf '%s\0%s\0%s' "$PG_USER" "$PG_PASSWORD" "$LOCAL_PORT" | python3 -c '
from urllib.parse import quote
import sys
user, password, port = sys.stdin.buffer.read().split(b"\0")[:3]
print("postgresql://" + quote(user.decode(), safe="") + ":" + quote(password.decode(), safe="") + "@127.0.0.1:" + port.decode() + "/postgres", end="")
')"
  require_isolated_control_api_files
  start_isolated_postgres
  T1_GFS_RESTORE_REQUIRED=true
  run_suite control-api shared "$ADMIN_DSN"
  run_suite control-api isolated "$ISOLATED_DSN"
  run_suite gfs-controller shared "$ADMIN_DSN"
  unset PG_USER PG_PASSWORD PG_DATABASE T1_REDACT_PASSWORD
  unset ADMIN_DSN ISOLATED_DSN
  stop_isolated_postgres
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
