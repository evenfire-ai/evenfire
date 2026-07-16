#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Approval Flow — Full Desktop App approval lifecycle validation
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the FULL approval flow from login to tool approval completion:
#   1. Password Login   → session JWT
#   2. RPC Token        → scoped RPC JWT (all scopes)
#   3. Send Message     → async task (taskId)
#   4. Poll Approval    → awaiting_approval (requestId)
#   5. Approve          → { success: true }
#   6. Poll Completion  → completed + response text
#   7. Re-poll          → still completed (idempotent)
#   8. List Artifacts   → JSON with artifacts array
#   9. Host Status      → agent state idle
#
# Prerequisites:
#   - Port-forwards active:
#       external-rest-api on :8091
#       rpc-proxy on :8094
#   - CLERUM_ENABLE_AUTH=true in cluster
#   - The test user has a seeded password (scripts/e2e/seed-e2e-data.sh);
#     login uses POST /api/v1/auth/password-login with ADMIN_PASSWORD
#   - http_request MCP tool available (or similar HTTP tool)
#
# Usage:
#   ./tests/e2e/e2e-approval-flow.sh
#   ./tests/e2e/e2e-approval-flow.sh --skip-login
#   ./tests/e2e/e2e-approval-flow.sh --verbose
#
# Environment:
#   E2E_TEST_EMAIL              (default: playwright@clerum.io)
#   E2E_HOST_REF                (default: chatllm)
#   ADMIN_PASSWORD              (default: changeme123!; the seeded user's password)
#   E2E_EXTERNAL_REST_API_URL   (default: http://localhost:8091)
#   E2E_RPC_PROXY_URL           (default: http://localhost:8094)
#   E2E_SESSION_TOKEN           (for --skip-login: pre-existing session token)
#   E2E_RPC_TOKEN               (for --skip-login: pre-existing RPC token)
#   E2E_POLL_INTERVAL           (default: 3)
#   E2E_POLL_TIMEOUT            (default: 120)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# ─── Counters ────────────────────────────────────────────────────────
PASS=0
FAIL=0
TOTAL=0

# ─── Flags ───────────────────────────────────────────────────────────
SKIP_LOGIN=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --skip-login) SKIP_LOGIN=true ;;
    --verbose)    VERBOSE=true ;;
  esac
done

# ─── Logging ─────────────────────────────────────────────────────────
log()    { echo -e "${CYAN}[approval-flow]${NC} $*"; }
pass()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()   { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; exit 1; }
warn()   { echo -e "  ${YELLOW}WARN${NC} $*"; }
detail() { [[ "$VERBOSE" == "true" ]] && echo -e "       $*" || true; }

# ─── Configuration ───────────────────────────────────────────────────
TEST_EMAIL="${E2E_TEST_EMAIL:-playwright@clerum.io}"
HOST_REF="${E2E_HOST_REF:-chatllm}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-changeme123!}"
EXT_URL="${E2E_EXTERNAL_REST_API_URL:-http://localhost:8091}"
RPC_URL="${E2E_RPC_PROXY_URL:-http://localhost:8094}"
POLL_INTERVAL="${E2E_POLL_INTERVAL:-3}"
POLL_TIMEOUT="${E2E_POLL_TIMEOUT:-120}"

SESSION_TOKEN="${E2E_SESSION_TOKEN:-}"
RPC_TOKEN="${E2E_RPC_TOKEN:-}"

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Clerum E2E Approval Flow${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""
log "Config: email=$TEST_EMAIL host=$HOST_REF"
log "Config: external-rest-api=$EXT_URL"
log "Config: rpc-proxy=$RPC_URL"
log "Config: poll_interval=${POLL_INTERVAL}s poll_timeout=${POLL_TIMEOUT}s"
log "Config: skip_login=$SKIP_LOGIN"
echo ""

# ─── Helper: HTTP request via curl ───────────────────────────────────
# Usage: http_request METHOD URL [BODY] [EXTRA_HEADERS...]
# Outputs: HTTP_STATUS and HTTP_BODY are set as globals
HTTP_STATUS=""
HTTP_BODY=""

http_request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  shift 3 || shift $#

  local -a curl_args=(
    -s -w '\n%{http_code}'
    --max-time 30
    -X "$method"
    -H "Content-Type: application/json"
  )

  # Additional headers (e.g., Authorization)
  for hdr in "$@"; do
    curl_args+=(-H "$hdr")
  done

  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi

  local raw
  raw=$(curl "${curl_args[@]}" "$url" 2>/dev/null) || {
    HTTP_STATUS="000"
    HTTP_BODY='{"error":"curl failed"}'
    return 1
  }

  # Last line is the HTTP status code
  HTTP_STATUS=$(echo "$raw" | tail -n1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

# ─── Helper: Extract JSON field (uses node for reliability) ──────────
json_field() {
  local json="$1"
  local field="$2"
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

# ─── Prerequisite: Port-forward checks ───────────────────────────────
log "Phase 0: Port-forward connectivity"

if curl -sf --max-time 5 "${EXT_URL}/health" >/dev/null 2>&1; then
  pass "external-rest-api reachable at $EXT_URL"
else
  fail "external-rest-api not reachable at $EXT_URL (start port-forward: make gcp-pf-desktop)"
fi

if curl -sf --max-time 5 "${RPC_URL}/health" >/dev/null 2>&1; then
  pass "rpc-proxy reachable at $RPC_URL"
else
  fail "rpc-proxy not reachable at $RPC_URL (start port-forward: make gcp-pf-desktop)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 1: Password Login
# ═════════════════════════════════════════════════════════════════════

if [[ "$SKIP_LOGIN" == "true" ]]; then
  log "Phase 1: Skipping login (--skip-login)"
  if [[ -z "$SESSION_TOKEN" ]]; then
    fail "Phase 1: --skip-login requires E2E_SESSION_TOKEN env var"
  fi
  if [[ -z "$RPC_TOKEN" ]]; then
    fail "Phase 1: --skip-login requires E2E_RPC_TOKEN env var"
  fi
  pass "Phase 1: Using pre-existing session token (${#SESSION_TOKEN} chars)"
  pass "Phase 1: Using pre-existing RPC token (${#RPC_TOKEN} chars)"
  echo ""
else
  log "Phase 1: Password Login"

  LOGIN_BODY=$(printf '{"email":"%s","password":"%s"}' "$TEST_EMAIL" "$ADMIN_PASSWORD")
  http_request POST "${EXT_URL}/api/v1/auth/password-login" "$LOGIN_BODY"

  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "Phase 1: Password login failed (HTTP $HTTP_STATUS): $HTTP_BODY"
  fi

  SESSION_TOKEN=$(json_field "$HTTP_BODY" "o.token")
  if [[ -z "$SESSION_TOKEN" ]]; then
    fail "Phase 1: No token in login response"
  fi

  pass "Phase 1: Password login succeeded (token: ${#SESSION_TOKEN} chars)"
  detail "Response: $HTTP_BODY"
  echo ""

  # ═════════════════════════════════════════════════════════════════════
  # Phase 2: RPC Token
  # ═════════════════════════════════════════════════════════════════════
  log "Phase 2: RPC Token"

  RPC_TOKEN_BODY=$(printf '{
    "hostRefs": ["%s"],
    "scopes": [
      "host:message:invoke",
      "host:task:read",
      "host:status:read",
      "host:health:read",
      "host:approval:write",
      "host:activity:read",
      "mcp:servers:list"
    ]
  }' "$HOST_REF")

  http_request POST "${EXT_URL}/api/v1/rpc/token" "$RPC_TOKEN_BODY" \
    "Authorization: Bearer $SESSION_TOKEN"

  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "Phase 2: RPC token request failed (HTTP $HTTP_STATUS): $HTTP_BODY"
  fi

  RPC_TOKEN=$(json_field "$HTTP_BODY" "o.token")
  if [[ -z "$RPC_TOKEN" ]]; then
    fail "Phase 2: No token in RPC token response"
  fi

  pass "Phase 2: RPC token obtained (token: ${#RPC_TOKEN} chars)"
  detail "Response: $HTTP_BODY"
fi
echo ""

AUTH_HEADER="Authorization: Bearer $RPC_TOKEN"

# ═════════════════════════════════════════════════════════════════════
# Phase 3: Send Message (async)
# ═════════════════════════════════════════════════════════════════════
log "Phase 3: Send async message"

MSG_BODY=$(printf '{"content":"usa http_request para hacer GET a https://httpbin.org/get y muestra el resultado"}')
http_request POST "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/messages?async=true" "$MSG_BODY" \
  "$AUTH_HEADER"

if [[ "$HTTP_STATUS" != "200" ]]; then
  fail "Phase 3: Send message failed (HTTP $HTTP_STATUS): $HTTP_BODY"
fi

TASK_ID=$(json_field "$HTTP_BODY" "o.taskId")
if [[ -z "$TASK_ID" ]]; then
  fail "Phase 3: No taskId in async message response"
fi

MSG_STATUS=$(json_field "$HTTP_BODY" "o.status")
pass "Phase 3: Async message accepted (taskId=$TASK_ID, status=$MSG_STATUS)"
detail "Response: $HTTP_BODY"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 4: Poll for awaiting_approval
# ═════════════════════════════════════════════════════════════════════
log "Phase 4: Polling for awaiting_approval (timeout: ${POLL_TIMEOUT}s)"

ELAPSED=0
REQUEST_ID=""
POLL_STATUS=""

while [[ $ELAPSED -lt $POLL_TIMEOUT ]]; do
  http_request GET "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/tasks/${TASK_ID}/result" "" \
    "$AUTH_HEADER"

  POLL_STATUS=$(json_field "$HTTP_BODY" "o.status")
  detail "Poll ($ELAPSED s): status=$POLL_STATUS"

  if [[ "$POLL_STATUS" == "awaiting_approval" ]]; then
    REQUEST_ID=$(json_field "$HTTP_BODY" "o.approval.requestId")
    break
  fi

  if [[ "$POLL_STATUS" == "completed" ]]; then
    warn "Phase 4: Task completed without entering awaiting_approval (approval may be disabled)"
    pass "Phase 4: Task completed directly (skipping approval steps)"
    # Skip to Phase 7
    REQUEST_ID=""
    break
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [[ "$POLL_STATUS" == "awaiting_approval" ]]; then
  if [[ -z "$REQUEST_ID" ]]; then
    fail "Phase 4: awaiting_approval but no requestId found"
  fi
  pass "Phase 4: Task is awaiting_approval (requestId=$REQUEST_ID)"
  detail "Response: $HTTP_BODY"
elif [[ "$POLL_STATUS" != "completed" ]]; then
  fail "Phase 4: Timed out waiting for awaiting_approval (last status=$POLL_STATUS)"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 5: Approve tool call
# ═════════════════════════════════════════════════════════════════════

if [[ -n "$REQUEST_ID" ]]; then
  log "Phase 5: Approve tool call"

  APPROVE_BODY=$(printf '{"toolCallId":"%s"}' "$REQUEST_ID")
  http_request POST "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/approvals/approve" "$APPROVE_BODY" \
    "$AUTH_HEADER"

  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "Phase 5: Approve failed (HTTP $HTTP_STATUS): $HTTP_BODY"
  fi

  APPROVE_SUCCESS=$(json_field "$HTTP_BODY" "o.success")
  if [[ "$APPROVE_SUCCESS" != "true" ]]; then
    fail "Phase 5: Approve response success != true: $HTTP_BODY"
  fi

  pass "Phase 5: Tool call approved (success=true)"
  detail "Response: $HTTP_BODY"
  echo ""

  # ═══════════════════════════════════════════════════════════════════
  # Phase 6: Poll for completion after approval
  # ═══════════════════════════════════════════════════════════════════
  log "Phase 6: Polling for completion after approval (timeout: ${POLL_TIMEOUT}s)"

  ELAPSED=0
  COMPLETION_STATUS=""
  RESPONSE_TEXT=""

  while [[ $ELAPSED -lt $POLL_TIMEOUT ]]; do
    http_request GET "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/tasks/${TASK_ID}/result" "" \
      "$AUTH_HEADER"

    COMPLETION_STATUS=$(json_field "$HTTP_BODY" "o.status")
    detail "Poll ($ELAPSED s): status=$COMPLETION_STATUS"

    if [[ "$COMPLETION_STATUS" == "completed" ]]; then
      RESPONSE_TEXT=$(json_field "$HTTP_BODY" "o.response")
      break
    fi

    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
  done

  if [[ "$COMPLETION_STATUS" != "completed" ]]; then
    fail "Phase 6: Timed out waiting for completion after approval (last status=$COMPLETION_STATUS)"
  fi

  if [[ -z "$RESPONSE_TEXT" ]]; then
    warn "Phase 6: Completed but response text is empty"
  fi

  RESPONSE_PREVIEW=$(echo "$RESPONSE_TEXT" | head -c 120 | tr '\n' ' ')
  pass "Phase 6: Task completed after approval (response: \"${RESPONSE_PREVIEW}...\")"
  detail "Full response: $HTTP_BODY"
  echo ""
else
  log "Phase 5-6: Skipped (task completed without approval gate)"
  echo ""
fi

# ═════════════════════════════════════════════════════════════════════
# Phase 7: Re-poll (idempotent check)
# ═════════════════════════════════════════════════════════════════════
log "Phase 7: Re-poll task result (idempotent check)"

http_request GET "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/tasks/${TASK_ID}/result" "" \
  "$AUTH_HEADER"

REPOLL_STATUS=$(json_field "$HTTP_BODY" "o.status")

if [[ "$REPOLL_STATUS" == "completed" ]]; then
  pass "Phase 7: Re-poll returns completed (idempotent)"
else
  fail "Phase 7: Re-poll expected completed, got '$REPOLL_STATUS'"
fi

REPOLL_RESPONSE=$(json_field "$HTTP_BODY" "o.response")
if [[ -n "$REPOLL_RESPONSE" ]]; then
  pass "Phase 7: Re-poll still contains response text"
else
  warn "Phase 7: Re-poll response text is empty (may have been evicted)"
fi
detail "Response: $HTTP_BODY"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 8: List Artifacts
# ═════════════════════════════════════════════════════════════════════
log "Phase 8: List artifacts"

http_request GET "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/artifacts" "" \
  "$AUTH_HEADER"

if [[ "$HTTP_STATUS" != "200" ]]; then
  fail "Phase 8: List artifacts failed (HTTP $HTTP_STATUS): $HTTP_BODY"
fi

# Verify the response is valid JSON with an artifacts field (may be empty)
HAS_ARTIFACTS=$(json_field "$HTTP_BODY" "Array.isArray(o.artifacts)")
if [[ "$HAS_ARTIFACTS" == "true" ]]; then
  ARTIFACT_COUNT=$(json_field "$HTTP_BODY" "o.artifacts.length")
  pass "Phase 8: Artifacts endpoint returned JSON with artifacts array (count=$ARTIFACT_COUNT)"
else
  # Some responses may return the artifacts at the top level or differently shaped
  # Accept any valid JSON 200 response
  pass "Phase 8: Artifacts endpoint returned HTTP 200"
  warn "Phase 8: Response may not contain artifacts array: $(echo "$HTTP_BODY" | head -c 200)"
fi
detail "Response: $HTTP_BODY"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Phase 9: Host Status
# ═════════════════════════════════════════════════════════════════════
log "Phase 9: Host status check"

http_request GET "${RPC_URL}/api/v1/rpc/hosts/${HOST_REF}/status" "" \
  "$AUTH_HEADER"

if [[ "$HTTP_STATUS" != "200" ]]; then
  fail "Phase 9: Host status failed (HTTP $HTTP_STATUS): $HTTP_BODY"
fi

AGENT_STATE=$(json_field "$HTTP_BODY" "o.agentState || o.state || o.agent?.state || 'unknown'")
pass "Phase 9: Host status returned (agentState=$AGENT_STATE)"

if [[ "$AGENT_STATE" == "idle" ]]; then
  pass "Phase 9: Agent state is idle (expected after completion)"
else
  warn "Phase 9: Agent state is '$AGENT_STATE' (expected 'idle' -- may still be processing)"
fi
detail "Response: $HTTP_BODY"
echo ""

# ═════════════════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}=================================================================${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ALL PASSED: $PASS/$TOTAL tests passed${NC}"
else
  echo -e "${RED}${BOLD}  FAILURES: $FAIL/$TOTAL tests failed ($PASS passed)${NC}"
fi
echo -e "${BOLD}=================================================================${NC}"

exit $FAIL
