#!/usr/bin/env bash
# ======================================================================
# Apply the chatllm-api-keys LLM Secret (all 21 providers)
# ======================================================================
#
# Builds the `chatllm-api-keys` Secret (namespace: mcp-host) from whatever
# LLM keys are present in .env, across ALL providers in the registry
# (packages/llm-providers/index.cjs → PROVIDER_CREDENTIAL_SLOTS), not just
# the four original ones. mcp-host reads only the slot(s) for the selected
# CLERUM_MODEL_PROVIDER, so extra keys are harmless; the point is that
# setting e.g. GROQ_API_KEY or MISTRAL_API_KEY in .env now actually reaches
# the cluster.
#
# Backward compatible: the four original providers (openai/claude/zai/
# bailian) keep their test-placeholder fallbacks so an empty .env (CI, first
# boot) still stands up the default `zai` agent. Real values override the
# placeholders; the other 17 providers appear only when their key is set.
#
# The Secret stores keys in the registry `dataKey` form (lowercase-hyphen,
# e.g. `openai-api-key`), which is what mcp-host's LLM-secret watch expects.
#
# Usage:
#   CONTEXT=clerum-test ./scripts/minikube/apply-llm-secret.sh
#
# Env:
#   CONTEXT   kubectl context / minikube profile (default: clerum-test)
# ======================================================================

set -euo pipefail

CONTEXT="${CONTEXT:-clerum-test}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

# ── Resolve .env — read the MAIN checkout's .env when run from a worktree ──
# LLM_SECRET_ENV_FILE overrides resolution entirely (used by tests so they never
# touch the working-tree .env).
ENV_FILE="${LLM_SECRET_ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
  GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$GIT_COMMON_DIR" ]; then
    case "$GIT_COMMON_DIR" in
      /*) GIT_COMMON_ABS="$GIT_COMMON_DIR" ;;
      *)  GIT_COMMON_ABS="$(cd "$GIT_COMMON_DIR" && pwd)" ;;
    esac
    MAIN_REPO_DIR="$(cd "$GIT_COMMON_ABS/.." && pwd)"
    if [ -f "$MAIN_REPO_DIR/.env" ]; then ENV_FILE="$MAIN_REPO_DIR/.env"; fi
  fi
  if [ -z "$ENV_FILE" ] && [ -f .env ]; then ENV_FILE=".env"; fi
fi
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

# ── Provider credential slots ─────────────────────────────────────────
# One row per credential slot, mirrored from PROVIDER_CREDENTIAL_SLOTS in
# packages/llm-providers/index.cjs. Format: "<dataKey>|<ENV_NAME>|<placeholder>"
# Only the four original providers carry a placeholder (empty-.env fallback);
# every other slot is emitted ONLY when its env var is set. Keep in sync with
# the registry when providers/slots are added.
SLOTS=(
  "openai-api-key|OPENAI_API_KEY|sk-test-placeholder-openai-key-00000000000000000000"
  "claude-api-key|CLAUDE_API_KEY|sk-ant-api03-test-placeholder-claude-key-000000000000000000000000000000000000000000000000000000"
  "zai-api-key|ZAI_API_KEY|zai-test-placeholder-zai-key-00000000000000000000"
  "bailian-api-key|BAILIAN_API_KEY|sk-test-placeholder-bailian-key-00000000000000000000"
  "vertex-service-account-json|VERTEX_SERVICE_ACCOUNT_JSON|"
  "aws-access-key-id|AWS_ACCESS_KEY_ID|"
  "aws-secret-access-key|AWS_SECRET_ACCESS_KEY|"
  "openrouter-api-key|OPENROUTER_API_KEY|"
  "gemini-api-key|GEMINI_API_KEY|"
  "deepseek-api-key|DEEPSEEK_API_KEY|"
  "groq-api-key|GROQ_API_KEY|"
  "together-api-key|TOGETHER_API_KEY|"
  "fireworks-api-key|FIREWORKS_API_KEY|"
  "mistral-api-key|MISTRAL_API_KEY|"
  "xai-api-key|XAI_API_KEY|"
  "cerebras-api-key|CEREBRAS_API_KEY|"
  "deepinfra-api-key|DEEPINFRA_API_KEY|"
  "perplexity-api-key|PERPLEXITY_API_KEY|"
  "moonshot-api-key|MOONSHOT_API_KEY|"
  "nebius-api-key|NEBIUS_API_KEY|"
  "novita-api-key|NOVITA_API_KEY|"
  "azure-openai-api-key|AZURE_OPENAI_API_KEY|"
)

# ── Build kubectl args; each dataKey is emitted at most once (no dup keys) ──
ARGS=()
REAL_KEYS=()
for slot in "${SLOTS[@]}"; do
  data_key="${slot%%|*}"
  rest="${slot#*|}"
  env_name="${rest%%|*}"
  placeholder="${rest#*|}"
  # Indirect expansion (bash 3.2-safe): value of the env var named $env_name.
  value="${!env_name:-}"
  if [ -n "$value" ]; then
    ARGS+=( "--from-literal=${data_key}=${value}" )
    REAL_KEYS+=( "$env_name" )
  elif [ -n "$placeholder" ]; then
    ARGS+=( "--from-literal=${data_key}=${placeholder}" )
  fi
done

kubectl --context="$CONTEXT" create secret generic chatllm-api-keys \
  --namespace=mcp-host \
  "${ARGS[@]}" \
  --dry-run=client -o yaml | kubectl --context="$CONTEXT" apply -f -

if [ "${#REAL_KEYS[@]}" -gt 0 ]; then
  echo "  LLM API keys applied — real keys from .env: ${REAL_KEYS[*]} (provider: ${CLERUM_MODEL_PROVIDER:-zai})"
else
  echo "  LLM API keys applied — no keys in .env; using test placeholders (provider: ${CLERUM_MODEL_PROVIDER:-zai})"
fi
