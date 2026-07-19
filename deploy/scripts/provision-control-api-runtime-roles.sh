#!/usr/bin/env bash
# Reconcile least-privilege Postgres logins used by control-api tracing paths.
#
# Migration 0053 owns role creation and grants. This script owns only the
# runtime credential lifecycle: it preserves an existing valid credential or
# generates one on first provisioning, applies it to the fixed database role,
# and patches the matching Kubernetes Secret. No credential is accepted from
# the environment, written to disk, or printed.
set -euo pipefail
set +x

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ALLOWED_CONTEXTS="${ALLOWED_CONTEXTS:?set ALLOWED_CONTEXTS to an exact comma-separated context allowlist}"
PG_NAMESPACE="${PG_NAMESPACE:-control-plane}"
PG_DEPLOYMENT="${PG_DEPLOYMENT:-deployment/control-postgres}"
PG_DATABASE="${PG_DATABASE:-profiles}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
PG_HOST="${PG_HOST:-control-postgres.control-plane.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
PROVISION_WORKFLOW_RECIPES_RUNTIME="${PROVISION_WORKFLOW_RECIPES_RUNTIME:-true}"

log() {
  printf '[provision-control-api-runtime-roles] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

kctl() {
  kubectl --context="$CONTEXT" "$@"
}

context_is_allowed() {
  local candidate
  local entries=()
  IFS=',' read -r -a entries <<<"$ALLOWED_CONTEXTS"
  for candidate in "${entries[@]}"; do
    if [ "$candidate" = "$CONTEXT" ]; then
      return 0
    fi
  done
  return 1
}

read_existing_dsn() {
  local secret_name="$1"
  if ! kctl -n "$PG_NAMESPACE" get secret "$secret_name" >/dev/null 2>&1; then
    return 0
  fi
  kctl -n "$PG_NAMESPACE" get secret "$secret_name" \
    -o 'go-template={{with .data}}{{with index . "connection-string"}}{{. | base64decode}}{{end}}{{end}}'
}

password_from_valid_dsn() {
  local expected_role="$1"
  local dsn="$2"
  EXPECTED_ROLE="$expected_role" EXPECTED_HOST="$PG_HOST" EXPECTED_PORT="$PG_PORT" \
    EXPECTED_DATABASE="$PG_DATABASE" DSN="$dsn" python3 - <<'PY'
import os
import re
import sys
from urllib.parse import unquote, urlparse

parsed = urlparse(os.environ["DSN"])
expected = {
    "role": os.environ["EXPECTED_ROLE"],
    "host": os.environ["EXPECTED_HOST"],
    "port": int(os.environ["EXPECTED_PORT"]),
    "database": os.environ["EXPECTED_DATABASE"],
}
password = unquote(parsed.password or "")
valid = (
    parsed.scheme in {"postgres", "postgresql"}
    and unquote(parsed.username or "") == expected["role"]
    and parsed.hostname == expected["host"]
    and parsed.port == expected["port"]
    and parsed.path == f"/{expected['database']}"
    and re.fullmatch(r"[0-9a-f]{64}", password) is not None
)
if not valid:
    sys.exit(1)
sys.stdout.write(password)
PY
}

resolve_password() {
  local role_name="$1"
  local secret_name="$2"
  local existing_dsn password
  existing_dsn="$(read_existing_dsn "$secret_name")"
  if [ -n "$existing_dsn" ]; then
    if ! password="$(password_from_valid_dsn "$role_name" "$existing_dsn")"; then
      die "$PG_NAMESPACE/$secret_name contains an invalid runtime DSN; refusing to rotate implicitly"
    fi
    printf '%s' "$password"
    return 0
  fi
  openssl rand -hex 32
}

ensure_secret_exists() {
  local secret_name="$1"
  if kctl -n "$PG_NAMESPACE" get secret "$secret_name" >/dev/null 2>&1; then
    return 0
  fi
  kctl -n "$PG_NAMESPACE" create secret generic "$secret_name" \
    --dry-run=client -o yaml | kctl apply -f - >/dev/null
}

patch_connection_string() {
  local secret_name="$1"
  local dsn="$2"
  printf '%s' "$dsn" | python3 -c \
    'import json, sys; print(json.dumps({"stringData": {"connection-string": sys.stdin.read()}}))' \
    | kctl -n "$PG_NAMESPACE" patch secret "$secret_name" --type=merge \
        --patch-file=/dev/stdin >/dev/null
}

apply_role_password() {
  local role_name="$1"
  local role_password="$2"
  local sql
  case "$role_name" in
    control_api_runtime|trace_maintenance_runtime|workflow_recipes_runtime) ;;
    *) die "unsupported runtime role: $role_name" ;;
  esac
  sql="$(cat <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role_name}') THEN
    RAISE EXCEPTION '${role_name} role missing; run control-api migrations first';
  END IF;
END \$\$;
\\set runtime_role_password '${role_password}'
SELECT format(
  'ALTER ROLE ${role_name} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_role_password'
) \\gexec
SQL
)"
  printf '%s\n' "$sql" | kctl -n "$PG_NAMESPACE" exec -i "$PG_DEPLOYMENT" -- \
    psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "$PG_DATABASE" -f - >/dev/null
  sql=''
}

reconcile_role() {
  local role_name="$1"
  local secret_name="$2"
  local password dsn
  password="$(resolve_password "$role_name" "$secret_name")"
  apply_role_password "$role_name" "$password"
  ensure_secret_exists "$secret_name"
  dsn="postgresql://${role_name}:${password}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}"
  patch_connection_string "$secret_name" "$dsn"
  password=''
  dsn=''
  log "Reconciled $role_name and $PG_NAMESPACE/$secret_name"
}

context_is_allowed || die "CONTEXT=$CONTEXT is not in ALLOWED_CONTEXTS"
command -v kubectl >/dev/null 2>&1 || die "kubectl is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

log "Waiting for $PG_NAMESPACE/$PG_DEPLOYMENT in context $CONTEXT"
kctl -n "$PG_NAMESPACE" rollout status "$PG_DEPLOYMENT" --timeout=180s >/dev/null

reconcile_role control_api_runtime control-api-postgres-runtime
reconcile_role trace_maintenance_runtime trace-maintenance-postgres-runtime
if [ "$PROVISION_WORKFLOW_RECIPES_RUNTIME" = "true" ]; then
  reconcile_role workflow_recipes_runtime workflow-recipes-postgres-runtime
fi

log "Runtime database roles are ready"
