#!/usr/bin/env bash
# Align the profiles/external-rest-api browser origin with a branch profile's
# Profile UI origin.
#
# WHY THIS EXISTS
# The base manifest pins EXTERNAL_REST_API_CORS_ORIGIN to the default local
# Profile UI origin, port 3001 (deploy/base/profiles/external-rest-api.yaml),
# while a branch-owned Minikube
# profile serves Profile UI on a generated port (scripts/minikube-profiles/
# branch-profile.sh: PROFILE_UI_URL). external-rest-api's browser mutation
# guard requires the request Origin to be one of the configured origins
# (external-rest-api/src/middleware/browserMutationGuard.ts), and Next's rewrite
# proxy forwards the browser Origin unchanged. Password login and every other
# cookie-bearing POST from the profile UI therefore returned 403 on a branch
# profile (review item C-8, owner decision OD-8).
#
# The guard and the CORS checks stay exactly as they are: this script gives the
# profile-scoped deployment the one origin it actually serves. Production and
# clerum-dev keep using their own manifests and never reach this path.
#
# WHERE IT RUNS
# The branch-profile harness owns the value inside its own deploy paths, after
# the kustomize overlay is applied:
#   * scripts/minikube/full-setup.sh          (make minikube-setup, branch-profile-setup)
#   * Makefile minikube-deploy-all-body       (make minikube-deploy-all, pre-gate-sync)
# A plain `kubectl apply` of the overlay three-way merges the field back to the
# manifest literal, so a later sync would otherwise revert the value; running
# the reconcile after every apply is what keeps it.
#
# ORIGIN SOURCE
# The origin comes only from the branch profile's own ports.env: PROFILE_UI_URL
# first, then http://127.0.0.1:${PROFILE_UI_PORT}. An ambient PROFILE_UI_URL
# (operator shell, wrapper, dotenv) must not diverge from that file, so a
# disagreement is refused before any cluster call instead of being written onto
# the profile Deployment.
#
# NOT A BRANCH PROFILE -> NO-OP
# A branch-owned profile always carries a persisted ports.env written by
# scripts/minikube-profiles/branch-profile.sh. Without one this script logs and
# exits 0 before touching the cluster, so shared profiles (clerum-test,
# clerum-dev, ...) keep their manifest value. A profile whose name is
# branch-scoped but whose ports are missing fails loud instead: silently
# skipping there would leave the profile UI login broken with a 403.
#
# Usage:
#   scripts/minikube/sync-external-rest-api-cors-origin.sh --context <name>
#   scripts/minikube/sync-external-rest-api-cors-origin.sh --context <name> --dry-run
#   CLERUM_PROFILE_PORTS_ENV=/path/to/ports.env ... (explicit ports file)
set -euo pipefail

ENV_NAME="EXTERNAL_REST_API_CORS_ORIGIN"
NAMESPACE="profiles"
DEPLOYMENT="external-rest-api"
CONTAINER="external-rest-api"
ROLLOUT_TIMEOUT_SECONDS=180

PROFILE="${MINIKUBE_PROFILE:-${KUBECONTEXT:-}}"
PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-}"
PROFILE_CACHE_ROOT="${CLERUM_PROFILE_CACHE_ROOT:-${HOME}/.cache/clerum/minikube-profiles}"
PORTS_ENV_EXPLICIT=false
DRY_RUN=false

log() {
  printf '[external-rest-api-cors-origin] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/minikube/sync-external-rest-api-cors-origin.sh [options]

Options:
  --context <name>     Kubernetes context / Minikube profile (default: MINIKUBE_PROFILE)
  --ports-env <path>   Branch profile ports.env (default: CLERUM_PROFILE_PORTS_ENV or
                       $HOME/.cache/clerum/minikube-profiles/<profile>/ports.env)
  --dry-run            Print the resolved Profile UI origin without patching the cluster
  -h, --help           Show this help

The Deployment env value is resolved from the branch profile ports.env:
  1. PROFILE_UI_URL from ports.env
  2. http://127.0.0.1:${PROFILE_UI_PORT} from the same file

An ambient PROFILE_UI_URL that disagrees with that file is refused. Without a
branch profile ports.env this is a no-op. Shared or protected contexts are
refused outright, case-insensitively.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      PROFILE="${2:-}"
      shift 2
      ;;
    --context=*)
      PROFILE="${1#--context=}"
      shift
      ;;
    --ports-env)
      PORTS_ENV="${2:-}"
      PORTS_ENV_EXPLICIT=true
      shift 2
      ;;
    --ports-env=*)
      PORTS_ENV="${1#--ports-env=}"
      PORTS_ENV_EXPLICIT=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

[[ -n "${PROFILE}" ]] || die "MINIKUBE_PROFILE or --context is required"

if [[ -z "${PORTS_ENV}" ]]; then
  PORTS_ENV="${PROFILE_CACHE_ROOT}/${PROFILE}/ports.env"
fi

is_branch_scoped_profile() {
  [[ "$1" =~ ^clerum-[a-z0-9][a-z0-9._-]*-[0-9a-f]{7,8}$ ]]
}

# Shared and protected contexts keep their manifest value. They are checked
# only after a ports.env was found, so an ordinary `make minikube-deploy-all`
# against a shared profile stays a plain no-op instead of failing the deploy.
# The name list is case-insensitive, exactly like refuse_shared_profile_name in
# scripts/minikube-profiles/branch-profile.sh.
is_shared_or_protected_profile() {
  local normalized
  normalized="$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    clerum | clerum-dev | clerum-test | minikube | docker-desktop | default | *gke* | *prod* | *staging*) return 0 ;;
    *) return 1 ;;
  esac
}

read_ports_env_value() {
  local key="$1"
  awk -F= -v expected_key="${key}" '$1 == expected_key { sub(/^[^=]*=/, ""); print; exit }' "${PORTS_ENV}"
}

if [[ ! -f "${PORTS_ENV}" ]]; then
  if [[ "${PORTS_ENV_EXPLICIT}" == "true" ]]; then
    die "profile ports file does not exist: ${PORTS_ENV}"
  fi
  if is_branch_scoped_profile "${PROFILE}"; then
    die "PROFILE_PORTS_MISSING: branch-scoped profile ${PROFILE} has no persisted ports at ${PORTS_ENV}; refusing to leave the profile UI login on the shared manifest origin"
  fi
  log "profile ${PROFILE} is not branch-owned (no ${PORTS_ENV}); nothing to sync"
  exit 0
fi

is_shared_or_protected_profile "${PROFILE}" &&
  die "refusing shared or protected context ${PROFILE}: a branch profile ports file is not its owner"

resolve_profile_ui_origin() {
  local origin port
  origin="$(read_ports_env_value PROFILE_UI_URL)"
  if [[ -z "${origin}" ]]; then
    port="$(read_ports_env_value PROFILE_UI_PORT)"
    if [[ "${port}" =~ ^[0-9]{2,5}$ ]]; then
      origin="http://127.0.0.1:${port}"
    fi
  fi
  printf '%s' "${origin%/}"
}

validate_origin() {
  local origin="$1"
  # Exactly what a browser sends in the Origin header: scheme, host and an
  # optional port. No wildcard, no path, no list, no whitespace.
  [[ "${origin}" =~ ^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{2,5})?$ ]] ||
    die "refusing an unusable browser origin: ${origin}"
}

# The env var is a literal value in the profile Deployment (see
# deploy/base/profiles/external-rest-api.yaml), so the live value can be read
# back and compared before writing.
current_cors_origin() {
  local jsonpath
  jsonpath="{.spec.template.spec.containers[?(@.name==\"${CONTAINER}\")].env[?(@.name==\"${ENV_NAME}\")].value}"
  "${KCTL[@]}" get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" -o "jsonpath=${jsonpath}"
}

PROFILE_UI_ORIGIN="$(resolve_profile_ui_origin)"

# The branch profile owns its Profile UI port. Refuse an ambient value that
# disagrees with the file before any cluster call instead of writing it onto
# the profile Deployment.
if [[ -n "${PROFILE_UI_URL:-}" && "${PROFILE_UI_URL%/}" != "${PROFILE_UI_ORIGIN}" ]]; then
  die "refusing ambient PROFILE_UI_URL='${PROFILE_UI_URL}': ${PORTS_ENV} records '${PROFILE_UI_ORIGIN:-<no Profile UI origin>}'"
fi

[[ -n "${PROFILE_UI_ORIGIN}" ]] ||
  die "could not resolve PROFILE_UI_URL from ${PORTS_ENV}; the profile UI login origin is unknown"
validate_origin "${PROFILE_UI_ORIGIN}"

log "Profile: ${PROFILE}"
log "Profile UI origin: ${PROFILE_UI_ORIGIN}"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "Dry run complete; cluster unchanged"
  exit 0
fi

KCTL=(kubectl --context="${PROFILE}")

if ! "${KCTL[@]}" get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  die "missing ${NAMESPACE}/${DEPLOYMENT}; apply the minikube overlay before syncing the profile UI origin"
fi

current_origin="$(current_cors_origin || true)"
if [[ "${current_origin}" == "${PROFILE_UI_ORIGIN}" ]]; then
  log "${NAMESPACE}/${DEPLOYMENT} ${ENV_NAME} already matches ${PROFILE_UI_ORIGIN}"
  exit 0
fi

# Strategic merge so the env entry is replaced BY NAME and every other env
# entry the overlay manages stays untouched.
patch_payload="$(printf '{"spec":{"template":{"spec":{"containers":[{"name":"%s","env":[{"name":"%s","value":"%s"}]}]}}}}' \
  "${CONTAINER}" "${ENV_NAME}" "${PROFILE_UI_ORIGIN}")"

log "Patching ${NAMESPACE}/${DEPLOYMENT} ${ENV_NAME} (was '${current_origin:-<unset>}')"
"${KCTL[@]}" patch deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
  --type=strategic --patch "${patch_payload}" >/dev/null

log "Waiting for the ${NAMESPACE}/${DEPLOYMENT} rollout"
"${KCTL[@]}" rollout status "deployment/${DEPLOYMENT}" -n "${NAMESPACE}" \
  --timeout="${ROLLOUT_TIMEOUT_SECONDS}s" >/dev/null

log "Profile UI origin synced on ${NAMESPACE}/${DEPLOYMENT}"
