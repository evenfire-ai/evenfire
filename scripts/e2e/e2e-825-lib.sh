# shellcheck shell=bash
# Helpers shared by the #825 live gates (e2e-hcc-storage-layout-switch.sh and
# e2e-hcc-layout-upgrade.sh). Sourced after e2e-lib.sh; defines functions and
# fixture scripts only. The caller sets HOST_NS, HCC_NS, HCC_DEPLOY, CAPI,
# EXT_BASE, RPC_BASE, ADMIN_USERNAME, ADMIN_PASSWORD, DEV_EMAIL, DEV_PASSWORD,
# SOURCE_HOST_JSON, SCRATCH, FIXTURE_POD_REGISTRY, FIXTURE_IMAGE, RUN,
# LAYOUT_SCRIPT, the timeouts, and the state below.

# ─── HTTP ─────────────────────────────────────────────────────────────
# http METHOD URL [BODY] [MAX_SECONDS] → HTTP_CODE, HTTP_BODY. A transport
# failure is HTTP_CODE=000 and a non-zero return. The body goes to curl on
# stdin, never in argv, because login bodies carry passwords; the login
# helpers hand the password to jq through its environment for the same reason.
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
    "$(ADMIN_PASSWORD="$ADMIN_PASSWORD" jq -cn --arg u "$ADMIN_USERNAME" '{username:$u,password:env.ADMIN_PASSWORD}')" || true
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
    "$(DEV_PASSWORD="$DEV_PASSWORD" jq -cn --arg e "$DEV_EMAIL" '{email:$e,password:env.DEV_PASSWORD}')" || true
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

read_seed_file() { # HOST NAME EXPECTED
  local got
  got="$(pvc_fixture "$1" ro read-file "$READ_FILE_SCRIPT" "$2")" || return 1
  [ "$got" = "$3" ] || { fail "$1: seeded file e2e-825/$2 reads '${got}', expected '$3'"; return 1; }
  ok "$1: seeded file e2e-825/$2 intact at the PVC root"
}

# ─── Operator script ──────────────────────────────────────────────────
# layout_row inventory|verify HOST EXITS: runs deploy/scripts/host-layout-merge.sh
# on this profile and prints the result of the Host's PVC row. EXITS is a
# space-separated list of accepted exit codes (a `|` inside an expanded case
# pattern is matched literally, not as alternation); the fleet verdict is left
# alone because other Hosts on the profile decide it, and exit 2 (read failure)
# never matches.
layout_row() {
  local cmd=$1 host=$2 exits=$3 rc=0 out row
  out="$(mktemp "${SCRATCH}/layout-${cmd}-${host}.XXXXXX")"
  log "host-layout-merge.sh ${cmd} for ${HOST_NS}/${host}-workspace" >&2
  bash "$LAYOUT_SCRIPT" "$cmd" --context "$E2E_KUBECONTEXT" >"$out" 2>"${out}.err" || rc=$?
  case " ${exits} " in
    *" ${rc} "*) ;;
    *)
      fail "${host}: host-layout-merge.sh ${cmd} exited ${rc} (expected ${exits}): $(tail -n 3 "${out}.err" | tr '\n' ' ') $(tail -n 3 "$out" | tr '\n' ' ')" >&2
      return 1
      ;;
  esac
  [ "$rc" != 2 ] || { fail "${host}: host-layout-merge.sh ${cmd} could not read the cluster" >&2; return 1; }
  row="$(grep -F "PVC ${HOST_NS}/${host}-workspace " "$out")" ||
    { fail "${host}: host-layout-merge.sh ${cmd} printed no row for ${host}-workspace" >&2; return 1; }
  printf '%s\n' "${row#*result=}"
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
