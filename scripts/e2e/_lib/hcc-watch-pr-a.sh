#!/usr/bin/env bash
# PR A extends the existing branch-owned lifecycle fault controller.
HCC_PR_A_RESYNC_SEC=60
HCC_PR_A_TLS_CREATED=0
HCC_PR_A_CONFIG_SNAPSHOT=''
HCC_PR_A_LIB="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

hcc_pr_a_proxy_pod() {
  kctl get pods -n "$HCC_NS" -l "app=${PROXY_NAME}" -o json |
    jq -er '[.items[]|select(.metadata.deletionTimestamp==null)|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|if length==1 then .[0].metadata.name else error("ambiguous proxy") end'
}

hcc_pr_a_command() {
  local action=$1 value=${2:-} pod command
  pod="$(hcc_pr_a_proxy_pod)" || return 1
  HCC_PR_A_COMMAND_ID="${RUN_ID}-$(date +%s)-${RANDOM}"
  command="$(jq -cn --arg id "$HCC_PR_A_COMMAND_ID" --arg action "$action" --arg value "$value" \
    '{id:$id,action:$action} + (if $action=="arm" then {path:$value,method:"GET",durationMs:25000} elif $action=="cut" then {kind:$value} elif $action=="release" then {pauseId:$value} else {} end)')"
  printf '%s' "$command" | kctl exec -i "pod/$pod" -n "$HCC_NS" -c proxy -- node -e \
    'const fs=require("fs");const value=fs.readFileSync(0);fs.writeFileSync("/churn-ctl/next.json",value,{mode:384});fs.renameSync("/churn-ctl/next.json","/churn-ctl/command.json")'
}

hcc_pr_a_ack() {
  local state=$1 pod
  pod="$(hcc_pr_a_proxy_pod)" || return 1
  kctl exec "pod/$pod" -n "$HCC_NS" -c proxy -- node -e \
    'const fs=require("fs");try{const a=JSON.parse(fs.readFileSync("/churn-ctl/ack.json"));if(a.id!==process.argv[1]||a.state!==process.argv[2]||(a.state==="cut"&&a.count<1))process.exit(1)}catch{process.exit(1)}' \
    "$HCC_PR_A_COMMAND_ID" "$state" >/dev/null 2>&1
}

hcc_pr_a_cut() {
  hcc_pr_a_command cut "$1" || return 1
  wait_until 5 'acknowledged live watch cut' hcc_pr_a_ack cut
}

hcc_pr_a_pause_held() {
  local pause_id=$1 pod
  pod="$(hcc_pr_a_proxy_pod)" || return 1
  kctl exec "pod/$pod" -n "$HCC_NS" -c proxy -- node -e \
    'const fs=require("fs");try{const p=JSON.parse(fs.readFileSync("/churn-ctl/pause.json"));if(p.id!==process.argv[1]||p.state!=="intercepted")process.exit(1)}catch{process.exit(1)}' \
    "$pause_id" >/dev/null 2>&1
}

hcc_pr_a_logs() {
  jq -Rrc 'fromjson? | select(.event=="networkpolicy-recovery-decision" or .event=="networkpolicy-request" or .event=="networkpolicy-pass-start" or .event=="networkpolicy-pass-result")' "$HCC_LOG_BUFFER"
}

hcc_pr_a_recovery_checkpoint() {
  # Defaults preserve the simultaneous-stress diagnostic checkpoint.
  local line_base=${1:-$HCC_PR_A_OBSERVATION_LOG_LINE_BASE}
  local destination=${2:-$NP604_EVIDENCE/recovery-observation.jsonl}
  # Persist only structured observation fields before a failing assertion can
  # enter cleanup and remove the original log buffer. Never persist payloads.
  tail -n "+$((line_base + 1))" "$HCC_LOG_BUFFER" |
    jq -Rrc 'fromjson? | select(.event=="networkpolicy-recovery-decision" or
      .event=="networkpolicy-request" or .event=="networkpolicy-pass-start" or .event=="networkpolicy-pass-result") |
      {ts,event,kind,decision,reason,contextRevision,serverRevision,passId,causes,trailing,result,cause,admission} |
      with_entries(select(.value!=null))' > "$destination"
  printf 'PR_A_RECOVERY_DECISION_COUNTS (observation window)\n'
  jq -sc '[.[]|select(.event=="networkpolicy-recovery-decision")] |
    group_by([.kind,.decision,.reason]) | map({kind:.[0].kind,decision:.[0].decision,reason:.[0].reason,count:length})' \
    "$destination"
}

hcc_pr_a_identical_skip_after() {
  local line_base=$1 kind=$2 revision=$3
  require_hcc_recovery_log_stream || return 1
  tail -n "+$((line_base + 1))" "$HCC_LOG_BUFFER" | jq -Rse --arg kind "$kind" --argjson revision "$revision" '
    split("\n") | map(fromjson?) | any(.event=="networkpolicy-recovery-decision" and .kind==$kind and
      .decision=="skip" and .reason=="identical-complete" and
      .contextRevision==$revision.contextRevision and .serverRevision==$revision.serverRevision)' >/dev/null
}

hcc_pr_a_no_recovery_admission_after() {
  tail -n "+$(($1 + 1))" "$HCC_LOG_BUFFER" | jq -Rse '
    split("\n") | map(fromjson?) | all(.[];
      ((.event=="networkpolicy-request" and (.cause=="mcp-recovery" or .cause=="context-recovery")) or
       (.event=="networkpolicy-pass-start" and any(.causes[]?; .=="mcp-recovery" or .=="context-recovery"))) | not)' >/dev/null
}

hcc_pr_a_controlled_omissions_core() {
  local line_base=$1 kind cycle before revision periodic affected control
  require_hcc_recovery_log_stream || return 1
  hcc_pr_a_gate 200 || return 1
  revision="$(hcc_pr_a_logs | jq -sce '[.[]|select(.event=="networkpolicy-pass-result" and .result=="certified")][-1] |
    {contextRevision,serverRevision} | select(.contextRevision!=null and .serverRevision!=null)')" || return 1
  periodic="$(hcc_pr_a_periodic_started_count)" || return 1
  affected="$(np604_snapshot "$NP604_SERVER")" || return 1
  control="$(np604_snapshot "$NP604_CONTROL")" || return 1
  [ "$(jq length <<< "$affected")" = 4 ] && [ "$(jq length <<< "$control")" = 4 ] || return 1
  for kind in McpServer Context; do
    for cycle in 1 2 3; do
      before="$(wc -l < "$HCC_LOG_BUFFER" | tr -d ' ')" || return 1
      hcc_pr_a_cut "$kind" || return 1
      wait_until 8 "fresh identical-complete ${kind} omission ${cycle}" \
        hcc_pr_a_identical_skip_after "$before" "$kind" "$revision" || return 1
      wait_until 5 'protected API recovered after controlled cut' hcc_pr_a_gate 200 || return 1
      hcc_pr_a_no_recovery_admission_after "$line_base" || return 1
      [ "$(hcc_pr_a_periodic_started_count)" = "$periodic" ] || {
        printf 'PR A controlled omission phase overlapped a periodic pass\n' >&2; return 1;
      }
    done
  done
  np604_invoke "$NP604_SERVER" || return 1
  np604_invoke "$NP604_CONTROL" || return 1
  [ "$(np604_snapshot "$NP604_SERVER")" = "$affected" ] || return 1
  [ "$(np604_snapshot "$NP604_CONTROL")" = "$control" ] || return 1
  [ "$(hcc_pr_a_periodic_started_count)" = "$periodic" ] || return 1
  require_hcc_recovery_log_stream || return 1
  hcc_pr_a_no_recovery_admission_after "$line_base"
}

hcc_pr_a_controlled_omissions() {
  local line_base status=0
  line_base="$(wc -l < "$HCC_LOG_BUFFER" | tr -d ' ')" || return 1
  hcc_pr_a_controlled_omissions_core "$line_base" || status=$?
  hcc_pr_a_recovery_checkpoint "$line_base" "$NP604_EVIDENCE/controlled-recovery-observation.jsonl"
  [ "$status" = 0 ] || die 'PR A controlled identical recoveries failed; checkpoint retained'
  printf 'PR_A_IDENTICAL_RECOVERIES=PASS (3 sequential cuts per watch; no recovery admission)\n'
}

hcc_pr_a_decision_after() {
  local baseline=$1 kind=$2 decision=$3
  require_hcc_recovery_log_stream || return 1
  [ "$(hcc_pr_a_decision_count "$kind" "$decision")" -gt "$baseline" ]
}

hcc_pr_a_decision_count() {
  hcc_pr_a_logs | jq -s --arg kind "$1" --arg decision "$2" \
    '[.[]|select(.event=="networkpolicy-recovery-decision" and .kind==$kind and .decision==$decision)]|length'
}

hcc_pr_a_periodic_count() {
  hcc_pr_a_logs | jq -s '[.[]|select(.event=="networkpolicy-pass-result" and .result=="certified" and (.causes|index("periodic-resync"))!=null)]|length'
}
hcc_pr_a_periodic_after() { [ "$(hcc_pr_a_periodic_count)" -gt "$1" ]; }

hcc_pr_a_periodic_started_count() {
  hcc_pr_a_logs | jq -s '[.[]|select(.event=="networkpolicy-pass-start" and (.causes|index("periodic-resync"))!=null)]|length'
}

hcc_pr_a_runtime_completed() {
  local captured pod
  captured="$(hcc_pr_a_logs | jq -sr '[.[]|select(.event=="networkpolicy-pass-start" and (.causes|index("periodic-resync"))!=null)][-1].ts')"
  [ "$captured" != null ] || return 1
  pod="$(running_hcc_pod)" || return 1
  kctl exec -i "pod/$pod" -n "$HCC_NS" -c host-context-controller -- node - \
    "$captured" < "$HCC_PR_A_LIB/hcc-watch-runtime-metric.cjs" >/dev/null 2>&1
}

hcc_pr_a_certified_count() {
  hcc_pr_a_logs | jq -s '[.[]|select(.event=="networkpolicy-pass-result" and .result=="certified")]|length'
}
hcc_pr_a_certified_after() { [ "$(hcc_pr_a_certified_count)" -gt "$1" ]; }

hcc_pr_a_run() {
  local periodic baseline context_spec certified affected_policy control_policy context_servers pause_id
  require_hcc_recovery_log_stream || die 'PR A requires live structured logs'
  hcc_pr_a_gate 200 || die 'PR A protected inventory unavailable before fault'
  control_policy="$(np604_snapshot "$NP604_CONTROL")"
  periodic="$(hcc_pr_a_periodic_count)"
  wait_until 75 'PR A real periodic completion' hcc_pr_a_periodic_after "$periodic" || die 'PR A periodic path inactive'
  wait_until 15 'PR A periodic runtime effects complete' hcc_pr_a_runtime_completed || die 'PR A runtime did not complete before drift'
  # The B stress window may legitimately retain repair work. Test omission
  # separately after healthy binding, periodic policy/runtime completion and
  # the driver's acknowledged pause of automatic churn; never warm up on skips.
  hcc_pr_a_controlled_omissions
  periodic="$(hcc_pr_a_periodic_count)"
  context_spec="$(np604_kctl get mcpserver "$NP604_SERVER" -n "$MCP_NS" -o json | jq -Sc '{uid:.metadata.uid,generation:.metadata.generation,spec}')"
  hcc_pr_a_remove_service
  baseline="$(hcc_pr_a_decision_count McpServer skip)"
  hcc_pr_a_cut McpServer || die 'PR A did not cut live MCP watch'
  wait_until 12 'PR A identical recovery omitted' hcc_pr_a_decision_after "$baseline" McpServer skip || die 'PR A identical recovery not omitted'
  hcc_pr_a_service_absent || die 'PR A drift repaired before periodic witness'
  [ "$context_spec" = "$(np604_kctl get mcpserver "$NP604_SERVER" -n "$MCP_NS" -o json | jq -Sc '{uid:.metadata.uid,generation:.metadata.generation,spec}')" ] || die 'PR A drift changed CRD'
  wait_until 75 'PR A drift repaired by periodic pass' hcc_pr_a_periodic_after "$periodic" || die 'PR A no periodic repair pass'
  wait_until 15 'PR A actual Service recreation' hcc_pr_a_service_restored || die 'PR A periodic pass omitted runtime effect'
  wait_until 10 'PR A repaired runtime complete' hcc_pr_a_runtime_completed || die 'PR A repaired runtime not complete'
  np604_invoke "$NP604_SERVER" || die 'PR A drift recovery business result failed'
  printf 'PR_A_DRIFT_REPAIR=PASS\n'

  periodic="$(hcc_pr_a_periodic_started_count)"
  certified="$(hcc_pr_a_certified_count)"
  hcc_pr_a_remove_service
  # ensureService precedes ensureDeployment in the real reconciler. Holding
  # the Service existence GET prevents the missing effect from being repaired
  # before the watch generation retires its mutationAllowed predicate.
  hcc_pr_a_command arm "/api/v1/namespaces/${MCP_NS}/services/${NP604_SERVER}"
  pause_id=$HCC_PR_A_COMMAND_ID
  wait_until 5 'runtime pause armed' hcc_pr_a_ack armed || die 'PR A runtime pause not armed'
  np604_kctl patch context "$NP604_CONTEXT" -n "$MCP_NS" --type=merge \
    -p '{"spec":{"description":"PR A runtime interruption"}}' >/dev/null
  wait_until 10 'runtime GET intercepted' hcc_pr_a_ack intercepted || die 'PR A runtime GET not intercepted'
  wait_until 5 'NP finishes while runtime held' hcc_pr_a_certified_after "$certified" || die 'PR A NP did not finish before runtime retirement'
  hcc_pr_a_pause_held "$pause_id" || die 'PR A runtime pause expired before retirement'
  hcc_pr_a_service_absent || die 'PR A missing interrupted effect witness'
  baseline="$(hcc_pr_a_decision_count McpServer request)"
  hcc_pr_a_cut McpServer || die 'PR A runtime watch retirement missing'
  wait_until 5 'retired runtime recovery admitted' hcc_pr_a_decision_after "$baseline" McpServer request || die 'PR A dropped runtime recovery'
  hcc_pr_a_pause_held "$pause_id" || die 'PR A runtime pause expired before recovery completed'
  hcc_pr_a_command release "$pause_id"
  wait_until 5 'runtime pause released' hcc_pr_a_ack released || die 'PR A release not acknowledged'
  wait_until 20 'retired runtime effect repaired' hcc_pr_a_service_restored || die 'PR A retired runtime not repaired'
  [ "$(hcc_pr_a_periodic_started_count)" = "$periodic" ] || die 'PR A interrupted repair confounded by periodic tick'
  np604_invoke "$NP604_SERVER" || die 'PR A interrupted runtime business result failed'
  printf 'PR_A_INTERRUPTED_RUNTIME=PASS\n'

  affected_policy="$(hcc_pr_a_capture_egress_identity)" || die 'PR A egress identity ambiguous'
  hcc_pr_a_command arm "/apis/networking.k8s.io/v1/namespaces/${MCP_NS}/networkpolicies/$(jq -r '.name' <<< "$affected_policy")"
  pause_id=$HCC_PR_A_COMMAND_ID
  wait_until 5 'egress pause armed' hcc_pr_a_ack armed || die 'PR A egress pause not armed'
  np604_kctl patch mcpserver "$NP604_SERVER" -n "$MCP_NS" --type=merge \
    -p '{"spec":{"description":"PR A queue interception"}}' >/dev/null
  wait_until 10 'egress GET intercepted' hcc_pr_a_ack intercepted || die 'PR A egress operation not intercepted'
  context_servers="$(np604_kctl get context "$NP604_CONTEXT" -n "$MCP_NS" -o json | jq -c '.spec.mcpServers')"
  np604_kctl patch context "$NP604_CONTEXT" -n "$MCP_NS" --type=merge \
    -p "$(jq -cn --argjson names "$context_servers" --arg server "$NP604_SERVER" '{spec:{mcpServers:($names|map(select(.!=$server)))}}')" >/dev/null
  wait_until 5 'protected API closes while queue held' hcc_pr_a_gate 503 || die 'PR A protected gate never closed'
  printf 'PR_A_READY_DURING_API_503=%s\n' "$(ready_status "$(running_hcc_pod)")"
  hcc_pr_a_pause_held "$pause_id" || die 'PR A queue pause expired before the API witness'
  hcc_pr_a_command release "$pause_id"
  wait_until 5 'egress pause released' hcc_pr_a_ack released || die 'PR A egress release not acknowledged'
  wait_until 25 'protected API recertifies without revoked server' hcc_pr_a_gate 200 false || die 'PR A protected gate did not reopen with revoked inventory'
  hcc_pr_a_only_captured_egress_remains "$affected_policy" || die 'PR A revoked policy set differs from captured egress identity'
  np604_kctl patch context "$NP604_CONTEXT" -n "$MCP_NS" --type=merge \
    -p "$(jq -cn --argjson names "$context_servers" '{spec:{mcpServers:$names}}')" >/dev/null
  wait_until 20 'protected API restores desired binding' hcc_pr_a_gate 200 || die 'PR A desired binding not restored'
  np604_invoke "$NP604_SERVER" || die 'PR A affected business result failed after API recovery'
  np604_invoke "$NP604_CONTROL" || die 'PR A control business result failed after API recovery'
  [ "$(np604_snapshot "$NP604_CONTROL")" = "$control_policy" ] || die 'PR A control policies changed'
  printf 'PR_A_PROTECTED_API_RECOVERY=PASS\n'
  hcc_pr_a_logs > "$NP604_EVIDENCE/pr-a-observations.jsonl"
  # Receipt is a separate finite observation, never an automatic D2-b gate.
  hcc_pr_a_bookmark_report || printf 'PR_A_BOOKMARK_RECEIPT=NOT_DEMONSTRATED (artifact unavailable)\n'
}

hcc_pr_a_bookmark_pod_witness() {
  kctl get pod "$1" -n "$HCC_NS" -o json | jq -ce --arg container "$2" '
    . as $pod | [.status.containerStatuses[]? | select(.name==$container)][0] as $status |
    {uid:.metadata.uid,name:.metadata.name,
     image:([.spec.containers[] | select(.name==$container)][0].image),
     imageID:$status.imageID,restarts:$status.restartCount,startedAt:$status.state.running.startedAt} |
    select(.uid!=null and .image!=null and .imageID!=null and .restarts!=null and .startedAt!=null)'
}

hcc_pr_a_bookmark_unknown() {
  jq -n '{boundary:"verified-upstream-watch-response",window:null,receiptStatus:"NOT_DEMONSTRATED",
    disconnectBenefit:"NOT_DEMONSTRATED",reason:"observation-or-identity-unavailable",
    byWatch:{McpServer:{bookmarks:null,coverage:"unknown"},Context:{bookmarks:null,coverage:"unknown"}}}' \
    > "$NP604_EVIDENCE/bookmark-receipt.json"
  printf 'PR_A_BOOKMARK_RECEIPT=NOT_DEMONSTRATED\n'
}

hcc_pr_a_bookmark_report() {
  local proxy_pod hcc_pod proxy_before proxy_after hcc_before hcc_after observed
  proxy_pod="$(hcc_pr_a_proxy_pod)" && hcc_pod="$(running_hcc_pod)" &&
    proxy_before="$(hcc_pr_a_bookmark_pod_witness "$proxy_pod" proxy)" &&
    hcc_before="$(hcc_pr_a_bookmark_pod_witness "$hcc_pod" host-context-controller)" || {
      hcc_pr_a_bookmark_unknown; return;
    }
  hcc_pr_a_command observe-bookmarks &&
    wait_until 5 'finite upstream bookmark observation' hcc_pr_a_ack observed &&
    observed="$(kctl exec "pod/$proxy_pod" -n "$HCC_NS" -c proxy -- node -e \
      'process.stdout.write(require("fs").readFileSync("/churn-ctl/bookmarks.json"))')" &&
    proxy_after="$(hcc_pr_a_bookmark_pod_witness "$proxy_pod" proxy)" &&
    hcc_after="$(hcc_pr_a_bookmark_pod_witness "$hcc_pod" host-context-controller)" || {
      hcc_pr_a_bookmark_unknown; return;
    }
  jq -n --arg image "$HCC_IMAGE" --argjson observation "$observed" \
    --argjson hccBefore "$hcc_before" --argjson hccAfter "$hcc_after" \
    --argjson proxyBefore "$proxy_before" --argjson proxyAfter "$proxy_after" '
    def epoch: sub("\\.[0-9]+Z$";"Z") | fromdateiso8601 * 1000;
    ($hccBefore==$hccAfter and $proxyBefore==$proxyAfter and
     $hccAfter.image==$image and $proxyAfter.image==$image and
     $hccAfter.imageID==$proxyAfter.imageID and
     ($proxyAfter.startedAt|epoch)<=$observation.startedAtMs) as $sameIdentity |
    $observation | .window={startedAtMs:.startedAtMs,endedAtMs:.endedAtMs} |
    .configuredImage=$image | .hcc=$hccAfter | .proxy=$proxyAfter |
    .byWatch |= with_entries(
      if $sameIdentity and .value.firstWatchAtMs!=null and
         ($hccAfter.startedAt|epoch)<=.value.firstWatchAtMs then .
      else .value.coverage="unknown" | .value.bookmarks=null | .value.receipt="unknown" |
        .value.reasons += ["identity-unknown"] end) |
    .receiptStatus=(if any(.byWatch[]; .receipt=="observed") then "OBSERVED_UPSTREAM" else "NOT_DEMONSTRATED" end) |
    .disconnectBenefit="NOT_DEMONSTRATED"' > "$NP604_EVIDENCE/bookmark-receipt.json" || {
      hcc_pr_a_bookmark_unknown; return;
    }
  jq -r '"PR_A_BOOKMARK_RECEIPT="+.receiptStatus+" (callback processing and benefit not demonstrated)"' \
    "$NP604_EVIDENCE/bookmark-receipt.json"
}

hcc_pr_a_service_absent() {
  local resource
  resource="$(np604_kctl get service "$NP604_SERVER" -n "$MCP_NS" --ignore-not-found -o name)" || return 1
  [ -z "$resource" ]
}

hcc_pr_a_service_restored() {
  np604_kctl get service "$NP604_SERVER" -n "$MCP_NS" -o json |
    jq -e --arg uid "$HCC_PR_A_SERVICE_UID" --arg name "$NP604_SERVER" \
      '.metadata.uid!=$uid and .metadata.labels["clerum.io/mcpserver"]==$name and any(.spec.ports[]; .port==3000)' >/dev/null
}

hcc_pr_a_affected_policy_identities() {
  np604_kctl get networkpolicy -A \
    -l "clerum.io/mcpserver=${NP604_SERVER},clerum.io/managed-by=host-context-controller" -o json |
    jq -Sce '
      [.items[] | {
        namespace:.metadata.namespace,
        name:.metadata.name,
        type:.metadata.labels["clerum.io/policy-type"],
        uid:.metadata.uid,
        spec
      }] |
      if all(.[]; (.namespace|type)=="string" and (.namespace|length)>0 and
                    (.name|type)=="string" and (.name|length)>0 and
                    (.type|type)=="string" and (.type|length)>0 and
                    (.uid|type)=="string" and (.uid|length)>0 and
                    (.spec|type)=="object")
      then sort_by(.namespace,.name)
      else error("affected policy identity missing")
      end'
}

hcc_pr_a_capture_egress_identity() {
  hcc_pr_a_affected_policy_identities | jq -Sce '
    [.[] | select(.type=="external-egress")] |
    if length==1 then .[0] else error("egress identity ambiguous") end'
}

hcc_pr_a_only_captured_egress_remains() {
  local captured=$1
  hcc_pr_a_affected_policy_identities | jq -Sce --argjson captured "$captured" '. == [$captured]' >/dev/null
}

hcc_pr_a_remove_service() {
  HCC_PR_A_SERVICE_UID="$(np604_kctl get service "$NP604_SERVER" -n "$MCP_NS" -o json |
    jq -er --arg name "$NP604_SERVER" 'select(.metadata.labels["clerum.io/mcpserver"]==$name)|.metadata.uid')" || die 'PR A Service ownership missing'
  np604_kctl delete service "$NP604_SERVER" -n "$MCP_NS" --wait=true --timeout=10s >/dev/null
  hcc_pr_a_service_absent || die 'PR A Service never became absent'
}

hcc_pr_a_gate() {
  local expected=$1 visible=${2:-true} pod
  pod="$(np604_kctl get pods -n "$HOST_NS" -l "clerum.io/context=${NP604_CONTEXT}" -o json |
    jq -er '[.items[]|select(.metadata.deletionTimestamp==null)|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))][0].metadata.name')" || return 1
  { cat "$HCC_PR_A_LIB/np08-runtime-access.mjs"; cat "$HCC_PR_A_LIB/hcc-watch-gate-probe.mjs"; } |
    np604_kctl exec -i "$pod" -n "$HOST_NS" -- env "HCC_PR_A_EXPECT_STATUS=$expected" \
      "HCC_PR_A_AFFECTED=$NP604_SERVER" "HCC_PR_A_CONTROL=$NP604_CONTROL" \
      "HCC_PR_A_AFFECTED_VISIBLE=$visible" node --input-type=module -
}

hcc_pr_a_preflight() {
  local command_name
  for command_name in node openssl; do
    command -v "$command_name" >/dev/null || die "PR A requires installed ${command_name}"
  done
  [ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || die 'PR A requires Node 24'
  openssl req -help 2>&1 | grep -q -- '-addext' || die 'PR A requires openssl req -addext'
  HCC_PR_A_CONFIG_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/hcc-pr-a-public-config.XXXXXX")"
  chmod 600 "$HCC_PR_A_CONFIG_SNAPSHOT"
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json |
    node "$HCC_PR_A_LIB/hcc-watch-config.mjs" snapshot > "$HCC_PR_A_CONFIG_SNAPSHOT"
  [ -s "$HCC_PR_A_CONFIG_SNAPSHOT" ] || die 'PR A public configuration capture failed'
  printf 'PR_A_TEST_RESYNC_SECONDS=%s (development test only)\n' "$HCC_PR_A_RESYNC_SEC"
}

hcc_pr_a_identity_current() {
  [ -s "$HCC_PR_A_CONFIG_SNAPSHOT" ] || return 1
  local current
  current="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.metadata.uid}')" || return 1
  [ "$current" = "$(jq -r '.uid' "$HCC_PR_A_CONFIG_SNAPSHOT")" ]
}

hcc_pr_a_enable_proxy() {
  local patch paths server
  server="$(truncate_rfc1123 "np604-${RUN_ID}-affected")"
  paths="$(jq -cn --arg ns "$MCP_NS" --arg server "$server" '[
    ("/apis/apps/v1/namespaces/"+$ns+"/deployments/"+$server),
    ("/api/v1/namespaces/"+$ns+"/services/"+$server),
    ("/apis/networking.k8s.io/v1/namespaces/"+$ns+"/networkpolicies/ext-egress-"+$server+"-1-2-3-4-32-443")]')"
  # Consumed by the lifecycle cleanup owner.
  # shellcheck disable=SC2034
  HCC_PR_A_TLS_CREATED=1
  # Generated private material stays in this anonymous pipe, never an artifact.
  node "$HCC_PR_A_LIB/hcc-watch-tls-manifest.mjs" "$PROXY_NAME" "$HCC_NS" "$RUN_ID" \
    "$HCC_PR_A_LIB/hcc-watch-api-proxy.mjs" | kctl create -f - >/dev/null 2>&1 || die 'PR A TLS fixture creation failed'
  patch="$(jq -cn --arg name "$PROXY_NAME" --arg paths "$paths" '{spec:{template:{spec:{
    securityContext:{fsGroup:1000}, containers:[{name:"proxy",command:["node","/fixture/proxy.mjs"],args:[],
      env:[{name:"PAUSE_PATHS",value:$paths}],volumeMounts:[
        {name:"fixture-code",mountPath:"/fixture",readOnly:true},
        {name:"fixture-tls",mountPath:"/fixture-tls",readOnly:true},
        {name:"upstream-ca",mountPath:"/upstream-ca",readOnly:true}]}],
    volumes:[{name:"fixture-code",configMap:{name:$name}},
      {name:"fixture-tls","secret":{secretName:$name,defaultMode:288}},
      {name:"upstream-ca",configMap:{name:"kube-root-ca.crt"}}]}}}}')"
  kctl patch deployment "$PROXY_NAME" -n "$HCC_NS" --type=strategic -p "$patch" >/dev/null
  kctl rollout status deployment "$PROXY_NAME" -n "$HCC_NS" --timeout=60s >/dev/null || die 'PR A TLS proxy not Ready'
}

hcc_pr_a_redirect_patch() {
  jq -cn --arg uid "$(jq -r '.uid' "$HCC_PR_A_CONFIG_SNAPSHOT")" \
    --arg name "$PROXY_NAME" --arg cidr "$K8S_API_CIDR" --arg seconds "$HCC_PR_A_RESYNC_SEC" '{metadata:{uid:$uid},spec:{template:{spec:{
    containers:[{name:"host-context-controller",env:[
      {name:"KUBECONFIG",valueFrom:null,value:"/hcc-pr-a/config.json"},
      {name:"CONTEXT_MAPPER_K8S_API_CIDRS",valueFrom:null,value:$cidr},
      {name:"CONTEXT_MAPPER_NETPOL_RESYNC_SEC",valueFrom:null,value:$seconds}],
      volumeMounts:[{name:"hcc-pr-a-config",mountPath:"/hcc-pr-a",readOnly:true}]}],
    volumes:[{name:"hcc-pr-a-config",configMap:{name:$name}}]}}}}'
}

hcc_pr_a_restore() {
  local patch
  [ -s "$HCC_PR_A_CONFIG_SNAPSHOT" ] || return 1
  patch="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json |
    node "$HCC_PR_A_LIB/hcc-watch-config.mjs" restore "$HCC_PR_A_CONFIG_SNAPSHOT")" || return 1
  kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=json -p "$patch" >/dev/null || return 1
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json |
    node "$HCC_PR_A_LIB/hcc-watch-config.mjs" verify "$HCC_PR_A_CONFIG_SNAPSHOT"
}
