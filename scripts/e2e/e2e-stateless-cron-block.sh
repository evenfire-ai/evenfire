#!/usr/bin/env bash
# e2e-stateless-cron-block.sh -- cron x stateless policy E2E (PR #735).
# Default/false forbids cron_manage create/enable without HITL or a live
# schedule. The tool/HITL policy is covered deterministically in unit tests
# because tool selection is model-driven in the live chat path. This T2 gate
# proves the runtime lifecycle contract with deterministic heartbeat evidence:
# activeCronSchedules blocks suspension, and clearing it releases suspension.
#
# Registered gate: e2e-stateless-cron-block (run directly; not wired to Make).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
. "${HERE}/e2e-lib.sh"

require_safe_kube_context

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
RPC_BASE="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

MCP_HOST_NS="${MCP_HOST_NS:-mcp-host}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
HCC_NS="${HCC_NS:-${CONTROL_NS:-control-plane}}"

E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
POD_READY_TIMEOUT="${POD_READY_TIMEOUT:-180}"
SUSPEND_WINDOW="${SUSPEND_WINDOW:-180}"      # idle(60)+emitter+drain+poll+slack
BLOCK_HOLD="${BLOCK_HOLD:-150}"              # >= 2 heartbeat windows the host must stay up
REASON_WAIT="${REASON_WAIT:-120}"           # bounded wait for the SuspendBlocked reason

# Fast HCC cadence overlay (mirrors the wake-recovery gate).
TEST_IDLE_MINUTES="${TEST_IDLE_MINUTES:-1}"
TEST_IDLE_FLOOR_MINUTES="${TEST_IDLE_FLOOR_MINUTES:-1}"
TEST_DRAIN_GRACE_MS="${TEST_DRAIN_GRACE_MS:-20000}"
TEST_POLL_MS="${TEST_POLL_MS:-5000}"

RUN_ID="$$-$(now_ms)"
THREAD_ID="cron-block-${RUN_ID}"
SESSION_TOKEN=""; RPC_TOKEN=""
HCC_ENV_SAVED=""
CRON_ALLOW_ENV_SAVED=""
CRON_ALLOW_ENV_WAS_SET=0
CRON_ALLOW_ENV_TOUCHED=0
CRON_PIN_PID=""
CRON_POD_UID=""

# kctl(), require_safe_kube_context, header/ok/fail/log/print_results and
# ready_pod_name all come from e2e-lib.sh (sourced above).

lifecycle_state() { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true; }
lifecycle_reason() { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.reason}' 2>/dev/null || true; }
deployment_replicas() { kct=$(kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo ""); printf '%s' "$kct"; }
current_ready_pod() { ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}" 2>/dev/null || true; }
pod_uid() { kctl get pod "$1" -n "$MCP_HOST_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }

upsert_heartbeat_conditions() {
  local pod_uid_arg=$1 active_work=$2 conditions=$3 state=$4
  kctl -n control-plane exec deployment/control-postgres -- psql -U postgres -d profiles -v ON_ERROR_STOP=1     -c "INSERT INTO host_heartbeats (host_ref, pod_uid, active_work, conditions, last_activity_ts, state, received_at) VALUES (\$\$${HOST_REF}\$\$, \$\$${pod_uid_arg}\$\$, ${active_work}, \$\$${conditions}\$\$::jsonb, 0, \$\$${state}\$\$, NOW()) ON CONFLICT (host_ref) DO UPDATE SET pod_uid=EXCLUDED.pod_uid, active_work=EXCLUDED.active_work, conditions=EXCLUDED.conditions, last_activity_ts=EXCLUDED.last_activity_ts, state=EXCLUDED.state, received_at=NOW();" >/dev/null
}

stop_active_cron_pin() {
  local pod_uid_arg=${1:-}
  if [ -n "$CRON_PIN_PID" ]; then
    kill "$CRON_PIN_PID" 2>/dev/null || true
    wait "$CRON_PIN_PID" 2>/dev/null || true
    CRON_PIN_PID=""
  fi
  if [ -n "$pod_uid_arg" ]; then
    local clear_conditions='{"activeTask":false,"awaitingApproval":false,"pendingResults":false,"activeCronSchedules":false}'
    upsert_heartbeat_conditions "$pod_uid_arg" false "$clear_conditions" active >/dev/null 2>&1 || true
  fi
}

start_active_cron_pin() {
  local pod_uid_arg=$1
  local conditions='{"activeTask":false,"awaitingApproval":false,"pendingResults":false,"activeCronSchedules":true}'
  stop_active_cron_pin
  (
    while true; do
      upsert_heartbeat_conditions "$pod_uid_arg" true "$conditions" active >/dev/null 2>&1 || true
      sleep 2
    done
  ) &
  CRON_PIN_PID=$!
}

RPC_SCOPES_JSON='["host:message:invoke","host:approval:write","host:session:read","host:status:read","host:wake:write"]'

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
send_turn_raw() {
  local content=$1 payload resp
  payload="$(jq -cn --arg c "$content" --arg t "$THREAD_ID" '{content:$c,threadId:$t}')"
  resp=$(curl -sS -m "$E2E_TURN_TIMEOUT" -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json' \
    -d "$payload") || { echo "message POST failed at ${RPC_BASE}" >&2; return 1; }
  TURN_STATUS="$(echo "$resp" | tail -n1)"; TURN_BODY="$(echo "$resp" | sed '$d')"
}

post_wake() {
  local resp
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/wake" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json') || return 1
  WAKE_STATUS="$(echo "$resp" | tail -n1)"; WAKE_BODY="$(echo "$resp" | sed '$d')"
  case "$WAKE_STATUS" in
    200|202) return 0 ;;
    *) echo "wake POST -> HTTP ${WAKE_STATUS}: ${WAKE_BODY}" >&2; return 1 ;;
  esac
}

wake_if_suspended() {
  local label=$1 st
  st="$(lifecycle_state)"
  if [ "$st" = "suspended" ]; then
    log "${label}: host suspended -- waking"
    mint_rpc_token || return 1
    post_wake || { fail "${label}: wake POST failed"; return 1; }
    wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "${label}: wake produced no Ready pod"; return 1; }
  fi
}

wait_for_ready_pod() {
  local timeout=$1 waited=0 pod
  while [ "$waited" -lt "$timeout" ]; do
    pod="$(current_ready_pod)"
    if [ -n "$pod" ]; then printf '%s' "$pod"; return 0; fi
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

wait_for_suspended() {
  local timeout=$1 waited=0 st reps running
  while [ "$waited" -lt "$timeout" ]; do
    st="$(lifecycle_state)"; reps="$(deployment_replicas)"
    if ! running="$(running_pod_count "$MCP_HOST_NS" "app=${HOST_REF}")"; then
      echo "wait_for_suspended: failed to count Running pods for ${HOST_REF}" >&2
      return 1
    fi
    if [ "$st" = "suspended" ] && [ "${reps:-1}" = "0" ] && [ "${running:-1}" = "0" ]; then return 0; fi
    sleep 5; waited=$((waited + 5))
  done
  return 1
}

probe_pod_cron_policy_artifacts() {
  local expected_allow=$1 pod
  pod="$(current_ready_pod)"
  [ -n "$pod" ] || { fail "cron tool probe: no Ready pod"; return 1; }
  # Runs inside the deployed mcp-host image, but as a fresh Node process.
  # This proves shipped policy artifacts and env-gated behavior; it does not
  # claim to inspect the already-running scheduler instance.
  kctl exec -i -n "$MCP_HOST_NS" "$pod" -- node - "$expected_allow" < "${HERE}/_lib/stateless-cron-policy-probe.cjs"
}

save_and_set_hcc_cadences() {
  header "PRECONDITION (labeled setup) -- HCC test cadences (idle=${TEST_IDLE_MINUTES}min, drain=${TEST_DRAIN_GRACE_MS}ms)"
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
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1 || {
    fail "HCC rollout did not settle after cadence set"; return 1; }
  ok "HCC test cadences applied"
}

restore_hcc_cadences() {
  [ -n "$HCC_ENV_SAVED" ] || return 0
  log "restoring HCC cadence env"
  local args=() line k v
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    k="${line%%=*}"; v="${line#*=}"
    if [ -n "$v" ]; then args+=("${k}=${v}"); else args+=("${k}-"); fi
  done <<< "$HCC_ENV_SAVED"
  [ ${#args[@]} -gt 0 ] && kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" "${args[@]}" >/dev/null 2>&1 || true
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=120s >/dev/null 2>&1 || true
}

restore_cron_allow_env() {
  [ "$CRON_ALLOW_ENV_TOUCHED" = "1" ] || return 0
  local arg
  if [ "$CRON_ALLOW_ENV_WAS_SET" = "1" ]; then
    arg="CLERUM_STATELESS_ALLOW_CRON_MANAGE=${CRON_ALLOW_ENV_SAVED}"
  else
    arg="CLERUM_STATELESS_ALLOW_CRON_MANAGE-"
  fi
  log "restoring CLERUM_STATELESS_ALLOW_CRON_MANAGE on ${HOST_REF}"
  kctl set env "deployment/${HOST_REF}" -n "$MCP_HOST_NS" "$arg" >/dev/null 2>&1 || true
  kctl rollout status "deployment/${HOST_REF}" -n "$MCP_HOST_NS" --timeout=180s >/dev/null 2>&1 || true
}

set_stateless_cron_allow() {
  local value=$1 cur
  if [ "$CRON_ALLOW_ENV_TOUCHED" = "0" ]; then
    cur="$(kctl get "deployment/${HOST_REF}" -n "$MCP_HOST_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='CLERUM_STATELESS_ALLOW_CRON_MANAGE')].value}" 2>/dev/null || true)"
    CRON_ALLOW_ENV_SAVED="$cur"
    [ -n "$cur" ] && CRON_ALLOW_ENV_WAS_SET=1 || CRON_ALLOW_ENV_WAS_SET=0
    CRON_ALLOW_ENV_TOUCHED=1
  fi
  kctl set env "deployment/${HOST_REF}" -n "$MCP_HOST_NS" \
    "CLERUM_STATELESS_ALLOW_CRON_MANAGE=${value}" >/dev/null 2>&1 || {
    fail "failed to set CLERUM_STATELESS_ALLOW_CRON_MANAGE=${value}"; return 1; }
  kctl rollout status "deployment/${HOST_REF}" -n "$MCP_HOST_NS" --timeout=180s >/dev/null 2>&1 || {
    fail "${HOST_REF} rollout did not settle after CLERUM_STATELESS_ALLOW_CRON_MANAGE=${value}"; return 1; }
  wake_if_suspended "CLERUM_STATELESS_ALLOW_CRON_MANAGE=${value}" || return 1
  wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || {
    fail "${HOST_REF} did not become Ready after CLERUM_STATELESS_ALLOW_CRON_MANAGE=${value}"; return 1; }
  ok "CLERUM_STATELESS_ALLOW_CRON_MANAGE=${value} applied"
}

cleanup() {
  local rc=$?
  stop_active_cron_pin "$CRON_POD_UID" >/dev/null 2>&1 || true
  restore_cron_allow_env
  restore_hcc_cadences
  print_results
  exit "$rc"
}
trap cleanup EXIT

# ---- Prereqs ---------------------------------------------------------------
header "Prerequisites"
for bin in jq curl kubectl; do
  command -v "$bin" >/dev/null 2>&1 || { fail "required tool '${bin}' not installed"; exit 1; }
done
kctl get host "$HOST_REF" -n "$MCP_HOST_NS" >/dev/null 2>&1 \
  && ok "Host '${HOST_REF}' exists" \
  || { fail "Host '${HOST_REF}' not found in ${MCP_HOST_NS}"; exit 1; }
stateless="$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || true)"
[ "$stateless" = "true" ] && ok "Host is stateless (spec.lifecycle.stateless=true)" \
  || { fail "Host '${HOST_REF}' is not stateless -- cannot exercise cron-block"; exit 1; }
curl -sS -m 8 -o /dev/null "${EXT_BASE}/health" && ok "external-rest-api reachable" || { fail "external-rest-api NOT reachable at ${EXT_BASE}"; exit 1; }
curl -sS -m 8 -o /dev/null "${RPC_BASE}/health" && ok "rpc-proxy reachable" || { fail "rpc-proxy NOT reachable at ${RPC_BASE}"; exit 1; }
mint_session_token && ok "session token minted for ${DEV_EMAIL}" || { fail "cannot login as ${DEV_EMAIL}"; exit 1; }
mint_rpc_token && ok "user RPC token minted" || { fail "cannot mint RPC token for ${HOST_REF}"; exit 1; }

save_and_set_hcc_cadences || exit 1
wake_if_suspended "prereq" || exit 1

# ---- Baseline: the host converses ------------------------------------------
header "Baseline -- the host serves a normal turn"
send_turn_raw "Reply with exactly: CRON_BLOCK_BASELINE_${RUN_ID}"
[ "$TURN_STATUS" = "200" ] && ok "baseline turn served (200)" \
  || { fail "baseline turn did not serve (HTTP ${TURN_STATUS}: $(printf '%s' "$TURN_BODY" | head -c 200))"; exit 1; }

# ---- Default forbid has no live cron blocker -------------------------------
header "Default forbid -- no active cron blocker remains"
set_stateless_cron_allow false || exit 1
probe_pod_cron_policy_artifacts false && ok "pod-image cron_manage policy probe rejects create/enable in forbid mode" || exit 1
if wait_for_suspended "$SUSPEND_WINDOW"; then
  ok "default forbid left no active cron blocker; host suspended"
else
  fail "forbid mode did not suspend; state=$(lifecycle_state), replicas=$(deployment_replicas), reason=$(lifecycle_reason)"
  exit 1
fi

header "Allow=true -- activeCronSchedules pins the stateless host awake"
set_stateless_cron_allow true || exit 1
probe_pod_cron_policy_artifacts true && ok "pod-image cron_manage policy probe remains approval-gated and enabled in allow mode" || exit 1
wake_if_suspended "allow=true setup" || exit 1
cron_pod="$(current_ready_pod)"
[ -n "$cron_pod" ] || { fail "allow=true setup had no Ready pod"; exit 1; }
CRON_POD_UID="$(pod_uid "$cron_pod")"
[ -n "$CRON_POD_UID" ] || { fail "could not resolve pod UID for ${cron_pod}"; exit 1; }
start_active_cron_pin "$CRON_POD_UID"
ok "activeCronSchedules heartbeat pin started for pod ${cron_pod}"

log "informational: cron_manage registration, forbid/allow policy, HITL gate, imported-schedule cleanup, and CronScheduler->heartbeat supplier wiring are deterministic local coverage; this T2 phase proves HCC lifecycle response to activeCronSchedules heartbeat without depending on model tool choice"

# ---- BLOCKED: the schedule pins the host awake -----------------------------
header "An active schedule pins the host awake (SuspendBlocked: activeCronSchedules)"
reason_seen=0; waited=0
while [ "$waited" -lt "$REASON_WAIT" ]; do
  r="$(lifecycle_reason)"
  if [ "$r" = "SuspendBlocked: activeCronSchedules" ]; then reason_seen=1; break; fi
  st="$(lifecycle_state)"
  if [ "$st" = "suspended" ]; then
    fail "host suspended while activeCronSchedules=true -- the schedule blocker did NOT keep it awake"
    exit 1
  fi
  sleep 5; waited=$((waited + 5))
done
[ "$reason_seen" = "1" ] && ok "reason == 'SuspendBlocked: activeCronSchedules' -- the schedule is the blocker" \
  || { fail "reason never became 'SuspendBlocked: activeCronSchedules' within ${REASON_WAIT}s (last: '$(lifecycle_reason)')"; kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle}' >&2 2>/dev/null || true; exit 1; }

# Sustained: across >= BLOCK_HOLD (multiple heartbeat windows) the host must
# NOT suspend while the schedule is active.
held=0; violated=0
while [ "$held" -lt "$BLOCK_HOLD" ]; do
  st="$(lifecycle_state)"; reps="$(deployment_replicas)"
  if [ "$st" = "suspended" ] || [ "${reps:-1}" = "0" ]; then violated=1; break; fi
  sleep 10; held=$((held + 10))
done
[ "$violated" = "0" ] && ok "host stayed up for ${BLOCK_HOLD}s with activeCronSchedules=true (never suspended, replicas stayed 1)" \
  || { fail "host suspended (state=${st}, replicas=${reps}) while activeCronSchedules=true -- the block failed"; exit 1; }

# ---- RELEASE: clear activeCronSchedules and the host suspends --------------
header "Clearing activeCronSchedules releases the host"
stop_active_cron_pin "$CRON_POD_UID"
ok "activeCronSchedules heartbeat pin cleared"

if wait_for_suspended "$SUSPEND_WINDOW"; then
  ok "host suspended after activeCronSchedules cleared (state=suspended, replicas=0, pod gone) -- the cron blocker WAS the blocker"
else
  fail "host did NOT suspend within ${SUSPEND_WINDOW}s after activeCronSchedules cleared (state=$(lifecycle_state), replicas=$(deployment_replicas), reason=$(lifecycle_reason))"
  exit 1
fi

# print_results is emitted by the EXIT trap (cleanup); do not double-print here.
