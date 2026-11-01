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
# A fresh database has no hand-seeded allowlist: its rows come only from
# control-api's catalog sync (models.dev). So setup first waits for that sync,
# then classifies the Host model, and full-setup's step 10 adds or enables it
# through the admin API when the catalog did not (scripts/e2e/llm-model-ensure.sh).
# The hard proof runs after that step.
#
# Usage (library):
#   source scripts/minikube/host-model.sh
#   resolve_host_model || exit 1              # sets RESOLVED_PROVIDER/MODEL
#   wait_for_catalog_decision || exit 1       # sets CATALOG_DECISION
#   host_model_state "$RESOLVED_PROVIDER" "$RESOLVED_MODEL" || exit 1   # sets HOST_MODEL_STATE
#   assert_host_model_allowed "$RESOLVED_PROVIDER" "$RESOLVED_MODEL" || exit 1
# ======================================================================

# The catalog rule shared with the seed (llm_catalog_sync_source).
# shellcheck source=scripts/minikube/llm-catalog-runs.sh
source "$(dirname "${BASH_SOURCE[0]}")/llm-catalog-runs.sh"

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

# Sets HOST_MODEL_STATE to the llm_allowed_models state of (provider, model) in
# the profile's control-postgres: `enabled`, `disabled`, or `unknown` (no row).
# It sets a variable rather than printing because err/warn write to stdout,
# which a $(...) capture would swallow. Needs KC (the
# kubectl command with the profile's --context). Only `enabled` is read: `stale`
# is a soft quarantine that leaves a model usable (control-api
# llmAllowedModels.ts).
#
# The values travel as psql variables and the SQL reads them as :'provider'
# and :'model', so neither is ever interpolated into SQL text.
#
# Returns 1, after an err line with HOST_MODEL_CHECK_FAILED, when the query
# cannot run or answers something else.
host_model_state() {
  local provider="${1:-}" model="${2:-}" answer
  HOST_MODEL_STATE=""
  if [ -z "$provider" ] || [ -z "$model" ]; then
    err "HOST_MODEL_CHECK_FAILED: the llm_allowed_models check needs a provider and a model (got '${provider}' / '${model}')."
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
    t)  HOST_MODEL_STATE=enabled ;;
    f)  HOST_MODEL_STATE=disabled ;;
    '') HOST_MODEL_STATE=unknown ;;
    *)
      err "HOST_MODEL_CHECK_FAILED: unexpected answer from llm_allowed_models for ${provider}/${model}: '$(printf '%s' "$answer" | tr '\n' ' ')'."
      return 1
      ;;
  esac
}

# Sets HOST_MODEL_DISMISSED to true when an operator removed (provider, model)
# from the allowlist (a row in llm_catalog_dismissed), else false. Read-only.
# Returns 1, after err HOST_MODEL_CHECK_FAILED, when the query cannot run.
host_model_dismissed() {
  local provider="${1:-}" model="${2:-}" answer
  HOST_MODEL_DISMISSED=""
  if [ -z "${KC:-}" ] || [ -z "$provider" ] || [ -z "$model" ]; then
    err "HOST_MODEL_CHECK_FAILED: the llm_catalog_dismissed check needs KC, a provider and a model (got '${provider}' / '${model}')."
    return 1
  fi
  # shellcheck disable=SC2086
  if ! answer="$($KC exec -i -n control-plane deployment/control-postgres -- \
    psql -U postgres -d profiles -v ON_ERROR_STOP=1 \
    -v "provider=${provider}" -v "model=${model}" -Atq -f - <<'SQL'
SELECT 't' FROM llm_catalog_dismissed
 WHERE provider = :'provider' AND model = :'model';
SQL
  )"; then
    err "HOST_MODEL_CHECK_FAILED: the llm_catalog_dismissed query for ${provider}/${model} failed in control-postgres (see the kubectl/psql error above)."
    return 1
  fi
  # Read by the caller (full-setup.sh 6f).
  # shellcheck disable=SC2034
  case "$answer" in
    t)  HOST_MODEL_DISMISSED=true ;;
    '') HOST_MODEL_DISMISSED=false ;;
    *)
      err "HOST_MODEL_CHECK_FAILED: unexpected answer from llm_catalog_dismissed for ${provider}/${model}: '$(printf '%s' "$answer" | tr '\n' ' ')'."
      return 1
      ;;
  esac
}

# Proves (provider, model) is an enabled row of llm_allowed_models before the
# Host may serve. Refusals (each an err line and a non-zero return):
#   HOST_MODEL_UNKNOWN       no row for the pair
#   HOST_MODEL_DISABLED      the row exists with enabled = false
#   HOST_MODEL_CHECK_FAILED  the query could not run or answered something else
assert_host_model_allowed() {
  local provider="${1:-}" model="${2:-}"
  host_model_state "$provider" "$model" || return 1
  case "$HOST_MODEL_STATE" in
    enabled)
      return 0
      ;;
    disabled)
      err "HOST_MODEL_DISABLED: ${provider}/${model} is in llm_allowed_models but disabled. Enable it in the Control UI (LLM models), or set CLERUM_MODEL_PROVIDER and CLERUM_MODEL_NAME to an enabled model."
      return 1
      ;;
    *)
      err "HOST_MODEL_UNKNOWN: ${provider}/${model} is not in llm_allowed_models. Add it in the Control UI (LLM models), or set CLERUM_MODEL_PROVIDER and CLERUM_MODEL_NAME in .env to a model that the catalog enables for that provider."
      return 1
      ;;
  esac
}

# Waits, read-only, for control-api's catalog sync to record a run in
# llm_catalog_sync_runs, and sets CATALOG_DECISION:
#   live      a run used the live models.dev catalog: eligible models of
#             providers whose auto-enable policy is on are enabled.
#   vendored  only the vendored snapshot was used by the deadline. Such a run
#             cannot decide, so it enables nothing for policy-on providers; the
#             cron keeps probing models.dev and decides once it is reachable.
#   none      no run was recorded by the deadline.
#
# A vendored-only run keeps the wait going: a retry may still reach models.dev
# before the deadline. Neither vendored nor none stops setup; each warns, and
# step 10 provisions the Host model through the admin API instead.
#
# CLERUM_CATALOG_WAIT_SECONDS bounds the wait (default 180; 0 probes once);
# CLERUM_CATALOG_WAIT_INTERVAL_SECONDS is the gap between probes (default 5).
# Returns 1, after err CATALOG_WAIT_CHECK_FAILED, when the query cannot run:
# the same control-postgres channel the Host model check needs.
wait_for_catalog_decision() {
  local timeout="${CLERUM_CATALOG_WAIT_SECONDS:-180}"
  local interval="${CLERUM_CATALOG_WAIT_INTERVAL_SECONDS:-5}"
  local attempts attempt=1 answer
  CATALOG_DECISION=none
  case "$timeout" in ''|*[!0-9]*)
    err "CATALOG_WAIT_CHECK_FAILED: CLERUM_CATALOG_WAIT_SECONDS must be a whole number of seconds (got '${timeout}')."
    return 1 ;;
  esac
  case "$interval" in ''|*[!0-9]*|0)
    err "CATALOG_WAIT_CHECK_FAILED: CLERUM_CATALOG_WAIT_INTERVAL_SECONDS must be a positive whole number (got '${interval}')."
    return 1 ;;
  esac
  if [ -z "${KC:-}" ]; then
    err "CATALOG_WAIT_CHECK_FAILED: KC is not set, so the profile's control-postgres cannot be queried for llm_catalog_sync_runs."
    return 1
  fi
  attempts=$((timeout / interval + 1))
  while :; do
    if ! answer="$(llm_catalog_sync_source)"; then
      err "CATALOG_WAIT_CHECK_FAILED: the llm_catalog_sync_runs query failed in control-postgres (see the kubectl/psql error above)."
      return 1
    fi
    case "$answer" in
      live)     CATALOG_DECISION=live; return 0 ;;
      vendored) CATALOG_DECISION=vendored ;;
      '')       : ;;
      *)
        err "CATALOG_WAIT_CHECK_FAILED: unexpected answer from llm_catalog_sync_runs: '$(printf '%s' "$answer" | tr '\n' ' ')'."
        return 1
        ;;
    esac
    [ "$attempt" -ge "$attempts" ] && break
    attempt=$((attempt + 1))
    sleep "$interval"
  done
  if [ "$CATALOG_DECISION" = vendored ]; then
    warn "CATALOG_SYNC_VENDORED_ONLY: within ${timeout}s control-api synced only the vendored models.dev snapshot, which enables nothing for providers whose auto-enable policy is on. Setup needs egress to models.dev (or MODELS_DEV_API_URL pointing at a reachable mirror); an air-gapped install stays like this by design and its models are added by hand."
  else
    warn "CATALOG_SYNC_PENDING: control-api recorded no LLM catalog sync run within ${timeout}s (raise CLERUM_CATALOG_WAIT_SECONDS, or check control-api's llm_catalog_boot_sync logs). Without egress to models.dev, or with MODELS_DEV_API_URL unreachable, no model is auto-enabled."
  fi
  return 0
}
