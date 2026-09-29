#!/usr/bin/env bash
# T1 must keep the Vitest JSON reporter parseable after redaction and must print
# the file-level message of a suite that failed before any test ran. Only the
# T1 function definitions are sourced; nothing here touches a cluster or Docker.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-t1-reporter.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT

(
  set +e
  export MINIKUBE_PROFILE=t1-reporter-contract
  export T2_CONTEXT=t1-reporter-contract
  source "$ROOT/scripts/e2e/minikube-real-postgres.sh" >/dev/null 2>&1
  trap - EXIT INT TERM
  set +e
  declare -F sanitize_file >/dev/null || fail 'sanitize_file is not defined'
  declare -F print_reporter_failure_details >/dev/null || fail 'print_reporter_failure_details is not defined'

  assert_valid_json() {
    python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$1" \
      || fail "$2: sanitized reporter is not valid JSON"
  }

  # 1. A DSN followed by an escaped quote must not swallow the escape.
  # The synthetic DSNs are assembled at run time so this file carries no
  # literal scheme://user:password@host, which the public-boundary gate rejects.
  dsn_scheme=postgresql
  dsn_json="$TEST_DIR/dsn.json"
  printf '{"failureMessages":["expected \\"%s://u:p@h/db\\" to be undefined"]}' "$dsn_scheme" >"$dsn_json"
  T1_REDACT_PASSWORD='' sanitize_file "$dsn_json"
  assert_valid_json "$dsn_json" 'DSN inside a JSON string'
  grep -Fq '<minikube-postgres-dsn-redacted>' "$dsn_json" \
    || fail 'DSN was not redacted (liveness witness missing)'
  grep -Fq 'u:p@h' "$dsn_json" && fail 'DSN credential survived redaction'

  # 2. A password with JSON-special characters is redacted in every spelling.
  pw_json="$TEST_DIR/password.json"
  password='s3cr"et\pw'
  python3 - "$pw_json" "$password" <<'PY'
import json
import sys
from urllib.parse import quote

path, password = sys.argv[1], sys.argv[2]
message = (
    f"auth failed for {password} "
    f"see http://example.invalid/?p={quote(password, safe='')}"
)
with open(path, "w") as handle:
    json.dump({"testResults": [{"message": message}]}, handle)
PY
  grep -Fq 's3cr' "$pw_json" || fail 'fixture does not contain the password (liveness witness missing)'
  T1_REDACT_PASSWORD="$password" sanitize_file "$pw_json"
  assert_valid_json "$pw_json" 'JSON-escaped password'
  grep -Fq '<password-redacted>' "$pw_json" || fail 'password was not redacted'
  grep -Fq 's3cr' "$pw_json" && fail 'a spelling of the password survived redaction'

  # 3. A suite that failed before any test has no assertionResults; its reason
  #    is the file-level message and must be printed after the FAILED FILE line.
  report="$TEST_DIR/report.json"
  cat >"$report" <<JSON
{
  "success": false,
  "numTotalTestSuites": 3,
  "numPassedTestSuites": 1,
  "numFailedTestSuites": 2,
  "numTotalTests": 1,
  "numPassedTests": 1,
  "numFailedTests": 0,
  "testResults": [
    {"name": "/repo/control-api/ok.realPostgres.test.ts", "status": "passed",
     "message": "", "assertionResults": [{"status": "passed", "title": "works"}]},
    {"name": "/repo/control-api/early.realPostgres.test.ts", "status": "failed",
     "message": "beforeAll failed: connect ECONNREFUSED ${dsn_scheme}://admin:hunter2@127.0.0.1:5432/postgres",
     "assertionResults": []},
    {"name": "/repo/control-api/late.realPostgres.test.ts", "status": "failed",
     "message": "",
     "assertionResults": [{"status": "failed", "fullName": "late fails",
                           "failureMessages": ["assertion detail LATE-DETAIL"]}]}
  ]
}
JSON
  T1_REDACT_PASSWORD='hunter2' sanitize_file "$report"
  assert_valid_json "$report" 'reporter with a pre-test failure'
  details="$TEST_DIR/details.out"
  print_reporter_failure_details "$report" >"$details" 2>&1 || fail 'print_reporter_failure_details failed'
  grep -Fq 'FAILED FILE: /repo/control-api/early.realPostgres.test.ts' "$details" \
    || fail 'the failed file was not printed (liveness witness missing)'
  grep -Fq 'FAILED FILE: /repo/control-api/late.realPostgres.test.ts' "$details" \
    || fail 'the assertion-failure file was not printed'
  grep -Fq 'LATE-DETAIL' "$details" || fail 'assertion failure messages are no longer printed'
  grep -Fq 'ok.realPostgres' "$details" && fail 'a passing file was printed as failed'
  early_next="$(grep -A1 -F 'FAILED FILE: /repo/control-api/early.realPostgres.test.ts' "$details" | tail -n 1)"
  case "$early_next" in
    'beforeAll failed: connect ECONNREFUSED '*) ;;
    *) fail "pre-test failure reason was not printed after FAILED FILE: '$early_next'" ;;
  esac
  grep -Fq 'hunter2' "$details" && fail 'a credential reached the failure dump'
  grep -Fq '<minikube-postgres-dsn-redacted>' "$details" \
    || fail 'the dumped message was not sanitized'
  exit 0
) || fail 'T1 reporter sanitization or failure dump contract broken'

printf 'PASS: T1 reporter stays valid JSON after redaction and prints pre-test failure reasons\n'
