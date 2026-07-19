#!/usr/bin/env bash
#
# dev.sh — day-to-day minikube lifecycle for the Clerum dev loop.
#
# Thin wrapper over the existing minikube-* Make targets that adds the two
# things the raw targets don't: a service→namespace map for a parametrized
# multi-service rebuild, and a health check on the real liveness routes.
#
# Subcommands:
#   up                  Start Docker+minikube (if down), relaunch background
#                       port-forwards, health check. Boots an ALREADY-provisioned
#                       cluster — this is NOT a full regen (use `make minikube-setup`).
#   down                Stop port-forwards, then `minikube stop`. Safe: preserves
#                       the cluster, its DB and PVCs (nothing is deleted).
#   redeploy [svc...]   Rebuild image(s) + rollout restart, then relaunch
#                       port-forwards + health check. Defaults to the trio we
#                       iterate on most: control-api control-ui mcp-host.
#                       Override with an explicit list, e.g.
#                         scripts/minikube/dev.sh redeploy control-api mcp-host
#
# Honors MINIKUBE_PROFILE (default clerum-test). Health probes use the default
# shared ports (3000/8090/8080/...); branch profiles with random port-forwards
# have their own preflight and are out of scope here.
set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
SAFE_PROFILE="${PROFILE//[^A-Za-z0-9_.-]/_}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

KC=(kubectl --context="$PROFILE")

DEFAULT_SVCS=(control-api control-ui mcp-host)

# svc → "<namespace> <deployment> <port> <health_path>"
# port/health_path empty ("- -") means: rollout-only, no HTTP probe.
# deployment column encodes the mcp-host→chatllm rename already baked into the
# Makefile (minikube_deployment). Keep this table in sync with the build-images.sh
# --only=<svc> selectors and the actual deployment names in-cluster.
svc_meta() {
  case "$1" in
    control-api)       echo "control-plane control-api 8090 /health" ;;
    control-ui)        echo "control-plane control-ui 3000 /" ;;
    mcp-host)          echo "mcp-host chatllm 8080 /v1/runtime/health" ;;
    profile-ui)        echo "profiles profile-ui 3001 /" ;;
    external-rest-api) echo "profiles external-rest-api 8091 /health" ;;
    rpc-proxy)         echo "rpc-proxy rpc-proxy 8094 /health" ;;
    hcc)               echo "control-plane host-context-controller - -" ;;
    *)                 return 1 ;;
  esac
}

KNOWN_SVCS="control-api control-ui mcp-host profile-ui external-rest-api rpc-proxy hcc"

log()  { printf '%s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }

# Relaunch background port-forwards (nohup, non-holding) via the existing target.
relaunch_pf() {
  step "port-forwards ($PROFILE)"
  make --no-print-directory minikube-pf-all-bg
}

# HTTP health probe for the given services (skips ones with no port).
health_check() {
  step "health"
  local svc ns dep port path code line=""
  for svc in "$@"; do
    svc_meta "$svc" >/dev/null || continue
    read -r ns dep port path <<<"$(svc_meta "$svc")"
    [[ "$port" == "-" ]] && continue
    # On a connection failure curl exits non-zero and -w still prints 000.
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${port}${path}" 2>/dev/null || true)"
    line+="${svc}:${port} ${code:-000} · "
  done
  log "${line% · }"
  step "pods"
  # List pods per (namespace, deployment) so we show exactly the services we
  # touched — the pod name is "<deployment>-<rs-hash>-<pod-hash>", and the
  # anchored pattern excludes sibling deployments like control-api-rpc-gateway.
  for svc in "$@"; do
    svc_meta "$svc" >/dev/null || continue
    read -r ns dep port path <<<"$(svc_meta "$svc")"
    "${KC[@]}" get pods -n "$ns" --no-headers 2>/dev/null \
      | awk -v d="$dep" '$1 ~ "^"d"-[a-z0-9]+-[a-z0-9]+$"' || true
  done
}

cmd_up() {
  step "start cluster ($PROFILE)"
  make --no-print-directory minikube-start
  relaunch_pf
  health_check "${DEFAULT_SVCS[@]}"
  log ""
  log "Control UI → http://127.0.0.1:3000"
}

cmd_down() {
  step "stop port-forwards"
  local pidfile pid
  shopt -s nullglob
  for pidfile in /tmp/pf-"${SAFE_PROFILE}"-*.pid; do
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
  shopt -u nullglob
  # NOTE: we deliberately do NOT `pkill -f pf-all-stack.sh` here. Killing the
  # port-forward PIDs above already frees the ports (the background flow). A
  # broad pkill would also reach a holding `make minikube-pf-all` from a
  # DIFFERENT profile, since the profile isn't on that process's command line.

  step "minikube stop ($PROFILE) — preserves cluster, DB, PVCs"
  make --no-print-directory minikube-stop
  log ""
  log "Cluster stopped safely. Bring it back with: make minikube-up"
}

cmd_redeploy() {
  local svcs=("$@")
  [[ ${#svcs[@]} -eq 0 ]] && svcs=("${DEFAULT_SVCS[@]}")

  # Validate up front so a typo fails before any build starts.
  local svc ns dep port path
  for svc in "${svcs[@]}"; do
    if ! svc_meta "$svc" >/dev/null; then
      log "ERROR: unknown service '$svc'. Known: $KNOWN_SVCS" >&2
      exit 2
    fi
  done

  log "Redeploying: ${svcs[*]}"
  local results=()
  for svc in "${svcs[@]}"; do
    read -r ns dep _ _ <<<"$(svc_meta "$svc")"
    step "rebuild $svc → deploy/$dep in $ns"
    if make --no-print-directory minikube-deploy-service SVC="$svc" NS="$ns" DEPLOYMENT="$dep"; then
      results+=("$svc=ok")
    else
      results+=("$svc=FAIL")
    fi
  done

  # `|| true`: a flaky port-forward must not abort before the build summary.
  relaunch_pf || true
  health_check "${svcs[@]}"

  step "summary"
  log "${results[*]}"
  # Non-zero exit if any service failed to build/roll out.
  [[ "${results[*]}" == *FAIL* ]] && exit 1 || true
}

usage() {
  cat >&2 <<EOF
Usage: scripts/minikube/dev.sh <up|down|redeploy> [svc...]

  up                  Start cluster + port-forwards + health check (not a regen).
  down                Stop port-forwards + minikube stop (safe; preserves data).
  redeploy [svc...]   Rebuild + rollout + PF + health. Default: ${DEFAULT_SVCS[*]}.
                      Known services: $KNOWN_SVCS
EOF
  exit 64
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    up)       cmd_up ;;
    down)     cmd_down ;;
    redeploy) cmd_redeploy "$@" ;;
    ""|-h|--help|help) usage ;;
    *) log "ERROR: unknown subcommand '$sub'" >&2; usage ;;
  esac
}

main "$@"
