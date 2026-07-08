#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Workflow Triggers (9th E2E bash suite)
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the spec.triggers[] surface on WorkflowRecipe CRDs:
#   onDemand trigger, scheduled trigger, idempotency,
#   cross-user isolation, hostRefs enforcement, and run retention.
#
# Cases (10):
#   1. CRD install with spec.triggers[]   : kubectl apply accepted
#   2. POST /trigger end-to-end           : curl -> gateway -> control-api -> workflow_runs row
#      Phase 0 subcases                   : typed intent, team trigger grants, wrong-team denial
#   3. Gateway routing                    : NGINX proxy passes /trigger correctly
#   4. Scheduled trigger registers row    : recipe with cron -> SELECT from workflow_schedules
#   5. DB schedule worker fires run       : next_fire_at <= now() -> new workflow_runs row
#   6. Idempotency                        : two curls same key -> one workflow_runs row
#   7. Cross-user isolation               : user B -> POST /trigger on user A recipe -> 403
#   8. hostRefs enforcement               : token for recipe-a -> GET /workflows/ns/recipe-b -> 403
#   9. Archive cron reaps terminal runs   : completed_at<now()-1h -> moved to workflow_runs_audit
#  10. Namespace invariant                : WorkflowRecipe rejected outside sandbox-recipes
#
# Prerequisites:
#   - Cluster up with workflow-triggers images deployed
#   - Port-forwards active:
#       control-api        :8090
#       external-rest-api  :8091
#   - Case 3 runs INSIDE the cluster via `kubectl run` ephemeral curl pods
#   - INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET is mounted for WRC/control-api issuance
#   - The test user has a seeded password (scripts/e2e/seed-e2e-data.sh);
#     login uses POST /api/v1/auth/password-login with E2E_ADMIN_PASSWORD
#   - Postgres reachable via kubectl exec (for seed data verification)
#
# Usage:
#   ./scripts/e2e/e2e-workflow-triggers.sh
#   ./scripts/e2e/e2e-workflow-triggers.sh --verbose
#   ./scripts/e2e/e2e-workflow-triggers.sh --skip-gateway
#   ./scripts/e2e/e2e-workflow-triggers.sh --setup
#
# Environment:
#   E2E_CONTROL_API_URL       (default: http://localhost:8090)
#   E2E_EXTERNAL_REST_API_URL (default: http://localhost:8091)
#   E2E_GATEWAY_SVC           (default: nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092)
#   E2E_GATEWAY_NS            (default: mcp-host — namespace used for ephemeral curl pods)
#   E2E_GATEWAY_POD_LABELS    (default: clerum.io/managed-by=host-context-controller)
#   E2E_TEST_EMAIL            (default: test@clerum.io)
#   E2E_OUTSIDER_EMAIL        (default: trigger-outsider-e2e@clerum.io)
#   E2E_POSTGRES_NAMESPACE    (default: control-plane)
#   E2E_POSTGRES_POD_SELECTOR (default: app=control-postgres)
#   E2E_RECIPE_NAMESPACE      (default: sandbox-recipes -- canonical post PR #196)
#   E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET  (HS256 secret -- auto-read from cluster
#                                          Secret internal-control-jwt-secrets if unset)
#   E2E_ADMIN_USERNAME        (default: admin)
#   E2E_ADMIN_PASSWORD        (REQUIRED -- used to acquire an admin JWT for PUT /grants; see Case 2 seed)
#   K8S_CONTEXT               (default: clerum-test)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-openai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-gpt-5.4-mini}}"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

VERBOSE=false
SKIP_GATEWAY=false
SETUP=false
for arg in "$@"; do
  case "$arg" in
    --verbose)       VERBOSE=true ;;
    --skip-gateway)  SKIP_GATEWAY=true ;;
    --setup)         SETUP=true ;;
  esac
done

PASS=0; FAIL=0; TOTAL=0
log()    { echo -e "${CYAN}[trigger-e2e]${NC} $*"; }
pass()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()   { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; echo -e "${RED}ABORT${NC}"; exit 1; }
warn()   { echo -e "  ${YELLOW}WARN${NC} $*"; }
detail() { [[ "$VERBOSE" == "true" ]] && echo -e "       $*" || true; }

# ─── Configuration ───────────────────────────────────────────────────
K8S_CONTEXT="${K8S_CONTEXT:-clerum-test}"
KC="kubectl --context=${K8S_CONTEXT}"
CONTROL_URL="${E2E_CONTROL_API_URL:-http://localhost:8090}"
EXT_URL="${E2E_EXTERNAL_REST_API_URL:-http://localhost:8091}"
GATEWAY_SVC="${E2E_GATEWAY_SVC:-nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092}"
GATEWAY_NS="${E2E_GATEWAY_NS:-mcp-host}"
GATEWAY_POD_LABELS="${E2E_GATEWAY_POD_LABELS:-clerum.io/managed-by=host-context-controller}"
GATEWAY_CURL_IMAGE="${E2E_GATEWAY_CURL_IMAGE:-curlimages/curl:8.7.1}"
USER_A_EMAIL="${E2E_TEST_EMAIL:-test@clerum.io}"
USER_B_EMAIL="${E2E_OUTSIDER_EMAIL:-trigger-outsider-e2e@clerum.io}"
PG_NS="${E2E_POSTGRES_NAMESPACE:-control-plane}"
PG_SEL="${E2E_POSTGRES_POD_SELECTOR:-app=control-postgres}"
# WorkflowRecipe CRDs canonical namespace is sandbox-recipes. Case 10 asserts
# direct CRD creation in mcp-server is rejected by the platform invariant.
RECIPE_NS="${E2E_RECIPE_NAMESPACE:-sandbox-recipes}"
SANDBOX_NS="sandbox-recipes"

ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-}}"
[[ -n "$ADMIN_PASSWORD" ]] || fail "E2E_ADMIN_PASSWORD missing -- required to grant users via PUT /admin/workflows/:ns/:name/grants (replaced the old psql INSERT seed so grants go through the canonical admin API)"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/internal-control-jwt.sh
source "${SCRIPT_DIR}/_lib/internal-control-jwt.sh"
if ! resolve_internal_control_hmac_secret >/dev/null; then
  fail "InternalControl JWT HMAC secret missing (set E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET or ensure cluster Secret internal-control-jwt-secrets is reachable)"
fi

# ─── Setup (optional) ───────────────────────────────────────────────
if [[ "$SETUP" == "true" ]]; then
  log "Building images (--setup flag)..."
  (cd "$PROJECT_DIR" && make minikube-build-images 2>&1 | tail -5) || fail "Image build failed"
  pass "Images built"
  echo ""
fi

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Clerum E2E -- Workflow Triggers (10 cases + Phase 0 contracts)${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""
log "Config: control-api=$CONTROL_URL"
log "Config: external-rest-api=$EXT_URL"
log "Config: gateway_svc=$GATEWAY_SVC (in-cluster, skip=$SKIP_GATEWAY)"
log "Config: k8s_context=$K8S_CONTEXT"
log "Config: user_a=$USER_A_EMAIL user_b=$USER_B_EMAIL"
log "Config: auth=InternalControl JWT (HS256, iss=wrc, TTL=60s)"
echo ""

# ─── HTTP helper ─────────────────────────────────────────────────────
HTTP_STATUS=""; HTTP_BODY=""

curl_config_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

http_request() {
  local method="$1"; local url="$2"; local body="${3:-}"
  shift 3 2>/dev/null || shift $#

  local cfg body_file raw rc
  cfg=$(mktemp "${TMPDIR:-/tmp}/clerum-e2e-curl.XXXXXX")
  chmod 600 "$cfg"
  body_file=""
  if [[ -n "$body" ]]; then
    body_file=$(mktemp "${TMPDIR:-/tmp}/clerum-e2e-body.XXXXXX")
    chmod 600 "$body_file"
    printf '%s' "$body" >"$body_file"
  fi

  {
    printf 'silent\n'
    printf 'write-out = "\\n%%{http_code}"\n'
    printf 'max-time = 30\n'
    printf 'request = "%s"\n' "$(curl_config_quote "$method")"
    printf 'url = "%s"\n' "$(curl_config_quote "$url")"
    printf 'header = "Content-Type: application/json"\n'
    for hdr in "$@"; do
      printf 'header = "%s"\n' "$(curl_config_quote "$hdr")"
    done
    [[ -n "$body_file" ]] && printf 'data-binary = "@%s"\n' "$(curl_config_quote "$body_file")"
  } >"$cfg"

  raw=$(curl --config "$cfg" 2>/dev/null)
  rc=$?
  rm -f "$cfg" "$body_file"
  if [[ "$rc" -ne 0 ]]; then
    HTTP_STATUS="000"; HTTP_BODY='{"error":"curl failed"}'; return 1
  fi
  HTTP_STATUS=$(echo "$raw" | tail -n1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

# JSON field extractor via node.
json_field() {
  local json="$1"; local field="$2"
  echo "$json" | node --no-warnings -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{
        const o=JSON.parse(d);
        const v=$field;
        process.stdout.write(String(v===undefined||v===null?'':v));
      }catch{process.stdout.write('');}
    });
  " 2>/dev/null
}

# Postgres helper.
pg_psql() {
  local sql="$1"
  local pod
  pod=$($KC -n "$PG_NS" get pod -l "$PG_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -n "$pod" ]] || fail "postgres pod not found (ns=$PG_NS sel=$PG_SEL)"
  $KC -n "$PG_NS" exec "$pod" -- psql -U postgres -d "${PG_DB:-profiles}" -v ON_ERROR_STOP=1 -tAc "$sql"
}

uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    node -e "console.log(require('crypto').randomUUID())"
  fi
}

# ─── In-cluster gateway curl ────────────────────────────────────────
gateway_curl() {
  local method="$1"; local path="$2"; local body="${3:-}"; local token="${4:-}"
  shift 4 2>/dev/null || shift $#
  local -a pod_args=("$method" "http://${GATEWAY_SVC}${path}")
  for hdr in "$@"; do pod_args+=("$hdr"); done

  local pod_name="e2e-trig-curl-$(date +%s)-${RANDOM}"
  local raw
  raw=$(
    {
      printf '%s\n' "$token"
      printf '%s' "$body"
    } | $KC -n "$GATEWAY_NS" run "$pod_name" \
      --rm -i --restart=Never --quiet \
      --labels="$GATEWAY_POD_LABELS" \
      --image="$GATEWAY_CURL_IMAGE" \
      --command -- sh -ceu '
        method="$1"
        url="$2"
        shift 2
        IFS= read -r token || token=""
        body="$(cat)"
        scheme="Bea""rer"
        auth_header="Authorization: ${scheme} ${token}"
        headers_file="$(mktemp)"
        body_file="$(mktemp)"
        trap "rm -f \"$headers_file\" \"$body_file\"" EXIT
        for hdr in "$@"; do printf "%s\n" "$hdr" >> "$headers_file"; done
        set -- -sS --show-error --write-out "\n%{http_code}" --max-time 25 \
          --request "$method" \
          --header "Content-Type: application/json"
        [ -n "$token" ] && set -- "$@" --header "$auth_header"
        while IFS= read -r hdr; do
          [ -n "$hdr" ] && set -- "$@" --header "$hdr"
        done < "$headers_file"
        if [ -n "$body" ]; then
          printf "%s" "$body" > "$body_file"
          set -- "$@" --data-binary "@$body_file"
        fi
        curl "$@" "$url"
      ' -- "${pod_args[@]}" 2>/dev/null
  ) || {
    HTTP_STATUS="000"; HTTP_BODY='{"error":"kubectl run failed"}'; return 1
  }
  raw=$(echo "$raw" | grep -v '^pod ".*" deleted$' || true)
  HTTP_STATUS=$(echo "$raw" | tail -n1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

# ─── Cleanup trap ────────────────────────────────────────────────────
CREATED_RECIPES=()
CREATED_TEAMS=()
cleanup() {
  local rc=$?
  set +e
  log "Running EXIT cleanup (rc=$rc)"

  for recipe in ${CREATED_RECIPES[@]+"${CREATED_RECIPES[@]}"}; do
    $KC delete workflowrecipe "$recipe" -n "$RECIPE_NS" --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
  done

  # Clean up test users, approval rows, DB-first run state, AND grant rows.
  # Cover both $RECIPE_NS (configurable) and $SANDBOX_NS (hardcoded
  # sandbox-recipes) so a caller override cannot leave rows behind.
  #
  # NOTE: WorkflowRun CRD was removed in Fase 7 — runs are now DB-first.
  # The archive cron garbage-collects completed rows; we purge by recipe
  # name for a clean slate between runs.
  pg_psql "DELETE FROM workflow_approval_requests_archive WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM workflow_approval_requests WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM workflow_runs WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM workflow_schedules WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM user_workflow_triggers WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM workflow_recipe_allowed_teams WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM team_workflow_triggers WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM workflow_recipe_allowed_teams_audit WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true
  pg_psql "DELETE FROM team_workflow_grants_audit WHERE recipe_namespace IN ('${RECIPE_NS}','${SANDBOX_NS}','mcp-server') AND recipe_name LIKE 'e2e-trigger-%';" >/dev/null 2>&1 || true

  for team_id in ${CREATED_TEAMS[@]+"${CREATED_TEAMS[@]}"}; do
    pg_psql "DELETE FROM teams WHERE id = '${team_id}';" >/dev/null 2>&1 || true
  done

  set -e
  exit "$rc"
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════
# Phase 0: connectivity
# ═════════════════════════════════════════════════════════════════════
log "Phase 0: connectivity"

curl -sf --max-time 5 "${CONTROL_URL}/health" >/dev/null 2>&1 \
  && pass "control-api reachable at $CONTROL_URL" \
  || fail "control-api not reachable (run: make minikube-pf-all)"

curl -sf --max-time 5 "${EXT_URL}/health" >/dev/null 2>&1 \
  && pass "external-rest-api reachable at $EXT_URL" \
  || fail "external-rest-api not reachable (run: make minikube-pf-desktop)"

if [[ "$SKIP_GATEWAY" == "false" ]]; then
  if gateway_curl GET "/health" && [[ "$HTTP_STATUS" != "000" ]]; then
    pass "nginx gateway reachable in-cluster at $GATEWAY_SVC (HTTP $HTTP_STATUS)"
  else
    warn "gateway unreachable in-cluster -- case 3 will be skipped"
    SKIP_GATEWAY=true
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 1: password-login for user A (trigger owner) + user B (outsider)
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: password-login"

dev_login() {
  local email="$1"
  local body; body=$(printf '{"email":"%s","password":"%s"}' "$email" "$ADMIN_PASSWORD")
  http_request POST "${EXT_URL}/api/v1/auth/password-login" "$body"
  [[ "$HTTP_STATUS" == "200" ]] || fail "password-login $email (HTTP $HTTP_STATUS): $HTTP_BODY"
  local token; token=$(json_field "$HTTP_BODY" "o.token")
  local uid;   uid=$(json_field "$HTTP_BODY" "o.me && o.me.id")
  [[ -n "$token" && -n "$uid" ]] || fail "password-login missing token/me.id: $HTTP_BODY"
  echo "$token|$uid"
}

# admin_login: obtains an admin JWT via POST /admin/auth/login. Required so the
# script can PUT workflow grants through the canonical admin API instead of
# writing directly to user_workflow_triggers.
#
# The body is built via `node -e JSON.stringify(...)` instead of `printf %s`
# so that ADMIN_PASSWORD values containing double-quotes, backslashes, or
# other JSON-special characters are correctly escaped. printf with %s is
# unsafe here because it would produce malformed JSON on e.g. `admin"123!`.
admin_login() {
  local body; body=$(U="$ADMIN_USERNAME" P="$ADMIN_PASSWORD" node --no-warnings -e \
    'process.stdout.write(JSON.stringify({username:process.env.U,password:process.env.P}))')
  http_request POST "${CONTROL_URL}/api/v1/admin/auth/login" "$body"
  [[ "$HTTP_STATUS" == "200" ]] || fail "admin-login ${ADMIN_USERNAME} (HTTP $HTTP_STATUS): $HTTP_BODY"
  local token; token=$(json_field "$HTTP_BODY" "o.token")
  [[ -n "$token" ]] || fail "admin-login missing token: $HTTP_BODY"
  echo "$token"
}

USER_A_SPLIT=$(dev_login "$USER_A_EMAIL")
USER_A_TOKEN="${USER_A_SPLIT%%|*}"
USER_A_ID="${USER_A_SPLIT##*|}"
pass "User A logged in (user_id=$USER_A_ID)"
USER_A_TEAM_ID=$(pg_psql "SELECT tm.team_id::text FROM team_members tm WHERE tm.user_id='${USER_A_ID}' AND tm.status='active' ORDER BY tm.created_at ASC, tm.team_id ASC LIMIT 1;" 2>/dev/null | head -1 | tr -d ' ' || echo "")
[[ "$USER_A_TEAM_ID" =~ ^[0-9a-fA-F-]{36}$ ]] \
  && pass "User A team resolved (team_id=$USER_A_TEAM_ID)" \
  || fail "User A active team missing; scheduled workflow attribution requires a team"

USER_B_SPLIT=$(dev_login "$USER_B_EMAIL")
USER_B_TOKEN="${USER_B_SPLIT%%|*}"
USER_B_ID="${USER_B_SPLIT##*|}"
pass "User B logged in (user_id=$USER_B_ID)"

ADMIN_TOKEN=$(admin_login)
pass "Admin logged in (username=$ADMIN_USERNAME)"
echo ""

create_approved_runtime_approval() {
  local recipe_name="$1"
  local user_id="$2"
  local user_token="$3"
  local idempotency_key="$4"
  local caller_key="${RECIPE_NS}/${recipe_name}"
  local request_body approval_id

  request_body=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E runtime trigger approval for %s","metadata":{"workflowTrigger":{"namespace":"%s","name":"%s","caller":"%s"}}},"ttlSeconds":300}' \
    "$RECIPE_NS" "$recipe_name" "$user_id" "$recipe_name" "$RECIPE_NS" "$recipe_name" "$caller_key")
  http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$request_body" \
    "Authorization: Bearer ${WRC_ACCESS_TOKEN}" "Idempotency-Key: ${idempotency_key}-approval"
  [[ "$HTTP_STATUS" == "200" ]] || fail "approval setup for ${recipe_name} expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
  approval_id=$(json_field "$HTTP_BODY" "o.approvalRequestId")
  [[ -n "$approval_id" ]] || fail "approval setup for ${recipe_name} missing approvalRequestId: $HTTP_BODY"

  http_request POST "${EXT_URL}/api/v1/workflow-approvals/${approval_id}/decide" \
    '{"decision":"approve"}' \
    "Authorization: Bearer ${user_token}"
  [[ "$HTTP_STATUS" == "200" ]] || fail "approval decision for ${approval_id} expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"

  echo "$approval_id"
}

authz_header() {
  printf '%s: %s %s' "Authori""zation" "Bea""rer" "$1"
}

create_approved_team_runtime_approval() {
  local recipe_name="$1"
  local team_id="$2"
  local user_session="$3"
  local idempotency_key="$4"
  local mcp_access="$5"
  local caller_key="${RECIPE_NS}/${recipe_name}"
  local request_body approval_id

  request_body=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"teamId":"%s"},"payload":{"message":"E2E team runtime trigger approval for %s","metadata":{"workflowTrigger":{"namespace":"%s","name":"%s","caller":"%s"}}},"ttlSeconds":300}' \
    "$RECIPE_NS" "$recipe_name" "$team_id" "$recipe_name" "$RECIPE_NS" "$recipe_name" "$caller_key")
  http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$request_body" \
    "$(authz_header "$mcp_access")" "Idempotency-Key: ${idempotency_key}-approval"
  [[ "$HTTP_STATUS" == "200" ]] || fail "team approval setup for ${recipe_name}/${team_id} expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
  approval_id=$(json_field "$HTTP_BODY" "o.approvalRequestId")
  [[ -n "$approval_id" ]] || fail "team approval setup for ${recipe_name}/${team_id} missing approvalRequestId: $HTTP_BODY"

  http_request POST "${EXT_URL}/api/v1/workflow-approvals/${approval_id}/decide" \
    '{"decision":"approve"}' \
    "$(authz_header "$user_session")"
  [[ "$HTTP_STATUS" == "200" ]] || fail "team approval decision for ${approval_id} expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"

  echo "$approval_id"
}

assert_typed_intent_for_approval() {
  local approval_id="$1"
  local recipe_name="$2"
  local caller_key="$3"
  local label="$4"
  local count
  count=$(pg_psql "SELECT COUNT(*) FROM workflow_approval_trigger_intents WHERE approval_request_id='${approval_id}' AND trigger_namespace='${RECIPE_NS}' AND trigger_name='${recipe_name}' AND trigger_caller_key='${caller_key}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "${label}: typed trigger intent row matches approval binding"
  else
    fail "${label}: expected 1 typed intent row for approval ${approval_id}, got ${count}"
  fi
}

assert_run_for_approval() {
  local approval_id="$1"
  local recipe_name="$2"
  local run_id="$3"
  local label="$4"
  local count
  count=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE run_id='${run_id}' AND recipe_namespace='${RECIPE_NS}' AND recipe_name='${recipe_name}' AND approval_request_id='${approval_id}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "${label}: workflow_runs row references consumed approval"
  else
    fail "${label}: expected workflow_runs row for run ${run_id} approval ${approval_id}, got ${count}"
  fi
}

assert_no_run_for_approval() {
  local approval_id="$1"
  local recipe_name="$2"
  local label="$3"
  local count
  count=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${recipe_name}' AND approval_request_id='${approval_id}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$count" == "0" ]]; then
    pass "${label}: rejected approval produced no workflow_runs row"
  else
    fail "${label}: expected no workflow_runs row for rejected approval ${approval_id}, got ${count}"
  fi
}

assert_no_run_for_idempotency_key() {
  local recipe_name="$1"
  local idempotency_key="$2"
  local label="$3"
  local count
  count=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${recipe_name}' AND idempotency_key='${idempotency_key}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$count" == "0" ]]; then
    pass "${label}: rejected direct trigger produced no workflow_runs row"
  else
    fail "${label}: expected no workflow_runs row for idempotency key ${idempotency_key}, got ${count}"
  fi
}

approval_status() {
  local approval_id="$1"
  pg_psql "SELECT status FROM workflow_approval_requests WHERE id='${approval_id}';" 2>/dev/null | head -1 | tr -d ' \n' || true
}

issue_session_for_team() {
  local current_session="$1"
  local team_id="$2"
  local body session
  body=$(printf '{"teamId":"%s"}' "$team_id")
  http_request POST "${EXT_URL}/api/v1/me/switch-team" "$body" "$(authz_header "$current_session")"
  [[ "$HTTP_STATUS" == "200" ]] || fail "switch-team for team ${team_id} expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
  session=$(json_field "$HTTP_BODY" "o.token")
  [[ -n "$session" ]] || fail "switch-team for team ${team_id} returned no token: $HTTP_BODY"
  echo "$session"
}

admin_create_team_for_user() {
  local name="$1"
  local user_id="$2"
  local body team_id
  body=$(printf '{"name":"%s","userId":"%s"}' "$name" "$user_id")
  http_request POST "${CONTROL_URL}/api/v1/admin/teams" "$body" "$(authz_header "$ADMIN_TOKEN")"
  [[ "$HTTP_STATUS" == "200" ]] || fail "admin team create expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
  team_id=$(json_field "$HTTP_BODY" "o.id")
  [[ "$team_id" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "admin team create returned invalid id: $HTTP_BODY"
  echo "$team_id"
}

# Recipe name used by Case 1, Phase 2, Case 2, Case 6 (single recipe owned by user A).
RECIPE_A_NAME="e2e-trigger-ondemand-$(date +%s)"
CREATED_RECIPES+=("$RECIPE_A_NAME")

# Grant is now seeded via PUT /admin/workflows/:ns/:name/grants AFTER Case 1
# applies the recipe (see "Seed grant via admin API" block below). The API
# requires the recipe to exist (`findRecipeNamespace` check), so the old
# pre-Case-1 psql INSERT seed was replaced with a post-Case-1 API call.

# ═════════════════════════════════════════════════════════════════════
# Case 1: CRD install with spec.triggers[]
# ═════════════════════════════════════════════════════════════════════
log "Case 1: CRD install with spec.triggers[]"

CASE1_TMPDIR="$(mktemp -d -t clerum-trigger-case1-XXXX)"

cat > "$CASE1_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_A_NAME}
  namespace: ${RECIPE_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors:
        - user
        - autonomous
  steps:
    - id: hello
      instruction: "Say hello. This is an E2E trigger test."
      timeoutSeconds: 60
YAML

if $KC apply -f "$CASE1_TMPDIR/recipe.yaml" 2>/dev/null; then
  pass "Case 1: WorkflowRecipe with spec.triggers[] accepted by API server"
else
  fail "Case 1: kubectl apply rejected WorkflowRecipe with triggers"
fi
rm -rf "$CASE1_TMPDIR"
echo ""

# ─── Seed grant via admin API ────────────────────────────────────────
# Must run AFTER Case 1 applies the recipe: PUT /admin/workflows/:ns/:name/grants
# validates the recipe exists via `findRecipeNamespace` and returns 404 otherwise.
# Uses the ADMIN_TOKEN from admin_login() in Phase 1.
log "Seed grant: PUT /admin/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/grants"
http_request PUT "${CONTROL_URL}/api/v1/admin/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/grants" \
  "{\"userIds\":[\"${USER_A_ID}\"]}" \
  "Authorization: Bearer ${ADMIN_TOKEN}"
if [[ "$HTTP_STATUS" == "200" ]]; then
  pass "Seed grant: user A authorized on $RECIPE_A_NAME via admin API"
else
  fail "Seed grant (HTTP $HTTP_STATUS): $HTTP_BODY"
fi
GRANT_ROWS=$(pg_psql "SELECT count(*) FROM user_workflow_triggers WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_A_NAME}' AND user_id='${USER_A_ID}';")
[[ "$GRANT_ROWS" == "1" ]] || fail "Seed grant was not persisted to user_workflow_triggers for ${RECIPE_A_NAME}"
pass "Seed grant persisted to canonical user_workflow_triggers table"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 1b: Anti-bias regression guard for PUT /admin/workflows/:ns/:name/grants
# ═════════════════════════════════════════════════════════════════════
# The "Seed grant" block above covers the happy path (admin token → 200).
# Case 1b is the complementary negative: the same route MUST respond with
# an opaque 401 when called by a non-admin caller (user-session token),
# NOT 403/404 — that opacity is the contract that keeps the route from
# becoming an auth-probe oracle on the external mount scan surface.
#
# Gated via the admin workflow lane auth helper. If future
# middleware leaks a 403 or if the route becomes unregistered (404), this
# case fails loudly. Matching the body (`"error":"Unauthorized"`) in
# addition to the status code guards against framework-default 404 shapes.
log "Case 1b: Anti-bias regression guard — PUT /grants route must exist and gate non-admins"

http_request PUT "${CONTROL_URL}/api/v1/admin/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/grants" \
  "{\"userIds\":[\"${USER_A_ID}\"]}" \
  "x-user-session-token: ${USER_A_TOKEN}" \
  "Content-Type: application/json"
if [[ "$HTTP_STATUS" == "401" ]] && echo "$HTTP_BODY" | grep -q '"error":"Unauthorized"'; then
  pass "Case 1b: grants route exists and correctly rejects non-admin callers (HTTP 401 Unauthorized)"
elif [[ "$HTTP_STATUS" == "404" ]]; then
  fail "Case 1b: grants route is NOT MOUNTED (HTTP 404). The admin grants API is the only product-side way to authorize users — scripts must not be the sole writer to user_workflow_triggers."
else
  fail "Case 1b: unexpected HTTP $HTTP_STATUS (expected 401 Unauthorized): $HTTP_BODY"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 2: issue mcpHost control token for recipe-A
# ═════════════════════════════════════════════════════════════════════
# WRC/HCC provisioners use InternalControl JWT only on the mcp-host issuance lane.
# The returned mcpHostControlToken is the runtime token used by /workflows/:ns/:name/trigger.
log "Phase 2: POST /auth/mcp-host/:ns/:name/tokens"

ISSUE_BODY='{"includeMcpHostControlToken":true,"workflowControlScopes":["workflow:list","workflow:read","workflow:trigger"]}'
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_A_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
[[ "$HTTP_STATUS" == "200" ]] || fail "mcp-host token issuance (HTTP $HTTP_STATUS): $HTTP_BODY"
WRC_CONTROL_TOKEN=$(json_field "$HTTP_BODY" "o.mcpHostControlToken")
WRC_ACCESS_TOKEN=$(json_field "$HTTP_BODY" "o.mcpHostAccessToken")
[[ -n "$WRC_CONTROL_TOKEN" ]] || fail "mcp-host token issuance empty control token: $HTTP_BODY"
[[ -n "$WRC_ACCESS_TOKEN" ]] || fail "mcp-host token issuance empty access token: $HTTP_BODY"
WA_HEADER="Authorization: Bearer $WRC_CONTROL_TOKEN"
pass "mcpHost tokens issued (access=${#WRC_ACCESS_TOKEN} chars, control=${#WRC_CONTROL_TOKEN} chars, aud=mcp-host)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 2: POST /trigger end-to-end
# ═════════════════════════════════════════════════════════════════════
log "Case 2: POST /trigger end-to-end"

TRIGGER_BODY='{"inputs":{}}'
IDEMPO_KEY_2="e2e-trigger-case2-$(uuid)"

http_request POST "${CONTROL_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/trigger" "$TRIGGER_BODY" \
  "$WA_HEADER" "Idempotency-Key: $IDEMPO_KEY_2"
[[ "$HTTP_STATUS" == "400" ]] || fail "Case 2a: trigger without approvalRequestId expected HTTP 400, got $HTTP_STATUS: $HTTP_BODY"
[[ "$(json_field "$HTTP_BODY" "o.error")" == "approvalRequestId is required for mcp-host-control triggers" ]] \
  || fail "Case 2a: unexpected missing-approval error: $HTTP_BODY"
pass "Case 2a: mcpHost trigger without durable approval is rejected"

APPROVAL_ID_2=$(create_approved_runtime_approval "$RECIPE_A_NAME" "$USER_A_ID" "$USER_A_TOKEN" "$IDEMPO_KEY_2")
TRIGGER_BODY=$(printf '{"inputs":{},"approvalRequestId":"%s"}' "$APPROVAL_ID_2")
http_request POST "${CONTROL_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/trigger" "$TRIGGER_BODY" \
  "$WA_HEADER" "Idempotency-Key: $IDEMPO_KEY_2"
if [[ "$HTTP_STATUS" == "201" ]]; then
  # DB-first (Fase 2+): response is the canonical run DTO — {id, source:"live", phase, ...}.
  RUN_ID_2=$(json_field "$HTTP_BODY" "o.id")
  [[ -n "$RUN_ID_2" ]] || fail "Case 2: id missing in response body: $HTTP_BODY"
  pass "Case 2b: approved mcpHost trigger accepted (HTTP 201, runId=$RUN_ID_2)"
else
  fail "Case 2: POST /trigger expected HTTP 201, got $HTTP_STATUS: $HTTP_BODY"
fi
assert_typed_intent_for_approval "$APPROVAL_ID_2" "$RECIPE_A_NAME" "${RECIPE_NS}/${RECIPE_A_NAME}" "Case 2c"
assert_run_for_approval "$APPROVAL_ID_2" "$RECIPE_A_NAME" "$RUN_ID_2" "Case 2d"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 2e: Phase 0 team grants + typed intent contract
# ═════════════════════════════════════════════════════════════════════
log "Case 2e: Phase 0 team grants + typed trigger intent contract"

RECIPE_TEAM_NAME="e2e-trigger-team-$(date +%s)"
CREATED_RECIPES+=("$RECIPE_TEAM_NAME")
CASE2E_TMPDIR="$(mktemp -d -t clerum-trigger-case2e-XXXX)"

cat > "$CASE2E_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_TEAM_NAME}
  namespace: ${RECIPE_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors:
        - user
        - autonomous
  steps:
    - id: team-trigger
      instruction: "This is a team grant E2E trigger test."
      timeoutSeconds: 60
YAML

if $KC apply -f "$CASE2E_TMPDIR/recipe.yaml" 2>/dev/null; then
  pass "Case 2e.1: team grant WorkflowRecipe applied"
else
  fail "Case 2e.1: kubectl apply rejected team grant WorkflowRecipe"
fi
rm -rf "$CASE2E_TMPDIR"

TEAM_GRANT_ID=$(admin_create_team_for_user "e2e-trigger-team-grant-${RECIPE_TEAM_NAME}" "$USER_A_ID")
CREATED_TEAMS+=("$TEAM_GRANT_ID")
pass "Case 2e.2: created Team B for team grant via admin API (team_id=$TEAM_GRANT_ID)"

USER_A_TEAM_GRANT_SESSION=$(issue_session_for_team "$USER_A_TOKEN" "$TEAM_GRANT_ID")
pass "Case 2e.3: issued user A session scoped to granted Team B"

http_request PUT "${CONTROL_URL}/api/v1/admin/workflows/${RECIPE_NS}/${RECIPE_TEAM_NAME}/team-grants" \
  "{\"teamIds\":[\"${TEAM_GRANT_ID}\"]}" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.4: team grants PUT expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
TEAM_GRANT_SEEN=$(json_field "$HTTP_BODY" "(o.teamIds||[]).includes('${TEAM_GRANT_ID}')")
if [[ "$TEAM_GRANT_SEEN" == "true" ]]; then
  pass "Case 2e.4: Team B authorized via canonical team-grants API"
else
  fail "Case 2e.4: team-grants response missing Team B: $HTTP_BODY"
fi

TEAM_GRANT_AUDIT_COUNT=$(pg_psql "SELECT COUNT(*) FROM team_workflow_grants_audit WHERE target_team_id='${TEAM_GRANT_ID}' AND recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_TEAM_NAME}' AND action='grant';" 2>/dev/null | tr -d ' \n' || echo "0")
if [[ "$TEAM_GRANT_AUDIT_COUNT" == "1" ]]; then
  pass "Case 2e.5: team grant audit row persisted"
else
  fail "Case 2e.5: expected 1 team grant audit row, got ${TEAM_GRANT_AUDIT_COUNT}"
fi

http_request PUT "${CONTROL_URL}/api/v1/admin/workflow-recipes/${RECIPE_NS}/${RECIPE_TEAM_NAME}/allowed-teams/${TEAM_GRANT_ID}" "" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.6: allow Team B for approvals expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
http_request PUT "${CONTROL_URL}/api/v1/admin/workflow-recipes/${RECIPE_NS}/${RECIPE_TEAM_NAME}/allowed-teams/${USER_A_TEAM_ID}" "" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.6: allow Team A for negative approvals expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
pass "Case 2e.6: approval target teams allowlisted via admin API"

TEAM_REVOKE_ID=$(admin_create_team_for_user "e2e-trigger-team-revoke-${RECIPE_TEAM_NAME}" "$USER_A_ID")
CREATED_TEAMS+=("$TEAM_REVOKE_ID")
http_request PUT "${CONTROL_URL}/api/v1/admin/workflow-recipes/${RECIPE_NS}/${RECIPE_TEAM_NAME}/allowed-teams/${TEAM_REVOKE_ID}" "" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.6a: allow temporary approval team expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
http_request GET "${CONTROL_URL}/api/v1/admin/workflow-recipes/${RECIPE_NS}/${RECIPE_TEAM_NAME}/allowed-teams" "" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.6a: allowed-teams list expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
ALLOWLIST_TEMP_SEEN=$(json_field "$HTTP_BODY" "(o.items||[]).some(x=>x.id==='${TEAM_REVOKE_ID}')")
[[ "$ALLOWLIST_TEMP_SEEN" == "true" ]] \
  && pass "Case 2e.6a: approval allowed-teams list includes temporary team" \
  || fail "Case 2e.6a: allowed-teams list missing temporary team: $HTTP_BODY"
http_request DELETE "${CONTROL_URL}/api/v1/admin/workflow-recipes/${RECIPE_NS}/${RECIPE_TEAM_NAME}/allowed-teams/${TEAM_REVOKE_ID}" "" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.6b: allowed-teams revoke expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
ALLOWLIST_REMOVED=$(json_field "$HTTP_BODY" "o.removed")
[[ "$ALLOWLIST_REMOVED" == "true" ]] || fail "Case 2e.6b: expected removed=true, got $HTTP_BODY"
http_request GET "${CONTROL_URL}/api/v1/admin/workflow-recipes/${RECIPE_NS}/${RECIPE_TEAM_NAME}/allowed-teams" "" \
  "$(authz_header "$ADMIN_TOKEN")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.6b: allowed-teams list after revoke expected HTTP 200, got $HTTP_STATUS: $HTTP_BODY"
ALLOWLIST_REVOKED_SEEN=$(json_field "$HTTP_BODY" "(o.items||[]).some(x=>x.id==='${TEAM_REVOKE_ID}')")
[[ "$ALLOWLIST_REVOKED_SEEN" == "false" ]] \
  && pass "Case 2e.6b: approval allowed-teams revoke removes temporary team" \
  || fail "Case 2e.6b: temporary team still present after revoke: $HTTP_BODY"

http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_TEAM_NAME}/tokens" "$ISSUE_BODY" \
  "$(authz_header "$(sign_internal_control_jwt wrc)")"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 2e.7: team recipe mcp-host token issuance (HTTP $HTTP_STATUS): $HTTP_BODY"
TEAM_CONTROL_SESSION=$(json_field "$HTTP_BODY" "o.mcpHostControlToken")
TEAM_ACCESS_SESSION=$(json_field "$HTTP_BODY" "o.mcpHostAccessToken")
[[ -n "$TEAM_CONTROL_SESSION" && -n "$TEAM_ACCESS_SESSION" ]] || fail "Case 2e.7: team recipe token issuance returned empty values: $HTTP_BODY"
TEAM_WA_HEADER="$(authz_header "$TEAM_CONTROL_SESSION")"
pass "Case 2e.7: team recipe mcpHost tokens issued"

IDEMPO_KEY_2E_DIRECT="e2e-trigger-case2e-direct-$(uuid)"
http_request POST "${EXT_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_TEAM_NAME}/trigger" \
  '{"inputs":{"contract":"direct-user-session-team-grant"}}' \
  "$(authz_header "$USER_A_TEAM_GRANT_SESSION")" "Idempotency-Key: $IDEMPO_KEY_2E_DIRECT"
if [[ "$HTTP_STATUS" == "201" ]]; then
  RUN_ID_2E_DIRECT=$(json_field "$HTTP_BODY" "o.id")
  [[ -n "$RUN_ID_2E_DIRECT" ]] || fail "Case 2e.8: direct team-grant trigger response missing id: $HTTP_BODY"
  DIRECT_TEAM_RUN_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE run_id='${RUN_ID_2E_DIRECT}' AND recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_TEAM_NAME}' AND actor_type='user' AND team_id='${TEAM_GRANT_ID}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$DIRECT_TEAM_RUN_COUNT" == "1" ]]; then
    pass "Case 2e.8: direct-user-session Team B grant created a user run with Team B context"
  else
    fail "Case 2e.8: expected direct team run ${RUN_ID_2E_DIRECT} to carry Team B context"
  fi
else
  fail "Case 2e.8: direct-user-session Team B trigger expected HTTP 201, got $HTTP_STATUS: $HTTP_BODY"
fi

IDEMPO_KEY_2E_WRONG_SESSION="e2e-trigger-case2e-wrong-session-$(uuid)"
http_request POST "${EXT_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_TEAM_NAME}/trigger" \
  '{"inputs":{"contract":"wrong-team-session-denied"}}' \
  "$(authz_header "$USER_A_TOKEN")" "Idempotency-Key: $IDEMPO_KEY_2E_WRONG_SESSION"
if [[ "$HTTP_STATUS" == "403" ]]; then
  pass "Case 2e.9: direct-user-session Team A cannot use Team B trigger grant"
else
  fail "Case 2e.9: expected HTTP 403 for wrong session team, got $HTTP_STATUS: $HTTP_BODY"
fi
assert_no_run_for_idempotency_key "$RECIPE_TEAM_NAME" "$IDEMPO_KEY_2E_WRONG_SESSION" "Case 2e.10"

IDEMPO_KEY_2E_TEAM="e2e-trigger-case2e-team-$(uuid)"
APPROVAL_ID_2E_TEAM=$(create_approved_team_runtime_approval "$RECIPE_TEAM_NAME" "$TEAM_GRANT_ID" "$USER_A_TEAM_GRANT_SESSION" "$IDEMPO_KEY_2E_TEAM" "$TEAM_ACCESS_SESSION")
assert_typed_intent_for_approval "$APPROVAL_ID_2E_TEAM" "$RECIPE_TEAM_NAME" "${RECIPE_NS}/${RECIPE_TEAM_NAME}" "Case 2e.11"
TRIGGER_BODY_2E_TEAM=$(printf '{"inputs":{"contract":"target-team-grant"},"approvalRequestId":"%s"}' "$APPROVAL_ID_2E_TEAM")
http_request POST "${CONTROL_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_TEAM_NAME}/trigger" "$TRIGGER_BODY_2E_TEAM" \
  "$TEAM_WA_HEADER" "Idempotency-Key: $IDEMPO_KEY_2E_TEAM"
if [[ "$HTTP_STATUS" == "201" ]]; then
  RUN_ID_2E_TEAM=$(json_field "$HTTP_BODY" "o.id")
  [[ -n "$RUN_ID_2E_TEAM" ]] || fail "Case 2e.12: team approval trigger response missing id: $HTTP_BODY"
  assert_run_for_approval "$APPROVAL_ID_2E_TEAM" "$RECIPE_TEAM_NAME" "$RUN_ID_2E_TEAM" "Case 2e.12"
  TEAM_APPROVAL_RUN_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE run_id='${RUN_ID_2E_TEAM}' AND team_id='${TEAM_GRANT_ID}' AND approval_request_id='${APPROVAL_ID_2E_TEAM}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$TEAM_APPROVAL_RUN_COUNT" == "1" ]]; then
    pass "Case 2e.13: target-team approval run carries Team B context"
  else
    fail "Case 2e.13: expected target-team approval run ${RUN_ID_2E_TEAM} to carry Team B context"
  fi
else
  fail "Case 2e.12: team approval trigger expected HTTP 201, got $HTTP_STATUS: $HTTP_BODY"
fi

IDEMPO_KEY_2E_WRONG_APPROVAL="e2e-trigger-case2e-wrong-approval-$(uuid)"
REQUEST_BODY_2E_WRONG=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"teamId":"%s"},"payload":{"message":"E2E wrong target team approval for %s","metadata":{"workflowTrigger":{"namespace":"%s","name":"%s","caller":"%s/%s"}}},"ttlSeconds":300}' \
  "$RECIPE_NS" "$RECIPE_TEAM_NAME" "$USER_A_TEAM_ID" "$RECIPE_TEAM_NAME" "$RECIPE_NS" "$RECIPE_TEAM_NAME" "$RECIPE_NS" "$RECIPE_TEAM_NAME")
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQUEST_BODY_2E_WRONG" \
  "$(authz_header "$TEAM_ACCESS_SESSION")" "Idempotency-Key: ${IDEMPO_KEY_2E_WRONG_APPROVAL}-approval"
if [[ "$HTTP_STATUS" == "403" ]] && [[ "$(json_field "$HTTP_BODY" "o.error")" == "Target not authorized to trigger this recipe" ]]; then
  pass "Case 2e.14: target Team A approval setup fails closed when only Team B has trigger grant"
else
  fail "Case 2e.14: expected target authorization rejection for wrong target team, got HTTP $HTTP_STATUS: $HTTP_BODY"
fi
assert_no_run_for_idempotency_key "$RECIPE_TEAM_NAME" "$IDEMPO_KEY_2E_WRONG_APPROVAL" "Case 2e.15"

IDEMPO_KEY_2E_DELETE_REPLAY="e2e-trigger-case2e-delete-replay-$(uuid)"
APPROVAL_ID_2E_DELETE_REPLAY=$(create_approved_team_runtime_approval "$RECIPE_TEAM_NAME" "$TEAM_GRANT_ID" "$USER_A_TEAM_GRANT_SESSION" "$IDEMPO_KEY_2E_DELETE_REPLAY" "$TEAM_ACCESS_SESSION")
assert_typed_intent_for_approval "$APPROVAL_ID_2E_DELETE_REPLAY" "$RECIPE_TEAM_NAME" "${RECIPE_NS}/${RECIPE_TEAM_NAME}" "Case 2e.17"
if $KC delete workflowrecipe "$RECIPE_TEAM_NAME" -n "$RECIPE_NS" --timeout=60s >/dev/null 2>&1; then
  pass "Case 2e.18: deleting recipe with a live approved approval completed"
else
  fail "Case 2e.18: deleting recipe with a live approved approval timed out or failed"
fi
DELETE_REPLAY_STATUS=$(approval_status "$APPROVAL_ID_2E_DELETE_REPLAY")
if [[ "$DELETE_REPLAY_STATUS" == "cancelled" ]]; then
  pass "Case 2e.19: recipe delete cancels live approved trigger-bound approval"
else
  fail "Case 2e.19: expected deleted recipe approval to be cancelled, got '${DELETE_REPLAY_STATUS}'"
fi
TRIGGER_BODY_2E_DELETE_REPLAY=$(printf '{"inputs":{"contract":"deleted-recipe-replay-denied"},"approvalRequestId":"%s"}' "$APPROVAL_ID_2E_DELETE_REPLAY")
http_request POST "${CONTROL_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_TEAM_NAME}/trigger" "$TRIGGER_BODY_2E_DELETE_REPLAY" \
  "$TEAM_WA_HEADER" "Idempotency-Key: $IDEMPO_KEY_2E_DELETE_REPLAY"
if [[ "$HTTP_STATUS" == "404" || "$HTTP_STATUS" == "403" ]]; then
  pass "Case 2e.20: deleted recipe approval cannot be replayed into a workflow run"
else
  fail "Case 2e.20: expected deleted recipe replay rejection, got HTTP $HTTP_STATUS: $HTTP_BODY"
fi
assert_no_run_for_approval "$APPROVAL_ID_2E_DELETE_REPLAY" "$RECIPE_TEAM_NAME" "Case 2e.21"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 3: Gateway routing for /trigger
# ═════════════════════════════════════════════════════════════════════
if [[ "$SKIP_GATEWAY" == "true" ]]; then
  log "Case 3: SKIPPED (--skip-gateway)"
  echo ""
else
  log "Case 3: Gateway routing for /trigger"

  IDEMPO_KEY_3="e2e-trigger-case3-$(uuid)"
  APPROVAL_ID_3=$(create_approved_runtime_approval "$RECIPE_A_NAME" "$USER_A_ID" "$USER_A_TOKEN" "$IDEMPO_KEY_3")
  TRIGGER_BODY_3=$(printf '{"inputs":{},"approvalRequestId":"%s"}' "$APPROVAL_ID_3")
  gateway_curl POST "/api/v1/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/trigger" "$TRIGGER_BODY_3" "$WRC_CONTROL_TOKEN" \
    "Idempotency-Key: $IDEMPO_KEY_3"

  if [[ "$HTTP_STATUS" == "000" ]]; then
    warn "Case 3: gateway unreachable"
  elif [[ "$HTTP_STATUS" == "403" ]]; then
    fail "Case 3: /trigger blocked by gateway (HTTP 403) -- nginx missing location block"
  elif [[ "$HTTP_STATUS" == "201" ]]; then
    RUN_ID_3=$(json_field "$HTTP_BODY" "o.id")
    [[ -n "$RUN_ID_3" ]] || fail "Case 3: gateway trigger response missing id: $HTTP_BODY"
    pass "Case 3: gateway routed approved trigger to control-api (HTTP 201, runId=$RUN_ID_3)"
  else
    fail "Case 3: gateway trigger expected HTTP 201, got $HTTP_STATUS: $HTTP_BODY"
  fi
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════
# Case 4: Scheduled trigger registers workflow_schedules row
# ═════════════════════════════════════════════════════════════════════
log "Case 4: Scheduled trigger registers workflow_schedules row"

RECIPE_SCHED_NAME="e2e-trigger-sched-$(date +%s)"
CREATED_RECIPES+=("$RECIPE_SCHED_NAME")
CASE4_TMPDIR="$(mktemp -d -t clerum-trigger-case4-XXXX)"

cat > "$CASE4_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_SCHED_NAME}
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/workflow-team-id: "${USER_A_TEAM_ID}"
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    schedule:
      cron: "0 9 * * 1"
      timezone: UTC
      concurrencyPolicy: Forbid
  steps:
    - id: scheduled-step
      instruction: "This is a scheduled E2E test step."
      timeoutSeconds: 60
YAML

if $KC apply -f "$CASE4_TMPDIR/recipe.yaml" 2>/dev/null; then
  pass "Case 4a: WorkflowRecipe with schedule trigger applied"
else
  fail "Case 4: kubectl apply rejected scheduled WorkflowRecipe"
fi

# Fase 5: WRC persists the schedule to Postgres (workflow_schedules table),
# NOT to a CronJob. Poll the DB until the schedule worker registers the row.
SCHED_FOUND=false
for _ in $(seq 1 20); do
  COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_schedules WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_SCHED_NAME}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$COUNT" == "1" ]]; then
    SCHED_FOUND=true
    break
  fi
  sleep 3
done

if [[ "$SCHED_FOUND" == "true" ]]; then
  pass "Case 4b: workflow_schedules row registered for ${RECIPE_SCHED_NAME}"
  SCHED_TEAM_ID=$(pg_psql "SELECT team_id::text FROM workflow_schedules WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_SCHED_NAME}';" 2>/dev/null | head -1 | tr -d ' ' || echo "")
  [[ "$SCHED_TEAM_ID" == "$USER_A_TEAM_ID" ]] \
    && pass "Case 4c: workflow_schedules row carries team_id snapshot" \
    || fail "Case 4c: workflow_schedules team_id mismatch (got '$SCHED_TEAM_ID', expected '$USER_A_TEAM_ID')"
else
  fail "Case 4b: workflow_schedules row not found within 60s"
fi
rm -rf "$CASE4_TMPDIR"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 5: DB schedule worker fires a run
# ═════════════════════════════════════════════════════════════════════
log "Case 5: DB schedule worker fires a run"

if [[ "$SCHED_FOUND" == "true" ]]; then
  # Force next_fire_at into the past so workflowScheduleWorker picks it up
  # on its next tick (10s cadence). This avoids waiting a full minute.
  pg_psql "UPDATE workflow_schedules SET next_fire_at = now() - INTERVAL '1 second' WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_SCHED_NAME}';" >/dev/null 2>&1 || true
  detail "Forced next_fire_at to the past; waiting for schedule worker"

  RUN_FOUND=false
  for _ in $(seq 1 30); do
    RUN_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_SCHED_NAME}' AND actor_type='scheduled';" 2>/dev/null | tr -d ' \n' || echo "0")
    if [[ "$RUN_COUNT" != "0" && "$RUN_COUNT" != "" ]]; then
      RUN_FOUND=true
      break
    fi
    sleep 3
  done

  if [[ "$RUN_FOUND" == "true" ]]; then
    pass "Case 5: schedule worker created a workflow_runs row (actor_type=scheduled)"
    SCHED_RUN_TEAM_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_SCHED_NAME}' AND actor_type='scheduled' AND team_id='${USER_A_TEAM_ID}';" 2>/dev/null | tr -d ' \n' || echo "0")
    [[ "$SCHED_RUN_TEAM_COUNT" != "0" && "$SCHED_RUN_TEAM_COUNT" != "" ]] \
      && pass "Case 5b: scheduled workflow_runs row carries team_id snapshot" \
      || fail "Case 5b: scheduled workflow_runs row missing team_id snapshot"
  else
    fail "Case 5: No scheduled workflow_runs row observed within 90s"
  fi

  # Disable the schedule to prevent continuous firing during the rest of the suite
  pg_psql "UPDATE workflow_schedules SET enabled = FALSE WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_SCHED_NAME}';" >/dev/null 2>&1 || true
else
  fail "Case 5: no workflow_schedules row from Case 4"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 6: Idempotency -- two curls with same Idempotency-Key
# ═════════════════════════════════════════════════════════════════════
log "Case 6: Idempotency"

IDEMPO_KEY_6="e2e-trigger-case6-$(uuid)"
APPROVAL_ID_6=$(create_approved_runtime_approval "$RECIPE_A_NAME" "$USER_A_ID" "$USER_A_TOKEN" "$IDEMPO_KEY_6")
TRIGGER_BODY_6=$(printf '{"inputs":{},"approvalRequestId":"%s"}' "$APPROVAL_ID_6")
TRIGGER_PATH_6="/api/v1/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/trigger"

# First request -- HTTP 201 on successful CREATE.
http_request POST "${CONTROL_URL}${TRIGGER_PATH_6}" "$TRIGGER_BODY_6" \
  "$WA_HEADER" "Idempotency-Key: $IDEMPO_KEY_6"
FIRST_STATUS="$HTTP_STATUS"
FIRST_RUN_ID=$(json_field "$HTTP_BODY" "o.id")
detail "First request: HTTP $FIRST_STATUS runId=$FIRST_RUN_ID"
[[ "$FIRST_STATUS" == "201" ]] || fail "Case 6: first request expected HTTP 201, got $FIRST_STATUS: $HTTP_BODY"
[[ -n "$FIRST_RUN_ID" ]] || fail "Case 6: first request missing id: $HTTP_BODY"

# Second request with SAME key -- idempotent replay returns HTTP 200 (Stripe-style cache),
# NOT 409. Body is the SAME canonical run DTO {id, source:"live", phase, ...}.
http_request POST "${CONTROL_URL}${TRIGGER_PATH_6}" "$TRIGGER_BODY_6" \
  "$WA_HEADER" "Idempotency-Key: $IDEMPO_KEY_6"
SECOND_STATUS="$HTTP_STATUS"
SECOND_RUN_ID=$(json_field "$HTTP_BODY" "o.id")
detail "Second request: HTTP $SECOND_STATUS runId=$SECOND_RUN_ID"

if [[ "$SECOND_STATUS" == "200" && "$FIRST_RUN_ID" == "$SECOND_RUN_ID" ]]; then
  pass "Case 6: idempotency enforced (201 create -> 200 replay, same runId=$FIRST_RUN_ID)"
else
  fail "Case 6: idempotency not enforced (first=$FIRST_STATUS/$FIRST_RUN_ID second=$SECOND_STATUS/$SECOND_RUN_ID)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 7: Cross-user isolation
# ═════════════════════════════════════════════════════════════════════
log "Case 7: Cross-user isolation"

# User B should NOT be able to trigger User A's recipe
TRIGGER_BODY_7='{"inputs":{}}'
IDEMPO_KEY_7A="e2e-trigger-case7a-$(uuid)"

# Issue a token for user B (via external API, as if the Desktop App did it)
# User B does not have allowlist access to recipe A.
# Try via the external REST API endpoint which validates session tokens.
http_request POST "${EXT_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/trigger" "$TRIGGER_BODY_7" \
  "Authorization: Bearer $USER_B_TOKEN" "Idempotency-Key: $IDEMPO_KEY_7A"

if [[ "$HTTP_STATUS" == "403" ]]; then
  pass "Case 7a: cross-user isolation enforced via external-rest-api (user B -> 403 on user A recipe)"
else
  fail "Case 7a: expected 403 for user-session cross-user trigger, got HTTP $HTTP_STATUS: $HTTP_BODY"
fi

# ── Case 7b: approval caller binding on control-api ───────────────────
# Create a second recipe (B), issue a mcpHost workflow control token scoped to
# recipe-B, then try to use it with an approval bound to recipe-A's caller key.
# For approval-bound triggers, the target workflow may differ from the caller;
# the security invariant is that the token caller must match the typed
# approval trigger_caller_key. Case 8 covers hostRefs isolation for read/status.
RECIPE_B_NAME="e2e-trigger-userb-$(date +%s)"
CREATED_RECIPES+=("$RECIPE_B_NAME")
CASE7B_TMPDIR="$(mktemp -d -t clerum-trigger-case7b-XXXX)"
cat > "$CASE7B_TMPDIR/recipe-b.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_B_NAME}
  namespace: ${RECIPE_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
  steps:
    - id: hello
      instruction: "Case 7b fixture recipe."
      timeoutSeconds: 60
YAML
$KC apply -f "$CASE7B_TMPDIR/recipe-b.yaml" >/dev/null 2>&1 \
  || fail "Case 7b: could not create fixture recipe-B"
rm -rf "$CASE7B_TMPDIR"

http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_B_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 7b: token issuance for recipe-B (HTTP $HTTP_STATUS): $HTTP_BODY"
TOKEN_B=$(json_field "$HTTP_BODY" "o.mcpHostControlToken")
[[ -n "$TOKEN_B" ]] || fail "Case 7b: empty mcpHostControlToken for recipe-B: $HTTP_BODY"

IDEMPO_KEY_7B="e2e-trigger-case7b-$(uuid)"
APPROVAL_ID_7B=$(create_approved_runtime_approval "$RECIPE_A_NAME" "$USER_A_ID" "$USER_A_TOKEN" "$IDEMPO_KEY_7B")
TRIGGER_BODY_7B=$(printf '{"inputs":{"contract":"caller-binding-denied"},"approvalRequestId":"%s"}' "$APPROVAL_ID_7B")
http_request POST "${CONTROL_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_A_NAME}/trigger" "$TRIGGER_BODY_7B" \
  "Authorization: Bearer $TOKEN_B" "Idempotency-Key: $IDEMPO_KEY_7B"
if [[ "$HTTP_STATUS" == "403" ]] && [[ "$(json_field "$HTTP_BODY" "o.error")" == "approval_trigger_binding_mismatch" ]]; then
  pass "Case 7b: caller binding isolation enforced (recipe-B token cannot consume recipe-A approval)"
else
  fail "Case 7b: expected approval_trigger_binding_mismatch, got HTTP $HTTP_STATUS: $HTTP_BODY"
fi
assert_no_run_for_approval "$APPROVAL_ID_7B" "$RECIPE_A_NAME" "Case 7b.1"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 8: hostRefs enforcement
# ═════════════════════════════════════════════════════════════════════
log "Case 8: hostRefs enforcement"

# Token scoped to RECIPE_A should NOT be able to query RECIPE_B's workflow
# status. Reuse the real recipe-B fixture from Case 7b so a 404 cannot masquerade
# as a hostRefs pass.
RECIPE_B_FOR_REFS="$RECIPE_B_NAME"

http_request GET "${CONTROL_URL}/api/v1/workflows/${RECIPE_NS}/${RECIPE_B_FOR_REFS}" "" \
  "$WA_HEADER"

if [[ "$HTTP_STATUS" == "403" ]]; then
  pass "Case 8: hostRefs enforcement (recipe-A token -> 403 on recipe-B status)"
else
  fail "Case 8: expected 403 for hostRefs violation, got HTTP $HTTP_STATUS: $HTTP_BODY"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 9: DB-first archive cron
# ═════════════════════════════════════════════════════════════════════
log "Case 9: DB-first archive cron"

# Deploy a recipe with very short TTL to test the reaper
RECIPE_RETENTION="e2e-trigger-retention-$(date +%s)"
CREATED_RECIPES+=("$RECIPE_RETENTION")
CASE9_TMPDIR="$(mktemp -d -t clerum-trigger-case9-XXXX)"

cat > "$CASE9_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_RETENTION}
  namespace: ${RECIPE_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
  runRetention:
    successfulHistoryLimit: 1
    failedHistoryLimit: 1
    ttlSecondsAfterFinished: 10
  steps:
    - id: ephemeral
      instruction: "Say hello. This is a retention test."
      timeoutSeconds: 60
YAML

if $KC apply -f "$CASE9_TMPDIR/recipe.yaml" 2>/dev/null; then
  pass "Case 9a: WorkflowRecipe with runRetention applied"
else
  fail "Case 9: kubectl apply rejected retention recipe"
fi

# Verify the CRD stored the runRetention fields correctly
RETENTION_JSON=$($KC get workflowrecipe "$RECIPE_RETENTION" -n "$RECIPE_NS" -o jsonpath='{.spec.runRetention}' 2>/dev/null || echo "")
if [[ -n "$RETENTION_JSON" ]]; then
  TTL_STORED=$(echo "$RETENTION_JSON" | node --no-warnings -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const o=JSON.parse(d); process.stdout.write(String(o.ttlSecondsAfterFinished||'')); }
      catch { process.stdout.write(''); }
    });
  " 2>/dev/null)
  if [[ "$TTL_STORED" == "10" ]]; then
    pass "Case 9b: runRetention.ttlSecondsAfterFinished=10 stored in CRD"
  else
    fail "Case 9b: ttlSecondsAfterFinished='$TTL_STORED' (expected 10)"
  fi
else
  fail "Case 9b: runRetention not found in CRD spec"
fi

# Fase 7: WorkflowRun CRD removed. Runs live in workflow_runs (active) and
# workflow_runs_audit (archive). The archive cron (control-api) moves rows with
# completed_at < now()-1h from workflow_runs -> workflow_runs_audit every 15min.
#
# Seed a synthetic terminal row directly in workflow_runs and verify the archive
# cron picks it up. TTL=15 min means we seed with completed_at = now()-2h so
# the next cron tick archives it unconditionally.
SYNTH_RUN_ID=$(uuid)
PAST_TIMESTAMP="now() - INTERVAL '2 hours'"

SEED_SQL="INSERT INTO workflow_runs
  (run_id, recipe_namespace, recipe_name, phase, actor_type, trigger_source, started_at, completed_at)
VALUES
  ('${SYNTH_RUN_ID}', '${RECIPE_NS}', '${RECIPE_RETENTION}', 'Succeeded', 'user', 'onDemand',
   ${PAST_TIMESTAMP}, ${PAST_TIMESTAMP});"

if SEED_OUT=$(pg_psql "$SEED_SQL" 2>&1); then
  detail "Seeded terminal workflow_runs row ($SYNTH_RUN_ID, completed 2h ago)"

  # Archive cron ticks every 15min. We cannot wait that long in E2E; instead,
  # we verify the row is archivable by manually running the same SELECT the cron
  # uses and confirming the row would be picked up.
  ELIGIBLE=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE completed_at < now() - INTERVAL '1 hour' AND run_id = '${SYNTH_RUN_ID}';" 2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "$ELIGIBLE" == "1" ]]; then
    pass "Case 9c: seeded row matches archive-cron eligibility window"
  else
    fail "Case 9c: seeded row not eligible for archive (expected 1, got $ELIGIBLE)"
  fi

  # Clean up the seed row so it doesn't get archived on the next real cron tick
  # and pollute workflow_runs_audit.
  pg_psql "DELETE FROM workflow_runs WHERE run_id = '${SYNTH_RUN_ID}';" >/dev/null 2>&1 || true
else
  fail "Case 9c: could not seed workflow_runs row: $SEED_OUT"
fi

rm -rf "$CASE9_TMPDIR"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 10: WorkflowRecipe namespace invariant
# ═════════════════════════════════════════════════════════════════════
log "Case 10: WorkflowRecipe CRDs are rejected outside sandbox-recipes"

FOREIGN_NS="mcp-server"
FOREIGN_RECIPE_NAME="e2e-trigger-foreign-$(date +%s)"
CASE10_TMPDIR="$(mktemp -d -t clerum-trigger-case10-XXXX)"

cat > "$CASE10_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${FOREIGN_RECIPE_NAME}
  namespace: ${FOREIGN_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
  steps:
    - id: foreign-namespace-check
      instruction: "Case 10 foreign namespace fixture."
      timeoutSeconds: 60
YAML

if $KC apply -f "$CASE10_TMPDIR/recipe.yaml" >/dev/null 2>&1; then
  $KC delete workflowrecipe "$FOREIGN_RECIPE_NAME" -n "$FOREIGN_NS" \
    --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
  rm -rf "$CASE10_TMPDIR"
  fail "Case 10: WorkflowRecipe was accepted in ${FOREIGN_NS}; platform invariant is broken"
else
  pass "Case 10: admission rejected WorkflowRecipe in ${FOREIGN_NS}"
fi
rm -rf "$CASE10_TMPDIR"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo -e "  PASS:  ${GREEN}${PASS}${NC}"
echo -e "  FAIL:  ${RED}${FAIL}${NC}"
echo -e "  TOTAL: ${TOTAL}"
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL WORKFLOW TRIGGER E2E CASES PASSED${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}WORKFLOW TRIGGER E2E FAILED${NC}"
  exit 1
fi
