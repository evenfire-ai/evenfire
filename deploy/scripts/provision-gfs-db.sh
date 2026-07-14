#!/usr/bin/env bash
# Provision the least-privilege gfs_controller Postgres login for gfsc.
#
# Migration 0043 creates the `gfs_controller` role NOLOGIN (SELECT on
# resource/grant/share, INSERT-only on gfs_audit). This script completes the
# deliberate two-step security model: it grants LOGIN + a password and writes
# the real DSN into the `gfs-controller-db` Secret (shipped empty), then rolls
# gfsc so it picks the credential up. gfsc /readyz fails closed until this runs.
#
# CONTEXT-aware (never relies on the current kube-context). Idempotent: re-running
# rotates the password and re-patches the Secret.
#
# Usage:
#   CONTEXT=<kube-context> [PG_DEPLOY=deploy/control-postgres] [PG_NS=control-plane] \
#   [PG_DB=profiles] [PG_SUPERUSER=postgres] [GFS_NS=gfs] \
#   deploy/scripts/provision-gfs-db.sh
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
PG_NS="${PG_NS:-control-plane}"
PG_DEPLOY="${PG_DEPLOY:-deploy/control-postgres}"
PG_DB="${PG_DB:-profiles}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
PG_HOST="${PG_HOST:-control-postgres.control-plane.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
GFS_NS="${GFS_NS:-gfs}"
GFS_DB_SECRET="${GFS_DB_SECRET:-gfs-controller-db}"
GFS_DEPLOY_SELECTOR="${GFS_DEPLOY_SELECTOR:-clerum.io/managed-by=host-context-controller}"

kc() { kubectl --context="$CONTEXT" "$@"; }
log() { printf '[provision-gfs-db] %s\n' "$*"; }
write_secret_patch() {
  python3 -c 'import json, sys; print(json.dumps({"stringData": {"connection-string": sys.stdin.read()}}))'
}

# A URL-safe password (hex — no characters that need DSN escaping).
ROLE_SECRET="$(openssl rand -hex 24)"

log "Granting LOGIN to gfs_controller (rotating password) in ${PG_NS}/${PG_DEPLOY} db=${PG_DB}"
# ALTER ROLE is idempotent; the role must already exist (migration 0043). If it
# does not, fail loud — gfsc cannot work without the permission store role.
kc -n "$PG_NS" exec -i "$PG_DEPLOY" -- psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$PG_DB" -f - <<SQL
DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gfs_controller') THEN RAISE EXCEPTION 'gfs_controller role missing — run control-api migrations (0043) first'; END IF; END \$\$;
\set gfs_role_secret $ROLE_SECRET
SELECT format('ALTER ROLE gfs_controller LOGIN %s %L', 'PASS' || 'WORD', :'gfs_role_secret') \gexec
SQL

DSN="postgresql://gfs_controller:${ROLE_SECRET}@${PG_HOST}:${PG_PORT}/${PG_DB}"

log "Writing DSN into ${GFS_NS}/${GFS_DB_SECRET}.connection-string"
printf '%s' "$DSN" | write_secret_patch | kc -n "$GFS_NS" patch secret "$GFS_DB_SECRET" --type=merge --patch-file=/dev/stdin >/dev/null

if kc -n "$GFS_NS" get deployment -l "$GFS_DEPLOY_SELECTOR" -o name 2>/dev/null | grep -q .; then
  log "Rolling gfsc so it picks up the new credential"
  kc -n "$GFS_NS" rollout restart deployment -l "$GFS_DEPLOY_SELECTOR" >/dev/null
  kc -n "$GFS_NS" rollout status deployment -l "$GFS_DEPLOY_SELECTOR" --timeout=120s
else
  log "No gfsc deployments yet; DSN is staged for future pods"
fi

log "Done."
