#!/usr/bin/env bash
# One deploy-time entrypoint for writer ownership, bootstrap, and reader staging.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GFS_NS="${GFS_NS:-gfs}"
set +u
T2_PROJECT_DIR="$T2_PROJECT_DIR"
T2_PROFILE="$T2_PROFILE"
T2_CONTEXT="$T2_CONTEXT"
MINIKUBE_PROFILE="$MINIKUBE_PROFILE"
CONTROL_API_REAL_PG_CONTEXT="$CONTROL_API_REAL_PG_CONTEXT"
T2_LOCK_TOKEN="$T2_LOCK_TOKEN"
set -u
if [ -z "$T2_PROJECT_DIR" ]; then T2_PROJECT_DIR="$ROOT"; fi
if [ -z "$T2_PROFILE" ]; then T2_PROFILE="$MINIKUBE_PROFILE"; fi
if [ -z "$T2_PROFILE" ]; then T2_PROFILE="$CONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$CONTROL_API_REAL_PG_CONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$CONTEXT"; fi

remote_context_allowed() {
  local allowed_context
  local -a allowed_contexts=()
  [ "${GFS_REMOTE_RECONCILE_AUTHORIZED:-false}" = true ] || return 1
  [ -n "${ALLOWED_CONTEXTS:-}" ] || return 1
  IFS=',' read -r -a allowed_contexts <<<"${ALLOWED_CONTEXTS}"
  for allowed_context in "${allowed_contexts[@]}"; do
    if [ "$allowed_context" = "$CONTEXT" ]; then
      return 0
    fi
  done
  return 1
}

if [ -n "$T2_LOCK_TOKEN" ] || [[ "$CONTEXT" == clerum-* ]]; then
  # shellcheck source=scripts/minikube/t2-common.sh
  source "$ROOT/scripts/minikube/t2-common.sh"
  if [ -z "$T2_SKIP_LOCK" ]; then T2_SKIP_LOCK=false; fi
  RECONCILE_CLEANUP_DONE=false
  cleanup_reconcile() {
    local status="${1:-$?}"
    if [ "$RECONCILE_CLEANUP_DONE" = true ]; then
      return "$status"
    fi
    RECONCILE_CLEANUP_DONE=true
    trap - EXIT
    trap '' INT TERM
    t2_lock_release "$status" || status=$?
    return "$status"
  }
  handle_reconcile_signal() {
    local signal="$1" status
    case "$signal" in
      INT) status=130 ;;
      TERM) status=143 ;;
      *) status=1 ;;
    esac
    cleanup_reconcile "$status" || status=$?
    exit "$status"
  }
  handle_reconcile_exit() {
    local status=$?
    cleanup_reconcile "$status" || status=$?
    exit "$status"
  }
  trap handle_reconcile_exit EXIT
  trap 'handle_reconcile_signal INT' INT
  trap 'handle_reconcile_signal TERM' TERM
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
  t2_mutation_lock
  # The verified profile context is authoritative. Do not let a caller keep
  # a second CONTEXT value after the fence has been acquired.
  CONTEXT="$T2_CONTEXT"
else
  # Remote reconciliation is authorized by the explicit workflow decision and
  # exact context membership, never by a provider/name convention. This also
  # supports self-hosted dev contexts whose names are not gke_*.
  if ! remote_context_allowed; then
    if [ -z "${GFS_REMOTE_RECONCILE_AUTHORIZED:-}" ] && [ -z "${ALLOWED_CONTEXTS:-}" ]; then
      printf '[reconcile-gfs-deploy] ERROR: refusing unverified Kubernetes context: %s\n' "$CONTEXT" >&2
      exit 1
    fi
    printf '[reconcile-gfs-deploy] ERROR: refusing remote context without explicit authorization and exact ALLOWED_CONTEXTS membership: %s\n' "$CONTEXT" >&2
    exit 1
  fi
fi

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
