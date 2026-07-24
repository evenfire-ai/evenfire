#!/usr/bin/env bash
# Verify the two intentional HCC/GFSC rollback states without exposing DSNs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib/gfs-dsn-probe.sh
source "$ROOT/deploy/scripts/lib/gfs-dsn-probe.sh"

usage() {
  cat <<'EOF'
Usage:
  verify-gfs-hcc-phase.sh --context <kube-context> --phase writer-compat|candidate

writer-compat verifies the temporary rollback state: both GFSC deployments use
the retained writer identity. It is not reader/writer isolation.

candidate verifies the restored split: writer and reader use their dedicated
credential references and authenticate as distinct database roles.
EOF
}

fail() { printf '[verify-gfs-hcc-phase] FAIL: %s\n' "$*" >&2; exit 1; }
log() { printf '[verify-gfs-hcc-phase] %s\n' "$*"; }

CONTEXT=""
PHASE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --context) CONTEXT="${2:-}"; shift 2 ;;
    --context=*) CONTEXT="${1#--context=}"; shift ;;
    --phase) PHASE="${2:-}"; shift 2 ;;
    --phase=*) PHASE="${1#--phase=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$CONTEXT" ] || { usage >&2; exit 2; }
case "$PHASE" in writer-compat|candidate) ;; *) usage >&2; exit 2 ;; esac

GFS_NS="${GFS_NS:-gfs}"
PG_NS="${PG_NS:-control-plane}"
PG_PROBE_DEPLOY="${PG_PROBE_DEPLOY:-deploy/control-api}"
PG_DB="${PG_DB:-profiles}"
PG_HOST="${PG_HOST:-control-postgres.control-plane.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
VERIFY_ROLLOUT_TIMEOUT="${VERIFY_ROLLOUT_TIMEOUT:-240s}"

kc() { kubectl --context="$CONTEXT" "$@"; }

read_field() {
  local out
  out="$(kc "$@" 2>&1)" || fail "kubectl $* failed: $out"
  printf '%s' "$out"
}

deployment_env_value() {
  local deployment="$1" env_name="$2" value
  value="$(read_field -n "$GFS_NS" get deployment "$deployment" -o \
    "go-template={{range .spec.template.spec.containers}}{{range .env}}{{if eq .name \"$env_name\"}}{{if .value}}{{.value}}{{else}}{{.valueFrom.secretKeyRef.name}}{{end}}{{\"\\n\"}}{{end}}{{end}}{{end}}")"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  [ -n "$value" ] || fail "deployment/$deployment has no explicit $env_name"
  printf '%s' "$value"
}

verify_deployment_contract() {
  local deployment="$1" expected_ref="$2" expected_role="$3" actual
  actual="$(deployment_env_value "$deployment" PG_CONNECTION_STRING)"
  [ "$actual" = "$expected_ref" ] \
    || fail "deployment/$deployment credential reference is $actual, expected $expected_ref for $PHASE"
  actual="$(deployment_env_value "$deployment" GFS_STORAGE_ROLE)"
  [ "$actual" = "$expected_role" ] \
    || fail "deployment/$deployment storage role is $actual, expected $expected_role"
  kc -n "$GFS_NS" rollout status "deployment/$deployment" --timeout="$VERIFY_ROLLOUT_TIMEOUT" >/dev/null \
    || fail "deployment/$deployment did not roll out"
}

verify_credential_role() {
  local object="$1" expected_role="$2" encoded dsn rc
  encoded="$(read_field -n "$GFS_NS" get secret "$object" -o 'jsonpath={.data.connection-string}')"
  [ -n "$encoded" ] || fail "$GFS_NS/$object has no database URI"
  dsn="$(printf '%s' "$encoded" | base64 -d)" || fail "$GFS_NS/$object database URI is not valid base64"
  set +e
  gfs_dsn_authenticates_as "$dsn" "$expected_role"
  rc=$?
  set -e
  unset dsn
  case "$rc" in
    0) log "$object authenticates as $expected_role" ;;
    1) fail "$object was rejected or did not authenticate as $expected_role" ;;
    *) fail "$object role probe was unavailable; phase cannot be verified" ;;
  esac
}

verify_deployment_contract gfsc-writer gfs-controller-db writer
verify_credential_role gfs-controller-db gfs_controller

if [ "$PHASE" = writer-compat ]; then
  verify_deployment_contract gfsc-reader gfs-controller-db reader
  log 'writer-compat verified: both deployments use the retained writer identity'
  log 'reader/writer database isolation is intentionally NOT active in this temporary phase'
else
  verify_deployment_contract gfsc-reader gfs-controller-reader-db reader
  verify_credential_role gfs-controller-reader-db gfs_controller_reader
  log 'candidate verified: reader/writer references and authenticated database users are distinct'
fi
