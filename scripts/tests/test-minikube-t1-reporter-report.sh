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

  # 2b. Spellings of a secret the first two cases did not cover. Each fixture
  #     is built from real producers (json.dump, quote, a DSN template) and
  #     first shown to contain the secret, so a redactor that never ran cannot
  #     pass; the reporter must still parse afterwards.
  # 2b-i. JavaScript's encodeURIComponent keeps !~*'() literal, which
  #       urllib's quote(safe="") does not, so 'ss%20word(x)' used to survive.
  uri_json="$TEST_DIR/uri.json"
  uri_password="pa'ss word(x)"
  python3 - "$uri_json" "$uri_password" <<'PY'
import json
import sys
from urllib.parse import quote

path, password = sys.argv[1], sys.argv[2]
js_encoded = quote(password, safe="-_.!~*'()")  # encodeURIComponent output
with open(path, "w") as handle:
    json.dump({"testResults": [{"message": f"connect failed, retry with ?pw={js_encoded}"}]}, handle)
PY
  grep -Fq "ss%20word(x)" "$uri_json" || fail 'encodeURIComponent fixture lacks the password (liveness witness missing)'
  T1_REDACT_PASSWORD="$uri_password" sanitize_file "$uri_json"
  assert_valid_json "$uri_json" 'encodeURIComponent password'
  grep -Fq '<password-redacted>' "$uri_json" || fail 'encodeURIComponent password was not redacted'
  grep -Fq 'ss%20word' "$uri_json" && fail 'the encodeURIComponent spelling of the password survived'

  # 2b-ii. A JSON document quoted inside a reporter message escapes the
  #        backslash twice.
  twice_json="$TEST_DIR/twice.json"
  twice_password='Zq7\Xv3'
  python3 - "$twice_json" "$twice_password" <<'PY'
import json
import sys

path, password = sys.argv[1], sys.argv[2]
inner = json.dumps({"failureMessages": [f"auth failed for {password}"]})
with open(path, "w") as handle:
    json.dump({"testResults": [{"message": inner}]}, handle)
PY
  grep -Fq 'Zq7' "$twice_json" || fail 'double-escaped fixture lacks the password (liveness witness missing)'
  T1_REDACT_PASSWORD="$twice_password" sanitize_file "$twice_json"
  assert_valid_json "$twice_json" 'doubly JSON-escaped password'
  grep -Fq '<password-redacted>' "$twice_json" || fail 'doubly escaped password was not redacted'
  grep -Fq 'Zq7' "$twice_json" && fail 'the doubly escaped spelling of the password survived'
  grep -Fq 'Xv3' "$twice_json" && fail 'the tail of the doubly escaped password survived'

  # 2b-iii. An upper-case scheme is still a DSN. No password is registered, so
  #         the DSN credentials must be removed on their own.
  upper_scheme="$(printf '%s' "$dsn_scheme" | tr '[:lower:]' '[:upper:]')"
  upper_json="$TEST_DIR/upper.json"
  python3 - "$upper_json" "$upper_scheme" <<'PY'
import json
import sys

path, scheme = sys.argv[1], sys.argv[2]
message = f"connect failed for {scheme}://gfs_runtime:UpperSecret1@db.internal:5432/app"
with open(path, "w") as handle:
    json.dump({"testResults": [{"message": message}]}, handle)
PY
  grep -Fq 'UpperSecret1' "$upper_json" || fail 'upper-case DSN fixture lacks the secret (liveness witness missing)'
  T1_REDACT_PASSWORD='' sanitize_file "$upper_json"
  assert_valid_json "$upper_json" 'upper-case DSN scheme'
  grep -Fq '<minikube-postgres-dsn-redacted>' "$upper_json" || fail 'upper-case DSN was not redacted'
  grep -Fq 'UpperSecret1' "$upper_json" && fail 'the credential of an upper-case DSN survived'

  # 2b-iv. libpq conninfo carries the password as password=..., bare or quoted.
  #        A bare value at the end of a JSON string must not eat the closing quote.
  conninfo_json="$TEST_DIR/conninfo.json"
  python3 - "$conninfo_json" <<'PY'
import json
import sys

# The quoted value carries the word "Fixture", the marker the public-boundary
# gate accepts for a synthetic credential assignment.
messages = [
    "connection to server failed: host=db.internal user=gfs password=BareSecret2",
    "connection to server failed: host=db.internal password='Quoted Fixture3' dbname=app",
    "PGPASSWORD=EnvSecret4 psql failed",
]
with open(sys.argv[1], "w") as handle:
    json.dump({"testResults": [{"message": message} for message in messages]}, handle)
PY
  for secret in BareSecret2 'Quoted Fixture3' EnvSecret4; do
    grep -Fq "$secret" "$conninfo_json" || fail "conninfo fixture lacks '$secret' (liveness witness missing)"
  done
  T1_REDACT_PASSWORD='' sanitize_file "$conninfo_json"
  assert_valid_json "$conninfo_json" 'libpq conninfo password'
  grep -Fq '<password-redacted>' "$conninfo_json" || fail 'conninfo password was not redacted'
  for secret in BareSecret2 'Quoted Fixture3' EnvSecret4; do
    grep -Fq "$secret" "$conninfo_json" && fail "conninfo password '$secret' survived"
  done
  grep -Fq 'host=db.internal' "$conninfo_json" || fail 'redaction removed the non-secret conninfo fields'

  # 2b-v. A password with a double quote inside a DSN is JSON-escaped, so the
  #       backslash used to end the redaction and leave the tail readable. No
  #       password is registered: the DSN userinfo must go on its own.
  tail_json="$TEST_DIR/tail.json"
  python3 - "$tail_json" "$dsn_scheme" <<'PY'
import json
import sys

path, scheme = sys.argv[1], sys.argv[2]
message = f'connect failed for {scheme}://gfs_runtime:Zq"TailSecret5@db.internal:5432/app'
with open(path, "w") as handle:
    json.dump({"testResults": [{"message": message}]}, handle)
PY
  grep -Fq 'TailSecret5' "$tail_json" || fail 'escaped-DSN fixture lacks the secret (liveness witness missing)'
  T1_REDACT_PASSWORD='' sanitize_file "$tail_json"
  assert_valid_json "$tail_json" 'JSON-escaped DSN with a quote in the password'
  grep -Fq '<minikube-postgres-dsn-redacted>' "$tail_json" || fail 'escaped DSN was not redacted'
  grep -Fq 'TailSecret5' "$tail_json" && fail 'the tail of a JSON-escaped DSN survived'
  grep -Fq 'db.internal' "$tail_json" && fail 'the DSN host survived redaction'

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
  # The counters line is the only place the suite/test totals reach the log.
  grep -Fq 'T1 reporter counters:' "$details" || fail 'the reporter counters line is missing'
  grep -Fq "'numTotalTestSuites': 3" "$details" || fail 'the counters line does not carry the suite total'
  grep -Fq "'numFailedTestSuites': 2" "$details" || fail 'the counters line does not carry the failed suite count'

  # 3b. The raw password, with JSON-special characters, as it appears in a
  #     plain-text log (not a JSON string). Only the verbatim spelling matches
  #     there: the JSON-escaped and percent-encoded spellings differ from it.
  plain_log="$TEST_DIR/plain.log"
  plain_password='Lg8"Pl\ain'
  printf 'vitest: auth failed for %s (retrying)\n' "$plain_password" >"$plain_log"
  grep -Fq "$plain_password" "$plain_log" || fail 'plain log fixture lacks the password (liveness witness missing)'
  T1_REDACT_PASSWORD="$plain_password" sanitize_file "$plain_log"
  grep -Fq '<password-redacted>' "$plain_log" || fail 'the verbatim password was not redacted in a plain log'
  grep -Fq 'Pl\ain' "$plain_log" && fail 'the verbatim spelling of the password survived in a plain log'
  grep -Fq 'Lg8' "$plain_log" && fail 'the head of the verbatim password survived in a plain log'

  # 3c. An Authorization header inside a reporter message. The token is
  #     mid-string in one message and ends the JSON string in the other: the
  #     redaction must stop before the closing quote in both.
  bearer_json="$TEST_DIR/bearer.json"
  bearer_token='FixtureBearerTok7'
  python3 - "$bearer_json" "$bearer_token" <<'PY'
import json
import sys

path, token = sys.argv[1], sys.argv[2]
messages = [
    f"request rejected: Authorization: Bearer {token} while calling the API",
    f"request rejected: Authorization: Bearer {token}",
]
with open(path, "w") as handle:
    json.dump({"testResults": [{"message": message} for message in messages]}, handle)
PY
  grep -Fq "$bearer_token" "$bearer_json" || fail 'bearer fixture lacks the token (liveness witness missing)'
  T1_REDACT_PASSWORD='' sanitize_file "$bearer_json"
  assert_valid_json "$bearer_json" 'Authorization bearer header'
  grep -Fq '<token-redacted>' "$bearer_json" || fail 'the bearer token was not redacted'
  grep -Fq "$bearer_token" "$bearer_json" && fail 'the bearer token survived redaction'
  grep -Fq 'Authorization: Bearer' "$bearer_json" || fail 'redaction removed the header name'

  # 4. The failure path of run_suite itself. Calling print_reporter_failure_details
  #    directly (case 3) cannot tell whether the script still calls it when the
  #    reporter says a suite failed. Here the real run_suite runs against a
  #    stand-in npm that writes a failing reporter, exactly as Vitest would, and
  #    the FAILED FILE line, the pre-test message and the counters must reach
  #    stderr, sanitized. run_suite runs under set -e, as in production.
  run_project="$TEST_DIR/run-project"
  run_file="$run_project/control-api/early.realPostgres.test.ts"
  mkdir -p "$run_project/control-api"
  printf 'fixture\n' >"$run_file"
  run_password='RunPlain9Secret'
  run_bearer='FixtureRunBearer8'
  npm_marker="$TEST_DIR/npm-ran"
  PROJECT_DIR="$run_project"
  T1_TMP_DIR="$TEST_DIR/run-tmp"
  mkdir -p "$T1_TMP_DIR"
  RUN_FILE="$run_file" RUN_DSN_SCHEME="$dsn_scheme" RUN_BEARER="$run_bearer" NPM_MARKER="$npm_marker"
  RUN_PASSWORD="$run_password"
  export RUN_FILE RUN_DSN_SCHEME RUN_BEARER NPM_MARKER RUN_PASSWORD
  npm() {
    local output_file=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --outputFile=*) output_file="${1#--outputFile=}" ;;
      esac
      shift
    done
    printf 'npm stand-in ran\n' >"$NPM_MARKER"
    printf 'vitest log: connect refused for %s\n' "$RUN_PASSWORD"
    python3 - "$output_file" <<'PY'
import json
import os
import sys

message = (
    "beforeAll failed: connect ECONNREFUSED "
    f"{os.environ['RUN_DSN_SCHEME']}://admin:{os.environ['RUN_PASSWORD']}@127.0.0.1:5432/postgres "
    f"with Authorization: Bearer {os.environ['RUN_BEARER']} on retry"
)
report = {
    "success": False,
    "numTotalTestSuites": 1,
    "numPassedTestSuites": 0,
    "numFailedTestSuites": 1,
    "numPendingTestSuites": 0,
    "numTotalTests": 0,
    "numPassedTests": 0,
    "numFailedTests": 0,
    "numPendingTests": 0,
    "testResults": [
        {"name": os.environ["RUN_FILE"], "status": "failed", "message": message, "assertionResults": []}
    ],
}
with open(sys.argv[1], "w") as handle:
    json.dump(report, handle)
PY
    return 1
  }
  export -f npm
  export RUN_PROJECT="$run_project" RUN_SCRIPT="$ROOT/scripts/e2e/minikube-real-postgres.sh" RUN_TMP="$T1_TMP_DIR"
  run_err="$TEST_DIR/run-suite.err"
  # A child bash, so that set -e is really in force: this subshell is itself the
  # left side of a || list, where set -e is ignored and die_t1 would not stop
  # run_suite the way it does in production.
  bash -c '
    set -euo pipefail
    source "$RUN_SCRIPT" >/dev/null 2>&1
    trap - EXIT INT TERM
    PROJECT_DIR="$RUN_PROJECT"
    T1_TMP_DIR="$RUN_TMP"
    T1_REDACT_PASSWORD="$RUN_PASSWORD"
    run_suite control-api isolated "$1"
  ' bash "$dsn_scheme://isolated" >"$TEST_DIR/run-suite.out" 2>"$run_err"
  run_status=$?
  [ -s "$npm_marker" ] || fail 'the npm stand-in never ran (liveness witness missing)'
  grep -Fq 'REAL_PG_SUITE_FAILED' "$run_err" || fail 'run_suite did not fail on the failing reporter'
  [ "$run_status" -ne 0 ] || fail 'run_suite returned success on a failing reporter'
  grep -Fq "FAILED FILE: $run_file" "$run_err" \
    || fail 'run_suite did not print the FAILED FILE line of the failing suite'
  grep -Fq 'beforeAll failed: connect ECONNREFUSED' "$run_err" \
    || fail 'run_suite did not print the pre-test failure message'
  grep -Fq 'T1 reporter counters:' "$run_err" || fail 'run_suite did not print the reporter counters'
  grep -Fq "'numFailedTestSuites': 1" "$run_err" || fail 'run_suite counters lack the failed suite count'
  grep -Fq '<token-redacted>' "$run_err" || fail 'the failure dump was not bearer-sanitized'
  grep -Fq '<password-redacted>' "$run_err" || fail 'the vitest log was not password-sanitized'
  grep -Fq "$run_password" "$run_err" && fail 'the password reached the run_suite failure output'
  grep -Fq "$run_bearer" "$run_err" && fail 'the bearer token reached the run_suite failure output'
  unset -f npm
  exit 0
) || fail 'T1 reporter sanitization or failure dump contract broken'

printf 'PASS: T1 reporter stays valid JSON after redaction and prints pre-test failure reasons\n'
