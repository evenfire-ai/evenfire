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
# run only when E2E_ADMIN_TOKEN is set. Without it, the gate still asserts the
# infrastructure invariants (status, Secret, env, NetworkPolicies) that need
# no admin credentials. Obtain a token from the seeded minikube admin
# (scripts/minikube/seed-test-data.sh) and export E2E_ADMIN_TOKEN.
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-plugin-workload-sdk.sh
#   bash scripts/e2e/e2e-plugin-workload-sdk.sh --cleanup-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

RECIPE_NAME="e2e-plugin-workload-sdk"
WORKLOAD_ID="sdk-caller"
EVENT_TYPE="e2e.test.notification"
E2E_DESKTOP_USER_EMAIL="${E2E_DESKTOP_USER_EMAIL:-${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}}"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-5.1}}"
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
# Hard ceiling for the entire gate (default 15m). Override with E2E_GATE_MAX_SECONDS.
E2E_GATE_MAX_SECONDS="${E2E_GATE_MAX_SECONDS:-900}"
E2E_GATE_STARTED_AT=$SECONDS
# Per-phase wait ceilings (seconds).
E2E_WAIT_STATUS_VALIDATED="${E2E_WAIT_STATUS_VALIDATED:-120}"
E2E_WAIT_CALLER_MARKER="${E2E_WAIT_CALLER_MARKER:-180}"
E2E_WAIT_CALLER_DONE="${E2E_WAIT_CALLER_DONE:-180}"
E2E_WAIT_NOTIFICATION_ROW="${E2E_WAIT_NOTIFICATION_ROW:-60}"

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

cleanup_sdk_recipe() {
  local cleanup_status=0
  cleanup_plugin_workload_sdk_db
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_status=1
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" || cleanup_status=1
  # WRC sweeps Deployments, Secrets, ConfigMaps and NetworkPolicies by the
  # recipe label on finalization; give it a moment, then best-effort prune the
  # named pods that may linger.
  kctl delete pod "${RECIPE_NAME}-mcp-host" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  return "$cleanup_status"
}

cleanup_on_exit() {
  local status=$?
  if [ "${e2e_total:-0}" -gt 0 ] && [ "${E2E_SUPPRESS_RESULTS:-0}" != "1" ]; then
    print_results || true
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
  cleanup_sdk_recipe
  exit $?
fi

trap cleanup_on_exit EXIT

# ─── control-api admin helpers (exec curl inside the control-api pod) ─────

control_api_pod() {
  ready_pod_name "$CONTROL_NS" "app=control-api" 2>/dev/null \
    || ready_pod_name "$CONTROL_NS" "app.kubernetes.io/name=control-api" 2>/dev/null
}

# admin_curl METHOD PATH [JSON_BODY]
# Runs node fetch inside the control-api pod against localhost:8090 with the
# E2E_ADMIN_TOKEN bearer. Sets ADMIN_CURL_HTTP_STATUS + ADMIN_CURL_BODY and
# echoes the body for callers that only need the payload.
admin_curl() {
  local method=$1 path=$2 body=${3:-} pod response
  pod="$(control_api_pod)" || return 1
  response="$(kctl exec "$pod" -n "$CONTROL_NS" -- node -e '
    const method = process.argv[1]
    const url = "http://localhost:8090" + process.argv[2]
    const token = process.argv[3]
    const body = process.argv[4] || null
    fetch(url, {
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body,
    }).then(async r => {
      const text = await r.text()
      process.stdout.write(String(r.status) + "\t" + text)
      process.exit(0)
    }).catch(e => { process.stderr.write(e.message); process.exit(1) })
  ' "$method" "$path" "$E2E_ADMIN_TOKEN" "$body")"
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
  response="$(curl -sS -w '\n%{http_code}' -X POST \
    "${E2E_EXTERNAL_REST_API_URL}/api/v1/auth/password-login" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$email" --arg p "$password" '{email: $e, password: $p}')" \
    2>/dev/null || true)"
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
    payload='{"recipeNamespace":"sandbox-recipes","recipeName":"'"$RECIPE_NAME"'","capabilityFamily":"promptBridge","allowedModels":["'"$E2E_WORKFLOW_MODEL_NAME"'"],"allowedCallers":["'"$WORKLOAD_ID"'"],"quotaLimits":{"maxRequestsPerRun":3}}'
  else
    payload='{"recipeNamespace":"sandbox-recipes","recipeName":"'"$RECIPE_NAME"'","capabilityFamily":"clientNotifications","allowedEventTypes":["'"$EVENT_TYPE"'"],"allowedUserRefs":["'"$USER_REF"'"],"allowedCallers":["'"$WORKLOAD_ID"'"],"quotaLimits":{"maxNotificationsPerRun":10}}'
  fi
  admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$payload"
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

if [ -z "$E2E_ADMIN_TOKEN" ]; then
  warn "E2E_ADMIN_TOKEN not set — skipping grant creation, SDK call, and audit assertions."
  warn "Export E2E_ADMIN_TOKEN (seeded minikube admin) to run the full happy path."
  print_results
  exit 0
fi

header "Admin grant guardrails"

wildcard_payload='{"recipeNamespace":"'"$RECIPE_NS"'","recipeName":"'"$RECIPE_NAME"'","capabilityFamily":"promptBridge","allowedModels":["*"],"allowedCallers":["'"$WORKLOAD_ID"'"]}'
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$wildcard_payload" >/dev/null || true
wildcard_status="$ADMIN_CURL_HTTP_STATUS"
wildcard_body="$ADMIN_CURL_BODY"
if [ "$wildcard_status" = "400" ] && printf '%s' "$wildcard_body" | grep -q 'wildcard_not_allowed'; then
  ok "admin API rejects wildcard allowlists with wildcard_not_allowed"
else
  fail "wildcard grant was not rejected as expected (status=${wildcard_status}, body=${wildcard_body})"
  exit 1
fi

empty_models_payload='{"recipeNamespace":"'"$RECIPE_NS"'","recipeName":"'"$RECIPE_NAME"'","capabilityFamily":"promptBridge","allowedModels":[],"allowedCallers":["'"$WORKLOAD_ID"'"]}'
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$empty_models_payload" >/dev/null || true
empty_models_status="$ADMIN_CURL_HTTP_STATUS"
empty_models_body="$ADMIN_CURL_BODY"
if [ "$empty_models_status" = "400" ] && printf '%s' "$empty_models_body" | grep -q 'allowedModels must be non-empty'; then
  ok "admin API rejects promptBridge grants without an explicit model"
else
  fail "empty-model promptBridge grant was not rejected as expected (status=${empty_models_status}, body=${empty_models_body})"
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

create_grant promptBridge >/dev/null && ok "created promptBridge grant" || { fail "promptBridge grant creation failed"; exit 1; }
create_grant clientNotifications >/dev/null && ok "created clientNotifications grant" || { fail "clientNotifications grant creation failed"; exit 1; }

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

narrow_payload='{"recipeNamespace":"'"$RECIPE_NS"'","recipeName":"'"$RECIPE_NAME"'","capabilityFamily":"promptBridge","allowedModels":["'"$E2E_WORKFLOW_MODEL_NAME"'"],"allowedCallers":["e2e-unlisted-caller"],"quotaLimits":{"maxRequestsPerRun":3}}'
admin_curl POST "/api/v1/admin/plugin-workload-sdk/grants" "$narrow_payload" >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" != "200" ]; then
  fail "failed to narrow promptBridge grant for caller_not_allowed probe (status=${ADMIN_CURL_HTTP_STATUS}, body=${ADMIN_CURL_BODY})"
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
  fail "sdk-caller promptBridge call did not succeed within ${E2E_WAIT_CALLER_MARKER}s: $(printf '%s' "$logs" | grep E2E_SDK_PROMPT_BRIDGE || true)"
  exit 1
fi

if printf "%s" "$logs" | grep -q E2E_SDK_CLIENT_NOTIFICATION_OK; then
  ok "sdk-caller clientNotifications call was accepted (notificationId returned)"
else
  fail "sdk-caller clientNotifications call did not succeed within ${E2E_WAIT_CALLER_MARKER}s: $(printf '%s' "$logs" | grep E2E_SDK_CLIENT_NOTIFICATION || true)"
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
  fail "could not obtain desktop session token for ${E2E_DESKTOP_USER_EMAIL} (HTTP ${ADMIN_CURL_HTTP_STATUS} via ${E2E_EXTERNAL_REST_API_URL}: ${ADMIN_CURL_BODY})"
  exit 1
fi
ok "obtained desktop session token for notification-preferences checks"

session_curl PUT "/external/me/notification-preferences" "$desktop_session_token" '{"preferredMedium":"telegram"}' >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" = "400" ] &&
   printf '%s' "$ADMIN_CURL_BODY" | grep -q 'invalid_channel_fallback_enabled'; then
  ok "partial PUT without channelFallbackEnabled is rejected with invalid_channel_fallback_enabled"
else
  fail "partial notification-preferences PUT was not rejected as expected (status=${ADMIN_CURL_HTTP_STATUS}, body=${ADMIN_CURL_BODY})"
  exit 1
fi

session_curl PUT "/external/me/notification-preferences" "$desktop_session_token" '{"channelFallbackEnabled":true}' >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" = "400" ] &&
   printf '%s' "$ADMIN_CURL_BODY" | grep -q 'invalid_preferred_medium'; then
  ok "partial PUT without preferredMedium is rejected with invalid_preferred_medium"
else
  fail "partial notification-preferences PUT without preferredMedium was not rejected as expected (status=${ADMIN_CURL_HTTP_STATUS}, body=${ADMIN_CURL_BODY})"
  exit 1
fi

session_curl PUT "/external/me/notification-preferences" "$desktop_session_token" '{"preferredMedium":null,"channelFallbackEnabled":false}' >/dev/null || true
if [ "$ADMIN_CURL_HTTP_STATUS" != "200" ]; then
  fail "full notification-preferences PUT expected HTTP 200, got ${ADMIN_CURL_HTTP_STATUS}: ${ADMIN_CURL_BODY}"
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

# Idempotency: same idempotencyKey returns same invocationId without consuming quota.
if printf "%s" "$logs" | grep -q E2E_SDK_IDEMPOTENCY_OK; then
  ok "idempotency replay returned same invocationId (no extra quota consumed)"
else
  fail "idempotency replay did not return same invocationId: $(printf '%s' "$logs" | grep E2E_SDK_IDEMPOTENCY || true)"
  exit 1
fi

# Quota enforcement: N+1 call is rejected after quota exhausted.
if printf "%s" "$logs" | grep -q E2E_SDK_QUOTA_EXCEEDED_OK; then
  ok "quota enforcement correctly rejected call after 3/3 requests consumed"
else
  fail "quota enforcement did not reject excess call: $(printf '%s' "$logs" | grep E2E_SDK_QUOTA_EXCEEDED || true)"
  exit 1
fi

print_results
exit 0
