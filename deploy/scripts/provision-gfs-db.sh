#!/usr/bin/env bash
# Reconcile or explicitly rotate the two least-privilege GFSC database logins.
# `stage-writer` adopts or validates without rotating; `stage-reader` is
# additive and rolls only a reader recovering a newly committed credential.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gfs-dsn-probe.sh
source "${SCRIPT_DIR}/lib/gfs-dsn-probe.sh"
# shellcheck source=lib/gfs-credential-secret.sh
source "${SCRIPT_DIR}/lib/gfs-credential-secret.sh"
# shellcheck source=lib/gfs-credential-rollout.sh
source "${SCRIPT_DIR}/lib/gfs-credential-rollout.sh"
# shellcheck source=lib/gfs-credential-recovery.sh
source "${SCRIPT_DIR}/lib/gfs-credential-recovery.sh"

usage() {
  cat <<'EOF'
Usage: CONTEXT=<kube-context> deploy/scripts/provision-gfs-db.sh <mode>

Modes (required; there is no default):
  stage-writer   Validate and atomically adopt/reconcile the existing writer without rotation
  stage-reader   Reconcile reader; rollout only to recover a stale deployed reader
  rotate-reader  Rotate only the reader credential and restart only gfsc-reader
  rotate-writer  Rotate only the writer credential and restart only gfsc-writer
EOF
}

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
MODE="${1:-}"
[ $# -eq 1 ] || { usage >&2; exit 2; }
case "$MODE" in
  stage-writer|stage-reader|rotate-reader|rotate-writer) ;;
  *) usage >&2; exit 2 ;;
esac

PG_NS="${PG_NS:-control-plane}"
PG_DEPLOY="${PG_DEPLOY:-deploy/control-postgres}"
PG_PROBE_DEPLOY="${PG_PROBE_DEPLOY:-deploy/control-api}"
PG_DB="${PG_DB:-profiles}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
PG_HOST="${PG_HOST:-control-postgres.control-plane.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
GFS_NS="${GFS_NS:-gfs}"
WRITER_SECRET="${GFS_WRITER_DB_SECRET:-gfs-controller-db}"
READER_SECRET="${GFS_READER_DB_SECRET:-gfs-controller-reader-db}"
# Consumed by the sourced, domain-specific rollout helper.
# shellcheck disable=SC2034
ROLLOUT_TIMEOUT="${GFS_ROLLOUT_TIMEOUT:-240s}"

kc() { kubectl --context="$CONTEXT" "$@"; }
log() { printf '[provision-gfs-db] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

secret_value() {
  local secret="$1" key="$2" encoded decoded
  if ! encoded="$(kc -n "$GFS_NS" get secret "$secret" -o "jsonpath={.data.${key}}")"; then
    die "cannot read ${GFS_NS}/$secret; refusing to treat an API or RBAC failure as an absent credential"
  fi
  [ -n "$encoded" ] || return 0
  if ! decoded="$(printf '%s' "$encoded" | base64 -d)"; then
    die "${GFS_NS}/$secret contains an invalid $key encoding"
  fi
  printf '%s' "$decoded"
}

secret_dsn() { secret_value "$1" connection-string; }
pending_dsn() { secret_value "$1" pending-connection-string; }
secret_resource_version() {
  kc -n "$GFS_NS" get secret "$1" -o 'jsonpath={.metadata.resourceVersion}'
}

dsn_has_role() {
  local dsn="$1" role="$2"
  printf '%s' "$dsn" | gfs_dsn_validate "$role" "$PG_HOST" "$PG_PORT" "$PG_DB"
}

dsn_authenticates_as() {
  gfs_dsn_authenticates_as "$1" "$2"
}

verify_role_contract() {
  local role="$1" kind="$2" login_required="${3:-true}"
  log "Verifying ${kind} role attributes and privilege boundary"
  kc -n "$PG_NS" exec -i "$PG_DEPLOY" -- psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$PG_DB" -v role_name="$role" -v role_kind="$kind" -v login_required="$login_required" -f - <<'SQL'
SELECT EXISTS (
  SELECT 1 FROM pg_roles
  WHERE rolname = :'role_name'
    AND ((:'login_required' = 'true' AND rolcanlogin)
      OR (:'login_required' = 'false' AND NOT rolcanlogin))
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls
    AND NOT rolinherit
    AND NOT EXISTS (
      SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid
    )
) AS role_ok \gset
\if :role_ok
\else
SELECT 1/0;
\endif
SELECT (:'role_kind' <> 'reader' OR (
  has_table_privilege(:'role_name', 'gfs_resources', 'SELECT')
  AND has_table_privilege(:'role_name', 'gfs_grants', 'SELECT')
  AND has_table_privilege(:'role_name', 'gfs_shares', 'SELECT')
  AND has_table_privilege(:'role_name', 'gfs_audit', 'INSERT')
  AND has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'USAGE')
  AND has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'SELECT')
  AND NOT has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'UPDATE')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_resources', 'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_resources', 'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_grants', 'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_grants', 'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_shares', 'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_shares', 'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_blob_manifests', 'SELECT,INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_blob_manifests', 'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_audit', 'SELECT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_audit', 'DELETE,TRUNCATE,TRIGGER')
)) AS privilege_ok \gset
\if :privilege_ok
\else
SELECT 1/0;
\endif
SELECT (:'role_kind' <> 'writer' OR (
  has_table_privilege(:'role_name', 'gfs_resources', 'SELECT')
  AND has_table_privilege(:'role_name', 'gfs_resources', 'INSERT')
  AND has_table_privilege(:'role_name', 'gfs_resources', 'UPDATE')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_resources', 'REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_resources', 'DELETE,TRUNCATE,TRIGGER')
  AND has_table_privilege(:'role_name', 'gfs_blob_manifests', 'SELECT')
  AND has_table_privilege(:'role_name', 'gfs_blob_manifests', 'INSERT')
  AND has_table_privilege(:'role_name', 'gfs_blob_manifests', 'UPDATE')
  AND has_table_privilege(:'role_name', 'gfs_blob_manifests', 'DELETE')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_blob_manifests', 'REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_blob_manifests', 'TRUNCATE,TRIGGER')
  AND has_table_privilege(:'role_name', 'gfs_grants', 'SELECT')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_grants', 'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_grants', 'DELETE,TRUNCATE,TRIGGER')
  AND has_table_privilege(:'role_name', 'gfs_shares', 'SELECT')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_shares', 'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_shares', 'DELETE,TRUNCATE,TRIGGER')
  AND has_table_privilege(:'role_name', 'gfs_audit', 'INSERT')
  AND has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'USAGE')
  AND has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'SELECT')
  AND NOT has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'UPDATE')
  AND NOT has_any_column_privilege(:'role_name', 'gfs_audit', 'SELECT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_audit', 'DELETE,TRUNCATE,TRIGGER')
)) AS writer_privilege_ok \gset
\if :writer_privilege_ok
\else
SELECT 1/0;
\endif
SELECT (
  NOT has_table_privilege(:'role_name', 'control_admin_users', 'SELECT')
  AND has_column_privilege(:'role_name', 'control_admin_users', 'id', 'SELECT')
  AND has_column_privilege(:'role_name', 'control_admin_users', 'status', 'SELECT')
  AND has_column_privilege(:'role_name', 'control_admin_users', 'session_version', 'SELECT')
  AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'control_admin_users'
       AND column_name NOT IN ('id', 'status', 'session_version')
       AND has_column_privilege(:'role_name', 'control_admin_users', column_name, 'SELECT')
  )
  AND NOT has_any_column_privilege(:'role_name', 'control_admin_users',
    'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'control_admin_users',
    'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_table_privilege(:'role_name', 'users', 'SELECT')
  AND has_column_privilege(:'role_name', 'users', 'id', 'SELECT')
  AND has_column_privilege(:'role_name', 'users', 'lifecycle_state', 'SELECT')
  AND has_column_privilege(:'role_name', 'users', 'lifecycle_version', 'SELECT')
  AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name NOT IN ('id', 'lifecycle_state', 'lifecycle_version')
       AND has_column_privilege(:'role_name', 'users', column_name, 'SELECT')
  )
  AND NOT has_any_column_privilege(:'role_name', 'users',
    'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'users',
    'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_table_privilege(:'role_name', 'gfs_desktop_operator_links', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'id', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'lineage_id', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'generation', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'user_id', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'control_admin_id', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'state', 'SELECT')
  AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', 'source', 'SELECT')
  AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'gfs_desktop_operator_links'
       AND column_name NOT IN ('id', 'lineage_id', 'generation', 'user_id', 'control_admin_id', 'state', 'source')
       AND has_column_privilege(:'role_name', 'gfs_desktop_operator_links', column_name, 'SELECT')
  )
  AND NOT has_any_column_privilege(:'role_name', 'gfs_desktop_operator_links',
    'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'gfs_desktop_operator_links',
    'DELETE,TRUNCATE,TRIGGER')
  AND NOT has_table_privilege(:'role_name', 'team_members', 'SELECT')
  AND has_column_privilege(:'role_name', 'team_members', 'team_id', 'SELECT')
  AND has_column_privilege(:'role_name', 'team_members', 'user_id', 'SELECT')
  AND has_column_privilege(:'role_name', 'team_members', 'status', 'SELECT')
  AND NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'team_members'
       AND column_name NOT IN ('team_id', 'user_id', 'status')
       AND has_column_privilege(:'role_name', 'team_members', column_name, 'SELECT')
  )
  AND NOT has_any_column_privilege(:'role_name', 'team_members',
    'INSERT,UPDATE,REFERENCES')
  AND NOT has_table_privilege(:'role_name', 'team_members',
    'DELETE,TRUNCATE,TRIGGER')
) AS subject_privilege_ok \gset
\if :subject_privilege_ok
\else
SELECT 1/0;
\endif
SQL
}

verify_role() {
  local role="$1" kind="$2" ref_name=WRITER_SECRET persisted
  [ "$kind" = reader ] && ref_name=READER_SECRET
  persisted="$(secret_dsn "${!ref_name}")"
  dsn_has_role "$persisted" "$role" || die "persisted ${kind} candidate rejected"
  require_authenticated_dsn "$persisted" "$role" "persisted ${kind}"
  verify_role_contract "$role" "$kind"
}

set_role_password() {
  local role="$1" value="$2"
  {
    printf '\\set role_name %s\n' "$role"
    printf '\\set role_secret %s\n' "$value"
    cat <<'SQL'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
  THEN format('ALTER ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_secret')
  ELSE 'SELECT 1/0'
END \gexec
SQL
  } | kc -n "$PG_NS" exec -i "$PG_DEPLOY" -- \
    psql -Xq -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$PG_DB" -f - 2>/dev/null
}

disable_role_login() {
  local role="$1"
  printf 'ALTER ROLE %s NOLOGIN;\n' "$role" \
    | kc -n "$PG_NS" exec -i "$PG_DEPLOY" -- psql -Xq -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$PG_DB" >/dev/null
}

role_can_login() {
  printf "SELECT rolcanlogin FROM pg_roles WHERE rolname = :'role_name';\n" \
    | kc -n "$PG_NS" exec -i "$PG_DEPLOY" -- psql -XAtq -v ON_ERROR_STOP=1 \
      -U "$PG_SUPERUSER" -d "$PG_DB" -v role_name="$1" -f -
}

ensure_pending_candidate() {
  local role="$1" secret="$2" candidate password state
  candidate="$(pending_dsn "$secret")"
  if [ -n "$candidate" ]; then
    state="$(gfs_secret_state "$secret")"
    [ "$state" = pending ] || die "${GFS_NS}/${secret} candidate is owned by state ${state}; refusing concurrent adoption"
    dsn_has_role "$candidate" "$role" || die "${GFS_NS}/${secret} contains an invalid pending candidate"
    log "Resuming persisted pending candidate for ${secret}"
    printf '%s' "$candidate"
    return 0
  fi
  password="$(openssl rand -hex 24)"
  candidate="postgresql://${role}:${password}@${PG_HOST}:${PG_PORT}/${PG_DB}"
  printf '%s' "$candidate" | stage_secret_candidate "$secret" \
    || die "failed to stage credential candidate; another operation or API update won the state transition"
  printf '%s' "$candidate"
}

promote_candidate() {
  printf '%s' "$2" | promote_secret_candidate "$1"
}

rollback_uncommitted_candidate() {
  local role="$1" secret="$2" active="$3" candidate="$4" previous auth_state
  [ "$(gfs_secret_state "$secret")" = applying ] || return 1
  [ "$(pending_dsn "$secret")" = "$candidate" ] || return 1
  if [ -n "$active" ]; then
    previous="$(printf '%s' "$active" | gfs_dsn_password)" || return 1
    set_role_password "$role" "$previous" || return 1
    auth_state="$(dsn_authentication_state "$active" "$role")"
    [ "$auth_state" = authenticated ] || return 1
  else
    disable_role_login "$role" || return 1
  fi
  printf '%s' "$candidate" | clear_secret_candidate "$secret"
}

reconcile_credential() {
  local role="$1" kind="$2" secret="$3" deployment="$4" rotate="$5"
  local active pending candidate value login_state state rotated recovery candidate_applied=false auth_state
  ensure_secret_state "$secret" || die "cannot initialize credential state for ${GFS_NS}/${secret}"
  active="$(secret_dsn "$secret")"
  pending="$(pending_dsn "$secret")"
  state="$(gfs_secret_state "$secret")"

  if [ "$state" = applying ]; then
    recovery="$(recover_abandoned_applying "$role" "$secret" "$active" "$pending")"
    if [ "$recovery" = applied ]; then
      candidate="$pending"
      candidate_applied=true
    elif [ "$recovery" = pending ]; then
      state=pending
    else
      die "unexpected abandoned credential recovery result"
    fi
  fi

  if [ -z "$pending" ] && [ -n "$active" ]; then
    dsn_has_role "$active" "$role" || die "${GFS_NS}/${secret} contains an invalid committed DSN"
    authenticate_or_restore_nologin "$role" "$kind" "$active" "$state" "${GFS_NS}/${secret}"
    if [ "$state" = rollout-pending ] || [ "$state" = rollout-running ]; then
      if credential_rollout_required "$deployment" "$secret" "$state"; then
        log "Resuming incomplete ${deployment} rollout without rotating again"
        complete_rollout "$secret" "$deployment"
        verify_role "$role" "$kind"
        return 0
      fi
      log "${deployment} does not consume ${secret} yet; preserving ${state} until post-overlay reconciliation"
      verify_role "$role" "$kind"
      return 0
    fi
    if credential_rollout_required "$deployment" "$secret" "$state"; then
      log "Recovering stale ${deployment} pods without rotating again"
      complete_rollout "$secret" "$deployment"
      verify_role "$role" "$kind"
      return 0
    fi
    if [ "$rotate" = false ]; then
      log "Preserving existing valid ${kind} credential"
      verify_role "$role" "$kind"
      return 0
    fi
  fi

  if [ -z "$pending" ] && [ -z "$active" ]; then
    login_state="$(role_can_login "$role")"
    [ "$login_state" = f ] || die "${role} is LOGIN while ${GFS_NS}/${secret} is empty; refusing an unrecoverable overwrite"
  fi

  if [ "$candidate_applied" = false ]; then
    candidate="$(ensure_pending_candidate "$role" "$secret")"
    printf '%s' "$candidate" | claim_secret_candidate "$secret" \
      || die "credential candidate was claimed by another operation; no database change was attempted"
  fi
  value="$(printf '%s' "$candidate" | gfs_dsn_password)" || die "pending candidate secret is invalid"
  if [ "$candidate_applied" = false ]; then
    if ! set_role_password "$role" "$value"; then
      die "database role update failed; applying candidate retained for explicit recovery"
    fi
  fi
  auth_state="$(dsn_authentication_state "$candidate" "$role")"
  if [ "$auth_state" != authenticated ] || ! verify_role_contract "$role" "$kind"; then
    if rollback_uncommitted_candidate "$role" "$secret" "$active" "$candidate"; then
      die "candidate verification failed; previous credential restored"
    fi
    die "candidate verification failed and compensation could not complete; pending candidate retained for recovery"
  fi
  if ! promote_candidate "$secret" "$candidate"; then
    die "candidate authenticated but promotion did not converge; confirm the prior process ended, then retry with GFS_RECOVER_ABANDONED_STATE=true"
  fi
  unset candidate value
  verify_role "$role" "$kind"
  if [ "$rotate" = true ] || deployment_uses_secret "$deployment" "$secret"; then
    complete_rollout "$secret" "$deployment"
  else
    log "${deployment} does not consume ${secret} yet; credential staged without rollout"
    rotated="$(gfs_secret_rotated_at "$secret")"
    mark_secret_rollout_ready "$secret" "$rotated" rollout-pending \
      || die "staged credential state was superseded; refusing a stale completion"
  fi
}

stage_writer() {
  local adopted_at
  load_secret_snapshot "$WRITER_SECRET" \
    || die "cannot read a consistent ${GFS_NS}/${WRITER_SECRET} snapshot"
  if [ -n "$GFS_SNAPSHOT_STATE" ]; then
    reconcile_credential gfs_controller writer "$WRITER_SECRET" gfsc-writer false
    return 0
  fi

  [ -n "$GFS_SNAPSHOT_ACTIVE" ] || die "${GFS_NS}/${WRITER_SECRET} has no writer credential to adopt"
  [ -z "$GFS_SNAPSHOT_PENDING" ] || die "${GFS_NS}/${WRITER_SECRET} has a legacy pending candidate without lifecycle ownership"
  dsn_has_role "$GFS_SNAPSHOT_ACTIVE" gfs_controller \
    || die "${GFS_NS}/${WRITER_SECRET} contains an invalid legacy writer DSN"
  authenticate_or_restore_nologin gfs_controller writer "$GFS_SNAPSHOT_ACTIVE" \
    "$GFS_SNAPSHOT_STATE" "${GFS_NS}/${WRITER_SECRET} legacy writer"
  verify_role_contract gfs_controller writer

  adopted_at="$GFS_SNAPSHOT_ROTATED_AT"
  [ -n "$adopted_at" ] || adopted_at="$(credential_adoption_timestamp gfsc-writer \
    'app=gfs-controller,clerum.io/gfsc-role=writer' "$GFS_SNAPSHOT_ACTIVE")"
  adopt_legacy_secret_state "$WRITER_SECRET" "$GFS_SNAPSHOT_RV" "$GFS_SNAPSHOT_ANNOTATIONS" \
    "$GFS_SNAPSHOT_ROTATED_AT" "$adopted_at" \
    || die "legacy writer Secret changed during adoption; retry after confirming the competing operation"

  [ "$(gfs_secret_state "$WRITER_SECRET")" = ready ] \
    || die "legacy writer adoption did not persist ready state"
  [ -z "$(pending_dsn "$WRITER_SECRET")" ] \
    || die "legacy writer adoption observed an unexpected pending candidate"
  [ "$(secret_dsn "$WRITER_SECRET")" = "$GFS_SNAPSHOT_ACTIVE" ] \
    || die "legacy writer adoption changed the committed DSN"
  verify_role gfs_controller writer
  log "Adopted legacy writer credential without rotation or rollout"
}

case "$MODE" in
  stage-writer)
    stage_writer
    ;;
  stage-reader)
    reconcile_credential gfs_controller_reader reader "$READER_SECRET" gfsc-reader false
    ;;
  rotate-reader)
    log "Explicitly rotating reader credential"
    reconcile_credential gfs_controller_reader reader "$READER_SECRET" gfsc-reader true
    ;;
  rotate-writer)
    log "Explicitly rotating writer credential"
    reconcile_credential gfs_controller writer "$WRITER_SECRET" gfsc-writer true
    ;;
esac

log "Mode ${MODE} completed"
