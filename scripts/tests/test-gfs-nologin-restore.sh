#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run_restore() (
  set -euo pipefail
  calls="$1"; export GFS_RESTORE_ACTIVE_NOLOGIN="$2"
  state="$3"; login="$4"; pre_ok="$5"; set_ok="$6"; auth_rc="$7"; post_ok="$8"
  log() { :; }
  role_can_login() { printf '%s' "$login"; }
  verify_role_contract() {
    if [ "${3:-true}" = false ]; then
      printf 'pre-contract\n' >>"$calls"; [ "$pre_ok" = yes ]
    else
      printf 'post-contract\n' >>"$calls"; [ "$post_ok" = yes ]
    fi
  }
  gfs_dsn_password() { cat >/dev/null; printf exact-password; }
  set_role_password() {
    printf 'set:%s:%s\n' "$1" "$2" >>"$calls"
    [ "$set_ok" = yes ]
  }
  dsn_authenticates_as() { printf 'auth\n' >>"$calls"; return "$auth_rc"; }
  disable_role_login() { printf 'disable:%s\n' "$1" >>"$calls"; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
  restore_nologin_role_from_active gfs_controller writer active-dsn "$state"
)

assert_failure_without_set() {
  local name="$1" flag="$2" state="$3" login="$4" pre="$5" set_ok="$6" auth="$7" post="$8" calls
  calls="$(mktemp)"
  if run_restore "$calls" "$flag" "$state" "$login" "$pre" "$set_ok" "$auth" "$post"; then
    rm -f "$calls"; fail "$name unexpectedly succeeded"
  fi
  ! grep -q '^set:' "$calls" || { rm -f "$calls"; fail "$name mutated the role"; }
  rm -f "$calls"
}

assert_failure_without_set no-flag false ready f yes yes 0 yes
assert_failure_without_set wrong-state true applying f yes yes 0 yes
assert_failure_without_set already-login true ready t yes yes 0 yes
assert_failure_without_set pre-contract true ready f no yes 0 yes

calls="$(mktemp)"
set +e
(
  set -euo pipefail
  GFS_RESTORE_ACTIVE_NOLOGIN=true
  die() { exit 70; }
  dsn_authenticates_as() { printf auth >>"$calls"; return 2; }
  role_can_login() { printf role-state >>"$calls"; return 1; }
  set_role_password() { printf set >>"$calls"; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
  authenticate_or_restore_nologin gfs_controller writer active-dsn ready writer
)
rc=$?
set -e
[ "$rc" -eq 70 ] || { rm -f "$calls"; fail "pre-restore unavailable probe returned $rc"; }
[ "$(cat "$calls")" = auth ] || { rm -f "$calls"; fail 'pre-restore unavailable probe mutated the role'; }
rm -f "$calls"

calls="$(mktemp)"
run_restore "$calls" true ready f yes yes 0 yes || fail 'valid explicit restore failed'
[ "$(grep -c '^set:gfs_controller:exact-password$' "$calls")" -eq 1 ] || fail 'password was not restored exactly once'
[ "$(cat "$calls")" = $'pre-contract\nset:gfs_controller:exact-password\nauth\npost-contract' ] \
  || fail 'restore verification order changed'
rm -f "$calls"

for failure in set auth post; do
  calls="$(mktemp)"
  set_ok=yes; auth=0; post=yes
  [ "$failure" != set ] || set_ok=no
  [ "$failure" != auth ] || auth=1
  [ "$failure" != post ] || post=no
  ! run_restore "$calls" true ready f yes "$set_ok" "$auth" "$post" \
    || { rm -f "$calls"; fail "$failure failure was reported as success"; }
  rm -f "$calls"
done

for auth_failure in 1 2; do
  calls="$(mktemp)"
  ! run_restore "$calls" true ready f yes yes "$auth_failure" yes \
    || { rm -f "$calls"; fail "auth rc=$auth_failure was reported as success"; }
  [ "$(grep -c '^disable:gfs_controller$' "$calls")" -eq 1 ] \
    || { rm -f "$calls"; fail "auth rc=$auth_failure did not compensate to NOLOGIN"; }
  rm -f "$calls"
done

calls="$(mktemp)"
! run_restore "$calls" true ready f yes yes 0 no \
  || { rm -f "$calls"; fail 'post-contract failure was reported as success'; }
[ "$(grep -c '^disable:gfs_controller$' "$calls")" -eq 1 ] \
  || { rm -f "$calls"; fail 'post-contract failure did not compensate to NOLOGIN'; }
rm -f "$calls"

printf 'PASS: explicit NOLOGIN restoration is gated and fail-closed\n'
