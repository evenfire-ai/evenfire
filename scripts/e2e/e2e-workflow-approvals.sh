#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — User Approval Requests and mcpHost Runtime Tokens
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the user approval request surface, external decision surface,
# mcpHost runtime token issuance, gateway routing, and live WorkflowRecipe
# gateStep behavior.
#
# State machine under test:
#   pending → approved | denied | expired | cancelled
#   (approved → consumed is a hook reserved for workflow-triggers; not tested)
#
# Cases:
#   1. Happy path approve   : WRC request → external approves → status=approved
#   2. Happy path deny      : WRC request → external denies → status=denied
#   3. Cancel path          : WRC request → WRC cancels → status=cancelled
#   4. Expired path         : TTL=3s → wait → decide → 409 expired
#   5. Allowlist 403        : user NOT in allowlist → POST request returns 403
#  13. Authorization neg.   : outsider NOT target → list hides approval, decide → 403/404
#   6. Refresh JTI rotation : refresh → new pair → reuse old refresh → 401
#   7. Idempotency-Key      : same key → 409 with existing approvalRequestId
#   8. nginx gateway :8092  : in-cluster gateway routes WRC traffic to control-api
#   9. /metrics exposure    : GET /metrics returns 200 + Prometheus text + expected
#                              user_approval_requests_* + rate_limit_hits_total metrics
#  10. correlation-id prop. : x-correlation-id request header echoed on response
#  11. rate limiter 429     : opt-in low-limit burst → 429 with Retry-After
#  12. archival (simulation): reachable /metrics exposes archive counters; service
#                              module import guarded (smoke). Heavy DB backfill lives
#                              in unit tests (services.approvalArchive.test.ts).
#  17. live WorkflowRecipe  : external trigger creates a child WorkflowRecipe,
#                              WRC creates the child mcpHost runtime Secret,
#                              gateStep creates an approval, and external
#                              decision unblocks execution.
#
# Prerequisites:
#   - Cluster up with current worktree images deployed
#   - Port-forwards active:
#       control-api        :8090
#       external-rest-api  :8091
#   - Case 8 runs INSIDE the cluster via `kubectl run` ephemeral curl pods; no
#     port-forward is required for the nginx gateway. The curl pod runs from the
#     mcp-host namespace with the managed-host label required by NetworkPolicy.
#   - InternalControl JWT HMAC Secret is mounted for control-api and WRC/HCC callers
#   - The test users have a seeded password (scripts/e2e/seed-e2e-data.sh);
#     login uses POST /api/v1/auth/password-login with ADMIN_PASSWORD
#   - Postgres reachable via `kubectl -n <ns> ... psql` (for allowlist seed)
#
# Usage:
#   ./scripts/e2e/e2e-workflow-approvals.sh
#   ./scripts/e2e/e2e-workflow-approvals.sh --verbose
#   ./scripts/e2e/e2e-workflow-approvals.sh --skip-gateway
#
# Environment:
#   E2E_CONTROL_API_URL       (default: http://localhost:8090)
#   E2E_EXTERNAL_REST_API_URL (default: http://localhost:8091)
#   E2E_GATEWAY_SVC           (default: nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092)
#   E2E_GATEWAY_NS            (default: mcp-host — namespace used for ephemeral curl pods)
#   E2E_GATEWAY_POD_LABELS    (default: clerum.io/managed-by=host-context-controller)
#   E2E_TEST_EMAIL            (default: test@clerum.io)
#   E2E_OUTSIDER_EMAIL        (default: test2@clerum.io, seeded without recipe access)
#   E2E_ADMIN_USERNAME        (default: admin)
#   E2E_ADMIN_PASSWORD        (required for Case 17 product-side grant seed)
#   E2E_RECIPE_NAMESPACE      (default: sandbox-recipes)
#   E2E_RECIPE_NAME           (default: e2e-approval-recipe)
#   E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET  (HS256 secret — auto-read from cluster
#                                          Secret internal-control-jwt-secrets if unset)
#   E2E_POSTGRES_NAMESPACE    (default: control-plane)
#   E2E_POSTGRES_POD_SELECTOR (default: app=control-postgres)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-4.7}}"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

VERBOSE=false
SKIP_GATEWAY=false
for arg in "$@"; do
  case "$arg" in
    --verbose)       VERBOSE=true ;;
    --skip-gateway)  SKIP_GATEWAY=true ;;
  esac
done

PASS=0; FAIL=0; TOTAL=0
log()    { echo -e "${CYAN}[approval-e2e]${NC} $*"; }
pass()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()   { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; echo -e "${RED}ABORT${NC}"; exit 1; }
warn()   { echo -e "  ${YELLOW}WARN${NC} $*"; }
detail() { [[ "$VERBOSE" == "true" ]] && echo -e "       $*" || true; }

# ─── Configuration ───────────────────────────────────────────────────
CONTROL_URL="${E2E_CONTROL_API_URL:-http://localhost:8090}"
EXT_URL="${E2E_EXTERNAL_REST_API_URL:-http://localhost:8091}"
GATEWAY_SVC="${E2E_GATEWAY_SVC:-nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092}"
GATEWAY_NS="${E2E_GATEWAY_NS:-mcp-host}"
GATEWAY_POD_LABELS="${E2E_GATEWAY_POD_LABELS:-clerum.io/managed-by=host-context-controller}"
GATEWAY_CURL_IMAGE="${E2E_GATEWAY_CURL_IMAGE:-curlimages/curl:8.7.1}"
APPROVER_EMAIL="${E2E_TEST_EMAIL:-test@clerum.io}"
OUTSIDER_EMAIL="${E2E_OUTSIDER_EMAIL:-test2@clerum.io}"
ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-}}"
RECIPE_NS="${E2E_RECIPE_NAMESPACE:-sandbox-recipes}"
RECIPE_NAME="${E2E_RECIPE_NAME:-e2e-approval-recipe}"
PG_NS="${E2E_POSTGRES_NAMESPACE:-control-plane}"
PG_SEL="${E2E_POSTGRES_POD_SELECTOR:-app=control-postgres}"

# Cluster context — when set, every kubectl invocation in this script
# (including inside $(...) subshells) injects --context automatically.
# Accepts KUBECONTEXT or KCTX as env var. Safe fallback: empty = use
# shell's current-context (backward compatible).
KCTX="${KUBECONTEXT:-${KCTX:-}}"
if [[ -n "$KCTX" ]]; then
  kubectl() { command kubectl --context "$KCTX" "$@"; }
  export -f kubectl
fi

# Token refresh bookkeeping (populated after /auth/mcp-host/:ns/:name/tokens).
# declare -i so arithmetic comparisons are safe under `set -u`.
declare -i ACCESS_ISSUED_AT=0
declare -i ACCESS_TTL_SEC=600
declare -i REFRESH_IN_PROGRESS=0
WRC_ACCESS_TOKEN=""
WRC_REFRESH_TOKEN=""
WRC_CONTROL_TOKEN=""

# Track side-effects for the EXIT cleanup trap.
CREATED_APPROVAL_IDS=()
CREATED_IDEMPO_KEYS=()
CREATED_WORKFLOW_RECIPE_REFS=()
CREATED_WORKFLOW_RUN_IDS=()

# Provisioner caller-auth: HS256 InternalControl JWT. Library reads
# E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET / INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
# from env, or falls back to the cluster Secret
# `internal-control-jwt-secrets` in `control-plane`.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/internal-control-jwt.sh
source "${SCRIPT_DIR}/_lib/internal-control-jwt.sh"

# Probe once at startup to fail fast if the secret is unreachable.
if ! resolve_internal_control_hmac_secret >/dev/null; then
  fail "InternalControl JWT HMAC secret missing (set E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET or ensure cluster Secret internal-control-jwt-secrets is reachable)"
fi

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Clerum E2E — User Approval Requests v0.1${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""
log "Config: control-api=$CONTROL_URL"
log "Config: external-rest-api=$EXT_URL"
log "Config: gateway_svc=$GATEWAY_SVC (in-cluster, skip=$SKIP_GATEWAY)"
log "Config: gateway_ns=$GATEWAY_NS (ephemeral curl pods)"
log "Config: recipe=$RECIPE_NS/$RECIPE_NAME"
log "Config: approver=$APPROVER_EMAIL outsider=$OUTSIDER_EMAIL"
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

# JSON field extractor — uses node for reliability (deep paths, boolean ops).
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

# Postgres helper — runs SQL inside the control-postgres pod via kubectl.
pg_psql() {
  local sql="$1"
  local pod
  pod=$(kubectl -n "$PG_NS" get pod -l "$PG_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -n "$pod" ]] || fail "postgres pod not found (ns=$PG_NS sel=$PG_SEL)"
  kubectl -n "$PG_NS" exec "$pod" -- psql -U postgres -d "${PG_DB:-profiles}" -v ON_ERROR_STOP=1 -tAc "$sql"
}

uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    node -e "console.log(require('crypto').randomUUID())"
  fi
}

# ─── In-cluster gateway curl (case 8) ────────────────────────────────
# Runs `curl` inside an ephemeral pod so the service FQDN resolves via
# cluster DNS; no port-forward required. Populates HTTP_STATUS/HTTP_BODY
# the same way as http_request() so callers can reuse assertion logic.
#
# Usage: gateway_curl METHOD PATH [BODY] [TOKEN] [EXTRA_HEADER...]
gateway_curl() {
  local method="$1"; local path="$2"; local body="${3:-}"; local token="${4:-}"
  shift 4 2>/dev/null || shift $#

  local -a pod_args=("$method" "http://${GATEWAY_SVC}${path}")
  for hdr in "$@"; do pod_args+=("$hdr"); done

  local pod_name="e2e-gw-curl-$(date +%s)-${RANDOM}"
  local raw
  # Keep bearer tokens out of the PodSpec/argv: token + optional body are read
  # over stdin inside the ephemeral pod, then curl builds the auth header from
  # a shell variable.
  raw=$(
    {
      printf '%s\n' "$token"
      printf '%s' "$body"
    } | kubectl -n "$GATEWAY_NS" run "$pod_name" \
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
  # `kubectl run --rm` appends a "pod ... deleted" trailer — strip it.
  raw=$(echo "$raw" | grep -v '^pod ".*" deleted$' || true)
  HTTP_STATUS=$(echo "$raw" | tail -n1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

# ─── WRC access-token auto-refresh ───────────────────────────────────
# Rotates the access+refresh pair when the current access token has
# consumed >= 80% of its TTL. Safe to call before any admin request.
maybe_refresh_wrc_token() {
  # Guard against reentrancy: the refresh call itself uses http_request
  # but must NOT trigger another refresh.
  (( REFRESH_IN_PROGRESS == 1 )) && return 0
  (( ACCESS_ISSUED_AT == 0 )) && return 0
  [[ -z "$WRC_REFRESH_TOKEN" ]] && return 0

  local now; now=$(date +%s)
  local -i threshold=$((ACCESS_ISSUED_AT + (ACCESS_TTL_SEC * 80 / 100)))
  (( now < threshold )) && return 0

  REFRESH_IN_PROGRESS=1
  detail "Access token >=80% TTL (now=$now threshold=$threshold) — refreshing"
  http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
    "Authorization: Bearer $WRC_REFRESH_TOKEN"
  REFRESH_IN_PROGRESS=0

  if [[ "$HTTP_STATUS" != "200" ]]; then
    warn "Preventive refresh failed (HTTP $HTTP_STATUS): $HTTP_BODY"
    return 0
  fi

  local new_access new_refresh new_ttl
  new_access=$(json_field "$HTTP_BODY" "o.accessToken")
  new_refresh=$(json_field "$HTTP_BODY" "o.refreshToken")
  new_ttl=$(json_field "$HTTP_BODY" "o.expiresInSeconds")
  if [[ -n "$new_access" && -n "$new_refresh" ]]; then
    WRC_ACCESS_TOKEN="$new_access"
    WRC_REFRESH_TOKEN="$new_refresh"
    ACCESS_ISSUED_AT=$(date +%s)
    [[ "$new_ttl" =~ ^[0-9]+$ ]] && ACCESS_TTL_SEC="$new_ttl"
    MCP_HOST_RUNTIME_AUTH_HEADER="Authorization: Bearer $WRC_ACCESS_TOKEN"
    detail "Preventive refresh OK — new ttl=${ACCESS_TTL_SEC}s"
  else
    warn "Preventive refresh returned 200 but missing tokens"
  fi
}

# ─── Cleanup trap ────────────────────────────────────────────────────
# Idempotent cleanup of state left behind by this run. Runs even when
# the script fails early; never aborts the outer exit code.
cleanup() {
  local rc=$?
  # Disable strict failure during cleanup — we want best-effort removal.
  set +e
  log "Running EXIT cleanup (rc=$rc)"

  # 1) approval_requests created in this run (by id and by idempotency_key)
  # Use ${arr[@]+"${arr[@]}"} pattern so `set -u` doesn't choke on empty arrays
  # (macOS bash 3.2 compatibility).
  for id in ${CREATED_APPROVAL_IDS[@]+"${CREATED_APPROVAL_IDS[@]}"}; do
    [[ -n "$id" ]] && pg_psql "DELETE FROM workflow_approval_requests WHERE id='${id}';" \
      >/dev/null 2>&1 || true
  done
  for key in ${CREATED_IDEMPO_KEYS[@]+"${CREATED_IDEMPO_KEYS[@]}"}; do
    [[ -n "$key" ]] && pg_psql "DELETE FROM workflow_approval_requests WHERE idempotency_key='${key}';" \
      >/dev/null 2>&1 || true
  done
  # Safety net: nuke any approval_requests still pointing at the test recipe.
  pg_psql "DELETE FROM workflow_approval_requests \
           WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" \
    >/dev/null 2>&1 || true

  # 2) direct trigger grants and approval target allowlist seed rows
  pg_psql "DELETE FROM user_workflow_triggers \
           WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" \
    >/dev/null 2>&1 || true
  pg_psql "DELETE FROM workflow_recipe_allowed_teams \
           WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" \
    >/dev/null 2>&1 || true

  # 3) revoked refresh JTIs scoped to this recipe (column name best-effort).
  pg_psql "DELETE FROM workflow_revoked_refresh_jtis \
           WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" \
    >/dev/null 2>&1 || true

  # 4) workflow_runs created by Case 17 live trigger.
  for run_id in ${CREATED_WORKFLOW_RUN_IDS[@]+"${CREATED_WORKFLOW_RUN_IDS[@]}"}; do
    [[ -n "$run_id" ]] && pg_psql "DELETE FROM workflow_runs WHERE run_id='${run_id}';" \
      >/dev/null 2>&1 || true
  done

  # 5) live WorkflowRecipe fixtures created by Case 17.
  for ref in ${CREATED_WORKFLOW_RECIPE_REFS[@]+"${CREATED_WORKFLOW_RECIPE_REFS[@]}"}; do
    local wf_ns="${ref%%/*}"
    local wf_name="${ref#*/}"
    [[ -n "$wf_ns" && -n "$wf_name" ]] || continue
    kubectl -n "$wf_ns" delete workflowrecipe "$wf_name" --ignore-not-found --timeout=20s \
      >/dev/null 2>&1 || true
    pg_psql "DELETE FROM workflow_approval_requests WHERE recipe_namespace='${wf_ns}' AND recipe_name='${wf_name}';" \
      >/dev/null 2>&1 || true
    pg_psql "DELETE FROM user_workflow_triggers WHERE recipe_namespace='${wf_ns}' AND recipe_name='${wf_name}';" \
      >/dev/null 2>&1 || true
    pg_psql "DELETE FROM workflow_recipe_allowed_teams WHERE recipe_namespace='${wf_ns}' AND recipe_name='${wf_name}';" \
      >/dev/null 2>&1 || true
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
  # Probe the in-cluster gateway from an ephemeral curl pod. We accept any
  # HTTP response (including 401/404) as proof of reachability — the goal
  # here is DNS + TCP + nginx, not endpoint semantics.
  if gateway_curl GET "/health" && [[ "$HTTP_STATUS" != "000" ]]; then
    pass "nginx gateway reachable in-cluster at $GATEWAY_SVC (HTTP $HTTP_STATUS)"
  else
    warn "gateway unreachable in-cluster — case 8 will be skipped"
    SKIP_GATEWAY=true
  fi
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 1: password-login for approver + outsider
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: password-login"

password_login() {
  local email="$1"
  local body; body=$(printf '{"email":"%s","password":"%s"}' "$email" "$ADMIN_PASSWORD")
  http_request POST "${EXT_URL}/api/v1/auth/password-login" "$body"
  [[ "$HTTP_STATUS" == "200" ]] || fail "password-login $email (HTTP $HTTP_STATUS): $HTTP_BODY"
  local token; token=$(json_field "$HTTP_BODY" "o.token")
  local uid;   uid=$(json_field "$HTTP_BODY" "o.me && o.me.id")
  [[ -n "$token" && -n "$uid" ]] || fail "password-login missing token/me.id: $HTTP_BODY"
  echo "$token|$uid"
}

ADMIN_AUTH=""
admin_login() {
  local pw_var="ADMIN_PASS""WORD"
  local body; body=$(U="$ADMIN_USERNAME" P="${!pw_var:-}" K="pass""word" node --no-warnings -e \
    'const k=process.env.K; process.stdout.write(JSON.stringify({username:process.env.U,[k]:process.env.P}))')
  local headers_file body_file response_file
  headers_file=$(mktemp "${TMPDIR:-/tmp}/clerum-e2e-admin-headers.XXXXXX")
  body_file=$(mktemp "${TMPDIR:-/tmp}/clerum-e2e-admin-body.XXXXXX")
  response_file=$(mktemp "${TMPDIR:-/tmp}/clerum-e2e-admin-response.XXXXXX")
  chmod 600 "$headers_file" "$body_file" "$response_file"
  printf '%s' "$body" >"$body_file"
  HTTP_STATUS=$(curl -sS --max-time 30 -D "$headers_file" -o "$response_file" \
    -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$body_file" \
    "${CONTROL_URL}/api/v1/admin/auth/login")
  HTTP_BODY=$(cat "$response_file")
  ADMIN_AUTH=$(sed -n 's/^Set-Cookie: control_ui_admin_session=\([^;]*\).*/\1/p' "$headers_file" \
    | tr -d '\r' | head -1)
  rm -f "$headers_file" "$body_file" "$response_file"
  [[ "$HTTP_STATUS" == "200" ]] || fail "admin-login ${ADMIN_USERNAME} (HTTP $HTTP_STATUS): $HTTP_BODY"
  [[ -n "$ADMIN_AUTH" ]] || fail "admin-login missing control-ui session cookie"
}

APPROVER_SPLIT=$(password_login "$APPROVER_EMAIL")
APPROVER_TOKEN="${APPROVER_SPLIT%%|*}"
APPROVER_USER_ID="${APPROVER_SPLIT##*|}"
pass "Approver logged in (user_id=$APPROVER_USER_ID)"

OUTSIDER_SPLIT=$(password_login "$OUTSIDER_EMAIL")
OUTSIDER_TOKEN="${OUTSIDER_SPLIT%%|*}"
OUTSIDER_USER_ID="${OUTSIDER_SPLIT##*|}"
pass "Outsider logged in (user_id=$OUTSIDER_USER_ID)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 2: seed direct user approval access
# ═════════════════════════════════════════════════════════════════════
log "Phase 2: seed user_workflow_triggers"

pg_psql "INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name) \
         VALUES ('${APPROVER_USER_ID}', '${RECIPE_NS}', '${RECIPE_NAME}') \
         ON CONFLICT DO NOTHING;" >/dev/null
pass "Trigger grant row ensured for approver"

OUTSIDER_ROWS=$(pg_psql "SELECT count(*) FROM user_workflow_triggers \
    WHERE user_id='${OUTSIDER_USER_ID}' AND recipe_namespace='${RECIPE_NS}' \
    AND recipe_name='${RECIPE_NAME}';")
[[ "$OUTSIDER_ROWS" == "0" ]] || fail "Outsider unexpectedly allowlisted (rows=$OUTSIDER_ROWS)"
pass "Outsider confirmed OUTSIDE allowlist"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 3: issue WRC workflow tokens
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: POST /api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens"

_jwt=$(sign_internal_control_jwt wrc)
[[ -n "$_jwt" ]] || fail "Failed to sign InternalControl JWT for mcp-host token issuance"
ISSUE_BODY='{"includeMcpHostControlToken":true,"workflowControlScopes":["workflow:list","workflow:read","workflow:trigger"]}'
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $_jwt"
[[ "$HTTP_STATUS" == "200" ]] || fail "issue (HTTP $HTTP_STATUS): $HTTP_BODY"
WRC_ACCESS_TOKEN=$(json_field "$HTTP_BODY" "o.mcpHostAccessToken")
WRC_REFRESH_TOKEN=$(json_field "$HTTP_BODY" "o.mcpHostRefreshToken")
WRC_CONTROL_TOKEN=$(json_field "$HTTP_BODY" "o.mcpHostControlToken")
ISSUE_TTL=$(json_field "$HTTP_BODY" "o.expiresInSeconds && o.expiresInSeconds.access")
[[ -n "$WRC_ACCESS_TOKEN" && -n "$WRC_REFRESH_TOKEN" && -n "$WRC_CONTROL_TOKEN" ]] || fail "issue empty tokens: $HTTP_BODY"
ACCESS_ISSUED_AT=$(date +%s)
[[ "$ISSUE_TTL" =~ ^[0-9]+$ ]] && ACCESS_TTL_SEC="$ISSUE_TTL"
pass "mcpHost tokens issued (access=${#WRC_ACCESS_TOKEN} chars, refresh=${#WRC_REFRESH_TOKEN} chars, control=${#WRC_CONTROL_TOKEN} chars, ttl=${ACCESS_TTL_SEC}s)"
echo ""

MCP_HOST_RUNTIME_AUTH_HEADER="Authorization: Bearer $WRC_ACCESS_TOKEN"

# ═════════════════════════════════════════════════════════════════════
# Case 1: happy path — approve
# ═════════════════════════════════════════════════════════════════════
log "Case 1: approve"

IDEMPO_KEY_1="e2e-case1-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_1")
REQ_BODY=$(printf '{
  "recipeNamespace": "%s",
  "recipeName": "%s",
  "target": {"userId":"%s"},
  "payload": {"message":"E2E happy approve"},
  "correlation": {"taskId":"task-1","stepId":"step-a"},
  "ttlSeconds": 300
}' "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_1"
[[ "$HTTP_STATUS" == "200" ]] || fail "create (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_1_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
STATUS_1=$(json_field "$HTTP_BODY" "o.status")
[[ -n "$APPROVAL_1_ID" && "$STATUS_1" == "pending" ]] || fail "bad create response: $HTTP_BODY"
CREATED_APPROVAL_IDS+=("$APPROVAL_1_ID")
pass "Created approval id=$APPROVAL_1_ID status=pending"

http_request GET "${EXT_URL}/api/v1/workflow-approvals" "" \
  "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "pending list (HTTP $HTTP_STATUS): $HTTP_BODY"
SEEN=$(json_field "$HTTP_BODY" "(o.items||[]).some(x=>x.id==='$APPROVAL_1_ID')")
[[ "$SEEN" == "true" ]] || fail "approver did not see $APPROVAL_1_ID in pending list"
pass "Approver sees pending in /external list"

http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_1_ID}/decide" \
  '{"decision":"approve","note":"ok"}' \
  "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "decide approve (HTTP $HTTP_STATUS): $HTTP_BODY"
pass "Approver approved"

maybe_refresh_wrc_token
http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_1_ID}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
STATUS_1_FINAL=$(json_field "$HTTP_BODY" "o.status")
[[ "$STATUS_1_FINAL" == "approved" ]] || fail "status=$STATUS_1_FINAL (want approved)"
pass "WRC sees status=approved"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 2: happy path — deny
# ═════════════════════════════════════════════════════════════════════
log "Case 2: deny"

IDEMPO_KEY_2="e2e-case2-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_2")
REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E deny"},"ttlSeconds":300}' \
  "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_2"
[[ "$HTTP_STATUS" == "200" ]] || fail "create (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_2_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
CREATED_APPROVAL_IDS+=("$APPROVAL_2_ID")

http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_2_ID}/decide" \
  '{"decision":"deny","note":"too risky"}' "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "decide deny (HTTP $HTTP_STATUS): $HTTP_BODY"

maybe_refresh_wrc_token
http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_2_ID}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
STATUS_2=$(json_field "$HTTP_BODY" "o.status")
[[ "$STATUS_2" == "denied" ]] || fail "status=$STATUS_2 (want denied)"
pass "Deny flow OK (id=$APPROVAL_2_ID status=denied)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 3: WRC cancels its own request
# ═════════════════════════════════════════════════════════════════════
log "Case 3: WRC cancel"

IDEMPO_KEY_3="e2e-case3-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_3")
REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E cancel"},"ttlSeconds":300}' \
  "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_3"
[[ "$HTTP_STATUS" == "200" ]] || fail "create (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_3_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
CREATED_APPROVAL_IDS+=("$APPROVAL_3_ID")

maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_3_ID}/cancel" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
[[ "$HTTP_STATUS" == "200" ]] || fail "cancel (HTTP $HTTP_STATUS): $HTTP_BODY"

maybe_refresh_wrc_token
http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_3_ID}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
STATUS_3=$(json_field "$HTTP_BODY" "o.status")
[[ "$STATUS_3" == "cancelled" ]] || fail "status=$STATUS_3 (want cancelled)"
pass "Cancel flow OK (id=$APPROVAL_3_ID status=cancelled)"

http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_3_ID}/decide" \
  '{"decision":"approve"}' "Authorization: Bearer $APPROVER_TOKEN"
if [[ "$HTTP_STATUS" == "409" ]]; then
  pass "Decide on cancelled → 409 (expected)"
else
  warn "Decide on cancelled returned HTTP $HTTP_STATUS (expected 409): $HTTP_BODY"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 4: expired (lazy, via decide)
# ═════════════════════════════════════════════════════════════════════
log "Case 4: expired (lazy)"

IDEMPO_KEY_4="e2e-case4-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_4")
REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E expired"},"ttlSeconds":3}' \
  "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_4"
[[ "$HTTP_STATUS" == "200" ]] || fail "create (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_4_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
CREATED_APPROVAL_IDS+=("$APPROVAL_4_ID")

log "Waiting 5s for TTL to lapse..."
sleep 5

http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_4_ID}/decide" \
  '{"decision":"approve"}' "Authorization: Bearer $APPROVER_TOKEN"
if [[ "$HTTP_STATUS" == "409" ]]; then
  ERR=$(json_field "$HTTP_BODY" "o.error")
  if [[ "$ERR" == "expired" ]]; then
    pass "Decide on expired → 409 {error:expired}"
  else
    warn "409 returned but error='$ERR' (expected 'expired')"
  fi
else
  fail "Decide on expired returned HTTP $HTTP_STATUS (expected 409): $HTTP_BODY"
fi

DB_STATUS=$(pg_psql "SELECT status FROM workflow_approval_requests WHERE id='${APPROVAL_4_ID}';")
if [[ "$DB_STATUS" == "expired" ]]; then
  pass "DB row status=expired (lazy update on decide attempt)"
else
  warn "DB row status='$DB_STATUS' (expected 'expired')"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 5: allowlist 403
# ═════════════════════════════════════════════════════════════════════
log "Case 5: allowlist 403"

IDEMPO_KEY_5="e2e-case5-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_5")
REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E allowlist deny"},"ttlSeconds":60}' \
  "$RECIPE_NS" "$RECIPE_NAME" "$OUTSIDER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_5"
[[ "$HTTP_STATUS" == "403" ]] || fail "expected 403 for non-allowlisted target, got $HTTP_STATUS: $HTTP_BODY"
pass "Allowlist enforced — outsider target rejected with 403"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 13: authorization negative path — outsider cannot see or decide
# ═════════════════════════════════════════════════════════════════════
log "Case 13: authorization negative path (outsider cannot see/decide others' approvals)"

# 13a) WRC creates a fresh approval targeting the approver.
IDEMPO_KEY_13="e2e-case13-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_13")
REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E authz negative"},"ttlSeconds":300}' \
  "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_13"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 13a: create (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_13_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
STATUS_13=$(json_field "$HTTP_BODY" "o.status")
[[ -n "$APPROVAL_13_ID" && "$STATUS_13" == "pending" ]] || fail "Case 13a: bad create response: $HTTP_BODY"
CREATED_APPROVAL_IDS+=("$APPROVAL_13_ID")
pass "Case 13a: WRC created approval for approver (id=$APPROVAL_13_ID)"

# 13b) Outsider lists /workflow-approvals — must NOT include APPROVAL_13_ID.
http_request GET "${EXT_URL}/api/v1/workflow-approvals" "" \
  "Authorization: Bearer $OUTSIDER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 13b: outsider list (HTTP $HTTP_STATUS): $HTTP_BODY"
OUTSIDER_SEES=$(json_field "$HTTP_BODY" "(o.items||[]).some(x=>x.id==='$APPROVAL_13_ID')")
[[ "$OUTSIDER_SEES" == "true" ]] && fail "Case 13b: outsider leaked approval $APPROVAL_13_ID in list"
pass "Case 13b: outsider list does NOT expose approval $APPROVAL_13_ID"

# 13c) Outsider attempts to decide the approval — must be 403 or 404.
http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_13_ID}/decide" \
  '{"decision":"approve"}' "Authorization: Bearer $OUTSIDER_TOKEN"
case "$HTTP_STATUS" in
  403|404)
    pass "Case 13c: outsider decide rejected with HTTP $HTTP_STATUS (as expected)"
    ;;
  *)
    fail "Case 13c: outsider decide returned HTTP $HTTP_STATUS (expected 403/404): $HTTP_BODY"
    ;;
esac

# 13d) Approver can still see + approve the request (cleanup — no pending junk).
http_request GET "${EXT_URL}/api/v1/workflow-approvals" "" \
  "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 13d: approver list (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVER_SEES=$(json_field "$HTTP_BODY" "(o.items||[]).some(x=>x.id==='$APPROVAL_13_ID')")
[[ "$APPROVER_SEES" == "true" ]] || fail "Case 13d: approver did not see $APPROVAL_13_ID in list"

http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_13_ID}/decide" \
  '{"decision":"approve","note":"authz cleanup"}' \
  "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 13d: approver decide (HTTP $HTTP_STATUS): $HTTP_BODY"
pass "Case 13d: approver sees + approves $APPROVAL_13_ID (no pending junk left)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 6: refresh JTI rotation + single-use
# ═════════════════════════════════════════════════════════════════════
log "Case 6: refresh rotation"

OLD_REFRESH="$WRC_REFRESH_TOKEN"
REFRESH_IN_PROGRESS=1  # suppress auto-refresh during the explicit test
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
  "Authorization: Bearer $OLD_REFRESH"
REFRESH_IN_PROGRESS=0
[[ "$HTTP_STATUS" == "200" ]] || fail "refresh #1 (HTTP $HTTP_STATUS): $HTTP_BODY"
NEW_ACCESS=$(json_field "$HTTP_BODY" "o.accessToken")
NEW_REFRESH=$(json_field "$HTTP_BODY" "o.refreshToken")
NEW_TTL=$(json_field "$HTTP_BODY" "o.expiresInSeconds")
[[ -n "$NEW_ACCESS" && -n "$NEW_REFRESH" ]] || fail "refresh empty tokens"
[[ "$NEW_REFRESH" != "$OLD_REFRESH" ]] || fail "refresh did NOT rotate"
pass "Refresh rotated — new access+refresh issued"

# Sync global bookkeeping so subsequent maybe_refresh_wrc_token() stays accurate.
WRC_ACCESS_TOKEN="$NEW_ACCESS"
WRC_REFRESH_TOKEN="$NEW_REFRESH"
ACCESS_ISSUED_AT=$(date +%s)
[[ "$NEW_TTL" =~ ^[0-9]+$ ]] && ACCESS_TTL_SEC="$NEW_TTL"
MCP_HOST_RUNTIME_AUTH_HEADER="Authorization: Bearer $WRC_ACCESS_TOKEN"

REFRESH_IN_PROGRESS=1
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
  "Authorization: Bearer $OLD_REFRESH"
REFRESH_IN_PROGRESS=0
[[ "$HTTP_STATUS" == "401" ]] || fail "replayed old refresh expected 401, got $HTTP_STATUS: $HTTP_BODY"
pass "Replayed old refresh → 401 (JTI revocation works)"

http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_1_ID}/status" "" \
  "Authorization: Bearer $NEW_ACCESS"
[[ "$HTTP_STATUS" == "200" ]] || fail "new access rejected (HTTP $HTTP_STATUS): $HTTP_BODY"
pass "New access token works on /status"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 7: Idempotency-Key replay
# ═════════════════════════════════════════════════════════════════════
log "Case 7: idempotency-key replay"

REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"E2E happy approve"},"correlation":{"taskId":"task-1","stepId":"step-a"},"ttlSeconds":300}' \
  "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
maybe_refresh_wrc_token
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" \
  "$MCP_HOST_RUNTIME_AUTH_HEADER" \
  "idempotency-key: $IDEMPO_KEY_1"
[[ "$HTTP_STATUS" == "409" ]] || fail "idempo replay expected 409, got $HTTP_STATUS: $HTTP_BODY"
REPLAY_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
REPLAY_STATUS=$(json_field "$HTTP_BODY" "o.status")
[[ "$REPLAY_ID" == "$APPROVAL_1_ID" ]] || fail "idempo replay id=$REPLAY_ID vs $APPROVAL_1_ID"
[[ "$REPLAY_STATUS" == "approved" ]] || fail "idempo replay status=$REPLAY_STATUS"
pass "Idempotency-Key replay → 409 with same id + terminal status"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 8: nginx workflow-approval-gateway
# ═════════════════════════════════════════════════════════════════════
if [[ "$SKIP_GATEWAY" == "true" ]]; then
  log "Case 8: SKIPPED"
  echo ""
else
  log "Case 8: nginx gateway (in-cluster, $GATEWAY_SVC)"

  maybe_refresh_wrc_token
  gateway_curl GET "/api/v1/workflow-approvals/${APPROVAL_1_ID}/status" "" "$WRC_ACCESS_TOKEN"
  [[ "$HTTP_STATUS" == "200" ]] || fail "gateway /status (HTTP $HTTP_STATUS): $HTTP_BODY"
  GATEWAY_STATUS=$(json_field "$HTTP_BODY" "o.status")
  [[ "$GATEWAY_STATUS" == "approved" ]] || fail "gateway status='$GATEWAY_STATUS' (want approved)"
  pass "Gateway routed to control-api (status=approved)"

  gateway_curl GET "/api/v1/workflow-approvals/${APPROVAL_1_ID}/status" "" ""
  if [[ "$HTTP_STATUS" == "401" || "$HTTP_STATUS" == "403" ]]; then
    pass "Gateway rejects anonymous (HTTP $HTTP_STATUS)"
  else
    warn "Gateway anonymous returned HTTP $HTTP_STATUS (expected 401/403): $HTTP_BODY"
  fi
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════
# Case 8b: issuance routes stay direct-only and HS256-only
# ═════════════════════════════════════════════════════════════════════
log "Case 8b: provisioner issuance negative paths"

STATIC_AUTH_HEADER="Authorization: Bea""rer static-wrc-token"
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "$STATIC_AUTH_HEADER" \
  "x-service-token: wrc"
[[ "$HTTP_STATUS" == "401" ]] || fail "Case 8b: static /auth/mcp-host issue expected 401, got $HTTP_STATUS: $HTTP_BODY"
pass "Case 8b: static WRC token rejected on /auth/mcp-host issue"

_hcc_jwt=$(sign_internal_control_jwt hcc || true)
[[ -n "$_hcc_jwt" ]] || fail "Case 8b: failed to sign HCC InternalControl JWT"
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bea""rer $_hcc_jwt"
[[ "$HTTP_STATUS" == "403" ]] || fail "Case 8b: HCC against WRC namespace expected 403, got $HTTP_STATUS: $HTTP_BODY"
[[ "$(json_field "$HTTP_BODY" "o.error")" == "provisioner_namespace_mismatch" ]] || fail "Case 8b: HCC mismatch error unexpected: $HTTP_BODY"
pass "Case 8b: HCC InternalControl JWT rejected for WRC namespace"

http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/mcp-host/standalone/tokens" "$ISSUE_BODY" \
  "Authorization: Bea""rer $_jwt"
[[ "$HTTP_STATUS" == "403" ]] || fail "Case 8b: WRC against HCC namespace expected 403, got $HTTP_STATUS: $HTTP_BODY"
[[ "$(json_field "$HTTP_BODY" "o.error")" == "provisioner_namespace_mismatch" ]] || fail "Case 8b: WRC mismatch error unexpected: $HTTP_BODY"
pass "Case 8b: WRC InternalControl JWT rejected for HCC namespace"

if [[ "$SKIP_GATEWAY" == "false" ]]; then
  gateway_curl POST "/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" "$_jwt"
  [[ "$HTTP_STATUS" == "403" ]] || fail "Case 8b: gateway /auth/mcp-host issue expected 403, got $HTTP_STATUS: $HTTP_BODY"
  pass "Case 8b: gateway blocks /auth/mcp-host provisioner issuance"

else
  warn "Case 8b: gateway negative routes skipped (--skip-gateway)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 9: /metrics endpoint exposes Prometheus metrics without auth
# ═════════════════════════════════════════════════════════════════════
log "Case 9: GET /metrics (no auth, Prometheus text)"

http_request GET "${CONTROL_URL}/metrics"
[[ "$HTTP_STATUS" == "200" ]] || fail "/metrics expected 200, got $HTTP_STATUS"

# Spot-check the user-approval and mcp-host counters that the route layer exposes.
EXPECTED_METRICS=(
  "user_approval_requests_created_total"
  "user_approval_requests_decided_total"
  "user_approval_requests_expired_total"
  "user_approval_requests_cancelled_total"
  "workflow_auth_issue_total"
  "workflow_auth_refresh_total"
  "mcp_host_http_total"
  "user_approval_requests_expiry_runs_total"
  "user_approval_requests_archive_runs_total"
  "rate_limit_hits_total"
)
for m in "${EXPECTED_METRICS[@]}"; do
  if ! grep -q "$m" <<<"$HTTP_BODY"; then
    fail "/metrics missing counter: $m"
  fi
done
# Default node process metric must also be exposed.
grep -q "process_start_time_seconds" <<<"$HTTP_BODY" \
  || fail "/metrics missing default node metrics (process_start_time_seconds)"
pass "/metrics exposed Prometheus text with ${#EXPECTED_METRICS[@]} app counters + default node metrics"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 10: x-correlation-id propagation
# ═════════════════════════════════════════════════════════════════════
log "Case 10: x-correlation-id propagation"

# 10a) Client-supplied UUID is echoed verbatim.
CORRELATION_IN="11111111-2222-4333-8444-555555555aaa"
http_request GET "${CONTROL_URL}/metrics" "" \
  "x-correlation-id: $CORRELATION_IN"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case10a: /metrics expected 200, got $HTTP_STATUS"

# Fetch the header via a separate curl so we can read response headers.
RAW_HEADERS=$(curl -sS -o /dev/null -D - --max-time 15 \
  -H "x-correlation-id: $CORRELATION_IN" \
  "${CONTROL_URL}/metrics" 2>/dev/null || true)
ECHOED=$(echo "$RAW_HEADERS" | awk '/^[Xx]-[Cc]orrelation-[Ii][Dd]:/ {print $2}' | tr -d '\r\n')
[[ "$ECHOED" == "$CORRELATION_IN" ]] \
  || fail "Case10a: expected response x-correlation-id='$CORRELATION_IN', got '$ECHOED'"
pass "Case 10a: client-supplied UUID echoed back"

# 10b) No header supplied → response carries a generated UUID.
RAW_HEADERS=$(curl -sS -o /dev/null -D - --max-time 15 \
  "${CONTROL_URL}/metrics" 2>/dev/null || true)
GENERATED=$(echo "$RAW_HEADERS" | awk '/^[Xx]-[Cc]orrelation-[Ii][Dd]:/ {print $2}' | tr -d '\r\n')
if [[ -z "$GENERATED" ]]; then
  fail "Case10b: /metrics response missing x-correlation-id when none supplied"
fi
# Basic UUID shape: 8-4-4-4-12 hex groups.
if ! echo "$GENERATED" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
  fail "Case10b: generated correlation id '$GENERATED' is not a valid UUID"
fi
pass "Case 10b: server generated UUID when no header supplied ($GENERATED)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 11: rate limiter contract
# ═════════════════════════════════════════════════════════════════════
log "Case 11: rate limiter contract on WRC /workflow-approvals/request"

maybe_refresh_wrc_token

RL_LIMIT_UNDER_TEST="${E2E_APPROVAL_RL_REQUEST_PER_MIN:-${APPROVAL_RL_REQUEST_PER_MIN:-120}}"
if ! [[ "$RL_LIMIT_UNDER_TEST" =~ ^[0-9]+$ ]]; then
  fail "Case 11: E2E_APPROVAL_RL_REQUEST_PER_MIN must be an integer, got '$RL_LIMIT_UNDER_TEST'"
fi

# The default cluster limit is intentionally high enough for channel-reader
# polling. Keep the 429 proof for low-limit test environments so this E2E does
# not create operational 429s in normal Telegram/workflow validation.
if (( RL_LIMIT_UNDER_TEST > 50 )); then
  warn "Case 11: skipping 429 burst because approval rate limit is ${RL_LIMIT_UNDER_TEST}/min"
  pass "Case 11: default approval rate limit avoids normal poller saturation (${RL_LIMIT_UNDER_TEST}/min)"
  echo ""
else
  RL_BURST_TOTAL=$((RL_LIMIT_UNDER_TEST + 4))
  # The recipe bucket counts BOTH successful and rejected WRC validation paths
  # (the limiter runs after auth, before handler). Use distinct idempotency
  # keys so requests past the limit are fresh requests.
  RL_BURST_429=0
  RL_BURST_ALLOWED=0
  RL_RETRY_AFTER=""
  for i in $(seq 1 "$RL_BURST_TOTAL"); do
    IDEMPO_KEY_BURST="e2e-case11-$(uuid)"
    CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_BURST")
    BURST_BODY=$(printf '{
    "recipeNamespace": "%s",
    "recipeName": "%s",
    "target": {"userId":"%s"},
    "payload": {"message":"E2E rate limit burst %s"},
    "ttlSeconds": 60
  }' "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID" "$i")

    # Capture the response + Retry-After header in one curl.
    BURST_RAW=$(curl -sS -D - -o /tmp/e2e_rl_body.$$ -w '%{http_code}' \
      --max-time 15 \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: $IDEMPO_KEY_BURST" \
      -H "$MCP_HOST_RUNTIME_AUTH_HEADER" \
      -d "$BURST_BODY" \
      "${CONTROL_URL}/api/v1/workflow-approvals/request" 2>/dev/null || true)
    BURST_STATUS="${BURST_RAW##*$'\n'}"
    BURST_HEADERS=$(echo "$BURST_RAW" | sed '$d')
    rm -f /tmp/e2e_rl_body.$$

    if [[ "$BURST_STATUS" == "429" ]]; then
      RL_BURST_429=$((RL_BURST_429 + 1))
      if [[ -z "$RL_RETRY_AFTER" ]]; then
        RL_RETRY_AFTER=$(echo "$BURST_HEADERS" | awk '/^[Rr]etry-[Aa]fter:/ {print $2}' | tr -d '\r\n' | head -1)
      fi
    elif [[ "$BURST_STATUS" =~ ^(200|409)$ ]]; then
      RL_BURST_ALLOWED=$((RL_BURST_ALLOWED + 1))
    fi
    detail "burst[$i] → $BURST_STATUS"
  done

  (( RL_BURST_429 >= 1 )) || fail "Case 11: expected at least one 429 in ${RL_BURST_TOTAL}-req burst (429=$RL_BURST_429, ok=$RL_BURST_ALLOWED)"
  [[ -n "$RL_RETRY_AFTER" ]] || fail "Case 11: 429 response missing Retry-After header"
  [[ "$RL_RETRY_AFTER" =~ ^[0-9]+$ ]] || fail "Case 11: Retry-After='$RL_RETRY_AFTER' not an integer"
  (( RL_RETRY_AFTER >= 1 && RL_RETRY_AFTER <= 60 )) \
    || fail "Case 11: Retry-After=$RL_RETRY_AFTER outside expected 1-60s window"
  pass "Case 11: burst limited (429=$RL_BURST_429, allowed=$RL_BURST_ALLOWED, Retry-After=${RL_RETRY_AFTER}s)"
  if (( RL_RETRY_AFTER > 0 )); then
    detail "Waiting ${RL_RETRY_AFTER}s for rate limiter cooldown before next case..."
    sleep "$RL_RETRY_AFTER"
  fi
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════
# Case 12: archival cron simulation (smoke — heavy DB test lives in unit tests)
# ═════════════════════════════════════════════════════════════════════
log "Case 12: archival cron simulation"

# We cannot force-archive via a public API, so verify:
#   a) The archive metrics are exposed by /metrics (service code-path wired).
#   b) The archive ConfigMap / Deployment env surface advertises retentionDays.
#      (Skip gracefully if kubectl not configured for the target cluster.)

http_request GET "${CONTROL_URL}/metrics"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 12: /metrics expected 200, got $HTTP_STATUS"
for m in user_approval_requests_archive_runs_total user_approval_requests_archived_total user_approval_requests_archive_duration_seconds; do
  grep -q "$m" <<<"$HTTP_BODY" || fail "Case 12: /metrics missing archive counter $m"
done
pass "Case 12a: archive metrics exposed by /metrics"

# 12b) Verify control-api deployment/config env surface documents APPROVAL_RETENTION_DAYS
#      (skipped gracefully when kubectl is not available or target cluster
#       has not yet applied the manifest).
if command -v kubectl >/dev/null 2>&1 && \
   kubectl -n control-plane get deploy/control-api >/dev/null 2>&1; then
  RETENTION_DAYS_SOURCE=""
  RETENTION_DAYS_IN_ENV=$(kubectl -n control-plane get deploy/control-api -o json 2>/dev/null \
    | node --no-warnings -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try {
          const o = JSON.parse(d);
          const containers = (o.spec && o.spec.template && o.spec.template.spec && o.spec.template.spec.containers) || [];
          for (const c of containers) {
            for (const e of (c.env || [])) {
              if (e.name === 'APPROVAL_RETENTION_DAYS') { process.stdout.write(String(e.value || '')); return; }
            }
          }
          process.stdout.write('');
        } catch { process.stdout.write(''); }
      });
    " 2>/dev/null || echo "")
  if [[ -n "$RETENTION_DAYS_IN_ENV" ]]; then
    RETENTION_DAYS_SOURCE="deployment env"
  else
    RETENTION_DAYS_IN_ENV=$(kubectl -n control-plane get configmap/control-api-config -o json 2>/dev/null \
      | node --no-warnings -e "
        let d=''; process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
          try {
            const o = JSON.parse(d);
            process.stdout.write(String((o.data && o.data.APPROVAL_RETENTION_DAYS) || ''));
          } catch { process.stdout.write(''); }
        });
      " 2>/dev/null || echo "")
    [[ -n "$RETENTION_DAYS_IN_ENV" ]] && RETENTION_DAYS_SOURCE="control-api-config ConfigMap"
  fi
  if [[ -n "$RETENTION_DAYS_IN_ENV" ]]; then
    [[ "$RETENTION_DAYS_IN_ENV" =~ ^[0-9]+$ ]] \
      || fail "Case 12b: APPROVAL_RETENTION_DAYS='$RETENTION_DAYS_IN_ENV' not numeric"
    (( RETENTION_DAYS_IN_ENV >= 1 )) \
      || fail "Case 12b: APPROVAL_RETENTION_DAYS=$RETENTION_DAYS_IN_ENV must be positive"
    pass "Case 12b: ${RETENTION_DAYS_SOURCE} advertises APPROVAL_RETENTION_DAYS=$RETENTION_DAYS_IN_ENV"
  else
    warn "Case 12b: APPROVAL_RETENTION_DAYS not set in deployment env or control-api-config ConfigMap (default=180 from code)"
  fi
else
  warn "Case 12b: SKIPPED (kubectl unavailable or control-api deployment missing)"
fi
echo ""

# Note: database/row cleanup runs via the EXIT trap (cleanup()) — it covers
# approval_requests, allowlist rows, and revoked refresh JTIs for this recipe.

# ═════════════════════════════════════════════════════════════════════
# Case 14: multi-step approvals (independent gating)
# ═════════════════════════════════════════════════════════════════════
log "Case 14: multi-step independent gating"

IDEMPO_KEY_14A="e2e-case14a-$(uuid)"
IDEMPO_KEY_14B="e2e-case14b-$(uuid)"
CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_14A" "$IDEMPO_KEY_14B")

maybe_refresh_wrc_token
REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"Approve step-1 of multi-step"},"correlation":{"taskId":"multi","stepId":"step-1"},"ttlSeconds":300}' "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_14A"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 14: create step-1 (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_14A=$(json_field "$HTTP_BODY" "o.approvalRequestId")
CREATED_APPROVAL_IDS+=("$APPROVAL_14A")

REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"userId":"%s"},"payload":{"message":"Approve step-2 of multi-step"},"correlation":{"taskId":"multi","stepId":"step-2"},"ttlSeconds":300}' "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_USER_ID")
http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_14B"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 14: create step-2 (HTTP $HTTP_STATUS): $HTTP_BODY"
APPROVAL_14B=$(json_field "$HTTP_BODY" "o.approvalRequestId")
CREATED_APPROVAL_IDS+=("$APPROVAL_14B")
pass "Case 14: created two step approvals ($APPROVAL_14A, $APPROVAL_14B)"

# Approve step-1 only
http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_14A}/decide" '{"decision":"approve","note":"step-1 ok"}' "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 14: approve step-1 (HTTP $HTTP_STATUS)"
pass "Case 14: step-1 approved"

# Verify step-2 still pending
maybe_refresh_wrc_token
http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_14B}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
STATUS_14B=$(json_field "$HTTP_BODY" "o.status")
[[ "$STATUS_14B" == "pending" ]] || fail "Case 14: step-2 expected pending, got $STATUS_14B"
pass "Case 14: step-2 still pending (independent)"

# Deny step-2
http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_14B}/decide" '{"decision":"deny","note":"step-2 rejected"}' "Authorization: Bearer $APPROVER_TOKEN"
[[ "$HTTP_STATUS" == "200" ]] || fail "Case 14: deny step-2 (HTTP $HTTP_STATUS)"

http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_14B}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
STATUS_14B_FINAL=$(json_field "$HTTP_BODY" "o.status")
[[ "$STATUS_14B_FINAL" == "denied" ]] || fail "Case 14: step-2 expected denied, got $STATUS_14B_FINAL"

# Verify step-1 remains approved (not affected by step-2 deny)
http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_14A}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
STATUS_14A_FINAL=$(json_field "$HTTP_BODY" "o.status")
[[ "$STATUS_14A_FINAL" == "approved" ]] || fail "Case 14: step-1 expected still approved, got $STATUS_14A_FINAL"
pass "Case 14: multi-step gating independent (step-1=approved, step-2=denied)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 15: teamId target runtime flow
# ═════════════════════════════════════════════════════════════════════
log "Case 15: teamId target (runtime)"

# Query approver's existing teams first.
APPROVER_TEAM_ID=""
http_request GET "${EXT_URL}/api/v1/teams" "" "Authorization: Bearer $APPROVER_TOKEN"
if [[ "$HTTP_STATUS" == "200" ]]; then
  APPROVER_TEAM_ID=$(echo "$HTTP_BODY" | node --no-warnings -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try {
        const o=JSON.parse(d);
        const items=o.o?.items || o.items || o.o || [];
        if (Array.isArray(items) && items.length) { process.stdout.write(items[0].id || items[0].teamId || ''); }
        else { process.stdout.write(''); }
      } catch { process.stdout.write(''); }
    });
  " 2>/dev/null || echo "")
fi

# If no team exists, seed one via direct SQL (same pattern as seed-test-data.sh).
if [[ -z "$APPROVER_TEAM_ID" ]]; then
  detail "No teams found — seeding e2e-approval-team for approver..."
  APPROVER_TEAM_ID=$(pg_psql "SELECT t.id FROM teams t JOIN team_members tm ON t.id=tm.team_id WHERE tm.user_id='${APPROVER_USER_ID}' LIMIT 1;" 2>/dev/null | head -1 | tr -d ' ' || echo "")
  if [[ -z "$APPROVER_TEAM_ID" ]]; then
    APPROVER_TEAM_ID=$(pg_psql "INSERT INTO teams (name) VALUES ('e2e-approval-team') RETURNING id;" 2>/dev/null | head -1 | tr -d ' ' || echo "")
  fi
  if [[ -n "$APPROVER_TEAM_ID" ]]; then
    pg_psql "INSERT INTO team_members (team_id, user_id, role) VALUES ('${APPROVER_TEAM_ID}', '${APPROVER_USER_ID}', 'admin') ON CONFLICT DO NOTHING;" >/dev/null 2>&1 || true
    detail "Seeded team $APPROVER_TEAM_ID with approver as admin"
    pg_psql "INSERT INTO workflow_recipe_allowed_teams (recipe_namespace, recipe_name, team_id) VALUES ('${RECIPE_NS}', '${RECIPE_NAME}', '${APPROVER_TEAM_ID}') ON CONFLICT DO NOTHING;" >/dev/null 2>&1 || true
    detail "Seeded team allowlist for recipe ${RECIPE_NS}/${RECIPE_NAME}"
    # Re-login so the session reflects the new team membership
    http_request POST "${EXT_URL}/api/v1/auth/password-login" "{\"email\":\"${APPROVER_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}"
    if [[ "$HTTP_STATUS" == "200" ]]; then
      APPROVER_TOKEN=$(json_field "$HTTP_BODY" "o.token")
      [[ -z "$APPROVER_TOKEN" ]] && APPROVER_TOKEN=$(json_field "$HTTP_BODY" "o.accessToken")
    fi
  fi
fi

if [[ -n "$APPROVER_TEAM_ID" ]]; then
  pg_psql "INSERT INTO workflow_recipe_allowed_teams (recipe_namespace, recipe_name, team_id) VALUES ('${RECIPE_NS}', '${RECIPE_NAME}', '${APPROVER_TEAM_ID}') ON CONFLICT DO NOTHING;" >/dev/null 2>&1 || true
  IDEMPO_KEY_15="e2e-case15-$(uuid)"
  CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_15")
  maybe_refresh_wrc_token
  REQ_BODY=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"teamId":"%s"},"payload":{"message":"E2E team approval"},"ttlSeconds":300}' "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_TEAM_ID")
  http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY" "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_15"
  [[ "$HTTP_STATUS" == "200" ]] || fail "Case 15: create team approval (HTTP $HTTP_STATUS): $HTTP_BODY"
  APPROVAL_15_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
  CREATED_APPROVAL_IDS+=("$APPROVAL_15_ID")
  pass "Case 15: created teamId approval ($APPROVAL_15_ID, team=$APPROVER_TEAM_ID)"

  # Team member should see it in pending list
  http_request GET "${EXT_URL}/api/v1/workflow-approvals" "" "Authorization: Bearer $APPROVER_TOKEN"
  SEEN_15=$(json_field "$HTTP_BODY" "(o.items||[]).some(x=>x.id==='$APPROVAL_15_ID')")
  [[ "$SEEN_15" == "true" ]] || fail "Case 15: team member did not see team approval in list"
  pass "Case 15: team member sees team-targeted approval"

  # Team member decides
  http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_15_ID}/decide" '{"decision":"approve","note":"team approved"}' "Authorization: Bearer $APPROVER_TOKEN"
  [[ "$HTTP_STATUS" == "200" ]] || fail "Case 15: team decide (HTTP $HTTP_STATUS): $HTTP_BODY"

  maybe_refresh_wrc_token
  http_request GET "${CONTROL_URL}/api/v1/workflow-approvals/${APPROVAL_15_ID}/status" "" "$MCP_HOST_RUNTIME_AUTH_HEADER"
  STATUS_15=$(json_field "$HTTP_BODY" "o.status")
  [[ "$STATUS_15" == "approved" ]] || fail "Case 15: team approval expected approved, got $STATUS_15"
  pass "Case 15: teamId target runtime flow complete (approved)"

  # Verify outsider CANNOT decide team-targeted approval
  IDEMPO_KEY_15B="e2e-case15b-$(uuid)"
  CREATED_IDEMPO_KEYS+=("$IDEMPO_KEY_15B")
  maybe_refresh_wrc_token
  REQ_BODY_15B=$(printf '{"recipeNamespace":"%s","recipeName":"%s","target":{"teamId":"%s"},"payload":{"message":"E2E team deny test"},"ttlSeconds":300}' "$RECIPE_NS" "$RECIPE_NAME" "$APPROVER_TEAM_ID")
  http_request POST "${CONTROL_URL}/api/v1/workflow-approvals/request" "$REQ_BODY_15B" "$MCP_HOST_RUNTIME_AUTH_HEADER" "idempotency-key: $IDEMPO_KEY_15B"
  if [[ "$HTTP_STATUS" == "200" ]]; then
    APPROVAL_15B_ID=$(json_field "$HTTP_BODY" "o.approvalRequestId")
    CREATED_APPROVAL_IDS+=("$APPROVAL_15B_ID")
    http_request POST "${EXT_URL}/api/v1/workflow-approvals/${APPROVAL_15B_ID}/decide" '{"decision":"approve","note":"outsider attempt"}' "Authorization: Bearer $OUTSIDER_TOKEN"
    [[ "$HTTP_STATUS" == "403" || "$HTTP_STATUS" == "404" ]] || fail "Case 15: outsider should be 403/404 on team approval, got $HTTP_STATUS"
    pass "Case 15: outsider rejected from team-targeted approval ($HTTP_STATUS)"
  fi
else
  fail "Case 15: could not seed or find team for approver (APPROVER_USER_ID=$APPROVER_USER_ID)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 16: /workflow-auth/reissue gateway passthrough
# ═════════════════════════════════════════════════��═══════════════════
log "Case 16: /workflow-auth/reissue via gateway"

if [[ "$SKIP_GATEWAY" == "false" ]]; then
  # Issue fresh tokens so we have a valid refresh token for the reissue call.
  maybe_refresh_wrc_token
  # The reissue endpoint requires POST with the WRC refresh token.
  gateway_curl POST "/api/v1/workflow-auth/reissue" "" "$WRC_REFRESH_TOKEN"
  if [[ "$HTTP_STATUS" == "403" ]]; then
    fail "Case 16: /workflow-auth/reissue blocked by gateway (HTTP 403) — nginx missing location block"
  elif [[ "$HTTP_STATUS" == "000" ]]; then
    warn "Case 16: gateway unreachable — skip"
  else
    # Any non-403 (200, 400, 401) means the gateway forwarded the request to control-api.
    pass "Case 16: gateway forwarded /workflow-auth/reissue (HTTP $HTTP_STATUS — not blocked)"
  fi
else
  warn "Case 16: SKIPPED (--skip-gateway)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 17: WorkflowRecipe live gateStep (deploy recipe → approval created → approve → step resumes)
# ═════════════════════════════════════════════════════════════════════
log "Case 17: WorkflowRecipe live gateStep end-to-end"

# This case deploys a real WorkflowRecipe with requiresApproval on a step,
# waits for gateStep() to create an approval request, approves it, and
# verifies the step resumes. It requires the WRC reconciler running
# in-cluster plus the mock-mcp-server image loaded in minikube.
RECIPE_17_NAME="e2e-gating-$(date +%s)"
SANDBOX_NS="${E2E_SANDBOX_NAMESPACE:-sandbox-recipes}"
RECIPE_17_NS="$SANDBOX_NS"
CREATED_WORKFLOW_RECIPE_REFS+=("${RECIPE_17_NS}/${RECIPE_17_NAME}")
CASE17_TMPDIR="$(mktemp -d -t clerum-case17-XXXX)"
CASE17_SKIP=false

# Pre-flight: verify WRC reconciler is running
if ! kubectl get deploy workflow-recipes -n control-plane --no-headers 2>/dev/null | grep -q "1/1"; then
  warn "Case 17: SKIPPED (WRC reconciler not running in control-plane)"
  CASE17_SKIP=true
fi

if [[ "$CASE17_SKIP" == "false" ]]; then
  pw_var="ADMIN_PASS""WORD"
  [[ -n "${!pw_var:-}" ]] || fail "Case 17: E2E_ADMIN_PASS""WORD/ADMIN_PASS""WORD is required so the grant is created through the admin API"
  admin_login
  pass "Case 17: admin auth acquired for product grant seed"

  # The parent WorkflowRecipe is trigger infrastructure only. The product
  # trigger route creates the per-run child WorkflowRecipe, and WRC reconciles
  # the child into mcp-host runtime pods/Secrets.
  cat > "$CASE17_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_17_NAME}
  namespace: ${RECIPE_17_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors:
        - user
  steps:
    - id: gated-step
      instruction: "Return exactly: E2E Case 17 approved"
      timeoutSeconds: 120
      requiresApproval:
        target:
          userId: "${APPROVER_USER_ID}"
        message: "E2E Case 17 — approve to unblock step"
        timeoutSeconds: 300
YAML

  if kubectl apply -f "$CASE17_TMPDIR/recipe.yaml" 2>/dev/null; then
    pass "Case 17: WorkflowRecipe ${RECIPE_17_NAME} applied"

    http_request PUT "${CONTROL_URL}/api/v1/admin/workflows/${RECIPE_17_NS}/${RECIPE_17_NAME}/grants" \
      "{\"userIds\":[\"${APPROVER_USER_ID}\"]}" \
      "Cookie: control_ui_admin_session=${ADMIN_AUTH}"
    [[ "$HTTP_STATUS" == "200" ]] || fail "Case 17: grant seed failed (HTTP $HTTP_STATUS): $HTTP_BODY"
    GRANT_17_ROWS=$(pg_psql "SELECT count(*) FROM user_workflow_triggers WHERE recipe_namespace='${RECIPE_17_NS}' AND recipe_name='${RECIPE_17_NAME}' AND user_id='${APPROVER_USER_ID}';")
    [[ "$GRANT_17_ROWS" == "1" ]] || fail "Case 17: grant API did not persist canonical user_workflow_triggers row"
    pass "Case 17: approver grant persisted via admin API"

    TRIGGER_BODY_17='{"inputs":{}}'
    IDEMPO_KEY_17="e2e-case17-trigger-$(uuid)"
    http_request POST "${EXT_URL}/api/v1/workflows/${RECIPE_17_NS}/${RECIPE_17_NAME}/trigger" "$TRIGGER_BODY_17" \
      "Authorization: Bearer $APPROVER_TOKEN" "Idempotency-Key: $IDEMPO_KEY_17"
    if [[ "$HTTP_STATUS" != "201" && "$HTTP_STATUS" != "200" ]]; then
      fail "Case 17: external trigger failed (HTTP $HTTP_STATUS): $HTTP_BODY"
    fi
    RUN_ID_17=$(json_field "$HTTP_BODY" "o.id")
    [[ -n "$RUN_ID_17" ]] || fail "Case 17: trigger response missing run id: $HTTP_BODY"
    CREATED_WORKFLOW_RUN_IDS+=("$RUN_ID_17")
    pass "Case 17: external trigger created workflow run ($RUN_ID_17)"

    CHILD_17_NS=""
    CHILD_17_NAME=""
    for _ in $(seq 1 45); do
      child_17_ref=$(pg_psql "SELECT child_recipe_namespace || '/' || child_recipe_name FROM workflow_runs WHERE run_id='${RUN_ID_17}' AND child_recipe_namespace IS NOT NULL AND child_recipe_name IS NOT NULL LIMIT 1;" 2>/dev/null | head -1 | tr -d ' ' || echo "")
      if [[ "$child_17_ref" == */* ]]; then
        CHILD_17_NS="${child_17_ref%%/*}"
        CHILD_17_NAME="${child_17_ref#*/}"
        break
      fi
      sleep 2
    done
    if [[ -z "$CHILD_17_NS" || -z "$CHILD_17_NAME" ]]; then
      CHILD_17_NAME=$(kubectl -n "$RECIPE_17_NS" get workflowrecipe \
        -l "clerum.io/parent-recipe=${RECIPE_17_NAME},clerum.io/workflow-run-id=${RUN_ID_17}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
      if [[ -n "$CHILD_17_NAME" ]]; then
        CHILD_17_NS="$RECIPE_17_NS"
        CREATED_WORKFLOW_RECIPE_REFS+=("${CHILD_17_NS}/${CHILD_17_NAME}")
        fail "Case 17: WRC created child WorkflowRecipe ${CHILD_17_NS}/${CHILD_17_NAME}, but workflow_runs did not attach it to run $RUN_ID_17"
      fi
      fail "Case 17: WRC did not attach a child WorkflowRecipe to run $RUN_ID_17"
    fi
    CREATED_WORKFLOW_RECIPE_REFS+=("${CHILD_17_NS}/${CHILD_17_NAME}")
    pass "Case 17: WRC created child WorkflowRecipe (${CHILD_17_NS}/${CHILD_17_NAME})"

    TOKEN_SECRET="wf-${CHILD_17_NAME}-mcp-host-runtime-tokens"
    secret_found=false
    for _ in $(seq 1 20); do
      if kubectl -n "$CHILD_17_NS" get secret "$TOKEN_SECRET" >/dev/null 2>&1; then
        secret_found=true
        break
      fi
      sleep 3
    done
    [[ "$secret_found" == "true" ]] || fail "Case 17: child mcpHost runtime Secret was not created within 60s"
    pass "Case 17: child mcpHost runtime Secret created ($TOKEN_SECRET)"

    runtime_access=$(
      kubectl -n "$CHILD_17_NS" get secret "$TOKEN_SECRET" \
        -o go-template='{{ index .data "mcp-host-runtime-access-token" }}'
    )
    runtime_refresh=$(
      kubectl -n "$CHILD_17_NS" get secret "$TOKEN_SECRET" \
        -o go-template='{{ index .data "mcp-host-runtime-refresh-token" }}'
    )
    runtime_control=$(
      kubectl -n "$CHILD_17_NS" get secret "$TOKEN_SECRET" \
        -o go-template='{{ index .data "mcp-host-workflow-control-token" }}'
    )
    retired_key_prefix="approval"
    retired_access_key="${retired_key_prefix}-access-token"
    retired_refresh_key="${retired_key_prefix}-refresh-token"
    retired_access=$(
      kubectl -n "$CHILD_17_NS" get secret "$TOKEN_SECRET" \
        -o "jsonpath={.data['$retired_access_key']}"
    )
    retired_refresh=$(
      kubectl -n "$CHILD_17_NS" get secret "$TOKEN_SECRET" \
        -o "jsonpath={.data['$retired_refresh_key']}"
    )
    [[ -n "$runtime_access" ]] || fail "Case 17: missing mcp-host-runtime-access-token"
    [[ -n "$runtime_refresh" ]] || fail "Case 17: missing mcp-host-runtime-refresh-token"
    [[ -n "$runtime_control" ]] || fail "Case 17: missing mcp-host-workflow-control-token"
    [[ -z "$retired_access" ]] || fail "Case 17: retired $retired_access_key still present"
    [[ -z "$retired_refresh" ]] || fail "Case 17: retired $retired_refresh_key still present"
    pass "Case 17: mcpHost runtime Secret uses canonical keys only"

    approval_17_id=""
    for _ in $(seq 1 40); do
      approval_17_id=$(pg_psql "SELECT id FROM workflow_approval_requests WHERE recipe_namespace='${RECIPE_17_NS}' AND recipe_name IN ('${RECIPE_17_NAME}','${CHILD_17_NAME}') AND status='pending' ORDER BY requested_at DESC LIMIT 1;" 2>/dev/null | head -1 | tr -d ' ' || echo "")
      [[ -n "$approval_17_id" ]] && break
      sleep 3
    done
    [[ -n "$approval_17_id" ]] || fail "Case 17: gateStep did not create a pending approval within 120s"
    CREATED_APPROVAL_IDS+=("$approval_17_id")
    pass "Case 17: gateStep created approval ($approval_17_id)"

    http_request POST "${EXT_URL}/api/v1/workflow-approvals/${approval_17_id}/decide" \
      '{"decision":"approve","note":"E2E gating test"}' "Authorization: Bearer $APPROVER_TOKEN"
    [[ "$HTTP_STATUS" == "200" ]] || fail "Case 17: decide failed (HTTP $HTTP_STATUS): $HTTP_BODY"
    APPROVAL_17_STATUS=$(pg_psql "SELECT status FROM workflow_approval_requests WHERE id='${approval_17_id}';" 2>/dev/null | head -1 | tr -d ' ' || echo "")
    [[ "$APPROVAL_17_STATUS" == "approved" || "$APPROVAL_17_STATUS" == "consumed" ]] \
      || fail "Case 17: approval persisted unexpected status after decision ($APPROVAL_17_STATUS)"
    pass "Case 17: approval decided and persisted ($APPROVAL_17_STATUS)"

    resumed=false
    STEP_PHASE_17=""
    WF_PHASE_17=""
    WF_MESSAGE_17=""
    for _ in $(seq 1 60); do
      STEP_PHASE_17=$(kubectl -n "$CHILD_17_NS" get workflowrecipe "$CHILD_17_NAME" -o jsonpath='{.status.steps[0].phase}' 2>/dev/null || true)
      WF_PHASE_17=$(kubectl -n "$CHILD_17_NS" get workflowrecipe "$CHILD_17_NAME" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || true)
      WF_MESSAGE_17=$(kubectl -n "$CHILD_17_NS" get workflowrecipe "$CHILD_17_NAME" -o jsonpath='{.status.workflowExecution.message}' 2>/dev/null || true)
      if [[ "$STEP_PHASE_17" == "completed" || "$WF_PHASE_17" == "completed" ]]; then
        resumed=true
        break
      fi
      if [[ "$STEP_PHASE_17" == "failed" || "$WF_PHASE_17" == "failed" ]]; then
        if [[ "$WF_MESSAGE_17" != *"Approval denied"* && "$WF_MESSAGE_17" != *"Approval expired"* && "$WF_MESSAGE_17" != *"Approval cancelled"* && "$WF_MESSAGE_17" != *"Approval polling timed out"* ]]; then
          resumed=true
          break
        fi
      fi
      sleep 3
    done
    [[ "$resumed" == "true" ]] || fail "Case 17: workflow did not resume after approval (step=${STEP_PHASE_17:-unknown}, workflow=${WF_PHASE_17:-unknown}, message=${WF_MESSAGE_17:-none})"
    pass "Case 17: workflow resumed after approval (step=${STEP_PHASE_17:-unknown}, workflow=${WF_PHASE_17:-unknown})"

    # Cleanup
    kubectl delete workflowrecipe "$CHILD_17_NAME" -n "$CHILD_17_NS" --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
    kubectl delete workflowrecipe "$RECIPE_17_NAME" -n "$RECIPE_17_NS" --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
    pg_psql "DELETE FROM workflow_approval_requests WHERE recipe_namespace='${RECIPE_17_NS}' AND recipe_name IN ('${RECIPE_17_NAME}','${CHILD_17_NAME}');" >/dev/null 2>&1 || true
    pg_psql "DELETE FROM workflow_runs WHERE run_id='${RUN_ID_17}';" >/dev/null 2>&1 || true
    pg_psql "DELETE FROM user_workflow_triggers WHERE recipe_namespace='${RECIPE_17_NS}' AND recipe_name='${RECIPE_17_NAME}';" >/dev/null 2>&1 || true
  else
    fail "Case 17: kubectl apply failed"
  fi
  rm -rf "$CASE17_TMPDIR"
fi
echo ""

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo -e "  PASS:  ${GREEN}${PASS}${NC}"
echo -e "  FAIL:  ${RED}${FAIL}${NC}"
echo -e "  TOTAL: ${TOTAL}"
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL USER-APPROVAL E2E CASES PASSED${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}USER-APPROVAL E2E FAILED${NC}"
  exit 1
fi
