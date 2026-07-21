#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy/scripts/provision-gfs-runtime.sh --context <kube-context> --overlay <overlay-dir> [--allow-prod] [--skip-auth-sync] [--skip-instances]

Runs the post-overlay GFS runtime provisioning steps and applies overlay CRD
instances. Production contexts require --allow-prod; the Makefile prod target
must perform the human confirmation before passing that flag.

Environment:
  ALLOWED_CONTEXTS   Comma-separated exact kube-contexts to treat as allowed dev
                     contexts (in addition to the built-in generic patterns).
                     A self-hosted deploy pipeline whose GKE dev context is not
                     named by the built-ins sets this to that exact context.
EOF
}

log() { printf '[provision-gfs-runtime] %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

CONTEXT=""
OVERLAY=""
ALLOW_PROD="0"
SKIP_SYNC="0"
SKIP_INSTANCES="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --context)
      CONTEXT="${2:-}"
      shift 2
      ;;
    --context=*)
      CONTEXT="${1#--context=}"
      shift
      ;;
    --overlay)
      OVERLAY="${2:-}"
      shift 2
      ;;
    --overlay=*)
      OVERLAY="${1#--overlay=}"
      shift
      ;;
    --allow-prod)
      ALLOW_PROD="1"
      shift
      ;;
    --skip-auth-sync)
      SKIP_SYNC="1"
      shift
      ;;
    --skip-instances)
      # GFS DB provisioning only — do NOT apply the overlay's CRD instances
      # (Host/Context/CommunicationChannel/GlobalFileSystem). Used by the prod
      # promotion pipeline, where instance management stays a gated runbook op.
      SKIP_INSTANCES="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$CONTEXT" ] || {
  usage >&2
  exit 1
}
[ -n "$OVERLAY" ] || {
  usage >&2
  exit 1
}
[ -d "$OVERLAY" ] || die "overlay directory not found: $OVERLAY"

# Contexts listed in ALLOWED_CONTEXTS (comma-separated) are treated as allowed
# dev contexts. A self-hosted deploy pipeline whose GKE dev context is not named
# by the generic built-in patterns below sets this to that exact context — the
# same override idiom the sibling scripts use (run-control-api-db-migration.sh,
# scripts/e2e/seed-e2e-data.sh). A prod-looking context is hard-denied regardless.
context_allowed_via_env() {
  local c allowed
  IFS=',' read -r -a allowed <<<"${ALLOWED_CONTEXTS:-}"
  for c in "${allowed[@]}"; do
    [ -n "$c" ] && [ "$CONTEXT" = "$c" ] && return 0
  done
  return 1
}

case "$CONTEXT" in
  *example-dev*|minikube|clerum-test|clerum-codex-*|clerum-detached-*|clerum-feat-*|clerum-pr-*)
    ;;
  *)
    # A non-dev context passes only if explicitly named in ALLOWED_CONTEXTS or
    # via --allow-prod. Both are conscious opt-ins; the explicit allowlist IS the
    # guard. (This script legitimately serves prod via --allow-prod, so there is
    # deliberately no blanket prod-pattern hard-deny here — cf. seed-e2e-data.sh,
    # which is dev-only and does hard-deny prod.)
    if ! context_allowed_via_env && [ "$ALLOW_PROD" != "1" ]; then
      die "refusing non-dev context without an ALLOWED_CONTEXTS entry or --allow-prod: $CONTEXT"
    fi
    ;;
esac

kctl() {
  kubectl --context "$CONTEXT" "$@"
}

INSTANCES_DIR="$OVERLAY/instances"

log "Checking required GFS platform resources"
kctl get crd globalfilesystems.clerum.io >/dev/null
kctl -n gfs get role host-context-controller-gfs-runtime >/dev/null
kctl -n gfs get rolebinding host-context-controller-gfs-runtime >/dev/null
kctl -n gfs get networkpolicy deny-all-gfs >/dev/null

if [ "$SKIP_SYNC" = "1" ]; then
  log "Skipping runtime auth configuration sync"
else
  log "Syncing runtime auth configuration"
  bash scripts/minikube/sync-auth-key.sh --context "$CONTEXT"
fi

log "Provisioning gfsc database access"
CONTEXT="$CONTEXT" bash deploy/scripts/provision-gfs-db.sh

if [ "$SKIP_INSTANCES" = "1" ]; then
  # DB-credential heal ONLY: skip the instances apply AND the
  # GlobalFileSystem-Ready wait below. provision-gfs-db.sh already rolled the
  # gfsc deployments and waited for their rollout, which is exactly the
  # surface this mode changes — entering the CR readiness gate here would
  # couple every prod promotion to overall GFS health once the CR exists.
  log "Skipping CRD instances apply and GlobalFileSystem readiness wait (--skip-instances)"
  exit 0
fi
if [ -d "$INSTANCES_DIR" ]; then
  log "Applying CRD instances from $INSTANCES_DIR"
  kctl apply -f "$INSTANCES_DIR"
else
  log "No instances directory found at $INSTANCES_DIR"
  exit 0
fi

if ! kctl -n gfs get globalfilesystem gfs >/dev/null 2>&1; then
  log "GlobalFileSystem/gfs not present after instance apply; nothing to wait for"
  exit 0
fi

log "Waiting for GlobalFileSystem/gfs status.phase=Ready"
deadline=$((SECONDS + 240))
while [ "$SECONDS" -lt "$deadline" ]; do
  phase="$(kctl -n gfs get globalfilesystem gfs -o 'jsonpath={.status.phase}' 2>/dev/null || true)"
  if [ "$phase" = "Ready" ]; then
    log "GlobalFileSystem/gfs is Ready"
    log "Waiting for gfsc writer and reader rollouts"
    kctl -n gfs rollout status deployment/gfsc-writer --timeout=240s
    kctl -n gfs rollout status deployment/gfsc-reader --timeout=240s
    exit 0
  fi
  log "GlobalFileSystem/gfs phase=${phase:-<empty>}; waiting"
  sleep 5
done

kctl -n gfs get globalfilesystem gfs -o yaml || true
kctl -n gfs get deploy,pods,pvc,svc,networkpolicy -o wide || true
die "GlobalFileSystem/gfs did not become Ready before timeout"
