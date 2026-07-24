#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_HOST=control-postgres.control-plane.svc.cluster.local
PG_PORT=5432
PG_DB=profiles
PG_NS=control-plane
PG_PROBE_DEPLOY=deploy/control-api
DSN="postgresql://gfs_controller:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@${PG_HOST}:${PG_PORT}/${PG_DB}"
PROBE_MODE=authenticated

kc() {
  cat >/dev/null
  case "$PROBE_MODE" in
    authenticated) printf gfs_controller ;;
    rejected) printf GFS_DSN_AUTH_REJECTED; return 41 ;;
    unavailable) return 1 ;;
    ambiguous) return 41 ;;
  esac
}

source "$ROOT/deploy/scripts/lib/gfs-dsn-probe.sh"
grep -q 'error.code === "28P01".*error.code === "28000"' \
  "$ROOT/deploy/scripts/lib/gfs-dsn-probe.sh" \
  || { printf 'FAIL: probe does not limit rejection to PostgreSQL authentication SQLSTATEs\n' >&2; exit 1; }

gfs_dsn_authenticates_as "$DSN" gfs_controller \
  || { printf 'FAIL: authenticated DSN was rejected\n' >&2; exit 1; }

for mode_and_rc in rejected:1 unavailable:2 ambiguous:2; do
  PROBE_MODE="${mode_and_rc%%:*}"
  expected="${mode_and_rc##*:}"
  set +e
  gfs_dsn_authenticates_as "$DSN" gfs_controller
  rc=$?
  set -e
  [ "$rc" -eq "$expected" ] \
    || { printf 'FAIL: %s probe returned %s, expected %s\n' "$PROBE_MODE" "$rc" "$expected" >&2; exit 1; }
done

calls="$(mktemp)"
set +e
(
  GFS_NS=gfs
  GFS_RECOVER_ABANDONED_STATE=true
  die() { exit 70; }
  log() { :; }
  dsn_has_role() { return 0; }
  dsn_authenticates_as() { printf 'probe:%s\n' "$1" >>"$calls"; return 2; }
  role_can_login() { printf role-state >>"$calls"; return 1; }
  release_abandoned_candidate() { printf mutation >>"$calls"; return 1; }
  source "$ROOT/deploy/scripts/lib/gfs-credential-recovery.sh"
  recover_abandoned_applying gfs_controller_reader reader-secret active candidate
) >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 70 ] || { rm -f "$calls"; printf 'FAIL: unavailable recovery probe returned %s\n' "$rc" >&2; exit 1; }
[ "$(cat "$calls")" = 'probe:candidate' ] \
  || { rm -f "$calls"; printf 'FAIL: unavailable recovery probe performed a mutation\n' >&2; exit 1; }
rm -f "$calls"

printf 'PASS: GFS DSN probe distinguishes rejection from unavailability\n'
