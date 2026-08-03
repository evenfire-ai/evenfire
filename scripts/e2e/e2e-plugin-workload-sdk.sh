#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E gate — Plugin Workload SDK (promptBridge + clientNotifications)
# ═══════════════════════════════════════════════════════════════════════
#
# Minikube-only (plan §8, §9). Proves that a recipe declaring
# spec.pluginWorkloadSdk:
#   - has its capability validated and projected to status.pluginWorkloadSdk,
#   - gets the SDK NetworkPolicies + token Secret + workload env injected,
#   - lets an allowed plugin workload call promptBridge + clientNotifications
#     through the recipe mcp-host's SDK server, authorized by control-api,
#   - records both calls in the invocation audit trail.
#
# Token-dependent steps (grant creation, SDK call assertions, audit query)
# use E2E_ADMIN_TOKEN when supplied, otherwise the gate acquires an ephemeral
# session from the seeded admin on an explicitly selected local minikube profile.
#
# Usage:
#   E2E_PLUGIN_SDK_WRITE_CONFIRM=1 KUBECONTEXT=clerum-test \
#     bash scripts/e2e/e2e-plugin-workload-sdk.sh
#   E2E_PLUGIN_SDK_WRITE_CONFIRM=1 bash scripts/e2e/e2e-plugin-workload-sdk.sh --cleanup-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the canonical repository environment before sourcing e2e-lib. A
# secondary worktree normally has no .env of its own; the seeded credentials
# and provider keys live in the primary checkout. Explicit process values are
# intentionally preserved, then the test-specific defaults are applied below:
#
#   process environment > canonical root .env > safe test defaults
#
# The dotenv file is parsed as data without sourcing or evaluating it. Values
# supplied by the caller remain authoritative, and shell expressions in the
# canonical file are preserved literally.
load_canonical_root_env() {
  local repo_root env_file common_dir main_repo_dir raw_line line key
  repo_root="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  env_file=""

  if [ -f "${repo_root}/.env" ]; then
    env_file="${repo_root}/.env"
  else
    common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null || true)"
    if [ -n "$common_dir" ]; then
      case "$common_dir" in
        /*) main_repo_dir="$(cd "${common_dir}/.." && pwd)" ;;
        *) main_repo_dir="$(cd "${repo_root}/${common_dir}/.." && pwd)" ;;
      esac
      if [ -f "${main_repo_dir}/.env" ]; then
        env_file="${main_repo_dir}/.env"
      fi
    fi
  fi

  if [ -z "$env_file" ]; then
    return 0
  fi

  local line_number=0 value quote
  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    line_number=$((line_number + 1))
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    if [[ "$line" != *=* ]]; then
      printf 'Ignoring invalid canonical .env line %s (expected KEY=value)\n' "$line_number" >&2
      return 1
    fi
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      printf 'Ignoring invalid canonical .env key on line %s\n' "$line_number" >&2
      return 1
    fi
    if [ "${!key+x}" = x ]; then
      continue
    fi
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      quote="${value:0:1}"
      if [[ "${value: -1}" != "$quote" ]]; then
        printf 'Ignoring unterminated quoted value on canonical .env line %s\n' "$line_number" >&2
        return 1
      fi
      value="${value:1:${#value}-2}"
    fi
    # Treat dotenv as data. In particular, command substitutions, backticks,
    # globbing and variable references remain literal text and are never
    # evaluated by a shell.
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$env_file"
}

load_canonical_root_env
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
# shellcheck source=e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

RECIPE_NAME="e2e-plugin-workload-sdk"
WORKLOAD_ID="sdk-caller"
EVENT_TYPE="e2e.test.notification"
E2E_DESKTOP_USER_EMAIL="${E2E_DESKTOP_USER_EMAIL:-${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}}"

# The host-wide CLERUM_MODEL_PROVIDER may legitimately remain Z.AI for other
# local workloads, but this gate must not spend its T3 calls against the
# provider currently limited by 429s. Inherit the host provider/model only
# when it is an allowed OpenAI/Claude target; otherwise use the deterministic
# OpenAI default and make the fallback Claude. An explicit E2E_* value still
# wins and is validated below.
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-}"
if [ -z "$E2E_WORKFLOW_MODEL_PROVIDER" ]; then
  case "${CLERUM_MODEL_PROVIDER:-}" in
    openai|claude)
      E2E_WORKFLOW_MODEL_PROVIDER="$CLERUM_MODEL_PROVIDER"
      if [ -z "$E2E_WORKFLOW_MODEL_NAME" ] && [ -n "${CLERUM_MODEL_NAME:-}" ]; then
        E2E_WORKFLOW_MODEL_NAME="$CLERUM_MODEL_NAME"
      fi
      ;;
    '')
      E2E_WORKFLOW_MODEL_PROVIDER="openai"
      ;;
    *)
      warn "CLERUM_MODEL_PROVIDER=${CLERUM_MODEL_PROVIDER} is not used by this Plugin Workload SDK gate; selecting the OpenAI default because the Z.AI lane is unavailable"
      E2E_WORKFLOW_MODEL_PROVIDER="openai"
      ;;
  esac
fi
if [ -z "$E2E_WORKFLOW_MODEL_NAME" ]; then
  case "$E2E_WORKFLOW_MODEL_PROVIDER" in
    openai) E2E_WORKFLOW_MODEL_NAME="gpt-5.4-mini" ;;
    claude) E2E_WORKFLOW_MODEL_NAME="claude-sonnet-4-6" ;;
    *) E2E_WORKFLOW_MODEL_NAME="gpt-5.4-mini" ;;
  esac
fi
# promptBridge grants are an ordered, credential-bound policy. The target
# reference is not a credential value; operators can override both values for
# a non-default, provider-owned Secret data key without exposing its contents.
# The gate deliberately carries two distinct providers so selector authorization
# and ordered fallback are exercised independently of whether either paid
# provider is available in the local cluster.
E2E_PROMPT_TARGET_REF="${E2E_PROMPT_TARGET_REF:-primary}"
E2E_PROMPT_CREDENTIAL_SLOT="${E2E_PROMPT_CREDENTIAL_SLOT:-${E2E_WORKFLOW_CREDENTIAL_SLOT:-}}"
E2E_PROMPT_FALLBACK_PROVIDER="${E2E_PROMPT_FALLBACK_PROVIDER:-}"
E2E_PROMPT_FALLBACK_MODEL="${E2E_PROMPT_FALLBACK_MODEL:-}"
if [ -z "$E2E_PROMPT_FALLBACK_PROVIDER" ]; then
  if [ "$E2E_WORKFLOW_MODEL_PROVIDER" = "claude" ]; then
    E2E_PROMPT_FALLBACK_PROVIDER="openai"
  else
    E2E_PROMPT_FALLBACK_PROVIDER="claude"
  fi
fi
if [ -z "$E2E_PROMPT_FALLBACK_MODEL" ]; then
  case "$E2E_PROMPT_FALLBACK_PROVIDER" in
    openai) E2E_PROMPT_FALLBACK_MODEL="gpt-5.4-mini" ;;
    claude) E2E_PROMPT_FALLBACK_MODEL="claude-sonnet-4-6" ;;
    *) E2E_PROMPT_FALLBACK_MODEL="" ;;
  esac
fi
E2E_PROMPT_FALLBACK_TARGET_REF="${E2E_PROMPT_FALLBACK_TARGET_REF:-fallback-${E2E_PROMPT_FALLBACK_PROVIDER}}"
E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT="${E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT:-}"
E2E_ADMIN_TOKEN="${E2E_ADMIN_TOKEN:-}"
# Seeded by scripts/e2e/seed-e2e-data.sh (copies ADMIN_PASSWORD into test users).
E2E_DESKTOP_PASSWORD="${E2E_DESKTOP_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

load_branch_profile_ports() {
  local ctx="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-}}"
  local ports_env="${CLERUM_PROFILE_PORTS_ENV:-}"
  if [ -z "$ports_env" ] && [ -n "$ctx" ]; then
    ports_env="${HOME}/.cache/clerum/minikube-profiles/${ctx}/ports.env"
  fi
  if [ -f "$ports_env" ]; then
    # shellcheck disable=SC1090
    . "$ports_env"
  fi
}
load_branch_profile_ports
E2E_EXTERNAL_REST_API_URL="${E2E_EXTERNAL_REST_API_URL:-${EXTERNAL_REST_API_URL:-http://127.0.0.1:8091}}"
FIXTURE="${SCRIPT_DIR}/../../tests/e2e/fixtures/plugin-workload-sdk-recipe.yaml"
E2E_CREATED_RECIPE=0
ADMIN_CURL_HTTP_STATUS=""
ADMIN_CURL_BODY=""
NOTIFICATION_PREF_SNAPSHOT_READY=0
NOTIFICATION_PREF_SNAPSHOT_EXISTS=0
NOTIFICATION_PREF_SNAPSHOT_MEDIUM=""
NOTIFICATION_PREF_SNAPSHOT_FALLBACK=""
NOTIFICATION_PREF_SNAPSHOT_ACCOUNT=""
# Hard ceiling for the entire gate (default 15m). Override with E2E_GATE_MAX_SECONDS.
E2E_GATE_MAX_SECONDS="${E2E_GATE_MAX_SECONDS:-900}"
E2E_GATE_STARTED_AT=$SECONDS
# Per-phase wait ceilings (seconds).
E2E_WAIT_STATUS_VALIDATED="${E2E_WAIT_STATUS_VALIDATED:-120}"
E2E_WAIT_CALLER_MARKER="${E2E_WAIT_CALLER_MARKER:-180}"
E2E_WAIT_CALLER_DONE="${E2E_WAIT_CALLER_DONE:-180}"
E2E_WAIT_NOTIFICATION_ROW="${E2E_WAIT_NOTIFICATION_ROW:-60}"

require_write_confirmation() {
  if [ "${E2E_PLUGIN_SDK_WRITE_CONFIRM:-}" != "1" ]; then
    printf '%s\n' \
      'Refusing Plugin Workload SDK E2E: this gate creates grants, calls providers, sends a notification, and changes test-user preferences.' \
      'Set E2E_PLUGIN_SDK_WRITE_CONFIRM=1 explicitly for the branch-owned local Minikube profile.' >&2
    return 1
  fi
}

for provider in "$E2E_WORKFLOW_MODEL_PROVIDER" "$E2E_PROMPT_FALLBACK_PROVIDER"; do
  case "$provider" in
    openai|claude) ;;
    *)
      printf 'Plugin Workload SDK E2E only permits OpenAI or Claude targets; got %q\n' "$provider" >&2
      exit 2
      ;;
  esac
done

default_prompt_credential_slot() {
  case "$1" in
    openai) printf '%s\n' 'openai-api-key' ;;
    claude) printf '%s\n' 'claude-api-key' ;;
    zai) printf '%s\n' 'zai-api-key' ;;
    bailian) printf '%s\n' 'bailian-api-key' ;;
    vertex) printf '%s\n' 'vertex-service-account-json' ;;
    bedrock) printf '%s\n' 'aws-access-key-id' ;;
    openrouter) printf '%s\n' 'openrouter-api-key' ;;
    gemini) printf '%s\n' 'gemini-api-key' ;;
    deepseek) printf '%s\n' 'deepseek-api-key' ;;
    groq) printf '%s\n' 'groq-api-key' ;;
    together) printf '%s\n' 'together-api-key' ;;
    fireworks) printf '%s\n' 'fireworks-api-key' ;;
    mistral) printf '%s\n' 'mistral-api-key' ;;
    xai) printf '%s\n' 'xai-api-key' ;;
    cerebras) printf '%s\n' 'cerebras-api-key' ;;
    deepinfra) printf '%s\n' 'deepinfra-api-key' ;;
    perplexity) printf '%s\n' 'perplexity-api-key' ;;
    moonshot) printf '%s\n' 'moonshot-api-key' ;;
    nebius) printf '%s\n' 'nebius-api-key' ;;
    novita) printf '%s\n' 'novita-api-key' ;;
    azure) printf '%s\n' 'azure-openai-api-key' ;;
    *) return 1 ;;
  esac
}

if [ -z "$E2E_PROMPT_CREDENTIAL_SLOT" ]; then
  E2E_PROMPT_CREDENTIAL_SLOT="$(default_prompt_credential_slot "$E2E_WORKFLOW_MODEL_PROVIDER")" \
    || { printf 'Unsupported promptBridge provider %q; set E2E_PROMPT_CREDENTIAL_SLOT explicitly\n' "$E2E_WORKFLOW_MODEL_PROVIDER" >&2; exit 2; }
fi
if [ -z "$E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT" ]; then
  E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT="$(default_prompt_credential_slot "$E2E_PROMPT_FALLBACK_PROVIDER")" \
    || { printf 'Unsupported promptBridge fallback provider %q; set E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT explicitly\n' "$E2E_PROMPT_FALLBACK_PROVIDER" >&2; exit 2; }
fi
if [ "$E2E_WORKFLOW_MODEL_PROVIDER" = "$E2E_PROMPT_FALLBACK_PROVIDER" ]; then
  printf 'promptBridge E2E requires two distinct providers; got %q for both primary and fallback\n' \
    "$E2E_WORKFLOW_MODEL_PROVIDER" >&2
  exit 2
fi

gate_assert_deadline() {
  local phase=${1:-gate}
  if [ $((SECONDS - E2E_GATE_STARTED_AT)) -ge "$E2E_GATE_MAX_SECONDS" ]; then
    fail "E2E gate exceeded ${E2E_GATE_MAX_SECONDS}s deadline during: ${phase}"
    print_results
    exit 1
  fi
}

stop_sdk_caller_fixture() {
  kctl delete pod "$caller_pod" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if wait_for_pod "$SANDBOX_NS" "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${WORKLOAD_ID}" "$TIMEOUT_POD"; then
    caller_pod="$(ready_pod_name "$SANDBOX_NS" "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${WORKLOAD_ID}")"
    return 0
  fi
  return 1
}

reset_sdk_runtime_state_for_happy_path() {
  psql_query "DELETE FROM plugin_workload_sdk_quota_counters WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
  psql_query "DELETE FROM plugin_workload_sdk_invocations WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
  psql_query "DELETE FROM notification_deliveries WHERE payload->>'recipeName'='${RECIPE_NAME}' AND payload->>'origin'='plugin_workload_sdk';" >/dev/null 2>&1 || true
}

wait_for_caller_logs_matching() {
  local pattern=$1
  local timeout_sec=${2:-$E2E_WAIT_CALLER_MARKER}
  local deadline=$((SECONDS + timeout_sec))
  local logs=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    gate_assert_deadline "waiting for sdk-caller log pattern: ${pattern}"
    logs="$(kctl logs "$caller_pod" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true)"
    if printf "%s" "$logs" | grep -q "$pattern"; then
      printf '%s' "$logs"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  printf '%s' "$logs"
  return 1
}

wait_for_notification_delivery_row() {
  local notification_id=$1
  local timeout_sec=${2:-$E2E_WAIT_NOTIFICATION_ROW}
  local deadline=$((SECONDS + timeout_sec))
  local dedupe_key="${notification_id}:plugin_workload_sdk.notification"
  local row=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    gate_assert_deadline "waiting for notification_deliveries row"
    row="$(psql_query "SELECT event_type || '|' || status || '|' || COALESCE(audience->>'userId','') FROM notification_deliveries WHERE dedupe_key='${dedupe_key}' OR payload->>'notificationId'='${notification_id}' LIMIT 1;" || true)"
    row="$(printf '%s' "$row" | tr -d '[:space:]')"
    if [ -n "$row" ] && printf '%s' "$row" | grep -q 'plugin_workload_sdk.notification|'; then
      printf '%s' "$row"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  printf '%s' "$row"
  return 1
}

notifications_desktop_first_enabled() {
  local value
  value="$(kctl get deploy control-api -n "$CONTROL_NS" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="NOTIFICATIONS_DESKTOP_FIRST_ENABLED")].value}' 2>/dev/null || true)"
  if [ -z "$value" ]; then
    printf 'true\n'
    return 0
  fi
  if [ "$value" = "false" ]; then
    printf 'false\n'
    return 1
  fi
  printf 'true\n'
}

# ─── cleanup ─────────────────────────────────────────────────────────────

cleanup_plugin_workload_sdk_db() {
  psql_query "DELETE FROM plugin_workload_sdk_quota_counters WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
  psql_query "DELETE FROM plugin_workload_sdk_invocations WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
  psql_query "DELETE FROM plugin_workload_sdk_grants WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
  psql_query "DELETE FROM notification_deliveries WHERE payload->>'recipeName'='${RECIPE_NAME}' AND payload->>'origin'='plugin_workload_sdk';" >/dev/null 2>&1 || true
}

prune_recipe_owned_resources() {
  local cleanup_status=0 ns kind
  # WRC owns the lifecycle sweep, but a failed/aborted reconcile can leave
  # recipe-labeled SDK NetworkPolicies behind after the WorkflowRecipe is
  # gone. The gate must not leak those resources into the next run, so prune
  # only the exact fixture label in the two namespaces it can touch.
  for ns in "$SANDBOX_NS" "$RECIPE_NS"; do
    for kind in deployment service secret configmap networkpolicy pod pvc; do
      kctl delete "$kind" -n "$ns" -l "clerum.io/recipe=${RECIPE_NAME}" \
        --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
    done
  done
  return "$cleanup_status"
}

cleanup_sdk_recipe() {
  local cleanup_status=0
  cleanup_plugin_workload_sdk_db
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || cleanup_status=1
  if ! prune_recipe_owned_resources; then
    cleanup_status=1
  fi
  return "$cleanup_status"
}

# shellcheck disable=SC2329 # Registered below through the EXIT trap.
cleanup_on_exit() {
  local status=$?
  if [ "${e2e_total:-0}" -gt 0 ] && [ "${E2E_SUPPRESS_RESULTS:-0}" != "1" ]; then
    print_results || true
  fi
  if ! restore_notification_preferences && [ "$status" -eq 0 ]; then
    fail "notification preference cleanup could not restore the seeded user state"
    status=1
  fi
  if [ "${E2E_KEEP_RESOURCES:-0}" = "1" ]; then exit "$status"; fi
  if [ "$E2E_CREATED_RECIPE" != "1" ]; then exit "$status"; fi
  if ! cleanup_sdk_recipe && [ "$status" -eq 0 ]; then
    fail "plugin workload SDK cleanup left E2E resources behind"
    exit 1
  fi
  exit "$status"
}

if [ "${1:-}" = "--cleanup-only" ]; then
  require_write_confirmation || exit 2
  cleanup_sdk_recipe
  exit $?
fi

require_write_confirmation || exit 2

trap cleanup_on_exit EXIT

# ─── control-api admin helpers (exec curl inside the control-api pod) ─────

control_api_pod() {
  ready_pod_name "$CONTROL_NS" "app=control-api" 2>/dev/null \
    || ready_pod_name "$CONTROL_NS" "app.kubernetes.io/name=control-api" 2>/dev/null
}

is_local_default_operator_context() {
  local context=${1:-}
  if [[ -z "$context" ]]; then
    context="$(current_e2e_context || true)"
  fi
  case "$context" in
    clerum-test) return 0 ;;
    clerum-codex-* | clerum-cursor-* | clerum-detached-*)
      is_branch_scoped_e2e_context "$context"
      ;;
    *) return 1 ;;
  esac
}

operator_admin_password() {
  if [[ -n "${E2E_ADMIN_PASSWORD:-}" ]]; then printf '%s' "$E2E_ADMIN_PASSWORD"; return 0; fi
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then printf '%s' "$ADMIN_PASSWORD"; return 0; fi
  if [[ -n "${ADMIN_PASS:-}" ]]; then printf '%s' "$ADMIN_PASS"; return 0; fi
  if [[ -n "${TEST_ADMIN_PASSWORD:-}" ]]; then printf '%s' "$TEST_ADMIN_PASSWORD"; return 0; fi
  is_local_default_operator_context || return 1
  printf '%s%s' 'changeme123' '!'
  return 0
}

ensure_operator_session() {
  if [[ -n "${E2E_ADMIN_TOKEN:-}" ]]; then
    return 0
  fi

  local admin_password admin_username pod response status session_cookie
  admin_password="$(operator_admin_password)" || return 1
  admin_username="${E2E_ADMIN_USERNAME:-admin}"
  pod="$(control_api_pod)" || return 1

  # NUL-delimited stdin keeps both credentials out of local and remote argv.
  response="$(
    printf '%s\0%s' "$admin_username" "$admin_password" \
      | kctl exec -i "$pod" -n "$CONTROL_NS" -- node -e '
    const chunks = []
    process.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)))
    process.stdin.on("end", async () => {
      try {
        const input = Buffer.concat(chunks)
        const separator = input.indexOf(0)
        if (separator < 0) throw new Error("invalid login input")
        const username = input.subarray(0, separator).toString("utf8")
        const password = input.subarray(separator + 1).toString("utf8")
        const response = await fetch("http://localhost:8090/api/v1/admin/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        })
        const cookies = typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [response.headers.get("set-cookie")].filter(Boolean)
        const raw = cookies.map(String).find(cookie => cookie.startsWith("control_ui_admin_session=")) || ""
        const value = raw ? raw.split(";")[0].split("=").slice(1).join("=") : ""
        process.stdout.write(String(response.status) + "\t" + value)
      } catch (error) {
        process.stderr.write(error.message)
        process.exit(1)
      }
    })
  '
  )" || return 1
  status="$(printf '%s' "$response" | cut -f1)"
  session_cookie="$(printf '%s' "$response" | cut -f2)"
  [[ "$status" == "200" && -n "$session_cookie" ]] || return 1
  E2E_ADMIN_TOKEN="$session_cookie"
  return 0
}

operator_session_gate() {
  ensure_operator_session
}

# admin_curl METHOD PATH [JSON_BODY]
# Runs node fetch inside the control-api pod against localhost:8090 with the
# E2E_ADMIN_TOKEN control-ui session cookie. Sets ADMIN_CURL_HTTP_STATUS +
# ADMIN_CURL_BODY and echoes the body for callers that only need the payload.
admin_curl() {
  local method=$1 path=$2 body=${3:-} pod response
  pod="$(control_api_pod)" || return 1
  response="$(
    printf '%s\0%s\0%s\0%s' "$method" "$path" "$E2E_ADMIN_TOKEN" "$body" \
      | kctl exec -i "$pod" -n "$CONTROL_NS" -- node -e '
    const chunks = []
    process.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)))
    process.stdin.on("end", async () => {
      try {
        const fields = Buffer.concat(chunks).toString("utf8").split("\0")
        if (fields.length < 4) throw new Error("invalid admin request input")
        const method = fields.shift()
        const path = fields.shift()
        const token = fields.shift()
        const body = fields.join("\0") || null
        const response = await fetch("http://localhost:8090" + path, {
          method,
          headers: {
            "Cookie": "control_ui_admin_session=" + token,
            "Content-Type": "application/json",
          },
          body,
        })
        const text = await response.text()
        process.stdout.write(String(response.status) + "\t" + text)
      } catch (error) {
        process.stderr.write(error.message)
        process.exit(1)
      }
    })
  '
  )"
  ADMIN_CURL_HTTP_STATUS="$(printf '%s' "$response" | cut -f1)"
  ADMIN_CURL_BODY="$(printf '%s' "$response" | cut -f2-)"
  printf '%s' "$ADMIN_CURL_BODY"
}

# session_curl METHOD PATH SESSION_TOKEN [JSON_BODY]
# User-session routes are exposed by external-rest-api (/api/v1/me/*) and forward
# to control-api with the service token. Match the desktop app transport via PF.
session_curl() {
  local method=$1 path=$2 session_token=$3 body=${4:-} api_path response curl_args
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  api_path="${path#/external}"
  curl_args=(-sS -w '\n%{http_code}' -X "$method" \
    "${E2E_EXTERNAL_REST_API_URL}/api/v1${api_path}" \
    -H "Authorization: Bearer ${session_token}" \
    -H 'Content-Type: application/json')
  if [ -n "$body" ]; then
    curl_args+=(-d "$body")
  fi
  response="$(curl "${curl_args[@]}" 2>/dev/null || true)"
  ADMIN_CURL_HTTP_STATUS="$(printf '%s' "$response" | tail -n1)"
  ADMIN_CURL_BODY="$(printf '%s' "$response" | sed '$d')"
  printf '%s' "$ADMIN_CURL_BODY"
}

psql_query() {
  local sql=$1
  kctl exec deploy/control-postgres -n "$CONTROL_NS" -- \
    psql -v ON_ERROR_STOP=1 -U postgres -d profiles -tA \
    -c "$sql" 2>/dev/null
}

snapshot_notification_preferences() {
  local row
  if ! row="$(psql_query "SELECT CASE WHEN preferred_medium IS NULL THEN '<NULL>' ELSE preferred_medium END || '|' || channel_fallback_enabled::text || '|' || CASE WHEN preferred_account_id IS NULL THEN '<NULL>' ELSE preferred_account_id::text END FROM user_notification_preferences WHERE user_id='${USER_REF}'::uuid;")"; then
    return 1
  fi
  if [ -z "$row" ]; then
    NOTIFICATION_PREF_SNAPSHOT_EXISTS=0
    NOTIFICATION_PREF_SNAPSHOT_READY=1
    return 0
  fi
  IFS='|' read -r NOTIFICATION_PREF_SNAPSHOT_MEDIUM \
    NOTIFICATION_PREF_SNAPSHOT_FALLBACK \
    NOTIFICATION_PREF_SNAPSHOT_ACCOUNT <<< "$row"
  NOTIFICATION_PREF_SNAPSHOT_EXISTS=1
  NOTIFICATION_PREF_SNAPSHOT_READY=1
}

restore_notification_preferences() {
  if [ "${NOTIFICATION_PREF_SNAPSHOT_READY:-0}" != "1" ]; then
    return 0
  fi
  if [ "${NOTIFICATION_PREF_SNAPSHOT_EXISTS:-0}" != "1" ]; then
    psql_query "DELETE FROM user_notification_preferences WHERE user_id='${USER_REF}'::uuid;" >/dev/null 2>&1
    return $?
  fi

  local medium_sql account_sql
  if [ "$NOTIFICATION_PREF_SNAPSHOT_MEDIUM" = '<NULL>' ]; then
    medium_sql='NULL'
  else
    medium_sql="'${NOTIFICATION_PREF_SNAPSHOT_MEDIUM}'"
  fi
  if [ "$NOTIFICATION_PREF_SNAPSHOT_ACCOUNT" = '<NULL>' ]; then
    account_sql='NULL'
  else
    account_sql="'${NOTIFICATION_PREF_SNAPSHOT_ACCOUNT}'::uuid"
  fi
  psql_query "INSERT INTO user_notification_preferences (user_id,preferred_medium,channel_fallback_enabled,preferred_account_id) VALUES ('${USER_REF}'::uuid,${medium_sql},${NOTIFICATION_PREF_SNAPSHOT_FALLBACK},${account_sql}) ON CONFLICT (user_id) DO UPDATE SET preferred_medium=EXCLUDED.preferred_medium,channel_fallback_enabled=EXCLUDED.channel_fallback_enabled,preferred_account_id=EXCLUDED.preferred_account_id,updated_at=NOW();" >/dev/null 2>&1
}

is_psql_true() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    t | true) return 0 ;;
    *) return 1 ;;
  esac
}

is_psql_false() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    f | false) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_e2e_desktop_user_id() {
  local email=$1
  psql_query "SELECT id::text FROM users WHERE lower(email)=lower('${email}') LIMIT 1;" \
    | tr -d '[:space:]'
}

ensure_external_rest_api_reachable() {
  local url="${E2E_EXTERNAL_REST_API_URL}/health"
  if curl -sf -m 5 "$url" >/dev/null 2>&1; then
    return 0
  fi
  load_branch_profile_ports
  url="${E2E_EXTERNAL_REST_API_URL}/health"
  if curl -sf -m 5 "$url" >/dev/null 2>&1; then
    return 0
  fi
  fail "external-rest-api not reachable at ${E2E_EXTERNAL_REST_API_URL} (run branch-profile-pf for ${KUBECONTEXT:-<profile>})"
  exit 1
}

obtain_desktop_session_token() {
  local email=$1 password=$2 response body token
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  ensure_external_rest_api_reachable
  response="$(
    printf '%s\0%s' "$email" "$password" \
      | jq -Rs 'split("\u0000") | {email: .[0], password: .[1]}' \
      | curl -sS -w '\n%{http_code}' -X POST \
        "${E2E_EXTERNAL_REST_API_URL}/api/v1/auth/password-login" \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        2>/dev/null || true
  )"
  ADMIN_CURL_HTTP_STATUS="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"
  token="$(printf '%s' "$body" | jq -r '.token // empty' 2>/dev/null || true)"
  ADMIN_CURL_BODY="$body"
  if [ "$ADMIN_CURL_HTTP_STATUS" != "200" ] || [ -z "$token" ]; then
    return 1
  fi
  printf '%s' "$token"
}

create_grant() {
  local family=$1 payload
  if [ "$family" = "promptBridge" ]; then
    payload="$(prompt_grant_payload "$WORKLOAD_ID")"
  else
    payload='{"recipeNamespace":"sandbox-recipes","recipeName":"'"$RECIPE_NAME"'","capabilityFamily":"clientNotifications","allowedEventTypes":["'"$EVENT_TYPE"'"],"allowedUserRefs":["'"$USER_REF"'"],"allowedCallers":["'"$WORKLOAD_ID"'"],"quotaLimits":{"maxNotificationsPerRun":10}}'
  fi
  admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$payload"
}

# The admin API validates the policy; jq is used here solely to serialize E2E
# configuration safely, never to carry credential values. `allowedModels` is
# retained for the compatibility/bootstrap contract, while `promptTargets` is
# the authorization policy and `defaultTargetRef` must select its first target.
prompt_grant_payload() {
  local caller=$1
  jq -cn \
    --arg namespace "$RECIPE_NS" \
    --arg recipe "$RECIPE_NAME" \
    --arg provider "$E2E_WORKFLOW_MODEL_PROVIDER" \
    --arg model "$E2E_WORKFLOW_MODEL_NAME" \
    --arg targetRef "$E2E_PROMPT_TARGET_REF" \
    --arg credentialSlot "$E2E_PROMPT_CREDENTIAL_SLOT" \
    --arg fallbackProvider "$E2E_PROMPT_FALLBACK_PROVIDER" \
    --arg fallbackModel "$E2E_PROMPT_FALLBACK_MODEL" \
    --arg fallbackTargetRef "$E2E_PROMPT_FALLBACK_TARGET_REF" \
    --arg fallbackCredentialSlot "$E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT" \
    --arg caller "$caller" \
    '{recipeNamespace:$namespace,recipeName:$recipe,capabilityFamily:"promptBridge",provider:$provider,allowedModels:[$model,$fallbackModel],promptTargets:[{targetRef:$targetRef,provider:$provider,model:$model,credentialSlot:$credentialSlot},{targetRef:$fallbackTargetRef,provider:$fallbackProvider,model:$fallbackModel,credentialSlot:$fallbackCredentialSlot}],defaultTargetRef:$targetRef,allowedCallers:[$caller],quotaLimits:{maxRequestsPerRun:4}}'
}

# ─── prerequisites ───────────────────────────────────────────────────────

header "Plugin Workload SDK E2E — prerequisites"

kctl cluster-info >/dev/null
kctl get ns "$SANDBOX_NS" >/dev/null
kctl get ns "$MCP_HOST_NS" >/dev/null
kctl get crd workflowrecipes.clerum.io >/dev/null
kctl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
ok "runtime prerequisites available"

# The triple activation gate requires the flag on both control-api and the
# recipe mcp-host. Surface a clear failure if the feature is off.
if kctl get deploy control-api -n "$CONTROL_NS" -o jsonpath='{.spec.template.spec.containers[*].env[?(@.name=="PLUGIN_WORKLOAD_SDK_ENABLED")].value}' 2>/dev/null | grep -q true; then
  ok "control-api has PLUGIN_WORKLOAD_SDK_ENABLED=true"
else
  fail "control-api PLUGIN_WORKLOAD_SDK_ENABLED is not true — enable the feature flag (plan §9.2)"
  exit 1
fi

if ! cleanup_sdk_recipe; then
  fail "plugin workload SDK pre-run cleanup left E2E resources behind"
  exit 1
fi

# ─── apply fixture ───────────────────────────────────────────────────────

header "Apply the SDK recipe fixture"

USER_REF="${E2E_SDK_USER_REF:-$(resolve_e2e_desktop_user_id "$E2E_DESKTOP_USER_EMAIL")}"
if [ -z "$USER_REF" ]; then
  fail "could not resolve desktop user id for ${E2E_DESKTOP_USER_EMAIL} — seed test data first"
  exit 1
fi
ok "SDK clientNotifications userRef targets desktop user ${USER_REF}"

sed -e "s/PLACEHOLDER_PROVIDER/${E2E_WORKFLOW_MODEL_PROVIDER}/" \
    -e "s/PLACEHOLDER_MODEL/${E2E_WORKFLOW_MODEL_NAME}/" \
    -e "s/PLACEHOLDER_FALLBACK_TARGET_REF/${E2E_PROMPT_FALLBACK_TARGET_REF}/" \
    -e "s/PLACEHOLDER_RECIPE_NAME/${RECIPE_NAME}/" \
    -e "s/PLACEHOLDER_USER_REF/${USER_REF}/" \
    "$FIXTURE" | kctl apply -f -
E2E_CREATED_RECIPE=1
ok "applied WorkflowRecipe ${RECIPE_NAME}"

# ─── infra invariants (no admin token needed) ────────────────────────────

header "Infrastructure invariants"

# 1. Capability validated + projected to status.
status_ok=0
state=""
status_deadline=$((SECONDS + E2E_WAIT_STATUS_VALIDATED))
while [ "$SECONDS" -lt "$status_deadline" ]; do
  gate_assert_deadline "waiting for status.pluginWorkloadSdk.state=validated"
  state=$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o jsonpath='{.status.pluginWorkloadSdk.state}' 2>/dev/null || true)
  if [ "$state" = "validated" ]; then status_ok=1; break; fi
  sleep "$POLL_INTERVAL"
done
if [ "$status_ok" = "1" ]; then
  ok "status.pluginWorkloadSdk.state == validated"
else
  fail "status.pluginWorkloadSdk.state did not reach 'validated' (got '${state:-<empty>}')"
  exit 1
fi

# 2. mcp-host ready (hosts the SDK server).
if wait_for_pod "$SANDBOX_NS" "clerum.io/recipe=${RECIPE_NAME},clerum.io/component=workflow-mcp-host" 180; then
  ok "recipe mcp-host pod is ready"
else
  fail "recipe mcp-host pod never became ready"
  exit 1
fi

# 3. SDK token Secret created.
if kctl get secret "wf-${RECIPE_NAME}-plugin-workload-sdk-token" -n "$SANDBOX_NS" >/dev/null 2>&1; then
  ok "SDK workload token Secret exists"
else
  fail "SDK workload token Secret missing"
  exit 1
fi

# 4. SDK NetworkPolicies created (ingress + egress).
np_ok=1
for np in "${RECIPE_NAME}-workload-to-mcp-host-sdk-ingress" "${RECIPE_NAME}-workload-to-mcp-host-sdk-egress"; do
  kctl get networkpolicy "$np" -n "$SANDBOX_NS" >/dev/null 2>&1 || np_ok=0
done
if [ "$np_ok" = "1" ]; then
  ok "SDK ingress + egress NetworkPolicies exist"
else
  fail "one or both SDK NetworkPolicies are missing"
  exit 1
fi

# 5. sdk-caller pod ready + env injected.
if wait_for_pod "$SANDBOX_NS" "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${WORKLOAD_ID}" 180; then
  ok "sdk-caller workload pod is ready"
else
  fail "sdk-caller workload pod never became ready"
  exit 1
fi
caller_pod="$(ready_pod_name "$SANDBOX_NS" "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${WORKLOAD_ID}")"
caller_env="$(kctl get pod "$caller_pod" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].env[*].name}' 2>/dev/null || true)"
if printf "%s" "$caller_env" | grep -q PLUGIN_WORKLOAD_SDK_ENDPOINT &&
   printf "%s" "$caller_env" | grep -q PLUGIN_WORKLOAD_SDK_TOKEN; then
  ok "sdk-caller received PLUGIN_WORKLOAD_SDK_ENDPOINT + PLUGIN_WORKLOAD_SDK_TOKEN"
else
  fail "sdk-caller missing SDK endpoint/token env"
  exit 1
fi

# Security invariant: no provider key env leaked into the workload.
if printf "%s" "$caller_env" | grep -Eq 'OPENAI_API_KEY|CLAUDE_API_KEY|ZAI_API_KEY|BAILIAN_API_KEY'; then
  fail "sdk-caller pod has a provider API key env — must never be exposed to workloads"
  exit 1
else
  ok "sdk-caller pod has no provider API key env"
fi

# ─── route guards (token-independent) ───────────────────────────────────

header "Route guards"

# 401: a request without the workload token is rejected by the SDK server.
# The caller image is node:24-alpine (no curl); use the in-pod node + fetch.
unauth_status="$(kctl exec "$caller_pod" -n "$SANDBOX_NS" -- node -e '
fetch(process.env.PLUGIN_WORKLOAD_SDK_ENDPOINT + "/v1/prompt-bridge", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-clerum-caller-ref": "sdk-caller" },
  body: "{}",
}).then(r => { console.log(r.status); process.exit(0) })
  .catch(() => { console.log("ERR"); process.exit(0) })
' 2>/dev/null || true)"
if [ "$unauth_status" = "401" ]; then
  ok "SDK server returns 401 for a request without the workload token"
else
  fail "SDK server did not return 401 without a token (got '${unauth_status}')"
  exit 1
fi

# NetworkPolicy: a pod in a different namespace cannot reach the SDK port.
mcp_svc="$(kctl get svc -n "$SANDBOX_NS" -l "clerum.io/recipe=${RECIPE_NAME},clerum.io/component=workflow-mcp-host" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [ -n "$mcp_svc" ]; then
  probe_out="$(kctl run "sdk-np-probe-$$" -n default --rm -i --restart=Never \
    --image=busybox:1.36 --command --timeout=60s -- \
    sh -c "nc -z -w5 ${mcp_svc}.${SANDBOX_NS}.svc.cluster.local 8099 && echo OPEN || echo BLOCKED" 2>/dev/null || echo BLOCKED)"
  if printf "%s" "$probe_out" | grep -q BLOCKED; then
    ok "SDK port 8099 is blocked from the 'default' namespace (NetworkPolicy enforced)"
  else
    fail "SDK port 8099 was reachable cross-namespace — NetworkPolicy not enforcing"
    exit 1
  fi
else
  warn "could not resolve the recipe mcp-host Service name; skipping cross-namespace NP probe"
fi

# ─── authorized happy path (requires admin token) ────────────────────────

if operator_session_gate; then
  ok "operator session available for authenticated Plugin Workload SDK checks"
else
  fail "operator session acquisition failed for required authenticated Plugin Workload SDK checks"
  exit 1
fi

header "Admin grant guardrails"

wildcard_payload="$(jq -cn \
  --arg namespace "$RECIPE_NS" \
  --arg recipe "$RECIPE_NAME" \
  --arg provider "$E2E_WORKFLOW_MODEL_PROVIDER" \
  --arg model "$E2E_WORKFLOW_MODEL_NAME" \
  --arg targetRef "$E2E_PROMPT_TARGET_REF" \
  --arg credentialSlot "$E2E_PROMPT_CREDENTIAL_SLOT" \
  --arg caller "$WORKLOAD_ID" \
  '{recipeNamespace:$namespace,recipeName:$recipe,capabilityFamily:"promptBridge",provider:$provider,allowedModels:["*"],promptTargets:[{targetRef:$targetRef,provider:$provider,model:$model,credentialSlot:$credentialSlot}],defaultTargetRef:$targetRef,allowedCallers:[$caller]}')"
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$wildcard_payload" >/dev/null || true
wildcard_status="$ADMIN_CURL_HTTP_STATUS"
wildcard_body="$ADMIN_CURL_BODY"
if [ "$wildcard_status" = "400" ] && printf '%s' "$wildcard_body" | grep -q 'wildcard_not_allowed'; then
  ok "admin API rejects wildcard allowlists with wildcard_not_allowed"
else
  fail "wildcard grant was not rejected as expected (HTTP ${wildcard_status:-unknown}; response body redacted)"
  exit 1
fi

missing_policy_payload="$(jq -cn \
  --arg namespace "$RECIPE_NS" \
  --arg recipe "$RECIPE_NAME" \
  --arg provider "$E2E_WORKFLOW_MODEL_PROVIDER" \
  --arg model "$E2E_WORKFLOW_MODEL_NAME" \
  --arg caller "$WORKLOAD_ID" \
  '{recipeNamespace:$namespace,recipeName:$recipe,capabilityFamily:"promptBridge",provider:$provider,allowedModels:[$model],allowedCallers:[$caller]}')"
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$missing_policy_payload" >/dev/null || true
missing_policy_status="$ADMIN_CURL_HTTP_STATUS"
missing_policy_body="$ADMIN_CURL_BODY"
if [ "$missing_policy_status" = "400" ] && printf '%s' "$missing_policy_body" | grep -q 'promptTargets must be a non-empty array'; then
  ok "admin API rejects promptBridge grants without ordered promptTargets"
else
  fail "promptBridge grant without promptTargets was not rejected as expected (HTTP ${missing_policy_status:-unknown}; response body redacted)"
  exit 1
fi

missing_default_payload="$(jq -cn \
  --arg namespace "$RECIPE_NS" \
  --arg recipe "$RECIPE_NAME" \
  --arg provider "$E2E_WORKFLOW_MODEL_PROVIDER" \
  --arg model "$E2E_WORKFLOW_MODEL_NAME" \
  --arg targetRef "$E2E_PROMPT_TARGET_REF" \
  --arg credentialSlot "$E2E_PROMPT_CREDENTIAL_SLOT" \
  --arg caller "$WORKLOAD_ID" \
  '{recipeNamespace:$namespace,recipeName:$recipe,capabilityFamily:"promptBridge",provider:$provider,allowedModels:[$model],promptTargets:[{targetRef:$targetRef,provider:$provider,model:$model,credentialSlot:$credentialSlot}],allowedCallers:[$caller]}')"
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$missing_default_payload" >/dev/null || true
missing_default_status="$ADMIN_CURL_HTTP_STATUS"
missing_default_body="$ADMIN_CURL_BODY"
if [ "$missing_default_status" = "400" ] && printf '%s' "$missing_default_body" | grep -q 'defaultTargetRef is required'; then
  ok "admin API rejects promptBridge grants without defaultTargetRef"
else
  fail "promptBridge grant without defaultTargetRef was not rejected as expected (HTTP ${missing_default_status:-unknown}; response body redacted)"
  exit 1
fi

header "Grants + negative authorization"

E2E_PROBE_RUN_ID="${E2E_PROBE_RUN_ID:-run-$$-$(date +%s)}"
# Idempotency keys allow only [a-zA-Z0-9_-]; sanitize hostname-derived noise.
E2E_PROBE_RUN_ID="$(printf '%s' "$E2E_PROBE_RUN_ID" | tr -c 'a-zA-Z0-9_-' '_')"
if ! stop_sdk_caller_fixture; then
  fail "could not recycle sdk-caller pod before authorization probes"
  exit 1
fi
ok "paused sdk-caller fixture before authorization probes (run=${E2E_PROBE_RUN_ID})"

if create_grant promptBridge >/dev/null; then
  ok "created promptBridge grant"
else
  fail "promptBridge grant creation failed"
  exit 1
fi
if create_grant clientNotifications >/dev/null; then
  ok "created clientNotifications grant"
else
  fail "clientNotifications grant creation failed"
  exit 1
fi

# Read back only the persisted policy metadata. This proves the operator's
# two-provider order/default contract without ever logging a Secret value,
# bearer token, or credential ticket.
prompt_grant_readback="$(admin_curl GET "/api/v1/admin/plugin-workload-sdk/grants?recipeNamespace=${RECIPE_NS}&recipeName=${RECIPE_NAME}" || true)"
if [ "$ADMIN_CURL_HTTP_STATUS" = "200" ] &&
  printf '%s' "$prompt_grant_readback" | jq -e \
    --arg provider "$E2E_WORKFLOW_MODEL_PROVIDER" \
    --arg model "$E2E_WORKFLOW_MODEL_NAME" \
    --arg targetRef "$E2E_PROMPT_TARGET_REF" \
    --arg credentialSlot "$E2E_PROMPT_CREDENTIAL_SLOT" \
    --arg fallbackProvider "$E2E_PROMPT_FALLBACK_PROVIDER" \
    --arg fallbackModel "$E2E_PROMPT_FALLBACK_MODEL" \
    --arg fallbackTargetRef "$E2E_PROMPT_FALLBACK_TARGET_REF" \
    --arg fallbackCredentialSlot "$E2E_PROMPT_FALLBACK_CREDENTIAL_SLOT" \
    '(.items // []) | map(select(.capabilityFamily == "promptBridge")) | .[0] as $grant |
      ($grant.provider == $provider) and
      ($grant.defaultTargetRef == $targetRef) and
      (($grant.promptTargets // []) | length == 2) and
      ($grant.promptTargets[0] == {targetRef:$targetRef,provider:$provider,model:$model,credentialSlot:$credentialSlot}) and
      ($grant.promptTargets[1] == {targetRef:$fallbackTargetRef,provider:$fallbackProvider,model:$fallbackModel,credentialSlot:$fallbackCredentialSlot}) and
      ((($grant | tojson) | test("secret|token"; "i")) | not)' >/dev/null; then
  ok "persisted promptBridge policy contains ordered primary + fallback providers without credential material"
else
  fail "persisted promptBridge policy did not match the two-provider order/default contract (HTTP ${ADMIN_CURL_HTTP_STATUS:-unknown}; response body redacted)"
  exit 1
fi

# Recipients read endpoint (grant-driven picker): the clientNotifications grant
# just created carries allowedUserRefs=[USER_REF]. GET /v1/client-notifications/
# recipients must surface that userRef (resolved to a display label) so a recipe
# sandbox UI can populate its notify dropdown from the authoritative grant rather
# than a recipe-baked RECIPIENTS env. Read-only: it must NOT consume the quota.
recipients_out="$(kctl exec "$caller_pod" -n "$SANDBOX_NS" -- env "E2E_USER_REF=${USER_REF}" node -e '
fetch(process.env.PLUGIN_WORKLOAD_SDK_ENDPOINT + "/v1/client-notifications/recipients", {
  headers: { Authorization: "Bearer " + process.env.PLUGIN_WORKLOAD_SDK_TOKEN },
}).then(async r => {
  const b = await r.json().catch(() => ({}));
  const recips = Array.isArray(b.recipients) ? b.recipients : [];
  const hit = recips.some(x => x && x.userRef === process.env.E2E_USER_REF && typeof x.displayName === "string");
  console.log(r.status + ":" + (hit ? "HIT" : "MISS") + ":" + recips.length);
  process.exit(0);
}).catch(() => { console.log("ERR"); process.exit(0) })
' 2>/dev/null || true)"
if printf "%s" "$recipients_out" | grep -q '^200:HIT:'; then
  ok "recipients endpoint surfaces the grant's allowedUserRefs (grant-driven picker)"
else
  fail "recipients endpoint did not surface the granted userRef (got '${recipients_out}')"
  exit 1
fi

# Probe denials on the infra-phase pod before restarting it for the happy-path fixture run.
# callerRef is token-bound on the SDK server — never from x-clerum-caller-ref.

deny_event="$(kctl exec "$caller_pod" -n "$SANDBOX_NS" -- env "E2E_USER_REF=${USER_REF}" "E2E_PROBE_RUN_ID=${E2E_PROBE_RUN_ID}" node -e '
fetch(process.env.PLUGIN_WORKLOAD_SDK_ENDPOINT + "/v1/client-notifications", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + process.env.PLUGIN_WORKLOAD_SDK_TOKEN,
  },
  body: JSON.stringify({
    eventType: "unknown.event",
    userRef: process.env.E2E_USER_REF,
    idempotencyKey: "e2e-deny-event-" + process.env.E2E_PROBE_RUN_ID,
    notification: { title: "x", body: "y" },
  }),
}).then(async r => { const b = await r.json().catch(() => ({})); console.log(r.status + ":" + (b.error || "")); process.exit(0) })
  .catch(() => { console.log("ERR"); process.exit(0) })
' 2>/dev/null || true)"
if printf "%s" "$deny_event" | grep -q 'event_type_not_allowed'; then
  ok "undeclared event type is denied with event_type_not_allowed"
else
  fail "undeclared event type was not denied as expected (got '${deny_event}')"
  exit 1
fi

unauthorized_target="$(kctl exec "$caller_pod" -n "$SANDBOX_NS" -- env "E2E_PROBE_RUN_ID=${E2E_PROBE_RUN_ID}" node -e '
fetch(process.env.PLUGIN_WORKLOAD_SDK_ENDPOINT + "/v1/prompt-bridge", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + process.env.PLUGIN_WORKLOAD_SDK_TOKEN,
  },
  body: JSON.stringify({
    purpose: "summarization",
    targetRef: "unauthorized-third-provider",
    idempotencyKey: "e2e-deny-target-" + process.env.E2E_PROBE_RUN_ID,
    messages: [{ role: "user", content: "x" }],
  }),
}).then(async r => { const b = await r.json().catch(() => ({})); console.log(r.status + ":" + (b.error || "")); process.exit(0) })
  .catch(() => { console.log("ERR"); process.exit(0) })
' 2>/dev/null || true)"
if printf "%s" "$unauthorized_target" | grep -q 'target_not_allowed'; then
  ok "selector outside the two-provider policy is denied with target_not_allowed"
else
  fail "unauthorized provider target was not denied as expected (got '${unauthorized_target}')"
  exit 1
fi

narrow_payload="$(prompt_grant_payload 'e2e-unlisted-caller')"
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$narrow_payload" >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" != "200" ]; then
  fail "failed to narrow promptBridge grant for caller_not_allowed probe (HTTP ${ADMIN_CURL_HTTP_STATUS:-unknown}; response body redacted)"
  exit 1
fi

deny_caller="$(kctl exec "$caller_pod" -n "$SANDBOX_NS" -- env "E2E_PROBE_RUN_ID=${E2E_PROBE_RUN_ID}" node -e '
fetch(process.env.PLUGIN_WORKLOAD_SDK_ENDPOINT + "/v1/prompt-bridge", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + process.env.PLUGIN_WORKLOAD_SDK_TOKEN,
  },
  body: JSON.stringify({
    purpose: "summarization",
    idempotencyKey: "e2e-deny-caller-" + process.env.E2E_PROBE_RUN_ID,
    messages: [{ role: "user", content: "x" }],
  }),
}).then(async r => { const b = await r.json().catch(() => ({})); console.log(r.status + ":" + (b.error || "")); process.exit(0) })
  .catch(() => { console.log("ERR"); process.exit(0) })
' 2>/dev/null || true)"
if printf "%s" "$deny_caller" | grep -q 'caller_not_allowed'; then
  ok "token-bound caller excluded from grant is denied with caller_not_allowed"
else
  fail "caller_not_allowed probe failed (got '${deny_caller}')"
  exit 1
fi

create_grant promptBridge >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" != "200" ]; then
  fail "failed to restore promptBridge grant after caller_not_allowed probe (status=${ADMIN_CURL_HTTP_STATUS})"
  exit 1
fi
ok "restored promptBridge grant after caller_not_allowed probe"

header "Authorized happy path"

reset_sdk_runtime_state_for_happy_path
ok "reset SDK invocation/quota/delivery state before happy-path fixture"

# Restart the caller so the fixture re-runs against the restored grants.
if ! stop_sdk_caller_fixture; then
  fail "sdk-caller did not come back ready after grants"
  exit 1
fi
ok "sdk-caller restarted after grants for happy-path fixture"

# The caller prints structured markers; wait for happy-path before idempotency/quota finish.
logs="$(wait_for_caller_logs_matching E2E_SDK_CLIENT_NOTIFICATION_OK "$E2E_WAIT_CALLER_MARKER" || true)"

if printf "%s" "$logs" | grep -q E2E_SDK_PROMPT_BRIDGE_OK; then
  ok "sdk-caller promptBridge call was authorized (invocationId returned)"
else
  fail "sdk-caller promptBridge call did not succeed within ${E2E_WAIT_CALLER_MARKER}s (fixture marker missing; caller logs redacted)"
  exit 1
fi

if printf "%s" "$logs" | grep -q E2E_SDK_EXPLICIT_TARGET_OK; then
  ok "sdk-caller explicit approved targetRef was served and returned non-empty content"
else
  fail "sdk-caller explicit approved targetRef did not return a served target/content marker"
  exit 1
fi

if printf "%s" "$logs" | grep -q E2E_SDK_CLIENT_NOTIFICATION_OK; then
  ok "sdk-caller clientNotifications call was accepted (notificationId returned)"
else
  fail "sdk-caller clientNotifications call did not succeed within ${E2E_WAIT_CALLER_MARKER}s (fixture marker missing; caller logs redacted)"
  exit 1
fi

logs="$(wait_for_caller_logs_matching E2E_SDK_DONE "$E2E_WAIT_CALLER_DONE" || true)"
if ! printf "%s" "$logs" | grep -q E2E_SDK_DONE; then
  fail "sdk-caller fixture did not finish within ${E2E_WAIT_CALLER_DONE}s"
  exit 1
fi

NOTIFICATION_ID="$(printf '%s' "$logs" | sed -n 's/.*E2E_SDK_CLIENT_NOTIFICATION_OK=\([^[:space:]]*\).*/\1/p' | tail -1)"
if [ -z "$NOTIFICATION_ID" ]; then
  fail "could not parse notificationId from sdk-caller logs"
  exit 1
fi
NOTIFICATION_DEDUPE_KEY="${NOTIFICATION_ID}:plugin_workload_sdk.notification"

delivery_row="$(wait_for_notification_delivery_row "$NOTIFICATION_ID" "$E2E_WAIT_NOTIFICATION_ROW" || true)"
if printf "%s" "$delivery_row" | grep -Eq "plugin_workload_sdk.notification\|(queued|retrying)\|${USER_REF}"; then
  ok "notification_deliveries queued for desktop stream (audience.userId=${USER_REF})"
else
  fail "notification_deliveries row missing or mis-targeted within ${E2E_WAIT_NOTIFICATION_ROW}s (got '${delivery_row}')"
  exit 1
fi

header "Desktop grace + channel fallback eligibility"

if notifications_desktop_first_enabled >/dev/null; then
  # Assert the grace deferral relative to the row's own created_at, NOT to a live
  # NOW(). Both columns are stamped in the same INSERT statement (deferred branch:
  # next_attempt_at = NOW() + grace; ELSE branch: next_attempt_at = NOW()), so
  # next_attempt_at > created_at proves the desktop-first grace window was applied.
  # Comparing against a live NOW() here is racy: the caller fixture's preceding
  # promptBridge / idempotency / quota steps can consume more than the grace
  # window before this assertion runs, expiring it and masking a correct deferral.
  grace_active="$(psql_query "SELECT (next_attempt_at > created_at)::text FROM notification_deliveries WHERE dedupe_key='${NOTIFICATION_DEDUPE_KEY}';" \
    | tr -d '[:space:]')"
  if is_psql_true "$grace_active"; then
    ok "desktop-first grace window deferred channel fallback (next_attempt_at > created_at)"
  else
    fail "notification_deliveries next_attempt_at was not deferred for desktop grace (got '${grace_active}')"
    exit 1
  fi

  psql_query "UPDATE notification_deliveries SET next_attempt_at = NOW() - INTERVAL '10 seconds' WHERE dedupe_key='${NOTIFICATION_DEDUPE_KEY}';" >/dev/null 2>&1

  fallback_eligible="$(psql_query "SELECT (next_attempt_at <= NOW() AND status IN ('queued','retrying'))::text FROM notification_deliveries WHERE dedupe_key='${NOTIFICATION_DEDUPE_KEY}';" \
    | tr -d '[:space:]')"
  if is_psql_true "$fallback_eligible"; then
    ok "channel fallback claim window opened after grace expiry"
  else
    fail "notification remained ineligible for channel fallback after grace expiry (got '${fallback_eligible}')"
    exit 1
  fi
else
  warn "NOTIFICATIONS_DESKTOP_FIRST_ENABLED=false — skipping desktop grace + fallback eligibility checks"
fi

header "Notification preferences PUT contract"

desktop_session_token="$(obtain_desktop_session_token "$E2E_DESKTOP_USER_EMAIL" "$E2E_DESKTOP_PASSWORD" || true)"
if [ -z "$desktop_session_token" ]; then
  fail "could not obtain desktop session token for ${E2E_DESKTOP_USER_EMAIL} (HTTP ${ADMIN_CURL_HTTP_STATUS:-unknown} via ${E2E_EXTERNAL_REST_API_URL}; response body redacted)"
  exit 1
fi
ok "obtained desktop session token for notification-preferences checks"

if ! snapshot_notification_preferences; then
  fail "could not snapshot notification preferences for ${USER_REF}"
  exit 1
fi
ok "snapshotted notification preferences before the contract PUT checks"

session_curl PUT "/external/me/notification-preferences" "$desktop_session_token" '{"preferredMedium":"telegram"}' >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" = "400" ] &&
   printf '%s' "$ADMIN_CURL_BODY" | grep -q 'invalid_channel_fallback_enabled'; then
  ok "partial PUT without channelFallbackEnabled is rejected with invalid_channel_fallback_enabled"
else
  fail "partial notification-preferences PUT was not rejected as expected (HTTP ${ADMIN_CURL_HTTP_STATUS:-unknown}; response body redacted)"
  exit 1
fi

session_curl PUT "/external/me/notification-preferences" "$desktop_session_token" '{"channelFallbackEnabled":true}' >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" = "400" ] &&
   printf '%s' "$ADMIN_CURL_BODY" | grep -q 'invalid_preferred_medium'; then
  ok "partial PUT without preferredMedium is rejected with invalid_preferred_medium"
else
  fail "partial notification-preferences PUT without preferredMedium was not rejected as expected (HTTP ${ADMIN_CURL_HTTP_STATUS:-unknown}; response body redacted)"
  exit 1
fi

session_curl PUT "/external/me/notification-preferences" "$desktop_session_token" '{"preferredMedium":null,"channelFallbackEnabled":false}' >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" != "200" ]; then
  fail "full notification-preferences PUT expected HTTP 200, got ${ADMIN_CURL_HTTP_STATUS:-unknown} (response body redacted)"
  exit 1
fi

prefs_fallback="$(psql_query "SELECT channel_fallback_enabled::text FROM user_notification_preferences WHERE user_id='${USER_REF}'::uuid;" \
  | tr -d '[:space:]')"
if is_psql_false "$prefs_fallback"; then
  ok "user_notification_preferences.channel_fallback_enabled persisted as false after full PUT"
else
  fail "user_notification_preferences.channel_fallback_enabled was not persisted as false (got '${prefs_fallback}')"
  exit 1
fi

# Audit trail: both invocations recorded.
invocations="$(admin_curl GET "/api/v1/admin/plugin-workload-sdk/invocations?recipeName=${RECIPE_NAME}" || true)"
if printf "%s" "$invocations" | grep -q '"method":"promptBridge"' &&
   printf "%s" "$invocations" | grep -q '"method":"clientNotifications"'; then
  ok "invocation audit trail contains both promptBridge and clientNotifications records"
else
  fail "invocation audit trail is missing SDK records"
  exit 1
fi

# ─── idempotency + quota enforcement ─────────────────────────────────────

# Idempotency: a completed prompt replay is guarded before the provider seam.
# The current public SDK route returns idempotency_conflict because completion
# content is not persisted for replay; the audit record and quota reservation
# remain stable, and the fixture's subsequent quota phase proves no second
# provider charge was made.
if printf "%s" "$logs" | grep -q E2E_SDK_IDEMPOTENCY_REPLAY_GUARDED; then
  ok "idempotency replay was guarded without a second provider call or quota charge"
else
  fail "idempotency replay was not guarded as expected (fixture marker missing; caller logs redacted)"
  exit 1
fi

# Quota enforcement: N+1 call is rejected after quota exhausted.
if printf "%s" "$logs" | grep -q E2E_SDK_QUOTA_EXCEEDED_OK; then
  ok "quota enforcement correctly rejected call after 4/4 requests consumed"
else
  fail "quota enforcement did not reject the excess call (fixture marker missing; caller logs redacted)"
  exit 1
fi

print_results
exit 0
