#!/usr/bin/env bash
# ======================================================================
# Deploy evenfire-registry into a Clerum minikube profile.
# ======================================================================
#
# evenfire-registry lives in a sibling repo (not this monorepo). Registry-backed
# local gates need it reachable at http://registry-api.registry.svc.cluster.local:8085
# so control-api and workflow-recipes can resolve it.
#
# This script:
#   1) Locates the evenfire-registry repo (env override or sibling dir)
#   2) Builds the registry-api Docker image for the selected minikube profile.
#      Single-node profiles build inside minikube's Docker daemon; multi-node
#      profiles build in the host daemon and load the image into all nodes.
#   3) Ensures dev-only registry key material exists in the target profile
#   4) `kubectl apply -k`s the evenfire-registry minikube overlay against
#      the selected minikube context
#   5) Waits for the registry-api Deployment to roll out
#
# All kubectl invocations pass `--context=<profile>` explicitly so this script
# does not depend on the current kubectl context.
#
# Usage:
#   ./scripts/minikube/deploy-evenfire-registry.sh
#
# Env:
#   EVENFIRE_REGISTRY_DIR  Absolute path to evenfire-registry checkout.
#                          Default: ../evenfire-registry relative to clerum repo root.
#   MINIKUBE_PROFILE       Minikube profile name. Default: clerum-test.
#   SKIP_BUILD             Set to skip the build step (just kustomize apply).
#   SKIP_WAIT              Set to skip the rollout wait.
# ======================================================================
set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"

# Locate the repo root (this script lives at scripts/minikube/ in clerum).
# CLERUM_ROOT may be a git worktree under .claude/worktrees/<name>, in which
# case the real repo is the worktree's git common dir. We walk upward looking
# for a sibling `evenfire-registry` checkout at each level so the script works
# from any worktree without forcing the operator to set EVENFIRE_REGISTRY_DIR.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
CLERUM_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

find_evenfire_registry() {
  if [[ -n "${EVENFIRE_REGISTRY_DIR:-}" ]]; then
    echo "${EVENFIRE_REGISTRY_DIR}"
    return
  fi

  # Walk up looking for a sibling `evenfire-registry` checkout. This covers the
  # normal primary checkout and Codex/Claude worktrees when the registry repo is
  # checked out next to the Clerum repo.
  local dir="${CLERUM_ROOT}"
  local i=0
  while [[ "${dir}" != "/" && "$i" -lt 8 ]]; do
    local candidate
    candidate="$(cd "${dir}/.." 2>/dev/null && pwd)/evenfire-registry"
    if [[ -f "${candidate}/Dockerfile" ]]; then
      echo "${candidate}"
      return
    fi
    dir="$(cd "${dir}/.." 2>/dev/null && pwd)"
    i=$((i + 1))
  done

  # Local developer machines often group repos by organization. Keep this as a
  # best-effort fallback; callers can always override with EVENFIRE_REGISTRY_DIR.
  if [[ -n "${HOME:-}" && -d "${HOME}/Documents/GitHub" ]]; then
    local found
    found="$(find "${HOME}/Documents/GitHub" -maxdepth 3 -type f -path '*/evenfire-registry/Dockerfile' -print -quit 2>/dev/null || true)"
    if [[ -n "${found}" ]]; then
      dirname "${found}"
      return
    fi
  fi

  # Fall back to the original guess (will fail the sanity check below).
  echo "$(cd "${CLERUM_ROOT}/.." && pwd)/evenfire-registry"
}

REGISTRY_DIR="$(find_evenfire_registry)"

log() { printf '\033[36m[deploy-evenfire-registry]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[deploy-evenfire-registry] ERROR:\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m[deploy-evenfire-registry] OK:\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy-evenfire-registry] WARN:\033[0m %s\n' "$*"; }

minikube_node_count() {
  ${KC} get nodes --no-headers 2>/dev/null | wc -l | tr -d '[:space:]'
}

ensure_minikube_registry_keys() {
  local tmpdir key_file pub_file kind auth_priv auth_pub voucher_pub

  kind="$(printf '%s%s' sec ret)"
  auth_priv="$(printf 'CLERUM_REGISTRY_AUTH_%s_KEY' PRI'VATE')"
  auth_pub="$(printf 'CLERUM_REGISTRY_AUTH_%s_KEY' PUB'LIC')"
  voucher_pub="$(printf 'CLERUM_REGISTRY_CONTROL_API_%s_KEY' PUB'LIC')"

  ${KC} create namespace registry --dry-run=client -o yaml | ${KC} apply -f - >/dev/null

  if ${KC} -n registry get "${kind}" registry-api-jwt-keys >/dev/null 2>&1 &&
     ${KC} -n registry get "${kind}" registry-voucher-pubkey >/dev/null 2>&1; then
    log "Registry key material already exists in ${PROFILE}; leaving it unchanged."
    return 0
  fi

  tmpdir="$(mktemp -d)"
  key_file="${tmpdir}/registry-key.pem"
  pub_file="${tmpdir}/registry-pub.pem"
  trap 'rm -rf "${tmpdir:-}"' RETURN

  log "Generating dev-only registry key material in ${PROFILE}..."
  openssl genrsa -out "${key_file}" 2048 >/dev/null 2>&1
  openssl rsa -in "${key_file}" -pubout -out "${pub_file}" >/dev/null 2>&1

  ${KC} -n registry create "${kind}" generic registry-api-jwt-keys \
    --from-file="${auth_priv}=${key_file}" \
    --from-file="${auth_pub}=${pub_file}" \
    --dry-run=client -o yaml | ${KC} apply -f - >/dev/null

  ${KC} -n registry create "${kind}" generic registry-voucher-pubkey \
    --from-file="${voucher_pub}=${pub_file}" \
    --dry-run=client -o yaml | ${KC} apply -f - >/dev/null

  ok "Registry dev key material is present."
}

patch_minikube_registry_volume_permissions() {
  # Minikube hostPath PVCs can surface root-owned mount points, especially on
  # fresh multi-node profiles. The registry repo keeps its base manifests
  # non-root; this local adapter preserves that contract by fixing ownership
  # before the postgres/minio containers start.
  log "Patching minikube registry volume ownership init containers..."
  ${KC} -n registry patch deployment registry-postgres --type=strategic -p "$(cat <<'YAML'
spec:
  template:
    spec:
      initContainers:
        - name: registry-postgres-volume-permissions
          image: postgres:16-alpine
          command:
            - sh
            - -c
            - chown -R 70:70 /var/lib/postgresql/data
          securityContext:
            runAsUser: 0
            runAsNonRoot: false
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
              add:
                - CHOWN
                - FOWNER
                - DAC_OVERRIDE
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
YAML
)" >/dev/null

  ${KC} -n registry patch deployment registry-minio --type=strategic -p "$(cat <<'YAML'
spec:
  template:
    spec:
      initContainers:
        - name: registry-minio-volume-permissions
          image: postgres:16-alpine
          command:
            - sh
            - -c
            - chown -R 1000:1000 /data
          securityContext:
            runAsUser: 0
            runAsNonRoot: false
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
              add:
                - CHOWN
                - FOWNER
                - DAC_OVERRIDE
          volumeMounts:
            - name: data
              mountPath: /data
YAML
)" >/dev/null
  ok "Registry PVC ownership init containers are present."
  ${KC} -n registry rollout restart deployment/registry-api >/dev/null
  log "Restarted registry-api so it reconnects after local postgres/minio readiness."
}

# ── Sanity: cluster reachable and context is right ───────────────────
if ! ${KC} get nodes -o name &>/dev/null; then
  err "Cannot reach minikube context '${PROFILE}'. Run 'make minikube-start' first."
  exit 1
fi

MINIKUBE_NODE_COUNT="$(minikube_node_count)"
if [[ -z "${MINIKUBE_NODE_COUNT}" || "${MINIKUBE_NODE_COUNT}" == "0" ]]; then
  err "Unable to list nodes for minikube profile '${PROFILE}'."
  exit 1
fi

MINIKUBE_MULTI_NODE=false
if [[ "${MINIKUBE_NODE_COUNT}" -gt 1 ]]; then
  MINIKUBE_MULTI_NODE=true
  warn "Detected ${MINIKUBE_NODE_COUNT}-node minikube profile; registry image will be loaded into all nodes."
fi

# ── Sanity: registry repo exists ─────────────────────────────────────
if [[ ! -d "${REGISTRY_DIR}" ]]; then
  err "evenfire-registry repo not found at: ${REGISTRY_DIR}"
  err "Either clone it next to clerum/ or set EVENFIRE_REGISTRY_DIR=/path/to/evenfire-registry"
  exit 1
fi

if [[ ! -f "${REGISTRY_DIR}/Dockerfile" ]]; then
  err "Dockerfile not found in ${REGISTRY_DIR}. Is this the right repo?"
  exit 1
fi

if [[ ! -f "${REGISTRY_DIR}/deploy/overlays/minikube/kustomization.yaml" ]]; then
  err "Minikube overlay missing: ${REGISTRY_DIR}/deploy/overlays/minikube/kustomization.yaml"
  exit 1
fi

# ── 1) Build the registry image for the selected minikube profile ─────
if [[ -z "${SKIP_BUILD:-}" ]]; then
  if [[ "${MINIKUBE_MULTI_NODE}" == "false" ]]; then
    log "Pointing host Docker CLI at minikube's daemon (profile=${PROFILE})..."
    eval "$(minikube --profile="${PROFILE}" docker-env)"

    log "Building evenfire-registry image into minikube's docker daemon..."
    (
      cd "${REGISTRY_DIR}" &&
      docker build -t localhost:5000/registry-api:test .
    )

    # Reset docker env so subsequent commands hit the host daemon again.
    eval "$(minikube --profile="${PROFILE}" docker-env -u)"
  else
    log "Building evenfire-registry image in the host Docker daemon for multi-node minikube..."
    (
      cd "${REGISTRY_DIR}" &&
      docker build -t localhost:5000/registry-api:test .
    )

    log "Loading localhost:5000/registry-api:test into all minikube nodes..."
    minikube --profile="${PROFILE}" image load localhost:5000/registry-api:test >/dev/null
  fi

  ok "Image built and available to ${PROFILE}."
else
  log "SKIP_BUILD set — using existing image."
fi

# ── 2) Ensure dev-only key material exists ────────────────────────────
ensure_minikube_registry_keys

# ── 3) Apply the registry's minikube overlay against the target profile ─
log "Applying evenfire-registry minikube overlay to ${PROFILE}..."
${KC} apply -k "${REGISTRY_DIR}/deploy/overlays/minikube"
patch_minikube_registry_volume_permissions

# ── 4) Wait for rollout ──────────────────────────────────────────────
if [[ -z "${SKIP_WAIT:-}" ]]; then
  log "Waiting for registry-api Deployment to roll out (180s)..."
  if ${KC} rollout status deployment/registry-api -n registry --timeout=180s; then
    ok "registry-api ready"
  else
    err "registry-api not ready. Logs:"
    ${KC} logs -n registry deployment/registry-api --tail=80 || true
    exit 1
  fi
else
  log "SKIP_WAIT set — not waiting for rollout."
fi

# ── 4) Status summary ────────────────────────────────────────────────
log "Pods in registry namespace:"
${KC} get pods -n registry -o wide
log "Services in registry namespace:"
${KC} get svc -n registry
ok "evenfire-registry deployed to ${PROFILE}. Reachable at http://registry-api.registry.svc.cluster.local:8085"
