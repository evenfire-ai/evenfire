#!/usr/bin/env bash
# ======================================================================
# J4 — rpc-proxy Host parent path through control-api-rpc-gateway
# ======================================================================
# A user message and an artifact list go through rpc-proxy, which resolves
# the Host through control-api-rpc-gateway on the parent path:
#   POST /api/v1/rpc/access/users/:userId/mcp-hosts/:hostRef
#     (a message with threadId carries a direct-run binding)
#   GET  /api/v1/rpc/access/users/:userId/mcp-hosts/:hostRef
#     (an artifact list has no binding)
# The gateway ends in a default `return 403`, so a missing location turns
# both journeys into an opaque denial. The access-log check is anchored at
# the Host ref, so a sub-path such as /message-resolution does not match.
# Signals per journey:
#   1. rpc-proxy answers HTTP 200;
#   2. the gateway access log has the parent path with status 200 and no 403;
#   3. for the message, the user turn is persisted in the Host's state.db.
#
# Meant as a T2 healthcheck:
#   T2_HEALTHCHECK_COMMAND="KUBECONTEXT=<profile> E2E_PROFILE_PORTS_ENV=<ports.env> \
#     bash scripts/e2e/e2e-rpc-gateway-host-paths.sh"
#
# Required environment:
#   KUBECONTEXT (or E2E_K8S_CONTEXT)  explicit branch-profile context
#   E2E_PROFILE_PORTS_ENV             <profile root>/<profile>/ports.env of
#                                     that same profile (T2 exports it as
#                                     T2_PORTS_ENV); the External REST and
#                                     rpc-proxy URLs come from it, never from
#                                     fixed ports
#   E2E_DEV_LOGIN_EMAIL               seeded Desktop login for the Host owner
#   E2E_USER_PASSWORD or ADMIN_PASSWORD
# Optional:
#   E2E_GATEWAY_HOST_REF (default chatllm)
#   E2E_TURN_TIMEOUT (default 120), J4_DEADLINE_SECONDS (default 300)
#
# J4_DEADLINE_SECONDS is the run budget: no request, kubectl call or retry
# sleep starts once it is spent, each gets at most the remaining budget, and
# the run fails when it expires. A timed-out kubectl call can take up to the
# 2 s kill grace of run-with-deadline.mjs to terminate.
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

if [ -z "${E2E_KUBECONTEXT:-}" ] || ! is_branch_scoped_e2e_context "$E2E_KUBECONTEXT"; then
  echo "J4 requires an explicit branch-scoped KUBECONTEXT (or E2E_K8S_CONTEXT); the global current-context is never used" >&2
  exit 2
fi
require_safe_kube_context
if [ -z "${E2E_PROFILE_PORTS_ENV:-}" ] || [ ! -r "$E2E_PROFILE_PORTS_ENV" ]; then
  echo "J4 requires E2E_PROFILE_PORTS_ENV pointing at the branch profile ports.env" >&2
  exit 2
fi
# A profile keeps its ports map at <profile root>/<profile>/ports.env
# (scripts/minikube-profiles/branch-profile.sh set_profile_paths), and the
# Minikube context is named after the profile. A ports file from another
# profile would send the login and the message to that profile's services.
ports_profile="$(basename "$(cd "$(dirname "$E2E_PROFILE_PORTS_ENV")" && pwd -P)")"
if [ "$ports_profile" != "$E2E_KUBECONTEXT" ]; then
  echo "J4 refuses to run: ${E2E_PROFILE_PORTS_ENV} belongs to profile ${ports_profile}, not ${E2E_KUBECONTEXT}" >&2
  exit 2
fi
profile_port_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$E2E_PROFILE_PORTS_ENV"
}
CONTROL_API_BASE_URL="$(profile_port_value CONTROL_API_URL)"
CONTROL_UI_BASE_URL="$(profile_port_value CONTROL_UI_URL)"
EXTERNAL_REST_API_BASE_URL="$(profile_port_value EXTERNAL_REST_API_URL)"
RPC_PROXY_BASE_URL="$(profile_port_value RPC_PROXY_URL)"
export CONTROL_API_BASE_URL CONTROL_UI_BASE_URL EXTERNAL_REST_API_BASE_URL RPC_PROXY_BASE_URL
if ! require_branch_profile_urls "$E2E_KUBECONTEXT" "$E2E_PROFILE_PORTS_ENV"; then
  echo "J4 refuses to run: profile URLs are missing from ${E2E_PROFILE_PORTS_ENV}" >&2
  exit 2
fi
: "${E2E_DEV_LOGIN_EMAIL:?J4 requires E2E_DEV_LOGIN_EMAIL (the seeded Desktop login)}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-}}"
if [ -z "$DEV_PASSWORD" ]; then
  echo "J4 requires E2E_USER_PASSWORD or ADMIN_PASSWORD" >&2
  exit 2
fi

HOST_REF="${E2E_GATEWAY_HOST_REF:-chatllm}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL%/}"
RPC_BASE="${RPC_PROXY_BASE_URL%/}"
GATEWAY_NS=control-plane
GATEWAY_SELECTOR=app=control-api-rpc-gateway
E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
J4_DEADLINE_SECONDS="${J4_DEADLINE_SECONDS:-300}"
# The budget arithmetic is integer-only; a fractional value would make the
# comparisons error out and skip the cap.
for setting in E2E_TURN_TIMEOUT J4_DEADLINE_SECONDS; do
  if ! [[ "${!setting}" =~ ^[1-9][0-9]*$ ]]; then
    echo "J4 requires ${setting} to be a positive integer number of seconds, got '${!setting}'" >&2
    exit 2
  fi
done
RUN_ID="$(date +%s)-$$-${RANDOM}"
MARKER="j4-gateway-${RUN_ID}"
THREAD_ID="e2e-rpc-gateway-host-paths-${RUN_ID}"
STARTED_SECONDS=$SECONDS

remaining_seconds() {
  printf '%s\n' $((J4_DEADLINE_SECONDS - (SECONDS - STARTED_SECONDS)))
}

within_deadline() {
  if [ "$(remaining_seconds)" -le 0 ]; then
    fail "J4 deadline of ${J4_DEADLINE_SECONDS}s expired before: $1"
    print_results || true
    exit 1
  fi
}

# Cap a per-call timeout at the remaining run budget.
call_budget() {
  local requested=$1 remaining
  remaining="$(remaining_seconds)"
  if [ "$remaining" -lt "$requested" ]; then
    printf '%s\n' "$remaining"
  else
    printf '%s\n' "$requested"
  fi
}

# Every kubectl call names the context and cannot outlive the run budget.
kctl() {
  local budget
  budget="$(call_budget 30)"
  if [ "$budget" -le 0 ]; then
    echo "J4 deadline expired before kubectl $*" >&2
    return 124
  fi
  node "${ROOT}/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds "$budget" --kill-grace-seconds 2 --heartbeat-seconds 30 \
    --label j4-kubectl -- "$KUBECTL_BIN" --context="$E2E_KUBECONTEXT" \
    --request-timeout="${budget}s" "$@"
}

http_call() {
  # http_call <label> <timeout-seconds> <curl args...> → HTTP_STATUS / HTTP_BODY
  local label=$1 budget resp
  budget="$(call_budget "$2")"
  shift 2
  HTTP_STATUS=000
  HTTP_BODY=''
  if [ "$budget" -le 0 ]; then
    echo "${label}: J4 deadline expired before the request" >&2
    return 1
  fi
  if ! resp=$(curl -sS -m "$budget" -w '\n%{http_code}' "$@"); then
    echo "${label}: curl error" >&2
    return 1
  fi
  HTTP_STATUS="$(printf '%s\n' "$resp" | tail -n1)"
  HTTP_BODY="$(printf '%s\n' "$resp" | sed '$d')"
}

header "Prerequisites"
for bin in jq curl node; do
  command -v "$bin" >/dev/null 2>&1 || { fail "missing required binary: $bin"; print_results || true; exit 1; }
done
for base in "$EXT_BASE" "$RPC_BASE"; do
  if http_call health 10 -o /dev/null "${base}/health" && [ "$HTTP_STATUS" = "200" ]; then
    ok "${base}/health → 200"
  else
    fail "${base}/health → ${HTTP_STATUS} (port-forward down or service unhealthy)"
    print_results || true
    exit 1
  fi
done
if ! gateway_pods="$(kctl -n "$GATEWAY_NS" get pods -l "$GATEWAY_SELECTOR" \
  --field-selector=status.phase=Running -o name)"; then
  fail "cannot list control-api-rpc-gateway pods in ${GATEWAY_NS}"
  print_results || true
  exit 1
fi
if [ -n "$gateway_pods" ]; then
  ok "control-api-rpc-gateway pods running: $(printf '%s' "$gateway_pods" | tr '\n' ' ')"
else
  fail "no Running control-api-rpc-gateway pod in ${GATEWAY_NS}"
  kctl -n "$GATEWAY_NS" get pods -l "$GATEWAY_SELECTOR" -o wide >&2 || true
  print_results || true
  exit 1
fi

header "Tokens"
SESSION_TOKEN=''
if http_call password-login 30 -X POST "${EXT_BASE}/api/v1/auth/password-login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg e "$E2E_DEV_LOGIN_EMAIL" --arg p "$DEV_PASSWORD" '{email: $e, password: $p}')"; then
  SESSION_TOKEN="$(printf '%s' "$HTTP_BODY" | jq -r '.token // empty' 2>/dev/null || true)"
fi
if [ "$HTTP_STATUS" = "200" ] && [ -n "$SESSION_TOKEN" ]; then
  ok "session token minted for ${E2E_DEV_LOGIN_EMAIL}"
else
  fail "password-login → HTTP ${HTTP_STATUS} (no session token)"
  print_results || true
  exit 1
fi

mint_rpc_token() {
  RPC_TOKEN=''
  http_call rpc/token 30 -X POST "${EXT_BASE}/api/v1/rpc/token" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg h "$HOST_REF" '{hostRefs: [$h], scopes: ["host:message:invoke", "host:task:read"]}')" ||
    return 1
  RPC_TOKEN="$(printf '%s' "$HTTP_BODY" | jq -r '.token // empty' 2>/dev/null || true)"
  [ "$HTTP_STATUS" = "200" ] && [ -n "$RPC_TOKEN" ]
}
if mint_rpc_token; then
  ok "RPC token minted for hostRef=${HOST_REF}"
else
  fail "rpc/token → HTTP ${HTTP_STATUS}: ${HTTP_BODY}"
  print_results || true
  exit 1
fi

# The gateway log window starts here, before the first journey request.
LOG_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

header "Journey: message through the parent Host path"
attempts=0
message_sent=false
while :; do
  within_deadline "message send"
  attempts=$((attempts + 1))
  if ! mint_rpc_token; then
    fail "rpc/token re-mint → HTTP ${HTTP_STATUS}"
    break
  fi
  if ! http_call message "$E2E_TURN_TIMEOUT" -X POST "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
    -H "Authorization: Bearer ${RPC_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg c "J4 gateway check ${MARKER}. Reply with OK." --arg t "$THREAD_ID" '{content: $c, threadId: $t}')"; then
    fail "POST /rpc/hosts/${HOST_REF}/messages: no HTTP response"
    break
  fi
  # Only the documented retryable wake signal is retried, with a bounded budget.
  if [ "$HTTP_STATUS" = "503" ] && grep -q 'host_waking' <<<"$HTTP_BODY" && [ "$attempts" -lt 5 ]; then
    warn "message got retryable 503 host_waking (attempt ${attempts}/5)"
    # A spent budget skips the sleep; the next within_deadline fails the run.
    pause="$(call_budget 5)"
    if [ "$pause" -gt 0 ]; then
      sleep "$pause"
    fi
    continue
  fi
  message_sent=true
  break
done
if [ "$message_sent" = true ]; then
  if [ "$HTTP_STATUS" = "200" ] && jq -e '.success == true' >/dev/null 2>&1 <<<"$HTTP_BODY"; then
    ok "POST /rpc/hosts/${HOST_REF}/messages → 200 success=true"
  else
    fail "POST /rpc/hosts/${HOST_REF}/messages → HTTP ${HTTP_STATUS}: ${HTTP_BODY}"
  fi
fi

header "Journey: artifact list through the parent Host path"
within_deadline "artifact read"
if ! mint_rpc_token; then
  fail "rpc/token re-mint → HTTP ${HTTP_STATUS}; artifact list not attempted"
elif ! http_call artifacts 30 "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/artifacts" \
  -H "Authorization: Bearer ${RPC_TOKEN}"; then
  fail "GET /rpc/hosts/${HOST_REF}/artifacts: no HTTP response"
elif [ "$HTTP_STATUS" = "200" ]; then
  ok "GET /rpc/hosts/${HOST_REF}/artifacts → 200"
else
  fail "GET /rpc/hosts/${HOST_REF}/artifacts → HTTP ${HTTP_STATUS}: ${HTTP_BODY}"
fi

header "Gateway access log"
within_deadline "gateway log read"
gateway_log=''
if ! gateway_log="$(kctl -n "$GATEWAY_NS" logs -l "$GATEWAY_SELECTOR" --since-time="$LOG_SINCE" \
  --tail=-1 --max-log-requests=10)"; then
  fail "cannot read control-api-rpc-gateway logs"
  gateway_log=''
fi
# Here-strings, not `printf | grep -q`: under pipefail grep -q exits on the
# first match, printf can then die of SIGPIPE, and the pipeline reports no match.
check_gateway_line() {
  local method=$1 pattern
  # The space before HTTP anchors the path at the Host ref. A sub-path
  # (/message-resolution, /artifact-read) does not match.
  pattern="\"${method} /api/v1/rpc/access/users/[^/ ]+/mcp-hosts/${HOST_REF} HTTP/[0-9.]+\" "
  if grep -Eq "${pattern}200 " <<<"$gateway_log"; then
    ok "gateway logged ${method} .../mcp-hosts/${HOST_REF} → 200"
  else
    fail "gateway has no ${method} .../mcp-hosts/${HOST_REF} line with 200 since ${LOG_SINCE}"
  fi
  if grep -Eq "${pattern}403 " <<<"$gateway_log"; then
    fail "gateway denied ${method} .../mcp-hosts/${HOST_REF} with 403 (missing or wrong location)"
  else
    ok "gateway logged no 403 for ${method} .../mcp-hosts/${HOST_REF}"
  fi
}
check_gateway_line POST
check_gateway_line GET

header "Persisted user turn"
within_deadline "state.db read"
pod="$(ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}" || true)"
if [ -z "$pod" ]; then
  fail "no Ready pod for app=${HOST_REF} in ${MCP_HOST_NS}"
else
  db_dir="$(kctl exec "$pod" -n "$MCP_HOST_NS" -- printenv CLERUM_SESSION_DB_DIR 2>/dev/null || true)"
  if [ -z "$db_dir" ]; then
    fail "pod ${pod} has no CLERUM_SESSION_DB_DIR"
  else
    db_path="${db_dir%/}/state.db"
    sql="SELECT COUNT(*) FROM messages WHERE role='user' AND (content LIKE '%${MARKER}%' OR content_parts LIKE '%${MARKER}%')"
    if kctl exec "$pod" -n "$MCP_HOST_NS" -- sh -c 'command -v sqlite3' >/dev/null 2>&1; then
      count="$(kctl exec "$pod" -n "$MCP_HOST_NS" -- sqlite3 -readonly "$db_path" "$sql" || true)"
    else
      # Resolve the Host's own better-sqlite3 from the container working directory
      # (/app/mcp-host/node_modules in the chatllm image), not a fixed path.
      count="$(kctl exec "$pod" -n "$MCP_HOST_NS" -- env "DB=${db_path}" "SQL=${sql}" node -e \
        'const D=require("better-sqlite3");const db=new D(process.env.DB,{readonly:true});db.pragma("busy_timeout=5000");const row=db.prepare(process.env.SQL).get();console.log(row?Object.values(row)[0]:0);' || true)"
    fi
    count="$(printf '%s' "$count" | tr -d '[:space:]')"
    if [ "$count" = "1" ]; then
      ok "user turn ${MARKER} persisted once in ${db_path}"
    else
      fail "expected 1 persisted user turn with ${MARKER} in ${db_path}, found '${count}'"
    fi
  fi
fi

within_deadline "results"
print_results
