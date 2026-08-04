#!/usr/bin/env bash
# Prove that active GFS credentials can be restored after PostgreSQL recreation.
# This preflight intentionally inspects Kubernetes metadata only: it must remain
# usable when PostgreSQL is unavailable or corrupt.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GFS_NS="${GFS_NS:-gfs}"
PG_HOST="${PG_HOST:-control-postgres.control-plane.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-profiles}"

# shellcheck source=/dev/null
source "$ROOT/deploy/scripts/lib/gfs-dsn-probe.sh"
# shellcheck source=/dev/null
source "$ROOT/deploy/scripts/lib/gfs-credential-secret.sh"

kc() { kubectl --context="$CONTEXT" "$@"; }
fail() { printf '[preflight-gfs-db-reset] ERROR: %s\n' "$*" >&2; exit 1; }

validate_restorable_secret() {
  local secret="$1" expected_role="$2"

  load_secret_snapshot "$secret" \
    || fail "cannot read a valid snapshot for ${GFS_NS}/${secret}"
  [ "$GFS_SNAPSHOT_STATE" = "ready" ] \
    || fail "${GFS_NS}/${secret} is not in ready state"
  [ -z "$GFS_SNAPSHOT_PENDING" ] \
    || fail "${GFS_NS}/${secret} has a pending credential"
  [ -n "$GFS_SNAPSHOT_ACTIVE" ] \
    || fail "${GFS_NS}/${secret} has no active credential to restore"
  printf '%s' "$GFS_SNAPSHOT_ACTIVE" \
    | gfs_dsn_validate "$expected_role" "$PG_HOST" "$PG_PORT" "$PG_DB" \
    || fail "${GFS_NS}/${secret} active credential violates the expected DSN contract"
}

# Migrate only the legacy kubectl apply ownership record. This never reads or
# changes Secret data and makes the active writer credential safe from a later
# overlay apply.
CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/apply-gfs-writer-secret.sh"
validate_restorable_secret gfs-controller-db gfs_controller
validate_restorable_secret gfs-controller-reader-db gfs_controller_reader

printf '[preflight-gfs-db-reset] active writer and reader credentials are restorable\n' >&2
