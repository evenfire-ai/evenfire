#!/usr/bin/env bash
# One deploy-time entrypoint for writer ownership, bootstrap, and reader staging.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GFS_NS="${GFS_NS:-gfs}"

CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/apply-gfs-writer-secret.sh"
writer_dsn_b64="$(kubectl --context="$CONTEXT" -n "$GFS_NS" get secret gfs-controller-db \
  -o 'jsonpath={.data.connection-string}')" \
  || { printf '[reconcile-gfs-deploy] ERROR: cannot inspect writer Secret\n' >&2; exit 1; }
if [ -z "$writer_dsn_b64" ]; then
  CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/provision-gfs-db.sh" rotate-writer
fi
CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/provision-gfs-db.sh" stage-writer

kubectl --context="$CONTEXT" apply -f "$ROOT/deploy/base/gfs/gfs-controller-reader-db.yaml" >/dev/null
CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/provision-gfs-db.sh" stage-reader
printf '[reconcile-gfs-deploy] writer and reader credentials reconciled\n' >&2
