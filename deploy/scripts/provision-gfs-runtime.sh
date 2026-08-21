#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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
  local c
  [ -n "${ALLOWED_CONTEXTS:-}" ] || return 1
  local -a allowed=()
  IFS=',' read -r -a allowed <<<"${ALLOWED_CONTEXTS}"
  for c in "${allowed[@]}"; do
    [ -n "$c" ] && [ "$CONTEXT" = "$c" ] && return 0
  done
  return 1
}

case "$CONTEXT" in
  minikube|clerum-test|clerum-codex-*|clerum-detached-*|clerum-feat-*|clerum-pr-*)
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

deployment_references_secret() {
  local deployment="$1" secret="$2" refs
  if ! refs="$(kctl -n gfs get deployment "$deployment" -o \
    'jsonpath={range .spec.template.spec.containers[*].env[*]}{.valueFrom.secretKeyRef.name}{"\n"}{end}' 2>&1)"; then
    grep -qiE 'not ?found' <<<"$refs" && return 1
    die "cannot inspect gfs/${deployment} Secret references: $refs"
  fi
  grep -Fxq "$secret" <<<"$refs"
}

wait_for_gfsc_secret_references() {
  local deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if deployment_references_secret gfsc-writer gfs-controller-db && \
       deployment_references_secret gfsc-reader gfs-controller-reader-db; then
      return 0
    fi
    log "Waiting for HCC to publish writer/reader deployments with their dedicated Secrets"
    sleep 5
  done
  kctl -n gfs get globalfilesystem gfs -o yaml || true
  kctl -n gfs get deployments,pods -o wide || true
  die "GFSC deployments did not adopt their dedicated Secrets before timeout"
}

wait_for_globalfilesystem_ready() {
  local deadline=$((SECONDS + 240)) phase=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    phase="$(kctl -n gfs get globalfilesystem gfs -o 'jsonpath={.status.phase}' 2>/dev/null || true)"
    if [ "$phase" = "Ready" ]; then
      log "GlobalFileSystem/gfs is Ready"
      return 0
    fi
    log "GlobalFileSystem/gfs phase=${phase:-<empty>}; waiting"
    sleep 5
  done
  kctl -n gfs get globalfilesystem gfs -o yaml || true
  kctl -n gfs get deploy,pods,pvc,svc,networkpolicy -o wide || true
  die "GlobalFileSystem/gfs did not become Ready before timeout"
}

finalize_credentials_after_overlay() {
  local out
  if out="$(kctl -n gfs get globalfilesystem gfs -o name 2>&1)"; then
    :
  elif grep -qiE 'not ?found' <<<"$out"; then
    log "GlobalFileSystem/gfs is not installed; leaving credentials staged for the future runtime"
    return 0
  else
    die "cannot determine GlobalFileSystem/gfs presence: $out"
  fi

  log "Waiting for the post-overlay HCC rollout"
  # HCC serves 503 on /ready until its initial fleet reconciliation completes, so
  # time-to-Ready scales with the McpServer/Context fleet. clerum-dev (108 McpServers,
  # 22 Contexts) took 651s on 2026-08-05; clerum-prod (7/6) is far quicker.
  #
  # This number is only half the budget. `kubectl rollout status` aborts as soon as the
  # Deployment controller sets Progressing=False/ProgressDeadlineExceeded, so it can never
  # outlast progressDeadlineSeconds on the Deployment — and that clock starts earlier, when
  # apply-inter-service-tokens.sh `rollout restart`s HCC several steps before this one.
  # Keep this UNDER (progressDeadlineSeconds - that head start) or it silently does nothing:
  # at 480s against the unset-hence-600s default it never once bound. The manifest now sets
  # progressDeadlineSeconds: 1200; scripts/tests/test-provision-gfs-runtime.sh pins the
  # relationship so the two cannot drift apart again.
  kctl -n control-plane rollout status deployment/host-context-controller --timeout=900s
  wait_for_gfsc_secret_references

  log "Finalizing staged GFS credentials after the overlay"
  # This entrypoint has already validated the target context (including the
  # explicit --allow-prod path). Carry that decision into the credential
  # mutator as an exact, single-context remote authorization instead of
  # relying on a gke_* name prefix.
  GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS="$CONTEXT" \
    CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/reconcile-gfs-deploy-credentials.sh"

  log "Waiting for the exact GFSC writer and reader rollouts"
  kctl -n gfs rollout status deployment/gfsc-writer --timeout=240s
  kctl -n gfs rollout status deployment/gfsc-reader --timeout=240s
  wait_for_globalfilesystem_ready
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
  # This entrypoint is the explicit non-local boundary. Carry the same exact
  # context authorization into the auth-key mutator; it must not infer remote
  # ownership from a failed local Minikube probe.
  GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS="$CONTEXT" \
    bash "$ROOT/scripts/minikube/sync-auth-key.sh" --context "$CONTEXT" --require-gfs
fi

if [ "$SKIP_INSTANCES" = "1" ]; then
  # Prod promotion does not manage CR instances here. Credential staging was
  # already completed before overlay apply and never triggers a rollout.
  log "Skipping CRD instances apply and GlobalFileSystem readiness wait (--skip-instances)"
elif [ -d "$INSTANCES_DIR" ]; then
  log "Applying CRD instances from $INSTANCES_DIR"
  kctl apply -f "$INSTANCES_DIR"
else
  log "No instances directory found at $INSTANCES_DIR"
fi

finalize_credentials_after_overlay
