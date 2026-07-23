#!/usr/bin/env bash
# Wait until HCC has published the split GFSC deployments referencing their
# dedicated Secrets (writer -> gfs-controller-db, reader ->
# gfs-controller-reader-db). Running a credential reconcile before that point
# races the HCC cutover: the staged reader credential stays rollout-pending and
# the terminal verify-gfs check fails even though serving is healthy.
#
# Fresh bootstrap (HCC has not created the GFSC deployments yet) is not the
# racing case: it is logged and skipped so the callers' documented ordering —
# reconcile now, finalize after HCC creates the stack — stays intact.
set -euo pipefail

[ -n "${CONTEXT:-}" ] || { echo "[wait-gfsc-secret-references] CONTEXT is required" >&2; exit 1; }

kctl() {
  kubectl --context "$CONTEXT" "$@"
}

die() {
  echo "[wait-gfsc-secret-references] ERROR: $*" >&2
  exit 1
}

deployment_references_secret() {
  local deployment="$1" secret="$2" refs
  if ! refs="$(kctl -n gfs get deployment "$deployment" -o \
    'jsonpath={range .spec.template.spec.containers[*].env[*]}{.valueFrom.secretKeyRef.name}{"\n"}{end}' 2>&1)"; then
    grep -qiE 'not ?found' <<<"$refs" && return 1
    die "cannot inspect gfs/${deployment} Secret references: $refs"
  fi
  grep -Fxq "$secret" <<<"$refs"
}

if ! writer_probe="$(kctl -n gfs get deployment gfsc-writer -o name 2>&1)"; then
  if grep -qiE 'not ?found' <<<"$writer_probe"; then
    echo "[wait-gfsc-secret-references] GFSC deployments not created yet (fresh bootstrap) — skipping secret-reference wait"
    exit 0
  fi
  die "cannot inspect gfs/gfsc-writer: $writer_probe"
fi

deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
  if deployment_references_secret gfsc-writer gfs-controller-db && \
     deployment_references_secret gfsc-reader gfs-controller-reader-db; then
    exit 0
  fi
  echo "[wait-gfsc-secret-references] waiting for HCC to publish writer/reader deployments with their dedicated Secrets"
  sleep 5
done
kctl -n gfs get globalfilesystem gfs -o yaml || true
kctl -n gfs get deployments,pods -o wide || true
die "GFSC deployments did not adopt their dedicated Secrets before timeout"
