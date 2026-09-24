#!/usr/bin/env bash
# ======================================================================
# Which model the minikube chatllm Host runs, and proof that it may
# ======================================================================
#
# Sourced library, shared by scripts/minikube/full-setup.sh (step 6f) and
# scripts/bootstrap-cluster.sh. It defines functions only: it sets no shell
# options and reports through the caller's err/warn functions.
#
# The rule (docs/llm-providers/README.md):
#   - CLERUM_MODEL_PROVIDER and CLERUM_MODEL_NAME set  -> used as given.
#   - CLERUM_MODEL_PROVIDER only                        -> that provider's
#     default model.
#   - CLERUM_MODEL_NAME without CLERUM_MODEL_PROVIDER   -> refused. The name
#     belongs to one provider, and pairing it with whichever key happens to be
#     present is how openai/glm-4.7 reached a Host and failed on its first
#     message.
#   - neither -> the provider of the first key present, in the order
#     OPENAI_API_KEY, CLAUDE_API_KEY, ZAI_API_KEY, BAILIAN_API_KEY, with its
#     default model. With no key at all: openai/gpt-5.4-mini, with a warning
#     that the agent will not reply until a key is added.
#
# Usage (library):
#   source scripts/minikube/host-model.sh
#   resolve_host_model || exit 1              # sets RESOLVED_PROVIDER/MODEL
#   assert_host_model_allowed "$RESOLVED_PROVIDER" "$RESOLVED_MODEL" || exit 1
# ======================================================================

# The provider named by CLERUM_MODEL_PROVIDER, else the provider of the first
# key present. Prints nothing when neither exists.
resolve_model_provider() {
  if [ -n "${CLERUM_MODEL_PROVIDER:-}" ]; then
    printf '%s' "${CLERUM_MODEL_PROVIDER}"
    return 0
  fi
  if [ -n "${OPENAI_API_KEY:-}" ];  then printf 'openai';  return 0; fi
  if [ -n "${CLAUDE_API_KEY:-}" ];  then printf 'claude';  return 0; fi
  if [ -n "${ZAI_API_KEY:-}" ];     then printf 'zai';     return 0; fi
  if [ -n "${BAILIAN_API_KEY:-}" ]; then printf 'bailian'; return 0; fi
  printf ''
}

# These MUST equal the defaultModel values in mcp-host/src/llm/registryCore.ts,
# the single source of truth mcp-host reads through
# descriptorFor(provider).defaultModel. scripts/tests/test-minikube-host-model.sh
# (H11) reads that file and fails on any drift.
default_model_for_provider() {
  case "$1" in
    openai)  printf 'gpt-5.4-mini' ;;
    claude)  printf 'claude-sonnet-4-6' ;;
    zai)     printf 'glm-5.1' ;;
    bailian) printf 'qwen3-coder-plus' ;;
    *)       printf '' ;;
  esac
}

# Sets RESOLVED_PROVIDER and RESOLVED_MODEL from the environment by the rule in
# the header. Returns 1, after err, when the pair cannot be resolved.
resolve_host_model() {
  RESOLVED_PROVIDER=""
  RESOLVED_MODEL=""
  if [ -n "${CLERUM_MODEL_NAME:-}" ] && [ -z "${CLERUM_MODEL_PROVIDER:-}" ]; then
    err "CLERUM_MODEL_NAME='${CLERUM_MODEL_NAME}' is set without CLERUM_MODEL_PROVIDER. A model name belongs to one provider: set CLERUM_MODEL_PROVIDER in .env, or remove CLERUM_MODEL_NAME to use the detected provider's default model."
    return 1
  fi

  RESOLVED_PROVIDER="$(resolve_model_provider)"
  if [ -z "$RESOLVED_PROVIDER" ]; then
    warn "No LLM API key found in .env (OPENAI_API_KEY / CLAUDE_API_KEY / ZAI_API_KEY / BAILIAN_API_KEY)."
    warn "Defaulting Host to openai with a placeholder key — the chatllm agent will NOT reply."
    warn "Set a key in .env and re-run to fix."
    RESOLVED_PROVIDER="openai"
  fi

  if [ -n "${CLERUM_MODEL_NAME:-}" ]; then
    RESOLVED_MODEL="${CLERUM_MODEL_NAME}"
  else
    RESOLVED_MODEL="$(default_model_for_provider "$RESOLVED_PROVIDER")"
  fi
  if [ -z "$RESOLVED_MODEL" ]; then
    err "Provider '${RESOLVED_PROVIDER}' has no default model here — set CLERUM_MODEL_NAME explicitly in .env."
    return 1
  fi
  return 0
}

# Proves (provider, model) is an enabled row of llm_allowed_models in the
# profile's control-postgres before the Host is applied. Needs KC (the kubectl
# command with the profile's --context). Only `enabled` is read: `stale` is a
# soft quarantine that leaves a model usable (control-api llmAllowedModels.ts).
#
# The values travel as psql variables and the SQL reads them as :'provider'
# and :'model', so neither is ever interpolated into SQL text.
#
# Refusals (each an err line and a non-zero return):
#   HOST_MODEL_UNKNOWN       no row for the pair
#   HOST_MODEL_DISABLED      the row exists with enabled = false
#   HOST_MODEL_CHECK_FAILED  the query could not run or answered something else
assert_host_model_allowed() {
  local provider="${1:-}" model="${2:-}" answer
  if [ -z "$provider" ] || [ -z "$model" ]; then
    err "HOST_MODEL_CHECK_FAILED: assert_host_model_allowed needs a provider and a model (got '${provider}' / '${model}')."
    return 1
  fi
  if [ -z "${KC:-}" ]; then
    err "HOST_MODEL_CHECK_FAILED: KC is not set, so the profile's control-postgres cannot be queried for ${provider}/${model}."
    return 1
  fi
  # $KC is a command plus its --context flag and must split into words.
  # shellcheck disable=SC2086
  if ! answer="$($KC exec -i -n control-plane deployment/control-postgres -- \
    psql -U postgres -d profiles -v ON_ERROR_STOP=1 \
    -v "provider=${provider}" -v "model=${model}" -Atq -f - <<'SQL'
SELECT enabled FROM llm_allowed_models
 WHERE provider = :'provider' AND model = :'model';
SQL
  )"; then
    err "HOST_MODEL_CHECK_FAILED: the llm_allowed_models query for ${provider}/${model} failed in control-postgres (see the kubectl/psql error above)."
    return 1
  fi
  case "$answer" in
    t)
      return 0
      ;;
    f)
      err "HOST_MODEL_DISABLED: ${provider}/${model} is in llm_allowed_models but disabled. Enable it in the Control UI, or set CLERUM_MODEL_PROVIDER and CLERUM_MODEL_NAME to an enabled model."
      return 1
      ;;
    '')
      err "HOST_MODEL_UNKNOWN: ${provider}/${model} is not in llm_allowed_models. Set CLERUM_MODEL_PROVIDER and CLERUM_MODEL_NAME in .env to a model that catalog enables for that provider."
      return 1
      ;;
    *)
      err "HOST_MODEL_CHECK_FAILED: unexpected answer from llm_allowed_models for ${provider}/${model}: '$(printf '%s' "$answer" | tr '\n' ' ')'."
      return 1
      ;;
  esac
}
