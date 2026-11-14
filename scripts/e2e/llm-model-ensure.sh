#!/usr/bin/env bash
# ======================================================================
# Make sure the LLM models setup depends on are enabled, through the admin API
# ======================================================================
#
# Sourced library for scripts/e2e/seed-e2e-data.sh. It defines functions only
# and sets no shell options.
#
# A fresh control DB has no hand-seeded allowlist: its rows come only from
# control-api's models.dev catalog sync. Some models that setup and the E2E
# lanes use are not in that catalog (no row), and some enter disabled because
# models.dev marks them deprecated or their provider's auto-enable policy is
# off. On minikube the seed closes that gap with the admin session it already
# holds:
#
#   no row          POST /admin/llm-models {provider, model, enabled:true}
#                   (a manual row; on a reused DB, not when an operator deleted
#                   the pair, which leaves a row in llm_catalog_dismissed)
#   POST 409        someone inserted it meanwhile (the catalog sync): re-read
#                   and handle the row
#   row disabled    PUT /admin/llm-models/:id {enabled:true}, but only when this
#                   setup run created the DB (LLM_ENSURE_DB_FRESH=true), or the
#                   row appeared during this run (the catalog sync inserted it
#                   after our first read). Otherwise the disable may be an
#                   operator's: warn instead
#   row enabled     nothing
#
# Before the first POST the seed checks that the catalog sync has used the live
# catalog, waiting a little if setup did not already see it: a row created
# before that stays manual (no catalog price or lifecycle status), even when
# models.dev lists the model.
#
# Every write goes through the API, never psql, so it is audited and the
# clerum-llm-allowed-models ConfigMap is re-materialized. A manual row has no
# catalog price, so cost budgets do not limit it until it is priced.
#
# One line per pair on stdout:  LLM_MODEL_ENSURED <outcome> <provider>/<model>
# with outcome created | enabled | present | skipped-reuse.
#
# The caller supplies: CAPI_BASE (control-api base URL, ending in /api/v1),
# AUTH_CURL (curl arguments carrying the admin session), CONTEXT, KC,
# CONTROL_API_NS, is_minikube_context, and log/warn.
#
# Environment read:
#   LLM_ENSURE_MINIKUBE_PROFILE  the minikube profile full-setup.sh is running;
#                           the ensure runs when it equals CONTEXT. Without it,
#                           only names is_minikube_context recognizes qualify
#   LLM_ENSURE_CATALOG_DECISION  what setup's catalog wait saw (live | vendored
#                           | none); live skips the seed's own check
#   LLM_ENSURE_CATALOG_WAIT_SECONDS  bound of that check (default 60)
#   LLM_ENSURE_DB_FRESH     true when this setup run created the control DB
#                           (default false: never re-enable a disabled row)
#   LLM_ENSURE_HOST_MODEL   provider/model of the Host, set by full-setup.sh
#   LLM_ENSURE_MANIFEST     pairs file for the e2e profile
#                           (default scripts/e2e/e2e-llm-models.txt)
#   E2E_WORKFLOW_MODEL_PROVIDER, E2E_WORKFLOW_MODEL_NAME
#                           ensured too under the e2e profile when both are set
# ======================================================================

LLM_ENSURE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The catalog rule shared with setup's 6f wait (llm_catalog_sync_source).
# shellcheck source=scripts/minikube/llm-catalog-runs.sh
source "${LLM_ENSURE_LIB_DIR}/../minikube/llm-catalog-runs.sh"

llm_ensure_err() { printf '  ERROR — %s\n' "$*" >&2; }

# Whether CONTEXT may receive LLM model writes. full-setup.sh only ever targets
# a minikube profile, so its explicit signal is trusted when it names the same
# context; a direct seed run falls back to the context-name check. The name
# check is deliberately not widened: it also guards non-setup callers.
llm_ensure_context_allowed() {
  if [ -n "${LLM_ENSURE_MINIKUBE_PROFILE:-}" ]; then
    [ "$LLM_ENSURE_MINIKUBE_PROFILE" = "${CONTEXT:-}" ]
    return
  fi
  declare -F is_minikube_context >/dev/null && is_minikube_context
}

# llm_ensure_request <METHOD> <path> [json-body]
# Sets LLM_ENSURE_CODE (000 when curl itself failed) and LLM_ENSURE_BODY.
llm_ensure_request() {
  local method="$1" path="$2" body="${3:-}" resp
  local args=(-sS --max-time "${LLM_ENSURE_HTTP_TIMEOUT_SECONDS:-30}" -w '\n%{http_code}'
    -X "$method" "${CAPI_BASE}${path}" "${AUTH_CURL[@]}")
  if [ -n "$body" ]; then args+=(-d "$body"); fi
  if ! resp="$(curl "${args[@]}")"; then
    LLM_ENSURE_CODE=000
    LLM_ENSURE_BODY=""
    return 0
  fi
  LLM_ENSURE_CODE="$(printf '%s\n' "$resp" | tail -n1)"
  LLM_ENSURE_BODY="$(printf '%s\n' "$resp" | sed '$d')"
}

# Only the error code of a failed response: its body is not echoed whole.
llm_ensure_error_code() {
  printf '%s' "$LLM_ENSURE_BODY" | jq -r '.error // empty' 2>/dev/null || true
}

llm_ensure_fail() {
  local what="$1" pair="$2" code
  code="$(llm_ensure_error_code)"
  llm_ensure_err "LLM_MODEL_ENSURE_FAILED: ${what} for ${pair} → HTTP ${LLM_ENSURE_CODE}${code:+ (${code})}"
  return 1
}

# llm_ensure_lookup <provider> <model>
# Sets LLM_ENSURE_ROW_ID and LLM_ENSURE_ROW_ENABLED (true | false | empty when
# there is no row).
llm_ensure_lookup() {
  local provider="$1" model="$2" row
  LLM_ENSURE_ROW_ID=""
  LLM_ENSURE_ROW_ENABLED=""
  llm_ensure_request GET /admin/llm-models
  if [ "$LLM_ENSURE_CODE" != 200 ]; then
    llm_ensure_fail "GET /admin/llm-models" "${provider}/${model}"
    return 1
  fi
  # `//` would read enabled:false as absent, so `has` decides instead.
  if ! row="$(printf '%s' "$LLM_ENSURE_BODY" | jq -er --arg p "$provider" --arg m "$model" \
      '[.rows[] | select(.provider == $p and .model == $m)] | first // {}
       | "\(.id // "")\t\(if has("enabled") then (.enabled | tostring) else "" end)"')"; then
    llm_ensure_err "LLM_MODEL_ENSURE_FAILED: GET /admin/llm-models answered 200 without a rows list"
    return 1
  fi
  LLM_ENSURE_ROW_ID="${row%%$'\t'*}"
  LLM_ENSURE_ROW_ENABLED="${row#*$'\t'}"
}

# Whether an operator removed the pair (read-only). Prints t or nothing.
llm_ensure_pair_dismissed() {
  local provider="$1" model="$2"
  # $KC is a command plus its --context flag and must split into words.
  # shellcheck disable=SC2086
  $KC -n "${CONTROL_API_NS:-control-plane}" exec -i deploy/control-postgres -- \
    psql -U postgres -d profiles -v ON_ERROR_STOP=1 \
    -v "provider=${provider}" -v "model=${model}" -Atq -f - <<'SQL'
SELECT 't' FROM llm_catalog_dismissed
 WHERE provider = :'provider' AND model = :'model';
SQL
}

llm_ensure_report() { printf 'LLM_MODEL_ENSURED %s %s\n' "$1" "$2"; }

# Run once per seed, before the first POST. Sets LLM_ENSURE_CATALOG_STATE to
# live or undecided, and LLM_ENSURE_CATALOG_WAITED=true when it had to poll
# (rows may have appeared meanwhile). Uses the same rule as setup's 6f wait: a
# live run exists. Returns 1 when llm_catalog_sync_runs cannot be read.
llm_ensure_catalog_check() {
  local timeout="${LLM_ENSURE_CATALOG_WAIT_SECONDS:-60}"
  local interval="${LLM_ENSURE_CATALOG_WAIT_INTERVAL_SECONDS:-5}"
  local attempts attempt=1 source
  LLM_ENSURE_CATALOG_WAITED=false
  if [ -n "${LLM_ENSURE_CATALOG_STATE:-}" ]; then return 0; fi
  if [ "${LLM_ENSURE_CATALOG_DECISION:-}" = live ]; then
    LLM_ENSURE_CATALOG_STATE=live
    return 0
  fi
  case "$timeout" in ''|*[!0-9]*) timeout=60 ;; esac
  case "$interval" in ''|*[!0-9]*|0) interval=5 ;; esac
  attempts=$((timeout / interval + 1))
  while :; do
    if ! source="$(llm_catalog_sync_source)"; then
      llm_ensure_err "LLM_MODEL_ENSURE_FAILED: could not read llm_catalog_sync_runs for the catalog check"
      return 1
    fi
    if [ "$source" = live ]; then
      LLM_ENSURE_CATALOG_STATE=live
      return 0
    fi
    [ "$attempt" -ge "$attempts" ] && break
    attempt=$((attempt + 1))
    LLM_ENSURE_CATALOG_WAITED=true
    sleep "$interval"
  done
  LLM_ENSURE_CATALOG_STATE=undecided
  warn "LLM_MODEL_ENSURE_BEFORE_CATALOG: control-api has not synced the live models.dev catalog (runs so far: ${source:-none}), so the models setup adds now stay manual rows: no catalog price or lifecycle status, even for models models.dev lists. Price them under Cost → LLM prices if cost budgets must limit them."
  return 0
}

llm_ensure_skip_reuse() {
  local pair="$1" why="$2"
  warn "LLM_MODEL_ENSURE_SKIPPED_REUSE: ${pair} ${why} on a reused control DB, and setup leaves an operator's choice alone. Enable it in the Control UI (LLM models) if this profile needs it, or rebuild the DB (run setup without REUSE_DB)."
  llm_ensure_report skipped-reuse "$pair"
}

# ensure_llm_model_enabled <provider> <model>
ensure_llm_model_enabled() {
  local provider="${1:-}" model="${2:-}" pair dismissed body appeared_this_run=false
  pair="${provider}/${model}"
  if [ -z "$provider" ] || [ -z "$model" ]; then
    llm_ensure_err "LLM_MODEL_ENSURE_FAILED: a provider and a model are required (got '${pair}')"
    return 1
  fi
  if ! llm_ensure_context_allowed; then
    llm_ensure_err "LLM_MODEL_ENSURE_REFUSED: '${CONTEXT:-}' is not a minikube context (or not the profile setup is running); models are enabled by an admin there, never by a seed"
    return 1
  fi

  llm_ensure_lookup "$provider" "$model" || return 1
  if [ -z "$LLM_ENSURE_ROW_ID" ]; then
    llm_ensure_catalog_check || return 1
    if [ "$LLM_ENSURE_CATALOG_WAITED" = true ]; then
      # The sync may have inserted the pair while we waited.
      llm_ensure_lookup "$provider" "$model" || return 1
      if [ -n "$LLM_ENSURE_ROW_ID" ]; then appeared_this_run=true; fi
    fi
  fi
  if [ -z "$LLM_ENSURE_ROW_ID" ]; then
    if [ "${LLM_ENSURE_DB_FRESH:-false}" != true ]; then
      if ! dismissed="$(llm_ensure_pair_dismissed "$provider" "$model")"; then
        llm_ensure_err "LLM_MODEL_ENSURE_FAILED: could not read llm_catalog_dismissed for ${pair}"
        return 1
      fi
      if [ "$dismissed" = t ]; then
        llm_ensure_skip_reuse "$pair" "was removed by an operator"
        return 0
      fi
    fi
    body="$(jq -cn --arg p "$provider" --arg m "$model" '{provider: $p, model: $m, enabled: true}')"
    llm_ensure_request POST /admin/llm-models "$body"
    appeared_this_run=true
    case "$LLM_ENSURE_CODE" in
      201)
        llm_ensure_report created "$pair"
        return 0
        ;;
      409)
        llm_ensure_lookup "$provider" "$model" || return 1
        if [ -z "$LLM_ENSURE_ROW_ID" ]; then
          llm_ensure_fail "POST /admin/llm-models (409, and no row on re-read)" "$pair"
          return 1
        fi
        ;;
      *)
        llm_ensure_fail "POST /admin/llm-models" "$pair"
        return 1
        ;;
    esac
  fi

  if [ "$LLM_ENSURE_ROW_ENABLED" = true ]; then
    llm_ensure_report present "$pair"
    return 0
  fi
  if [ "$LLM_ENSURE_ROW_ENABLED" != false ]; then
    llm_ensure_err "LLM_MODEL_ENSURE_FAILED: row for ${pair} has enabled='${LLM_ENSURE_ROW_ENABLED}'"
    return 1
  fi
  # A row that appeared after our first read was written by the catalog sync
  # during this run, so it is not an operator's disable.
  if [ "${LLM_ENSURE_DB_FRESH:-false}" != true ] && [ "$appeared_this_run" != true ]; then
    llm_ensure_skip_reuse "$pair" "is disabled"
    return 0
  fi
  llm_ensure_request PUT "/admin/llm-models/${LLM_ENSURE_ROW_ID}" '{"enabled":true}'
  if [ "$LLM_ENSURE_CODE" != 200 ]; then
    llm_ensure_fail "PUT /admin/llm-models/:id" "$pair"
    return 1
  fi
  llm_ensure_report enabled "$pair"
}

# Prints the pairs this seed run must ensure, one provider/model per line,
# without duplicates: the Host pair, then under SEED_PROFILE=e2e the manifest,
# the E2E workflow model and any extra pairs given as arguments.
llm_ensure_seed_pairs() {
  local manifest="${LLM_ENSURE_MANIFEST:-${LLM_ENSURE_LIB_DIR}/e2e-llm-models.txt}" pair
  # Checked before the pipeline: a failure inside it would not reach the caller
  # without pipefail.
  if [ "${SEED_PROFILE:-e2e}" = e2e ] && [ ! -r "$manifest" ]; then
    llm_ensure_err "LLM_MODEL_ENSURE_FAILED: E2E model manifest '${manifest}' is not readable"
    return 1
  fi
  {
    if [ -n "${LLM_ENSURE_HOST_MODEL:-}" ]; then printf '%s\n' "$LLM_ENSURE_HOST_MODEL"; fi
    if [ "${SEED_PROFILE:-e2e}" = e2e ]; then
      sed -e 's/#.*//' -e 's/[[:space:]]//g' "$manifest" | sed '/^$/d'
      if [ -n "${E2E_WORKFLOW_MODEL_PROVIDER:-}" ] && [ -n "${E2E_WORKFLOW_MODEL_NAME:-}" ]; then
        printf '%s/%s\n' "$E2E_WORKFLOW_MODEL_PROVIDER" "$E2E_WORKFLOW_MODEL_NAME"
      fi
      for pair in "$@"; do printf '%s\n' "$pair"; done
    fi
  } | awk '!seen[$0]++'
}

# ensure_seed_llm_models [extra provider/model ...]
# Outside minikube this logs and does nothing: there the admin owns the
# allowlist.
ensure_seed_llm_models() {
  local pairs pair
  LLM_ENSURE_CATALOG_STATE=""
  if ! llm_ensure_context_allowed; then
    if [ -n "${LLM_ENSURE_MINIKUBE_PROFILE:-}" ]; then
      llm_ensure_err "LLM_MODEL_ENSURE_REFUSED: setup named profile '${LLM_ENSURE_MINIKUBE_PROFILE}' but the seed targets '${CONTEXT:-}'"
      return 1
    fi
    log "Skipping LLM model ensure: '${CONTEXT:-}' is not a minikube context"
    return 0
  fi
  pairs="$(llm_ensure_seed_pairs "$@")" || return 1
  [ -n "$pairs" ] || return 0
  log "Ensuring LLM models are enabled (fresh DB: ${LLM_ENSURE_DB_FRESH:-false})"
  while IFS= read -r pair; do
    case "$pair" in
      */*) ;;
      *) llm_ensure_err "LLM_MODEL_ENSURE_FAILED: '${pair}' is not provider/model"; return 1 ;;
    esac
    ensure_llm_model_enabled "${pair%%/*}" "${pair#*/}" || return 1
  done <<<"$pairs"
}
