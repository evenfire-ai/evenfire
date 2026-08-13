#!/usr/bin/env bash
# Verify reader/writer GFSC credentials independently without printing DSNs.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../deploy/scripts/lib/gfs-dsn-probe.sh
source "${PROJECT_DIR}/deploy/scripts/lib/gfs-dsn-probe.sh"

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
GFS_NS="${GFS_NS:-gfs}"
PG_NS="${PG_NS:-control-plane}"
PG_PROBE_DEPLOY="${PG_PROBE_DEPLOY:-deploy/control-api}"
PG_DB="${PG_DB:-profiles}"
PG_HOST="${PG_HOST:-control-postgres.control-plane.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
# On a cold cluster a freshly-restarted gfsc-reader needs ~145s to reach Ready;
# the old 60s default killed it prematurely. Still bounded and fail-loud, still
# overridable via the env var.
VERIFY_ROLLOUT_TIMEOUT="${VERIFY_ROLLOUT_TIMEOUT:-240s}"

kc() { kubectl --context="$CONTEXT" "$@"; }
log() { printf '[verify-gfs] %s\n' "$*"; }
fail() { printf '[verify-gfs] FAIL: %s\n' "$*" >&2; exit 1; }
kc_read() { local out; out="$(kc "$@" 2>&1)" || fail "kubectl $* failed: $out"; printf '%s' "$out"; }

if crd_out="$(kc get crd globalfilesystems.clerum.io -o name 2>&1)"; then
  log "${crd_out} is installed"
elif grep -qiE 'not ?found' <<<"$crd_out"; then
  log "GlobalFileSystem CRD is not installed; GFS is not adopted"
  exit 0
else
  fail "cannot determine whether the GlobalFileSystem CRD is installed: ${crd_out}"
fi

if instance_out="$(kc -n "$GFS_NS" get globalfilesystem gfs -o name 2>&1)"; then
  log "${instance_out} is present; verifying its database identities"
elif grep -qiE 'not ?found' <<<"$instance_out"; then
  log "GlobalFileSystem/gfs is not adopted; no GFS instance to verify"
  exit 0
else
  fail "cannot determine whether GlobalFileSystem/gfs is adopted: ${instance_out}"
fi
kc_read -n "$GFS_NS" get configmap gfs-config -o name >/dev/null

verify_role() {
  local role="$1" secret="$2" deployment="$3" selector="$4"
  local encoded dsn lifecycle pending rotated_at rows live

  lifecycle="$(kc_read -n "$GFS_NS" get secret "$secret" -o \
    'jsonpath={.metadata.annotations.clerum\.io/gfs-dsn-state}')"
  [ "$lifecycle" = ready ] || fail "${secret} credential lifecycle is ${lifecycle:-unset}, not ready"
  pending="$(kc_read -n "$GFS_NS" get secret "$secret" \
    -o 'go-template={{if index .data "pending-connection-string"}}yes{{else}}no{{end}}')"
  [ "$pending" = no ] || fail "${secret} retains an unfinished credential candidate"

  encoded="$(kc_read -n "$GFS_NS" get secret "$secret" -o 'jsonpath={.data.connection-string}')"
  [ -n "$encoded" ] || fail "${GFS_NS}/${secret}.connection-string is empty"
  dsn="$(printf '%s' "$encoded" | base64 -d)" || fail "${GFS_NS}/${secret} has invalid encoding"
  gfs_dsn_authenticates_as "$dsn" "$role" \
    || fail "${secret} cannot authenticate through the expected PostgreSQL Service and role"
  unset dsn
  log "${secret} authenticates as ${role}"

  kc -n "$GFS_NS" rollout status "deployment/${deployment}" --timeout="$VERIFY_ROLLOUT_TIMEOUT" >/dev/null 2>&1 \
    || fail "deployment/${deployment} is not rolled out"
  rotated_at="$(kc_read -n "$GFS_NS" get secret "$secret" -o jsonpath='{.metadata.annotations.clerum\.io/gfs-dsn-rotated-at}')"
  [ -n "$rotated_at" ] || fail "${secret} has no credential rotation timestamp"
  rows="$(kc_read -n "$GFS_NS" get pods -l "$selector" -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.creationTimestamp}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}')"
  live="$(printf '%s\n' "$rows" | awk -F'|' 'NF >= 3 && $4 == "" {print}')"
  [ -n "$live" ] || fail "no live pods for ${deployment}"
  while IFS='|' read -r pod created ready _deleting; do
    [ "$created" ">" "$rotated_at" ] || [ "$created" = "$rotated_at" ] \
      || fail "${pod} predates ${secret}; run the directed ${deployment} rotation"
    [ "$ready" = True ] || fail "${pod} is not Ready"
  done <<<"$live"
  log "${deployment} is fresh for ${secret} and Ready"
}

verify_role gfs_controller gfs-controller-db gfsc-writer 'app=gfs-controller,clerum.io/gfsc-role=writer'
verify_role gfs_controller_reader gfs-controller-reader-db gfsc-reader 'app=gfs-controller,clerum.io/gfsc-role=reader'
log 'OK — distinct reader/writer database identities and deployments verified'
