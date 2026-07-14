#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — User Approval Requests v0.1 — Case 13: Refresh Recovery
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the DB-level half of the refresh-rotation crash-recovery flow
# (Gap #3 of the user-approval-requests architecture audit). This is a
# sibling to scripts/e2e/e2e-workflow-approvals.sh — kept separate so the
# main script stays focused on the happy-path state machine.
#
# What this script proves (measurable / deterministic):
#   1. A freshly-issued refresh token rotates as expected (baseline).
#   2. Inserting a row into workflow_revoked_refresh_jtis for the ACTIVE
#      refresh JTI causes the next /workflow-auth/refresh call to return
#      401 — i.e. the DB revocation surface mcp-host detects in production
#      is live and wired.
#   3. After a revoked refresh, a fresh /auth/mcp-host/:ns/:name/tokens call succeeds
#      and mints a NEW access+refresh pair — i.e. the recovery endpoint
#      mcp-host would call via its reIssueTokens callback is operational.
#
# What this script does NOT cover (and why):
#   - The in-process mcp-host recovery path (refreshWithRecovery →
#     recoverTokenPair → reIssueTokens callback). That path is exercised by
#     the unit test suite at mcp-host/src/workflow/__tests__/approvalRequesterRecovery.test.ts
#     (7 tests, all passing). Wiring the callback from workflowService.ts
#     into mcp-host runtime is a follow-up, so an end-to-end runtime trace
#     requires runtime fixtures that do not exist yet.
#   - mcp-host /metrics scraping. The prom-client Counters (workflow_auth_
#     refresh_failures_total, workflow_auth_reissue_attempts_total) are
#     asserted by the unit tests, which use the default registry. Exposing
#     them over HTTP is a separate wiring task.
#
# State under test:
#   POST /auth/mcp-host/:ns/:name/tokens  → tokens minted (A0, R0)
#   POST /workflow-auth/refresh with R0 → (A1, R1), R0's JTI added to revoked table
#   INSERT INTO workflow_revoked_refresh_jtis (jti) VALUES (jti(R1)) → simulate revocation
#   POST /workflow-auth/refresh with R1 → 401 (revoked)
#   POST /auth/mcp-host/:ns/:name/tokens → (A2, R2) minted fresh — recovery path is live
#
# Usage:
#   ./scripts/e2e/e2e-workflow-approvals-recovery.sh
#   ./scripts/e2e/e2e-workflow-approvals-recovery.sh --verbose
#
# Environment:
#   E2E_CONTROL_API_URL       (default: http://localhost:8090)
#   E2E_RECIPE_NAMESPACE      (default: sandbox-recipes)
#   E2E_RECIPE_NAME           (default: e2e-approval-recovery-recipe)
#   E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET  (HS256 secret — auto-read from cluster
#                                          Secret internal-control-jwt-secrets if unset)
#   E2E_POSTGRES_NAMESPACE    (default: control-plane)
#   E2E_POSTGRES_POD_SELECTOR (default: app=control-postgres)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=true ;;
  esac
done

PASS=0; FAIL=0; TOTAL=0
log()    { echo -e "${CYAN}[approval-recovery]${NC} $*"; }
pass()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()   { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; echo -e "${RED}ABORT${NC}"; exit 1; }
warn()   { echo -e "  ${YELLOW}WARN${NC} $*"; }
detail() { [[ "$VERBOSE" == "true" ]] && echo -e "       $*" || true; }

# ─── Configuration ───────────────────────────────────────────────────
CONTROL_URL="${E2E_CONTROL_API_URL:-http://localhost:8090}"
RECIPE_NS="${E2E_RECIPE_NAMESPACE:-sandbox-recipes}"
RECIPE_NAME="${E2E_RECIPE_NAME:-e2e-approval-recovery-recipe}"
PG_NS="${E2E_POSTGRES_NAMESPACE:-control-plane}"
PG_SEL="${E2E_POSTGRES_POD_SELECTOR:-app=control-postgres}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib/internal-control-jwt.sh
source "${SCRIPT_DIR}/_lib/internal-control-jwt.sh"
if ! resolve_internal_control_hmac_secret >/dev/null; then
  fail "InternalControl JWT HMAC secret missing (set E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET or ensure cluster Secret internal-control-jwt-secrets is reachable)"
fi

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Clerum E2E — Approval Refresh Recovery (Gap #3)${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""
log "Config: control-api=$CONTROL_URL"
log "Config: recipe=$RECIPE_NS/$RECIPE_NAME"
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

# Decode the `jti` claim from a JWT's middle segment (base64url payload).
# JWT format: header.payload.signature — we only parse the payload.
jwt_jti() {
  local jwt="$1"
  printf '%s' "$jwt" | node --no-warnings -e "
    let input = '';
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const t = input.split('.');
      if (t.length < 2) { process.exit(0); }
      const pad = s => s + '='.repeat((4 - s.length % 4) % 4);
      const b64 = pad(t[1].replace(/-/g, '+').replace(/_/g, '/'));
      try {
        const p = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        process.stdout.write(String(p.jti || ''));
      } catch { /* empty */ }
    });
  " 2>/dev/null
}

pg_psql() {
  local sql="$1"
  local pod
  pod=$(kubectl --context "${KUBECONTEXT:-clerum-test}" -n "$PG_NS" get pod -l "$PG_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -n "$pod" ]] || fail "postgres pod not found (ns=$PG_NS sel=$PG_SEL)"
  kubectl --context "${KUBECONTEXT:-clerum-test}" -n "$PG_NS" exec "$pod" -- psql -U postgres -d "${PG_DB:-profiles}" -v ON_ERROR_STOP=1 -tAc "$sql"
}

# ─── Cleanup trap ────────────────────────────────────────────────────
INSERTED_JTIS=()
cleanup() {
  local rc=$?
  set +e
  log "Cleanup: removing ${#INSERTED_JTIS[@]} revoked JTI row(s) inserted by this run"
  for jti in ${INSERTED_JTIS[@]+"${INSERTED_JTIS[@]}"}; do
    [[ -n "$jti" ]] && pg_psql "DELETE FROM workflow_revoked_refresh_jtis WHERE jti='${jti}';" \
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
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 1: baseline — issue initial token pair
# ═════════════════════════════════════════════════════════════════════
log "Phase 1: POST /auth/mcp-host/:ns/:name/tokens (baseline)"

ISSUE_BODY='{"includeMcpHostControlToken":true,"workflowControlScopes":["workflow:list","workflow:read","workflow:trigger"]}'
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
[[ "$HTTP_STATUS" == "200" ]] || fail "issue baseline (HTTP $HTTP_STATUS): $HTTP_BODY"
A0=$(json_field "$HTTP_BODY" "o.mcpHostAccessToken")
R0=$(json_field "$HTTP_BODY" "o.mcpHostRefreshToken")
[[ -n "$A0" && -n "$R0" ]] || fail "issue baseline empty tokens: $HTTP_BODY"
R0_JTI=$(jwt_jti "$R0")
[[ -n "$R0_JTI" ]] || fail "could not decode jti from R0"
pass "Baseline tokens issued (access=${#A0} chars, refresh=${#R0} chars, jti=$R0_JTI)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 2: normal refresh rotates (sanity check)
# ═════════════════════════════════════════════════════════════════════
log "Phase 2: normal refresh rotates"

http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
  "Authorization: Bearer $R0"
[[ "$HTTP_STATUS" == "200" ]] || fail "refresh R0 (HTTP $HTTP_STATUS): $HTTP_BODY"
A1=$(json_field "$HTTP_BODY" "o.accessToken")
R1=$(json_field "$HTTP_BODY" "o.refreshToken")
[[ -n "$A1" && -n "$R1" ]] || fail "refresh R0 empty tokens"
[[ "$R1" != "$R0" ]] || fail "refresh did NOT rotate (R1 == R0)"
R1_JTI=$(jwt_jti "$R1")
[[ -n "$R1_JTI" ]] || fail "could not decode jti from R1"
pass "Refresh rotated — R0 → (A1, R1), new jti=$R1_JTI"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 3: simulate persistent revocation — insert R1's JTI as revoked
# ═════════════════════════════════════════════════════════════════════
# In production, revocation happens automatically when the token is
# refreshed (JTI single-use). Here we simulate the OTHER failure mode:
# admin-triggered revocation, DB-reset drift, or pod-restart state loss
# where mcp-host still has R1 in-memory but the DB says R1 is revoked.
log "Phase 3: simulate revocation — insert R1 jti into workflow_revoked_refresh_jtis"

# expires_at must be in the future for the revocation to still apply when
# refresh is attempted (the revocation row is retained until expiry). We
# use NOW() + 1 hour — safely beyond the refresh TTL.
pg_psql "INSERT INTO workflow_revoked_refresh_jtis (jti, expires_at) \
         VALUES ('${R1_JTI}', NOW() + INTERVAL '1 hour') \
         ON CONFLICT (jti) DO NOTHING;" >/dev/null
INSERTED_JTIS+=("$R1_JTI")

ROWS=$(pg_psql "SELECT count(*) FROM workflow_revoked_refresh_jtis WHERE jti='${R1_JTI}';")
[[ "$ROWS" == "1" ]] || fail "revocation row not persisted (rows=$ROWS)"
pass "R1 jti inserted as revoked (simulates persistent 401 condition)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 4: refresh with revoked R1 → 401
# This is the exact DB signal mcp-host's refreshWithRecovery() detects.
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: POST /workflow-auth/refresh with revoked R1 → expect 401"

http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
  "Authorization: Bearer $R1"
[[ "$HTTP_STATUS" == "401" ]] || fail "revoked refresh expected 401, got $HTTP_STATUS: $HTTP_BODY"
pass "Revoked refresh correctly rejected with 401"

# Verify a second attempt also returns 401 (establishes "persistent" — two
# consecutive 401s is exactly the threshold refreshWithRecovery uses to
# trigger recoverTokenPair in approvalRequester.ts).
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
  "Authorization: Bearer $R1"
[[ "$HTTP_STATUS" == "401" ]] || fail "2nd revoked refresh expected 401, got $HTTP_STATUS: $HTTP_BODY"
pass "2nd attempt also 401 — persistence confirmed (≥2 consecutive 401s)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 5: recovery — /auth/mcp-host/:ns/:name/tokens mints fresh tokens
# This is the endpoint mcp-host's reIssueTokens() callback calls.
# ═════════════════════════════════════════════════════════════════════
log "Phase 5: POST /auth/mcp-host/:ns/:name/tokens (recovery path)"

http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
[[ "$HTTP_STATUS" == "200" ]] || fail "recovery issue (HTTP $HTTP_STATUS): $HTTP_BODY"
A2=$(json_field "$HTTP_BODY" "o.mcpHostAccessToken")
R2=$(json_field "$HTTP_BODY" "o.mcpHostRefreshToken")
[[ -n "$A2" && -n "$R2" ]] || fail "recovery issue empty tokens: $HTTP_BODY"
[[ "$R2" != "$R1" ]] || fail "recovery issue did NOT mint fresh refresh"
[[ "$A2" != "$A1" ]] || fail "recovery issue did NOT mint fresh access"
pass "Recovery minted fresh pair (A2, R2) — distinct from revoked (A1, R1)"

# Sanity: new refresh works
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/refresh" "" \
  "Authorization: Bearer $R2"
[[ "$HTTP_STATUS" == "200" ]] || fail "R2 refresh (HTTP $HTTP_STATUS): $HTTP_BODY"
pass "Post-recovery refresh (R2) works — recovery is self-consistent"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 6: NEW /workflow-auth/reissue endpoint (Task #20)
# ═════════════════════════════════════════════════════════════════════
# This is the HTTP surface mcp-host's reIssueTokens callback hits when
# refresh has persistently returned 401. Verifies:
#   (a) Valid refresh + matching recipe_name → 200 fresh pair
#   (b) Missing Authorization → 401
#   (c) Recipe name mismatch → 401
#   (d) Replay of an already-consumed refresh → 401 (single-use enforced)
# We use a FRESH refresh (not expired) — the /reissue handler accepts
# both expired and non-expired tokens; what it rejects is revoked jtis
# and recipe-name mismatches. Using a fresh token keeps the E2E
# deterministic without clock manipulation.
log "Phase 6: POST /workflow-auth/reissue — recovery endpoint surface"

# Mint a brand-new refresh token via mcp-host token issuance to drive reissue.
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
[[ "$HTTP_STATUS" == "200" ]] || fail "phase6 issue (HTTP $HTTP_STATUS): $HTTP_BODY"
R3=$(json_field "$HTTP_BODY" "o.mcpHostRefreshToken")
[[ -n "$R3" ]] || fail "phase6 issue empty refresh"
pass "Minted R3 for reissue test"

# (a) Valid refresh + correct recipe_name → 200 with fresh pair
REISSUE_BODY=$(printf '{"recipe_name":"%s"}' "$RECIPE_NAME")
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/reissue" "$REISSUE_BODY" \
  "Authorization: Bearer $R3"
[[ "$HTTP_STATUS" == "200" ]] || fail "reissue expected 200, got $HTTP_STATUS: $HTTP_BODY"
A4=$(json_field "$HTTP_BODY" "o.accessToken")
R4=$(json_field "$HTTP_BODY" "o.refreshToken")
[[ -n "$A4" && -n "$R4" ]] || fail "reissue returned empty tokens: $HTTP_BODY"
[[ "$R4" != "$R3" ]] || fail "reissue did NOT rotate"
pass "reissue minted fresh pair (A4, R4) distinct from R3"

# (b) Missing Authorization → 401
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/reissue" "$REISSUE_BODY"
[[ "$HTTP_STATUS" == "401" ]] || fail "reissue without bearer expected 401, got $HTTP_STATUS"
pass "reissue rejects missing bearer with 401"

# (c) Recipe name mismatch → 401 (even with a valid, fresh refresh).
#     Mint another refresh so this check doesn't consume R4's jti.
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
R5=$(json_field "$HTTP_BODY" "o.mcpHostRefreshToken")
MISMATCH_BODY='{"recipe_name":"wrong-recipe-does-not-match"}'
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/reissue" "$MISMATCH_BODY" \
  "Authorization: Bearer $R5"
[[ "$HTTP_STATUS" == "401" ]] || fail "reissue with mismatched recipe expected 401, got $HTTP_STATUS"
pass "reissue rejects recipe_name mismatch with 401"

# (d) Replay — R3's jti was consumed in (a); retrying must 401.
http_request POST "${CONTROL_URL}/api/v1/workflow-auth/reissue" "$REISSUE_BODY" \
  "Authorization: Bearer $R3"
[[ "$HTTP_STATUS" == "401" ]] || fail "reissue replay of R3 expected 401, got $HTTP_STATUS"
pass "reissue rejects replayed (consumed) refresh with 401"

# Register consumed jtis for cleanup so the revoked table stays tidy.
R3_JTI=$(jwt_jti "$R3")
[[ -n "$R3_JTI" ]] && INSERTED_JTIS+=("$R3_JTI")
R4_JTI=$(jwt_jti "$R4")
[[ -n "$R4_JTI" ]] && INSERTED_JTIS+=("$R4_JTI")
R5_JTI=$(jwt_jti "$R5")
[[ -n "$R5_JTI" ]] && INSERTED_JTIS+=("$R5_JTI")
echo ""

# ═════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo -e "  Total: ${TOTAL}   ${GREEN}Pass: ${PASS}${NC}   ${RED}Fail: ${FAIL}${NC}"
if [[ "$FAIL" -eq 0 ]]; then
  echo -e "  ${GREEN}ALL RECOVERY CHECKS PASSED${NC}"
  echo ""
  echo "  In-process recovery (refreshWithRecovery → recoverTokenPair →"
  echo "  reIssueTokens callback) is validated by the unit suite at:"
  echo "    mcp-host/src/workflow/__tests__/approvalRequesterRecovery.test.ts"
  exit 0
else
  exit 1
fi
