#!/usr/bin/env bash
# Preserve a provisioning-owned writer DSN while migrating legacy apply ownership.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${ROOT}/deploy/base/gfs/gfs-controller-db.yaml"
NAMESPACE=gfs
SECRET=gfs-controller-db

kc() { kubectl --context="$CONTEXT" "$@"; }
fail() { printf '[apply-gfs-writer-secret] ERROR: %s\n' "$*" >&2; exit 1; }

if existing="$(kc -n "$NAMESPACE" get secret "$SECRET" -o name 2>&1)"; then
  # The historical manifest declared data.connection-string. Replace only its
  # last-applied ownership record before apply so the live provisioned key is
  # preserved; this command does not mutate Secret data.
  kc apply set-last-applied --create-annotation=true -f "$MANIFEST" >/dev/null \
    || fail "cannot migrate legacy apply ownership for ${NAMESPACE}/${SECRET}"
elif grep -qF "namespaces \"${NAMESPACE}\" not found" <<<"$existing"; then
  fail "namespace ${NAMESPACE} is not declared; apply deploy/base/namespaces.yaml before GFS Secrets"
elif grep -qF "secrets \"${SECRET}\" not found" <<<"$existing"; then
  : # Fresh bootstrap: the normal apply below creates the empty fail-closed Secret.
else
  fail "cannot determine whether ${NAMESPACE}/${SECRET} exists"
fi

kc apply -f "$MANIFEST" >/dev/null \
  || fail "cannot apply ${NAMESPACE}/${SECRET}"
printf '[apply-gfs-writer-secret] %s/%s declared without changing its provisioned DSN\n' "$NAMESPACE" "$SECRET" >&2
