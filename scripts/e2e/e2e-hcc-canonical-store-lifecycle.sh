#!/usr/bin/env bash
# Development runtime/API and visible Desktop gate for #825. Sources start at
# a completed, positively bound legacy floor. This does not certify bootstrap
# of an old/unknown image, Desktop s6, restore/rollback, or unsafe trace capture.
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
CONTRACT="${SCRIPT_DIR}/_lib/canonical-store-lifecycle.mjs"
PROBE="${SCRIPT_DIR}/_lib/canonical-store-runtime-probe.cjs"
CLIENT="${SCRIPT_DIR}/_lib/canonical-store-api.mjs"
if [ "${1:-}" = --help ]; then
  cat <<'HELP'
Development-only gate; noarg runs API, --playwright runs visible Desktop.
Require owned MINIKUBE_PROFILE/KUBECONTEXT, inherited T2 mutation lease,
E2E_BRANCH_PROFILE_ENV/E2E_PROFILE_PORTS_ENV/E2E_EXPECTED_PRE_GATE_GATE.
API: E2E_CANONICAL_HOST_REF/HOST_UID/PVC_UID/RUN_ID.
UI: E2E_CANONICAL_UI_HOST_REF/HOST_UID/PVC_UID/RUN_ID/HOST_DISPLAY/USER_DISPLAY.
API and UI refs, Host UIDs, PVC UIDs and run UUIDs must all be distinct.
Each Host carries e2e.clerum.io/canonical-run=<its UUID>, completed legacy-floor
compatibility, no canonical identity, Linux runtime without SFS.
Required opt-ins: E2E_HCC_WATCH_FAULT_INJECTION=1,
E2E_CANONICAL_WRITER_FAULT=1, QA_RECORDER_CONFIRM_CHAT=1.
Credentials are resolved only by the bound Node client after lease validation:
E2E_DEV_LOGIN_EMAIL/E2E_USER_PASSWORD, E2E_CONTROL_ADMIN_USERNAME/PASSWORD.
UI has E2E_CANONICAL_UI_LOGIN_EMAIL/UI_USER_PASSWORD; no value enters argv/log.
Playwright deadline: E2E_CANONICAL_PLAYWRIGHT_TIMEOUT_SECONDS(default1800),
E2E_CANONICAL_PLAYWRIGHT_KILL_GRACE_SECONDS(default300).
No automatic Host/PVC provision, global keychain operation, trace/video capture.
HELP
  exit 0
fi
MODE="${1:-api}"
[ "$MODE" = api ] || [ "$MODE" = --playwright ] || { echo 'Unsupported argument' >&2; exit 2; }
[ "$#" -le 1 ] || { echo 'Too many arguments' >&2; exit 2; }
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
die() { echo "CANONICAL_STORE_LIFECYCLE_BLOCKED: $*" >&2; exit 1; }
required() { [ -n "${!1:-}" ] || die "Missing $1"; }
for suffix in HOST_REF HOST_UID PVC_UID RUN_ID; do
  required "E2E_CANONICAL_UI_${suffix}"
  if [ "${E2E_CANONICAL_ACTIVE_LANE:-api}" = ui ]; then required "E2E_CANONICAL_API_${suffix}"; else required "E2E_CANONICAL_${suffix}"; fi
done
if [ "${E2E_CANONICAL_ACTIVE_LANE:-api}" = ui ]; then
  API_REF=$E2E_CANONICAL_API_HOST_REF API_UID=$E2E_CANONICAL_API_HOST_UID API_PVC=$E2E_CANONICAL_API_PVC_UID API_RUN=$E2E_CANONICAL_API_RUN_ID
  [ "$E2E_CANONICAL_HOST_REF" = "$E2E_CANONICAL_UI_HOST_REF" ] && [ "$E2E_CANONICAL_HOST_UID" = "$E2E_CANONICAL_UI_HOST_UID" ] &&
    [ "$E2E_CANONICAL_PVC_UID" = "$E2E_CANONICAL_UI_PVC_UID" ] && [ "$E2E_CANONICAL_RUN_ID" = "$E2E_CANONICAL_UI_RUN_ID" ] || die 'UI child binding mismatch'
else
  API_REF=$E2E_CANONICAL_HOST_REF API_UID=$E2E_CANONICAL_HOST_UID API_PVC=$E2E_CANONICAL_PVC_UID API_RUN=$E2E_CANONICAL_RUN_ID
fi
[ "$API_REF" != "$E2E_CANONICAL_UI_HOST_REF" ] && [ "$API_UID" != "$E2E_CANONICAL_UI_HOST_UID" ] &&
  [ "$API_PVC" != "$E2E_CANONICAL_UI_PVC_UID" ] && [ "$API_RUN" != "$E2E_CANONICAL_UI_RUN_ID" ] || die 'API/UI must own two distinct bindings'
for key in MINIKUBE_PROFILE E2E_BRANCH_PROFILE_ENV E2E_PROFILE_PORTS_ENV; do required "$key"; done
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || die 'Node 24 required'
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || die 'Explicit branch-owned context required'
[ "$MINIKUBE_PROFILE" = "$E2E_KUBECONTEXT" ] || die 'Profile/context mismatch'
require_safe_kube_context
[ "${E2E_HCC_WATCH_FAULT_INJECTION:-0}" = 1 ] || die 'Selective watch fault opt-in required'
[ "${E2E_CANONICAL_WRITER_FAULT:-0}" = 1 ] || die 'Slow writer opt-in required'
[ "${QA_RECORDER_CONFIRM_CHAT:-0}" = 1 ] || die 'Real synthetic model turns require confirmation'
profile_port_value() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, "");print;exit}' "$E2E_PROFILE_PORTS_ENV"; }
CONTROL_API_BASE_URL="$(profile_port_value CONTROL_API_URL)"
CONTROL_UI_BASE_URL="$(profile_port_value CONTROL_UI_URL)"
EXTERNAL_REST_API_BASE_URL="$(profile_port_value EXTERNAL_REST_API_URL)"
RPC_PROXY_BASE_URL="$(profile_port_value RPC_PROXY_URL)"
export CONTROL_API_BASE_URL CONTROL_UI_BASE_URL EXTERNAL_REST_API_BASE_URL RPC_PROXY_BASE_URL
require_branch_profile_urls "$E2E_KUBECONTEXT" "$E2E_PROFILE_PORTS_ENV" || die 'Owned endpoint map mismatch'
require_branch_owned_hcc_gate
if [ "$MODE" = --playwright ]; then
  for key in E2E_CANONICAL_UI_HOST_DISPLAY E2E_CANONICAL_UI_USER_DISPLAY E2E_CANONICAL_UI_LOGIN_EMAIL E2E_CANONICAL_UI_USER_PASSWORD; do required "$key"; done
  export E2E_CANONICAL_API_HOST_REF="$API_REF" E2E_CANONICAL_API_HOST_UID="$API_UID" E2E_CANONICAL_API_PVC_UID="$API_PVC" E2E_CANONICAL_API_RUN_ID="$API_RUN"
  export E2E_CANONICAL_HOST_REF="$E2E_CANONICAL_UI_HOST_REF" E2E_CANONICAL_HOST_UID="$E2E_CANONICAL_UI_HOST_UID" E2E_CANONICAL_PVC_UID="$E2E_CANONICAL_UI_PVC_UID" E2E_CANONICAL_RUN_ID="$E2E_CANONICAL_UI_RUN_ID"
  export E2E_CANONICAL_HOST_DISPLAY="$E2E_CANONICAL_UI_HOST_DISPLAY" E2E_CANONICAL_USER_DISPLAY="$E2E_CANONICAL_UI_USER_DISPLAY"
  export E2E_DEV_LOGIN_EMAIL="$E2E_CANONICAL_UI_LOGIN_EMAIL" E2E_USER_PASSWORD="$E2E_CANONICAL_UI_USER_PASSWORD"
  export E2E_CANONICAL_ACTIVE_LANE=ui E2E_CANONICAL_STORE_JOURNEY=1
  cd "$REPO_ROOT/desktop-app"
  exec node "$REPO_ROOT/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds "${E2E_CANONICAL_PLAYWRIGHT_TIMEOUT_SECONDS:-1800}" --kill-grace-seconds "${E2E_CANONICAL_PLAYWRIGHT_KILL_GRACE_SECONDS:-300}" \
    --label canonical-store-ui -- node node_modules/@playwright/test/cli.js test --config test/e2e-playwright/playwright.canonical-store.config.ts
fi
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-fixture.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-assertions.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-assertions.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-pr-a.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-pr-a.sh"
kctl() { "$KUBECTL_BIN" --context "$E2E_KUBECONTEXT" --request-timeout=210s "$@"; }
wait_until() {
  local description=$2 deadline=$((SECONDS + $1)); shift 2
  until "$@"; do [ "$SECONDS" -lt "$deadline" ] || die "Timed out: $description"; sleep 1; done
}
new_uuid() { node -p 'require("node:crypto").randomUUID()'; }
HOST_REF=$E2E_CANONICAL_HOST_REF HOST_UID=$E2E_CANONICAL_HOST_UID PVC_UID=$E2E_CANONICAL_PVC_UID RUN_ID=$E2E_CANONICAL_RUN_ID
HOST_NS=mcp-host HCC_NS=control-plane HCC_DEPLOY=host-context-controller MCP_NS=mcp-server CHANNEL_NS=channels
node -e 'const a=require("node:assert/strict");a.match(process.argv[1],/^[a-z][a-z0-9-]{0,62}$/);a.match(process.argv[2],/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)' "$HOST_REF" "$RUN_ID"
PRIMARY_REPO_ROOT="$(dirname -- "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)")"
EVIDENCE="$PRIMARY_REPO_ROOT/.local-notes/infra/runs/issue-825-${RUN_ID}"
[ ! -e "$EVIDENCE" ] || die 'Fresh isolated run required; evidence already exists'
mkdir -m 700 -p "$EVIDENCE"
SCRATCH="$(mktemp -d /private/tmp/evf-cs.XXXXXXXX)"
SOCKET="$SCRATCH/api.sock" BARRIER="${E2E_CANONICAL_UI_BARRIER_DIR:-}" STEP=0
[ -z "$BARRIER" ] || node "$CONTRACT" barrier "$BARRIER" "$RUN_ID" || die 'UI barrier binding invalid'
PROXY_NAME="$(truncate_rfc1123 "e2e-canonical-${RUN_ID}")" PROBE_NAME="$(truncate_rfc1123 "e2e-canonical-probe-${RUN_ID}")"
PROXY_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-api")" HCC_PROXY_NP="$(truncate_rfc1123 "${PROXY_NAME}-hcc")" PROBE_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-probe")"
FIXTURE_CHANNEL="$(truncate_rfc1123 "e2e-canonical-cc-${RUN_ID}")"
HCC_GATE_LOCK_ACQUIRED=0 HCC_GATE_LOCK_NAME='' HCC_GATE_LOCK_UID='' HCC_GATE_FINALIZATION_FAILURE=''
HCC_PATCHED=0 PROXY_CREATED=0 PROBE_CREATED=0 HCC_PR_A_TLS_CREATED=0 HCC_PR_A_CONFIG_SNAPSHOT='' CHANNEL_CREATED=0
HCC_LOG_BUFFER="$SCRATCH/watch.txt" HCC_LOG_STREAM_PID='' BROKER_PID='' CLAIM_NAME=''
STOPPED_POD='' STOPPED_UID='' STOPPED_PID='' STOPPED_TICKS=''
START_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
api() { printf '%s' "$1" | node "$CLIENT" client "$SOCKET"; }
admin_get() { api '{"operation":"admin-get"}' | jq -ec 'select(.status==200)|.body'; }
admin_request() {
  local operation=$1 body=$2 response id
  id="$(jq -er .requestId <<<"$body")"
  response="$(api "$(jq -cn --arg kind "$operation" --argjson body "$body" '{operation:"admin-post",kind:$kind,body:$body}')")" || die 'Operator transport failed'
  jq -e --arg id "$id" --arg operation "$operation" '(.status==202 or .status==200) and .body.requestId==$id and .body.operation==$operation and .body.storageContract=="canonical" and .body.state=="requested"' <<<"$response" >/dev/null || die 'Exact operator request not acknowledged'
}
rpc_request() { api "$(jq -cn --arg method "$1" --arg route "$2" --argjson body "${3:-null}" '{operation:"rpc",method:$method,route:$route}+(if $body==null then {} else {body:$body} end)')"; }
request_settled() {
  local host state
  host="$(admin_get)" || return 1
  state="$(jq -r --arg id "$1" 'if .status.conversationStore.requestResult.requestId==$id then .status.conversationStore.requestResult.state else "pending" end' <<<"$host")"
  [ "$state" != rejected ] || die 'Controller rejected request; protected maintenance retained'
  [ "$state" = completed ]
}
patch_host() {
  local host patch
  host="$(admin_get)" || die 'Fresh Host read failed'
  patch="$(jq -cn --arg uid "$HOST_UID" --arg rv "$(jq -er .metadata.resourceVersion <<<"$host")" --arg kind "$1" --argjson value "$2" --argjson host "$host" '
    [{op:"test",path:"/metadata/uid",value:$uid},{op:"test",path:"/metadata/resourceVersion",value:$rv}]+(if $kind=="opt-in" then
    [{op:"add",path:"/metadata/annotations",value:(($host.metadata.annotations//{})+{"clerum.io/canonical-store":"enabled"})}]
    else [{op:"add",path:"/spec/lifecycle",value:(($host.spec.lifecycle//{})+{stateless:$value})}] end)')"
  kctl patch host "$HOST_REF" -n "$HOST_NS" --type=json -p "$patch" >/dev/null || die 'Bound Host mutation conflicted'
}
current_pod() { kctl get pods -n "$HOST_NS" -l "app=${HOST_REF}" -o json | jq -er '[.items[]|select(.metadata.deletionTimestamp==null)|select(.status.phase=="Running")|select(any(.status.containerStatuses[]?;.name=="mcp-host" and .state.running!=null))]|if length==1 then .[0].metadata.name else error("ambiguous runtime") end'; }
runtime_probe() { local mode=$1 pod=$2; shift 2; kctl exec -i "$pod" -n "$HOST_NS" -c mcp-host -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node - "$mode" "$HOST_UID" "$PVC_UID" /var/lib/clerum/state "$@" < "$PROBE"; }
runtime_snapshot() {
  local host deployment pods replicasets pvc
  host="$(admin_get)" || return 1
  deployment="$(kctl get deployment "$HOST_REF" -n "$HOST_NS" -o json)" || return 1
  pods="$(kctl get pods -n "$HOST_NS" -l "app=${HOST_REF}" -o json)" || return 1
  replicasets="$(kctl get replicasets -n "$HOST_NS" -l "app=${HOST_REF}" -o json)" || return 1
  pvc="$(kctl get pvc "$CLAIM_NAME" -n "$HOST_NS" -o json)" || return 1
  jq -cn --argjson host "$host" --argjson deployment "$deployment" --argjson pods "$pods" --argjson replicasets "$replicasets" --argjson pvc "$pvc" '{host:$host,deployment:$deployment,pods:$pods,replicasets:$replicasets,pvc:$pvc}' | node "$CONTRACT" snapshot "${2:-}" > "$1"
}
catalog_snapshot() { local pod; pod="$(current_pod)" || return 1; runtime_probe catalog "$pod" > "$1" || return 1; node "$CONTRACT" catalog "$1" "$HOST_UID" "$PVC_UID" "$2"; }
fence_owned() { local pod; pod="$(current_pod)" || return 1; runtime_probe fence "$pod" | jq -e '.fenceBusy==true' >/dev/null; }
cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1 current
  set +e
  if [ -n "$STOPPED_POD" ]; then
    current="$(kctl get pod "$STOPPED_POD" -n "$HOST_NS" --ignore-not-found -o json)"
    if [ -n "$current" ] && [ "$(jq -r .metadata.uid <<<"$current")" = "$STOPPED_UID" ]; then runtime_probe writer-resume "$STOPPED_POD" "$STOPPED_PID" "$STOPPED_TICKS" >/dev/null || cleanup_failed=1; fi
  fi
  [ -z "$HCC_LOG_STREAM_PID" ] || { kill "$HCC_LOG_STREAM_PID" 2>/dev/null; wait "$HCC_LOG_STREAM_PID" 2>/dev/null; }
  [ -z "$BROKER_PID" ] || { kill "$BROKER_PID" 2>/dev/null; wait "$BROKER_PID" 2>/dev/null; }
  if [ "$CHANNEL_CREATED" = 1 ]; then
    current="$(kctl get communicationchannel "$FIXTURE_CHANNEL" -n "$CHANNEL_NS" --ignore-not-found -o json)"
    if [ -n "$current" ] && jq -e --arg run "$RUN_ID" '.metadata.labels["e2e.clerum.io/canonical-run"]==$run' <<<"$current" >/dev/null; then kctl delete communicationchannel "$FIXTURE_CHANNEL" -n "$CHANNEL_NS" --wait=true --timeout=60s >/dev/null || cleanup_failed=1; else cleanup_failed=1; fi
  fi
  if [ "$HCC_PATCHED" = 1 ]; then hcc_pr_a_restore && kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null || restore_ok=0; fi
  if [ "$restore_ok" = 1 ]; then
    [ "$PROXY_CREATED" = 0 ] || delete_hcc_proxy_fixture || cleanup_failed=1
    if [ "$HCC_PR_A_TLS_CREATED" = 1 ]; then
      kctl delete configmap "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null || cleanup_failed=1
      kctl delete secret "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null || cleanup_failed=1
    fi
  fi
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  [ "$cleanup_failed" = 0 ] || status=1
  jq -cn --arg runId "$RUN_ID" --arg context "$E2E_KUBECONTEXT" --arg head "$(git -C "$REPO_ROOT" rev-parse HEAD)" --argjson exit "$status" --argjson cleanupFailed "$cleanup_failed" '{schemaVersion:1,runId:$runId,context:$context,gitHead:$head,exitCode:$exit,cleanupFailed:$cleanupFailed,evidenceLane:"runtime-api",firstFloorBootstrap:"UNPROVEN",desktopS6:"UNPROVEN",restoreRollback:"SEPARATE",traceVideo:"PENDING"}' > "$EVIDENCE/result.json"
  rm -rf -- "$SCRATCH"
  [ "$status" != 0 ] || echo 'CANONICAL_STORE_LIFECYCLE_PASS'
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
node "$CLIENT" broker "$SOCKET" "$HOST_REF" "$E2E_KUBECONTEXT" "$REPO_ROOT" > "$SCRATCH/client-ready.txt" & BROKER_PID=$!
broker_ready() { kill -0 "$BROKER_PID" 2>/dev/null && [ -S "$SOCKET" ] && rg -q '^BOUND_CANONICAL_API_READY$' "$SCRATCH/client-ready.txt"; }
wait_until 40 'bound in-memory API client ready' broker_ready
host="$(admin_get)" || die 'Fresh admin Host read failed'
jq -e --arg uid "$HOST_UID" --arg pvc "$PVC_UID" --arg run "$RUN_ID" '.metadata.uid==$uid and .metadata.labels["e2e.clerum.io/canonical-run"]==$run and (.metadata.annotations["clerum.io/canonical-store"]//"")!="enabled" and (.spec.desktop//false)==false and .spec.lifecycle.stateless==true and .status.conversationStore.compatibility.storageContract=="legacy-floor" and .status.conversationStore.compatibility.pvcUid==$pvc and .status.conversationStore.compatibility.layoutVersion==1 and .status.conversationStore.compatibility.databasePath=="state/state.db" and .status.conversationStore.compatibility.writerFenceRoot=="state" and .status.conversationStore.requestResult.state=="completed" and .status.conversationStore.maintenance.phase=="released" and (.status.conversationStore.layout.storeId//null)==null' <<<"$host" >/dev/null || die 'Dedicated completed legacy-floor Host required'
deployment="$(kctl get deployment "$HOST_REF" -n "$HOST_NS" -o json)"
CLAIM_NAME="$(jq -er '[.spec.template.spec.volumes[]|select(.persistentVolumeClaim!=null)]|if length==1 then .[0].persistentVolumeClaim.claimName else error("PVC ambiguous") end' <<<"$deployment")"
jq -e '[.spec.template.spec.volumes[]|select((.name|startswith("sfs")) or (.name|startswith("shared")))]|length==0' <<<"$deployment" >/dev/null || die 'SFS fixture dimension required; this lane is Linux/no-SFS'
wait_until 90 'ready bound floor runtime' runtime_snapshot "$SCRATCH/floor-runtime.json"
fence_owned || die 'Actual floor runtime fence missing'
catalog_snapshot "$SCRATCH/floor-catalog.json" legacy-floor || die 'Floor catalog/identity diagnostic failed'
THREADS=()
transcript() { rpc_request GET "/api/v1/rpc/hosts/${HOST_REF}/sessions/${HOST_REF}/$1/messages"; }
completed_message() { transcript "$1" | jq -e --arg marker "$2" '.status==200 and .body.state=="idle" and any(.body.turns[]?;(.user_input|contains($marker)) and (.response|type)=="string" and (.response|contains($marker)))' >/dev/null; }
send_message() {
  local thread=$1 marker=$2 response
  response="$(rpc_request POST "/api/v1/rpc/hosts/${HOST_REF}/messages" "$(jq -cn --arg thread "$thread" --arg text "Reply with exactly ${marker}." '{threadId:$thread,content:$text}')")" || die 'Business send transport failed'
  jq -e '.status==200 and ((.body.taskId|type)=="string" or (.body.response|type)=="string")' <<<"$response" >/dev/null || die 'Real business acceptance missing'
  wait_until 150 'accepted turn completed durably' completed_message "$thread" "$marker"
}
for index in 1 2 3; do
  thread="${RUN_ID}-api-${index}"; THREADS+=("$thread"); turns=2; [ "$index" != 3 ] || turns=1
  for turn in $(seq 1 "$turns"); do send_message "$thread" "canonical-${RUN_ID}-${index}-${turn}"; done
done
session_oracle() { transcript "$1" | jq -ce 'select(.status==200)|.body.turns|select(type=="array" and length>0)' | node -e 'const f=require("node:fs"),c=require("node:crypto");const v=JSON.parse(f.readFileSync(0,"utf8"));process.stdout.write(c.createHash("sha256").update(JSON.stringify(v)).digest("hex")+"\n")' > "$2"; }
for index in 0 1 2; do session_oracle "${THREADS[$index]}" "$SCRATCH/session-${index}.hash" || die 'Seed transcript missing'; done
catalog_snapshot "$SCRATCH/catalog-baseline.json" legacy-floor
jq -e '.counts.sessions>=3 and .counts.messages>=5' "$SCRATCH/catalog-baseline.json" >/dev/null || die 'Seed not durable'
acquire_hcc_watch_gate_lock || die 'Another HCC watch gate owns profile'
HCC_IMAGE="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
K8S_API_SERVICE_HOST="$(kctl exec deployment/"$HCC_DEPLOY" -n "$HCC_NS" -c host-context-controller -- printenv KUBERNETES_SERVICE_HOST)"
node -e 'process.exit(require("node:net").isIP(process.argv[1])===4?0:1)' "$K8S_API_SERVICE_HOST" || die 'Unverified API address'
K8S_API_CIDR="${K8S_API_SERVICE_HOST}/32"
hcc_pr_a_preflight; create_hcc_api_proxy; HCC_PR_A_SELECTIVE_CHANNEL=1 hcc_pr_a_enable_proxy
E2E_HCC_PR_A=1 verify_hcc_proxy_network_policy
HCC_PATCHED=1
kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=strategic -p "$(hcc_pr_a_redirect_patch)" >/dev/null
kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null || die 'Selective proxy HCC not Ready'
read -r HCC_UID HCC_RESTARTS <<<"$(wait_for_hcc_identity 30)"
node "$CONTRACT" watch-observer "$E2E_KUBECONTEXT" "$HCC_NS" "$HCC_DEPLOY" "$START_TIME" 1800 > "$HCC_LOG_BUFFER" & HCC_LOG_STREAM_PID=$!
log_count() { grep -Ec "$1" "$HCC_LOG_BUFFER" || true; }
marker_count_reached() { kill -0 "$HCC_LOG_STREAM_PID" 2>/dev/null && [ "$(log_count "$1")" -ge "$2" ]; }
hold_active() { local pod; pod="$(hcc_pr_a_proxy_pod)" || return 1; kctl exec "$pod" -n "$HCC_NS" -c proxy -- node -e 'process.stdout.write(require("fs").readFileSync("/churn-ctl/channel-hold.json"))' > "$SCRATCH/hold.json" && node "$CONTRACT" hold "$SCRATCH/hold.json" "$HCC_PR_A_CHANNEL_HOLD_ID"; }
renew_hold() { hcc_pr_a_command hold-channel 60000 || die 'Hold renewal failed'; HCC_PR_A_CHANNEL_HOLD_ID=$HCC_PR_A_COMMAND_ID; wait_until 5 'hold renewal ack' hcc_pr_a_ack held; hold_active || die 'Renewed hold not live'; }
unchanged_transcripts() { local index; for index in 0 1 2; do session_oracle "${THREADS[$index]}" "$SCRATCH/session-current.hash" || return 1; cmp -s "$SCRATCH/session-${index}.hash" "$SCRATCH/session-current.hash" || return 1; done; }
held_integrity() {
  hold_active || die 'Authority expired before observation'
  runtime_snapshot "$SCRATCH/held-runtime.json"; node "$CONTRACT" held-runtime "$SCRATCH/hold-before.json" "$SCRATCH/held-runtime.json"
  catalog_snapshot "$SCRATCH/held-catalog.json" "$1"; node "$CONTRACT" unchanged "$SCRATCH/catalog-baseline.json" "$SCRATCH/held-catalog.json"
  unchanged_transcripts || die 'Held API transcript changed'; fence_owned || die 'Held writer fence lost'
  hold_active || die 'Authority expired during business assertions'; assert_hcc_identity
}
checkpoint() {
  local record acknowledgement
  STEP=$((STEP+1)); runtime_snapshot "$SCRATCH/checkpoint.json"
  record="$(jq -cn --arg runId "$RUN_ID" --arg phase "$1" --arg kind "$2" --argjson sequence "$STEP" --argjson runtime "$(cat "$SCRATCH/checkpoint.json")" '{schemaVersion:1,runId:$runId,sequence:$sequence,phase:$phase,kind:$kind,runtime:$runtime}')"
  printf '%s\n' "$record" > "$EVIDENCE/${STEP}-$1.json"
  [ -n "$BARRIER" ] || return 0
  printf '%s\n' "$record" > "$BARRIER/checkpoint.next"; mv "$BARRIER/checkpoint.next" "$BARRIER/${STEP}.json"
  acknowledgement="$BARRIER/${STEP}.ack.json"
  ui_acknowledged() { [ -f "$acknowledgement" ] && node "$CONTRACT" ack "$acknowledgement" "$RUN_ID" "$1" "$STEP"; }
  wait_until 100 'visible UI checkpoint ack' ui_acknowledged "$1"
  if [ "$2" != hold ]; then catalog_snapshot "$SCRATCH/ui-after.json" canonical; node "$CONTRACT" post-write "$SCRATCH/catalog-baseline.json" "$SCRATCH/ui-after.json"; cp "$SCRATCH/ui-after.json" "$SCRATCH/catalog-baseline.json"; fi
}
# Two acknowledged auxiliary retirements/reconnections under one live CC hold;
# hold renewal is not a second CC cut. Two full CC cycles follow activation.
runtime_snapshot "$SCRATCH/hold-before.json"
ended="$(log_count 'CommunicationChannel watch ended;')"
hcc_pr_a_command hold-channel 60000; HCC_PR_A_CHANNEL_HOLD_ID=$HCC_PR_A_COMMAND_ID
wait_until 5 'live channel cut ack' hcc_pr_a_ack held
wait_until 20 'channel authority retired' marker_count_reached 'CommunicationChannel watch ended;' "$((ended+1))"
patch_host opt-in null
for kind in McpServer Context; do
  renew_hold; ended="$(log_count "${kind} watch ended;")"; started="$(log_count "Starting ${kind} watch")"
  hcc_pr_a_cut "$kind" || die 'Auxiliary live cut ack missing'
  wait_until 20 'auxiliary watch retired' marker_count_reached "${kind} watch ended;" "$((ended+1))"
  wait_until 30 'auxiliary reconnected under CC hold' marker_count_reached "Starting ${kind} watch" "$((started+1))"
  held_integrity legacy-floor; checkpoint "pre-authority-${kind}" hold; hold_active || die 'UI witness outlived hold'
done
recovered="$(log_count 'Recovered [0-9]+ CommunicationChannel\(s\) into cache')"
hcc_pr_a_command release-channel; wait_until 5 'authority release ack' hcc_pr_a_ack released
wait_until 40 'fresh CC authority recovered' marker_count_reached 'Recovered [0-9]+ CommunicationChannel\(s\) into cache' "$((recovered+1))"
wait_until 90 'actual stateless eligibility recovered' wait_host_mode "$HOST_REF" accepted 1
proposal_ready() { admin_get > "$SCRATCH/proposal.json" && jq -e --arg host "$HOST_UID" --arg pvc "$PVC_UID" '.status.conversationStore.operatorProposal|.schemaVersion==1 and .state=="ready" and .hostUid==$host and .pvcUid==$pvc and .storageContract=="canonical" and (.templateRevision|test("^[0-9a-f]{64}$")) and (.image|length)>0' "$SCRATCH/proposal.json" >/dev/null; }
wait_until 90 'fresh controller target proposal' proposal_ready
MAINTENANCE_ID="$(new_uuid)" request_id="$(new_uuid)"
base_request() { jq -cn --arg request "$1" --arg host "$HOST_UID" --arg pvc "$PVC_UID" --arg maintenance "$MAINTENANCE_ID" '{schemaVersion:1,requestId:$request,storageContract:"canonical",hostUid:$host,pvcUid:$pvc,maintenanceId:$maintenance}'; }
admin_request maintenance "$(base_request "$request_id")"; wait_until 60 'maintenance durable acknowledgement' request_settled "$request_id"
prepare_diagnostic() { local pod uid; pod="$(current_pod)" || return 1; uid="$(kctl get pod "$pod" -n "$HOST_NS" -o jsonpath='{.metadata.uid}')" || return 1; runtime_probe prepare "$pod" "$MAINTENANCE_ID" "$uid" > "$SCRATCH/physical.json"; }
wait_until 120 'actual worker closure, floor frame and existing fence' prepare_diagnostic
jq -e --arg hash "$(jq -er .catalogHash "$SCRATCH/catalog-baseline.json")" '.catalogHash==$hash and .diagnosticOnly==true and .projection=="state-subpath"' "$SCRATCH/physical.json" >/dev/null || die 'Quiescent catalog differs'
response="$(rpc_request POST "/api/v1/rpc/hosts/${HOST_REF}/messages" "$(jq -cn --arg thread "${RUN_ID}-maintenance-negative" '{threadId:$thread,content:"This synthetic message must be rejected during maintenance."}')")"
jq -e '.status==503' <<<"$response" >/dev/null || die 'Maintenance admitted business write'
proposal_ready || die 'Fresh target proposal changed'
request_id="$(new_uuid)"
body="$(base_request "$request_id" | jq --arg image "$(jq -er .status.conversationStore.operatorProposal.image "$SCRATCH/proposal.json")" --arg revision "$(jq -er .status.conversationStore.operatorProposal.templateRevision "$SCRATCH/proposal.json")" --arg manifest "$(jq -er .manifestHash "$SCRATCH/physical.json")" '.+{sourceClass:"sqlite-pvc",targetImage:$image,templateRevision:$revision,manifestHash:$manifest}')"
printf '%s' "$body" > "$SCRATCH/request.json"; node "$CONTRACT" preparation "$SCRATCH/request.json" "$HOST_UID" "$PVC_UID"
admin_request prepare "$body"; wait_until 300 'full-PVC physical preparation/mutation/current verification' request_settled "$request_id"
host="$(admin_get)"
jq -e --arg maintenance "$MAINTENANCE_ID" '.status.conversationStore.maintenance.maintenanceId==$maintenance and .status.conversationStore.maintenance.phase=="completed" and .status.conversationStore.layout.state=="ready" and .status.conversationStore.operationOutcome.storageContract=="canonical"' <<<"$host" >/dev/null || die 'Authoritative canonical completion missing'
wait_until 90 'canonical Pod running under maintenance' runtime_snapshot "$SCRATCH/pending.json" allow-unready
catalog_snapshot "$SCRATCH/canonical.json" canonical; node "$CONTRACT" unchanged "$SCRATCH/catalog-baseline.json" "$SCRATCH/canonical.json" identity-created
request_id="$(new_uuid)"
body="$(base_request "$request_id" | jq --arg store "$(jq -er .identity.storeId "$SCRATCH/canonical.json")" --arg hash "$(jq -er .catalogHash "$SCRATCH/canonical.json")" '.+{expectedStoreId:$store,expectedCurrentCatalogHash:$hash}')"
admin_request release "$body"; wait_until 120 'verified release' request_settled "$request_id"
wait_until 120 'canonical ready runtime' runtime_snapshot "$SCRATCH/ready.json"; fence_owned
cp "$SCRATCH/canonical.json" "$SCRATCH/catalog-baseline.json"; checkpoint canonical-activated activation
postwrite() { send_message "${RUN_ID}-post-$1" "canonical-${RUN_ID}-$1"; catalog_snapshot "$SCRATCH/postwrite.json" canonical; node "$CONTRACT" post-write "$SCRATCH/catalog-baseline.json" "$SCRATCH/postwrite.json"; cp "$SCRATCH/postwrite.json" "$SCRATCH/catalog-baseline.json"; }
transition() {
  runtime_snapshot "$SCRATCH/transition-after.json"; node "$CONTRACT" rollout "$SCRATCH/transition-before.json" "$SCRATCH/transition-after.json" "$2"
  catalog_snapshot "$SCRATCH/transition-catalog.json" canonical; node "$CONTRACT" unchanged "$SCRATCH/catalog-baseline.json" "$SCRATCH/transition-catalog.json"
  unchanged_transcripts || die 'Confirmed mode transition changed API transcript'; fence_owned
  postwrite "$1"; checkpoint "$1" rollout
}
postwrite activated
for requested in false true; do
  runtime_snapshot "$SCRATCH/transition-before.json"; patch_host stateless "$requested"
  mode_matches() { runtime_snapshot "$SCRATCH/mode.json" && [ "$(jq -r .stateless "$SCRATCH/mode.json")" = "$requested" ]; }
  wait_until 180 'actual requested lifecycle mode' mode_matches; transition "stateless-${requested}" "$requested"
done
runtime_snapshot "$SCRATCH/transition-before.json"
channel="$(jq -cn --arg name "$FIXTURE_CHANNEL" --arg ns "$CHANNEL_NS" --arg host "$HOST_REF" --arg run "$RUN_ID" '{apiVersion:"clerum.io/v1alpha1",kind:"CommunicationChannel",metadata:{name:$name,namespace:$ns,labels:{"e2e.clerum.io/canonical-run":$run}},spec:{hostRef:$host,email:[{channelId:"INBOX",emails:["canonical-lifecycle@example.test"]}]}}')"
kctl create -f - <<<"$channel" >/dev/null; CHANNEL_CREATED=1
wait_until 120 'channel forces actual stateful mode' wait_host_mode "$HOST_REF" blocked 1; transition channel-added false
runtime_snapshot "$SCRATCH/transition-before.json"
kctl delete communicationchannel "$FIXTURE_CHANNEL" -n "$CHANNEL_NS" --wait=true --timeout=60s >/dev/null; CHANNEL_CREATED=0
wait_until 120 'channel removal restores actual stateless mode' wait_host_mode "$HOST_REF" accepted 1; transition channel-removed true
for cycle in 1 2; do
  runtime_snapshot "$SCRATCH/hold-before.json"; ended="$(log_count 'CommunicationChannel watch ended;')"; recovered="$(log_count 'Recovered [0-9]+ CommunicationChannel\(s\) into cache')"
  hcc_pr_a_command hold-channel 60000; HCC_PR_A_CHANNEL_HOLD_ID=$HCC_PR_A_COMMAND_ID
  wait_until 5 'real canonical cut ack' hcc_pr_a_ack held; wait_until 20 'canonical authority lost' marker_count_reached 'CommunicationChannel watch ended;' "$((ended+1))"
  renew_hold; held_integrity canonical; checkpoint "canonical-hold-${cycle}" hold; hold_active || die 'Hold expired before explicit release'
  hcc_pr_a_command release-channel; wait_until 5 'canonical release ack' hcc_pr_a_ack released
  wait_until 40 'canonical fresh authority recovery' marker_count_reached 'Recovered [0-9]+ CommunicationChannel\(s\) into cache' "$((recovered+1))"
  wait_until 120 'actual mode recovered' wait_host_mode "$HOST_REF" accepted 1
  runtime_snapshot "$SCRATCH/recovered.json"; node "$CONTRACT" held-runtime "$SCRATCH/hold-before.json" "$SCRATCH/recovered.json"
  catalog_snapshot "$SCRATCH/recovered-catalog.json" canonical; node "$CONTRACT" unchanged "$SCRATCH/catalog-baseline.json" "$SCRATCH/recovered-catalog.json"; postwrite "watch-recovered-${cycle}"
done
runtime_snapshot "$SCRATCH/slow-before.json"; STOPPED_POD="$(jq -er .podName "$SCRATCH/slow-before.json")"; STOPPED_UID="$(jq -er .podUid "$SCRATCH/slow-before.json")"
fence_owned; runtime_probe writer-stop "$STOPPED_POD" > "$SCRATCH/stop.json"
STOPPED_PID="$(jq -er .pid "$SCRATCH/stop.json")"; STOPPED_TICKS="$(jq -er .startTimeTicks "$SCRATCH/stop.json")"
kctl delete pod "$STOPPED_POD" -n "$HOST_NS" --wait=false --grace-period=30 >/dev/null
kctl get pod "$STOPPED_POD" -n "$HOST_NS" -o json | jq -e --arg uid "$STOPPED_UID" '.metadata.uid==$uid and .metadata.deletionTimestamp!=null' >/dev/null
runtime_probe fence "$STOPPED_POD" | jq -e '.fenceBusy==true' >/dev/null || die 'Slow live writer did not exclude contender'
runtime_probe writer-resume "$STOPPED_POD" "$STOPPED_PID" "$STOPPED_TICKS" >/dev/null; STOPPED_POD=''
wait_until 180 'replacement canonical writer ready' runtime_snapshot "$SCRATCH/slow-after.json"
[ "$(jq -r .podUid "$SCRATCH/slow-before.json")" != "$(jq -r .podUid "$SCRATCH/slow-after.json")" ] && [ "$(jq -r .templateHash "$SCRATCH/slow-before.json")" = "$(jq -r .templateHash "$SCRATCH/slow-after.json")" ] || die 'Slow writer restart witness invalid'
catalog_snapshot "$SCRATCH/slow-catalog.json" canonical; node "$CONTRACT" unchanged "$SCRATCH/catalog-baseline.json" "$SCRATCH/slow-catalog.json"; fence_owned
postwrite slow-writer-restart; checkpoint slow-writer-restarted rollout; assert_hcc_identity
cp "$SCRATCH/catalog-baseline.json" "$EVIDENCE/final-catalog.json"
