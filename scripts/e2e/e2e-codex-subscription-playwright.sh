#!/usr/bin/env bash
# Run Codex subscription Control UI Playwright guardians against a branch-owned
# Minikube profile with profile-scoped port-forwards and service URLs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"

# shellcheck source=scripts/e2e/load-dotenv.sh
source "${HERE}/load-dotenv.sh"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${HERE}/admin-credentials.sh"

PROFILE="${MINIKUBE_PROFILE:-${KUBECONTEXT:-}}"
PF_LOG="${E2E_PF_LOG:-/tmp/${PROFILE:-clerum-test}-codex-subscription-playwright-pf.log}"
PF_PID=""
PLAYWRIGHT_DIR="${ROOT}/tests/e2e/playwright"

log() {
  printf '[codex-subscription-playwright] %s\n' "$*"
}

die() {
  printf '[codex-subscription-playwright] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "${PF_PID}" 2>/dev/null; then
        wait "${PF_PID}" 2>/dev/null || true
        return 0
      fi
      sleep 0.25
    done
    kill -9 "${PF_PID}" 2>/dev/null || true
    wait "${PF_PID}" 2>/dev/null || true
  fi
}

wait_http() {
  local name="$1"
  local url="$2"
  local timeout="$3"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    if curl -sf -m 3 "${url}" >/dev/null 2>&1; then
      log "${name} ready at ${url}"
      return 0
    fi
    sleep 1
  done
  die "${name} never became ready at ${url} (see ${PF_LOG})"
}

load_branch_profile_ports() {
  local ctx="${KUBECONTEXT:-${MINIKUBE_PROFILE:-}}"
  local ports_env="${CLERUM_PROFILE_PORTS_ENV:-${E2E_PROFILE_PORTS_ENV:-}}"
  local urls_preconfigured=false
  if [[ -n "${CONTROL_UI_URL:-${CONTROL_UI_BASE_URL:-}}" && -n "${CONTROL_API_URL:-${CONTROL_API_BASE_URL:-}}" ]]; then
    urls_preconfigured=true
  fi
  if [[ "${ctx}" =~ ^clerum-(codex|detached)- ]] || [[ "${ctx}" =~ ^clerum-.+-[0-9a-f]{7,8}$ ]]; then
    if [[ -z "${ports_env}" ]]; then
      ports_env="${HOME}/.cache/clerum/minikube-profiles/${ctx}/ports.env"
    fi
    if [[ -z "${ports_env}" && "${urls_preconfigured}" != "true" ]]; then
      die "branch-owned context ${ctx} requires ports.env from branch-profile preflight, or explicit CONTROL_UI_URL and CONTROL_API_URL"
    fi
  elif [[ -z "${ports_env}" && -n "${ctx}" ]]; then
    ports_env="${HOME}/.cache/clerum/minikube-profiles/${ctx}/ports.env"
  fi
  if [[ -n "${ports_env}" && -f "${ports_env}" ]]; then
    dotenv_load_file "${ports_env}"
  fi
  if [[ -n "${ports_env}" ]]; then
    export CLERUM_PROFILE_PORTS_ENV="${ports_env}"
  fi
}

require_random_local_port_for_branch_context() {
  local name="$1"
  local url="$2"
  local default_port="$3"
  if [[ ! "${PROFILE}" =~ ^clerum-(codex|detached)- ]] && [[ ! "${PROFILE}" =~ ^clerum-.+-[0-9a-f]{7,8}$ ]]; then
    return 0
  fi
  if [[ "${url}" =~ ^https?://(localhost|127\.0\.0\.1):${default_port}(/|$) ]]; then
    die "${PROFILE} must use profile-owned random port-forwards; ${name}=${url} uses shared default port ${default_port}"
  fi
}

[[ -n "${PROFILE}" ]] || die "KUBECONTEXT or MINIKUBE_PROFILE is required"

if ! minikube -p "${PROFILE}" status >/dev/null 2>&1; then
  die "minikube profile '${PROFILE}' is not running"
fi

if ! kubectl --context="${PROFILE}" cluster-info >/dev/null 2>&1; then
  die "kubectl cannot reach context '${PROFILE}'"
fi

[[ -x "${PLAYWRIGHT_DIR}/node_modules/.bin/playwright" ]] || \
  die "missing ${PLAYWRIGHT_DIR}/node_modules/.bin/playwright; run npm ci in tests/e2e/playwright"

export MINIKUBE_PROFILE="${PROFILE}"
export KUBECONTEXT="${PROFILE}"
export KUBE_CONTEXT="${PROFILE}"
export KUBECTL_CONTEXT="${PROFILE}"

load_branch_profile_ports

RESOLVED_ADMIN_PASSWORD="$(e2e_resolve_admin_password "${ROOT}" "$(printf '%s%s' 'changeme123' '!')" || true)"
if [[ -z "${RESOLVED_ADMIN_PASSWORD}" ]]; then
  die "no admin password is configured in the canonical root .env or process environment"
fi
export TEST_ADMIN_PASSWORD="${TEST_ADMIN_PASSWORD:-${RESOLVED_ADMIN_PASSWORD}}"
export TEST_ADMIN_USERNAME="${TEST_ADMIN_USERNAME:-admin}"

export CONTROL_UI_URL="${CONTROL_UI_URL:-${CONTROL_UI_BASE_URL:-http://127.0.0.1:${CONTROL_UI_PORT:-3000}}}"
export CONTROL_UI_BASE_URL="${CONTROL_UI_BASE_URL:-${CONTROL_UI_URL}}"
export CONTROL_API_URL="${CONTROL_API_URL:-${CONTROL_API_BASE_URL:-http://127.0.0.1:${CONTROL_API_PORT:-8090}}}"
export CONTROL_API_BASE_URL="${CONTROL_API_BASE_URL:-${CONTROL_API_URL}}"

require_random_local_port_for_branch_context "CONTROL_UI_URL" "${CONTROL_UI_URL}" "3000"
require_random_local_port_for_branch_context "CONTROL_API_URL" "${CONTROL_API_URL}" "8090"

log "Syncing Codex subscription Control UI origin into control-api"
sync_args=(--context "${PROFILE}")
if [[ -n "${CLERUM_PROFILE_PORTS_ENV:-}" ]]; then
  sync_args+=(--ports-env "${CLERUM_PROFILE_PORTS_ENV}")
fi
"${ROOT}/scripts/minikube/sync-codex-subscription-control-ui-url.sh" "${sync_args[@]}" \
  || die "failed to sync Codex subscription Control UI URL"

if [[ "${E2E_USE_EXISTING_PORT_FORWARDS:-false}" != "true" ]]; then
  log "Starting held port-forwards (log: ${PF_LOG})"
  "${ROOT}/scripts/minikube/pf-all-stack.sh" --hold >"${PF_LOG}" 2>&1 &
  PF_PID="$!"
  trap cleanup EXIT INT TERM
else
  log "Using existing port-forwards (E2E_USE_EXISTING_PORT_FORWARDS=true)"
fi

wait_http control-ui "${CONTROL_UI_URL%/}/" 90
wait_http control-api "${CONTROL_API_URL%/}/health" 60

log "Running Control UI Playwright guardians (CONTROL_UI_URL=${CONTROL_UI_URL})"
(
  cd "${PLAYWRIGHT_DIR}"
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_DIR}/.playwright-browsers" \
    ./node_modules/.bin/playwright test \
      --config playwright.codex-subscription.config.ts \
      --project=control-ui
)
