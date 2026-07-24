#!/usr/bin/env bash
# ======================================================================
# E2E — Stateless host suspend/wake (Stage 7 Part B, Phase 1: API)
#
# Exercises the full stateless lifecycle against a live cluster: idle
# suspend (D8), the five suspend-refusal conditions, suspend->wake, cancel-
# drain, wake-generation idempotency, concurrent-message dedup, wake authz,
# RBAC negatives, single-writer scale timeline, the heartbeat plane, the
# kill-switch, and mcpServer re-resolution on wake. Then hands off to the
# Desktop Playwright phase (stateless-wake.test.ts) as its final phase.
#
# HIGH-3 RE-RESOLUTION OBSERVABLE (Test 12, chosen and justified):
#   The spec demands "rotate a value -> new served, OLD provably rejected".
#   Removing an mcpServer only proves removal, so Test 12 adds a rotation
#   sub-case. Rotating the real LLM key to a second VALID provider key is not
#   feasible in minikube (needs two live keys against a real provider), so we
#   rotate the host's own LLM provider Secret (spec.secretRef) to a sentinel
#   INVALID value during suspension. The falsifiable half: the woken turn is
#   refused at the provider (non-200) -- if the woken pod had served the OLD
#   (valid) secret from a stale cache, the turn would still 200, so a refusal
#   proves the old value is provably no longer served and the pod re-read the
#   rotated Secret at wake. Restoring the Secret + re-waking then serves 200,
#   confirming the observable is the rotation, not a broken host. The original
#   Secret data is captured and restored in the cleanup trap.
#   TIGHTENED SEMANTICS (Test 12b): only a DEFINITIVE provider-facing response
#   counts as evidence. 503 {code:"host_waking"} is wake-in-progress -- it is
#   retried under the same WAKE_HOLD_DEADLINE bound send_turn_expect_ok uses,
#   never treated as a refusal. Deadline expiry while still host_waking and
#   any transport-level curl failure are HARD FAILURES: the request never
#   reached mcp-host's LLM-provider call, so passing on them would be a
#   false-positive on a security-property assertion.
#
# All user turns go through rpc-proxy (POST /rpc/hosts/:hostRef/messages).
# Explicit prewarm also uses the existing Desktop rpc-proxy route (POST
# /rpc/hosts/:hostRef/wake); rpc-proxy owns the control-api hop. The E2E
# runner never calls mcp-host or control-api's internal rpc facade directly.
# Tokens are minted the Desktop App way (password-login on external-rest-api
# -> POST /api/v1/rpc/token), mirroring e2e-stateless-durability.sh.
#
# EMITTER CADENCE (wall-clock math -- read before touching timeouts):
#   The mcp-host heartbeat emitter uses its product default of 30000ms. HCC
#   owns the derived host Deployment template and does not project a per-Host
#   heartbeat interval, so this suite must not mutate the Deployment to shorten
#   the cadence: that would create out-of-band template drift and a rollout
#   race rather than exercise the user path. Every suspend/refusal observation
#   therefore allows one emitter tick (~30s), plus one HCC heartbeat-poll tick
#   (CONTEXT_MAPPER_HEARTBEAT_POLL_MS, set to ~5s below). Suspend windows retain
#   slack for the normal production cadence.
#
# HCC test cadences are set on the live deployment via `kubectl set env`
# (NOT overlay files) and RESTORED + rollout-waited in the cleanup trap:
#   CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES = 1 (minimum legal floor; tracker rejects 0)
#   CONTEXT_MAPPER_STATELESS_IDLE_MINUTES       = 1 (minimum legal T_idle; tracker rejects 0)
#   CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS     = 20000
#   CONTEXT_MAPPER_HEARTBEAT_POLL_MS            = 5000
#
# Prereqs (each a HARD FAIL with the concrete reason):
#   - Host CR chatllm-stateless with spec.lifecycle.stateless=true + pod Ready
#   - external-rest-api + rpc-proxy + control-api reachable (port-forwards up)
#   - user RPC token mintable with host:wake:write (default user-token scope)
#   - host image present on the node (pod already Ready proves this)
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-stateless-suspend-wake.sh
#   E2E_SKIP_DESKTOP_PHASE=1 ...   # opt out of the Playwright phase (exit 3)
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
CONTEXT_NS="${CONTEXT_NS:-${MCP_SERVER_NS:-mcp-server}}"
CONTROL_BASE="${CONTROL_API_BASE_URL:-http://127.0.0.1:8090}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
RPC_BASE="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
GATEWAY_BASE="${RPC_GATEWAY_BASE_URL:-${CONTROL_BASE}}"
# Wake uses the same rpc-proxy user route as Desktop. rpc-proxy owns
# service-to-service auth to control-api; the E2E runner only sends the
# per-user RPC value minted by external-rest-api.
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
POD_READY_TIMEOUT="${POD_READY_TIMEOUT:-180}"
SUSPEND_WINDOW="${SUSPEND_WINDOW:-180}"         # emitter(30) + drain(20) + poll(5) + slack
WAKE_HOLD_DEADLINE="${WAKE_HOLD_DEADLINE:-270}" # single bounded deadline for wake-and-hold retries
DEDUP_RESULT_TIMEOUT="${DEDUP_RESULT_TIMEOUT:-360}"
DRAINING_WAIT="${DRAINING_WAIT:-90}"            # emitter tick + poll to reach state=draining
REFUSAL_HOLD_CYCLES="${REFUSAL_HOLD_CYCLES:-2}" # poll cycles replicas must stay 1 to prove refusal
E2E_SKIP_DESKTOP_PHASE="${E2E_SKIP_DESKTOP_PHASE:-0}"

# HCC test cadences (applied on the live deployment, restored in trap).
HCC_DEPLOY="host-context-controller"
HCC_NS="${CONTROL_NS:-control-plane}"
# HIGH-3/M5: control-api emits a structured "host wake requested"
# ({event:'host_wake_requested', hostRef, wakeGeneration}) log on EVERY wake
# request that reaches it (control-api/src/routes/rpc-access/hosts.ts). Counting
# those lines is a control-api-side wake-receipt counter that survives
# rpc-proxy's in-memory dedup coalescing. Test 6 runs rpc-proxy at replicas:1
# (below) so its in-memory dedup map is authoritative, then asserts exactly one
# wake receipt reached control-api for the concurrent burst.
CONTROL_API_DEPLOY="${CONTROL_API_DEPLOY:-control-api}"
RPC_PROXY_DEPLOY="${RPC_PROXY_DEPLOY:-rpc-proxy}"
RPC_PROXY_NS="${RPC_PROXY_NS:-rpc-proxy}"
TEST_IDLE_MINUTES="1"
TEST_IDLE_FLOOR_MINUTES="1"
TEST_DRAIN_GRACE_MS="20000"
TEST_POLL_MS="5000"

RUN_ID="$(date +%s)-$$-${RANDOM}"
THREAD_ID="e2e-stateless-suspend-wake-${RUN_ID}"

# --- Cleanup trap: restore HCC cadences, undo cluster mutations ------
HCC_ENV_SAVED=""
CREATED_CHANNEL=""
DESKTOP_PATCH_APPLIED=0
CONTEXT_PATCH_APPLIED=0
SECRET_ROTATED=0
SECRET_NAME=""
SECRET_DATA_BACKUP=""
RPC_PROXY_REPLICAS_SAVED=""
BATCH_POD_APPLIED=0
CORDONED_NODE=""
STATELESS_DISABLED=0

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
  if [ "$CONTEXT_PATCH_APPLIED" = "1" ]; then restore_context_mcpserver; fi
  if [ "$SECRET_ROTATED" = "1" ] && [ -n "$SECRET_NAME" ] && [ -n "$SECRET_DATA_BACKUP" ]; then
    kctl patch secret "$SECRET_NAME" -n "$MCP_HOST_NS" --type=merge \
      -p "{\"data\":${SECRET_DATA_BACKUP}}" >/dev/null 2>&1 || \
      warn "failed to restore rotated Secret ${SECRET_NAME} (manual check advised)"
  fi
  if [ -n "$RPC_PROXY_REPLICAS_SAVED" ]; then
    kctl scale "deployment/${RPC_PROXY_DEPLOY}" -n "$RPC_PROXY_NS" \
      --replicas="$RPC_PROXY_REPLICAS_SAVED" >/dev/null 2>&1 || \
      warn "failed to restore ${RPC_PROXY_DEPLOY} replicas to ${RPC_PROXY_REPLICAS_SAVED}"
  fi
  if [ -n "$CREATED_CHANNEL" ]; then
    kctl delete communicationchannel "$CREATED_CHANNEL" -n "${CHANNELS_NS:-channels}" \
      --ignore-not-found --wait=false >/dev/null 2>&1
  fi
  if [ "$DESKTOP_PATCH_APPLIED" = "1" ]; then
    kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=json \
      -p '[{"op":"remove","path":"/spec/desktop"}]' >/dev/null 2>&1
  fi
  if [ "$STATELESS_DISABLED" = "1" ]; then
    kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=merge \
      -p '{"spec":{"lifecycle":{"stateless":true}}}' >/dev/null 2>&1
  fi
  if [ "$BATCH_POD_APPLIED" = "1" ]; then
    kctl delete pod clerum-batch-filler -n "$MCP_HOST_NS" \
      --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
  fi
  if [ -n "$CORDONED_NODE" ]; then kctl uncordon "$CORDONED_NODE" >/dev/null 2>&1; fi
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

# --- Row observable (exactly-once marker): mirrors the durability exemplar
DB_PATH=""
ROW_TOOL=""
NODE_COUNT_SNIPPET='const D=require("better-sqlite3");const db=new D(process.env.DB,{readonly:true});db.pragma("busy_timeout=5000");const row=db.prepare(process.env.SQL).get();console.log(row?Object.values(row)[0]:0);'

current_ready_pod() { ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}"; }

wait_for_ready_pod() {
  local timeout=$1 exclude="${2:-}" elapsed=0 name
  while [ "$elapsed" -lt "$timeout" ]; do
    if name=$(current_ready_pod); then
      if [ -z "$exclude" ] || [ "$name" != "$exclude" ]; then printf "%s\n" "$name"; return 0; fi
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

resolve_row_tool() {
  local pod dbdir
  pod=$(current_ready_pod) || { echo "no ready pod to resolve state.db" >&2; return 1; }
  dbdir=$(kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'printf "%s" "${CLERUM_SESSION_DB_DIR:-}"' 2>/dev/null || true)
  [ -n "$dbdir" ] || { echo "CLERUM_SESSION_DB_DIR not set on pod ${pod}" >&2; return 1; }
  DB_PATH="${dbdir%/}/state.db"
  if kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'command -v sqlite3' >/dev/null 2>&1; then
    ROW_TOOL="sqlite3-cli"
  elif kctl exec "$pod" -n "$MCP_HOST_NS" -- node -e 'require.resolve("better-sqlite3")' >/dev/null 2>&1; then
    # Resolve via Node from the container WORKDIR — image-layout-agnostic
    # (works for /app/node_modules and /app/mcp-host/node_modules alike).
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

# --- RPC helpers (Desktop App auth path) ----------------------------
SESSION_TOKEN=""; RPC_TOKEN=""
RPC_SCOPES_JSON='["host:message:invoke","host:approval:write","host:session:read","host:status:read","host:health:read","host:wake:write"]'
RPC_HOSTREFS_JSON=""

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
  local resp code body hostrefs
  hostrefs="${RPC_HOSTREFS_JSON:-$(jq -cn --arg h "$HOST_REF" '[$h]')}"
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/rpc/token" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" -H 'Content-Type: application/json' \
    -d "$(jq -cn --argjson h "$hostrefs" --argjson s "$RPC_SCOPES_JSON" '{hostRefs:$h,scopes:$s}')") || {
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
# documented 503 {code:"host_waking"} while rpc-proxy's wake-and-hold settles.
send_turn_expect_ok() {
  local content=$1 deadline=$((SECONDS + WAKE_HOLD_DEADLINE)) attempt=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    attempt=$((attempt + 1))
    send_turn "$content" || return 1
    if [ "$TURN_STATUS" = "200" ]; then return 0; fi
    if [ "$TURN_STATUS" = "503" ] && echo "$TURN_BODY" | grep -q 'host_waking'; then
      log "attempt ${attempt}: host_waking (retryable) -- re-issuing within wake-hold deadline"
      sleep 3; continue
    fi
    echo "turn returned non-retryable HTTP ${TURN_STATUS}: ${TURN_BODY}" >&2; return 1
  done
  echo "wake-and-hold deadline (${WAKE_HOLD_DEADLINE}s) exceeded; last status=${TURN_STATUS} body=${TURN_BODY}" >&2
  return 1
}

rpc_auth_header() {
  printf '%s: %s %s' "Authorization" "Bearer" "$RPC_TOKEN"
}

ASYNC_STATUS=""; ASYNC_BODY=""
send_async_turn() {
  local content=$1 payload resp
  mint_rpc_token || return 1
  payload="$(jq -cn --arg c "$content" --arg t "$THREAD_ID" '{content:$c,threadId:$t}')"
  resp=$(curl -sS -m "$E2E_TURN_TIMEOUT" -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages?async=true" \
    -H "$(rpc_auth_header)" -H 'Content-Type: application/json' \
    -d "$payload") || { echo "async message POST failed at ${RPC_BASE}" >&2; return 1; }
  ASYNC_STATUS="$(echo "$resp" | tail -n1)"; ASYNC_BODY="$(echo "$resp" | sed '$d')"
}

wait_for_async_result_ok() {
  local task_id=$1 label=$2 deadline=$((SECONDS + DEDUP_RESULT_TIMEOUT)) resp code body status success
  while [ "$SECONDS" -lt "$deadline" ]; do
    mint_rpc_token || return 1
    resp=$(curl -sS -m 30 -w '\n%{http_code}' \
      "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/tasks/${task_id}/result" \
      -H "$(rpc_auth_header)") || {
      echo "${label}: task result poll failed at ${RPC_BASE}" >&2
      return 1
    }
    code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
    if [ "$code" = "200" ]; then
      status="$(echo "$body" | jq -r '.status // empty' 2>/dev/null || true)"
      success="$(echo "$body" | jq -r '.success // empty' 2>/dev/null || true)"
      if [ "$status" = "completed" ] && [ "$success" = "true" ]; then return 0; fi
      if [ "$status" = "failed" ] || [ "$success" = "false" ] || [ "$status" = "waiting_approval" ]; then
        echo "${label}: terminal non-success task result: ${body}" >&2
        return 1
      fi
    elif [ "$code" = "503" ] && echo "$body" | grep -q 'host_waking'; then
      :
    elif [ "$code" = "404" ]; then
      :
    else
      echo "${label}: task result returned non-retryable HTTP ${code}: ${body}" >&2
      return 1
    fi
    sleep 3
  done
  echo "${label}: task result did not complete within ${DEDUP_RESULT_TIMEOUT}s" >&2
  return 1
}

assert_success_response() {
  local label=$1
  if [ "$TURN_STATUS" = "200" ] && echo "$TURN_BODY" | jq -e '.success == true' >/dev/null 2>&1; then
    ok "${label}: 200 {success:true}"; return 0
  fi
  fail "${label}: expected 200 {success:true}, got HTTP ${TURN_STATUS} body=${TURN_BODY}"; return 1
}

# --- Wake helper ----------------------------------------------------

# The wake route is a user-facing rpc-proxy endpoint. rpc-proxy owns
# service-to-service auth to control-api; the E2E runner only carries the
# same per-user RPC value that Desktop sends.
WAKE_STATUS=""; WAKE_BODY=""
post_wake() {
  local auth resp
  if [ "$#" -gt 0 ]; then
    auth="$1"
  else
    mint_rpc_token || return 1
    auth="$RPC_TOKEN"
  fi
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/wake" \
    -H "Authorization: Bearer ${auth}" -H 'Content-Type: application/json') || {
    echo "wake POST failed at ${RPC_BASE}" >&2; return 1; }
  WAKE_STATUS="$(echo "$resp" | tail -n1)"; WAKE_BODY="$(echo "$resp" | sed '$d')"
  case "$WAKE_STATUS" in
    200|202|204) ;;
    *) echo "wake POST returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}" >&2; return 1 ;;
  esac
}

# --- Lifecycle observables ------------------------------------------
lifecycle_state()  { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true; }
lifecycle_reason() { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.reason}' 2>/dev/null || true; }
wake_handled_generation() { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.wakeHandledGeneration}' 2>/dev/null || true; }
wake_requested_annotation() { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath="{.metadata.annotations.clerum\\.io/wake-requested}" 2>/dev/null || true; }
deployment_replicas() { kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo ""; }

# A stateless effective lifecycle is more than replicas=1: it changes the
# pod template. Assert both shapes so a stale Host watch event cannot leave a
# legacy stateful Deployment behind while status says stateless is enabled.
deployment_has_stateless_template() {
  local deployment
  deployment="$(kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o json 2>/dev/null)" || return 2
  printf '%s' "$deployment" | jq -e '
    .spec.template.spec as $pod
    | [
        ($pod.priorityClassName == "clerum-interactive-host"),
        ([ $pod.initContainers[]? | select(.name == "workspace-layout-init") ] | length == 1),
        ([ $pod.containers[] | select(.name == "mcp-host") | .env[]? | select(.name == "CLERUM_STATELESS_LIFECYCLE" and .value == "true") ] | length == 1),
        ([ $pod.containers[] | select(.name == "mcp-host") | .volumeMounts[]? | select(.name == "workspace" and .mountPath == "/workspace" and .subPath == "workspace") ] | length == 1),
        ([ $pod.containers[] | select(.name == "mcp-host") | .volumeMounts[]? | select(.name == "workspace" and .mountPath == "/var/lib/clerum/state" and .subPath == "state") ] | length == 1)
      ] | all
  ' >/dev/null
}

# A STATEFUL effective template is discriminated ONLY by the effective-mode
# markers: no interactive priority class and no CLERUM_STATELESS_LIFECYCLE env.
# The requested stateless STORAGE layout (workspace-layout-init init container +
# the /var/lib/clerum/state and /workspace subPath mounts) is durable-
# compatibility state that a HARD REJECTION deliberately RETAINS — exactly like
# a spec.desktop/SFS rejection (buildDeployment gates the storage layout on the
# spec REQUEST `usesStatelessStorageLayout`, never on effective mode, so a
# rejection never remounts the PVC root and creates a second state.db). So the
# storage layout must NOT be part of the stateful discriminator: this helper
# must pass for a genuinely-stateful host (no layout) AND a channel/desktop hard-
# rejected stateless-requesting host (layout retained). See Addendum 6.
deployment_has_stateful_template() {
  local deployment
  deployment="$(kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o json 2>/dev/null)" || return 2
  printf '%s' "$deployment" | jq -e '
    .spec.template.spec as $pod
    | [
        ($pod.priorityClassName != "clerum-interactive-host"),
        ([ $pod.containers[] | select(.name == "mcp-host") | .env[]? | select(.name == "CLERUM_STATELESS_LIFECYCLE") ] | length == 0)
      ] | all
  ' >/dev/null
}

wait_for_deployment_template() {
  local expected="$1" timeout="$2" label="$3" elapsed=0
  local check="deployment_has_${expected}_template"
  while [ "$elapsed" -lt "$timeout" ]; do
    if "$check"; then
      ok "${label}: Deployment converged to ${expected} pod template"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "${label}: Deployment did not converge to ${expected} pod template within ${timeout}s (replicas=$(deployment_replicas) state=$(lifecycle_state) reason=$(lifecycle_reason))"
  pod_diagnostics
  return 1
}

scale_transition_count() {
  # HIGH-4: distinguish "0 matches" (a legit count) from "log read FAILED".
  # A bare `grep -c ... || true` masks a kubectl error (RBAC, truncation, pod
  # churn) as delta=0, letting a real regression pass. Capture the logs first,
  # hard-fail loudly if the kubectl invocation itself errored, THEN grep -c
  # (grep exit 1 = zero matches, which is a valid count, not a failure).
  local logs
  if ! logs="$(kctl logs "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --tail=-1 2>/dev/null)"; then
    echo "scale_transition_count: kubectl logs for deployment/${HCC_DEPLOY} in ${HCC_NS} FAILED (RBAC/pod-churn/truncation) -- refusing to report a masked 0" >&2
    return 1
  fi
  # grep -c exits 1 on zero matches; under `set -o pipefail` that would abort
  # the caller's command substitution even though 0 is a legit count (the
  # kubectl read already succeeded above). Count in awk (always exits 0).
  printf '%s\n' "$logs" \
    | awk -v re='\\[StatelessMetric\\] scale_transition host='"${HOST_REF}"' ' '$0 ~ re {c++} END {print c+0}'
}

hcc_log_has() {
  local needle=$1 needle2="${2:-}" logs
  if ! logs="$(kctl logs -n "$HCC_NS" -l "app=${HCC_DEPLOY}" --all-containers=true --tail=-1 --prefix 2>/dev/null)"; then
    echo "hcc_log_has: kubectl logs for app=${HCC_DEPLOY} in ${HCC_NS} FAILED (RBAC/pod-churn/truncation) -- refusing to report a masked missing log" >&2
    return 2
  fi
  # Read by label instead of deployment/name because the cadence setup rolls
  # HCC; during that window Kubernetes may choose a terminating pod for
  # `kubectl logs deployment/...` while the phase log is in the new pod.
  # Use literal substring checks instead of escaped EREs: BSD awk does not
  # treat \[ as a portable literal bracket in the way grep -E does.
  printf '%s\n' "$logs" | awk -v a="$needle" -v b="$needle2" \
    'index($0, a) && (b == "" || index($0, b)) {found=1} END {exit found ? 0 : 1}'
}

wait_for_hcc_log() {
  local timeout=$1 needle=$2 needle2="${3:-}" elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if hcc_log_has "$needle" "$needle2"; then return 0; fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  return 1
}

dump_hcc_phase_logs() {
  kctl logs -n "$HCC_NS" -l "app=${HCC_DEPLOY}" --all-containers=true --tail=240 --prefix 2>/dev/null \
    | awk '/StatelessSuspend|StatelessWake|Wake fast-path|Suspending stateless Host|Marked stateless Host/ {print}' >&2 || true
}

# HIGH-3/M5: count wake receipts that reached control-api for this host. Like
# scale_transition_count, this distinguishes a real read failure from a zero
# count so a masked 0 can never pass the dedup assertion.
control_api_wake_receipt_count() {
  local logs
  if ! logs="$(kctl logs "deployment/${CONTROL_API_DEPLOY}" -n "$CONTROL_NS" --tail=-1 2>/dev/null)"; then
    echo "control_api_wake_receipt_count: kubectl logs for deployment/${CONTROL_API_DEPLOY} in ${CONTROL_NS} FAILED -- refusing to report a masked 0" >&2
    return 1
  fi
  # Count receipts for THIS host. grep exit 1 (zero matches) is a legit 0 here
  # (the kubectl read already succeeded above), so it must not abort under
  # pipefail -- do the count in awk, which always exits 0.
  printf '%s\n' "$logs" \
    | awk -v h="\"hostRef\":\"${HOST_REF}\"" '/host wake requested/ && index($0, h) {c++} END {print c+0}'
}

wait_for_state() {
  local expected=$1 timeout=$2 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    [ "$(lifecycle_state)" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_not_suspended() {
  local timeout=$1 elapsed=0 st
  while [ "$elapsed" -lt "$timeout" ]; do
    st="$(lifecycle_state)"
    if [ -n "$st" ] && [ "$st" != "suspended" ]; then return 0; fi
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
  header "Forcing idle -> suspend (window ${SUSPEND_WINDOW}s)"
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
  header "Setting HCC test cadences (idle-immediate, drain=${TEST_DRAIN_GRACE_MS}ms, poll=${TEST_POLL_MS}ms)"
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
    fail "failed to set HCC test cadences via kubectl set env"; return 1; }
  if kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1; then
    ok "HCC test cadences applied and rolled out"
  else
    fail "HCC rollout did not settle after cadence set"; pod_diagnostics; return 1
  fi
}

# --- Context / MCP server helpers (test 12) -------------------------
CONTEXT_REF=""; DISABLED_MCP_SERVER=""; CONTEXT_MCPSERVERS_BACKUP=""
restore_context_mcpserver() {
  [ -n "$CONTEXT_REF" ] && [ -n "$CONTEXT_MCPSERVERS_BACKUP" ] || return 0
  kctl patch context "$CONTEXT_REF" -n "$CONTEXT_NS" --type=merge \
    -p "{\"spec\":{\"mcpServers\":${CONTEXT_MCPSERVERS_BACKUP}}}" >/dev/null 2>&1 || \
    warn "failed to restore Context ${CONTEXT_REF} mcpServers in namespace ${CONTEXT_NS}"
}

# ====================================================================== #
#  Prerequisites
# ====================================================================== #
header "Prerequisites"
for bin in jq curl; do
  command -v "$bin" >/dev/null 2>&1 || { fail "required tool '${bin}' not installed"; print_results; exit 1; }
done

stateless_flag=$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")
if [ "$stateless_flag" = "true" ]; then
  ok "Host '${HOST_REF}' exists with spec.lifecycle.stateless=true"
else
  fail "Host '${HOST_REF}' missing or spec.lifecycle.stateless != true (got '${stateless_flag:-<absent>}'). Seed: bash scripts/e2e/seed-stateless-host.sh"
  print_results; exit 1
fi

CONTEXT_REF=$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.contextRef}' 2>/dev/null || echo "")
[ -n "$CONTEXT_REF" ] && ok "resolved contextRef=${CONTEXT_REF}" || warn "no contextRef on host (test 12 will hard-fail if reached)"

# MEDIUM-8: the Ready-pod gate is deferred until AFTER tokens are minted so a
# prior run that left the host suspended (replicas 0) can be woken first
# instead of being reported as a false infra failure. See the wake-if-suspended
# step below.

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
  ok "user RPC token minted (requested host:wake:write and host:approval:write among scopes)"
else
  fail "cannot mint RPC token for hostRef=${HOST_REF} with host:wake:write and host:approval:write -- is ${DEV_EMAIL} associated to the stateless host?"; print_results; exit 1
fi

# MEDIUM-8: if a prior run left the host suspended (replicas 0, no Ready pod),
# that is idempotent re-runnable state, NOT an infra failure. Wake it via the
# rpc-proxy wake endpoint (same path Desktop uses) and wait
# bounded for a Ready pod. Fail loud only if the wake does not produce one.
prereq_state="$(lifecycle_state)"
if [ "$prereq_state" = "suspended" ]; then
  warn "host is suspended from a prior run -- issuing a wake to make the suite idempotently re-runnable"
  if ! post_wake; then
    fail "prereq wake POST failed at ${RPC_BASE} for suspended host ${HOST_REF}"; print_results; exit 1
  fi
  case "$WAKE_STATUS" in
    200|202) ok "prereq wake accepted (HTTP ${WAKE_STATUS}) for suspended host" ;;
    *) fail "prereq wake returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}"; print_results; exit 1 ;;
  esac
  if wait_for_not_suspended "$POD_READY_TIMEOUT"; then
    ok "prereq wake moved lifecycle out of suspended state (state=$(lifecycle_state))"
  else
    fail "prereq wake did not move lifecycle out of suspended state within ${POD_READY_TIMEOUT}s (state=$(lifecycle_state), wakeHandled=$(wake_handled_generation), wakeRequested=$(wake_requested_annotation))"
    print_results; exit 1
  fi
fi
if pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT"); then
  ok "stateless host pod Ready (host image present on node): ${pod}"
else
  fail "no Ready pod for app=${HOST_REF} in ${MCP_HOST_NS} after ${POD_READY_TIMEOUT}s (prereq_state=${prereq_state}; wake did not produce a Ready pod)"
  pod_diagnostics; print_results; exit 1
fi
wait_for_deployment_template stateless "$POD_READY_TIMEOUT" "prerequisite" || { print_results; exit 1; }

if resolve_row_tool; then
  ok "row observable ready (tool=${ROW_TOOL} db=${DB_PATH})"
else
  fail "cannot resolve state.db row observable -- no CLERUM_SESSION_DB_DIR or reader in pod"; print_results; exit 1
fi

save_and_set_hcc_cadences || { print_results; exit 1; }

# ====================================================================== #
#  Test 1 -- POSITIVE CONTROL: idle host suspends within a bounded window
# ====================================================================== #
header "Test 1 -- idle host suspends (positive control)"
if send_turn_expect_ok "Reply with exactly: SUSPEND_BASELINE_${RUN_ID}"; then
  assert_success_response "baseline turn" || { print_results; exit 1; }
else
  fail "baseline turn did not reach 200"; pod_diagnostics; print_results; exit 1
fi
force_idle_and_suspend || { print_results; exit 1; }
if wait_for_hcc_log 60 "[StatelessSuspend] host=${HOST_REF} phase=suspended_applied"; then
  ok "HCC logged phase=suspended_applied for ${HOST_REF}"
else
  dump_hcc_phase_logs
  fail "missing [StatelessSuspend] phase=suspended_applied log for ${HOST_REF}"; print_results; exit 1
fi
# M4/MEDIUM-6: phase=suspended_applied is reached by drain / kill-switch /
# forced-scale too, so it does NOT prove the idle floor caused THIS suspend.
# Assert the lifecycle reason is exactly the idle-gate sentinel
# (LIFECYCLE_REASON_SUSPENDED_IDLE = 'idle' in host-context-controller
# constants.ts) so the positive control is causally tied to idle expiry.
suspend_reason="$(lifecycle_reason)"
if [ "$suspend_reason" = "idle" ]; then
  ok "suspend reason is exactly 'idle' (idle-floor expiry caused this suspend, not drain/kill-switch)"
else
  fail "expected suspend reason 'idle' proving idle-floor causality, got '${suspend_reason:-<empty>}'"; print_results; exit 1
fi

# ====================================================================== #
#  Test 2 -- FIVE suspend-refusal sub-cases
# ====================================================================== #
header "Test 2 -- suspend-refusal sub-cases"
post_wake || { fail "wake POST failed while resurrecting host for refusal cases"; print_results; exit 1; }
if wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null; then
  ok "host resurrected (pod Ready) for refusal cases"
else
  fail "host did not come back Ready after wake"; pod_diagnostics; print_results; exit 1
fi

assert_refusal() {
  local case_label="$1"
  local want_condition="$2"
  local want_reason="SuspendBlocked: ${want_condition}"
  local elapsed=0 saw_reason=0 held_replicas=1 cycles=0 reason reps
  local deadline=$(( REFUSAL_HOLD_CYCLES * (TEST_POLL_MS/1000) + 90 ))
  while [ "$elapsed" -lt "$deadline" ]; do
    reason="$(lifecycle_reason)"; reps="$(deployment_replicas)"
    if [ "$reason" = "$want_reason" ]; then
      saw_reason=1; cycles=$((cycles + 1))
      [ "${reps:-1}" != "1" ] && held_replicas=0
      [ "$cycles" -ge "$REFUSAL_HOLD_CYCLES" ] && break
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  if [ "$saw_reason" = "1" ] && [ "$held_replicas" = "1" ]; then
    ok "${case_label}: reason='${want_reason}' held with replicas=1 over ${cycles} cycle(s)"; return 0
  fi
  fail "${case_label}: expected reason '${want_reason}' with replicas 1 (saw_reason=${saw_reason} held_replicas=${held_replicas} last_reason='$(lifecycle_reason)' replicas=$(deployment_replicas))"
  pod_diagnostics; return 1
}

# (a) active task
header "Test 2a -- active task blocks suspend"
A_POD="$(current_ready_pod)" || { fail "2a: no ready pod for deterministic activeTask heartbeat"; print_results; exit 1; }
A_POD_UID="$(kctl get pod "$A_POD" -n "$MCP_HOST_NS" -o jsonpath="{.metadata.uid}" 2>/dev/null || true)"
[ -n "$A_POD_UID" ] || { fail "2a: could not resolve pod UID for ${A_POD}"; print_results; exit 1; }
A_SQL_CONDITIONS="{\"activeTask\":true,\"awaitingApproval\":false,\"pendingResults\":false}"
(
  while true; do
    kctl -n control-plane exec deployment/control-postgres -- psql -U postgres -d profiles -v ON_ERROR_STOP=1 -c "INSERT INTO host_heartbeats (host_ref, pod_uid, active_work, conditions, last_activity_ts, state, received_at) VALUES (\$\$${HOST_REF}\$\$, \$\$${A_POD_UID}\$\$, true, \$\$${A_SQL_CONDITIONS}\$\$::jsonb, 0, \$\$active\$\$, NOW()) ON CONFLICT (host_ref) DO UPDATE SET pod_uid=EXCLUDED.pod_uid, active_work=EXCLUDED.active_work, conditions=EXCLUDED.conditions, last_activity_ts=EXCLUDED.last_activity_ts, state=EXCLUDED.state, received_at=NOW();" >/dev/null 2>&1 || true
    sleep 2
  done
) &
A_PIN=$!
if assert_refusal "2a active task" "activeTask"; then
  kill "$A_PIN" 2>/dev/null || true
  wait "$A_PIN" 2>/dev/null || true
else
  kill "$A_PIN" 2>/dev/null || true
  wait "$A_PIN" 2>/dev/null || true
  print_results; exit 1
fi
A_SQL_CONDITIONS="{\"activeTask\":false,\"awaitingApproval\":false,\"pendingResults\":false}"
kctl -n control-plane exec deployment/control-postgres -- psql -U postgres -d profiles -v ON_ERROR_STOP=1 -c "INSERT INTO host_heartbeats (host_ref, pod_uid, active_work, conditions, last_activity_ts, state, received_at) VALUES (\$\$${HOST_REF}\$\$, \$\$${A_POD_UID}\$\$, false, \$\$${A_SQL_CONDITIONS}\$\$::jsonb, 0, \$\$active\$\$, NOW()) ON CONFLICT (host_ref) DO UPDATE SET pod_uid=EXCLUDED.pod_uid, active_work=EXCLUDED.active_work, conditions=EXCLUDED.conditions, last_activity_ts=EXCLUDED.last_activity_ts, state=EXCLUDED.state, received_at=NOW();" >/dev/null || { fail "2a: failed to clear activeTask heartbeat"; print_results; exit 1; }
if force_idle_and_suspend; then ok "2a: suspends after the active task drains (causality proven)"; else print_results; exit 1; fi
post_wake || { fail "wake POST failed resurrecting for 2b"; print_results; exit 1; }
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "no pod after wake for 2b"; print_results; exit 1; }

# (b) AwaitingApproval
header "Test 2b -- AwaitingApproval blocks suspend"
if kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o json 2>/dev/null \
    | jq -e '(.spec.approval // {}) | (.mode=="always" or ((.tools // []) | length > 0))' >/dev/null 2>&1 \
   || kctl get context "$CONTEXT_REF" -n "$CONTEXT_NS" -o json 2>/dev/null \
    | jq -e '[.spec.mcpServers[]? | select((.approval // {}) | (.mode=="always" or ((.tools // [])|length>0)))] | length > 0' >/dev/null 2>&1; then
  b_pod="$(current_ready_pod)" || { fail "2b: no ready pod for deterministic awaitingApproval heartbeat"; print_results; exit 1; }
  B_POD_UID="$(kctl get pod "$b_pod" -n "$MCP_HOST_NS" -o jsonpath="{.metadata.uid}" 2>/dev/null || true)"
  [ -n "$B_POD_UID" ] || { fail "2b: could not resolve pod UID for ${b_pod}"; print_results; exit 1; }
  B_SQL_CONDITIONS="{\"activeTask\":false,\"awaitingApproval\":true,\"pendingResults\":false}"
  kctl -n control-plane exec deployment/control-postgres -- psql -U postgres -d profiles -v ON_ERROR_STOP=1 -c "INSERT INTO host_heartbeats (host_ref, pod_uid, active_work, conditions, last_activity_ts, state, received_at) VALUES (\$\$${HOST_REF}\$\$, \$\$${B_POD_UID}\$\$, false, \$\$${B_SQL_CONDITIONS}\$\$::jsonb, 0, \$\$active\$\$, NOW()) ON CONFLICT (host_ref) DO UPDATE SET pod_uid=EXCLUDED.pod_uid, active_work=EXCLUDED.active_work, conditions=EXCLUDED.conditions, last_activity_ts=EXCLUDED.last_activity_ts, state=EXCLUDED.state, received_at=NOW();" >/dev/null || { fail "2b: failed to upsert awaitingApproval heartbeat"; print_results; exit 1; }
  if assert_refusal "2b AwaitingApproval" "awaitingApproval"; then
    ok "2b: awaiting-approval heartbeat blocks suspend"
  else
    print_results; exit 1
  fi
  B_SQL_CONDITIONS="{\"activeTask\":false,\"awaitingApproval\":false,\"pendingResults\":false}"
  kctl -n control-plane exec deployment/control-postgres -- psql -U postgres -d profiles -v ON_ERROR_STOP=1 -c "INSERT INTO host_heartbeats (host_ref, pod_uid, active_work, conditions, last_activity_ts, state, received_at) VALUES (\$\$${HOST_REF}\$\$, \$\$${B_POD_UID}\$\$, false, \$\$${B_SQL_CONDITIONS}\$\$::jsonb, 0, \$\$active\$\$, NOW()) ON CONFLICT (host_ref) DO UPDATE SET pod_uid=EXCLUDED.pod_uid, active_work=EXCLUDED.active_work, conditions=EXCLUDED.conditions, last_activity_ts=EXCLUDED.last_activity_ts, state=EXCLUDED.state, received_at=NOW();" >/dev/null || { fail "2b: failed to clear awaitingApproval heartbeat"; print_results; exit 1; }
  if force_idle_and_suspend; then ok "2b: suspends after awaitingApproval heartbeat clears"; else print_results; exit 1; fi
  post_wake || { fail "wake POST failed resurrecting for 2c"; print_results; exit 1; }
  wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "no pod after wake for 2c"; print_results; exit 1; }
else
  fail "2b: no approval-requiring tool configured on Host '${HOST_REF}' or Context '${CONTEXT_REF}' (checked spec.approval and context mcpServers approval). Cannot induce AwaitingApproval -- seed an approval-gated tool (e.g. shell_exec)."
  print_results; exit 1
fi

# (c) pending results
header "Test 2c -- pending results block suspend"
C_MARKER="refusal-c-${RUN_ID}"
mint_rpc_token || true
c_payload="$(jq -cn --arg c "Reply exactly marker ${C_MARKER} in plain text. Do not call tools." --arg t "$THREAD_ID" "{content:\$c,threadId:\$t}")"
c_resp="$(curl -sS -m "$E2E_TURN_TIMEOUT" -w "\n%{http_code}" -X POST "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages?async=true" \
  -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json' -d "$c_payload")" || {
  fail "2c: async message POST failed at ${RPC_BASE}"
  print_results
  exit 1
}
c_status="$(echo "$c_resp" | tail -n1)"
c_body="$(echo "$c_resp" | sed -e "\$d")"
C_TASK_ID="$(echo "$c_body" | jq -r ".taskId // empty" 2>/dev/null || true)"
if [ "$c_status" != "200" ] || [ -z "$C_TASK_ID" ]; then
  fail "2c: async message did not return taskId; status=${c_status} body=$(printf '%s' "$c_body" | head -c 300)"
  print_results
  exit 1
fi
if assert_refusal "2c pendingResults" "pendingResults"; then
  ok "2c: parked async result blocks suspend"
  mint_rpc_token || true
  curl -sS -m 30 "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/tasks/${C_TASK_ID}/result" -H "Authorization: Bearer ${RPC_TOKEN}" >/dev/null 2>&1 || true
  if force_idle_and_suspend; then ok "2c: suspends after pending result is drained"; else print_results; exit 1; fi
else
  fail "2c: could not induce pendingResults (see mcp-host resultStore/pendingTaskResults flow -- the async intake did not park a result)"
  print_results; exit 1
fi
post_wake || { fail "wake POST failed resurrecting for 2d"; print_results; exit 1; }
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "no pod after wake for 2d"; print_results; exit 1; }

# (d-pre) REVERSE arrival order: a genuinely stateful Host that ALREADY has a
# CommunicationChannel, then flipped to spec.lifecycle.stateless:true, must
# hard-reject from the FIRST stateless-requesting reconcile -- the requested
# stateless lifecycle must NEVER be transiently enabled. Direct CRD writes are
# used deliberately: control-api blocks this flip at the admin API with a 409
# (stateless_host_communication_channel_conflict), so the state-derived HCC
# backstop is exactly the racing/direct-write path under test. Uses the shared
# $HOST_REF sequentially (the suite's established pattern; test 11 also flips
# spec.lifecycle.stateless on it) and restores it via the cleanup trap.
header "Test 2d-pre -- reverse arrival: channel-bound host flipped to stateless hard-rejects"
# 1. Make the Host genuinely stateful (direct CRD).
kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=merge \
  -p '{"spec":{"lifecycle":{"stateless":false}}}' >/dev/null 2>&1 \
  || { fail "2d-pre: failed to flip spec.lifecycle.stateless:false"; print_results; exit 1; }
STATELESS_DISABLED=1
wait_for_deployment_template stateful 120 "2d-pre: baseline genuinely stateful" || { print_results; exit 1; }
# 2. Associate a CommunicationChannel with the stateful Host (direct CRD).
CREATED_CHANNEL="e2e-stateless-prekillswitch-${RUN_ID}"
printf '%s\n' \
"apiVersion: clerum.io/v1alpha1" \
"kind: CommunicationChannel" \
"metadata:" \
"  name: ${CREATED_CHANNEL}" \
"  namespace: ${CHANNELS_NS:-channels}" \
"spec:" \
"  hostRef: ${HOST_REF}" \
"  telegram:" \
"    - channelId: \"e2e-prekillswitch-${RUN_ID}\"" \
"      chatType: \"private\"" \
"      userIds: [\"000000000\"]" \
  | kctl apply -f - >/dev/null 2>&1 || { fail "2d-pre: failed to apply CommunicationChannel"; print_results; exit 1; }
# Deterministic barrier: wait until HCC has OBSERVED the channel (it provisions
# channel-reader-<host> from the same watcher cache that countCommunicationChannels
# reads), so the channel is in cache BEFORE the stateless flip -- the first
# stateless reconcile cannot momentarily see zero channels and enable stateless.
cr_elapsed=0; cr_ok=0
while [ "$cr_elapsed" -lt 120 ]; do
  if kctl get deployment "channel-reader-${HOST_REF}" -n "${CHANNELS_NS:-channels}" >/dev/null 2>&1; then cr_ok=1; break; fi
  sleep "$POLL_INTERVAL"; cr_elapsed=$((cr_elapsed + POLL_INTERVAL))
done
[ "$cr_ok" = "1" ] || { fail "2d-pre: HCC did not provision channel-reader-${HOST_REF} within 120s (cannot prove the channel is observed before the stateless flip)"; print_results; exit 1; }
# 3. Flip spec.lifecycle.stateless:true on the channel-bound Host (direct CRD).
kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=merge \
  -p '{"spec":{"lifecycle":{"stateless":true}}}' >/dev/null 2>&1 \
  || { fail "2d-pre: failed to flip spec.lifecycle.stateless:true"; print_results; exit 1; }
STATELESS_DISABLED=0
# 4. Assert hard rejection to stateful active with the channel-count reason. The
#    effective mode is stateful throughout (genuinely-stateful -> rejected-
#    stateful, never a transient stateless): replicas 1, StatelessEnableRejected=True.
dp_elapsed=0; dp_ok=0
while [ "$dp_elapsed" -lt 120 ]; do
  cond="$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.conditions[?(@.type=="StatelessEnableRejected")].status}' 2>/dev/null || true)"
  emode="$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.effectiveMode}' 2>/dev/null || true)"
  reps="$(deployment_replicas)"
  # effectiveMode is not part of this repo's HostLifecycleStatus (see types.ts
  # HostLifecycleStatus) — HCC never writes it here. The assertion auto-arms if
  # the field is ever published, and is skipped (not weakened) while it is
  # absent: every other conjunct below already proves the hard rejection.
  if [ "$cond" = "True" ] && { [ -z "$emode" ] || [ "$emode" = "stateful" ]; } && [ "${reps:-0}" = "1" ] && deployment_has_stateful_template; then dp_ok=1; break; fi
  sleep "$POLL_INTERVAL"; dp_elapsed=$((dp_elapsed + POLL_INTERVAL))
done
if [ "$dp_ok" != "1" ]; then
  fail "2d-pre: expected hard rejection to stateful after stateless flip on channel-bound host (cond=${cond:-<none>} effectiveMode=${emode:-<none>} state=$(lifecycle_state) replicas=$(deployment_replicas) reason=$(lifecycle_reason))"; print_results; exit 1
fi
# The durable rejection reason must name the channel count + recovery action
# (control-ui renders the StatelessEnableRejected message verbatim).
pre_reason="$(lifecycle_reason)"
case "$pre_reason" in
  *"CommunicationChannel(s) reference this Host"*disassociate*)
    ok "2d-pre: reverse-order flip hard-rejects to stateful with the channel-count reason (${pre_reason})" ;;
  *)
    fail "2d-pre: rejection reason missing channel-count/disassociate recovery text (got '${pre_reason}')"; print_results; exit 1 ;;
esac
# 5. Disassociate the channel (direct CRD) -> stateless activates and suspends.
kctl delete communicationchannel "$CREATED_CHANNEL" -n "${CHANNELS_NS:-channels}" --ignore-not-found >/dev/null 2>&1
CREATED_CHANNEL=""
if wait_for_deployment_template stateless "$POD_READY_TIMEOUT" "2d-pre: channel removed" \
  && wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null && force_idle_and_suspend; then
  ok "2d-pre: stateless activates and suspends after the channel is disassociated (state-derived recovery)"
else
  fail "2d-pre: stateless did not activate after channel disassociation (reverse-order recovery)"; print_results; exit 1
fi
post_wake || { fail "wake POST failed resurrecting for 2d"; print_results; exit 1; }
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "no pod after wake for 2d"; print_results; exit 1; }

# (d) channel post-enable -> kill-switch
header "Test 2d -- CommunicationChannel post-enable flips to always-on"
CREATED_CHANNEL="e2e-stateless-killswitch-${RUN_ID}"
printf '%s\n' \
"apiVersion: clerum.io/v1alpha1" \
"kind: CommunicationChannel" \
"metadata:" \
"  name: ${CREATED_CHANNEL}" \
"  namespace: ${CHANNELS_NS:-channels}" \
"spec:" \
"  hostRef: ${HOST_REF}" \
"  telegram:" \
"    - channelId: \"e2e-killswitch-${RUN_ID}\"" \
"      chatType: \"private\"" \
"      userIds: [\"000000000\"]" \
  | kctl apply -f - >/dev/null 2>&1 || { fail "2d: failed to apply CommunicationChannel"; print_results; exit 1; }
d_elapsed=0; d_ok=0
while [ "$d_elapsed" -lt 120 ]; do
  st="$(lifecycle_state)"; reps="$(deployment_replicas)"
  cond="$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.conditions[?(@.type=="StatelessEnableRejected")].status}' 2>/dev/null || true)"
  if { [ "$st" = "active" ] || [ "$cond" = "True" ]; } && [ "${reps:-0}" = "1" ]; then d_ok=1; break; fi
  sleep "$POLL_INTERVAL"; d_elapsed=$((d_elapsed + POLL_INTERVAL))
done
if [ "$d_ok" = "1" ]; then
  ok "2d: channel added => StatelessEnableRejected/active + replicas 1"
else
  fail "2d: expected kill-switch after channel add (state=$(lifecycle_state) replicas=$(deployment_replicas))"; print_results; exit 1
fi
wait_for_deployment_template stateful 120 "2d: channel added" || { print_results; exit 1; }
kctl delete communicationchannel "$CREATED_CHANNEL" -n "${CHANNELS_NS:-channels}" --ignore-not-found >/dev/null 2>&1
CREATED_CHANNEL=""
if wait_for_deployment_template stateless "$POD_READY_TIMEOUT" "2d: channel removed" \
  && wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null && force_idle_and_suspend; then
  ok "2d: stateless template resumes after channel removed (suspends again)"
else
  fail "2d: stateless did not resume after channel removed"; print_results; exit 1
fi
post_wake || { fail "wake POST failed resurrecting for 2e"; print_results; exit 1; }
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "no pod after wake for 2e"; print_results; exit 1; }

# (e) spec.desktop post-enable -> kill-switch
header "Test 2e -- spec.desktop post-enable flips to always-on"
DESKTOP_PATCH_APPLIED=1
kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=merge \
  -p '{"spec":{"desktop":{"browser":false,"x11":false}}}' >/dev/null 2>&1 || { fail "2e: failed to patch spec.desktop"; print_results; exit 1; }
e_elapsed=0; e_ok=0
while [ "$e_elapsed" -lt 120 ]; do
  st="$(lifecycle_state)"; reps="$(deployment_replicas)"
  cond="$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.conditions[?(@.type=="StatelessEnableRejected")].status}' 2>/dev/null || true)"
  if { [ "$st" = "active" ] || [ "$cond" = "True" ]; } && [ "${reps:-0}" = "1" ]; then e_ok=1; break; fi
  sleep "$POLL_INTERVAL"; e_elapsed=$((e_elapsed + POLL_INTERVAL))
done
if [ "$e_ok" = "1" ]; then
  ok "2e: spec.desktop present => StatelessEnableRejected/active + replicas 1"
else
  fail "2e: expected kill-switch after spec.desktop add (state=$(lifecycle_state) replicas=$(deployment_replicas))"; print_results; exit 1
fi
kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=json -p '[{"op":"remove","path":"/spec/desktop"}]' >/dev/null 2>&1
DESKTOP_PATCH_APPLIED=0
# M4/MEDIUM-6: close the causality loop like Test 2d does -- prove the
# kill-switch actually lifted by driving the host idle and re-suspending,
# not merely that a pod came back Ready.
if wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null && force_idle_and_suspend; then
  ok "2e: stateless resumes after spec.desktop removed (suspends again -- kill-switch lifted)"
else
  fail "2e: host did not resume + re-suspend after spec.desktop removed"; print_results; exit 1
fi

# ====================================================================== #
#  Test 3 -- Suspend -> WAKE full cycle
# ====================================================================== #
header "Test 3 -- suspend -> wake full cycle"
handled_before="$(wake_handled_generation)"
force_idle_and_suspend || { print_results; exit 1; }
MARKER3="wakecycle-${RUN_ID}"
if send_turn_expect_ok "Reply with exactly this token and nothing else: ${MARKER3}"; then
  assert_success_response "post-wake served turn" || { print_results; exit 1; }
else
  fail "message to suspended host was not served within wake-hold deadline"; pod_diagnostics; print_results; exit 1
fi
if new_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT"); then ok "replacement pod Ready after wake: ${new_pod}"; else
  fail "no Ready pod after wake"; pod_diagnostics; print_results; exit 1; fi
if resolve_row_tool && count=$(db_count "$(assistant_marker_sql "$MARKER3")") && [ "$count" = "1" ]; then
  ok "wake-served turn persisted EXACTLY once (assistant row count=1)"
else
  fail "expected exactly 1 assistant row for ${MARKER3}, got '${count:-query-failed}'"; print_results; exit 1
fi
for phase in wake_observed status_flipped replicas_patched; do
  if wait_for_hcc_log 60 "[StatelessWake] host=${HOST_REF} generation=" " phase=${phase}"; then
    ok "W-phase log present: phase=${phase}"
  else
    fail "missing [StatelessWake] phase=${phase} log for ${HOST_REF}"; print_results; exit 1
  fi
done
handled_after="$(wake_handled_generation)"
if [ -n "$handled_after" ] && [ "${handled_after:-0}" -gt "${handled_before:-0}" ] 2>/dev/null; then
  ok "wakeHandledGeneration advanced (${handled_before:-<none>} -> ${handled_after})"
else
  fail "wakeHandledGeneration did not advance (before=${handled_before:-<none>} after=${handled_after:-<none>})"; print_results; exit 1
fi

# ====================================================================== #
#  Test 4 -- CANCEL-DRAIN
# ====================================================================== #
header "Test 4 -- cancel-drain keeps the same pod"
post_wake || { fail "wake failed setting up test 4"; print_results; exit 1; }
draining_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || { fail "no pod for cancel-drain setup"; print_results; exit 1; }
uid_before="$(kctl get pod "$draining_pod" -n "$MCP_HOST_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
if wait_for_state "draining" "$DRAINING_WAIT"; then
  ok "host reached state=draining"
else
  fail "host never reached state=draining within ${DRAINING_WAIT}s (state=$(lifecycle_state)) -- emitter cadence 30s + drain grace may exceed window"; pod_diagnostics; print_results; exit 1
fi
MARKER4="canceldrain-${RUN_ID}"
if send_turn_expect_ok "Reply with exactly: ${MARKER4}"; then
  assert_success_response "cancel-drain turn" || { print_results; exit 1; }
else
  fail "message during draining was not served (cancel-drain)"; pod_diagnostics; print_results; exit 1
fi
cancel_elapsed=0
while [ "$cancel_elapsed" -lt "$DRAINING_WAIT" ]; do
  [ "$(lifecycle_state)" = "active" ] && break
  sleep "$POLL_INTERVAL"; cancel_elapsed=$((cancel_elapsed + POLL_INTERVAL))
done
uid_after="$(kctl get pod "$draining_pod" -n "$MCP_HOST_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
if [ -n "$uid_before" ] && [ "$uid_before" = "$uid_after" ] && [ "$(lifecycle_state)" = "active" ]; then
  ok "cancel-drain served WITHOUT pod restart (same UID ${uid_before}) and state=active"
else
  fail "cancel-drain restarted the pod or state not active (uid_before=${uid_before} uid_after=${uid_after} state=$(lifecycle_state))"; print_results; exit 1
fi

# ====================================================================== #
#  Test 5 -- Wake-generation idempotency
# ====================================================================== #
header "Test 5 -- wake-generation idempotency"
force_idle_and_suspend || { print_results; exit 1; }
ann_before="$(wake_requested_annotation)"
st_before="$(scale_transition_count)"
for _ in 1 2 3 4 5; do post_wake || true; done
sleep $(( (TEST_POLL_MS/1000) + 15 ))
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "host did not wake under rapid POSTs"; print_results; exit 1; }
st_after="$(scale_transition_count)"
delta=$(( st_after - st_before ))
ann_after="$(wake_requested_annotation)"
if [ "$delta" -eq 1 ]; then
  ok "exactly one [StatelessMetric] scale_transition for ${HOST_REF} (delta=${delta})"
else
  fail "expected exactly 1 scale_transition delta from rapid wakes, got ${delta} (before=${st_before} after=${st_after})"; print_results; exit 1
fi
if [ "$ann_before" != "$ann_after" ] && [ -n "$ann_after" ]; then
  ok "wake annotation advanced to a single generation (${ann_before:-<none>} -> ${ann_after})"
else
  warn "wake annotation unchanged (${ann_before:-<none>} -> ${ann_after:-<none>}) -- generation bump is authoritative in PG; scale-transition delta already proved single wake"
fi

# ====================================================================== #
#  Test 6 -- DEDUP
# ====================================================================== #
header "Test 6 -- concurrent-message dedup (one wake cycle)"
# HIGH-3/M5: scale_transition delta==1 is guaranteed by control-api's Postgres
# coalescing REGARDLESS of rpc-proxy's in-memory dedup -- so that assertion
# alone is vacuous w.r.t. the rpc-proxy dedup map under test. To make the
# rpc-proxy in-memory map authoritative, pin rpc-proxy to a single replica for
# this test (a second replica would each hold its own map and could each emit a
# wake), then assert exactly ONE wake receipt reached control-api for the burst
# (control_api_wake_receipt_count), which is what actually proves rpc-proxy
# coalesced the 5 concurrent messages into a single upstream wake call.
RPC_PROXY_REPLICAS_SAVED="$(kctl get deployment "$RPC_PROXY_DEPLOY" -n "$RPC_PROXY_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
[ -n "$RPC_PROXY_REPLICAS_SAVED" ] || { fail "test 6: cannot read ${RPC_PROXY_DEPLOY} replicas (needed to pin dedup map to a single instance)"; print_results; exit 1; }
kctl scale "deployment/${RPC_PROXY_DEPLOY}" -n "$RPC_PROXY_NS" --replicas=1 >/dev/null 2>&1 || { fail "test 6: failed to scale ${RPC_PROXY_DEPLOY} to replicas=1"; print_results; exit 1; }
kctl rollout status "deployment/${RPC_PROXY_DEPLOY}" -n "$RPC_PROXY_NS" --timeout=120s >/dev/null 2>&1 || { fail "test 6: ${RPC_PROXY_DEPLOY} did not settle at replicas=1"; print_results; exit 1; }
ok "test 6: pinned ${RPC_PROXY_DEPLOY} to replicas=1 so its in-memory dedup map is authoritative"
force_idle_and_suspend || { print_results; exit 1; }
st_before6="$(scale_transition_count)"
receipts_before6="$(control_api_wake_receipt_count)"
declare -a DEDUP_TASK_FILES=()
for i in 1 2 3 4 5; do
  tf="$(mktemp)"; DEDUP_TASK_FILES+=("$tf")
  (
    if send_async_turn "Reply with exactly: DEDUP_${i}_${RUN_ID}"; then
      task_id="$(echo "$ASYNC_BODY" | jq -r '.taskId // empty' 2>/dev/null || true)"
      if [ "$ASYNC_STATUS" = "200" ] && [ -n "$task_id" ]; then
        echo "$task_id" > "$tf"
      else
        printf 'FAIL status=%s body=%s\n' "$ASYNC_STATUS" "$(printf '%s' "$ASYNC_BODY" | head -c 300)" > "$tf"
      fi
    else
      echo "FAIL async-send" > "$tf"
    fi
  ) &
done
wait
all_served=1
declare -a DEDUP_TASK_IDS=()
for tf in "${DEDUP_TASK_FILES[@]}"; do
  task_id="$(cat "$tf" 2>/dev/null || echo MISSING)"; rm -f "$tf"
  if [[ "$task_id" == FAIL* ]] || [ "$task_id" = "MISSING" ] || [ -z "$task_id" ]; then
    echo "test 6: async intake failed: ${task_id}" >&2
    all_served=0
  else
    DEDUP_TASK_IDS+=("$task_id")
  fi
done
for task_id in "${DEDUP_TASK_IDS[@]}"; do
  if ! wait_for_async_result_ok "$task_id" "test 6 task ${task_id}"; then
    all_served=0
  fi
done
st_after6="$(scale_transition_count)"
delta6=$(( st_after6 - st_before6 ))
receipts_after6="$(control_api_wake_receipt_count)"
receipts_delta6=$(( receipts_after6 - receipts_before6 ))
# Restore rpc-proxy replicas immediately (also covered by the trap).
kctl scale "deployment/${RPC_PROXY_DEPLOY}" -n "$RPC_PROXY_NS" --replicas="$RPC_PROXY_REPLICAS_SAVED" >/dev/null 2>&1 || \
  warn "test 6: failed to restore ${RPC_PROXY_DEPLOY} replicas to ${RPC_PROXY_REPLICAS_SAVED} (trap will retry)"
RPC_PROXY_REPLICAS_SAVED=""
if [ "$all_served" = "1" ]; then ok "all 5 concurrent messages eventually served (200)"; else
  fail "not all concurrent messages reached 200"; print_results; exit 1; fi
if [ "$delta6" -eq 1 ]; then
  ok "exactly ONE wake cycle for 5 concurrent messages (scale_transition delta=1)"
else
  fail "expected exactly 1 wake cycle for concurrent burst, got scale_transition delta=${delta6}"; print_results; exit 1
fi
# The load-bearing assertion for rpc-proxy dedup: exactly one wake receipt
# reached control-api for the burst. >1 means the in-memory dedup map failed to
# coalesce; 0 means no wake reached control-api (a masked read is already
# rejected loudly by control_api_wake_receipt_count).
if [ "$receipts_delta6" -eq 1 ]; then
  ok "exactly ONE wake receipt reached control-api for 5 concurrent messages (rpc-proxy dedup coalesced the burst)"
else
  fail "expected exactly 1 control-api wake receipt from the concurrent burst, got ${receipts_delta6} (before=${receipts_before6} after=${receipts_after6}) -- rpc-proxy in-memory dedup did not coalesce"; print_results; exit 1
fi

# ====================================================================== #
#  Test 7 -- Wake authz negative
# ====================================================================== #
header "Test 7 -- wake authz negative (403, annotation unchanged)"
ann_pre7="$(wake_requested_annotation)"
OTHER_HOST="${E2E_OTHER_HOST_REF:-chatllm}"
RPC_HOSTREFS_JSON="$(jq -cn --arg h "$OTHER_HOST" '[$h]')"
if mint_rpc_token; then
  post_wake "$RPC_TOKEN" || true
  if [ "$WAKE_STATUS" = "403" ]; then
    ok "wake with token lacking target hostRef -> 403"
  else
    fail "expected 403 for wake with wrong-host token, got HTTP ${WAKE_STATUS}: ${WAKE_BODY}"; print_results; exit 1
  fi
else
  fail "test 7 could not mint a token bound only to '${OTHER_HOST}' to prove the 403 authz negative -- is ${DEV_EMAIL} associated to it?"; print_results; exit 1
fi
RPC_HOSTREFS_JSON=""
mint_rpc_token || { fail "test 7 could not restore RPC token for hostRef=${HOST_REF} after wrong-host negative"; print_results; exit 1; }
ann_post7="$(wake_requested_annotation)"
if [ "$ann_pre7" = "$ann_post7" ]; then
  ok "wake annotation unchanged after rejected wake"
else
  fail "wake annotation changed on a rejected wake (${ann_pre7:-<none>} -> ${ann_post7:-<none>})"; print_results; exit 1
fi

# ====================================================================== #
#  Test 8 -- ServiceAccount RBAC negatives
# ====================================================================== #
header "Test 8 -- ServiceAccount RBAC negatives"
rbac_neg() {
  local sa=$1 sans=$2 verb=$3 resource=$4 desc=$5 out denied
  out="$(kctl auth can-i "$verb" "$resource" --as="system:serviceaccount:${sans}:${sa}" -n "$MCP_HOST_NS" 2>/dev/null || echo "no")"
  denied="$(printf "%s" "$out" | tr -d "[:space:]")"
  if [ -n "$denied" ] && [ -z "${denied//no/}" ]; then
    ok "${desc}: DENIED (can-i ${verb} ${resource} as ${sa})"
  else
    fail "${desc}: UNEXPECTEDLY ALLOWED (can-i ${verb} ${resource} as ${sa} = ${out})"; return 1
  fi
}
rbac_ok=1
rbac_neg "mcp-host" "mcp-host" "update" "deployments/scale" "mcp-host cannot scale deployments" || rbac_ok=0
rbac_neg "mcp-host" "mcp-host" "patch" "hosts" "mcp-host cannot patch hosts" || rbac_ok=0
rbac_neg "rpc-proxy" "rpc-proxy" "update" "deployments/scale" "rpc-proxy cannot scale deployments" || rbac_ok=0
rbac_neg "rpc-proxy" "rpc-proxy" "patch" "hosts" "rpc-proxy cannot patch hosts" || rbac_ok=0
[ "$rbac_ok" = "1" ] || { print_results; exit 1; }

# ====================================================================== #
#  Test 9 -- Single-writer timeline
# ====================================================================== #
header "Test 9 -- single-writer scale timeline (no pod overlap)"
force_idle_and_suspend || { print_results; exit 1; }
running_pods_before="$(kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" --field-selector=status.phase=Running -o name 2>/dev/null | wc -l | tr -d ' ')"
post_wake || { fail "wake failed for single-writer timeline"; print_results; exit 1; }
new9=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || { fail "no Ready pod after wake (test 9)"; print_results; exit 1; }
running_pods_after="$(kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" --field-selector=status.phase=Running -o name 2>/dev/null | wc -l | tr -d ' ')"
if [ "${running_pods_before:-0}" = "0" ] && [ "${running_pods_after:-0}" = "1" ]; then
  ok "single-writer: 0 running pods at suspend -> exactly 1 after wake (${new9}), no overlap"
else
  fail "single-writer violated: running before=${running_pods_before} after=${running_pods_after} (expected 0 -> 1)"; print_results; exit 1
fi

# ====================================================================== #
#  Test 10 -- Heartbeat plane auth
# ====================================================================== #
header "Test 10 -- heartbeat plane auth (claims win)"
HB_PATH="/api/v1/mcp-host/hosts/heartbeat"
HB_POD="$(current_ready_pod)" || { fail "10: no ready pod for heartbeat auth check"; print_results; exit 1; }
HB_POD_UID="$(kctl get pod "$HB_POD" -n "$MCP_HOST_NS" -o jsonpath="{.metadata.uid}" 2>/dev/null || true)"
[ -n "$HB_POD_UID" ] || { fail "10: could not resolve pod UID for ${HB_POD}"; print_results; exit 1; }
HB_BODY="$(jq -cn --arg h "$HOST_REF" --arg p "$HB_POD_UID" '{schemaVersion:1,state:"active",activeWork:false,lastActivityTs:0,hostRef:$h,podUid:$p,conditions:{activeTask:false,awaitingApproval:false,pendingResults:false}}')"
hb_code="$(curl -sS -m 15 -o /dev/null -w "%{http_code}" -X POST "${GATEWAY_BASE}${HB_PATH}" -H "Content-Type: application/json" -d "$HB_BODY" 2>/dev/null || echo "000")"
if [ "$hb_code" = "401" ]; then
  ok "heartbeat POST without auth -> 401"
else
  fail "heartbeat POST without auth returned HTTP ${hb_code} (expected 401). If the /mcp-host facade is not reachable via ${GATEWAY_BASE}, set RPC_GATEWAY_BASE_URL to the gateway URL."
  print_results; exit 1
fi
MISMATCH_HOST="${E2E_OTHER_HOST_REF:-chatllm}"
[ "$MISMATCH_HOST" != "$HOST_REF" ] || { fail "10: E2E_OTHER_HOST_REF must differ from HOST_REF for claims-win mismatch check"; print_results; exit 1; }
TARGET_RUNTIME_TOKEN="$(kctl get secret "host-${HOST_REF}-mcp-host-runtime-tokens" -n "$MCP_HOST_NS"   -o jsonpath='{.data.mcp-host-runtime-access-token}' 2>/dev/null | base64 -d 2>/dev/null || true)"
if [ -n "$TARGET_RUNTIME_TOKEN" ]; then
  HB_MISMATCH_BODY="$(jq -cn --arg h "$MISMATCH_HOST" --arg p "$HB_POD_UID" '{schemaVersion:1,state:"active",activeWork:false,lastActivityTs:0,hostRef:$h,podUid:$p,conditions:{activeTask:false,awaitingApproval:false,pendingResults:false}}')"
  hb2_code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "${GATEWAY_BASE}${HB_PATH}"     -H "Authorization: Bearer ${TARGET_RUNTIME_TOKEN}" -H 'Content-Type: application/json'     -d "$HB_MISMATCH_BODY" 2>/dev/null || echo "000")"
  if [ "$hb2_code" = "403" ]; then
    ok "heartbeat with valid target token but mismatched payload hostRef -> 403 (claims win)"
  else
    fail "expected 403 for mismatched heartbeat hostRef='${MISMATCH_HOST}' using target token, got HTTP ${hb2_code}"; print_results; exit 1
  fi
else
  fail "could not extract runtime token for '${HOST_REF}' from secret host-${HOST_REF}-mcp-host-runtime-tokens -- the claims-win 403 security negative cannot be asserted."
  print_results; exit 1
fi

# ====================================================================== #
#  Test 11 -- Kill-switch with held request
# ====================================================================== #
header "Test 11 -- kill-switch with held request completes or retryable"
force_idle_and_suspend || { print_results; exit 1; }
k_status_file="$(mktemp)"
MARKER11="killswitch-held-${RUN_ID}"
( if send_turn "Reply with exactly: ${MARKER11}"; then echo "$TURN_STATUS" > "$k_status_file"; else echo "ERR" > "$k_status_file"; fi ) &
K_BG=$!
sleep 2
STATELESS_DISABLED=1
kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=merge   -p '{"spec":{"lifecycle":{"stateless":false}}}' >/dev/null 2>&1 || { fail "test 11 could not flip stateless:false"; kill "$K_BG" 2>/dev/null; print_results; exit 1; }
k_wait=0
while kill -0 "$K_BG" 2>/dev/null && [ "$k_wait" -lt "$WAKE_HOLD_DEADLINE" ]; do sleep 3; k_wait=$((k_wait+3)); done
if kill -0 "$K_BG" 2>/dev/null; then
  kill "$K_BG" 2>/dev/null
  fail "held request hung past ${WAKE_HOLD_DEADLINE}s during kill-switch"; rm -f "$k_status_file"; print_results; exit 1
fi
wait "$K_BG" 2>/dev/null || true
k_result="$(cat "$k_status_file" 2>/dev/null || echo MISSING)"; rm -f "$k_status_file"
case "$k_result" in
  [0-9][0-9][0-9]) ok "held request resolved with concrete HTTP ${k_result} (no hang)" ;;
  *) fail "held request did not return a concrete HTTP status (got '${k_result}')"; print_results; exit 1 ;;
esac
# Kill-switch postcondition is a HARD assertion, not a warn: once stateless is
# disabled the host must converge to always-on (replicas=1 OR lifecycle=active).
# Give the reconciler a bounded window, then fail loud with diagnostics -- a
# host that never becomes always-on after the kill-switch is a real regression.
ks_wait=0; ks_ok=0
while [ "$ks_wait" -lt "$WAKE_HOLD_DEADLINE" ]; do
  if [ "$(deployment_replicas)" = "1" ] || [ "$(lifecycle_state)" = "active" ]; then ks_ok=1; break; fi
  sleep "$POLL_INTERVAL"; ks_wait=$((ks_wait + POLL_INTERVAL))
done
if [ "$ks_ok" = "1" ]; then
  ok "host is always-on (replicas 1 / active) while stateless disabled"
else
  fail "host did not become always-on within ${WAKE_HOLD_DEADLINE}s after kill-switch: state=$(lifecycle_state) replicas=$(deployment_replicas)"
  pod_diagnostics; print_results; exit 1
fi
wait_for_deployment_template stateful "$POD_READY_TIMEOUT" "11: stateless disabled" || { print_results; exit 1; }
kctl patch host "$HOST_REF" -n "$MCP_HOST_NS" --type=merge -p '{"spec":{"lifecycle":{"stateless":true}}}' >/dev/null 2>&1 || true
STATELESS_DISABLED=0
wait_for_deployment_template stateless "$POD_READY_TIMEOUT" "11: stateless re-enabled" \
  || { print_results; exit 1; }
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "host did not recover after re-enabling stateless"; print_results; exit 1; }
ok "running stateful Host converged back to stateless and is Ready"

# ====================================================================== #
#  Test 12 -- Re-resolution on wake
# ====================================================================== #
header "Test 12 -- mcpServers re-resolution on wake"
if [ -z "$CONTEXT_REF" ]; then
  fail "test 12 requires a contextRef on Host '${HOST_REF}' but none is set"; print_results; exit 1
fi
CTX_JSON="$(kctl get context "$CONTEXT_REF" -n "$CONTEXT_NS" -o json 2>/dev/null || true)"
CONTEXT_MCPSERVERS_BACKUP="$(echo "$CTX_JSON" | jq -c '.spec.mcpServers // []' 2>/dev/null || echo '[]')"
server_count="$(echo "$CONTEXT_MCPSERVERS_BACKUP" | jq 'length' 2>/dev/null || echo 0)"
if [ "${server_count:-0}" -lt 1 ]; then
  fail "test 12: Context '${CONTEXT_REF}' lists no mcpServers to disable"; print_results; exit 1
fi
DISABLED_MCP_SERVER="$(echo "$CONTEXT_MCPSERVERS_BACKUP" | jq -r '.[0] | if type == "object" then (.name // "") else . end' 2>/dev/null)"
force_idle_and_suspend || { print_results; exit 1; }
NEW_MCPSERVERS="$(echo "$CONTEXT_MCPSERVERS_BACKUP" | jq -c '.[1:]')"
CONTEXT_PATCH_APPLIED=1
kctl patch context "$CONTEXT_REF" -n "$CONTEXT_NS" --type=merge \
  -p "{\"spec\":{\"mcpServers\":${NEW_MCPSERVERS}}}" >/dev/null 2>&1 || { fail "test 12: failed to patch Context ${CONTEXT_REF} in namespace ${CONTEXT_NS}"; print_results; exit 1; }
if send_turn_expect_ok "Reply with exactly: RERESOLVE_${RUN_ID}"; then
  assert_success_response "re-resolution wake turn" || { print_results; exit 1; }
else
  fail "test 12: message to suspended host not served"; print_results; exit 1
fi
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "test 12: no pod after wake"; print_results; exit 1; }
mint_rpc_token || true
status_snap="$(curl -sS -m 30 "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/status" -H "Authorization: Bearer ${RPC_TOKEN}" 2>/dev/null || echo '{}')"
if echo "$status_snap" | jq -e --arg s "$DISABLED_MCP_SERVER" \
    '((.mcpServers // []) | map(if type == "object" then (.name // "") else . end) | index($s)) == null' >/dev/null 2>&1; then
  ok "post-wake status.mcpServers no longer lists '${DISABLED_MCP_SERVER}' (re-resolution honored)"
else
  fail "test 12: disabled MCP server '${DISABLED_MCP_SERVER}' still present in post-wake status: $(echo "$status_snap" | jq -c '.mcpServers // []')"; print_results; exit 1
fi
restore_context_mcpserver
CONTEXT_PATCH_APPLIED=0
ok "test 12: Context mcpServers restored"

# ---------------------------------------------------------------------- #
#  Test 12b -- secret rotation on wake: NEW value served, OLD rejected
#  (HIGH-3: re-resolution must prove a rotated value takes effect at wake,
#   with the old value provably refused -- see header for the observable.)
# ---------------------------------------------------------------------- #
header "Test 12b -- provider Secret rotation re-read on wake (old rejected)"
SECRET_NAME="$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.secretRef}' 2>/dev/null || true)"
if [ -z "$SECRET_NAME" ]; then
  fail "test 12b requires spec.secretRef on Host '${HOST_REF}' but none is set"; print_results; exit 1
fi
SECRET_DATA_BACKUP="$(kctl get secret "$SECRET_NAME" -n "$MCP_HOST_NS" -o jsonpath='{.data}' 2>/dev/null || true)"
if [ -z "$SECRET_DATA_BACKUP" ] || [ "$SECRET_DATA_BACKUP" = "{}" ]; then
  fail "test 12b: Secret '${SECRET_NAME}' has no .data to rotate"; print_results; exit 1
fi
# Build a rotated .data map: every existing key set to a sentinel INVALID
# base64 value ("clerum-e2e-rotated-invalid"), so provider auth fails for any
# provider regardless of which key name it reads.
ROTATED_DATA="$(printf '%s' "$SECRET_DATA_BACKUP" | jq -c 'to_entries | map({key:.key, value:("Y2xlcnVtLWUyZS1yb3RhdGVkLWludmFsaWQ=")}) | from_entries' 2>/dev/null || echo "")"
if [ -z "$ROTATED_DATA" ] || [ "$ROTATED_DATA" = "{}" ]; then
  fail "test 12b: failed to build rotated Secret data from backup"; print_results; exit 1
fi
force_idle_and_suspend || { print_results; exit 1; }
SECRET_ROTATED=1
kctl patch secret "$SECRET_NAME" -n "$MCP_HOST_NS" --type=merge \
  -p "{\"data\":${ROTATED_DATA}}" >/dev/null 2>&1 || { fail "test 12b: failed to rotate Secret ${SECRET_NAME}"; print_results; exit 1; }
ok "test 12b: rotated Secret ${SECRET_NAME} to a sentinel invalid value during suspension"
# Wake with a turn. The woken pod must re-read the ROTATED (invalid) Secret;
# the turn must be REFUSED (non-200 / success!=true). A 200 here would prove
# the woken pod served the OLD cached secret -- the exact stale-read bug this
# asserts against. ONLY a definitive mcp-host response counts as evidence:
# 503 {code:"host_waking"} is wake-in-progress (retried under the same
# WAKE_HOLD_DEADLINE bound send_turn_expect_ok uses, never a verdict), and a
# deadline expiry or transport-level curl failure HARD-FAILS -- an infra
# timeout must never pass a security-property test.
ROTATE_VERDICT=""
rotate_deadline=$((SECONDS + WAKE_HOLD_DEADLINE)); rotate_attempt=0
while [ "$SECONDS" -lt "$rotate_deadline" ]; do
  rotate_attempt=$((rotate_attempt + 1))
  if ! send_turn "Reply with exactly: ROTATED_REJECT_${RUN_ID}"; then
    fail "test 12b: transport-level failure on the rotated-secret wake turn (attempt ${rotate_attempt}, no HTTP status) -- the request never reached mcp-host's provider call, so this proves NOTHING about rotation"
    pod_diagnostics; print_results; exit 1
  fi
  if [ "$TURN_STATUS" = "503" ] && echo "$TURN_BODY" | grep -q 'host_waking'; then
    log "test 12b attempt ${rotate_attempt}: 503 host_waking (wake-in-progress, not evidence) -- re-issuing within deadline"
    sleep 3; continue
  fi
  ROTATE_VERDICT="definitive"; break
done
if [ "$ROTATE_VERDICT" != "definitive" ]; then
  fail "test 12b: wake-and-hold deadline (${WAKE_HOLD_DEADLINE}s) expired with no definitive provider-facing response (last HTTP ${TURN_STATUS} body=$(printf '%s' "$TURN_BODY" | head -c 300)) -- an infra timeout must never pass a security test"
  pod_diagnostics; print_results; exit 1
fi
if [ "$TURN_STATUS" = "200" ] && echo "$TURN_BODY" | jq -e '.success == true' >/dev/null 2>&1; then
  fail "test 12b: woken turn SUCCEEDED (200 success:true) with a rotated-invalid provider Secret -- old value was served from stale cache (re-resolution did not re-read the Secret)"; print_results; exit 1
fi
ok "test 12b: woken turn definitively refused with rotated-invalid Secret (HTTP ${TURN_STATUS}) -- old value provably not served"
# Restore the original Secret and prove the NEW (restored) value is served on
# the next wake -- confirming the observable is the rotation, not a dead host.
kctl patch secret "$SECRET_NAME" -n "$MCP_HOST_NS" --type=merge \
  -p "{\"data\":${SECRET_DATA_BACKUP}}" >/dev/null 2>&1 || { fail "test 12b: failed to restore Secret ${SECRET_NAME}"; print_results; exit 1; }
SECRET_ROTATED=0
force_idle_and_suspend || { print_results; exit 1; }
if send_turn_expect_ok "Reply with exactly: ROTATED_RESTORE_${RUN_ID}"; then
  assert_success_response "post-restore wake turn" || { print_results; exit 1; }
  ok "test 12b: restored Secret value served on wake (rotation re-read confirmed, not a broken host)"
else
  fail "test 12b: host did not serve after Secret restore -- cannot confirm rotation was the cause"; print_results; exit 1
fi

# ====================================================================== #
#  Phase 2 -- Desktop Playwright (final phase)
# ====================================================================== #
header "Phase 2 -- Desktop Playwright (stateless-wake.test.ts)"
if [ "$E2E_SKIP_DESKTOP_PHASE" = "1" ]; then
  echo -e "${YELLOW}"
  echo "=================================================================="
  echo "  DESKTOP PHASE NOT RUN -- E2E_SKIP_DESKTOP_PHASE=1"
  echo "  The Playwright suspend/wake spec was explicitly skipped. This is"
  echo "  an opt-out, not a pass: rerun without the flag on a display-capable"
  echo "  runner to gate the Desktop wake UX."
  echo "=================================================================="
  echo -e "${NC}"
  print_results
  exit 3
fi
force_idle_and_suspend || { print_results; exit 1; }
log "Handing off to Playwright (cycle 1) with E2E_HOST_REF=${HOST_REF}"
# Cycle 1 -- every scenario EXCEPT the repeat-cycle one, which requires its own
# fresh suspension and is run in the second pass below. Scenario 5 is excluded
# here by its title ("second cycle").
if E2E_HOST_REF="$HOST_REF" E2E_STATELESS_HOST_REF="$HOST_REF" E2E_STATELESS_SUSPENDED=1 \
   E2E_STATELESS_CYCLE=1 \
   bash "${SCRIPT_DIR}/playwright-dev.sh" stateless-wake.test.ts --grep-invert "second cycle"; then
  ok "Desktop Playwright stateless-wake cycle 1 PASSED"
else
  pw_rc=$?
  fail "Desktop Playwright stateless-wake cycle 1 FAILED (exit ${pw_rc}). If Electron/display is unavailable, rerun with E2E_SKIP_DESKTOP_PHASE=1 for an explicit, loud opt-out."
  print_results
  exit 1
fi

# ====================================================================== #
#  Phase 2 (cycle 2) -- repeat suspend/wake (§15.5 step 11)
# ====================================================================== #
# Re-suspend the SAME host and run only the second-cycle scenario. This excludes
# a one-shot cache artifact: the chats created in cycle 1 must survive a second
# replicas-0 suspension and a fresh, UI-driven wake. The desktop build from cycle
# 1 is reused (E2E_SKIP_DESKTOP_BUILD=1); a second cold suspend is mandatory
# before the pass, and any failure is surfaced loudly with the same exit-1
# discipline as cycle 1.
header "Phase 2 (cycle 2) -- repeat suspend/wake (stateless-wake.test.ts -g 'second cycle')"
force_idle_and_suspend || { print_results; exit 1; }
log "Handing off to Playwright (cycle 2) with E2E_HOST_REF=${HOST_REF}"
if E2E_HOST_REF="$HOST_REF" E2E_STATELESS_HOST_REF="$HOST_REF" E2E_STATELESS_SUSPENDED=1 \
   E2E_STATELESS_CYCLE=2 E2E_SKIP_DESKTOP_BUILD=1 \
   bash "${SCRIPT_DIR}/playwright-dev.sh" stateless-wake.test.ts -g "second cycle"; then
  ok "Desktop Playwright stateless-wake cycle 2 (repeat suspend/wake) PASSED"
else
  pw_rc=$?
  fail "Desktop Playwright stateless-wake cycle 2 FAILED (exit ${pw_rc}). The repeat suspend/wake cycle did not prove continuity across a second suspension."
  print_results
  exit 1
fi

print_results
