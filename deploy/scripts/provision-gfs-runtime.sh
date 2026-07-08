#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy/scripts/provision-gfs-runtime.sh --context <kube-context> --overlay <overlay-dir> [--allow-prod] [--skip-auth-sync]

Runs the post-overlay GFS runtime provisioning steps and applies overlay CRD
instances. Production contexts require --allow-prod; the Makefile prod target
must perform the human confirmation before passing that flag.
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

case "$CONTEXT" in
  *clerum-dev*|minikube|clerum-test|clerum-codex-*|clerum-detached-*|clerum-feat-*|clerum-pr-*)
    ;;
  *)
    [ "$ALLOW_PROD" = "1" ] || die "refusing non-dev context without --allow-prod: $CONTEXT"
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
