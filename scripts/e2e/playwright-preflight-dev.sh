#!/usr/bin/env bash
# Prepares the selected cluster for Desktop App Playwright Airtable E2E.
# Idempotent: safe to re-run.
#
# Steps:
#  1. Apply Airtable McpServer CRD — HCC auto-creates Deployment + Service
#  2. Require a real Airtable credential Secret (no placeholders)
#  3. Patch context1.spec.mcpServers[] to include airtable-server
#  4. Wait for Deployment Available
set -eo pipefail

DEFAULT_CONTEXT="$(
  kubectl config current-context 2>/dev/null || true
)"
if [[ -z "$DEFAULT_CONTEXT" ]]; then
  DEFAULT_CONTEXT="clerum-test"
fi
KCTX="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-$DEFAULT_CONTEXT}}"
MCP_NS="mcp-server"
SERVER_NAME="airtable-server"
CONTEXT_NAME="context1"
SECRET_NAME="mcp-airtable-credentials"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_YAML=""
SECRET_UPDATED=0
CONTEXT_UPDATED=0

log() { echo "[preflight] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Load .env from the current checkout, or from the main repo when running from
# a git worktree (.claude/worktrees/*) where the secret file is shared only in
# the common checkout.
ENV_FILE=""
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_FILE="$REPO_ROOT/.env"
else
  GIT_COMMON_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null || echo "")"
  if [[ -n "$GIT_COMMON_DIR" ]]; then
    case "$GIT_COMMON_DIR" in
      /*) MAIN_REPO_DIR="$(cd "${GIT_COMMON_DIR}/.." && pwd)" ;;
      *)  MAIN_REPO_DIR="$(cd "${REPO_ROOT}/${GIT_COMMON_DIR}/.." && pwd)" ;;
    esac
    if [[ -f "${MAIN_REPO_DIR}/.env" ]]; then
      ENV_FILE="${MAIN_REPO_DIR}/.env"
    fi
  fi
fi

if [[ -n "$ENV_FILE" ]]; then
  log "Loading .env from $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Use the minikube/local manifest for clerum-test and similar local contexts so
# Desktop E2E exercises the same image/build path as the local cluster.
case "$KCTX" in
  clerum-test|clerum-*|minikube*|docker-desktop*)
    MCP_YAML="$REPO_ROOT/deploy/overlays/minikube/instances/airtable-server.yaml"
    ;;
  *)
    MCP_YAML="$REPO_ROOT/mcp-servers/airtable/mcpserver.yaml"
    ;;
esac

if [[ ! -f "$MCP_YAML" ]]; then
  die "McpServer manifest not found at $MCP_YAML"
fi

# ── 1. McpServer CRD ─────────────────────────────────────────────────────
log "Applying $SERVER_NAME McpServer (context=$KCTX)"
kubectl --context "$KCTX" apply -f "$MCP_YAML"

# ── 2. Secret — require a real Airtable API key ──────────────────────────
# Desktop Airtable E2E is intended to validate real MCP connectivity, not a
# placeholder deployment that later fails with 401/"fetch failed".
if [[ -n "${AIRTABLE_API_KEY:-}" ]]; then
  current_secret_value="$(
    kubectl --context "$KCTX" -n "$MCP_NS" get secret "$SECRET_NAME" \
      -o jsonpath='{.data.api-key}' 2>/dev/null | base64 -d 2>/dev/null || true
  )"
  if [[ "$current_secret_value" == "$AIRTABLE_API_KEY" ]]; then
    log "Secret $SECRET_NAME already matches env key — leaving untouched"
  else
    log "Upserting Secret $SECRET_NAME with real api-key from env"
    kubectl --context "$KCTX" -n "$MCP_NS" create secret generic "$SECRET_NAME" \
      --from-literal=api-key="$AIRTABLE_API_KEY" \
      --dry-run=client -o yaml | kubectl --context "$KCTX" -n "$MCP_NS" apply -f - >/dev/null
    SECRET_UPDATED=1
    # Secret changes do not auto-propagate to env-from-secret references, so
    # restart the Airtable server only when the credential actually changed.
    if kubectl --context "$KCTX" -n "$MCP_NS" get deployment "$SERVER_NAME" >/dev/null 2>&1; then
      kubectl --context "$KCTX" -n "$MCP_NS" rollout restart deployment/"$SERVER_NAME" >/dev/null
    fi
  fi
else
  if ! kubectl --context "$KCTX" -n "$MCP_NS" get secret "$SECRET_NAME" >/dev/null 2>&1; then
    die "$SECRET_NAME is missing in $MCP_NS. Export AIRTABLE_API_KEY or create mcp-servers/airtable/secret.yaml before running Desktop Airtable E2E."
  fi

  secret_value="$(
    kubectl --context "$KCTX" -n "$MCP_NS" get secret "$SECRET_NAME" \
      -o jsonpath='{.data.api-key}' 2>/dev/null | base64 -d 2>/dev/null || true
  )"
  if [[ -z "$secret_value" ]]; then
    die "$SECRET_NAME exists but key api-key is empty or unreadable."
  fi

  case "$secret_value" in
    placeholder-airtable-api-key-for-e2e|e2e-placeholder-*|pattest*)
      die "$SECRET_NAME contains a placeholder Airtable key. Desktop Airtable E2E requires a real credential, not a dummy seed."
      ;;
  esac

  log "Secret $SECRET_NAME already exists with a non-placeholder key — leaving untouched"
fi

# ── 3. Patch Context allowlist (idempotent JSON-patch) ───────────────────
CURRENT_LIST=$(kubectl --context "$KCTX" -n "$MCP_NS" get context "$CONTEXT_NAME" \
  -o jsonpath='{.spec.mcpServers}' 2>/dev/null || echo "[]")
if echo "$CURRENT_LIST" | grep -q "\"$SERVER_NAME\""; then
  log "$SERVER_NAME already in $CONTEXT_NAME.spec.mcpServers"
else
  # If mcpServers is null/missing, use "replace" with empty array semantics via "add"
  # with path /spec/mcpServers. If it's already an array, append via /-.
  if [[ "$CURRENT_LIST" == "" || "$CURRENT_LIST" == "[]" ]]; then
    log "Setting $CONTEXT_NAME.spec.mcpServers = [$SERVER_NAME]"
    kubectl --context "$KCTX" -n "$MCP_NS" patch context "$CONTEXT_NAME" \
      --type=json \
      -p="[{\"op\":\"replace\",\"path\":\"/spec/mcpServers\",\"value\":[\"$SERVER_NAME\"]}]"
  else
    log "Appending $SERVER_NAME to $CONTEXT_NAME.spec.mcpServers"
    kubectl --context "$KCTX" -n "$MCP_NS" patch context "$CONTEXT_NAME" \
      --type=json \
      -p="[{\"op\":\"add\",\"path\":\"/spec/mcpServers/-\",\"value\":\"$SERVER_NAME\"}]"
  fi
  CONTEXT_UPDATED=1
fi

# ── 4. Wait for HCC reconcile (Deployment Available) ─────────────────────
log "Waiting for Deployment $SERVER_NAME to become Available (up to 120s)..."
kubectl --context "$KCTX" -n "$MCP_NS" wait --for=condition=Available \
  deployment/"$SERVER_NAME" --timeout=120s >/dev/null
log "Deployment $SERVER_NAME is Available"

# ── 5. Reconcile mcp-host so it picks up the new allowlisted server ──────
if (( SECRET_UPDATED || CONTEXT_UPDATED )); then
  log "Restarting chatllm (mcp-host) to reconcile updated Airtable access..."
  kubectl --context "$KCTX" -n mcp-host rollout restart deployment/chatllm 2>&1 | head -1 || true
  kubectl --context "$KCTX" -n mcp-host rollout status deployment/chatllm --timeout=90s 2>&1 | tail -1 || true
else
  log "chatllm restart not required — Airtable secret and allowlist are already current"
fi

log "Preflight complete"
