#!/usr/bin/env bash
# Exercise fixture cleanup without signalling any real process.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/branch-profile-fixture-process.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/records"

# shellcheck source=scripts/minikube/port-forward-owner.sh
source "$ROOT/scripts/minikube/port-forward-owner.sh"
# shellcheck source=scripts/tests/lib/branch-profile-fixture-process.sh
source "$ROOT/scripts/tests/lib/branch-profile-fixture-process.sh"

pf_owner_process_state() { cat "$tmp/state"; }
pf_owner_process_start() {
  local count
  if [[ "${EXIT_BEFORE_START_READ:-false}" == true ]]; then
    printf 'dead\n' >"$tmp/state"
    return 1
  fi
  count="$(cat "$tmp/start-count")"
  printf '%s\n' "$((count + 1))" >"$tmp/start-count"
  if [[ "${CHANGE_START_ON_SECOND_READ:-false}" == true && "$count" -ge 1 ]]; then
    printf '%s\n' 'different start'
  else
    printf '%s\n' "$ACTUAL_START"
  fi
}
pf_owner_process_command() {
  [[ "$ACTUAL_COMMAND" != unreadable ]] || return 1
  printf '%s\n' "$ACTUAL_COMMAND"
}
pf_owner_signal_process() {
  printf '%s %s\n' "$1" "$2" >>"$tmp/signals"
  printf 'dead\n' >"$tmp/state"
}
pf_owner_reap_process() { :; }
pf_owner_pause() { :; }

reset_fixture() {
  rm -f -- "$tmp/records/"*
  rm -f -- "$tmp/records/.closed"
  printf 'live\n' >"$tmp/state"
  printf '0\n' >"$tmp/start-count"
  : >"$tmp/signals"
  ACTUAL_START='Sun Nov  1 10:11:12 2026'
  ACTUAL_COMMAND='bash /fixture/kubectl --context=fixture'
  CHANGE_START_ON_SECOND_READ=false
  EXIT_BEFORE_START_READ=false
  fixture_process_register "$tmp/records" 4242 'fixture/kubectl --context=fixture'
  record=''
  for candidate in "$tmp/records/"*.ready; do
    [[ -f "$candidate" ]] && record="$candidate"
  done
  [[ -n "$record" ]] || { printf 'FAIL: fixture record missing\n' >&2; exit 1; }
  printf '0\n' >"$tmp/start-count"
}

assert_no_signal() {
  [[ ! -s "$tmp/signals" ]] || { printf 'FAIL: %s signalled a process\n' "$1" >&2; exit 1; }
}

reset_fixture
ACTUAL_START='Sun Nov  1 10:11:13 2026'
fixture_process_cleanup_record "$record"
assert_no_signal 'reused PID'

reset_fixture
CHANGE_START_ON_SECOND_READ=true
fixture_process_cleanup_record "$record"
assert_no_signal 'changed start during verification'

reset_fixture
EXIT_BEFORE_START_READ=true
fixture_process_cleanup_record "$record"
assert_no_signal 'process exited during verification'

for invalid_command in 'other process' unreadable; do
  reset_fixture
  ACTUAL_COMMAND="$invalid_command"
  if fixture_process_cleanup_record "$record"; then
    printf 'FAIL: unverified command was accepted\n' >&2
    exit 1
  fi
  assert_no_signal 'unverified command'
done

reset_fixture
printf '4242\n' >"$record"
if fixture_process_cleanup_record "$record"; then
  printf 'FAIL: incomplete fixture record was accepted\n' >&2
  exit 1
fi
assert_no_signal 'incomplete record'

reset_fixture
printf 'unknown\n' >"$tmp/state"
if fixture_process_cleanup_record "$record"; then
  printf 'FAIL: unknown process state was accepted\n' >&2
  exit 1
fi
assert_no_signal 'unknown process state'

reset_fixture
printf 'dead\n' >"$tmp/state"
fixture_process_cleanup_record "$record"
assert_no_signal 'dead process'

for command in 'bash /fixture/kubectl --context=fixture' 'fixture/kubectl --context=fixture'; do
  reset_fixture
  ACTUAL_COMMAND="$command"
  fixture_process_cleanup_record "$record"
  [[ "$(cat "$tmp/signals")" == '4242 KILL' ]] || {
    printf 'FAIL: exact fixture identity was not signalled once\n' >&2
    exit 1
  }
done

reset_fixture
fixture_process_close_registration "$tmp/records"
if fixture_process_register "$tmp/records" 4243 'late fixture process'; then
  printf 'FAIL: process registered after fixture cleanup began\n' >&2
  exit 1
fi
rmdir -- "$tmp/records/.lock"
if fixture_process_register "$tmp/records" 4243 'late fixture process'; then
  printf 'FAIL: process registered after a closed fixture retained its evidence\n' >&2
  exit 1
fi
assert_no_signal 'closed registration'

reset_fixture
fixture_process_close_registration "$tmp/records"
(
  pf_owner_pause() { : >"$tmp/registrar-waiting"; /bin/sleep 0.01; }
  if fixture_process_register "$tmp/records" 4243 'late fixture process'; then exit 1; fi
) &
registrar=$!
for ((attempt = 0; attempt < 200; attempt += 1)); do
  [[ -e "$tmp/registrar-waiting" ]] && break
  /bin/sleep 0.01
done
[[ -e "$tmp/registrar-waiting" ]] || { printf 'FAIL: registrar did not wait for cleanup\n' >&2; exit 1; }
mv -- "$tmp/records" "$tmp/closed-records"
if ! wait "$registrar" || [[ -e "$tmp/records" ]]; then
  printf 'FAIL: process registered after the fixture registry was moved\n' >&2
  exit 1
fi
assert_no_signal 'moved registration'

printf 'PASS: fixture cleanup verifies process identity before signalling\n'
