#!/usr/bin/env bash
# Contract test for admin_create_team_for_user in scripts/e2e/e2e-workflow-triggers.sh:
# POST /admin/teams creates the team only, so the helper must make the user a member in
# a second call, as scripts/e2e/seed-e2e-data.sh does.
#
# Hermetic: the helper and its two pure dependencies are extracted from the script, and
# http_request is a stub that records each call and answers from a queue.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/e2e/e2e-workflow-triggers.sh"
TEAM_ID="11111111-1111-4111-8111-111111111111"
USER_ID="22222222-2222-4222-8222-222222222222"

FAILED=0
PASSED=0
pass() { echo "PASS: $1"; PASSED=$((PASSED + 1)); }
check_fail() { echo "FAIL: $1"; FAILED=$((FAILED + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

extract_function() {
  awk -v start="^$1\\\\(\\\\) \\\\{" '$0 ~ start { on = 1 } on { print } on && /^}/ { exit }' "$SCRIPT"
}
for fn in admin_create_team_for_user json_field authz_header; do
  extract_function "$fn" >>"$WORK/functions.sh"
  if grep -q "^${fn}() {" "$WORK/functions.sh"; then
    pass "extracted ${fn}"
  else
    check_fail "${fn} not found in the script"
  fi
done

# Runs the helper in a subshell. Queue lines are "<status> <json>".
run_helper() {
  local log="$WORK/calls.log" queue="$WORK/queue.txt"
  : >"$log"
  printf '%s\n' "$@" >"$queue"
  (
    fail() { echo "HELPER_FAIL: $*" >&2; exit 1; }
    http_request() {
      printf '%s %s %s\n' "$1" "$2" "$3" >>"$log"
      local n reply
      n="$(wc -l <"$log" | tr -d ' ')"
      reply="$(sed -n "${n}p" "$queue")"
      # shellcheck disable=SC2034  # read by the sourced helper
      HTTP_STATUS="${reply%% *}"
      # shellcheck disable=SC2034  # read by the sourced helper
      HTTP_BODY="${reply#* }"
    }
    export CONTROL_URL="http://capi.test"
    export ADMIN_TOKEN="admin-token"
    # shellcheck source=/dev/null
    . "$WORK/functions.sh"
    admin_create_team_for_user "e2e team" "$USER_ID"
  )
}

# The team call, then the membership call.
output="$(run_helper "200 {\"id\":\"${TEAM_ID}\"}" "200 {\"teamId\":\"${TEAM_ID}\"}" 2>/dev/null)"
status=$?
[ "$status" -eq 0 ] && pass "both calls succeed: exit 0" || check_fail "both calls succeed: exit $status"
[ "$output" = "$TEAM_ID" ] && pass "prints only the team id" || check_fail "printed '$output'"
first_call="$(sed -n 1p "$WORK/calls.log")"
second_call="$(sed -n 2p "$WORK/calls.log")"
expected_first="POST http://capi.test/api/v1/admin/teams {\"name\":\"e2e team\"}"
expected_second="POST http://capi.test/api/v1/admin/teams/${TEAM_ID}/members {\"userId\":\"${USER_ID}\",\"role\":\"admin\"}"
[ "$first_call" = "$expected_first" ] && pass "creates the team with its name only" || check_fail "first call: $first_call"
[ "$second_call" = "$expected_second" ] && pass "adds the user as an admin member" || check_fail "second call: $second_call"
[ "$(wc -l <"$WORK/calls.log" | tr -d ' ')" = "2" ] && pass "makes exactly two calls" || check_fail "calls: $(cat "$WORK/calls.log")"

# A failed membership call stops the helper.
error="$(run_helper "200 {\"id\":\"${TEAM_ID}\"}" "500 {\"error\":\"boom\"}" 2>&1 >/dev/null)"
status=$?
[ "$status" -ne 0 ] && pass "a failed membership call fails" || check_fail "a failed membership call exited 0"
[ "$(wc -l <"$WORK/calls.log" | tr -d ' ')" = "2" ] && pass "witness: the membership call ran" || check_fail "calls: $(cat "$WORK/calls.log")"
case "$error" in
  *"HTTP 200, got 500"*) pass "the failure names the status" ;;
  *) check_fail "failure message: $error" ;;
esac

# A failed team call never reaches the membership call.
run_helper "500 {\"error\":\"boom\"}" >/dev/null 2>&1
status=$?
[ "$status" -ne 0 ] && pass "a failed team call fails" || check_fail "a failed team call exited 0"
[ "$(wc -l <"$WORK/calls.log" | tr -d ' ')" = "1" ] && pass "no membership call after a failed team call" || check_fail "calls: $(cat "$WORK/calls.log")"

echo "PASSED=$PASSED FAILED=$FAILED"
[ "$PASSED" -gt 0 ] || { echo "FAIL: no checks ran"; exit 1; }
[ "$FAILED" -eq 0 ]
