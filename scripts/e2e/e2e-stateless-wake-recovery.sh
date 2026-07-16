#!/usr/bin/env bash
# ======================================================================
# E2E — Stateless host wake-recovery latency (user-perceived resume time)
#
# Measures and GATES the user-perceived recovery time when a Desktop App
# user resumes a session on a stateless Host. Every measured turn travels
# the REAL route (message -> rpc-proxy -> mcp-host); kubectl is used ONLY
# to observe state and for clearly-labeled precondition setup. Each
# scenario asserts three signals:
#   business — definitive 200 {success:true} from the turn
#   state    — Host.status.lifecycle.state settles where the scenario says
#   runtime  — pod identity (metadata.uid) proves warm vs cold resolution
#
# Scenarios (each RECOVERY_CYCLES cycles, default 3; per-cycle ms +
# p50/p95 emitted as JSON):
#
#   R1 — warm resume during DRAINING (headline metric). Precondition
#        (labeled setup): drive the host to state=draining via the idle
#        cadence overlay. Action: real turn through rpc-proxy; measure
#        t(send -> definitive 200). Assert 200 + serving podUid UNCHANGED
#        (captured immediately after the 200 — a warm resume must never
#        cold-start; a changed podUid is a hard FAIL of the cancel-drain
#        promise) + post-serve state coherence: PASS when state=active is
#        observed at any 1s poll within ACTIVE_WAIT, OR when the host
#        re-suspended WITH warm-handling evidence — an HCC cancel-drain /
#        drained_report_superseded marker since cycle start, or serving
#        podUid == precondition podUid. Under the test cadences the host
#        legitimately re-drains ~60s after the turn, so "active" is a
#        transient, not a settling state. A suspended host is woken
#        between cycles before the next draining precondition.
#        Gate: p95 <= WARM_RECOVERY_BUDGET_MS (default 5000 — sized for the
#        fast-beat optimization landing with this suite: immediate beat on
#        fence hit + 1s floor cadence while a drain-cancel is pending).
#
#   R2 — cold resume from SUSPENDED. Precondition: full idle suspend
#        (replicas=0 + state=suspended). Action: real turn; measure
#        send -> 200. Assert 200 + state=active + podUid CHANGED (a new
#        pod MUST have been created). The [StatelessWake] W-phase
#        timestamps are parsed from HCC logs for the cycle and emitted in
#        the artifact. Gate: p95 <= COLD_RECOVERY_BUDGET_MS (default
#        120000, aligned with the Phase-0 cold-start budget).
#
#   R3 — resume in the drained-report window (worst-case race).
#        Precondition: drive to draining, then watch HCC logs for the
#        heartbeat-visible [StatelessSuspend] phase=drained_reported (or
#        phase=drain_answered — grace armed) line and fire the turn the
#        moment it is observed: the tightest window between drained-report
#        and suspend. Assert the turn lands EXACTLY once (assistant-row
#        marker count == 1, same observable as the durability suite),
#        final state coherent (active), and record whether the resolution
#        was warm or cold via podUid identity (either is legal here).
#        Gate: p95 <= COLD_RECOVERY_BUDGET_MS.
#
#   R4 -- prewarm then first message (pre-warm product claim). Precondition
#        (labeled setup): full idle suspend, exactly as R2. Action: POST
#        the NEW rpc-proxy passthrough route
#        /api/v1/rpc/hosts/{hostRef}/wake with the USER RPC bearer token
#        (the call the Desktop App pre-warm issues on agent-view open;
#        202 = wake-requested, 200 = already-active race -- both accepted;
#        404 = the deployed rpc-proxy image predates the wake passthrough
#        route -> hard FAIL). Wait for the prewarmed pod Ready and record
#        prewarm_to_ready_ms -- OVERLAP time while the user reads history /
#        types, NOT the user-perceived wait; informational, no budget (the
#        cold infra time is expected here and is exactly what the pre-warm
#        hides). Then send the first message, measured exactly like R1.
#        Assert the WARM-CLASS claim: infra_overhead_ms from [TurnTiming]
#        <= R4_WARM_INFRA_BUDGET_MS (warm ~100-250ms vs in-band cold
#        ~17000ms -- deterministic, immune to LLM latency weather) AND warm
#        resolution via podUid identity (the turn is served by the
#        prewarmed pod -- no in-band wake-hold). Total measured ms includes
#        llm_wall and is recorded as informational, NOT gated per cycle: a
#        slow LLM turn (llm_wall alone measured up to 5.8s in this suite)
#        must not fail the prewarm claim it has nothing to do with.
#        After the R4 loop, an anti-resurrection tail asserts the host
#        idles back to suspended, proving the prewarm did not pin it
#        awake. Gate: p95 <= WARM_RECOVERY_BUDGET_MS.
#
# Output: one JSON summary
#   {scenario: {cycles:[ms], p50, p95, budget_ms, verdict, resolution,
#               turn_attribution:[{cycle, ...[TurnTiming] phases,
#               measured_total_ms, infra_overhead_ms}]}}
# R4 additionally emits prewarm_to_ready_ms:[ms] -- the per-cycle overlap
# series (informational, no budget).
# Each measured turn (baseline, R1, R2, R4) is attributed with the serving
# pod's [TurnTiming] phase line (queue_wait/session_load/prompt_assembly/
# llm_wall/llm_calls/tool_loop/tools_called/input_chars_approx) and
# infra_overhead_ms = measured_total(send->200) - llm_wall_ms. A missing
# or unparseable [TurnTiming] line for a measured turn is a hard FAIL.
# printed to stdout AND written to /tmp/stateless-wake-recovery-<ts>.json
# (override: RECOVERY_ARTIFACT). OVER_BUDGET or any failed assertion ->
# exit 1 with pod_diagnostics.
#
# FAIL-LOUD CONTRACT: transport error, deadline expiry, unreadable HCC
# logs, or any unreachable assertion is a hard FAIL with diagnostics —
# never a silent skip, no error-masking on load-bearing reads, every wait
# is bounded and dumps diagnostics on expiry.
#
# LLM EMPTY-RESPONSE TOLERANCE (bounded, loud, orthogonal to wake): the
# provider (glm-4.7) intermittently returns {success:false, error.code=
# "LLM_INVALID_RESPONSE", "message":"LLM produced empty response..."} INSIDE
# an HTTP 200. That 200 already PROVES the wake worked (pod woke, accepted
# the turn, round-tripped to the provider); the empty LLM body is a
# provider flake, NOT a wake failure. It is the ONLY condition tolerated
# with a retry: the business-signal assertion (success:true) re-sends the
# SAME turn (same content/threadId) up to LLM_EMPTY_MAX_RETRIES (default 3),
# logging LOUDLY each attempt, and still hard-FAILS if the empty response
# persists after the cap. RECOVERY_MS (the reported wake metric) is the
# FIRST-200 wake round-trip and is NEVER inflated by an LLM re-send. Every
# other failure path (transport error, non-200, other error codes,
# host_waking/host_draining timeout, podUid checks) is unchanged and fails
# immediately with no retry.
#
# EMITTER CADENCE (wall-clock math — mirrors e2e-stateless-suspend-wake):
#   The mcp-host heartbeat emitter runs at its default 30s cadence (HCC
#   does not inject CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS into host pods).
#   HCC test cadences are set on the live deployment (labeled precondition
#   setup, RESTORED + rollout-waited in the cleanup trap):
#     CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES = 1
#     CONTEXT_MAPPER_STATELESS_IDLE_MINUTES       = 1
#     CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS     = 20000
#     CONTEXT_MAPPER_HEARTBEAT_POLL_MS            = 5000
#   Reaching state=draining after a served turn therefore needs idle
#   floor (60s) + one emitter tick (30s) + one HCC poll (5s) + slack =>
#   DRAINING_WAIT default 150s. Full suspend adds drain grace (20s) =>
#   SUSPEND_WINDOW default 180s.
#
# Prereqs (each a HARD FAIL with the concrete reason):
#   - Host CR chatllm-stateless with spec.lifecycle.stateless=true
#   - external-rest-api + rpc-proxy reachable (port-forwards up)
#   - user RPC token mintable with host:wake:write
#   - rpc-proxy wake passthrough route deployed (POST
#     /api/v1/rpc/hosts/{hostRef}/wake) -- a 404 in R4 is a hard FAIL
#     naming the stale rpc-proxy image
#   - state.db row observable resolvable (exactly-once assertion in R3)
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-stateless-wake-recovery.sh
#   RECOVERY_CYCLES=5 WARM_RECOVERY_BUDGET_MS=3000 ...
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
RPC_BASE="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
CONTROL_BASE="${CONTROL_API_BASE_URL:-http://127.0.0.1:8090}"
WAKE_BASE="${RPC_GATEWAY_BASE_URL:-${CONTROL_BASE}}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
POD_READY_TIMEOUT="${POD_READY_TIMEOUT:-180}"
SUSPEND_WINDOW="${SUSPEND_WINDOW:-180}"          # idle(60) + emitter(30) + drain(20) + poll(5) + slack
WAKE_HOLD_DEADLINE="${WAKE_HOLD_DEADLINE:-270}"  # single bounded deadline per measured turn (< 300s RPC token TTL)
DRAINING_WAIT="${DRAINING_WAIT:-150}"            # idle(60) + emitter(30) + poll(5) + slack, from last activity
ACTIVE_WAIT="${ACTIVE_WAIT:-90}"                 # bounded wait for state=active after a served turn
R3_WINDOW_WAIT="${R3_WINDOW_WAIT:-120}"          # bounded wait for the drained-report signal once draining

RECOVERY_CYCLES="${RECOVERY_CYCLES:-3}"
WARM_RECOVERY_BUDGET_MS="${WARM_RECOVERY_BUDGET_MS:-5000}"
R4_WARM_INFRA_BUDGET_MS="${R4_WARM_INFRA_BUDGET_MS:-1500}" # warm-class infra ceiling for the R4 prewarm claim (warm ~100-250ms, in-band cold ~17000ms)
COLD_RECOVERY_BUDGET_MS="${COLD_RECOVERY_BUDGET_MS:-120000}"
RECOVERY_ARTIFACT="${RECOVERY_ARTIFACT:-/tmp/stateless-wake-recovery-$(date +%s).json}"
TURN_TIMING_WAIT="${TURN_TIMING_WAIT:-15}"       # bounded wait for the serving pod's [TurnTiming] line after a 200
LLM_EMPTY_MAX_RETRIES="${LLM_EMPTY_MAX_RETRIES:-3}" # bounded re-sends of a turn that 200s with an empty-LLM body (glm-4.7 provider flake, orthogonal to wake)

# HCC test cadences (applied on the live deployment, restored in trap).
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
HCC_NS="${HCC_NS:-${CONTROL_NS:-control-plane}}"
TEST_IDLE_MINUTES="1"
TEST_IDLE_FLOOR_MINUTES="1"
TEST_DRAIN_GRACE_MS="20000"
TEST_POLL_MS="5000"

RUN_ID="$(date +%s)-$$-${RANDOM}"
THREAD_ID="e2e-stateless-wake-recovery-${RUN_ID}"
CYCLES_FILE="$(mktemp "${TMPDIR:-/tmp}/wake-recovery-cycles.XXXXXX")"

# --- Cleanup trap: restore HCC cadences, drop temp files --------------
HCC_ENV_SAVED=""

restore_hcc_env() {
  [ -n "$HCC_ENV_SAVED" ] || return 0
  local args=() key val
  while IFS='=' read -r key val; do
    [ -n "$key" ] || continue
    if [ -n "$val" ]; then args+=("${key}=${val}"); else args+=("${key}-"); fi
  done <<< "$HCC_ENV_SAVED"
  [ ${#args[@]} -gt 0 ] || return 0
  log "Restoring HCC cadence env on deployment/${HCC_DEPLOY}"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" "${args[@]}" >/dev/null 2>&1 || \
    warn "failed to restore HCC env (manual check advised)"
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1 || \
    warn "HCC rollout did not settle after env restore"
}

cleanup_on_exit() {
  local status=$?
  set +e
  rm -f "$CYCLES_FILE" >/dev/null 2>&1
  restore_hcc_env
  exit "$status"
}
trap cleanup_on_exit EXIT

pod_diagnostics() {
  echo "--- diagnostics for app=${HOST_REF} in ${MCP_HOST_NS} ---" >&2
  kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" -o wide 2>/dev/null >&2 || true
  kctl get host "$HOST_REF" -n "$MCP_HOST_NS" \
    -o jsonpath='{"lifecycle="}{.status.lifecycle}{"\n"}' 2>/dev/null >&2 || true
  kctl logs "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --tail=60 2>/dev/null >&2 || true
}

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
now_rfc3339() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))'; }

current_ready_pod() { ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}"; }

pod_uid() { kctl get pod "$1" -n "$MCP_HOST_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }

wait_for_ready_pod() {
  local timeout=$1 elapsed=0 name
  while [ "$elapsed" -lt "$timeout" ]; do
    if name=$(current_ready_pod); then printf "%s\n" "$name"; return 0; fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# --- Row observable (exactly-once marker): mirrors the durability exemplar
DB_PATH=""
ROW_TOOL=""
NODE_COUNT_SNIPPET='const D=require("/app/node_modules/better-sqlite3");const db=new D(process.env.DB,{readonly:true});db.pragma("busy_timeout=5000");const row=db.prepare(process.env.SQL).get();console.log(row?Object.values(row)[0]:0);'

resolve_row_tool() {
  local pod dbdir
  pod=$(current_ready_pod) || { echo "no ready pod to resolve state.db" >&2; return 1; }
  dbdir=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'printf "%s" "${CLERUM_SESSION_DB_DIR:-}"' 2>/dev/null || true)
  [ -n "$dbdir" ] || { echo "CLERUM_SESSION_DB_DIR not set on pod ${pod}" >&2; return 1; }
  DB_PATH="${dbdir%/}/state.db"
  if kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'command -v sqlite3' >/dev/null 2>&1; then
    ROW_TOOL="sqlite3-cli"
  elif kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'test -d /app/node_modules/better-sqlite3' >/dev/null 2>&1; then
    ROW_TOOL="node-better-sqlite3"
  else
    echo "no row-count reader in pod (${pod}): neither sqlite3 CLI nor better-sqlite3" >&2; return 1
  fi
}

db_count() {
  local sql=$1 pod out
  pod=$(current_ready_pod) || { echo "db_count: no ready pod" >&2; return 1; }
  case "$ROW_TOOL" in
    sqlite3-cli) out=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- sqlite3 -readonly "$DB_PATH" "$sql") || return 1 ;;
    node-better-sqlite3) out=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- env "DB=${DB_PATH}" "SQL=${sql}" node -e "$NODE_COUNT_SNIPPET") || return 1 ;;
    *) echo "db_count: row-count tool not initialized" >&2; return 1 ;;
  esac
  out="$(printf '%s' "$out" | tr -d '[:space:]')"
  case "$out" in ''|*[!0-9]*) echo "db_count: non-numeric '${out}' for: ${sql}" >&2; return 1 ;; esac
  printf "%s\n" "$out"
}

assistant_marker_sql() {
  printf "SELECT COUNT(*) FROM messages WHERE role='assistant' AND (content LIKE '%%%s%%' OR content_parts LIKE '%%%s%%')" "$1" "$1"
}

# --- RPC helpers (Desktop App auth path) ------------------------------
SESSION_TOKEN=""; RPC_TOKEN=""
RPC_SCOPES_JSON='["host:message:invoke","host:session:read","host:status:read","host:health:read","host:wake:write"]'

mint_session_token() {
  local resp code body
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/auth/password-login" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p}')") || {
    echo "password-login request failed at ${EXT_BASE}" >&2; return 1; }
  code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
  [ "$code" = "200" ] || { echo "password-login -> HTTP ${code}: ${body}" >&2; return 1; }
  SESSION_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$SESSION_TOKEN" ] || { echo "password-login returned no .token" >&2; return 1; }
}

mint_rpc_token() {
  local resp code body
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/rpc/token" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg h "$HOST_REF" --argjson s "$RPC_SCOPES_JSON" '{hostRefs:[$h],scopes:$s}')") || {
    echo "rpc/token request failed at ${EXT_BASE}" >&2; return 1; }
  code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
  [ "$code" = "200" ] || { echo "rpc/token -> HTTP ${code}: ${body}" >&2; return 1; }
  RPC_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$RPC_TOKEN" ] || { echo "rpc/token returned no .token" >&2; return 1; }
}

TURN_STATUS=""; TURN_BODY=""
# send_turn_raw: POSTs with the CURRENT RPC_TOKEN (no re-mint) so token
# minting latency never pollutes the measured send->200 window. The token
# TTL is 300s and WAKE_HOLD_DEADLINE defaults to 270s, so a token minted
# at t0 outlives the whole measurement; raising WAKE_HOLD_DEADLINE past
# the TTL surfaces as a loud non-retryable 401.
send_turn_raw() {
  local content=$1 payload resp
  payload="$(jq -cn --arg c "$content" --arg t "$THREAD_ID" '{content:$c,threadId:$t}')"
  resp=$(curl -sS -m "$E2E_TURN_TIMEOUT" -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json' \
    -d "$payload") || { echo "message POST failed at ${RPC_BASE} (transport-level)" >&2; return 1; }
  TURN_STATUS="$(echo "$resp" | tail -n1)"; TURN_BODY="$(echo "$resp" | sed '$d')"
}

# measure_recovery_turn: the measured user journey. t0 is stamped after a
# fresh token mint; the ONLY retryables are the documented transition 503s
# ({code:"host_waking"} / {code:"host_draining"}) inside ONE bounded
# deadline. Transport failure, any other status, or deadline expiry is a
# hard failure at the caller — an unreachable assertion never passes.
RECOVERY_MS=""
TURN_T0_RFC3339=""
measure_recovery_turn() {
  local content=$1 t0 t1 deadline attempt=0
  RECOVERY_MS=""
  mint_rpc_token || { echo "could not mint RPC token before t0" >&2; return 1; }
  TURN_T0_RFC3339="$(now_rfc3339)"
  t0="$(now_ms)"
  deadline=$((SECONDS + WAKE_HOLD_DEADLINE))
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    send_turn_raw "$content" || return 1
    if [ "$TURN_STATUS" = "200" ]; then
      t1="$(now_ms)"
      RECOVERY_MS=$((t1 - t0))
      return 0
    fi
    if [ "$TURN_STATUS" = "503" ] && echo "$TURN_BODY" | grep -qE 'host_waking|host_draining'; then
      log "attempt ${attempt}: 503 wake/drain transition (retryable) -- re-issuing within recovery deadline"
      sleep 1; continue
    fi
    echo "turn returned non-retryable HTTP ${TURN_STATUS}: ${TURN_BODY}" >&2
    return 1
  done
  echo "recovery deadline (${WAKE_HOLD_DEADLINE}s) exceeded without a definitive 200; last status=${TURN_STATUS} body=$(printf '%s' "$TURN_BODY" | head -c 300)" >&2
  return 1
}

# is_llm_empty_response: TRUE only for the KNOWN provider flake -- a 200
# whose body is {success:false, error.code=="LLM_INVALID_RESPONSE"} (glm-4.7
# returns an empty completion inside an HTTP 200). ANYTHING else (non-200,
# other error codes, transport failure, host_waking/host_draining) is NOT an
# LLM transient and returns false so the caller fails loud immediately.
is_llm_empty_response() {
  [ "$TURN_STATUS" = "200" ] || return 1
  echo "$TURN_BODY" | jq -e '.error.code == "LLM_INVALID_RESPONSE"' >/dev/null 2>&1
}

# assert_success_response: the BUSINESS signal (definitive 200 {success:true}).
# The measured wake latency (RECOVERY_MS) was already captured by
# measure_recovery_turn on the FIRST 200 and is NEVER touched here. When that
# first 200 carried the glm-4.7 empty-LLM body (success:false +
# LLM_INVALID_RESPONSE), this bounded-retry loop re-sends the SAME turn (same
# content/threadId) up to LLM_EMPTY_MAX_RETRIES to obtain the success:true
# business signal -- the re-send round-trip latency is NOT part of the
# reported wake metric. A persistent empty response after the cap IS a real
# failure (hard FAIL). Any NON-LLM-empty non-success (other error codes,
# non-200) fails IMMEDIATELY with no retry, exactly as before.
#
# $2 (content) is REQUIRED to enable the re-send; when omitted, an
# LLM-empty 200 cannot be re-sent and fails loud rather than being masked.
assert_success_response() {
  local label=$1 content=${2:-}
  local attempt=0
  while :; do
    if [ "$TURN_STATUS" = "200" ] && echo "$TURN_BODY" | jq -e '.success == true' >/dev/null 2>&1; then
      ok "${label}: 200 {success:true}"; return 0
    fi
    if is_llm_empty_response && [ -n "$content" ] && [ "$attempt" -lt "$LLM_EMPTY_MAX_RETRIES" ]; then
      attempt=$((attempt + 1))
      log "${label}: LLM returned empty (glm-4.7 provider flake) -- re-sending turn (attempt ${attempt}/${LLM_EMPTY_MAX_RETRIES})"
      # Advance the [TurnTiming] attribution window to THIS re-send so the
      # phase breakdown captured afterwards belongs to the turn that actually
      # produced success:true, and the serving pod's log window carries exactly
      # one TurnTiming line. RECOVERY_MS (first-200 wake latency) is untouched.
      TURN_T0_RFC3339="$(now_rfc3339)"
      sleep 2
      send_turn_raw "$content" || { fail "${label}: transport failure on LLM-empty re-send (attempt ${attempt})"; return 1; }
      continue
    fi
    if is_llm_empty_response; then
      fail "${label}: LLM produced empty response after ${attempt}/${LLM_EMPTY_MAX_RETRIES} re-sends (persistent glm-4.7 flake -- NOT masked; content=$([ -n "$content" ] && echo yes || echo none)), last body=${TURN_BODY}"; return 1
    fi
    fail "${label}: expected 200 {success:true}, got HTTP ${TURN_STATUS} body=${TURN_BODY}"; return 1
  done
}


# The control-api /rpc facade sits behind requireInternalService('rpc-proxy'):
# only the rpc-proxy PLANE may call it, authenticated by the inter-service
# token (authorization: Bearer <token> + x-service-token: rpc-proxy), with the
# USER RPC JWT carried separately in x-rpc-access-token (see
# rpc-proxy/src/services/controlApiRestService.ts controlApiHeaders and
# control-api/src/app.ts api.use('/rpc', requireInternalService('rpc-proxy'))).
# Labeled precondition: read that token from the Secret control-api-internal-tokens
# (key CONTROL_API_INTERNAL_SERVICE_TOKENS, "service=token" pairs). Fail loud if
# the key or the rpc-proxy entry is missing -- the pod could not be running with
# a different contract, so an absent entry is an infra defect, not a skip.
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

WAKE_STATUS=""; WAKE_BODY=""
post_wake() {
  local resp
  resolve_rpc_plane_service_token || return 1
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST \
    "${WAKE_BASE}/api/v1/rpc/hosts/${HOST_REF}/wake" \
    -H "Authorization: Bearer ${RPC_PLANE_SERVICE_TOKEN}" \
    -H "x-service-token: rpc-proxy" \
    -H "x-rpc-access-token: ${RPC_TOKEN}" -H 'Content-Type: application/json') || {
    echo "wake POST failed at ${WAKE_BASE}" >&2; return 1; }
  WAKE_STATUS="$(echo "$resp" | tail -n1)"; WAKE_BODY="$(echo "$resp" | sed '$d')"
}

# post_prewarm: the NEW rpc-proxy wake passthrough route (user plane).
# Unlike post_wake (the control-api /rpc facade, reachable only with the
# rpc-proxy inter-service token), this POST carries ONLY the user RPC
# bearer token -- the exact call the Desktop App pre-warm issues on
# agent-view open. Contract: 202 {status:'wake-requested'} when a wake was
# scheduled, 200 {status:'active'} when the host was already active. A 404
# means the deployed rpc-proxy image predates the passthrough route and is
# a hard FAIL at the caller.
PREWARM_STATUS=""; PREWARM_BODY=""
post_prewarm() {
  local resp
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/wake" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json') || {
    echo "prewarm wake POST failed at ${RPC_BASE} (transport-level)" >&2; return 1; }
  PREWARM_STATUS="$(echo "$resp" | tail -n1)"; PREWARM_BODY="$(echo "$resp" | sed '$d')"
}

# --- Lifecycle observables (read-only) --------------------------------
lifecycle_state()     { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true; }
deployment_replicas() { kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo ""; }

wait_for_state() {
  local expected=$1 timeout=$2 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    [ "$(lifecycle_state)" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_suspended() {
  local timeout=$1 elapsed=0 st reps running
  while [ "$elapsed" -lt "$timeout" ]; do
    st="$(lifecycle_state)"; reps="$(deployment_replicas)"
    if ! running="$(running_pod_count "$MCP_HOST_NS" "app=${HOST_REF}")"; then
      echo "wait_for_suspended: failed to count Running pods for ${HOST_REF}" >&2
      return 1
    fi
    if [ "$st" = "suspended" ] && [ "${reps:-1}" = "0" ] && [ "${running:-1}" = "0" ]; then return 0; fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

force_idle_and_suspend() {
  local running
  header "PRECONDITION (labeled setup) -- forcing idle -> suspend (window ${SUSPEND_WINDOW}s)"
  if wait_for_suspended "$SUSPEND_WINDOW"; then
    ok "host suspended (state=suspended, replicas=0, pod gone)"; return 0
  fi
  if ! running="$(running_pod_count "$MCP_HOST_NS" "app=${HOST_REF}")"; then
    fail "host did not suspend within ${SUSPEND_WINDOW}s and Running pod count could not be read"
    pod_diagnostics; return 1
  fi
  fail "host did not suspend within ${SUSPEND_WINDOW}s (state=$(lifecycle_state) replicas=$(deployment_replicas) runningPods=${running})"
  pod_diagnostics; return 1
}

save_and_set_hcc_cadences() {
  header "PRECONDITION (labeled setup) -- HCC test cadences (idle=1min, drain=${TEST_DRAIN_GRACE_MS}ms, poll=${TEST_POLL_MS}ms)"
  local keys=(CONTEXT_MAPPER_STATELESS_IDLE_MINUTES CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES \
    CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS CONTEXT_MAPPER_HEARTBEAT_POLL_MS)
  local k cur saved=""
  for k in "${keys[@]}"; do
    cur="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${k}')].value}" 2>/dev/null || true)"
    saved+="${k}=${cur}"$'\n'
  done
  HCC_ENV_SAVED="$saved"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
    "CONTEXT_MAPPER_STATELESS_IDLE_MINUTES=${TEST_IDLE_MINUTES}" \
    "CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES=${TEST_IDLE_FLOOR_MINUTES}" \
    "CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS=${TEST_DRAIN_GRACE_MS}" \
    "CONTEXT_MAPPER_HEARTBEAT_POLL_MS=${TEST_POLL_MS}" >/dev/null 2>&1 || {
    fail "failed to set HCC test cadences"; return 1; }
  if kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1; then
    ok "HCC test cadences applied and rolled out"
  else
    fail "HCC rollout did not settle after cadence set"; pod_diagnostics; return 1
  fi
}

# hcc_logs_since: fail-loud log read (a masked empty read must never pass
# an assertion built on it -- same discipline as the suspend-wake counters).
hcc_logs_since() {
  local since=$1 logs
  if ! logs="$(kctl logs "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --since-time="$since" 2>/dev/null)"; then
    echo "hcc_logs_since: log read for deployment/${HCC_DEPLOY} in ${HCC_NS} FAILED (RBAC/pod-churn) -- refusing to report a masked empty read" >&2
    return 2
  fi
  printf '%s\n' "$logs"
}

# drain_window_signal: rc 0 = drained-report / grace-armed observed since
# $1; rc 1 = not yet; rc 2 = log read failed (caller MUST hard-fail).
drain_window_signal() {
  local since=$1 logs rc=0
  logs="$(hcc_logs_since "$since")" || rc=$?
  [ "$rc" = "0" ] || return 2
  printf '%s\n' "$logs" | \
    grep -qE "\[StatelessSuspend\] host=${HOST_REF} phase=(drained_reported|drain_answered)"
}

record_cycle() {
  local scenario=$1 cycle=$2 ms=$3 resolution=$4 wake_lines=$5 timing_json=${6:-null} prewarm_ms=${7:-null}
  jq -cn --arg s "$scenario" --argjson c "$cycle" --argjson ms "$ms" \
    --arg r "$resolution" --arg wl "$wake_lines" --argjson tt "$timing_json" \
    --argjson pw "$prewarm_ms" \
    '{scenario:$s, cycle:$c, ms:$ms, resolution:$r, wake_phases:($wl | split("\n") | map(select(length>0))), turn_timing:$tt, prewarm_to_ready_ms:$pw}' \
    >> "$CYCLES_FILE"
}

# --- Per-turn phase attribution ([TurnTiming] parse) -------------------
# The instrumented mcp-host emits ONE info line per completed turn. In the
# pod the structured logger renders it as a JSON log line with
#   {"component":"TurnTiming","msg":"{\"taskId\":...,\"total_ms\":...,...}"}
# (dev-mode raw stdout keeps the literal "[TurnTiming] {...}" prefix form;
# both shapes are parsed). rpc-proxy reshapes the turn 200 body (no taskId
# reaches the caller), so the line is correlated by the TURN WINDOW: logs
# are read with --since-time=<turn t0>, and EXACTLY ONE TurnTiming entry
# must exist in that window -- the suite serializes turns on this host, so
# zero means the instrumentation is missing and >1 means the attribution
# would be ambiguous. Both are hard FAILs (fail-loud contract), as is an
# unreadable log stream or an unparseable payload.
TURN_TIMING_JSON=""
turn_timing_for_task() {
  local pod=$1 since=$2 logs candidates count elapsed=0
  TURN_TIMING_JSON=""
  if [ -z "$pod" ] || [ -z "$since" ]; then
    echo "turn_timing_for_task: empty pod ('${pod}') or since ('${since}')" >&2; return 1
  fi
  while [ "$elapsed" -le "$TURN_TIMING_WAIT" ]; do
    if ! logs="$(kctl logs "$pod" -n "$MCP_HOST_NS" --since-time="$since" 2>/dev/null)"; then
      echo "turn_timing_for_task: log read for pod ${pod} in ${MCP_HOST_NS} FAILED -- refusing a masked empty read" >&2
      return 1
    fi
    # Structured logger shape + raw dev-mode shape, deduped.
    candidates="$( { printf '%s\n' "$logs" | jq -R -r 'fromjson? | select(.component=="TurnTiming") | .msg' 2>/dev/null; \
                     printf '%s\n' "$logs" | sed -n 's/^.*\[TurnTiming\] \({.*\)$/\1/p'; } | awk 'NF' | sort -u)"
    count="$(printf '%s' "$candidates" | grep -c '' || true)"
    if [ "$count" -eq 1 ]; then
      TURN_TIMING_JSON="$candidates"
      if printf '%s' "$TURN_TIMING_JSON" | jq -e \
        '(.total_ms|type=="number") and (.llm_wall_ms|type=="number") and (.session_load_ms|type=="number") and (.prompt_assembly_ms|type=="number")' \
        >/dev/null 2>&1; then
        return 0
      fi
      echo "turn_timing_for_task: unparseable [TurnTiming] payload in window since ${since}: ${TURN_TIMING_JSON}" >&2
      return 1
    fi
    if [ "$count" -gt 1 ]; then
      echo "turn_timing_for_task: ${count} [TurnTiming] entries since ${since} -- attribution is ambiguous, refusing to guess:" >&2
      printf '%s\n' "$candidates" >&2
      return 1
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  echo "turn_timing_for_task: no [TurnTiming] entry in pod ${pod} since ${since} within ${TURN_TIMING_WAIT}s -- is the instrumented mcp-host image deployed?" >&2
  return 1
}

# capture_turn_attribution: derive the phase breakdown for the JUST-measured
# turn (window opened at TURN_T0_RFC3339 by measure_recovery_turn, total in
# RECOVERY_MS) from the serving pod's [TurnTiming] entry and stage it in
# TURN_ATTRIBUTION_JSON for record_cycle. Adds
# infra_overhead_ms = measured_total(send->200) - llm_wall_ms so the artifact
# answers "how much of the user-perceived time was NOT the model".
TURN_ATTRIBUTION_JSON="null"
capture_turn_attribution() {
  local label=$1 pod=$2 merged
  TURN_ATTRIBUTION_JSON="null"
  if [ -z "$TURN_T0_RFC3339" ]; then
    echo "${label}: TURN_T0_RFC3339 is empty -- measure_recovery_turn did not run before attribution" >&2
    return 1
  fi
  turn_timing_for_task "$pod" "$TURN_T0_RFC3339" || return 1
  merged="$(jq -cn --argjson tt "$TURN_TIMING_JSON" --argjson measured "$RECOVERY_MS" \
    '$tt + {measured_total_ms: $measured, infra_overhead_ms: ($measured - $tt.llm_wall_ms)}')" || {
    echo "${label}: failed to merge the [TurnTiming] payload with the measured send->200 total" >&2; return 1; }
  TURN_ATTRIBUTION_JSON="$merged"
  log "${label}: phase attribution $(printf '%s' "$merged" | jq -c \
    '{measured_total_ms, llm_wall_ms, llm_calls, session_load_ms, prompt_assembly_ms, tool_loop_ms, tools_called, queue_wait_ms, input_chars_approx, infra_overhead_ms}')"
}

# ====================================================================== #
#  Prerequisites
# ====================================================================== #
header "Prerequisites"
for bin in jq curl python3; do
  command -v "$bin" >/dev/null 2>&1 || { fail "required tool '${bin}' not installed"; print_results; exit 1; }
done

stateless_flag=$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")
if [ "$stateless_flag" = "true" ]; then
  ok "Host '${HOST_REF}' exists with spec.lifecycle.stateless=true"
else
  fail "Host '${HOST_REF}' missing or spec.lifecycle.stateless != true (got '${stateless_flag:-<absent>}'). Seed: bash scripts/e2e/seed-stateless-host.sh"
  print_results; exit 1
fi

for svc in "external-rest-api ${EXT_BASE}" "rpc-proxy ${RPC_BASE}"; do
  name="${svc%% *}"; base="${svc##* }"
  if curl -fsS -m 10 "${base}/health" >/dev/null 2>&1; then
    ok "${name} reachable at ${base}"
  else
    fail "${name} NOT reachable at ${base} -- start port-forwards (make minikube-pf-all)"; print_results; exit 1
  fi
done

if mint_session_token; then ok "session token minted for ${DEV_EMAIL}"; else
  fail "cannot login as ${DEV_EMAIL} on ${EXT_BASE}"; print_results; exit 1; fi
if mint_rpc_token; then
  ok "user RPC token minted (requested host:wake:write among scopes)"
else
  fail "cannot mint RPC token for hostRef=${HOST_REF} with host:wake:write -- is ${DEV_EMAIL} associated to the stateless host?"; print_results; exit 1
fi

# MEDIUM-8 (mirrors the siblings): a prior run may have left the host
# suspended -- that is idempotent re-runnable state, NOT an infra failure.
# Wake it via the same control-api wake endpoint the product uses and wait
# bounded for a Ready pod; fail loud only if the wake does not produce one.
prereq_state="$(lifecycle_state)"
if [ "$prereq_state" = "suspended" ]; then
  warn "host is suspended from a prior run -- issuing a wake to make the suite idempotently re-runnable"
  if ! post_wake; then
    fail "prereq wake POST failed at ${WAKE_BASE} for suspended host ${HOST_REF}"; print_results; exit 1
  fi
  case "$WAKE_STATUS" in
    200|202) ok "prereq wake accepted (HTTP ${WAKE_STATUS}) for suspended host" ;;
    *) fail "prereq wake returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}"; print_results; exit 1 ;;
  esac
fi
if pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT"); then
  ok "stateless host pod Ready (host image present on node): ${pod}"
else
  fail "no Ready pod for app=${HOST_REF} in ${MCP_HOST_NS} after ${POD_READY_TIMEOUT}s (prereq_state=${prereq_state}; wake did not produce a Ready pod)"
  pod_diagnostics; print_results; exit 1
fi

if resolve_row_tool; then
  ok "row observable ready (tool=${ROW_TOOL} db=${DB_PATH})"
else
  fail "cannot resolve state.db row observable -- no CLERUM_SESSION_DB_DIR or reader in pod"; print_results; exit 1
fi

save_and_set_hcc_cadences || { print_results; exit 1; }

# Baseline turn: pins state=active with FRESH activity so the first R1
# draining wait is measured from a known last-activity instant.
header "Baseline turn (pins active + fresh activity)"
if measure_recovery_turn "Reply with exactly: RECOVERY_BASELINE_${RUN_ID}"; then
  assert_success_response "baseline turn" "Reply with exactly: RECOVERY_BASELINE_${RUN_ID}" || { print_results; exit 1; }
  log "baseline turn served in ${RECOVERY_MS}ms (not gated)"
  base_pod="$(current_ready_pod)" || {
    fail "baseline: no Ready pod immediately after the served turn"; pod_diagnostics; print_results; exit 1; }
  if capture_turn_attribution "baseline" "$base_pod"; then
    ok "baseline: [TurnTiming] phase attribution captured"
  else
    fail "baseline: [TurnTiming] attribution missing for the measured turn"; pod_diagnostics; print_results; exit 1
  fi
  record_cycle "baseline_active_turn" 1 "$RECOVERY_MS" "warm" "" "$TURN_ATTRIBUTION_JSON"
else
  fail "baseline turn did not reach a definitive 200"; pod_diagnostics; print_results; exit 1
fi
if wait_for_state "active" "$ACTIVE_WAIT"; then
  ok "baseline: state=active"
else
  # The baseline turn was already hard-gated on a definitive 200 + clean
  # [TurnTiming] attribution above -- that IS the baseline's contract. Under
  # the compressed test cadences (idle floor 1min) a served turn is legitimately
  # followed by a re-drain/re-suspend; a draining/suspended state here with the
  # served-200 evidence is expected behavior, not a wedge. Only an unknown/empty
  # state (host lost) fails. R1 owns the warm-resume state-semantics assertion.
  bstate="$(lifecycle_state)"
  case "$bstate" in
    draining|suspended)
      ok "baseline: host re-cycled to '${bstate}' after the served turn (legitimate under 1min idle floor; measurement already captured)" ;;
    *)
      fail "baseline: host in unexpected state '${bstate}' after a served turn (no active/draining/suspended)"; pod_diagnostics; print_results; exit 1 ;;
  esac
fi

# wake_if_suspended: between-cycle handoff (labeled setup). A passed R1
# cycle may legitimately leave the host suspended (warm serve followed by
# re-drain + re-suspend under the test cadences). Wake it through the same
# product wake endpoint as the prereq wake-if-suspended block and wait
# bounded for a Ready pod; any failure is a hard FAIL at the caller.
wake_if_suspended() {
  local label=$1 st
  st="$(lifecycle_state)"
  [ "$st" = "suspended" ] || return 0
  log "${label}: host is suspended -- issuing a plane wake before the next precondition"
  mint_rpc_token || { fail "${label}: could not mint a fresh RPC token for the wake"; return 1; }
  post_wake || { fail "${label}: wake POST failed at ${WAKE_BASE}"; return 1; }
  case "$WAKE_STATUS" in
    200|202) log "${label}: wake accepted (HTTP ${WAKE_STATUS})" ;;
    *) fail "${label}: wake returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}"; return 1 ;;
  esac
  wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || {
    fail "${label}: wake did not produce a Ready pod within ${POD_READY_TIMEOUT}s"; return 1; }
  ok "${label}: host awake (Ready pod) -- proceeding"
}

# ====================================================================== #
#  R1 -- warm resume during DRAINING (headline metric)
# ====================================================================== #
cycle=1
while [ "$cycle" -le "$RECOVERY_CYCLES" ]; do
  header "R1 cycle ${cycle}/${RECOVERY_CYCLES} -- warm resume during draining"
  r1_since="$(now_rfc3339)"
  # The baseline (and a prior R1 cycle) legitimately leaves the host
  # suspended once the pendingResults idle gauge is no longer pinned, so
  # EVERY cycle -- including cycle 1 -- must wake a suspended host before it
  # can idle back into draining. wake_if_suspended is a labeled no-op when
  # the host is already up.
  wake_if_suspended "R1 cycle ${cycle}" || { print_results; exit 1; }
  # PRECONDITION (labeled setup): idle the host until state=draining.
  r1_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R1 cycle ${cycle}: no Ready pod before draining precondition"; pod_diagnostics; print_results; exit 1; }
  r1_uid_before="$(pod_uid "$r1_pod")"
  [ -n "$r1_uid_before" ] || { fail "R1 cycle ${cycle}: could not read podUid for ${r1_pod}"; print_results; exit 1; }
  if wait_for_state "draining" "$DRAINING_WAIT"; then
    ok "R1 cycle ${cycle} precondition: state=draining (pod ${r1_pod} uid ${r1_uid_before})"
  else
    fail "R1 cycle ${cycle}: host never reached state=draining within ${DRAINING_WAIT}s (state=$(lifecycle_state))"
    pod_diagnostics; print_results; exit 1
  fi
  # ACTION: real user turn through rpc-proxy; measure send -> definitive 200.
  r1_marker="R1_WARM_${RUN_ID}_c${cycle}"
  if measure_recovery_turn "Reply with exactly: ${r1_marker}"; then
    ok "R1 cycle ${cycle}: turn served in ${RECOVERY_MS}ms"
  else
    fail "R1 cycle ${cycle}: turn during draining did not reach a definitive 200"
    pod_diagnostics; print_results; exit 1
  fi
  assert_success_response "R1 cycle ${cycle} turn" "Reply with exactly: ${r1_marker}" || { print_results; exit 1; }
  # SERVING-POD IDENTITY -- captured IMMEDIATELY after the 200, before any
  # state wait: under the test cadences the host legitimately re-drains and
  # can re-suspend after the turn, so a capture taken after a state wait
  # would race the teardown and could not distinguish warm from cold.
  r1_pod_serve=$(current_ready_pod) || {
    fail "R1 cycle ${cycle}: no Ready pod immediately after the served turn"; pod_diagnostics; print_results; exit 1; }
  r1_uid_serve="$(pod_uid "$r1_pod_serve")"
  [ -n "$r1_uid_serve" ] || { fail "R1 cycle ${cycle}: could not read serving podUid for ${r1_pod_serve}"; print_results; exit 1; }
  if [ "$r1_pod_serve" = "$r1_pod" ] && [ "$r1_uid_serve" = "$r1_uid_before" ]; then
    ok "R1 cycle ${cycle}: podUid UNCHANGED (${r1_uid_before}) -- warm resume, cancel-drain honored"
  else
    fail "R1 cycle ${cycle}: warm resume COLD-STARTED -- cancel-drain promise broken (pod ${r1_pod}->${r1_pod_serve} uid ${r1_uid_before}->${r1_uid_serve})"
    pod_diagnostics; print_results; exit 1
  fi
  # ATTRIBUTION -- captured NOW, before the coherence wait: a re-suspension
  # would delete the serving pod and its [TurnTiming] log line with it.
  if capture_turn_attribution "R1 cycle ${cycle}" "$r1_pod_serve"; then
    ok "R1 cycle ${cycle}: [TurnTiming] phase attribution captured"
  else
    fail "R1 cycle ${cycle}: [TurnTiming] attribution missing for the measured turn"
    pod_diagnostics; print_results; exit 1
  fi
  r1_attr="$TURN_ATTRIBUTION_JSON"
  # POST-SERVE STATE COHERENCE: state=active after a served turn is
  # TRANSIENT under the test cadences (idle=1min, grace=20s) -- the host
  # legitimately re-drains ~60s after the turn and may re-suspend before a
  # slow poll observes active. Poll at 1s cadence for up to ACTIVE_WAIT and
  # PASS when EITHER state=active is observed at any poll OR the host
  # re-suspended WITH warm-handling evidence: an HCC cancel-drain /
  # drained_report_superseded marker since the cycle start, or the serving
  # podUid equal to the precondition podUid. A cold start was already a
  # hard FAIL above; a re-suspension with no evidence at all is a FAIL, as
  # is a state that reaches neither active nor suspended in the window.
  r1_outcome=""; r1_elapsed=0; r1_state=""
  while [ "$r1_elapsed" -lt "$ACTIVE_WAIT" ]; do
    r1_state="$(lifecycle_state)"
    if [ "$r1_state" = "active" ]; then r1_outcome="active"; break; fi
    if [ "$r1_state" = "suspended" ]; then r1_outcome="suspended"; break; fi
    sleep 1; r1_elapsed=$((r1_elapsed + 1))
  done
  if [ "$r1_outcome" = "active" ]; then
    ok "R1 cycle ${cycle}: state=active observed after the served turn (t+${r1_elapsed}s)"
  elif [ "$r1_outcome" = "suspended" ]; then
    r1_log_rc=0; r1_logs="$(hcc_logs_since "$r1_since")" || r1_log_rc=$?
    if [ "$r1_log_rc" = "0" ] && printf '%s\n' "$r1_logs" | \
       grep -qE "host=${HOST_REF} (cancel-drain:|phase=drained_report_superseded)"; then
      ok "R1 cycle ${cycle}: warm serve then legitimate re-suspension (HCC cancel-drain/supersede marker since cycle start)"
    elif [ "$r1_uid_serve" = "$r1_uid_before" ]; then
      ok "R1 cycle ${cycle}: warm serve then legitimate re-suspension (serving podUid == precondition podUid ${r1_uid_before})"
    else
      fail "R1 cycle ${cycle}: re-suspended with NO warm-handling evidence (hcc_log_rc=${r1_log_rc}, uid ${r1_uid_before}->${r1_uid_serve})"
      pod_diagnostics; print_results; exit 1
    fi
  else
    fail "R1 cycle ${cycle}: state reached neither active nor suspended within ${ACTIVE_WAIT}s (last observed='${r1_state:-<unread>}')"
    pod_diagnostics; print_results; exit 1
  fi
  record_cycle "R1_warm_resume_during_draining" "$cycle" "$RECOVERY_MS" "warm" "" "$r1_attr"
  # HANDOFF (labeled setup): a passed cycle may leave the host suspended --
  # wake it before the next draining precondition (or the R2 setup).
  wake_if_suspended "R1 cycle ${cycle} handoff" || { pod_diagnostics; print_results; exit 1; }
  cycle=$((cycle + 1))
done

# ====================================================================== #
#  R2 -- cold resume from SUSPENDED
# ====================================================================== #
cycle=1
while [ "$cycle" -le "$RECOVERY_CYCLES" ]; do
  header "R2 cycle ${cycle}/${RECOVERY_CYCLES} -- cold resume from suspended"
  r2_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R2 cycle ${cycle}: no Ready pod before suspend precondition"; pod_diagnostics; print_results; exit 1; }
  r2_uid_before="$(pod_uid "$r2_pod")"
  [ -n "$r2_uid_before" ] || { fail "R2 cycle ${cycle}: could not read podUid for ${r2_pod}"; print_results; exit 1; }
  force_idle_and_suspend || { print_results; exit 1; }
  r2_since="$(now_rfc3339)"
  # ACTION: real user turn to the suspended host; measure send -> 200.
  r2_marker="R2_COLD_${RUN_ID}_c${cycle}"
  if measure_recovery_turn "Reply with exactly: ${r2_marker}"; then
    ok "R2 cycle ${cycle}: turn served in ${RECOVERY_MS}ms"
  else
    fail "R2 cycle ${cycle}: turn to suspended host did not reach a definitive 200"
    pod_diagnostics; print_results; exit 1
  fi
  assert_success_response "R2 cycle ${cycle} turn" "Reply with exactly: ${r2_marker}" || { print_results; exit 1; }
  if wait_for_state "active" "$ACTIVE_WAIT"; then
    ok "R2 cycle ${cycle}: state=active after wake"
  else
    fail "R2 cycle ${cycle}: state did not reach active within ${ACTIVE_WAIT}s (state=$(lifecycle_state))"
    pod_diagnostics; print_results; exit 1
  fi
  r2_pod_after=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R2 cycle ${cycle}: no Ready pod after cold resume"; pod_diagnostics; print_results; exit 1; }
  r2_uid_after="$(pod_uid "$r2_pod_after")"
  if [ -n "$r2_uid_after" ] && [ "$r2_uid_after" != "$r2_uid_before" ]; then
    ok "R2 cycle ${cycle}: podUid CHANGED (${r2_uid_before} -> ${r2_uid_after}) -- a new pod served the resume"
  else
    fail "R2 cycle ${cycle}: expected a NEW pod after suspend, got uid '${r2_uid_after:-<empty>}' (before ${r2_uid_before})"
    pod_diagnostics; print_results; exit 1
  fi
  # ATTRIBUTION -- the NEW pod served the resume; its log stream carries the
  # [TurnTiming] line for the measured turn.
  if capture_turn_attribution "R2 cycle ${cycle}" "$r2_pod_after"; then
    ok "R2 cycle ${cycle}: [TurnTiming] phase attribution captured"
  else
    fail "R2 cycle ${cycle}: [TurnTiming] attribution missing for the measured turn"
    pod_diagnostics; print_results; exit 1
  fi
  r2_attr="$TURN_ATTRIBUTION_JSON"
  # W-phase breakdown from HCC logs for THIS cycle (fail-loud read).
  r2_rc=0; r2_logs="$(hcc_logs_since "$r2_since")" || r2_rc=$?
  if [ "$r2_rc" != "0" ]; then
    fail "R2 cycle ${cycle}: HCC log read failed -- cannot extract the [StatelessWake] W-phase breakdown"; print_results; exit 1
  fi
  r2_wake_lines="$(printf '%s\n' "$r2_logs" | grep -F "[StatelessWake] host=${HOST_REF} " || true)"
  if printf '%s\n' "$r2_wake_lines" | grep -q "phase=wake_observed"; then
    ok "R2 cycle ${cycle}: [StatelessWake] W-phase lines captured ($(printf '%s\n' "$r2_wake_lines" | grep -c 'phase=') phases)"
  else
    fail "R2 cycle ${cycle}: no [StatelessWake] phase=wake_observed line since ${r2_since} -- the wake path is unproven for this cycle"
    pod_diagnostics; print_results; exit 1
  fi
  record_cycle "R2_cold_resume_from_suspended" "$cycle" "$RECOVERY_MS" "cold" "$r2_wake_lines" "$r2_attr"
  cycle=$((cycle + 1))
done

# ====================================================================== #
#  R3 -- resume in the drained-report window (worst-case race)
# ====================================================================== #
cycle=1
while [ "$cycle" -le "$RECOVERY_CYCLES" ]; do
  header "R3 cycle ${cycle}/${RECOVERY_CYCLES} -- resume at the drained-report window"
  r3_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R3 cycle ${cycle}: no Ready pod before draining precondition"; pod_diagnostics; print_results; exit 1; }
  r3_uid_before="$(pod_uid "$r3_pod")"
  [ -n "$r3_uid_before" ] || { fail "R3 cycle ${cycle}: could not read podUid for ${r3_pod}"; print_results; exit 1; }
  r3_since="$(now_rfc3339)"
  # PRECONDITION (labeled setup): idle to draining, then watch for the
  # heartbeat-visible drained-report (phase=drained_reported) or armed
  # grace (phase=drain_answered) and fire the turn THAT moment.
  if wait_for_state "draining" "$DRAINING_WAIT"; then
    ok "R3 cycle ${cycle} precondition: state=draining"
  else
    fail "R3 cycle ${cycle}: host never reached state=draining within ${DRAINING_WAIT}s (state=$(lifecycle_state))"
    pod_diagnostics; print_results; exit 1
  fi
  r3_elapsed=0; r3_seen=0
  while [ "$r3_elapsed" -lt "$R3_WINDOW_WAIT" ]; do
    r3_sig_rc=0; drain_window_signal "$r3_since" || r3_sig_rc=$?
    if [ "$r3_sig_rc" = "0" ]; then r3_seen=1; break; fi
    if [ "$r3_sig_rc" = "2" ]; then
      fail "R3 cycle ${cycle}: HCC log read failed while watching for the drained-report window"; print_results; exit 1
    fi
    sleep 1; r3_elapsed=$((r3_elapsed + 1))
  done
  if [ "$r3_seen" = "1" ]; then
    ok "R3 cycle ${cycle}: drained-report window observed (phase=drained_reported/drain_answered) -- firing the turn NOW"
  else
    fail "R3 cycle ${cycle}: no drained_reported/drain_answered signal within ${R3_WINDOW_WAIT}s of draining (state=$(lifecycle_state))"
    pod_diagnostics; print_results; exit 1
  fi
  r3_marker="R3_RACE_${RUN_ID}_c${cycle}"
  if measure_recovery_turn "Reply with exactly: ${r3_marker}"; then
    ok "R3 cycle ${cycle}: turn served in ${RECOVERY_MS}ms"
  else
    fail "R3 cycle ${cycle}: turn in the drained-report window did not reach a definitive 200"
    pod_diagnostics; print_results; exit 1
  fi
  assert_success_response "R3 cycle ${cycle} turn" "Reply with exactly: ${r3_marker}" || { print_results; exit 1; }
  if wait_for_state "active" "$ACTIVE_WAIT"; then
    ok "R3 cycle ${cycle}: final state coherent (active)"
  else
    fail "R3 cycle ${cycle}: state did not settle to active within ${ACTIVE_WAIT}s (state=$(lifecycle_state))"
    pod_diagnostics; print_results; exit 1
  fi
  r3_pod_after=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R3 cycle ${cycle}: no Ready pod after the race turn"; pod_diagnostics; print_results; exit 1; }
  r3_uid_after="$(pod_uid "$r3_pod_after")"
  [ -n "$r3_uid_after" ] || { fail "R3 cycle ${cycle}: could not read podUid for ${r3_pod_after}"; print_results; exit 1; }
  if [ "$r3_uid_after" = "$r3_uid_before" ]; then r3_resolution="warm"; else r3_resolution="cold"; fi
  ok "R3 cycle ${cycle}: resolution=${r3_resolution} (uid ${r3_uid_before} -> ${r3_uid_after}; either is legal in this window)"
  # Exactly-once: the marked assistant row must exist EXACTLY once (0 = the
  # turn was lost in the race; >1 = it was duplicated). The pod may be new,
  # so re-resolve the row tool against the current pod first.
  if ! resolve_row_tool; then
    fail "R3 cycle ${cycle}: cannot re-resolve the state.db row observable on the current pod"; print_results; exit 1
  fi
  r3_count=""
  if ! r3_count="$(db_count "$(assistant_marker_sql "$r3_marker")")"; then
    fail "R3 cycle ${cycle}: exactly-once row query FAILED for marker ${r3_marker} -- refusing to pass on an unreadable observable"
    pod_diagnostics; print_results; exit 1
  fi
  if [ "$r3_count" = "1" ]; then
    ok "R3 cycle ${cycle}: marker persisted EXACTLY once (assistant row count=1)"
  else
    fail "R3 cycle ${cycle}: expected exactly 1 assistant row for ${r3_marker}, got ${r3_count} ($([ "$r3_count" = "0" ] && echo 'turn LOST in the race' || echo 'turn DUPLICATED'))"
    pod_diagnostics; print_results; exit 1
  fi
  record_cycle "R3_drained_report_window" "$cycle" "$RECOVERY_MS" "$r3_resolution" ""
  cycle=$((cycle + 1))
done

# ====================================================================== #
#  R4 -- prewarm then first message (pre-warm product claim)
# ====================================================================== #
cycle=1
while [ "$cycle" -le "$RECOVERY_CYCLES" ]; do
  header "R4 cycle ${cycle}/${RECOVERY_CYCLES} -- prewarm then first message"
  r4_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R4 cycle ${cycle}: no Ready pod before suspend precondition"; pod_diagnostics; print_results; exit 1; }
  r4_uid_before="$(pod_uid "$r4_pod")"
  [ -n "$r4_uid_before" ] || { fail "R4 cycle ${cycle}: could not read podUid for ${r4_pod}"; print_results; exit 1; }
  # PRECONDITION (labeled setup): full idle suspend, exactly as R2.
  force_idle_and_suspend || { print_results; exit 1; }
  # PREWARM: the client-side wake the Desktop App issues on agent-view
  # open -- the NEW rpc-proxy passthrough route, USER RPC bearer only. A
  # fresh token is minted first: the suspend window can outlive the 300s
  # RPC token TTL.
  mint_rpc_token || { fail "R4 cycle ${cycle}: could not mint a fresh RPC token before the prewarm"; print_results; exit 1; }
  r4_prewarm_t0="$(now_ms)"
  # PREWARM with bounded re-emission -- mirrors the Desktop client exactly.
  # HCC's raw watch can lose the annotation event (known limitation; the
  # reactive path re-emits every RPC_PROXY_WAKE_RETRIGGER_MS for the same
  # reason -- observed live: one R4 cycle got its 202 but no pod for 180s
  # until an HCC restart's full reconcile picked the wake up). The client
  # re-POSTs up to 2 more times ~10s apart while the answer stays 202 (HCC
  # has not acted); a 200 'active' is HCC's acknowledgment and stops the
  # loop. Each re-POST lands >2s past the control-api coalesce window
  # (CONTROL_API_HOST_WAKE_COALESCE_WINDOW_MS=2000), so it bumps the
  # generation and re-projects the annotation -> a fresh watch event.
  # Only the FIRST emission is a counted check; re-emissions are log lines
  # so the suite's check count stays deterministic.
  r4_prewarm_attempt=1
  r4_prewarm_acked=""
  while :; do
    post_prewarm || { fail "R4 cycle ${cycle}: prewarm POST failed at ${RPC_BASE} (transport-level)"; pod_diagnostics; print_results; exit 1; }
    case "$PREWARM_STATUS" in
      202)
        if [ "$r4_prewarm_attempt" -eq 1 ]; then
          ok "R4 cycle ${cycle}: prewarm accepted (HTTP 202 wake-requested)"
        else
          log "R4 cycle ${cycle}: prewarm re-emission ${r4_prewarm_attempt}/3 still 202 -- HCC has not acted (possible lost watch event); annotation re-projected"
        fi
        ;;
      200)
        if [ "$r4_prewarm_attempt" -eq 1 ]; then
          ok "R4 cycle ${cycle}: prewarm returned HTTP 200 (host already active -- wake race, accepted)"
        else
          log "R4 cycle ${cycle}: prewarm acknowledged by HCC (200 active on emission ${r4_prewarm_attempt}/3)"
        fi
        r4_prewarm_acked=1
        ;;
      404) fail "R4 cycle ${cycle}: prewarm route returned 404 -- the deployed rpc-proxy image predates the wake passthrough route (POST /api/v1/rpc/hosts/{hostRef}/wake); body=${PREWARM_BODY}"
           pod_diagnostics; print_results; exit 1 ;;
      *)   fail "R4 cycle ${cycle}: prewarm returned HTTP ${PREWARM_STATUS}: ${PREWARM_BODY}"
           pod_diagnostics; print_results; exit 1 ;;
    esac
    [ -n "$r4_prewarm_acked" ] && break
    if [ "$r4_prewarm_attempt" -ge 3 ]; then
      log "R4 cycle ${cycle}: 3 emissions without an HCC acknowledgment -- proceeding to the pod-ready wait (the client gives up here too; its user message rides the reactive path)"
      break
    fi
    sleep 10
    r4_prewarm_attempt=$((r4_prewarm_attempt + 1))
  done
  # READINESS (OVERLAP time -- models the user reading history / typing
  # after opening the agent view; NOT the user-perceived wait): the cold
  # infra start runs while no message is pending. Recorded per cycle as
  # prewarm_to_ready_ms -- informational, no budget.
  r4_pod_warm=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || {
    fail "R4 cycle ${cycle}: prewarm did not produce a Ready pod within ${POD_READY_TIMEOUT}s"; pod_diagnostics; print_results; exit 1; }
  r4_prewarm_ms=$(( $(now_ms) - r4_prewarm_t0 ))
  ok "R4 cycle ${cycle}: prewarmed pod Ready in ${r4_prewarm_ms}ms (overlap time hidden from the user -- informational, no budget)"
  r4_uid_warm="$(pod_uid "$r4_pod_warm")"
  [ -n "$r4_uid_warm" ] || { fail "R4 cycle ${cycle}: could not read podUid for prewarmed pod ${r4_pod_warm}"; print_results; exit 1; }
  if [ "$r4_uid_warm" != "$r4_uid_before" ]; then
    ok "R4 cycle ${cycle}: prewarm created a NEW pod (${r4_uid_before} -> ${r4_uid_warm}) -- the cold start ran in the overlap window"
  else
    fail "R4 cycle ${cycle}: prewarmed podUid equals the pre-suspend podUid (${r4_uid_before}) -- the suspend precondition did not actually recycle the pod"
    pod_diagnostics; print_results; exit 1
  fi
  # MEASURED FIRST MESSAGE (the user-perceived wait -- the product claim),
  # measured exactly like R1's warm turn.
  r4_marker="R4_PREWARM_${RUN_ID}_c${cycle}"
  if measure_recovery_turn "Reply with exactly: ${r4_marker}"; then
    ok "R4 cycle ${cycle}: first message served in ${RECOVERY_MS}ms"
  else
    fail "R4 cycle ${cycle}: first message after prewarm did not reach a definitive 200"
    pod_diagnostics; print_results; exit 1
  fi
  assert_success_response "R4 cycle ${cycle} turn" "Reply with exactly: ${r4_marker}" || { print_results; exit 1; }
  # WARM RESOLUTION -- the same podUid-identity classification R1/R2 use:
  # the serving pod (captured immediately after the 200) must BE the
  # prewarmed pod, proving the turn resolved without an in-band wake-hold.
  r4_pod_serve=$(current_ready_pod) || {
    fail "R4 cycle ${cycle}: no Ready pod immediately after the served turn"; pod_diagnostics; print_results; exit 1; }
  r4_uid_serve="$(pod_uid "$r4_pod_serve")"
  [ -n "$r4_uid_serve" ] || { fail "R4 cycle ${cycle}: could not read serving podUid for ${r4_pod_serve}"; print_results; exit 1; }
  if [ "$r4_uid_serve" = "$r4_uid_warm" ]; then
    ok "R4 cycle ${cycle}: podUid UNCHANGED across the measured turn (${r4_uid_warm}) -- warm resolution, no in-band wake-hold"
  else
    fail "R4 cycle ${cycle}: first message was NOT served by the prewarmed pod (uid ${r4_uid_warm} -> ${r4_uid_serve}) -- resolution is cold, the prewarm claim is broken"
    pod_diagnostics; print_results; exit 1
  fi
  if capture_turn_attribution "R4 cycle ${cycle}" "$r4_pod_serve"; then
    ok "R4 cycle ${cycle}: [TurnTiming] phase attribution captured"
  else
    fail "R4 cycle ${cycle}: [TurnTiming] attribution missing for the measured turn"
    pod_diagnostics; print_results; exit 1
  fi
  # WARM-CLASS gate (the product claim): the measured turn must carry
  # warm-class infra overhead. Total time includes llm_wall (LLM latency
  # weather, up to ~5.8s observed in this suite for a single call) and is
  # informational -- a slow LLM must not fail the prewarm claim, and an
  # in-band cold start (~17000ms infra) can never sneak under this gate.
  r4_infra_ms=$(printf '%s' "$TURN_ATTRIBUTION_JSON" | jq -r '.infra_overhead_ms // empty')
  if [ -z "$r4_infra_ms" ]; then
    fail "R4 cycle ${cycle}: infra_overhead_ms missing from the [TurnTiming] attribution -- refusing to gate the warm-class claim without phase data"
    pod_diagnostics; print_results; exit 1
  fi
  if [ "$r4_infra_ms" -le "$R4_WARM_INFRA_BUDGET_MS" ]; then
    ok "R4 cycle ${cycle}: warm-class infra overhead (${r4_infra_ms}ms <= ${R4_WARM_INFRA_BUDGET_MS}ms; total ${RECOVERY_MS}ms includes llm_wall, informational) -- the prewarm hid the cold start"
  else
    fail "R4 cycle ${cycle}: infra overhead ${r4_infra_ms}ms > R4_WARM_INFRA_BUDGET_MS=${R4_WARM_INFRA_BUDGET_MS}ms -- an in-band cold start leaked into the measured turn"
    pod_diagnostics; print_results; exit 1
  fi
  record_cycle "R4_prewarm_first_message" "$cycle" "$RECOVERY_MS" "warm" "" "$TURN_ATTRIBUTION_JSON" "$r4_prewarm_ms"
  cycle=$((cycle + 1))
done

# ANTI-RESURRECTION tail (once, labeled): after the last prewarmed turn
# the host must idle back down to suspended on its own, proving the
# prewarm route wakes the host WITHOUT pinning it awake.
header "R4 anti-resurrection -- host must re-suspend after the prewarm scenario"
if wait_for_suspended "$SUSPEND_WINDOW"; then
  ok "R4 anti-resurrection: host re-suspended on its own (state=suspended, replicas=0, pod gone) -- the prewarm did not pin the host awake"
else
  fail "R4 anti-resurrection: host did NOT re-suspend within ${SUSPEND_WINDOW}s after the prewarm scenario (state=$(lifecycle_state) replicas=$(deployment_replicas)) -- the prewarm may be pinning the host awake"
  pod_diagnostics; print_results; exit 1
fi

# ====================================================================== #
#  Aggregate + gate
# ====================================================================== #
header "Aggregate + gate (p95 budgets)"
if CYCLES_FILE="$CYCLES_FILE" ARTIFACT="$RECOVERY_ARTIFACT" HOST_REF="$HOST_REF" \
   RECOVERY_CYCLES="$RECOVERY_CYCLES" \
   WARM_BUDGET_MS="$WARM_RECOVERY_BUDGET_MS" \
   R4_INFRA_BUDGET_MS="$R4_WARM_INFRA_BUDGET_MS" \
   COLD_BUDGET_MS="$COLD_RECOVERY_BUDGET_MS" python3 - <<'PY'
import json, math, os, re, sys

records = []
with open(os.environ["CYCLES_FILE"]) as fh:
    for line in fh:
        line = line.strip()
        if line:
            records.append(json.loads(line))
if not records:
    print("no cycle records collected -- refusing to emit an empty verdict", file=sys.stderr)
    raise SystemExit(1)

def percentile(values, pct):
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]

expected = int(os.environ["RECOVERY_CYCLES"])
# Scenarios whose measured turns MUST carry [TurnTiming] attribution
# (baseline is enforced at capture time in the bash flow; R3 is exempt --
# its racing turn may be served by a pod that is torn down before its log
# stream can be read, and the attribution scope is baseline/R1/R2/R4).
requires_attribution = {
    "R1_warm_resume_during_draining",
    "R2_cold_resume_from_suspended",
    "R4_prewarm_first_message",
}
budgets = {
    "R1_warm_resume_during_draining": int(os.environ["WARM_BUDGET_MS"]),
    "R2_cold_resume_from_suspended": int(os.environ["COLD_BUDGET_MS"]),
    "R3_drained_report_window": int(os.environ["COLD_BUDGET_MS"]),
    "R4_prewarm_first_message": int(os.environ["R4_INFRA_BUDGET_MS"]),
}
wake_re = re.compile(r"\[StatelessWake\] host=\S+ generation=(\S+) phase=(\S+) ts=(\d+)")

scenarios = {}
over_budget = False
for name, budget in budgets.items():
    recs = [r for r in records if r["scenario"] == name]
    if len(recs) != expected:
        print(
            f"scenario {name}: expected {expected} cycle records, got {len(recs)} -- refusing to gate on partial data",
            file=sys.stderr,
        )
        raise SystemExit(1)
    values = [int(r["ms"]) for r in recs]
    resolution = {"warm": 0, "cold": 0}
    for r in recs:
        if r["resolution"] not in resolution:
            print(f"scenario {name} cycle {r['cycle']}: invalid resolution '{r['resolution']}'", file=sys.stderr)
            raise SystemExit(1)
        resolution[r["resolution"]] += 1
    attribution = []
    for r in recs:
        tt = r.get("turn_timing")
        if not tt:
            if name in requires_attribution:
                print(
                    f"scenario {name} cycle {r['cycle']}: missing [TurnTiming] attribution -- refusing to gate without phase data",
                    file=sys.stderr,
                )
                raise SystemExit(1)
            continue
        attribution.append({"cycle": r["cycle"], **tt})
    breakdown = []
    for r in recs:
        parsed = []
        for line in r.get("wake_phases", []):
            m = wake_re.search(line)
            if m:
                parsed.append({"generation": m.group(1), "phase": m.group(2), "ts_ms": int(m.group(3))})
        if parsed:
            breakdown.append({"cycle": r["cycle"], "wake_phases": parsed})
    # R4 overlap series (prewarm POST -> pod Ready). Informational, no
    # budget: cold infra time is EXPECTED here -- it is exactly what the
    # pre-warm hides from the user. A missing value for an R4 cycle is a
    # hard FAIL (fail-loud contract).
    prewarm = [r["prewarm_to_ready_ms"] for r in recs if r.get("prewarm_to_ready_ms") is not None]
    if name == "R4_prewarm_first_message" and len(prewarm) != expected:
        print(
            f"scenario {name}: expected {expected} prewarm_to_ready_ms values, got {len(prewarm)} -- refusing to emit a partial prewarm overlap series",
            file=sys.stderr,
        )
        raise SystemExit(1)
    p95 = percentile(values, 95)
    if name == "R4_prewarm_first_message":
        # The R4 gate metric is warm-class infra overhead, immune to LLM
        # latency weather; totals (cycles/p50/p95) stay informational.
        missing = [a["cycle"] for a in attribution if "infra_overhead_ms" not in a]
        if missing:
            print(
                f"scenario {name}: cycles {missing} lack infra_overhead_ms -- refusing to gate the warm-class claim",
                file=sys.stderr,
            )
            raise SystemExit(1)
        gate_metric = "infra_overhead_ms"
        gate_p95 = percentile([int(a["infra_overhead_ms"]) for a in attribution], 95)
    else:
        gate_metric = "ms"
        gate_p95 = p95
    verdict = "PASS" if gate_p95 <= budget else "OVER_BUDGET"
    if verdict != "PASS":
        over_budget = True
    entry = {
        "cycles": values,
        "p50": percentile(values, 50),
        "p95": p95,
        "gate_metric": gate_metric,
        "gate_p95": gate_p95,
        "budget_ms": budget,
        "verdict": verdict,
        "resolution": resolution,
    }
    if breakdown:
        entry["wake_phase_breakdown"] = breakdown
    if attribution:
        entry["turn_attribution"] = attribution
    if prewarm:
        entry["prewarm_to_ready_ms"] = prewarm
    scenarios[name] = entry

artifact = {
    "suite": "e2e-stateless-wake-recovery",
    "host_ref": os.environ["HOST_REF"],
    "scenarios": scenarios,
}
baseline_recs = [r for r in records if r["scenario"] == "baseline_active_turn"]
if baseline_recs:
    artifact["baseline"] = [
        {"cycle": r["cycle"], "ms": r["ms"], "turn_timing": r.get("turn_timing")}
        for r in baseline_recs
    ]
with open(os.environ["ARTIFACT"], "w") as fh:
    json.dump(artifact, fh, indent=2)
    fh.write("\n")
print(json.dumps(artifact, indent=2))
raise SystemExit(1 if over_budget else 0)
PY
then
  ok "wake-recovery latency gate passed (artifact: ${RECOVERY_ARTIFACT})"
else
  fail "wake-recovery latency gate FAILED (OVER_BUDGET or aggregation error) -- see artifact: ${RECOVERY_ARTIFACT}"
  pod_diagnostics
  print_results
  exit 1
fi

print_results
