#!/usr/bin/env bash
# Launches the Desktop App Playwright E2E suite against the selected cluster.
# Assumes branch-profile port-forwards are running for the same cluster. The
# active URLs are read from the caller environment (normally ports.env emitted
# by Clerum's .local-notes/minikube-profiles/branch.mk); fixed shared defaults
# are retained only for the unscoped clerum-test profile.
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

# shellcheck source=scripts/e2e/load-dotenv.sh
source "$HERE/load-dotenv.sh"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "$HERE/admin-credentials.sh"

CALLER_KUBECONTEXT="${KUBECONTEXT:-}"
CALLER_E2E_K8S_CONTEXT="${E2E_K8S_CONTEXT:-}"
CALLER_CONTROL_API_BASE_URL="${CONTROL_API_BASE_URL:-}"
CALLER_CONTROL_API_URL="${CONTROL_API_URL:-}"
CALLER_E2E_CONTROL_API_URL="${E2E_CONTROL_API_URL:-}"
CALLER_CONTROL_UI_BASE_URL="${CONTROL_UI_BASE_URL:-}"
CALLER_CONTROL_UI_URL="${CONTROL_UI_URL:-}"
CALLER_EXTERNAL_REST_API_BASE_URL="${EXTERNAL_REST_API_BASE_URL:-}"
CALLER_EXTERNAL_REST_API_URL="${EXTERNAL_REST_API_URL:-}"
CALLER_E2E_EXTERNAL_REST_API_URL="${E2E_EXTERNAL_REST_API_URL:-}"
CALLER_RPC_PROXY_BASE_URL="${RPC_PROXY_BASE_URL:-}"
CALLER_RPC_PROXY_URL="${RPC_PROXY_URL:-}"
CALLER_E2E_RPC_PROXY_URL="${E2E_RPC_PROXY_URL:-}"
CALLER_WORKFLOW_APPROVAL_READER_BASE_URL="${WORKFLOW_APPROVAL_READER_BASE_URL:-}"
CALLER_WORKFLOW_APPROVAL_READER_URL="${WORKFLOW_APPROVAL_READER_URL:-}"
CALLER_MCP_HOST_RUNTIME_BASE_URL="${MCP_HOST_RUNTIME_BASE_URL:-}"
CALLER_MCP_HOST_RUNTIME_URL="${MCP_HOST_RUNTIME_URL:-}"
CALLER_MCP_HOST_BASE_URL="${MCP_HOST_BASE_URL:-}"
# Load the canonical root .env as data so AIRTABLE_API_KEY + AIRTABLE_BASE_ID
# reach preflight without executing arbitrary dotenv content.
dotenv_load_canonical_root "$REPO"

# Resolve credentials by origin rather than by inherited variable name. The
# canonical root .env is the seed source for the branch-owned cluster, so a
# stale E2E_ADMIN_PASSWORD in the parent shell must not silently win. The
# local fallback is used only when no canonical/process credential exists.
RESOLVED_ADMIN_PASSWORD="$(e2e_resolve_admin_password "$REPO" "$(printf '%s%s' 'changeme123' '!')" || true)"
if [[ -z "$RESOLVED_ADMIN_PASSWORD" ]]; then
  echo '[playwright-dev] ERROR: no admin password is configured in the canonical root .env or process environment' >&2
  exit 1
fi
export E2E_ADMIN_PASSWORD="$RESOLVED_ADMIN_PASSWORD"
export ADMIN_PASSWORD="$RESOLVED_ADMIN_PASSWORD"
export TEST_ADMIN_PASSWORD="$RESOLVED_ADMIN_PASSWORD"

# The SDK T3 lane is intentionally deterministic and provider-bounded. Never
# inherit the host-wide Z.AI selection into this journey: an unavailable or
# rate-limited provider would make an infrastructure check look like a product
# failure. Callers may choose either approved provider explicitly.
SDK_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-openai}}"
case "$SDK_PROVIDER" in
  openai|claude) ;;
  *)
    echo "[playwright-dev] ERROR: Plugin Workload SDK Playwright requires OpenAI or Claude; got ${SDK_PROVIDER}" >&2
    exit 1
    ;;
esac
SDK_MODEL="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-}}"
if [[ -z "$SDK_MODEL" ]]; then
  case "$SDK_PROVIDER" in
    openai) SDK_MODEL='gpt-5.4-mini' ;;
    claude) SDK_MODEL='claude-sonnet-4-6' ;;
  esac
fi
export E2E_WORKFLOW_MODEL_PROVIDER="$SDK_PROVIDER"
export E2E_WORKFLOW_MODEL_NAME="$SDK_MODEL"

[[ -n "$CALLER_KUBECONTEXT" ]] && export KUBECONTEXT="$CALLER_KUBECONTEXT"
[[ -n "$CALLER_E2E_K8S_CONTEXT" ]] && export E2E_K8S_CONTEXT="$CALLER_E2E_K8S_CONTEXT"
if [[ -n "$CALLER_CONTROL_API_BASE_URL" ]]; then
  export CONTROL_API_BASE_URL="$CALLER_CONTROL_API_BASE_URL"
fi
if [[ -n "$CALLER_CONTROL_API_URL" ]]; then
  export CONTROL_API_URL="$CALLER_CONTROL_API_URL"
fi
if [[ -n "$CALLER_E2E_CONTROL_API_URL" ]]; then
  export E2E_CONTROL_API_URL="$CALLER_E2E_CONTROL_API_URL"
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
if [[ -n "$CALLER_EXTERNAL_REST_API_URL" ]]; then
  export EXTERNAL_REST_API_URL="$CALLER_EXTERNAL_REST_API_URL"
fi
if [[ -n "$CALLER_E2E_EXTERNAL_REST_API_URL" ]]; then
  export E2E_EXTERNAL_REST_API_URL="$CALLER_E2E_EXTERNAL_REST_API_URL"
fi
if [[ -n "$CALLER_RPC_PROXY_BASE_URL" ]]; then
  export RPC_PROXY_BASE_URL="$CALLER_RPC_PROXY_BASE_URL"
fi
if [[ -n "$CALLER_RPC_PROXY_URL" ]]; then
  export RPC_PROXY_URL="$CALLER_RPC_PROXY_URL"
fi
if [[ -n "$CALLER_E2E_RPC_PROXY_URL" ]]; then
  export E2E_RPC_PROXY_URL="$CALLER_E2E_RPC_PROXY_URL"
fi
if [[ -n "$CALLER_WORKFLOW_APPROVAL_READER_BASE_URL" ]]; then
  export WORKFLOW_APPROVAL_READER_BASE_URL="$CALLER_WORKFLOW_APPROVAL_READER_BASE_URL"
fi
if [[ -n "$CALLER_WORKFLOW_APPROVAL_READER_URL" ]]; then
  export WORKFLOW_APPROVAL_READER_URL="$CALLER_WORKFLOW_APPROVAL_READER_URL"
fi
if [[ -n "$CALLER_MCP_HOST_RUNTIME_BASE_URL" ]]; then
  export MCP_HOST_RUNTIME_BASE_URL="$CALLER_MCP_HOST_RUNTIME_BASE_URL"
fi
if [[ -n "$CALLER_MCP_HOST_RUNTIME_URL" ]]; then
  export MCP_HOST_RUNTIME_URL="$CALLER_MCP_HOST_RUNTIME_URL"
fi
if [[ -n "$CALLER_MCP_HOST_BASE_URL" ]]; then
  export MCP_HOST_BASE_URL="$CALLER_MCP_HOST_BASE_URL"
fi

DEFAULT_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
DEFAULT_CONTEXT="${DEFAULT_CONTEXT:-clerum-test}"
KCTX="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-$DEFAULT_CONTEXT}}"

# Preflight: ensure Airtable MCP is deployed + allowlisted in context1
KUBECONTEXT="$KCTX" AIRTABLE_API_KEY="${AIRTABLE_API_KEY:-}" \
  bash "$HERE/playwright-preflight-dev.sh"

export CONTROL_API_BASE_URL="${CONTROL_API_BASE_URL:-${CONTROL_API_URL:-${E2E_CONTROL_API_URL:-http://127.0.0.1:8090}}}"
export CONTROL_UI_BASE_URL="${CONTROL_UI_BASE_URL:-${CONTROL_UI_URL:-http://127.0.0.1:3000}}"
export EXTERNAL_REST_API_BASE_URL="${EXTERNAL_REST_API_BASE_URL:-${EXTERNAL_REST_API_URL:-${E2E_EXTERNAL_REST_API_URL:-http://127.0.0.1:8091}}}"
export E2E_EXTERNAL_REST_API_URL="${E2E_EXTERNAL_REST_API_URL:-$EXTERNAL_REST_API_BASE_URL}"
export RPC_PROXY_BASE_URL="${RPC_PROXY_BASE_URL:-${RPC_PROXY_URL:-${E2E_RPC_PROXY_URL:-http://127.0.0.1:8094}}}"
export E2E_RPC_PROXY_URL="${E2E_RPC_PROXY_URL:-$RPC_PROXY_BASE_URL}"
export WORKFLOW_APPROVAL_READER_BASE_URL="${WORKFLOW_APPROVAL_READER_BASE_URL:-${WORKFLOW_APPROVAL_READER_URL:-http://127.0.0.1:8098}}"
export MCP_HOST_RUNTIME_BASE_URL="${MCP_HOST_RUNTIME_BASE_URL:-${MCP_HOST_RUNTIME_URL:-${MCP_HOST_BASE_URL:-http://127.0.0.1:8080}}}"
export MCP_HOST_BASE_URL="${MCP_HOST_BASE_URL:-$MCP_HOST_RUNTIME_BASE_URL}"
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
    echo "  $name=$url uses shared default port $default_port, which can point at stale clerum-test/example-dev forwards." >&2
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
