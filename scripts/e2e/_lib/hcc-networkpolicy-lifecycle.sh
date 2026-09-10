#!/usr/bin/env bash
# Optional #604 lifecycle assertions inside the existing real watch-churn gate.
# The gate owns API fault injection, branch provenance, lock and restoration.
# This module owns only its labelled fixture and its policy event observer.

NP604_CREATED=0
NP604_WATCH_PID=''

np604_kctl() {
  kctl --request-timeout=30s "$@"
}

np604_setup() {
  NP604_CONTEXT="$(printf '%s-ctx-%03d' "$FLEET_PREFIX" 1)"
  NP604_SERVER="$(truncate_rfc1123 "np604-${RUN_ID}-affected")"
  NP604_CONTROL="$(truncate_rfc1123 "np604-${RUN_ID}-control")"
  NP604_ENV="$(truncate_rfc1123 "np604-${RUN_ID}-env")"
  NP604_EVIDENCE="${HCC_BRANCH_GATE_REPO_ROOT}/.local-notes/infra/runs/issue604-${RUN_ID}"
  mkdir -p "$NP604_EVIDENCE"
  NP604_CREATED=1
  # Synthetic, non-production fixture data; never derive it from user state.
  np604_kctl create secret generic "$NP604_ENV" -n "$MCP_NS" \
    --from-literal=required=e2e-fixture --dry-run=client -o json |
    jq --arg run "$RUN_ID" '.metadata.labels={"e2e.clerum.io/run":$run,"e2e.clerum.io/suite":"hcc-np604"}' |
    np604_kctl apply -f - >/dev/null
  local name
  for name in "$NP604_SERVER" "$NP604_CONTROL"; do
    np604_kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${name}
  namespace: ${MCP_NS}
  labels: {e2e.clerum.io/run: "${RUN_ID}", e2e.clerum.io/suite: hcc-np604}
spec:
  contextRef: ${NP604_CONTEXT}
  image: clerum/mock-mcp-server:test
  imagePullPolicy: Never
  transport: {type: streamableHttp, port: 3000, url: "http://${name}.${MCP_NS}.svc.cluster.local:3000/mcp"}
  egressBindings: [{cidr: 1.2.3.4/32, port: 443, protocol: TCP}]
EOF
  done
  np604_kctl patch mcpserver "$NP604_SERVER" -n "$MCP_NS" --type=merge \
    -p "$(jq -cn --arg name "$NP604_ENV" '{spec:{envSecret:{name:$name,keys:[{secretKey:"required",envVar:"NP604_FIXTURE"}]}}}')" >/dev/null
  np604_kctl patch context "$NP604_CONTEXT" -n "$MCP_NS" --type=merge \
    -p "$(jq -cn --arg a "$NP604_SERVER" --arg c "$NP604_CONTROL" '{spec:{mcpServers:[$a,$c]}}')" >/dev/null
}

np604_snapshot() {
  np604_kctl get networkpolicy -A -l "clerum.io/mcpserver=$1,clerum.io/managed-by=host-context-controller" -o json |
    jq -Sc '[.items[] | {namespace:.metadata.namespace,name:.metadata.name,type:.metadata.labels["clerum.io/policy-type"],spec}] | sort_by(.namespace,.name)'
}

np604_ready() {
  local name="$1"
  np604_kctl get deployment "$name" -n "$MCP_NS" -o json 2>/dev/null |
    jq -e '.status.observedGeneration >= .metadata.generation and (.status.readyReplicas // 0) > 0' >/dev/null &&
    [ "$(np604_snapshot "$name" | jq length)" = 4 ]
}

np604_invoke() {
  local name="$1" pod
  # Real Context-labelled mcp-host created by the parent gate, not a probe
  # with forged labels. Exercise the MCP protocol over the actual allow path.
  pod="$(np604_kctl get pods -n "$HOST_NS" -l "clerum.io/context=${NP604_CONTEXT}" -o json |
    jq -r '[.items[] | select(.metadata.deletionTimestamp == null) | select(any(.status.conditions[]?; .type=="Ready" and .status=="True"))][0].metadata.name // empty')"
  [ -n "$pod" ] || return 1
  np604_kctl exec -i "$pod" -n "$HOST_NS" -- node --input-type=module - "$name" "$MCP_NS" <<'JS'
const [name, namespace] = process.argv.slice(2)
const url = `http://${name}.${namespace}.svc.cluster.local:3000/mcp`
let session
async function rpc(id, method, params) {
  const headers = {'content-type':'application/json',accept:'application/json, text/event-stream'}
  if (session) headers['mcp-session-id'] = session
  const response = await fetch(url, {method:'POST', headers,
    body:JSON.stringify({jsonrpc:'2.0',...(id === undefined ? {} : {id}),method,params}),
    signal:AbortSignal.timeout(8000)})
  if (!response.ok) throw new Error(`MCP request failed: ${response.status}`)
  session = response.headers.get('mcp-session-id') ?? session
  const body = await response.text()
  if (id === undefined) return
  const messages = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    : [JSON.parse(body)]
  const message = messages.find(item => item.id === id)
  if (!message || message.error) throw new Error('MCP response missing or rejected')
  return message.result
}
await rpc(1, 'initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'np604-real-flow',version:'1'}})
await rpc(undefined, 'notifications/initialized', {})
const result = await rpc(2, 'tools/call', {name:'add',arguments:{a:17,b:25}})
if (result.isError || !result.content?.some(item => item.type === 'text' && item.text === '42')) {
  throw new Error('MCP business result did not equal 42')
}
console.log('NP604_MCP_BUSINESS_RESULT=42')
JS
}

np604_failed() {
  local reason="$1" runtime
  np604_kctl get mcpserver "$NP604_SERVER" -n "$MCP_NS" -o json |
    jq -e --arg reason "$reason" 'any(.status.conditions[]?; .type=="SecretResolved" and .status=="False" and .reason==$reason)' >/dev/null || return 1
  runtime="$(np604_kctl get deployment "$NP604_SERVER" -n "$MCP_NS" --ignore-not-found -o name)" || return 1
  [ -z "$runtime" ] && [ "$(np604_snapshot "$NP604_SERVER")" = '[]' ]
}

np604_observer_alive() {
  [ -n "$NP604_WATCH_PID" ] && jobs -pr | awk -v pid="$NP604_WATCH_PID" '$1==pid {found=1} END {exit !found}'
}

np604_observer_initial_witness() {
  awk -v name="${MCP_NS}/ctx-${NP604_CONTEXT}-${NP604_CONTROL}" \
    '$1=="ADDED" && $2==name {found=1} END {exit !found}' "$NP604_EVIDENCE/policy-events.txt"
}

np604_observer_witness() {
  awk -v name="${MCP_NS}/ctx-${NP604_CONTEXT}-${NP604_CONTROL}" \
    '$1=="MODIFIED" && $2==name {found=1} END {exit !found}' "$NP604_EVIDENCE/policy-events.txt"
}

np604_before_observation() {
  wait_until 180 'NP604 affected runtime and four policy families' np604_ready "$NP604_SERVER" || die 'NP604 initial runtime did not converge'
  wait_until 180 'NP604 control runtime and four policy families' np604_ready "$NP604_CONTROL" || die 'NP604 control did not converge'
  wait_until 120 'NP604 initial business result from mcp-host' np604_invoke "$NP604_SERVER" || die 'NP604 initial invocation failed'
  np604_invoke "$NP604_CONTROL" || die 'NP604 control invocation failed'
  np604_snapshot "$NP604_SERVER" > "$NP604_EVIDENCE/desired-policies.json"
  np604_kctl get networkpolicy deny-all-mcp-host -n "$HOST_NS" -o json |
    jq -e '.spec.podSelector=={} and (.spec.policyTypes|index("Ingress"))!=null and (.spec.policyTypes|index("Egress"))!=null' >/dev/null || die 'NP604 default deny missing'
  np604_kctl patch secret "$NP604_ENV" -n "$MCP_NS" --type=merge -p '{"data":null}' >/dev/null
  wait_until 120 'NP604 published failure and policy revocation' np604_failed SecretMissingKey || die 'NP604 did not revoke after failure'
  np604_invoke "$NP604_CONTROL" || die 'NP604 failure affected healthy control'
  # kubectl owns the initial LIST resourceVersion and resumes WATCH from it.
  # Wait for a listed control policy before annotating it, so the subsequent
  # MODIFIED witness cannot precede that LIST and disappear into its snapshot.
  "$KUBECTL_BIN" --context="$E2E_KUBECONTEXT" --request-timeout=180s get networkpolicy -A \
    -l "clerum.io/mcpserver in (${NP604_SERVER},${NP604_CONTROL})" \
    --watch --output-watch-events \
    -o 'jsonpath={.type}{" "}{.object.metadata.namespace}{"/"}{.object.metadata.name}{"\n"}' \
    > "$NP604_EVIDENCE/policy-events.txt" 2> "$NP604_EVIDENCE/observer-errors.txt" &
  NP604_WATCH_PID=$!
  wait_until 15 'NP604 observer initial inventory' np604_observer_initial_witness || die 'NP604 observer did not list the control policy'
  # Metadata-only witness on our healthy fixture: proves the watch is live
  # without creating a final policy or replacing HCC's desired policy spec.
  np604_kctl annotate networkpolicy "ctx-${NP604_CONTEXT}-${NP604_CONTROL}" -n "$MCP_NS" \
    "e2e.clerum.io/observer=${RUN_ID}" --overwrite >/dev/null
  wait_until 15 'NP604 policy observer positive witness' np604_observer_witness || die 'NP604 observer is not live'
  NP604_CUT_BASE="$(count_buffer '\[K8s\] Context watch ended; recovering authoritative inventory')"
}

np604_after_observation() {
  np604_observer_alive || die 'NP604 observer stopped before completing observation'
  local current_cuts
  current_cuts="$(count_buffer '\[K8s\] Context watch ended; recovering authoritative inventory')"
  [ "$((current_cuts - NP604_CUT_BASE))" -ge 3 ] || die 'NP604 needs three complete reconnect cycles in stable failed state'
  awk -v target="$NP604_SERVER" '$1=="ADDED" && index($2,target) {bad=1} END {exit bad}' \
    "$NP604_EVIDENCE/policy-events.txt" || die 'NP604 recreated a policy while runtime remained undesired'
  kill "$NP604_WATCH_PID"
  wait "$NP604_WATCH_PID" 2>/dev/null || true
  NP604_WATCH_PID=''
  np604_invoke "$NP604_CONTROL" || die 'NP604 control lost connectivity under churn'
}

np604_recover() {
  np604_kctl patch secret "$NP604_ENV" -n "$MCP_NS" --type=merge \
    -p '{"stringData":{"required":"e2e-fixture"}}' >/dev/null
  wait_until 180 'NP604 repaired runtime and policies' np604_ready "$NP604_SERVER" || die 'NP604 repair did not converge'
  wait_until 120 'NP604 repaired business result' np604_invoke "$NP604_SERVER" || die 'NP604 repair did not restore invocation'
  [ "$(np604_snapshot "$NP604_SERVER")" = "$(cat "$NP604_EVIDENCE/desired-policies.json")" ] || die 'NP604 recovered policy set differs'
  np604_kctl patch secret "$NP604_ENV" -n "$MCP_NS" --type=merge -p '{"data":null}' >/dev/null
  wait_until 120 'NP604 second failure' np604_failed SecretMissingKey || die 'NP604 second failure did not converge'
  np604_kctl patch mcpserver "$NP604_SERVER" -n "$MCP_NS" --type=merge -p '{"spec":{"envSecret":null}}' >/dev/null
  wait_until 180 'NP604 recovery after removing reference' np604_ready "$NP604_SERVER" || die 'NP604 removed reference did not recover'
  np604_invoke "$NP604_SERVER" || die 'NP604 removed reference did not restore invocation'
  [ "$(np604_snapshot "$NP604_SERVER")" = "$(cat "$NP604_EVIDENCE/desired-policies.json")" ] || die 'NP604 removed reference policy set differs'
  printf 'NP604_LIFECYCLE=PASS\nevidence=%s\n' "$NP604_EVIDENCE"
}

np604_cleanup() {
  if np604_observer_alive; then
    kill "$NP604_WATCH_PID"
    wait "$NP604_WATCH_PID" 2>/dev/null || true
  fi
  NP604_WATCH_PID=''
  [ "$NP604_CREATED" = 1 ] || return 0
  np604_kctl delete mcpserver,secret -n "$MCP_NS" \
    -l "e2e.clerum.io/suite=hcc-np604,e2e.clerum.io/run=${RUN_ID}" --ignore-not-found >/dev/null
}

np604_resources_absent() {
  local remaining
  remaining="$(np604_kctl get deployment,service,networkpolicy -A \
    -l "clerum.io/mcpserver in (${NP604_SERVER},${NP604_CONTROL})" -o name)" || return 1
  [ -z "$remaining" ]
}
