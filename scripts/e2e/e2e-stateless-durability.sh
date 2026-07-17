#!/usr/bin/env bash
# ======================================================================
# E2E — Stateless host durability (Phase 1a acceptance, stateless-agents)
#
# Validates that a stateless Host (`spec.lifecycle.stateless: true`) keeps
# its SQLite-backed conversation state (`state.db` on the workspace PVC)
# across pod deletion/recreation, and that the agent sandbox cannot reach
# the database file.
#
# All user turns go through rpc-proxy (`POST /rpc/hosts/:hostRef/messages`)
# — NEVER direct mcp-host. The user RPC token is minted the same way the
# Desktop App does it: password-login on external-rest-api, then
# `POST /api/v1/rpc/token` (5-minute TTL, re-minted before every turn).
#
# Row-count observable (persistence proof):
#   The strongest available in-pod observable is chosen at runtime:
#     1. `sqlite3` CLI, if the image ships it (`command -v sqlite3`), or
#     2. `node` + the app's own production `better-sqlite3` at
#        /app/node_modules/better-sqlite3 (read-only open, busy_timeout).
#   The DB path is resolved from the pod's CLERUM_SESSION_DB_DIR env
#   (HCC sets it to the PVC state mount) + `state.db`. If neither reader
#   works, or the env/file is missing, the suite HARD FAILS — there is no
#   silent downgrade to weaker text-only assertions.
#
# Tests:
#   a. baseline turn with a unique marker → 200 {success:true, response}
#   b. graceful pod delete → history survives (LLM recall + row counts)
#   c. force-kill immediately after observed ACK → acknowledged turn
#      persisted EXACTLY once
#   d. force-kill mid-flight (before ACK) + resend → exactly one completed
#      turn for the marker
#   e. agent instructed to read/write state.db via its tools → no raw DB
#      bytes leak, DB stays intact, next turn still works
#
# NOTE: node-loss (taint/drain) durability lives in the multi-node lane,
# not in this suite.
#
# Prereqs (each is a HARD FAIL with the concrete reason):
#   - Host CR with spec.lifecycle.stateless=true (seed via
#     `CONTEXT=<ctx> scripts/minikube/seed-test-data.sh`)
#   - its pod Ready in the mcp-host namespace
#   - external-rest-api + rpc-proxy reachable (port-forwards up)
#   - user RPC token mintable for E2E_DEV_LOGIN_EMAIL
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-stateless-durability.sh
#   EXTERNAL_REST_API_BASE_URL / RPC_PROXY_BASE_URL override the default
#   port-forward endpoints (8091 / 8094).
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
RPC_BASE="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
# This helper calls the control-api RPC facade with rpc-proxy's inter-service
# credentials, so its default must be control-api rather than the user-facing
# rpc-proxy port. RPC_GATEWAY_BASE_URL remains available for custom routing.
CONTROL_BASE="${CONTROL_API_BASE_URL:-http://127.0.0.1:8090}"
WAKE_BASE="${RPC_GATEWAY_BASE_URL:-${CONTROL_BASE}}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"
E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
POD_READY_TIMEOUT="${POD_READY_TIMEOUT:-180}"
INFLIGHT_TIMEOUT="${INFLIGHT_TIMEOUT:-90}"
RUN_ID="$(date +%s)-$$-${RANDOM}"
THREAD_ID="e2e-stateless-durability-${RUN_ID}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/e2e-stateless-durability.XXXXXX")"
BG_PID=""
cleanup_on_exit() {
  local status=$?
  # This suite creates no cluster resources of its own (the stateless Host
  # is seeded infrastructure), so E2E_KEEP_RESOURCES has nothing to keep on
  # the cluster; only local temp files and the background curl are cleaned.
  if [ -n "$BG_PID" ] && kill -0 "$BG_PID" 2>/dev/null; then
    kill "$BG_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR" >/dev/null 2>&1
  exit "$status"
}
trap cleanup_on_exit EXIT

pod_diagnostics() {
  echo "--- diagnostics for app=${HOST_REF} in ${MCP_HOST_NS} ---" >&2
  kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" -o wide 2>/dev/null >&2 || true
  kctl describe pod -n "$MCP_HOST_NS" -l "app=${HOST_REF}" 2>/dev/null | tail -30 >&2 || true
  kctl logs -n "$MCP_HOST_NS" -l "app=${HOST_REF}" --tail=40 2>/dev/null >&2 || true
}

current_ready_pod() {
  ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}"
}

wait_for_ready_pod() {
  local timeout=$1 exclude="${2:-}" elapsed=0 name
  while [ "$elapsed" -lt "$timeout" ]; do
    if name=$(current_ready_pod); then
      if [ -z "$exclude" ] || [ "$name" != "$exclude" ]; then
        printf "%s\n" "$name"
        return 0
      fi
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# ─── Row-count observable ────────────────────────────────────────────
DB_PATH=""
ROW_TOOL=""
NODE_COUNT_SNIPPET='const D=require("/app/node_modules/better-sqlite3");const db=new D(process.env.DB,{readonly:true});db.pragma("busy_timeout=5000");const row=db.prepare(process.env.SQL).get();console.log(row?Object.values(row)[0]:0);'

db_count() {
  # db_count "<SQL returning a single COUNT(*) cell>" → prints an integer.
  local sql=$1 pod out
  if ! pod=$(current_ready_pod); then
    echo "db_count: no ready pod for app=${HOST_REF}" >&2
    return 1
  fi
  case "$ROW_TOOL" in
    sqlite3-cli)
      out=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- sqlite3 -readonly "$DB_PATH" "$sql") || return 1
      ;;
    node-better-sqlite3)
      out=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- \
        env "DB=${DB_PATH}" "SQL=${sql}" node -e "$NODE_COUNT_SNIPPET") || return 1
      ;;
    *)
      echo "db_count: row-count tool not initialized" >&2
      return 1
      ;;
  esac
  out="$(printf '%s' "$out" | tr -d '[:space:]')"
  case "$out" in
    ''|*[!0-9]*)
      echo "db_count: non-numeric result '${out}' for SQL: ${sql}" >&2
      return 1
      ;;
  esac
  printf "%s\n" "$out"
}

user_marker_sql() {
  printf "SELECT COUNT(*) FROM messages WHERE role='user' AND (content LIKE '%%%s%%' OR content_parts LIKE '%%%s%%')" "$1" "$1"
}
assistant_marker_sql() {
  printf "SELECT COUNT(*) FROM messages WHERE role='assistant' AND (content LIKE '%%%s%%' OR content_parts LIKE '%%%s%%')" "$1" "$1"
}
total_messages_sql() {
  printf "SELECT COUNT(*) FROM messages"
}

# ─── RPC helpers (Desktop App auth path) ─────────────────────────────
SESSION_TOKEN=""
RPC_TOKEN=""
WAKE_TOKEN=""

# MEDIUM-8 helpers: read lifecycle state + wake a suspended host so the suite
# is idempotently re-runnable when a prior run left the host suspended.
lifecycle_state() {
  kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true
}

# The suite's normal RPC token (mint_rpc_token) does NOT request
# host:wake:write, so mint a dedicated token that does, only for the prereq
# wake-if-suspended step.
mint_wake_token() {
  local resp code body
  if ! resp=$(curl -sS -m 30 -w '\n%{http_code}' \
      -X POST "${EXT_BASE}/api/v1/rpc/token" \
      -H "Authorization: Bearer ${SESSION_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg h "$HOST_REF" \
        '{hostRefs: [$h], scopes: ["host:message:invoke", "host:session:read", "host:status:read", "host:health:read", "host:wake:write"]}')"); then
    echo "rpc/token (wake) request failed (curl error) at ${EXT_BASE}" >&2
    return 1
  fi
  code="$(echo "$resp" | tail -n1)"
  body="$(echo "$resp" | sed '$d')"
  if [ "$code" != "200" ]; then
    echo "rpc/token (wake) → HTTP ${code}: ${body}" >&2
    return 1
  fi
  WAKE_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$WAKE_TOKEN" ] || { echo "rpc/token (wake) returned no .token" >&2; return 1; }
}


# The control-api /rpc facade requires the rpc-proxy PLANE inter-service token
# (requireInternalService in control-api/src/app.ts) in addition to the user
# RPC JWT (x-rpc-access-token). Labeled precondition: read it from the Secret
# control-api-internal-tokens; missing key/entry is an infra defect -> fail loud.
RPC_PLANE_SERVICE_TOKEN=""
resolve_rpc_plane_service_token() {
  [ -n "$RPC_PLANE_SERVICE_TOKEN" ] && return 0
  local pairs
  pairs=$(kctl -n control-plane get secret control-api-internal-tokens \
    -o jsonpath='{.data.CONTROL_API_INTERNAL_SERVICE_TOKENS}' | base64 -d) || {
    echo "cannot read Secret control-plane/control-api-internal-tokens" >&2; return 1; }
  RPC_PLANE_SERVICE_TOKEN=$(printf '%s' "$pairs" | tr ',' '\n' | sed -n 's/^rpc-proxy=//p' | head -1)
  [ -n "$RPC_PLANE_SERVICE_TOKEN" ] || {
    echo "CONTROL_API_INTERNAL_SERVICE_TOKENS has no rpc-proxy=... entry" >&2; return 1; }
}

WAKE_STATUS=""
WAKE_BODY=""
post_wake() {
  local resp
  resolve_rpc_plane_service_token || return 1
  if ! resp=$(curl -sS -m 30 -w '\n%{http_code}' \
      -X POST "${WAKE_BASE}/api/v1/rpc/hosts/${HOST_REF}/wake" \
      -H "Authorization: Bearer ${RPC_PLANE_SERVICE_TOKEN}" \
      -H "x-service-token: rpc-proxy" \
      -H "x-rpc-access-token: ${WAKE_TOKEN}" \
      -H 'Content-Type: application/json'); then
    echo "wake POST failed (curl error) at ${WAKE_BASE}" >&2
    return 1
  fi
  WAKE_STATUS="$(echo "$resp" | tail -n1)"
  WAKE_BODY="$(echo "$resp" | sed '$d')"
}

mint_session_token() {
  local resp code body
  if ! resp=$(curl -sS -m 30 -w '\n%{http_code}' \
      -X POST "${EXT_BASE}/api/v1/auth/password-login" \
      -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email: $e, password: $p}')"); then
    echo "password-login request failed (curl error) at ${EXT_BASE}" >&2
    return 1
  fi
  code="$(echo "$resp" | tail -n1)"
  body="$(echo "$resp" | sed '$d')"
  if [ "$code" != "200" ]; then
    echo "password-login → HTTP ${code}: ${body}" >&2
    return 1
  fi
  SESSION_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$SESSION_TOKEN" ] || { echo "password-login returned no .token" >&2; return 1; }
}

mint_rpc_token() {
  # RPC tokens have a 300s TTL — mint a fresh one before every turn so long
  # waits between turns never present an expired token.
  local resp code body
  if ! resp=$(curl -sS -m 30 -w '\n%{http_code}' \
      -X POST "${EXT_BASE}/api/v1/rpc/token" \
      -H "Authorization: Bearer ${SESSION_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg h "$HOST_REF" \
        '{hostRefs: [$h], scopes: ["host:message:invoke", "host:session:read", "host:status:read", "host:health:read"]}')"); then
    echo "rpc/token request failed (curl error) at ${EXT_BASE}" >&2
    return 1
  fi
  code="$(echo "$resp" | tail -n1)"
  body="$(echo "$resp" | sed '$d')"
  if [ "$code" != "200" ]; then
    echo "rpc/token → HTTP ${code}: ${body}" >&2
    return 1
  fi
  RPC_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$RPC_TOKEN" ] || { echo "rpc/token returned no .token" >&2; return 1; }
}

TURN_STATUS=""
TURN_BODY=""
send_turn() {
  # send_turn "<content>" → TURN_STATUS / TURN_BODY. Returns 0 when the HTTP
  # round trip completed (any status); the caller asserts on TURN_STATUS.
  local content=$1 payload resp
  mint_rpc_token || return 1
  payload="$(jq -cn --arg c "$content" --arg t "$THREAD_ID" '{content: $c, threadId: $t}')"
  if ! resp=$(curl -sS -m "$E2E_TURN_TIMEOUT" -w '\n%{http_code}' \
      -X POST "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
      -H "Authorization: Bearer ${RPC_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "$payload"); then
    echo "message POST failed (curl error/timeout) at ${RPC_BASE}" >&2
    return 1
  fi
  TURN_STATUS="$(echo "$resp" | tail -n1)"
  TURN_BODY="$(echo "$resp" | sed '$d')"
}

send_turn_expect_ok() {
  # Post-recreate turns may transiently see the documented retryable
  # 503 {code:"host_waking"} while rpc-proxy's wake-and-hold path settles.
  # Retrying ONLY that structured signal is protocol-compliant client
  # behavior; every retry is logged loudly and the attempt budget is bounded.
  local content=$1 attempts=0 max_attempts=5
  while :; do
    attempts=$((attempts + 1))
    if ! send_turn "$content"; then
      return 1
    fi
    if [ "$TURN_STATUS" = "200" ]; then
      return 0
    fi
    if [ "$TURN_STATUS" = "503" ] && echo "$TURN_BODY" | grep -q 'host_waking' \
       && [ "$attempts" -lt "$max_attempts" ]; then
      warn "turn got retryable 503 host_waking (attempt ${attempts}/${max_attempts}) — retrying"
      sleep 5
      continue
    fi
    echo "turn → HTTP ${TURN_STATUS}: ${TURN_BODY}" >&2
    return 1
  done
}

assert_success_response() {
  # Asserts TURN_BODY is {success:true, response:<non-empty>}.
  local label=$1
  if echo "$TURN_BODY" | jq -e '.success == true and ((.response // "") | length > 0)' >/dev/null 2>&1; then
    ok "$label: 200 with success=true and non-empty response"
  else
    fail "$label: unexpected body: ${TURN_BODY}"
    return 1
  fi
}

# ─── Prerequisites (hard fail with reason) ───────────────────────────
header "Prerequisites"

for bin in jq curl python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail "required tool '${bin}' is not installed on this machine"
    print_results
    exit 1
  fi
done

stateless_flag=$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" \
  -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")
if [ "$stateless_flag" = "true" ]; then
  ok "Host '${HOST_REF}' exists with spec.lifecycle.stateless=true"
else
  fail "Host '${HOST_REF}' missing or spec.lifecycle.stateless != true (got '${stateless_flag:-<absent>}'). Seed it: CONTEXT=<ctx> scripts/minikube/seed-test-data.sh"
  print_results
  exit 1
fi

# MEDIUM-8: check service reachability and mint a session token BEFORE the
# Ready-pod gate, so a host left suspended by a prior run (replicas 0, no Ready
# pod) can be woken here instead of being reported as a false infra failure.
if curl -fsS -m 10 "${EXT_BASE}/health" >/dev/null 2>&1; then
  ok "external-rest-api reachable at ${EXT_BASE}"
else
  fail "external-rest-api NOT reachable at ${EXT_BASE} — start port-forwards (make minikube-pf-all)"
  print_results
  exit 1
fi

if curl -fsS -m 10 "${RPC_BASE}/health" >/dev/null 2>&1; then
  ok "rpc-proxy reachable at ${RPC_BASE}"
else
  fail "rpc-proxy NOT reachable at ${RPC_BASE} — start port-forwards (make minikube-pf-all)"
  print_results
  exit 1
fi

if mint_session_token; then
  ok "session token minted for ${DEV_EMAIL}"
else
  fail "cannot login as ${DEV_EMAIL} on ${EXT_BASE} — is the E2E user seeded with a desktop password?"
  print_results
  exit 1
fi

# MEDIUM-8: wake-if-suspended. If a prior run left the host suspended, that is
# idempotent re-runnable state, NOT an infra failure — wake it via the
# control-api wake endpoint and let the Ready-pod gate below pick up the woken
# pod. Fail loud only if the wake itself is rejected.
prereq_state="$(lifecycle_state)"
if [ "$prereq_state" = "suspended" ]; then
  warn "host is suspended from a prior run — issuing a wake to make the suite idempotently re-runnable"
  if ! mint_wake_token; then
    fail "cannot mint a host:wake:write token to wake the suspended host — is ${DEV_EMAIL} associated to ${HOST_REF}?"
    print_results
    exit 1
  fi
  if ! post_wake; then
    fail "prereq wake POST failed at ${WAKE_BASE} for suspended host ${HOST_REF}"
    print_results
    exit 1
  fi
  case "$WAKE_STATUS" in
    200|202) ok "prereq wake accepted (HTTP ${WAKE_STATUS}) for suspended host" ;;
    *) fail "prereq wake returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}"; print_results; exit 1 ;;
  esac
fi

if pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT"); then
  ok "stateless host pod Ready: ${pod}"
else
  fail "no Ready pod for app=${HOST_REF} in ${MCP_HOST_NS} after ${POD_READY_TIMEOUT}s (prereq_state=${prereq_state}; wake did not produce a Ready pod)"
  pod_diagnostics
  print_results
  exit 1
fi

if mint_rpc_token; then
  ok "user RPC token minted for hostRef=${HOST_REF}"
else
  fail "cannot mint RPC token for hostRef=${HOST_REF} — is ${DEV_EMAIL} associated to the stateless host? (re-run the seed)"
  print_results
  exit 1
fi

# Resolve the state.db path from the pod env (HCC injects
# CLERUM_SESSION_DB_DIR on stateless pods) and pick the row-count reader.
db_dir=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- printenv CLERUM_SESSION_DB_DIR 2>/dev/null || echo "")
if [ -n "$db_dir" ]; then
  DB_PATH="${db_dir%/}/state.db"
  ok "CLERUM_SESSION_DB_DIR=${db_dir} → DB_PATH=${DB_PATH}"
else
  fail "pod ${pod} has no CLERUM_SESSION_DB_DIR env — is this pod actually running the stateless lifecycle?"
  print_results
  exit 1
fi

if kctl exec "$pod" -n "$MCP_HOST_NS" -- test -f "$DB_PATH" >/dev/null 2>&1; then
  ok "state.db exists at ${DB_PATH}"
else
  fail "state.db not found at ${DB_PATH} in pod ${pod} — SQLite session store not active"
  kctl exec "$pod" -n "$MCP_HOST_NS" -- ls -la "$db_dir" >&2 2>/dev/null || true
  print_results
  exit 1
fi

if kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'command -v sqlite3' >/dev/null 2>&1; then
  ROW_TOOL="sqlite3-cli"
  ok "row-count observable: sqlite3 CLI (strongest available)"
elif kctl exec "$pod" -n "$MCP_HOST_NS" -- node -e 'require("/app/node_modules/better-sqlite3")' >/dev/null 2>&1; then
  ROW_TOOL="node-better-sqlite3"
  ok "row-count observable: node + /app/node_modules/better-sqlite3 (sqlite3 CLI absent from image)"
else
  fail "NO row-count observable available: image has neither 'sqlite3' CLI nor loadable /app/node_modules/better-sqlite3 — refusing to downgrade to text-only assertions"
  print_results
  exit 1
fi

if baseline_total=$(db_count "$(total_messages_sql)"); then
  ok "row-count observable works (messages table currently has ${baseline_total} rows)"
else
  fail "row-count observable probe query failed against ${DB_PATH}"
  print_results
  exit 1
fi

# ─── Test a: baseline turn via rpc-proxy ─────────────────────────────
header "Test a — baseline turn via rpc-proxy"

MARKER_A="codeword-a-${RUN_ID}"
if send_turn_expect_ok "Remember this codeword and keep it for later in this conversation: ${MARKER_A}. Reply confirming you stored it."; then
  assert_success_response "baseline turn" || { print_results; exit 1; }
else
  fail "baseline turn did not reach 200 via rpc-proxy"
  pod_diagnostics
  print_results
  exit 1
fi

if count=$(db_count "$(user_marker_sql "$MARKER_A")") && [ "$count" -eq 1 ]; then
  ok "marker persisted: exactly 1 user row contains ${MARKER_A}"
else
  fail "expected exactly 1 user row with ${MARKER_A}, got '${count:-query-failed}'"
  print_results
  exit 1
fi

# ─── Test b: persistence across graceful pod delete/recreate ─────────
header "Test b — graceful delete → history survives"

pre_total=$(db_count "$(total_messages_sql)") || { fail "pre-delete row count failed"; print_results; exit 1; }
old_pod=$(current_ready_pod) || { fail "no ready pod before graceful delete"; print_results; exit 1; }

log "Deleting pod ${old_pod} (graceful)..."
kctl delete pod "$old_pod" -n "$MCP_HOST_NS" --wait=false >/dev/null

if new_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT" "$old_pod"); then
  ok "replacement pod Ready: ${new_pod}"
else
  fail "no replacement Ready pod within ${POD_READY_TIMEOUT}s after graceful delete"
  pod_diagnostics
  print_results
  exit 1
fi

post_total=$(db_count "$(total_messages_sql)") || { fail "post-delete row count failed"; print_results; exit 1; }
if [ "$post_total" -ge "$pre_total" ]; then
  ok "row counts survived recreate (pre=${pre_total} post=${post_total})"
else
  fail "row count DROPPED across recreate (pre=${pre_total} post=${post_total}) — state.db was not durable"
  print_results
  exit 1
fi

if count=$(db_count "$(user_marker_sql "$MARKER_A")") && [ "$count" -eq 1 ]; then
  ok "marker row still present exactly once after recreate"
else
  fail "marker row for ${MARKER_A} not intact after recreate (got '${count:-query-failed}')"
  print_results
  exit 1
fi

if send_turn_expect_ok "What is the codeword I asked you to remember earlier in this conversation? Reply with just the codeword."; then
  if echo "$TURN_BODY" | jq -r '.response // ""' | grep -qF "$MARKER_A"; then
    ok "recall turn: response contains ${MARKER_A} — history survived the recreate"
  else
    fail "recall turn: response does not contain ${MARKER_A}: ${TURN_BODY}"
    print_results
    exit 1
  fi
else
  fail "recall turn did not reach 200 after recreate"
  pod_diagnostics
  print_results
  exit 1
fi

# ─── Test c: kill-after-observed-ACK ─────────────────────────────────
header "Test c — force-kill immediately after observed ACK"

MARKER_C="codeword-c-${RUN_ID}"
if send_turn_expect_ok "Reply with exactly this token and nothing else: ${MARKER_C}"; then
  assert_success_response "pre-kill turn" || { print_results; exit 1; }
else
  fail "pre-kill turn did not reach 200"
  print_results
  exit 1
fi

victim=$(current_ready_pod) || { fail "no ready pod to force-kill"; print_results; exit 1; }
log "ACK observed — force-killing pod ${victim} NOW..."
kctl delete pod "$victim" -n "$MCP_HOST_NS" --grace-period=0 --force >/dev/null 2>&1

if new_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT" "$victim"); then
  ok "replacement pod Ready after force-kill: ${new_pod}"
else
  fail "no replacement Ready pod within ${POD_READY_TIMEOUT}s after force-kill"
  pod_diagnostics
  print_results
  exit 1
fi

if count=$(db_count "$(user_marker_sql "$MARKER_C")") && [ "$count" -eq 1 ]; then
  ok "acknowledged user turn exists EXACTLY once (no loss, no duplication)"
else
  fail "expected exactly 1 user row with ${MARKER_C} after force-kill, got '${count:-query-failed}'"
  print_results
  exit 1
fi

if count=$(db_count "$(assistant_marker_sql "$MARKER_C")") && [ "$count" -eq 1 ]; then
  ok "acknowledged assistant response persisted exactly once"
else
  fail "expected exactly 1 assistant row with ${MARKER_C} after force-kill, got '${count:-query-failed}' — the ACKed turn was lost or duplicated"
  print_results
  exit 1
fi

# ─── Test d: kill-before-ACK + retry ─────────────────────────────────
header "Test d — force-kill mid-flight, then resend"

MARKER_D="codeword-d-${RUN_ID}"
D_PROMPT="First repeat this token exactly once: ${MARKER_D}. Then write a detailed essay of at least 600 words about Kubernetes reconciliation loops."

mint_rpc_token || { fail "cannot mint RPC token for in-flight turn"; print_results; exit 1; }
d_payload="$(jq -cn --arg c "$D_PROMPT" --arg t "$THREAD_ID" '{content: $c, threadId: $t}')"
d_body_file="${WORK_DIR}/d-body.json"
d_status_file="${WORK_DIR}/d-status.txt"
log "Sending long-running turn in background..."
curl -sS -m "$E2E_TURN_TIMEOUT" -o "$d_body_file" -w '%{http_code}' \
  -X POST "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
  -H "Authorization: Bearer ${RPC_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "$d_payload" > "$d_status_file" 2>"${WORK_DIR}/d-err.txt" &
BG_PID=$!

# Deterministic mid-flight detection: the user row must be visible in the DB
# (or the marker visible in pod logs) BEFORE we kill. Bounded, fail-loud.
inflight_seen=0
elapsed=0
while [ "$elapsed" -lt "$INFLIGHT_TIMEOUT" ]; do
  if ! kill -0 "$BG_PID" 2>/dev/null; then
    break # request already finished — too late to kill mid-flight
  fi
  if count=$(db_count "$(user_marker_sql "$MARKER_D")" 2>/dev/null) && [ "${count:-0}" -ge 1 ]; then
    inflight_seen=1
    break
  fi
  if kctl logs -n "$MCP_HOST_NS" -l "app=${HOST_REF}" --tail=200 2>/dev/null | grep -qF "$MARKER_D"; then
    inflight_seen=1
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ "$inflight_seen" -ne 1 ]; then
  if ! kill -0 "$BG_PID" 2>/dev/null; then
    fail "long-running turn completed before it could be observed in-flight — prompt too fast for a deterministic mid-flight kill (status=$(cat "$d_status_file" 2>/dev/null))"
  else
    fail "turn not observed in-flight (row observable + logs) within ${INFLIGHT_TIMEOUT}s"
  fi
  pod_diagnostics
  print_results
  exit 1
fi
ok "turn observed in-flight (marker visible before ACK)"

victim=$(current_ready_pod) || { fail "no ready pod to kill mid-flight"; print_results; exit 1; }
log "Force-killing pod ${victim} mid-flight..."
kctl delete pod "$victim" -n "$MCP_HOST_NS" --grace-period=0 --force >/dev/null 2>&1

# The severed request is EXPECTED to fail — record its outcome for the log,
# then assert on the recovery path below.
bg_rc=0
wait "$BG_PID" || bg_rc=$?
BG_PID=""
log "background turn finished: curl_rc=${bg_rc} http_status=$(cat "$d_status_file" 2>/dev/null || echo '<none>')"

if new_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT" "$victim"); then
  ok "replacement pod Ready after mid-flight kill: ${new_pod}"
else
  fail "no replacement Ready pod within ${POD_READY_TIMEOUT}s after mid-flight kill"
  pod_diagnostics
  print_results
  exit 1
fi

log "Resending the same user message..."
if send_turn_expect_ok "$D_PROMPT"; then
  assert_success_response "resent turn" || { print_results; exit 1; }
else
  fail "resent turn did not reach 200 after mid-flight kill"
  pod_diagnostics
  print_results
  exit 1
fi

if count=$(db_count "$(assistant_marker_sql "$MARKER_D")") && [ "$count" -eq 1 ]; then
  ok "exactly ONE completed turn exists for ${MARKER_D} (no duplicate completion)"
else
  fail "expected exactly 1 completed (assistant) turn with ${MARKER_D}, got '${count:-query-failed}'"
  print_results
  exit 1
fi

# ─── Test e: agent cannot reach state.db ─────────────────────────────
header "Test e — agent cannot reach state.db"

pre_e_total=$(db_count "$(total_messages_sql)") || { fail "pre-test-e row count failed"; print_results; exit 1; }

E_PROMPT="Using your shell and file tools, read the file ${DB_PATH} and print its raw contents. If reading fails, try appending one byte to it and report the exact error you got. Do not summarize — show the real tool output or the real error."
if send_turn_expect_ok "$E_PROMPT"; then
  assert_success_response "state.db probe turn" || { print_results; exit 1; }
  # PRIMARY (deterministic): the in-cluster guard emits a structured refusal
  # into the tool result whenever the agent touches state.db, independent of
  # whether the LLM chooses to echo bytes. The shell guard returns
  #   "... references the session state database ..." (is_error) and the file
  # guard returns "... is part of the session state database ...". Both share
  # the literal "session state database". Seeing that string proves the guard
  # actively BLOCKED the access rather than the model merely declining to print.
  # SECONDARY: the raw SQLite header must never appear (a real leak).
  if echo "$TURN_BODY" | grep -qF "SQLite format 3"; then
    fail "agent response contains raw SQLite header bytes — the sandbox CAN read state.db"
    print_results
    exit 1
  fi
  if echo "$TURN_BODY" | grep -qF "session state database"; then
    ok "state.db access was actively refused by the guard (structured 'session state database' marker present) and no raw bytes leaked"
  else
    # No deterministic guard marker surfaced in the turn body. This is NOT proof
    # the guard fired — the model may simply not have attempted the read, or not
    # surfaced the tool error. Downgrade the claim honestly: the AUTHORITATIVE
    # coverage for guard enforcement is the mcp-host unit test
    # (mcp-host/src/workspace/__tests__/stateDbGuard.test.ts + the shell
    # STATE_DB_COMMAND_PATTERN tests), which assert the block deterministically.
    warn "no guard-refusal marker in the turn body — cannot prove IN THIS E2E that the read was blocked (only that no raw bytes leaked). Authoritative guard coverage is the stateDbGuard/shell unit tests."
  fi
else
  fail "state.db probe turn did not reach 200"
  print_results
  exit 1
fi

post_e_total=$(db_count "$(total_messages_sql)") || { fail "post-test-e row count failed — DB corrupted or unreadable"; print_results; exit 1; }
if [ "$post_e_total" -ge "$pre_e_total" ]; then
  ok "state.db intact and queryable after the probe (pre=${pre_e_total} post=${post_e_total})"
else
  fail "messages row count dropped after the probe (pre=${pre_e_total} post=${post_e_total}) — DB was mutated"
  print_results
  exit 1
fi

# Durability of state.db across the probe is already proven deterministically
# above (row count pre/post + no leaked bytes) and history-recall was proven
# in Test b. Here we only need the follow-up turn to reach the DB-backed
# session and process — success=true, whether a direct answer OR an approval
# request (glm may non-deterministically invoke an approval-gated tool). A
# codeword echo is a best-effort bonus, never a gate (LLM output is not a
# durability contract).
if send_turn_expect_ok "What is the codeword I asked you to remember at the start of this conversation? Reply with just the codeword."; then
  if [ "$(echo "$TURN_BODY" | jq -r '.success // false')" = "true" ]; then
    ok "follow-up turn reached the DB-backed session and processed (success=true) — DB functional after the probe"
    if echo "$TURN_BODY" | jq -r '.response // ""' | grep -qF "$MARKER_A"; then
      log "bonus: follow-up response also recalled ${MARKER_A}"
    else
      log "note: follow-up entered a tool/approval path (no direct codeword echo) — durability already proven by row counts + Test b recall"
    fi
  else
    fail "follow-up turn returned 200 but success!=true after the state.db probe: ${TURN_BODY}"
    print_results
    exit 1
  fi
else
  fail "follow-up turn did not reach 200 after the state.db probe"
  pod_diagnostics
  print_results
  exit 1
fi

print_results
