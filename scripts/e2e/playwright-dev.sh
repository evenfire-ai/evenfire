#!/usr/bin/env bash
# Launches the Desktop App Playwright E2E suite against the selected cluster.
# Assumes port-forwards are running for the same cluster:
#   - control-api        :8090
#   - external-rest-api :8091
#   - rpc-proxy         :8094
#
# Visual modes:
#   VISUAL=1 bash playwright-dev.sh chat.test.ts -g "MongoDB"   # --debug inspector (step)
#   UI=1     bash playwright-dev.sh                             # --ui interactive mode
#
# Electron windows are HEADED by default on macOS/Linux — the visual mode flags
# only add the Playwright Inspector / UI mode on top of the already-visible app.
set -eo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEFAULT_CONTEXT="$(
  kubectl config current-context 2>/dev/null || true
)"
if [[ -z "$DEFAULT_CONTEXT" ]]; then
  DEFAULT_CONTEXT="clerum-test"
fi
KCTX="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-$DEFAULT_CONTEXT}}"

CALLER_CONTROL_API_BASE_URL="${CONTROL_API_BASE_URL:-}"
CALLER_CONTROL_UI_BASE_URL="${CONTROL_UI_BASE_URL:-}"
CALLER_CONTROL_UI_URL="${CONTROL_UI_URL:-}"
CALLER_EXTERNAL_REST_API_BASE_URL="${EXTERNAL_REST_API_BASE_URL:-}"
CALLER_RPC_PROXY_BASE_URL="${RPC_PROXY_BASE_URL:-}"
CALLER_WORKFLOW_APPROVAL_READER_BASE_URL="${WORKFLOW_APPROVAL_READER_BASE_URL:-}"
CALLER_MCP_HOST_RUNTIME_BASE_URL="${MCP_HOST_RUNTIME_BASE_URL:-}"

# Load .env so AIRTABLE_API_KEY + AIRTABLE_BASE_ID propagate to preflight.
# shellcheck disable=SC1090,SC1091
if [[ -f "$REPO/.env" ]]; then
  set -a
  . "$REPO/.env"
  set +a
else
  GIT_COMMON_DIR="$(cd "$REPO" && git rev-parse --git-common-dir 2>/dev/null || echo "")"
  if [[ -n "$GIT_COMMON_DIR" ]]; then
    case "$GIT_COMMON_DIR" in
      /*) MAIN_REPO_DIR="$(cd "${GIT_COMMON_DIR}/.." && pwd)" ;;
      *)  MAIN_REPO_DIR="$(cd "${REPO}/${GIT_COMMON_DIR}/.." && pwd)" ;;
    esac
    if [[ -f "${MAIN_REPO_DIR}/.env" ]]; then
      set -a
      # shellcheck disable=SC1090
      . "${MAIN_REPO_DIR}/.env"
      set +a
    fi
  fi
fi

if [[ -n "$CALLER_CONTROL_API_BASE_URL" ]]; then
  export CONTROL_API_BASE_URL="$CALLER_CONTROL_API_BASE_URL"
fi
if [[ -n "$CALLER_CONTROL_UI_BASE_URL" ]]; then
  export CONTROL_UI_BASE_URL="$CALLER_CONTROL_UI_BASE_URL"
fi
if [[ -n "$CALLER_CONTROL_UI_URL" ]]; then
  export CONTROL_UI_URL="$CALLER_CONTROL_UI_URL"
fi
if [[ -n "$CALLER_EXTERNAL_REST_API_BASE_URL" ]]; then
  export EXTERNAL_REST_API_BASE_URL="$CALLER_EXTERNAL_REST_API_BASE_URL"
fi
if [[ -n "$CALLER_RPC_PROXY_BASE_URL" ]]; then
  export RPC_PROXY_BASE_URL="$CALLER_RPC_PROXY_BASE_URL"
fi
if [[ -n "$CALLER_WORKFLOW_APPROVAL_READER_BASE_URL" ]]; then
  export WORKFLOW_APPROVAL_READER_BASE_URL="$CALLER_WORKFLOW_APPROVAL_READER_BASE_URL"
fi
if [[ -n "$CALLER_MCP_HOST_RUNTIME_BASE_URL" ]]; then
  export MCP_HOST_RUNTIME_BASE_URL="$CALLER_MCP_HOST_RUNTIME_BASE_URL"
fi

# Preflight: ensure Airtable MCP is deployed + allowlisted in context1
KUBECONTEXT="$KCTX" AIRTABLE_API_KEY="${AIRTABLE_API_KEY:-}" \
  bash "$HERE/playwright-preflight-dev.sh"

export CONTROL_API_BASE_URL="${CONTROL_API_BASE_URL:-http://127.0.0.1:8090}"
export CONTROL_UI_BASE_URL="${CONTROL_UI_BASE_URL:-${CONTROL_UI_URL:-http://127.0.0.1:3000}}"
export EXTERNAL_REST_API_BASE_URL="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
export RPC_PROXY_BASE_URL="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
export WORKFLOW_APPROVAL_READER_BASE_URL="${WORKFLOW_APPROVAL_READER_BASE_URL:-http://127.0.0.1:8098}"
export MCP_HOST_RUNTIME_BASE_URL="${MCP_HOST_RUNTIME_BASE_URL:-http://127.0.0.1:8080}"
export E2E_DEV_LOGIN_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
# approval-flow.test.ts and global setup use this to enforce cluster/url alignment.
# approval-flow.test.ts uses this to target the right cluster (default is minikube).
export E2E_K8S_CONTEXT="${E2E_K8S_CONTEXT:-$KCTX}"

check_health() {
  local name="$1"
  local url="$2"
  if ! curl -sf -m 2 "$url" >/dev/null 2>&1; then
    echo "[playwright-dev] ERROR: $name not reachable at $url — start/refresh port-forwards first:" >&2
    echo "  make minikube-pf-all-bg" >&2
    exit 1
  fi
}

require_random_local_port_for_branch_context() {
  local name="$1"
  local url="$2"
  local default_port="$3"
  if [[ ! "$KCTX" =~ ^clerum-(codex|detached)- ]]; then
    return 0
  fi
  if [[ "$url" =~ ^https?://(localhost|127\.0\.0\.1):${default_port}(/|$) ]]; then
    echo "[playwright-dev] ERROR: context=$KCTX must use random localhost port-forwards." >&2
    echo "  $name=$url uses shared default port $default_port, which can point at stale clerum-test/clerum-dev forwards." >&2
    exit 1
  fi
}

require_random_local_port_for_branch_context "CONTROL_UI_BASE_URL" "$CONTROL_UI_BASE_URL" "3000"
require_random_local_port_for_branch_context "CONTROL_API_BASE_URL" "$CONTROL_API_BASE_URL" "8090"
require_random_local_port_for_branch_context "EXTERNAL_REST_API_BASE_URL" "$EXTERNAL_REST_API_BASE_URL" "8091"
require_random_local_port_for_branch_context "RPC_PROXY_BASE_URL" "$RPC_PROXY_BASE_URL" "8094"
require_random_local_port_for_branch_context "WORKFLOW_APPROVAL_READER_BASE_URL" "$WORKFLOW_APPROVAL_READER_BASE_URL" "8098"
require_random_local_port_for_branch_context "MCP_HOST_RUNTIME_BASE_URL" "$MCP_HOST_RUNTIME_BASE_URL" "8080"

# Quick health check of required port-forwards
check_health "control-api" "${CONTROL_API_BASE_URL%/}/health"
check_health "external-rest-api" "${EXTERNAL_REST_API_BASE_URL%/}/health"
check_health "rpc-proxy" "${RPC_PROXY_BASE_URL%/}/health"

if [[ "${E2E_WORKFLOW_APPROVAL_QUADRANTS:-0}" == "1" ]]; then
  check_health "workflow-approval-request-reader" "${WORKFLOW_APPROVAL_READER_BASE_URL%/}/health"
  check_health "mcp-host" "${MCP_HOST_RUNTIME_BASE_URL%/}/v1/runtime/health"
fi

cd "$REPO/desktop-app"

if [[ "${E2E_SKIP_DESKTOP_BUILD:-0}" != "1" ]]; then
  echo "[playwright-dev] Building Desktop App before Playwright so dist/ui-dist matches the current worktree"
  npm run build
fi

if [[ "$E2E_K8S_CONTEXT" == "gke_${GCP_PROJECT}_us-central1-a_clerum-dev" ]] && \
   [[ "$CONTROL_API_BASE_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] && \
   [[ "$EXTERNAL_REST_API_BASE_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] && \
   [[ "$RPC_PROXY_BASE_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] && \
   { [[ "${E2E_WORKFLOW_APPROVAL_QUADRANTS:-0}" != "1" ]] || \
     { [[ "$WORKFLOW_APPROVAL_READER_BASE_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]] && \
       [[ "$MCP_HOST_RUNTIME_BASE_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]]; }; }; then
  export E2E_ALLOW_DEV_PORT_FORWARD="${E2E_ALLOW_DEV_PORT_FORWARD:-1}"
fi

EXTRA_FLAGS=()
if [[ "${VISUAL:-0}" == "1" ]]; then
  echo "[playwright-dev] VISUAL=1 → enabling Playwright Inspector (step-by-step)"
  EXTRA_FLAGS+=(--debug)
fi
if [[ "${UI:-0}" == "1" ]]; then
  echo "[playwright-dev] UI=1 → launching Playwright UI mode"
  EXTRA_FLAGS+=(--ui)
fi

echo "[playwright-dev] Launching Playwright (context=$E2E_K8S_CONTEXT email=$E2E_DEV_LOGIN_EMAIL)"
exec npx playwright test --config test/e2e-playwright/playwright.config.ts "${EXTRA_FLAGS[@]}" "$@"
