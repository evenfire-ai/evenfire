#!/usr/bin/env bash
# Branch-owned live gate for #825: one storage layout across lifecycle switches.
#
# Every Host mounts its workspace PVC root at the workspace path and keeps its
# conversation database there (CLERUM_SESSION_DB_DIR=<workspacePath>), whatever
# its lifecycle. A `workspace-layout-merge` init container moves a PVC split by
# the earlier stateless template back to the root before mcp-host starts.
#
# Each scenario creates its own Hosts through the control-api admin API and
# changes them only through that API. The trap deletes them. Named fixtures
# (logged as FAULT:<name>) are the only other cluster writes:
#   - hcc-cadence: shortens the HCC idle window so stateless Hosts suspend in
#     about a minute (opt-in E2E_ALLOW_STATELESS_CADENCE_ACCELERATION=1),
#     restored in the trap;
#   - pvc-fixture: a short-lived Pod (the Host image, uid 1001, no token) that
#     mounts a Host PVC to list it or, on a suspended Host, to seed a tree;
#   - channel: a CommunicationChannel CR that makes HCC run a stateless Host
#     as stateful.
# No kubectl exec into Host Pods, no SQLite writes, no apply/patch of Hosts or
# their Deployments.
#
# Scenarios: S1-S7 (plan A7.10), RACE (A7.13), NEG_RV (stale resourceVersion),
# NEG_CTRL (the history and chatId-set oracles reject an empty catalog). After
# every transition the Host must list the same non-empty chatId set as before
# it and open the same database (its "[ConversationStore] opened" log line);
# each check prints E2E_825_CONTINUITY. The final line is
# E2E_825_RESULT=PASS only when every defined scenario ran and passed.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/e2e/load-dotenv.sh
source "${REPO_ROOT}/scripts/e2e/load-dotenv.sh"
dotenv_load_canonical_root "${REPO_ROOT}"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${REPO_ROOT}/scripts/e2e/admin-credentials.sh"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"

die() { fail "$*"; exit 1; }

# ─── Preconditions ────────────────────────────────────────────────────
if [ -z "$E2E_KUBECONTEXT" ] || ! is_branch_scoped_e2e_context "$E2E_KUBECONTEXT"; then
  die 'select an explicit branch-scoped Minikube context (KUBECONTEXT=<profile>)'
fi
require_safe_kube_context
[ "${E2E_ALLOW_STATELESS_CADENCE_ACCELERATION:-0}" = 1 ] ||
  die 'set E2E_ALLOW_STATELESS_CADENCE_ACCELERATION=1 (S4-S7 shorten the HCC idle window on this owned profile)'
[ -n "${E2E_PROFILE_PORTS_ENV:-}" ] && [ -r "$E2E_PROFILE_PORTS_ENV" ] ||
  die 'provide E2E_PROFILE_PORTS_ENV from the owned branch profile'
[ -n "${E2E_DEV_LOGIN_EMAIL:-}" ] || die 'set E2E_DEV_LOGIN_EMAIL to the seeded login (admin@evenfire.local on a T2 profile)'
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

HOST_NS=mcp-host CHANNEL_NS=channels
HCC_NS=control-plane HCC_DEPLOY=host-context-controller
SOURCE_HOST="${E2E_SOURCE_HOST_REF:-chatllm}"
CAPI="${CONTROL_API_BASE_URL%/}/api/v1"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL%/}"
RPC_BASE="${RPC_PROXY_BASE_URL%/}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
[ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(e2e_resolve_admin_password "$REPO_ROOT" || true)"
[ -n "$ADMIN_PASSWORD" ] || die 'admin password could not be resolved (ADMIN_PASSWORD or the canonical .env)'
DEV_EMAIL="$E2E_DEV_LOGIN_EMAIL"
DEV_PASSWORD="${E2E_USER_PASSWORD:-$ADMIN_PASSWORD}"
# od reads a fixed byte count; `tr </dev/urandom | head` dies of SIGPIPE under pipefail.
RUN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
POD_READY_TIMEOUT="${E2E_825_POD_READY_TIMEOUT:-300}"
SUSPEND_TIMEOUT="${E2E_825_SUSPEND_TIMEOUT:-300}"
TURN_TIMEOUT="${E2E_825_TURN_TIMEOUT:-240}"
STORE_LOG_TIMEOUT="${E2E_825_STORE_LOG_TIMEOUT:-30}"
BASE_INIT_FIXTURE="${REPO_ROOT}/host-context-controller/test/__fixtures__/base-workspace-layout-init.sh"
[ -r "$BASE_INIT_FIXTURE" ] || die "missing base init fixture ${BASE_INIT_FIXTURE}"

DEFINED_SCENARIOS=(NEG_CTRL NEG_RV S1 S2 S3 RACE S4 S5 S6 S7)
EXECUTED=0 SCENARIO_FAILURES=0 SCENARIO_LOG=''
CREATED_HOSTS=() CREATED_CHANNELS=()
HCC_ENV_SAVED='' HCC_ENV_CHANGED=0
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/e2e-825.XXXXXX")"
FIXTURE_POD_REGISTRY="${SCRATCH}/fixture-pods"
: >"$FIXTURE_POD_REGISTRY"
ADMIN_COOKIE='' SESSION_TOKEN='' RPC_TOKEN='' USER_ID='' TEAM_ID=''
HTTP_CODE='' HTTP_BODY='' HTTP_HEADERS=()

# ─── HTTP ─────────────────────────────────────────────────────────────
# http METHOD URL [BODY] [MAX_SECONDS] → HTTP_CODE, HTTP_BODY. A transport
# failure is HTTP_CODE=000 and a non-zero return. The body goes to curl on
# stdin, never in argv, because login bodies carry passwords.
http() {
  local method=$1 url=$2 body=${3:-} max=${4:-60} resp
  local args=(-sS -m "$max" -w '\n%{http_code}' -X "$method" "$url")
  [ ${#HTTP_HEADERS[@]} -eq 0 ] || args+=("${HTTP_HEADERS[@]}")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary @-)
  if ! resp="$(printf '%s' "$body" | curl "${args[@]}")"; then
    HTTP_CODE=000 HTTP_BODY=''
    return 1
  fi
  HTTP_CODE="$(tail -n1 <<<"$resp")"
  HTTP_BODY="$(sed '$d' <<<"$resp")"
}
# auth_header KIND LINE: write one header line to a 0600 file under $SCRATCH
# and print its path. Credentials reach curl through `-H @file`, never argv,
# where any local user can read them with ps.
auth_header() {
  local file="${SCRATCH}/${1}.header"
  (umask 077 && printf '%s\n' "$2" >"$file")
  printf '%s' "$file"
}
admin() { HTTP_HEADERS=(-H "@$(auth_header admin "Cookie: control_ui_admin_session=${ADMIN_COOKIE}")"); http "$@"; }
rpc() { HTTP_HEADERS=(-H "@$(auth_header rpc "Authorization: Bearer ${RPC_TOKEN}")"); http "$@"; }

admin_login() {
  local headers="${SCRATCH}/admin-login.headers" line cookie
  HTTP_HEADERS=(-D "$headers")
  http POST "${CAPI}/admin/auth/login" \
    "$(jq -cn --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" '{username:$u,password:$p}')" || true
  [[ "$HTTP_CODE" =~ ^2 ]] || { fail "admin login returned ${HTTP_CODE}"; return 1; }
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$(tr '[:upper:]' '[:lower:]' <<<"$line")" in
      set-cookie:*control_ui_admin_session=*)
        cookie="${line#*control_ui_admin_session=}"
        ADMIN_COOKIE="${cookie%%;*}"
        ;;
    esac
  done <"$headers"
  rm -f "$headers"
  [ -n "$ADMIN_COOKIE" ] || { fail 'admin login set no control_ui_admin_session cookie'; return 1; }
}

user_login() {
  HTTP_HEADERS=()
  http POST "${EXT_BASE}/api/v1/auth/password-login" \
    "$(jq -cn --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p}')" || true
  [ "$HTTP_CODE" = 200 ] || { fail "password login for ${DEV_EMAIL} returned ${HTTP_CODE} (a 429 means the lockout window; wait, do not retry blindly)"; return 1; }
  SESSION_TOKEN="$(jq -er '.token' <<<"$HTTP_BODY")" || { fail 'password login returned no token'; return 1; }
}

# The rpc token names every Host this run created so far.
mint_rpc_token() {
  local refs
  refs="$(printf '%s\n' "${CREATED_HOSTS[@]}" | jq -R . | jq -cs .)"
  HTTP_HEADERS=(-H "@$(auth_header session "Authorization: Bearer ${SESSION_TOKEN}")")
  http POST "${EXT_BASE}/api/v1/rpc/token" "$(jq -cn --argjson refs "$refs" '{hostRefs:$refs,scopes:[
    "host:message:invoke","host:session:read","host:status:read","host:health:read",
    "host:wake:write","host:model:write"]}')" || true
  [[ "$HTTP_CODE" =~ ^2 ]] || { fail "rpc token mint returned ${HTTP_CODE}: ${HTTP_BODY}"; return 1; }
  RPC_TOKEN="$(jq -er '.token' <<<"$HTTP_BODY")" || { fail 'rpc token response has no token'; return 1; }
}

# ─── Host lifecycle through the admin API ─────────────────────────────
# PUT /admin/users/:id/agents filters names against the active agent set, so a
# just-created Host can lag; retry until the response echoes it back.
set_agent_grant() {
  local url=$1 name=$2 op=$3 attempt=1 names expected
  while :; do
    admin GET "$url" || true
    [ "$HTTP_CODE" = 200 ] || { fail "GET ${url} returned ${HTTP_CODE}"; return 1; }
    expected="$(jq -c '((.agentNames // []) + (.deletedAgentNames // []))' <<<"$HTTP_BODY")"
    if [ "$op" = add ]; then
      names="$(jq -c --arg a "$name" '((.agentNames // []) + [$a]) | unique' <<<"$HTTP_BODY")"
    else
      names="$(jq -c --arg a "$name" '(.agentNames // []) - [$a]' <<<"$HTTP_BODY")"
    fi
    admin PUT "$url" "$(jq -cn --argjson n "$names" --argjson e "$expected" \
      '{agentNames:$n,expectedCurrentAgentNames:$e}')" || true
    if [[ "$HTTP_CODE" =~ ^2 ]]; then
      if [ "$op" = remove ] ||
        jq -e --arg a "$name" '(.agentNames // []) | index($a) != null' <<<"$HTTP_BODY" >/dev/null; then
        return 0
      fi
    fi
    [ "$attempt" -lt 20 ] || { fail "${op} grant '${name}' on ${url} did not converge (${HTTP_CODE})"; return 1; }
    attempt=$((attempt + 1))
    sleep 3
  done
}

grant_host() {
  set_agent_grant "${CAPI}/admin/users/${USER_ID}/agents" "$1" add || return 1
  [ -z "$TEAM_ID" ] || set_agent_grant "${CAPI}/admin/teams/${TEAM_ID}/agents" "$1" add
}

# create_host NAME STATELESS(true|false): clones the seeded source Host's spec
# (context, secret, model) without desktop or channels and creates it via the API.
create_host() {
  local name=$1 stateless=$2 spec
  spec="$(jq -c --arg n "$name" --argjson s "$stateless" '
    .spec + {host:$n} | del(.channels) | del(.desktop)
    | .lifecycle = {stateless:$s}' <<<"$SOURCE_HOST_JSON")"
  admin POST "${CAPI}/admin/hosts" "$(jq -cn --arg n "$name" --argjson s "$spec" '{metadata:{name:$n},spec:$s}')" || true
  [ "$HTTP_CODE" = 201 ] || { fail "create Host ${name} returned ${HTTP_CODE}: ${HTTP_BODY}"; return 1; }
  CREATED_HOSTS+=("$name")
  grant_host "$name" || return 1
  mint_rpc_token
}

# set_lifecycle NAME STATELESS(true|false): GET then PUT with the read's
# resourceVersion, echoing the full spec as Control UI does.
set_lifecycle() {
  local name=$1 stateless=$2 rv spec
  admin GET "${CAPI}/admin/hosts/${name}" || true
  [ "$HTTP_CODE" = 200 ] || { fail "GET Host ${name} returned ${HTTP_CODE}"; return 1; }
  rv="$(jq -er '.metadata.resourceVersion' <<<"$HTTP_BODY")" || { fail "Host ${name} read has no resourceVersion"; return 1; }
  spec="$(jq -c --argjson s "$stateless" '.spec | .lifecycle = {stateless:$s}' <<<"$HTTP_BODY")"
  admin PUT "${CAPI}/admin/hosts/${name}" \
    "$(jq -cn --arg rv "$rv" --argjson s "$spec" '{metadata:{resourceVersion:$rv},spec:$s}')" || true
  [ "$HTTP_CODE" = 200 ] || { fail "PUT lifecycle stateless=${stateless} on ${name} returned ${HTTP_CODE}: ${HTTP_BODY}"; return 1; }
  log "lifecycle request on ${name}: stateless=${stateless}"
}

# ─── Pods and the lifecycle witness ───────────────────────────────────
host_pods() { kctl get pods -n "$HOST_NS" -l "app=$1" -o json; }

# wait_new_ready_pod NAME OLD_UID TIMEOUT: exactly one Pod exists, it is Ready,
# and its UID differs from OLD_UID. Sets POD_JSON, POD_UID.
wait_new_ready_pod() {
  local name=$1 old=$2 timeout=$3 elapsed=0 pods
  while [ "$elapsed" -lt "$timeout" ]; do
    if pods="$(host_pods "$name")" && POD_JSON="$(jq -ce --arg old "$old" '
        .items | select(length == 1) | .[0]
        | select(.metadata.deletionTimestamp == null and .metadata.uid != $old)
        | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))' <<<"$pods")"; then
      POD_UID="$(jq -r '.metadata.uid' <<<"$POD_JSON")"
      jq -r '.spec.nodeName' <<<"$POD_JSON" >"${SCRATCH}/${name}.node"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  fail "${name}: no new Ready Pod within ${timeout}s"
  kctl get pods -n "$HOST_NS" -l "app=${name}" -o wide >&2 || true
  kctl describe pods -n "$HOST_NS" -l "app=${name}" 2>&1 | tail -n 40 >&2 || true
  return 1
}

# Storage seen by the running Pod: workspace mounts, storage env, init names.
pod_storage() {
  jq -cS '{
    mounts: [.spec.containers[] | select(.name == "mcp-host") | .volumeMounts[] | select(.name == "workspace")],
    store: ([.spec.containers[] | select(.name == "mcp-host") | .env[]? | select(.name == "CLERUM_SESSION_STORE") | .value] | first),
    dbDir: ([.spec.containers[] | select(.name == "mcp-host") | .env[]? | select(.name == "CLERUM_SESSION_DB_DIR") | .value] | first),
    inits: [.spec.initContainers[]? | .name]
  }' <<<"$POD_JSON"
}

# assert_pod NAME STATELESS WORKSPACE_PATH: lifecycle markers of the new Pod
# match the requested lifecycle and its storage is the one root layout.
assert_pod() {
  local name=$1 stateless=$2 path=$3 env_flag priority merge_exit storage db
  env_flag="$(jq -r '[.spec.containers[] | select(.name == "mcp-host") | .env[]? | select(.name == "CLERUM_STATELESS_LIFECYCLE") | .value] | first // ""' <<<"$POD_JSON")"
  priority="$(jq -r '.spec.priorityClassName // ""' <<<"$POD_JSON")"
  if [ "$stateless" = true ]; then
    [ "$env_flag" = true ] && [ "$priority" = clerum-interactive-host ] ||
      { fail "${name}: Pod is not stateless (env=${env_flag:-<none>} priority=${priority:-<none>})"; return 1; }
  else
    [ -z "$env_flag" ] && [ "$priority" != clerum-interactive-host ] ||
      { fail "${name}: Pod is not stateful (env=${env_flag} priority=${priority})"; return 1; }
  fi
  storage="$(pod_storage)"
  jq -e --arg p "$path" '
    .mounts == [{mountPath:$p, name:"workspace"}] and .store == "sqlite"
    and .dbDir == $p and .inits == ["workspace-layout-merge"]' <<<"$storage" >/dev/null ||
    { fail "${name}: Pod storage is not the root layout: ${storage}"; return 1; }
  merge_exit="$(jq -r '[.status.initContainerStatuses[]? | select(.name == "workspace-layout-merge") | .state.terminated.exitCode] | first // "none"' <<<"$POD_JSON")"
  [ "$merge_exit" = 0 ] || { fail "${name}: workspace-layout-merge exit ${merge_exit}"; return 1; }
  if [ -s "${SCRATCH}/${name}.storage" ] && [ "$(cat "${SCRATCH}/${name}.storage")" != "$storage" ]; then
    fail "${name}: storage changed across the switch: $(cat "${SCRATCH}/${name}.storage") -> ${storage}"
    return 1
  fi
  printf '%s' "$storage" >"${SCRATCH}/${name}.storage"
  db="$(store_path "$name")" || { fail "${name}: no store-opened log line (reason above)"; return 1; }
  [ "$db" = "${path}/state.db" ] || { fail "${name}: mcp-host opened ${db}, expected ${path}/state.db"; return 1; }
  if [ -s "${SCRATCH}/${name}.dbpath" ] && [ "$(cat "${SCRATCH}/${name}.dbpath")" != "$db" ]; then
    fail "${name}: store changed across the switch: $(cat "${SCRATCH}/${name}.dbpath") -> ${db}"
    return 1
  fi
  printf '%s' "$db" >"${SCRATCH}/${name}.dbpath"
  ok "${name}: Pod ${POD_UID:0:8} stateless=${stateless}, root layout at ${path}, merge exit 0, store ${db}"
}

# store_path NAME: the database the running mcp-host opened, read from its one
# "[ConversationStore] opened" log line (kubectl logs, no exec). mcp-host
# writes the line after the worker's first answer, which can come after Pod
# Ready, so the log is re-read for up to STORE_LOG_TIMEOUT seconds. Callers
# run it inside $(...), so the reason goes to stderr and the caller records
# the FAIL.
store_path() {
  local pod lines deadline=$((SECONDS + STORE_LOG_TIMEOUT))
  pod="$(jq -r '.metadata.name' <<<"$POD_JSON")"
  while :; do
    lines="$(kctl logs "$pod" -n "$HOST_NS" -c mcp-host |
      jq -Rr 'fromjson? | select(.msg == "[ConversationStore] opened") | .dbPath')" ||
      { echo "${1}: could not read the mcp-host log of ${pod}" >&2; return 1; }
    if [ -n "$lines" ]; then
      [ "$(wc -l <<<"$lines" | tr -d ' ')" = 1 ] ||
        { echo "${1}: expected one store-opened line in ${pod}, got: ${lines}" >&2; return 1; }
      printf '%s' "$lines"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] ||
      { echo "${1}: expected one store-opened line in ${pod}, got: <none> after ${STORE_LOG_TIMEOUT}s" >&2; return 1; }
    sleep 1
  done
}

# switch_and_witness NAME STATELESS: request the switch, then require a new
# Pod with the requested lifecycle and the same storage as before.
switch_and_witness() {
  local name=$1 stateless=$2 old=$POD_UID
  set_lifecycle "$name" "$stateless" || return 1
  wait_new_ready_pod "$name" "$old" "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" "$stateless" /workspace
}

# ─── Conversations and the history oracle ─────────────────────────────
# history_digest MESSAGES_JSON → "<turns> <sha256>". The oracle refuses an
# empty catalog: zero turns is never a match.
history_digest() {
  local turns sum
  turns="$(jq -r '.turns | length' <<<"$1")"
  sum="$(jq -cS '[.turns[] | {number, user_input, response}]' <<<"$1" | shasum -a 256 | cut -d' ' -f1)"
  printf '%s %s' "$turns" "$sum"
}
history_matches() { # EXPECTED_DIGEST MESSAGES_JSON
  local actual
  actual="$(history_digest "$2")"
  [ "${actual%% *}" -gt 0 ] && [ "$actual" = "$1" ]
}
session_listed() { # SESSIONS_JSON HOST THREAD
  jq -e --arg t "$3" --arg a "$2" '[.items[]? | select(.chatId == $t and .agent == $a)] | length == 1' <<<"$1" >/dev/null
}
# chat_set SESSIONS_JSON HOST → "<n>:<sorted chatIds>" of the Host's sessions.
chat_set() {
  jq -r --arg a "$2" '[.items[]? | select(.agent == $a) | .chatId] | unique | "\(length):\(join(","))"' <<<"$1"
}
# chats_match BEFORE AFTER: the same set on both sides, and not an empty one.
chats_match() { [ "${1%%:*}" -gt 0 ] && [ "$1" = "$2" ]; }

# fetch_messages records nothing; read_messages counts a non-200 as a failure.
fetch_messages() { # HOST THREAD → HTTP_CODE, HTTP_BODY
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/$1/sessions/$1/$2/messages?limit=100" || true
}
read_messages() { # HOST THREAD → HTTP_BODY
  fetch_messages "$1" "$2"
  [ "$HTTP_CODE" = 200 ] || { fail "$1/$2: messages returned ${HTTP_CODE}"; return 1; }
}

# send_turn HOST THREAD CONTENT: a suspended Host answers 503 host_waking
# while it wakes; retry only that, bounded by TURN_TIMEOUT. The turn counts
# only once it is readable with its marker.
send_turn() {
  local host=$1 thread=$2 content=$3 elapsed=0 before
  fetch_messages "$host" "$thread"
  case "$HTTP_CODE" in
    200) before="$(jq -r '.turns | length' <<<"$HTTP_BODY")" ;;
    404) before=0 ;;
    *) fail "${host}/${thread}: messages returned ${HTTP_CODE} before the turn"; return 1 ;;
  esac
  while :; do
    rpc POST "${RPC_BASE}/api/v1/rpc/hosts/${host}/messages" \
      "$(jq -cn --arg c "$content" --arg t "$thread" '{content:$c,threadId:$t}')" "$TURN_TIMEOUT" || true
    [[ "$HTTP_CODE" =~ ^2 ]] && break
    if [ "$HTTP_CODE" = 503 ] && jq -e '.code == "host_waking"' <<<"$HTTP_BODY" >/dev/null 2>&1 &&
      [ "$elapsed" -lt "$TURN_TIMEOUT" ]; then
      sleep 5
      elapsed=$((elapsed + 5))
      continue
    fi
    fail "${host}/${thread}: turn returned ${HTTP_CODE}: ${HTTP_BODY:0:300}"
    return 1
  done
  elapsed=0
  while [ "$elapsed" -lt "$TURN_TIMEOUT" ]; do
    fetch_messages "$host" "$thread"
    if [ "$HTTP_CODE" = 200 ] && jq -e --argjson n "$((before + 1))" --arg c "$content" \
        '(.turns | length) == $n and (.turns[-1].user_input | contains($c))' <<<"$HTTP_BODY" >/dev/null; then
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  fail "${host}/${thread}: turn ${before}+1 not persisted within ${TURN_TIMEOUT}s"
  return 1
}

# seed_history HOST THREADS TURNS: writes conversations and records digests.
seed_history() {
  local host=$1 threads=$2 turns=$3 i j thread
  : >"${SCRATCH}/${host}.threads"
  for i in $(seq 1 "$threads"); do
    thread="e2e-825-${host}-t${i}"
    for j in $(seq 1 "$turns"); do
      send_turn "$host" "$thread" "e2e-825 ${RUN} ${host} thread ${i} turn ${j}: reply with one short sentence." || return 1
    done
    read_messages "$host" "$thread" || return 1
    printf '%s %s\n' "$thread" "$(history_digest "$HTTP_BODY")" >>"${SCRATCH}/${host}.threads"
  done
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${host}/sessions?agent=${host}&limit=100" || true
  [ "$HTTP_CODE" = 200 ] || { fail "${host}: sessions returned ${HTTP_CODE}"; return 1; }
  chat_set "$HTTP_BODY" "$host" >"${SCRATCH}/${host}.chats"
  ok "${host}: ${threads} conversation(s) x ${turns} turn(s) written"
}

# assert_history HOST TRANSITION: the Host lists the same chatId set as before
# the transition; every recorded conversation is unchanged; then a resume turn
# is persisted with the next turn number.
assert_history() {
  local host=$1 transition=$2 thread digest sessions before after next=''
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${host}/sessions?agent=${host}&limit=100" || true
  [ "$HTTP_CODE" = 200 ] || { fail "${host}: sessions returned ${HTTP_CODE}"; return 1; }
  sessions="$HTTP_BODY"
  before="$(cat "${SCRATCH}/${host}.chats")"
  after="$(chat_set "$sessions" "$host")"
  chats_match "$before" "$after" ||
    { fail "${host} ${transition}: chatId set before=${before} after=${after}"; return 1; }
  echo "E2E_825_CONTINUITY ${host} ${transition} before=${before} after=${after} dbPath=$(cat "${SCRATCH}/${host}.dbpath")"
  while read -r thread digest; do
    session_listed "$sessions" "$host" "$thread" || { fail "${host}/${thread}: not in the session list"; return 1; }
    read_messages "$host" "$thread" || return 1
    history_matches "$digest" "$HTTP_BODY" ||
      { fail "${host}/${thread}: history changed (expected ${digest}, got $(history_digest "$HTTP_BODY"))"; return 1; }
    send_turn "$host" "$thread" "e2e-825 ${RUN} resume ${thread}: reply with one short sentence." || return 1
    read_messages "$host" "$thread" || return 1
    next+="${thread} $(history_digest "$HTTP_BODY")"$'\n'
  done <"${SCRATCH}/${host}.threads"
  printf '%s' "$next" >"${SCRATCH}/${host}.threads"
  ok "${host}: history listed, unchanged and resumed ($(wc -l <"${SCRATCH}/${host}.threads" | tr -d ' ') conversation(s))"
}

# ─── FAULT:pvc-fixture ────────────────────────────────────────────────
# pvc_fixture HOST ro|rw LABEL SCRIPT [ARGS...]: runs SCRIPT with the PVC root
# as $1 in a Pod on the Host's last node. The Pod output goes to stdout; the
# log and failure lines go to stderr so a caller capturing stdout reads only it.
pvc_fixture() {
  local host=$1 mode=$2 label=$3 script=$4 pod node ro body elapsed=0 phase
  shift 4
  pod="$(truncate_rfc1123 "e2e825-${label}-${host}")"
  node="$(cat "${SCRATCH}/${host}.node")"
  ro=false
  [ "$mode" = ro ] && ro=true
  log "FAULT:pvc-fixture ${label} on ${host}-workspace (${mode})" >&2
  body="$(jq -cn --arg pod "$pod" --arg ns "$HOST_NS" --arg node "$node" --arg image "$FIXTURE_IMAGE" \
    --arg claim "${host}-workspace" --argjson ro "$ro" --arg script "$script" \
    --args '{
      apiVersion:"v1", kind:"Pod",
      metadata:{name:$pod, namespace:$ns, labels:{purpose:"e2e-825-pvc-fixture"}},
      spec:{
        restartPolicy:"Never", automountServiceAccountToken:false, enableServiceLinks:false,
        terminationGracePeriodSeconds:0, nodeName:$node,
        securityContext:{runAsUser:1001, runAsGroup:1001, runAsNonRoot:true, seccompProfile:{type:"RuntimeDefault"}},
        containers:[{
          name:"fixture", image:$image, imagePullPolicy:"IfNotPresent",
          command:(["/bin/sh","-c",$script,"fixture","/mnt/pvc"] + $ARGS.positional),
          resources:{requests:{cpu:"10m",memory:"32Mi"}, limits:{cpu:"200m",memory:"128Mi"}},
          securityContext:{allowPrivilegeEscalation:false, readOnlyRootFilesystem:true, capabilities:{drop:["ALL"]}},
          volumeMounts:[{name:"pvc", mountPath:"/mnt/pvc", readOnly:$ro}]
        }],
        volumes:[{name:"pvc", persistentVolumeClaim:{claimName:$claim, readOnly:$ro}}]
      }}' "$@")"
  # Callers usually run this function inside $(...), so an array append would
  # be lost with the subshell; the registry file is what cleanup() reads.
  # Registered before the create so a create that times out after the API
  # accepted it is still cleaned up.
  printf '%s\n' "$pod" >>"$FIXTURE_POD_REGISTRY"
  kctl create -f - <<<"$body" >/dev/null || { fail "${label}: fixture Pod create failed" >&2; return 1; }
  while [ "$elapsed" -lt 180 ]; do
    phase="$(kctl get pod "$pod" -n "$HOST_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in Succeeded | Failed) break ;; esac
    sleep 2
    elapsed=$((elapsed + 2))
  done
  kctl logs "$pod" -n "$HOST_NS" >"${SCRATCH}/${pod}.log" 2>&1 || true
  # A Pod left behind keeps the RWO claim attached to its node and blocks the
  # next fixture or Host Pod on another node, so a failed delete fails the step.
  if ! kctl delete pod "$pod" -n "$HOST_NS" --wait=true --timeout=60s >/dev/null 2>&1; then
    fail "${label}: fixture Pod ${pod} delete failed" >&2
    return 1
  fi
  if [ "$phase" != Succeeded ]; then
    fail "${label}: fixture Pod ended ${phase:-<timeout>}: $(tail -n 5 "${SCRATCH}/${pod}.log")" >&2
    return 1
  fi
  cat "${SCRATCH}/${pod}.log"
}

# Listing of the PVC root: `<type> <path>`, plus ` <target>` for a symlink,
# lost+found pruned. The fixture image has busybox find, which lacks -printf.
# shellcheck disable=SC2016 # expanded inside the fixture Pod
LIST_SCRIPT='cd "$1" && find . -path ./lost+found -prune -o -print | while IFS= read -r p; do
  if [ -L "$p" ]; then printf "l %s %s\n" "$p" "$(readlink "$p")"
  elif [ -d "$p" ]; then printf "d %s\n" "$p"
  else printf "f %s\n" "$p"; fi
done | LC_ALL=C sort'
# shellcheck disable=SC2016
HASH_SCRIPT='cd "$1" && find . -path ./lost+found -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum'
# shellcheck disable=SC2016
WRITE_FILE_SCRIPT='mkdir -p "$1/e2e-825" && printf "%s\n" "$2" > "$1/e2e-825/$3"'
# shellcheck disable=SC2016
READ_FILE_SCRIPT='cat "$1/e2e-825/$2"'
# The inventoried dev split shape: DB family and a backup under state/, every
# other root entry under workspace/, plus an agent-made symlink (A7.16).
# shellcheck disable=SC2016
SEED_SPLIT_SCRIPT='set -eu; cd "$1"; mkdir state workspace
for e in * .[!.]*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  case "$e" in lost+found|state|workspace) continue ;; state.db*) mv "$e" state/ ;; *) mv "$e" workspace/ ;; esac
done
cp state/state.db state/state.db.pre-20261014.bak
ln -s /tmp/e2e-825-link-target workspace/e2e-825-link
ls -la state workspace'
# Two live database families: the root one and a copy under state/ (F2),
# with workspace/ present so the tree carries the split-layout signature and
# a file under each directory the merge would move.
# shellcheck disable=SC2016
SEED_TWO_DB_SCRIPT='set -eu; cd "$1"; mkdir state workspace; cp state.db state/state.db
printf "notes\n" > state/notes.txt; printf "x\n" > workspace/x; ls -la . state workspace'

read_seed_file() { # HOST NAME EXPECTED
  local got
  got="$(pvc_fixture "$1" ro read-file "$READ_FILE_SCRIPT" "$2")" || return 1
  [ "$got" = "$3" ] || { fail "$1: seeded file e2e-825/$2 reads '${got}', expected '$3'"; return 1; }
  ok "$1: seeded file e2e-825/$2 intact at the PVC root"
}

# ─── Suspend and wake ─────────────────────────────────────────────────
wait_suspended() { # HOST: state suspended, replicas 0, zero Pods (Terminating included)
  local host=$1 elapsed=0 state reps pods
  log "FAULT:hcc-cadence waiting for ${host} to suspend"
  while [ "$elapsed" -lt "$SUSPEND_TIMEOUT" ]; do
    state="$(kctl get host "$host" -n "$HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true)"
    reps="$(kctl get deployment "$host" -n "$HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
    pods="$(host_pods "$host" | jq '.items | length')" || pods=unknown
    if [ "$state" = suspended ] && [ "$reps" = 0 ] && [ "$pods" = 0 ]; then
      ok "${host}: suspended with zero Pods"
      POD_UID=''
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  fail "${host}: not suspended within ${SUSPEND_TIMEOUT}s (state=${state:-<none>} replicas=${reps:-?} pods=${pods})"
  return 1
}

post_wake() { # HOST
  rpc POST "${RPC_BASE}/api/v1/rpc/hosts/$1/wake" || true
  case "$HTTP_CODE" in 200 | 202 | 204) log "wake requested for $1" ;; *)
    fail "$1: wake returned ${HTTP_CODE}: ${HTTP_BODY}"
    return 1
    ;;
  esac
}

set_hcc_cadence() {
  local keys=(CONTEXT_MAPPER_STATELESS_IDLE_MINUTES CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES
    CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS CONTEXT_MAPPER_HEARTBEAT_POLL_MS) k
  HCC_ENV_SAVED=''
  for k in "${keys[@]}"; do
    HCC_ENV_SAVED+="${k}=$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${k}')].value}")"$'\n'
  done
  log 'FAULT:hcc-cadence idle 1 min, drain 20 s, heartbeat poll 5 s'
  HCC_ENV_CHANGED=1
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
    CONTEXT_MAPPER_STATELESS_IDLE_MINUTES=1 CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES=1 \
    CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS=20000 CONTEXT_MAPPER_HEARTBEAT_POLL_MS=5000 >/dev/null ||
    { fail 'hcc-cadence: kubectl set env failed'; return 1; }
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null ||
    { fail 'hcc-cadence: HCC rollout did not settle'; return 1; }
}

restore_hcc_cadence() {
  local args=() key val actual
  [ "$HCC_ENV_CHANGED" = 1 ] || return 0
  while IFS='=' read -r key val; do
    [ -n "$key" ] || continue
    if [ -n "$val" ]; then args+=("${key}=${val}"); else args+=("${key}-"); fi
  done <<<"$HCC_ENV_SAVED"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" "${args[@]}" >/dev/null || return 1
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null || return 1
  while IFS='=' read -r key val; do
    [ -n "$key" ] || continue
    actual="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${key}')].value}")"
    [ "$actual" = "$val" ] || { echo "HCC ${key} restored to '${actual}', expected '${val}'" >&2; return 1; }
  done <<<"$HCC_ENV_SAVED"
  HCC_ENV_CHANGED=0
  log 'FAULT:hcc-cadence restored'
}

# A new stateless Host with history, a seeded file, then suspended.
suspended_host_with_history() { # NAME
  create_host "$1" true || return 1
  wait_new_ready_pod "$1" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$1" true /workspace || return 1
  seed_history "$1" 2 1 || return 1
  pvc_fixture "$1" rw seed-file "$WRITE_FILE_SCRIPT" "seed ${RUN}" seed.txt >/dev/null || return 1
  wait_suspended "$1"
}

# ─── Scenarios ────────────────────────────────────────────────────────
scenario_NEG_CTRL() {
  local digest set_a empty='{"agent":"x","chatId":"y","totalTurns":0,"turns":[]}'
  local real='{"turns":[{"number":1,"user_input":"a","response":"b"}]}'
  digest="$(history_digest "$real")"
  history_matches "$digest" "$real" || { fail 'NEG_CTRL witness: the oracle rejects a matching history'; return 1; }
  if history_matches "$digest" "$empty"; then fail 'NEG_CTRL: the history oracle accepts an empty catalog'; return 1; fi
  if history_matches "0 $(jq -cS '[]' <<<'null' | shasum -a 256 | cut -d' ' -f1)" "$empty"; then
    fail 'NEG_CTRL: the history oracle accepts zero turns as a match'
    return 1
  fi
  session_listed '{"items":[{"agent":"h","chatId":"t"}]}' h t || { fail 'NEG_CTRL witness: list oracle rejects a listed session'; return 1; }
  if session_listed '{"items":[]}' h t; then fail 'NEG_CTRL: the list oracle accepts an empty catalog'; return 1; fi
  set_a="$(chat_set '{"items":[{"agent":"h","chatId":"b"},{"agent":"h","chatId":"a"},{"agent":"x","chatId":"c"}]}' h)"
  [ "$set_a" = '2:a,b' ] || { fail "NEG_CTRL witness: chat_set returned '${set_a}', expected '2:a,b'"; return 1; }
  chats_match "$set_a" "$set_a" || { fail 'NEG_CTRL witness: the set oracle rejects an equal set'; return 1; }
  if chats_match "$set_a" "$(chat_set '{"items":[{"agent":"h","chatId":"a"}]}' h)"; then
    fail 'NEG_CTRL: the set oracle accepts a lost chat'
    return 1
  fi
  if chats_match "$(chat_set '{"items":[]}' h)" "$(chat_set '{"items":[]}' h)"; then
    fail 'NEG_CTRL: the set oracle accepts an empty set on both sides'
    return 1
  fi
  ok 'NEG_CTRL: oracles reject an empty catalog, a lost chat and empty-on-both-sides, and accept a real one'
}

scenario_NEG_RV() {
  local name rv1 spec
  name="$(truncate_rfc1123 "e2e-825-rv-${RUN}")"
  create_host "$name" false || return 1
  admin GET "${CAPI}/admin/hosts/${name}" || true
  [ "$HTTP_CODE" = 200 ] || { fail "NEG_RV: GET returned ${HTTP_CODE}"; return 1; }
  rv1="$(jq -r '.metadata.resourceVersion' <<<"$HTTP_BODY")"
  spec="$(jq -c '.spec | .lifecycle = {stateless:true}' <<<"$HTTP_BODY")"
  admin PUT "${CAPI}/admin/hosts/${name}" "$(jq -cn --arg rv "$rv1" --argjson s "$spec" '{metadata:{resourceVersion:$rv},spec:$s}')" || true
  [ "$HTTP_CODE" = 200 ] || { fail "NEG_RV witness: fresh PUT returned ${HTTP_CODE}"; return 1; }
  spec="$(jq -c '.lifecycle = {stateless:false}' <<<"$spec")"
  admin PUT "${CAPI}/admin/hosts/${name}" "$(jq -cn --arg rv "$rv1" --argjson s "$spec" '{metadata:{resourceVersion:$rv},spec:$s}')" || true
  if [ "$HTTP_CODE" != 409 ] || ! jq -e '.reason == "resource_changed"' <<<"$HTTP_BODY" >/dev/null; then
    fail "NEG_RV: stale PUT returned ${HTTP_CODE}: ${HTTP_BODY}"
    return 1
  fi
  [ "$(kctl get host "$name" -n "$HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}')" = true ] ||
    { fail 'NEG_RV: the stale PUT changed the lifecycle'; return 1; }
  ok 'NEG_RV: stale resourceVersion → 409 resource_changed, lifecycle unchanged; fresh PUT applied'
}

# S1: stateful → stateless → stateful, 3 conversations x 2 turns, a file.
scenario_S1() {
  local name
  name="$(truncate_rfc1123 "e2e-825-s1-${RUN}")"
  create_host "$name" false || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" false /workspace || return 1
  seed_history "$name" 3 2 || return 1
  pvc_fixture "$name" rw seed-file "$WRITE_FILE_SCRIPT" "s1 ${RUN}" seed.txt >/dev/null || return 1
  switch_and_witness "$name" true || return 1
  assert_history "$name" 'stateful->stateless' || return 1
  read_seed_file "$name" seed.txt "s1 ${RUN}" || return 1
  switch_and_witness "$name" false || return 1
  assert_history "$name" 'stateless->stateful' || return 1
  read_seed_file "$name" seed.txt "s1 ${RUN}"
}

# S2: created stateless → stateful → stateless.
scenario_S2() {
  local name
  name="$(truncate_rfc1123 "e2e-825-s2-${RUN}")"
  create_host "$name" true || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  seed_history "$name" 2 2 || return 1
  switch_and_witness "$name" false || return 1
  assert_history "$name" 'stateless->stateful' || return 1
  switch_and_witness "$name" true || return 1
  assert_history "$name" 'stateful->stateless'
}

# S3: a CommunicationChannel makes HCC run the stateless Host as stateful;
# deleting it returns the Host to stateless.
scenario_S3() {
  local name channel old reason elapsed=0
  name="$(truncate_rfc1123 "e2e-825-s3-${RUN}")"
  channel="$(truncate_rfc1123 "e2e-825-s3-${RUN}")"
  create_host "$name" true || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  seed_history "$name" 2 1 || return 1
  log "FAULT:channel ${CHANNEL_NS}/${channel} → ${name}"
  printf '%s\n' 'apiVersion: clerum.io/v1alpha1' 'kind: CommunicationChannel' 'metadata:' \
    "  name: ${channel}" "  namespace: ${CHANNEL_NS}" 'spec:' "  hostRef: ${name}" '  telegram:' \
    "    - channelId: \"e2e-825-${RUN}\"" '      chatType: "private"' '      userIds: ["000000000"]' |
    kctl create -f - >/dev/null || { fail 'S3: CommunicationChannel create failed'; return 1; }
  CREATED_CHANNELS+=("$channel")
  old=$POD_UID
  wait_new_ready_pod "$name" "$old" "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" false /workspace || return 1
  reason="$(kctl get host "$name" -n "$HOST_NS" -o jsonpath='{.status.conditions[?(@.type=="StatelessEnableRejected")].status}')"
  [ "$reason" = True ] || { fail "S3: StatelessEnableRejected is '${reason}', expected True"; return 1; }
  assert_history "$name" 'stateless->stateful(channel)' || return 1
  kctl delete communicationchannel "$channel" -n "$CHANNEL_NS" --wait=true --timeout=60s >/dev/null ||
    { fail 'S3: CommunicationChannel delete failed'; return 1; }
  old=$POD_UID
  wait_new_ready_pod "$name" "$old" "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  assert_history "$name" 'stateful->stateless(channel-deleted)'
}

# S4: switch to stateful while suspended, then back to stateless (history
# checked on the active Pod), suspend and wake.
scenario_S4() {
  local name
  name="$(truncate_rfc1123 "e2e-825-s4-${RUN}")"
  suspended_host_with_history "$name" || return 1
  switch_and_witness "$name" false || return 1
  assert_history "$name" 'suspended->stateful' || return 1
  read_seed_file "$name" seed.txt "seed ${RUN}" || return 1
  switch_and_witness "$name" true || return 1
  # The active stateless Pod between the switch and the suspend serves the
  # same history too, not only the Pod that wakes afterwards.
  assert_history "$name" 'stateful->stateless(active)' || return 1
  wait_suspended "$name" || return 1
  post_wake "$name" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  assert_history "$name" 'stateless-suspend->wake'
}

# S5: the inventoried split tree (state/ with a backup, workspace/ with a
# symlink) merges on wake; history, file, backup and link at the root.
scenario_S5() {
  local name listing
  name="$(truncate_rfc1123 "e2e-825-s5-${RUN}")"
  suspended_host_with_history "$name" || return 1
  pvc_fixture "$name" rw seed-split "$SEED_SPLIT_SCRIPT" >/dev/null || return 1
  listing="$(pvc_fixture "$name" ro list-split "$LIST_SCRIPT")" || return 1
  if ! grep -qx 'd ./state' <<<"$listing" || ! grep -qx 'f ./state/state.db'<<<"$listing"; then
    fail "S5: seeded tree is not split: ${listing}"
    return 1
  fi
  post_wake "$name" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  listing="$(pvc_fixture "$name" ro list-merged "$LIST_SCRIPT")" || return 1
  if grep -Eq '^d \./(state|workspace)$' <<<"$listing"; then fail "S5: split directories remain: ${listing}"; return 1; fi
  if ! grep -qx 'f ./state.db'<<<"$listing" ||
    ! grep -qx 'f ./state.db.pre-20261014.bak'<<<"$listing" ||
    ! grep -qx 'l ./e2e-825-link /tmp/e2e-825-link-target' <<<"$listing"; then
    fail "S5: merged tree lacks the database, backup or link at the root: ${listing}"
    return 1
  fi
  ok "S5: split tree merged to the root"
  assert_history "$name" 'suspend->wake(split-tree-merged)' || return 1
  read_seed_file "$name" seed.txt "seed ${RUN}"
}

# S6: two live database families: the merge refuses, the Pod stays in
# Init:Error and the tree is unchanged.
scenario_S6() {
  local name before after list_before list_after elapsed=0 pod logs
  name="$(truncate_rfc1123 "e2e-825-s6-${RUN}")"
  suspended_host_with_history "$name" || return 1
  pvc_fixture "$name" rw seed-two-db "$SEED_TWO_DB_SCRIPT" >/dev/null || return 1
  before="$(pvc_fixture "$name" ro hash-before "$HASH_SCRIPT")" || return 1
  list_before="$(pvc_fixture "$name" ro list-before "$LIST_SCRIPT")" || return 1
  grep -q ' ./state/state.db$' <<<"$before" || { fail "S6 witness: state/state.db not seeded: ${before}"; return 1; }
  if ! grep -qx 'f ./state/notes.txt' <<<"$list_before" || ! grep -qx 'f ./workspace/x' <<<"$list_before"; then
    fail "S6 witness: state/notes.txt or workspace/x not seeded: ${list_before}"
    return 1
  fi
  post_wake "$name" || return 1
  while [ "$elapsed" -lt "$POD_READY_TIMEOUT" ]; do
    pod="$(host_pods "$name" | jq -r '[.items[] | select(any(.status.initContainerStatuses[]?;
      .name == "workspace-layout-merge" and ((.state.terminated.exitCode // 0) == 1 or (.lastState.terminated.exitCode // 0) == 1)))][0].metadata.name // ""')"
    [ -n "$pod" ] && break
    sleep 3
    elapsed=$((elapsed + 3))
  done
  [ -n "$pod" ] || { fail "S6: no Pod with workspace-layout-merge exit 1 within ${POD_READY_TIMEOUT}s"; return 1; }
  logs="$(kctl logs "$pod" -n "$HOST_NS" -c workspace-layout-merge --previous 2>/dev/null ||
    kctl logs "$pod" -n "$HOST_NS" -c workspace-layout-merge)"
  grep -q 'workspace layout merge refused: more than one live SQLite database across' <<<"$logs" ||
    { fail "S6: merge refused without the F2 line: ${logs}"; return 1; }
  if host_pods "$name" | jq -e 'any(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null; then
    fail 'S6: a Pod became Ready on a refused tree'
    return 1
  fi
  after="$(pvc_fixture "$name" ro hash-after "$HASH_SCRIPT")" || return 1
  [ "$before" = "$after" ] || { fail "S6: tree changed after the refusal"; diff <(echo "$before") <(echo "$after") >&2 || true; return 1; }
  list_after="$(pvc_fixture "$name" ro list-after "$LIST_SCRIPT")" || return 1
  [ "$list_before" = "$list_after" ] ||
    { fail "S6: tree layout changed after the refusal"; diff <(echo "$list_before") <(echo "$list_after") >&2 || true; return 1; }
  ok 'S6: two live families → Init:Error with the F2 line, tree unchanged'
}

# S7: a merged tree re-split by the previous init (an HCC rollback), then
# woken: the merge restores the root layout and the history.
scenario_S7() {
  local name before listing script
  name="$(truncate_rfc1123 "e2e-825-s7-${RUN}")"
  suspended_host_with_history "$name" || return 1
  before="$(pvc_fixture "$name" ro list-before "$LIST_SCRIPT")" || return 1
  script="$(cat "$BASE_INIT_FIXTURE")"
  pvc_fixture "$name" rw base-init "$script" >/dev/null || return 1
  listing="$(pvc_fixture "$name" ro list-split "$LIST_SCRIPT")" || return 1
  if ! grep -qx 'd ./state' <<<"$listing" || ! grep -qx 'd ./workspace' <<<"$listing"; then
    fail "S7: the previous init did not split the tree: ${listing}"
    return 1
  fi
  post_wake "$name" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  listing="$(pvc_fixture "$name" ro list-after "$LIST_SCRIPT")" || return 1
  # Only the live writer's journals may differ: the suspended Host closed its
  # database (no -wal/-shm), the woken one holds it open. state.db itself and
  # any state.db*.bak must match, so a lost or extra backup fails here.
  grep -qx 'f ./state.db' <<<"$listing" || { fail "S7: no state.db at the PVC root after the merge: ${listing}"; return 1; }
  [ "$(grep -vxE 'f \./state\.db-(wal|shm)' <<<"$before")" = "$(grep -vxE 'f \./state\.db-(wal|shm)' <<<"$listing")" ] ||
    { fail 'S7: root entries differ from the tree before the re-split'; diff <(echo "$before") <(echo "$listing") >&2 || true; return 1; }
  ok 'S7: re-split tree merged back to the same root entries'
  assert_history "$name" 'suspend->wake(re-split-tree-merged)' || return 1
  read_seed_file "$name" seed.txt "seed ${RUN}"
}

# RACE: concurrent model selections on new chats create one session each and
# never restart the Host (A7.13).
race_host() { # NAME STATELESS
  local name=$1 stateless=$2 model uid restarts round i chat codes pids pods rpc_header
  create_host "$name" "$stateless" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" "$stateless" /workspace || return 1
  uid=$POD_UID
  restarts="$(jq -r '[.status.containerStatuses[] | select(.name == "mcp-host") | .restartCount] | first' <<<"$POD_JSON")"
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${name}/models" || true
  model="$(jq -er '.hostDefault' <<<"$HTTP_BODY")" || { fail "${name}: models returned ${HTTP_CODE}: ${HTTP_BODY}"; return 1; }
  rpc_header="$(auth_header rpc "Authorization: Bearer ${RPC_TOKEN}")"
  for round in 1 2 3 4 5; do
    chat="e2e-825-race-${RUN}-${round}"
    pids=()
    for i in 1 2 3 4; do
      curl -sS -m 60 -o /dev/null -w '%{http_code}\n' -X POST "${RPC_BASE}/api/v1/rpc/hosts/${name}/model" \
        -H "@${rpc_header}" -H 'Content-Type: application/json' \
        -d "$(jq -cn --arg c "$chat" --arg m "$model" '{chatId:$c,model:$m}')" >"${SCRATCH}/race-${round}-${i}" &
      pids+=("$!")
    done
    for i in "${pids[@]}"; do wait "$i" || true; done
    codes="$(cat "${SCRATCH}"/race-"${round}"-* | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
    [ "$(cat "${SCRATCH}"/race-"${round}"-* | grep -cx 200)" = 4 ] ||
      { fail "${name}: round ${round} model selections returned ${codes}"; return 1; }
    send_turn "$name" "$chat" "e2e-825 ${RUN} race ${round}: reply with one short sentence." || return 1
    rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${name}/sessions?agent=${name}&limit=100" || true
    session_listed "$HTTP_BODY" "$name" "$chat" || { fail "${name}: round ${round} chat not listed exactly once"; return 1; }
  done
  # The original Pod must be the only Pod, not terminating: a replacement
  # leaves the old Pod Terminating next to a new one, and items[0] could be
  # either of them.
  pods="$(host_pods "$name")" || { fail "${name}: could not list Pods after the race"; return 1; }
  POD_JSON="$(jq -c --arg uid "$uid" '[.items[] | select(.metadata.uid == $uid and .metadata.deletionTimestamp == null)] | first // empty' <<<"$pods")"
  [ "$(jq '.items | length' <<<"$pods")" = 1 ] && [ -n "$POD_JSON" ] &&
    [ "$(jq -r '[.status.containerStatuses[] | select(.name == "mcp-host") | .restartCount] | first' <<<"$POD_JSON")" = "$restarts" ] ||
    { fail "${name}: the Pod restarted or was replaced during the race: $(jq -c '[.items[] | {uid: .metadata.uid, deleting: (.metadata.deletionTimestamp != null)}]' <<<"$pods")"; return 1; }
  ok "${name}: 5 rounds x 4 concurrent selections, one session per chat, Pod ${uid:0:8} restartCount ${restarts}"
}
scenario_RACE() {
  race_host "$(truncate_rfc1123 "e2e-825-race-sf-${RUN}")" false || return 1
  race_host "$(truncate_rfc1123 "e2e-825-race-sl-${RUN}")" true
}

run_scenario() {
  local id=$1
  header "Scenario ${id}"
  EXECUTED=$((EXECUTED + 1))
  if "scenario_${id}"; then
    ok "SCENARIO ${id} PASS"
    SCENARIO_LOG+="${id}=PASS "
  else
    fail "SCENARIO ${id} FAIL"
    SCENARIO_LOG+="${id}=FAIL "
    SCENARIO_FAILURES=$((SCENARIO_FAILURES + 1))
  fi
}

# ─── Cleanup ──────────────────────────────────────────────────────────
cleanup() {
  local status=$? failed=0 name pod channel
  # bash 3.2 treats "${empty[@]}" as unbound under set -u.
  set +eu
  while IFS= read -r pod; do
    kctl delete pod "$pod" -n "$HOST_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done <"$FIXTURE_POD_REGISTRY"
  for channel in "${CREATED_CHANNELS[@]}"; do
    kctl delete communicationchannel "$channel" -n "$CHANNEL_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done
  restore_hcc_cadence || { failed=1; echo "HCC cadence restore failed; check deployment/${HCC_DEPLOY}" >&2; }
  for name in "${CREATED_HOSTS[@]}"; do
    admin DELETE "${CAPI}/admin/hosts/${name}" >/dev/null 2>&1
    case "$HTTP_CODE" in 200 | 404) ;; *) failed=1; echo "delete Host ${name} returned ${HTTP_CODE}" >&2 ;; esac
    [ -z "$USER_ID" ] || set_agent_grant "${CAPI}/admin/users/${USER_ID}/agents" "$name" remove >/dev/null 2>&1 || failed=1
    [ -z "$TEAM_ID" ] || set_agent_grant "${CAPI}/admin/teams/${TEAM_ID}/agents" "$name" remove >/dev/null 2>&1 || failed=1
  done
  for name in "${CREATED_HOSTS[@]}"; do
    kctl wait --for=delete "deployment/${name}" -n "$HOST_NS" --timeout=120s >/dev/null 2>&1
    kctl delete pvc "${name}-workspace" -n "$HOST_NS" --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || failed=1
  done
  rm -rf "$SCRATCH"
  [ "$failed" = 0 ] || { status=1; fail 'cleanup left resources behind (see stderr)'; }
  echo "E2E_825_SCENARIOS ${SCENARIO_LOG}"
  echo "E2E_825_EXECUTED=${EXECUTED} E2E_825_DEFINED=${#DEFINED_SCENARIOS[@]}"
  print_results || status=1
  if [ "$status" = 0 ] && [ "$SCENARIO_FAILURES" = 0 ] && [ "$EXECUTED" = "${#DEFINED_SCENARIOS[@]}" ]; then
    echo 'E2E_825_RESULT=PASS'
  else
    echo 'E2E_825_RESULT=FAIL'
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

# ─── Run ──────────────────────────────────────────────────────────────
header "#825 storage layout across lifecycle switches (run ${RUN}, ${E2E_KUBECONTEXT})"
# S5-S7 need HCC to render workspace-layout-merge; its flag defaults to true
# when unset or empty (A7.24). A literal value is the only one checkable here.
MERGE_FLAG="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -o json | jq -r '
  [.spec.template.spec.containers[].env[]? | select(.name == "CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE")]
  | if length == 0 then "<unset>" elif .[0].valueFrom then "<valueFrom>" else (.[0].value // "") end')" ||
  die "could not read deployment/${HCC_DEPLOY}"
case "$MERGE_FLAG" in
  '<unset>' | '' | true) ok "HCC CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE=${MERGE_FLAG:-<empty>} (merge init rendered)" ;;
  *) die "HCC CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE is '${MERGE_FLAG}'; this E2E needs it unset, empty or 'true'" ;;
esac
SOURCE_HOST_JSON="$(kctl get host "$SOURCE_HOST" -n "$HOST_NS" -o json)" || die "source Host ${SOURCE_HOST} not found"
FIXTURE_IMAGE="$(kctl get deployment "$SOURCE_HOST" -n "$HOST_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-host")].image}')"
[ -n "$FIXTURE_IMAGE" ] || die "could not read the ${SOURCE_HOST} image for the PVC fixture"
admin_login || die 'admin login failed'
admin GET "${CAPI}/admin/users?q=$(jq -rn --arg q "$DEV_EMAIL" '$q|@uri')" || true
USER_ID="$(jq -r --arg e "$DEV_EMAIL" '.items[]? | select((.email // "") == $e) | .id' <<<"$HTTP_BODY" | head -n1)"
[ -n "$USER_ID" ] || die "user ${DEV_EMAIL} not found (${HTTP_CODE})"
admin GET "${CAPI}/admin/users/${USER_ID}/teams" || true
TEAM_ID="$(jq -r '.items[0].id // empty' <<<"$HTTP_BODY")"
user_login || die 'user login failed'
ok "logged in as ${DEV_EMAIL}; fixture image ${FIXTURE_IMAGE}"

for id in NEG_CTRL NEG_RV S1 S2 S3 RACE; do run_scenario "$id"; done
header 'Suspended-Host scenarios'
if set_hcc_cadence; then
  for id in S4 S5 S6 S7; do run_scenario "$id"; done
else
  fail 'hcc-cadence fixture failed; S4-S7 not executed'
fi
