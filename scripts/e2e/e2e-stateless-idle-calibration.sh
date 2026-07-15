#!/usr/bin/env bash
# ======================================================================
# E2E — Stateless T_idle calibration sweep (compressed-local)
#
# PURPOSE: empirically ground the Time-to-Idle (T_idle) choice. The
# product hypothesis is T_idle = 30 min in production
# (CONTEXT_MAPPER_STATELESS_IDLE_MINUTES default, host-context-controller/
# src/config.ts:524). A local minikube cannot replay 30-minute human
# gaps, so this harness runs a TIME-COMPRESSED sweep over small T
# candidates and session gaps expressed as MULTIPLES of each candidate.
# That validates the tradeoff-curve MECHANICS (threshold correctness,
# resume-outcome classification, recovery latency per class, pod-uptime
# cost integration) — NOT the production constant. The transfer function
# to production data lives in docs/testing/stateless-idle-calibration.md.
#
# THE KNOB (verified — do not "fix" this to a Host CRD patch): T_idle is
# NOT a per-Host CRD field. Host CRD spec.lifecycle carries only
# `stateless: boolean` (charts/clerum-crds/crds/host.yaml). The idle
# threshold is HCC-global env:
#   CONTEXT_MAPPER_STATELESS_IDLE_MINUTES        (default 30)
#   CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES  (default 15)
# and the tracker applies T_idle = max(idleMinutes, idleFloorMinutes)
# (statelessLifecycleTracker.ts:220; drain rule in its doc comment:
# drain = statelessEnabled && !activeWork && now-lastActivityTs >= T_idle).
# The sweep therefore sets the candidate via `kubectl set env` on the HCC
# deployment (floor pinned to 1, the legal minimum — tracker rejects <=0),
# exactly like e2e-stateless-suspend-wake.sh does, and RESTORES the
# original env in the cleanup trap.
#
# CADENCE MATH (mirrors the sibling suite header — read before touching
# timeouts): the mcp-host heartbeat emitter runs at a FIXED 30s cadence
# (CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS default 30000, mcp-host/src/
# config.ts; HCC does not inject it). Suspend detection after idle expiry
# therefore lags by up to emitter(30s) + drainGrace(20s, set below) +
# HCC poll(5s, set below) + reconcile slack. On top of that, a gap that
# follows a COLD wake sits in the wakePending settling window: the tracker
# answers drain:false and cancels in-flight drains while
# wakeRequestedGeneration > wakeHandledGeneration (statelessLifecycleTracker
# "Cancel-drain wins: never answer drain:true over a pending wake"), and the
# handled marker only catches up on a reconciler pass (observed cadence
# ~3min). Measured 2026-07-05 (T=1, event after a cold_wake): suspend was
# still blocked at +150s, while steady-state suspend completes in ~15s once
# eligible. Hence SUSPEND_DETECT_SLACK=300s: one reconcile interval (~200s)
# + clean drain tail (~35s) + margin. Supra-threshold gaps are judged
# against T*60 + SUSPEND_DETECT_SLACK, never against the raw gap alone.
#
# GUARDIAN CONTRACT (all HARD FAILURES, no silent skips):
#   (a) a sub-threshold gap (g < 1x) that produces state=suspended FAILS
#       — T_idle not honored is a product bug detector, not tuning noise;
#   (b) a supra-threshold gap (g > 1x) that never suspends within
#       T*60 + SUSPEND_DETECT_SLACK FAILS with pod/HCC diagnostics;
#   (c) a resume whose turn times out, hits transport failure, or returns
#       a non-retryable status FAILS (only 503 {code:"host_waking"} is
#       retried, under the same bounded WAKE_HOLD_DEADLINE the sibling
#       suite uses).
# All user turns go through rpc-proxy (POST /rpc/hosts/:hostRef/messages);
# kubectl is used only for observation and labeled preconditions.
#
# DEFAULT MATRIX WALL TIME: candidates "1 2" x 4 events x multiplier
# cycle (0.5 1.5 3 0.5) => gap sleep (1+2)*5.5 = 16.5 min + per-candidate
# overhead (HCC rollout + resumes) ~= 26 min total. EVENTS_PER_CANDIDATE
# defaults to 4 (NOT 6): with 6 the estimate is ~40 min, over the ~35 min
# budget. Set EVENTS_PER_CANDIDATE=6 explicitly for the denser sweep.
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-stateless-idle-calibration.sh
#   IDLE_CANDIDATES_MIN="1 2" GAP_MULTIPLIERS="0.5 1.5 3" \
#   EVENTS_PER_CANDIDATE=4 DISRUPTION_THRESHOLD=0.34 ...
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

# --- Sweep parameters -------------------------------------------------
IDLE_CANDIDATES_MIN="${IDLE_CANDIDATES_MIN:-1 2}"
GAP_MULTIPLIERS="${GAP_MULTIPLIERS:-0.5 1.5 3}"
EVENTS_PER_CANDIDATE="${EVENTS_PER_CANDIDATE:-4}"
DISRUPTION_THRESHOLD="${DISRUPTION_THRESHOLD:-0.34}"

# --- Budgets (inherited from the sibling suite) -----------------------
E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
POD_READY_TIMEOUT="${POD_READY_TIMEOUT:-180}"
WAKE_HOLD_DEADLINE="${WAKE_HOLD_DEADLINE:-270}"
SUSPEND_DETECT_SLACK="${SUSPEND_DETECT_SLACK:-300}"  # emitter 30 + grace 20 + poll 5 + post-cold-wake wakePending settling (~1 reconcile interval; see header)
UPTIME_SAMPLE_INTERVAL="${UPTIME_SAMPLE_INTERVAL:-5}"

# --- HCC cadence overlay (candidate T is set per-loop; rest fixed) ----
HCC_DEPLOY="host-context-controller"
HCC_NS="${CONTROL_NS:-control-plane}"
TEST_IDLE_FLOOR_MINUTES="1"     # legal minimum; tracker rejects 0 -> candidate T governs
TEST_DRAIN_GRACE_MS="20000"
TEST_POLL_MS="5000"

RUN_ID="$(date +%s)-$$-${RANDOM}"
THREAD_ID="e2e-stateless-idle-calibration-${RUN_ID}"
OUT_JSON="${IDLE_CALIBRATION_OUT:-/tmp/stateless-idle-calibration-${RUN_ID}.json}"
RECORDS_FILE="$(mktemp)"
UPTIME_SUMMARY_FILE="$(mktemp)"
UPTIME_SAMPLES_FILE=""
UPTIME_PID=""

# --- Parameter validation (fail loud on nonsense) ---------------------
for T in $IDLE_CANDIDATES_MIN; do
  case "$T" in ''|*[!0-9]*) echo "IDLE_CANDIDATES_MIN entry '${T}' is not a positive integer (minutes)" >&2; exit 1 ;; esac
  [ "$T" -ge 1 ] || { echo "IDLE_CANDIDATES_MIN entry '${T}' must be >= 1 (tracker rejects idleMinutes <= 0)" >&2; exit 1; }
done
for g in $GAP_MULTIPLIERS; do
  awk -v g="$g" 'BEGIN{ if (g+0 != g || g <= 0) exit 1 }' || { echo "GAP_MULTIPLIERS entry '${g}' is not a positive number" >&2; exit 1; }
  # Multipliers in (0.9, 1.1) race the threshold itself (drain fires at
  # >= T while the emitter samples every 30s) -> unclassifiable, reject.
  awk -v g="$g" 'BEGIN{ if (g > 0.9 && g < 1.1) exit 1 }' || { echo "GAP_MULTIPLIERS entry '${g}' is ambiguous (within 10% of the threshold); pick a clearly sub- or supra-threshold multiple" >&2; exit 1; }
done
case "$EVENTS_PER_CANDIDATE" in ''|*[!0-9]*) echo "EVENTS_PER_CANDIDATE '${EVENTS_PER_CANDIDATE}' is not a positive integer" >&2; exit 1 ;; esac
[ "$EVENTS_PER_CANDIDATE" -ge 1 ] || { echo "EVENTS_PER_CANDIDATE must be >= 1" >&2; exit 1; }
awk -v t="$DISRUPTION_THRESHOLD" 'BEGIN{ if (t+0 != t || t < 0 || t > 1) exit 1 }' || { echo "DISRUPTION_THRESHOLD '${DISRUPTION_THRESHOLD}' must be a number in [0,1]" >&2; exit 1; }

# --- Cleanup trap ------------------------------------------------------
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

stop_uptime_sampler() {
  if [ -n "$UPTIME_PID" ]; then
    kill "$UPTIME_PID" 2>/dev/null || true
    wait "$UPTIME_PID" 2>/dev/null || true
    UPTIME_PID=""
  fi
}

cleanup_on_exit() {
  local status=$?
  set +e
  stop_uptime_sampler
  # Leave the host Ready for the next suite (best-effort; a suspended
  # host is idempotent-rerunnable state, so only warn on failure).
  if [ "$(lifecycle_state)" = "suspended" ]; then
    post_wake >/dev/null 2>&1 || warn "cleanup wake POST failed; host left suspended (re-runnable)"
  fi
  restore_hcc_env
  rm -f "$RECORDS_FILE" "$UPTIME_SUMMARY_FILE" "$UPTIME_SAMPLES_FILE" 2>/dev/null
  exit "$status"
}
trap cleanup_on_exit EXIT

# --- Observability helpers (mirrors e2e-stateless-suspend-wake.sh) ----
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

pod_diagnostics() {
  echo "--- diagnostics for app=${HOST_REF} in ${MCP_HOST_NS} ---" >&2
  kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" -o wide 2>/dev/null >&2 || true
  kctl get host "$HOST_REF" -n "$MCP_HOST_NS" \
    -o jsonpath='{"lifecycle="}{.status.lifecycle}{"\n"}' 2>/dev/null >&2 || true
  kctl logs "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --tail=60 2>/dev/null >&2 || true
}

lifecycle_state()     { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true; }
deployment_replicas() { kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo ""; }
current_ready_pod()   { ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}"; }

pod_uid() {
  local p
  p=$(current_ready_pod) || return 1
  kctl get pod "$p" -n "$MCP_HOST_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null
}

wait_for_ready_pod() {
  local timeout=$1 elapsed=0 name
  while [ "$elapsed" -lt "$timeout" ]; do
    if name=$(current_ready_pod); then printf "%s\n" "$name"; return 0; fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# --- RPC helpers (Desktop App auth path, mirrors the sibling suite) ---
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
send_turn() {
  local content=$1 payload resp
  mint_rpc_token || return 1
  payload="$(jq -cn --arg c "$content" --arg t "$THREAD_ID" '{content:$c,threadId:$t}')"
  resp=$(curl -sS -m "$E2E_TURN_TIMEOUT" -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json' \
    -d "$payload") || { echo "message POST failed at ${RPC_BASE}" >&2; return 1; }
  TURN_STATUS="$(echo "$resp" | tail -n1)"; TURN_BODY="$(echo "$resp" | sed '$d')"
}

# send_turn_expect_ok: single bounded deadline; the ONLY retryable is the
# documented 503 {code:"host_waking"} while rpc-proxy's wake-and-hold
# settles. Timeout / transport / non-retryable status => caller HARD FAILS
# (guardian (c)). Also records TURN_RECOVERY_MS (send entry -> definitive
# 200), the resume-latency observable.
TURN_RECOVERY_MS=""
send_turn_expect_ok() {
  local content=$1 deadline=$((SECONDS + WAKE_HOLD_DEADLINE)) attempt=0 t0 t1
  t0="$(now_ms)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    send_turn "$content" || return 1
    if [ "$TURN_STATUS" = "200" ]; then
      t1="$(now_ms)"; TURN_RECOVERY_MS=$((t1 - t0)); return 0
    fi
    if [ "$TURN_STATUS" = "503" ] && echo "$TURN_BODY" | grep -q 'host_waking'; then
      log "attempt ${attempt}: host_waking (retryable) -- re-issuing within wake-hold deadline"
      sleep 3; continue
    fi
    echo "turn returned non-retryable HTTP ${TURN_STATUS}: ${TURN_BODY}" >&2; return 1
  done
  echo "wake-and-hold deadline (${WAKE_HOLD_DEADLINE}s) exceeded; last status=${TURN_STATUS} body=${TURN_BODY}" >&2
  return 1
}

WAKE_STATUS=""; WAKE_BODY=""

# The control-api /rpc facade requires the rpc-proxy PLANE inter-service token
# (requireInternalService) plus the user RPC JWT in x-rpc-access-token — the
# exact contract rpc-proxy's controlApiHeaders uses. Read the plane token from
# the Secret; missing key/entry fails loud.
RPC_PLANE_SERVICE_TOKEN=""
resolve_rpc_plane_service_token() {
  [ -n "$RPC_PLANE_SERVICE_TOKEN" ] && return 0
  local pairs
  pairs=$(kctl -n control-plane get secret control-api-internal-tokens \
    -o jsonpath='{.data.CONTROL_API_INTERNAL_SERVICE_TOKENS}' | base64 -d) || {
    echo "cannot read Secret control-plane/control-api-internal-tokens" >&2; return 1; }
  RPC_PLANE_SERVICE_TOKEN=$(printf '%s' "$pairs" | tr ',' '\n' | sed -n 's/^rpc-proxy=//p' | head -1)
  [ -n "$RPC_PLANE_SERVICE_TOKEN" ] || {
    echo "no rpc-proxy entry in CONTROL_API_INTERNAL_SERVICE_TOKENS" >&2; return 1; }
}

post_wake() {
  local resp
  mint_rpc_token || return 1
  resolve_rpc_plane_service_token || return 1
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST \
    "${WAKE_BASE}/api/v1/rpc/hosts/${HOST_REF}/wake" \
    -H "Authorization: Bearer ${RPC_PLANE_SERVICE_TOKEN}" \
    -H "x-service-token: rpc-proxy" \
    -H "x-rpc-access-token: ${RPC_TOKEN}" -H 'Content-Type: application/json') || {
    echo "wake POST failed at ${WAKE_BASE}" >&2; return 1; }
  WAKE_STATUS="$(echo "$resp" | tail -n1)"; WAKE_BODY="$(echo "$resp" | sed '$d')"
}

# --- Candidate cadence (labeled precondition; restored in trap) --------
save_hcc_env_once() {
  [ -z "$HCC_ENV_SAVED" ] || return 0
  local keys=(CONTEXT_MAPPER_STATELESS_IDLE_MINUTES CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES \
    CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS CONTEXT_MAPPER_HEARTBEAT_POLL_MS)
  local k cur saved=""
  for k in "${keys[@]}"; do
    cur="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${k}')].value}" 2>/dev/null || true)"
    saved+="${k}=${cur}"$'\n'
  done
  HCC_ENV_SAVED="$saved"
}

apply_candidate_cadence() {
  local t_min=$1
  header "Precondition: T_idle candidate = ${t_min} min (HCC env overlay; floor=${TEST_IDLE_FLOOR_MINUTES}, drain=${TEST_DRAIN_GRACE_MS}ms, poll=${TEST_POLL_MS}ms)"
  save_hcc_env_once
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
    "CONTEXT_MAPPER_STATELESS_IDLE_MINUTES=${t_min}" \
    "CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES=${TEST_IDLE_FLOOR_MINUTES}" \
    "CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS=${TEST_DRAIN_GRACE_MS}" \
    "CONTEXT_MAPPER_HEARTBEAT_POLL_MS=${TEST_POLL_MS}" >/dev/null 2>&1 || {
    fail "failed to set candidate T_idle=${t_min}min via kubectl set env on ${HCC_DEPLOY}"; return 1; }
  if kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1; then
    ok "HCC running with T_idle=${t_min}min (T_idle = max(idleMinutes=${t_min}, floor=${TEST_IDLE_FLOOR_MINUTES}) = ${t_min}min)"
  else
    fail "HCC rollout did not settle after cadence set for T=${t_min}min"; pod_diagnostics; return 1
  fi
}

# --- Pod-uptime sampler (cost proxy) -----------------------------------
start_uptime_sampler() {
  UPTIME_SAMPLES_FILE="$(mktemp)"
  (
    while :; do
      n="$(kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" \
        --field-selector=status.phase=Running -o name 2>/dev/null | wc -l | tr -d ' ')"
      if [ "${n:-0}" -gt 0 ]; then echo 1; else echo 0; fi >> "$UPTIME_SAMPLES_FILE"
      sleep "$UPTIME_SAMPLE_INTERVAL"
    done
  ) &
  UPTIME_PID=$!
}

finish_uptime_sample() {
  local t_min=$1 wall_s=$2 up_samples uptime_s
  stop_uptime_sampler
  up_samples="$(awk '$1==1{c++} END{print c+0}' "$UPTIME_SAMPLES_FILE")"
  uptime_s=$((up_samples * UPTIME_SAMPLE_INTERVAL))
  jq -cn --argjson t "$t_min" --argjson u "$uptime_s" --argjson w "$wall_s" \
    '{candidate_min:$t, pod_uptime_seconds:$u, wall_seconds:$w}' >> "$UPTIME_SUMMARY_FILE"
  rm -f "$UPTIME_SAMPLES_FILE"; UPTIME_SAMPLES_FILE=""
}

record_event() {
  # args: candidate_min event multiplier gap_s outcome recovery_ms suspended_during_gap
  jq -cn --argjson t "$1" --argjson i "$2" --arg g "$3" --argjson gs "$4" \
    --arg o "$5" --argjson r "$6" --argjson s "$7" \
    '{candidate_min:$t, event:$i, multiplier:($g|tonumber), gap_seconds:$gs,
      outcome:$o, recovery_ms:$r, suspended_during_gap:($s==1)}' >> "$RECORDS_FILE"
}

# --- Per-candidate synthetic session trace ------------------------------
run_candidate() {
  local t_min=$1
  local -a mults
  read -r -a mults <<< "$GAP_MULTIPLIERS"
  local nm=${#mults[@]}

  apply_candidate_cadence "$t_min" || { print_results; exit 1; }

  # Make sure the trace starts from a served, active host.
  if [ "$(lifecycle_state)" = "suspended" ]; then
    post_wake || { fail "candidate T=${t_min}: wake POST failed reviving suspended host"; print_results; exit 1; }
    case "$WAKE_STATUS" in 200|202) : ;; *) fail "candidate T=${t_min}: wake returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}"; print_results; exit 1 ;; esac
  fi
  wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || {
    fail "candidate T=${t_min}: no Ready pod for app=${HOST_REF} before the trace"; pod_diagnostics; print_results; exit 1; }

  start_uptime_sampler
  local cand_start; cand_start=$(date +%s)

  header "Candidate T=${t_min}min -- baseline turn"
  if send_turn_expect_ok "Reply with exactly: IDLECAL_BASE_${t_min}_${RUN_ID}"; then
    ok "baseline turn served in ${TURN_RECOVERY_MS}ms"
  else
    fail "candidate T=${t_min}: baseline turn failed (guardian (c): timeout/transport/non-retryable are hard failures)"
    pod_diagnostics; print_results; exit 1
  fi
  local uid_last; uid_last="$(pod_uid || true)"
  [ -n "$uid_last" ] || { fail "candidate T=${t_min}: cannot resolve pod UID after baseline turn"; pod_diagnostics; print_results; exit 1; }

  local i g gap_s is_supra suspend_deadline gap_elapsed st suspended_during_gap
  local state_at_send outcome uid_now remaining gap_kind
  for (( i=1; i<=EVENTS_PER_CANDIDATE; i++ )); do
    g="${mults[$(( (i-1) % nm ))]}"
    gap_s="$(awk -v g="$g" -v t="$t_min" 'BEGIN{ printf "%d", (g*t*60)+0.5 }')"
    is_supra="$(awk -v g="$g" 'BEGIN{ print (g>1) ? 1 : 0 }')"
    suspended_during_gap=0
    if [ "$is_supra" = "1" ]; then gap_kind="supra"; else gap_kind="sub"; fi
    header "Candidate T=${t_min}min -- event ${i}/${EVENTS_PER_CANDIDATE}: gap ${g}xT = ${gap_s}s (${gap_kind}-threshold)"

    gap_elapsed=0
    if [ "$is_supra" = "0" ]; then
      # (a) Sub-threshold gap: the host must NEVER suspend during it.
      st=""
      while [ "$gap_elapsed" -lt "$gap_s" ]; do
        st="$(lifecycle_state)"
        if [ "$st" = "suspended" ]; then
          fail "GUARDIAN (a): sub-threshold gap (${g}xT=${gap_s}s < T=${t_min}min) produced state=suspended at +${gap_elapsed}s -- T_idle NOT honored (product bug, not tuning noise)"
          pod_diagnostics; print_results; exit 1
        fi
        sleep "$POLL_INTERVAL"; gap_elapsed=$((gap_elapsed + POLL_INTERVAL))
      done
      ok "sub-threshold gap held without suspend (last state='${st:-active}')"
    else
      # (b) Supra-threshold gap: the host MUST suspend within
      # T*60 + SUSPEND_DETECT_SLACK of the last activity.
      suspend_deadline=$(( t_min * 60 + SUSPEND_DETECT_SLACK ))
      while :; do
        st="$(lifecycle_state)"
        if [ "$st" = "suspended" ] && [ "$(deployment_replicas)" = "0" ]; then
          suspended_during_gap=1
          ok "suspended at +${gap_elapsed}s (bound: T+slack=${suspend_deadline}s)"
          break
        fi
        if [ "$gap_elapsed" -ge "$suspend_deadline" ]; then
          fail "GUARDIAN (b): supra-threshold gap (${g}xT) never suspended within T+slack=${suspend_deadline}s (state='${st:-<empty>}' replicas=$(deployment_replicas))"
          pod_diagnostics; print_results; exit 1
        fi
        sleep "$POLL_INTERVAL"; gap_elapsed=$((gap_elapsed + POLL_INTERVAL))
      done
      remaining=$(( gap_s - gap_elapsed ))
      if [ "$remaining" -gt 0 ]; then
        log "holding remaining ${remaining}s to complete the ${g}xT gap"
        sleep "$remaining"
      fi
    fi

    # Resume with the next turn; classify by lifecycle state at send.
    state_at_send="$(lifecycle_state)"
    if send_turn_expect_ok "Reply with exactly: IDLECAL_${t_min}_${i}_${RUN_ID}"; then
      :
    else
      fail "GUARDIAN (c): resume turn for event ${i} (state_at_send='${state_at_send:-<empty>}') did not reach a definitive 200 (timeout / transport / non-retryable)"
      pod_diagnostics; print_results; exit 1
    fi

    wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || {
      fail "event ${i}: no Ready pod after a served resume turn"; pod_diagnostics; print_results; exit 1; }
    uid_now="$(pod_uid || true)"
    [ -n "$uid_now" ] || { fail "event ${i}: cannot resolve pod UID after resume"; pod_diagnostics; print_results; exit 1; }

    case "$state_at_send" in
      suspended)
        outcome="cold_wake"
        if [ "$uid_now" = "$uid_last" ]; then
          fail "event ${i}: state was suspended at send but pod UID did not change (${uid_now}) -- wake did not replace the pod"
          pod_diagnostics; print_results; exit 1
        fi ;;
      draining)
        outcome="warm_cancel"
        if [ "$uid_now" != "$uid_last" ]; then
          fail "event ${i}: cancel-drain resume changed the pod UID (${uid_last} -> ${uid_now}) -- expected the same pod"
          pod_diagnostics; print_results; exit 1
        fi ;;
      *)
        outcome="warm_active"
        if [ "$uid_now" != "$uid_last" ]; then
          fail "event ${i}: active-state resume changed the pod UID (${uid_last} -> ${uid_now}) -- unexplained pod restart"
          pod_diagnostics; print_results; exit 1
        fi ;;
    esac
    ok "event ${i}: outcome=${outcome} recovery=${TURN_RECOVERY_MS}ms"
    record_event "$t_min" "$i" "$g" "$gap_s" "$outcome" "$TURN_RECOVERY_MS" "$suspended_during_gap"
    uid_last="$uid_now"
  done

  finish_uptime_sample "$t_min" "$(( $(date +%s) - cand_start ))"
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
if mint_rpc_token; then ok "user RPC token minted (host:wake:write among scopes)"; else
  fail "cannot mint RPC token for hostRef=${HOST_REF} -- is ${DEV_EMAIL} associated to the stateless host?"; print_results; exit 1; fi

EST_MIN="$(awk -v cands="$IDLE_CANDIDATES_MIN" -v mults="$GAP_MULTIPLIERS" -v ev="$EVENTS_PER_CANDIDATE" 'BEGIN{
  nc=split(cands, C, " "); nm=split(mults, M, " "); total=0
  for (i=1; i<=nc; i++) { s=0; for (e=0; e<ev; e++) s+=M[(e%nm)+1]; total+=s*C[i] }
  printf "%.1f", total + nc*2.5 + 2   # +2.5 min/candidate (HCC rollout + resumes) + 2 min prereq
}')"
log "Estimated wall time for this matrix: ~${EST_MIN} min (gap sleep + per-candidate overhead)"

# ====================================================================== #
#  Sweep
# ====================================================================== #
for T in $IDLE_CANDIDATES_MIN; do
  run_candidate "$T"
done

# ====================================================================== #
#  Aggregation + recommendation
# ====================================================================== #
header "Aggregation"
event_count="$(wc -l < "$RECORDS_FILE" | tr -d ' ')"
expected_count=0
for T in $IDLE_CANDIDATES_MIN; do expected_count=$((expected_count + EVENTS_PER_CANDIDATE)); done
if [ "$event_count" != "$expected_count" ]; then
  fail "aggregation refused: recorded ${event_count} events, expected ${expected_count} -- a missing record means an unmeasured resume"
  print_results; exit 1
fi

jq -s \
  --slurpfile uptime "$UPTIME_SUMMARY_FILE" \
  --argjson threshold "$DISRUPTION_THRESHOLD" \
  --arg gap_multipliers "$GAP_MULTIPLIERS" \
  --arg run_id "$RUN_ID" '
  def p95: sort | if length == 0 then null else .[(((length * 0.95) | ceil) - 1)] end;
  (group_by(.candidate_min) | map(
    . as $ev |
    ($uptime | map(select(.candidate_min == $ev[0].candidate_min)) | first) as $up |
    {
      candidate_min: $ev[0].candidate_min,
      resumes: ($ev | length),
      suspend_count: ($ev | map(select(.suspended_during_gap)) | length),
      cold_wake_count: ($ev | map(select(.outcome == "cold_wake")) | length),
      warm_cancel_count: ($ev | map(select(.outcome == "warm_cancel")) | length),
      warm_active_count: ($ev | map(select(.outcome == "warm_active")) | length),
      disruption_rate: (($ev | map(select(.outcome == "cold_wake")) | length) / ($ev | length)),
      p95_recovery_ms: {
        cold_wake:   ($ev | map(select(.outcome == "cold_wake")   | .recovery_ms) | p95),
        warm_cancel: ($ev | map(select(.outcome == "warm_cancel") | .recovery_ms) | p95),
        warm_active: ($ev | map(select(.outcome == "warm_active") | .recovery_ms) | p95)
      },
      pod_uptime_seconds: ($up | if . == null then null else .pod_uptime_seconds end),
      wall_seconds:       ($up | if . == null then null else .wall_seconds end),
      uptime_ratio:       ($up | if . == null or .wall_seconds == 0 then null
                                 else (.pod_uptime_seconds / .wall_seconds) end),
      events: $ev
    })) as $cands |
  ($cands | map(select(.disruption_rate <= $threshold)) | sort_by(.candidate_min) | first) as $pick |
  {
    run_id: $run_id,
    scope: "compressed-local",
    gap_multipliers: $gap_multipliers,
    candidates: $cands,
    recommendation: {
      scope: "compressed-local",
      decision_rule: "smallest T whose disruption_rate <= DISRUPTION_THRESHOLD, on the measured data",
      disruption_threshold: $threshold,
      chosen_candidate_min: ($pick | if . == null then null else .candidate_min end),
      note: (if $pick == null then
        "No candidate met the threshold at compressed scale. EXPECTED with the default multiplier mix: gaps are defined relative to each T, so every candidate sees the same supra/sub ratio and disruption_rate is fixed by GAP_MULTIPLIERS, by construction. The sweep validates threshold mechanics and per-class recovery latency; it does not pick the production constant."
      else
        "Chosen on measured compressed-local data only; do NOT promote to production without the transfer step."
      end),
      production_transfer_rule: "T_idle* ~= the p75-p90 quantile of the PRODUCTION inter-message gap distribution per Host class, bounded below by CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES and above by cost tolerance. Measure gaps as deltas of host_heartbeats.last_activity_ts in control-plane Postgres. The 30-min hypothesis is the right starting default iff ~75-90% of session gaps are under 30 min. See docs/testing/stateless-idle-calibration.md."
    }
  }' "$RECORDS_FILE" > "$OUT_JSON" || { fail "jq aggregation failed"; print_results; exit 1; }

ok "calibration JSON written to ${OUT_JSON}"
jq . "$OUT_JSON"

print_results
