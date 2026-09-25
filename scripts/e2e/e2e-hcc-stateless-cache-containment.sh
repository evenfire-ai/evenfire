#!/usr/bin/env bash
# Branch-owned live gate for #396. The TLS fixture cuts only the
# CommunicationChannel watch/list while forwarding all other Kubernetes API
# requests. A known conversation is created through rpc-proxy before the cut.
set -euo pipefail
umask 077
# shellcheck disable=SC2034 # Shared fixture helpers consume these globals.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# The branch profile is seeded from the canonical repository credentials.
# Resolve them in-process when the caller has not supplied this journey's
# explicit password; never print the resolved value in gate evidence.
# shellcheck source=scripts/e2e/load-dotenv.sh
source "${REPO_ROOT}/scripts/e2e/load-dotenv.sh"
dotenv_load_canonical_root "${REPO_ROOT}"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${REPO_ROOT}/scripts/e2e/admin-credentials.sh"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-fixture.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-assertions.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-assertions.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-logs.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-logs.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-pr-a.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-pr-a.sh"

die() { fail "$*"; exit 1; }
wait_until() {
  local timeout=$1 description=$2 elapsed=0
  shift 2
  while [ "$elapsed" -lt "$timeout" ]; do
    "$@" && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "Timed out waiting for ${description}" >&2
  return 1
}

if [ -z "$E2E_KUBECONTEXT" ] || ! is_branch_scoped_e2e_context "$E2E_KUBECONTEXT"; then
  die 'select an explicit branch-scoped Minikube context'
fi
require_safe_kube_context
[ "${E2E_HCC_WATCH_FAULT_INJECTION:-0}" = 1 ] || die 'set E2E_HCC_WATCH_FAULT_INJECTION=1'
[ -n "${E2E_BRANCH_PROFILE_ENV:-}" ] && [ -r "$E2E_BRANCH_PROFILE_ENV" ] ||
  die 'provide E2E_BRANCH_PROFILE_ENV from the owned branch profile'
[ -n "${E2E_PROFILE_PORTS_ENV:-}" ] && [ -r "$E2E_PROFILE_PORTS_ENV" ] ||
  die 'provide E2E_PROFILE_PORTS_ENV from the owned branch profile'
profile_port_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$E2E_PROFILE_PORTS_ENV"
}
CONTROL_API_BASE_URL="$(profile_port_value CONTROL_API_URL)"
CONTROL_UI_BASE_URL="$(profile_port_value CONTROL_UI_URL)"
EXTERNAL_REST_API_BASE_URL="$(profile_port_value EXTERNAL_REST_API_URL)"
RPC_PROXY_BASE_URL="$(profile_port_value RPC_PROXY_URL)"
export CONTROL_API_BASE_URL CONTROL_UI_BASE_URL EXTERNAL_REST_API_BASE_URL RPC_PROXY_BASE_URL
require_branch_profile_urls "$E2E_KUBECONTEXT" "$E2E_PROFILE_PORTS_ENV" ||
  die 'profile URLs do not match the owned ports'
kctl get nodes -o json | jq -e --arg c "$E2E_KUBECONTEXT" \
  'any(.items[]; .metadata.labels["minikube.k8s.io/name"]==$c)' >/dev/null ||
  die 'target is not the selected Minikube profile'

HCC_NS=control-plane HCC_DEPLOY=host-context-controller
HOST_NS=mcp-host MCP_NS=mcp-server CHANNEL_NS=channels
HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
RUN_ID="$(date +%s)-$$"
PROXY_NAME="$(truncate_rfc1123 "e2e-hcc-channel-${RUN_ID}")"
PROBE_NAME="$(truncate_rfc1123 "${PROXY_NAME}-negative-probe")"
PROXY_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-api")"
HCC_PROXY_NP="$(truncate_rfc1123 "${PROXY_NAME}-from-hcc")"
PROBE_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-from-probe")"
THREAD_ID="e2e-hcc-cache-${RUN_ID}"
MARKER="hcc-cache-${RUN_ID}"
START_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HCC_LOG_BUFFER="$(mktemp "${TMPDIR:-/tmp}/hcc-channel-log.XXXXXX")"
HCC_LOG_STREAM_PID=''
HCC_GATE_LOCK_ACQUIRED=0 HCC_GATE_LOCK_NAME='' HCC_GATE_LOCK_UID=''
HCC_GATE_FINALIZATION_FAILURE=''
HCC_PATCHED=0 PROXY_CREATED=0 PROBE_CREATED=0 HCC_PR_A_TLS_CREATED=0
HCC_UID='' HCC_RESTARTS=''
ORIGINAL_REPLICAS=''
HCC_PR_A_CHANNEL_HOLD_ID=''

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1
  set +e
  stop_hcc_recovery_log_stream
  if [ "$HCC_PATCHED" = 1 ]; then
    if hcc_pr_a_restore && kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null; then
      HCC_PATCHED=0
    else
      restore_ok=0
    fi
  fi
  if [ "$restore_ok" = 1 ]; then
    [ "$PROXY_CREATED" = 0 ] || delete_hcc_proxy_fixture || cleanup_failed=1
    if [ "$HCC_PR_A_TLS_CREATED" = 1 ]; then
      kctl delete configmap "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
      kctl delete secret "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
    fi
  else
    cleanup_failed=1
    echo "HCC restoration failed; retained proxy ${HCC_NS}/${PROXY_NAME} on ${E2E_KUBECONTEXT}" >&2
  fi
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  rm -f "$HCC_LOG_BUFFER" "${HCC_PR_A_CONFIG_SNAPSHOT:-}"
  [ "$cleanup_failed" = 0 ] || status=1
  print_results
  exit "$status"
}
trap cleanup EXIT

header 'Stateless Host containment during CommunicationChannel cache uncertainty'
require_branch_owned_hcc_gate
acquire_hcc_watch_gate_lock || die 'another HCC watch gate owns this profile'
ORIGINAL_REPLICAS="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.replicas}')"
[ "$ORIGINAL_REPLICAS" = 1 ] || die 'HCC must have exactly one replica'
[ "$(kctl get host "$HOST_REF" -n "$HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}')" = true ] ||
  die 'selected Host must request stateless lifecycle'

HCC_IMAGE="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
[ -n "$HCC_IMAGE" ] || die 'could not resolve the running HCC image'
K8S_API_SERVICE_HOST="$(kctl exec deployment/"$HCC_DEPLOY" -n "$HCC_NS" -c host-context-controller -- printenv KUBERNETES_SERVICE_HOST)"
node -e 'process.exit(require("node:net").isIP(process.argv[1])===4?0:1)' "$K8S_API_SERVICE_HOST" ||
  die 'Kubernetes API service address is not IPv4'
K8S_API_CIDR="${K8S_API_SERVICE_HOST}/32"
hcc_pr_a_preflight
create_hcc_api_proxy
HCC_PR_A_SELECTIVE_CHANNEL=1 hcc_pr_a_enable_proxy
E2E_HCC_PR_A=1 verify_hcc_proxy_network_policy
HCC_PATCHED=1
kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=strategic -p "$(hcc_pr_a_redirect_patch)" >/dev/null
kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null ||
  die 'HCC did not become Ready through selective TLS proxy'
read -r HCC_UID HCC_RESTARTS <<<"$(wait_for_hcc_identity 30)"
start_hcc_recovery_log_stream

EXT_BASE="${EXTERNAL_REST_API_BASE_URL%/}"
RPC_BASE="${RPC_PROXY_BASE_URL%/}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-}"
if [ -z "$DEV_PASSWORD" ]; then
  DEV_PASSWORD="$(e2e_resolve_admin_password "$REPO_ROOT" || true)"
fi
[ -n "$DEV_PASSWORD" ] || die 'known-session proof requires E2E_USER_PASSWORD or a canonical admin password'
curl -fsS -m 10 "${EXT_BASE}/health" >/dev/null || die 'external-rest-api unavailable'
curl -fsS -m 10 "${RPC_BASE}/health" >/dev/null || die 'rpc-proxy unavailable'
login="$(curl -fsS -m 20 -X POST "${EXT_BASE}/api/v1/auth/password-login" \
  -H 'Content-Type: application/json' -d "$(jq -cn --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p}')")" ||
  die 'E2E user login failed'
SESSION_TOKEN="$(jq -er '.token' <<<"$login")" || die 'login returned no token'
mint_rpc_token() {
  local body
  # The existing messages route uses wakeAndHold when the stateless Host is
  # suspended. Keep wake capability on this user token so the baseline message
  # can take that supported Desktop-to-rpc-proxy path when it is needed.
  body="$(curl -fsS -m 20 -X POST "${EXT_BASE}/api/v1/rpc/token" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg host "$HOST_REF" '{hostRefs:[$host],scopes:["host:message:invoke","host:session:read","host:status:read","host:health:read","host:wake:write"]}')")" || return 1
  RPC_TOKEN="$(jq -er '.token' <<<"$body")"
}
mint_rpc_token || die 'could not mint authorized RPC token'
message="$(jq -cn --arg content "Remember ${MARKER}." --arg thread "$THREAD_ID" '{content:$content,threadId:$thread}')"
baseline_accepted=0
for attempt in 1 2 3; do
  mint_rpc_token || die 'could not refresh authorized RPC token'
  response="$(curl -sS -m 120 -w '\n%{http_code}' -X POST "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json' -d "$message")" ||
    die 'baseline message through rpc-proxy failed'
  if [ "${response##*$'\n'}" = 200 ]; then
    baseline_accepted=1
    break
  fi
  if [ "$attempt" = 3 ] || [ "${response##*$'\n'}" != 503 ] ||
    ! jq -e '.code=="host_waking"' <<<"${response%$'\n'*}" >/dev/null; then
    die 'baseline message was not accepted'
  fi
  wait_until 90 'Host wake after retryable response' host_runtime_is_always_on "$HOST_REF" ||
    die 'Host did not wake after retryable response'
done
[ "$baseline_accepted" = 1 ] || die 'baseline message was not accepted'

session_visible() {
  local response status body
  mint_rpc_token || return 1
  response="$(curl -sS -m 30 -w '\n%{http_code}' \
    -H "Authorization: Bearer ${RPC_TOKEN}" \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/sessions/${HOST_REF}/${THREAD_ID}/messages")" || return 1
  status="${response##*$'\n'}" body="${response%$'\n'*}"
  [ "$status" = 200 ] && jq -e --arg marker "$MARKER" \
    'any(.turns[]?; .user_input|contains($marker))' <<<"$body" >/dev/null
}
session_listed() {
  local response status body
  mint_rpc_token || return 1
  response="$(curl -sS -m 30 -w '\n%{http_code}' \
    -H "Authorization: Bearer ${RPC_TOKEN}" \
    "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/sessions?agent=${HOST_REF}&limit=100")" || return 1
  status="${response##*$'\n'}" body="${response%$'\n'*}"
  [ "$status" = 200 ] && jq -e --arg thread "$THREAD_ID" --arg agent "$HOST_REF" \
    'any(.items[]?; .chatId==$thread and .agent==$agent)' <<<"$body" >/dev/null
}
wait_until 30 'baseline session transcript' session_visible || die 'known session was not readable'
wait_until 30 'baseline session list' session_listed || die 'known session was not listed'
wait_until 90 'baseline active Host' host_runtime_is_always_on "$HOST_REF" ||
  die 'Host was not active before fault injection'
baseline="$(kctl get deployment "$HOST_REF" -n "$HOST_NS" -o json)"
baseline_template="$(jq -Sc '.spec.template' <<<"$baseline")"
baseline_pod="$(kctl get pods -n "$HOST_NS" -l "app=${HOST_REF}" -o json |
  jq -er '[.items[]|select(.metadata.deletionTimestamp==null)|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|if length==1 then .[0].metadata.uid else error("pod identity ambiguous") end')"
jq -e '[.spec.template.spec.containers[].env[]? | select(.name=="CLERUM_SESSION_DB_DIR" and .value=="/var/lib/clerum/state")]|length==1' <<<"$baseline" >/dev/null ||
  die 'baseline SQLite directory is not the stateless path'

cache_held_active() {
  local status deployment pod
  status="$(kctl get host "$HOST_REF" -n "$HOST_NS" -o json)" || return 1
  jq -e '[.status.conditions[]?|select(.type=="StatelessEnableRejected")][0] |
    .status=="False" and .reason=="CommunicationChannelCacheUnsynced"' <<<"$status" >/dev/null || return 1
  host_runtime_is_always_on "$HOST_REF" || return 1
  deployment="$(kctl get deployment "$HOST_REF" -n "$HOST_NS" -o json)" || return 1
  [ "$(jq -Sc '.spec.template' <<<"$deployment")" = "$baseline_template" ] || return 1
  pod="$(kctl get pods -n "$HOST_NS" -l "app=${HOST_REF}" -o json |
    jq -er '[.items[]|select(.metadata.deletionTimestamp==null)|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|if length==1 then .[0].metadata.uid else error("pod identity ambiguous") end')" || return 1
  [ "$pod" = "$baseline_pod" ]
}

channel_hold_is_active() {
  local expected_id=$1 pod
  pod="$(hcc_pr_a_proxy_pod)" || return 1
  kctl exec "pod/$pod" -n "$HCC_NS" -c proxy -- node -e \
    'const fs=require("fs");try{const hold=JSON.parse(fs.readFileSync("/churn-ctl/channel-hold.json"));if(hold.id!==process.argv[1]||hold.state!=="held"||!Number.isFinite(hold.deadlineAtMs)||hold.deadlineAtMs<=Date.now())process.exit(1)}catch{process.exit(1)}' \
    "$expected_id" >/dev/null 2>&1
}

renew_channel_hold() {
  local cycle=$1
  hcc_pr_a_command hold-channel 60000 || die "cycle ${cycle}: channel-hold renewal command failed"
  HCC_PR_A_CHANNEL_HOLD_ID="$HCC_PR_A_COMMAND_ID"
  wait_until 5 'selective hold renewal acknowledgement' hcc_pr_a_ack held ||
    die "cycle ${cycle}: channel-hold renewal was not acknowledged"
  wait_until 5 'live selective hold after renewal' channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: renewed channel hold is not active"
}

for cycle in 1 2; do
  before="$(log_count 'CommunicationChannel watch ended;')"
  hcc_pr_a_command hold-channel 60000 || die "cycle ${cycle}: fault command failed"
  HCC_PR_A_CHANNEL_HOLD_ID="$HCC_PR_A_COMMAND_ID"
  wait_until 5 'selective hold acknowledgement' hcc_pr_a_ack held ||
    die "cycle ${cycle}: no live channel watch was cut"
  wait_until 5 'live selective hold' channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: channel hold is not active"
  wait_log_count 'CommunicationChannel watch ended;' "$((before + 1))" 20 ||
    die "cycle ${cycle}: HCC did not lose channel authority"
  wait_until 30 'reconciliation while channel cache is unsynced' cache_held_active ||
    die "cycle ${cycle}: active stateless Host did not converge during watch loss"
  channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: channel hold expired during cache reconciliation"
  renew_channel_hold "$cycle"
  channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: channel hold expired before session transcript read"
  session_visible || die "cycle ${cycle}: known session unavailable through rpc-proxy"
  channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: channel hold expired during session transcript read"
  renew_channel_hold "$cycle"
  channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: channel hold expired before session list read"
  session_listed || die "cycle ${cycle}: known session absent from authorized list"
  channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||
    die "cycle ${cycle}: channel hold expired during session list read"
  cache_held_active || die "cycle ${cycle}: template, SQLite path or pod identity changed"
  hcc_pr_a_command release-channel || die "cycle ${cycle}: release command failed"
  wait_until 5 'selective release acknowledgement' hcc_pr_a_ack released ||
    die "cycle ${cycle}: release was not acknowledged"
  wait_until 30 'CommunicationChannel watch recovery' wait_host_mode "$HOST_REF" accepted 1 ||
    die "cycle ${cycle}: channel authority did not recover"
  ok "cycle ${cycle}: reconciled active stateless Host, stable template/pod and readable session"
done
assert_hcc_identity
ok 'two selective watch-loss cycles completed without HCC restart'
