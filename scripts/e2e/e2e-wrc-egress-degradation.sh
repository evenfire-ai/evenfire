#!/usr/bin/env bash
# Proves that a correctly configured, active WorkflowRecipe stays available
# while WRC contracts removed UI/workload egress authorization across a real
# transient DNS failure. The fixture also widens both live policies while DNS
# is held and proves the post-DNS fresh-read contraction removes that drift
# before the reconcile completes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# Reuse the exact-head/profile/fingerprint validator used by the disruptive HCC
# gates. Despite its historical name, this helper performs no HCC mutation.
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-fixture.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"

[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT or E2E_K8S_CONTEXT must select an explicit branch profile." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing WRC fault injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
[ "${E2E_WRC_EGRESS_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_WRC_EGRESS_FAULT_INJECTION=1 to acknowledge reversible WRC DNS fault injection." >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

WRC_NS="${WRC_NAMESPACE:-control-plane}"
WRC_DEPLOY="${WRC_DEPLOYMENT:-workflow-recipes}"
UI_NS="${SANDBOX_UI_NS:-sandbox-ui}"
RECIPE_NAMESPACE="${WORKFLOW_RECIPE_NS:-sandbox-recipes}"
RUN_ID="$(date +%s)-$$"
RUN_LABEL="$(truncate_rfc1123 "$RUN_ID")"
SUITE_NAME=wrc-egress-degradation
RECIPE_NAME="$(truncate_rfc1123 "e2e-wrc-egress-${RUN_ID}")"
TARGET_DNS="$(truncate_rfc1123 "wrc-egress-${RUN_ID}").example.com"
ANSWER_IP=93.184.216.34
DNS_PROXY="$(truncate_rfc1123 "e2e-wrc-dns-${RUN_ID}")"
DNS_PROXY_CONFIGMAP="$(truncate_rfc1123 "${DNS_PROXY}-script")"
DNS_PROXY_POLICY="$(truncate_rfc1123 "${DNS_PROXY}-policy")"
WRC_DNS_POLICY="$(truncate_rfc1123 "${DNS_PROXY}-from-wrc")"
LOCK_NAME="e2e-wrc-egress-degradation-lock"
UI_POLICY="ui-egress-${RECIPE_NAME}"
WORKLOAD_POLICY="wl-egress-${RECIPE_NAME}-worker"
DNS_PROXY_SCRIPT="${SCRIPT_DIR}/../../tests/e2e/fixtures/wrc-egress-dns-proxy/server.cjs"

LOCK_UID=""
LOCK_ACQUIRED=0
PROXY_CREATED=0
WRC_MUTATED=0
RECIPE_CREATED=0
ORIGINAL_DNS_POLICY=""
ORIGINAL_DNS_CONFIG=""
ORIGINAL_REPLICAS=""
WRC_IMAGE=""
UPSTREAM_DNS_IP=""

die() {
  echo "[wrc-egress-degradation] ERROR: $*" >&2
  if [ "$PROXY_CREATED" = 1 ]; then
    kctl logs "deployment/${DNS_PROXY}" -n "$WRC_NS" -c dns-proxy --tail=120 >&2 || true
  fi
  exit 1
}

wait_until() {
  local timeout=$1 description=$2
  shift 2
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    "$@" && return 0
    sleep 1
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

deployment_ready() {
  local namespace=$1 name=$2
  local deployment
  deployment="$(kctl get deployment "$name" -n "$namespace" -o json 2>/dev/null)" || return 1
  jq -e '
    (.spec.replicas // 0) > 0 and
    (.status.observedGeneration // 0) >= (.metadata.generation // 0) and
    (.status.readyReplicas // 0) == (.spec.replicas // 0) and
    (.status.availableReplicas // 0) == (.spec.replicas // 0)
  ' <<<"$deployment" >/dev/null
}

recipe_active() {
  [ "$(kctl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NAMESPACE" \
    -o jsonpath='{.status.phase}' 2>/dev/null)" = active ]
}

policy_matches_ports() {
  local namespace=$1 name=$2 expected_json=$3
  local policy
  policy="$(kctl get networkpolicy "$name" -n "$namespace" -o json 2>/dev/null)" || return 1
  jq -e --arg answer "${ANSWER_IP}/32" --argjson expected "$expected_json" '
    .metadata.labels["clerum.io/managed-by"] == "workflow-recipes" and
    ([.spec.egress[]?.ports[]?.port] | unique | sort) == ($expected | unique | sort) and
    ([.spec.egress[]?.to[]?.ipBlock.cidr] | unique) == [$answer] and
    ((.metadata.annotations["clerum.io/egress-fqdn-state"] | fromjson |
      map(.port) | unique | sort) == ($expected | unique | sort))
  ' <<<"$policy" >/dev/null
}

policy_has_port() {
  local namespace=$1 name=$2 port=$3
  kctl get networkpolicy "$name" -n "$namespace" -o json 2>/dev/null |
    jq -e --argjson port "$port" 'any(.spec.egress[]?.ports[]?; .port == $port)' >/dev/null
}

append_policy_port() {
  local namespace=$1 name=$2 port=$3
  local patch
  patch="$(jq -cn --arg cidr "${ANSWER_IP}/32" --argjson port "$port" '
    [{op:"add",path:"/spec/egress/-",value:{
      to:[{ipBlock:{cidr:$cidr}}],ports:[{port:$port,protocol:"TCP"}]
    }}]
  ')"
  kctl patch networkpolicy "$name" -n "$namespace" --type=json -p "$patch" >/dev/null
}

workload_health() {
  local namespace=$1 workload=$2
  local pod
  pod="$(ready_pod_name "$namespace" \
    "clerum.io/recipe=${RECIPE_NAME},clerum.io/workload=${workload}" 2>/dev/null)" || return 1
  # loopback is intentionally assembled inside JavaScript for the repository's
  # public/private evidence boundary; no shell expansion belongs in this body.
  # shellcheck disable=SC2016
  kctl exec "$pod" -n "$namespace" -- node -e '
    const loopback = [127, 0, 0, 1].join(".");
    fetch(`http://${loopback}:3001/`)
      .then(async response => {
        const body = await response.json();
        if (response.status !== 200 || body.status !== "ok") process.exit(2);
      })
      .catch(() => process.exit(3));
  ' >/dev/null 2>&1
}

dns_state() {
  kctl exec "deployment/${DNS_PROXY}" -n "$WRC_NS" -c dns-proxy -- node -e '
    const http = require("node:http");
    http.get({host:"127.0.0.1",port:8090,path:"/state"}, response => {
      let body=""; response.on("data", chunk => body += chunk);
      response.on("end", () => { process.stdout.write(body); process.exit(response.statusCode === 200 ? 0 : 2); });
    }).once("error", () => process.exit(3));
  ' 2>/dev/null
}

dns_count() {
  local key=$1
  dns_state | jq -er --arg key "$key" '.counts[$key]'
}

set_dns_mode() {
  local selected=$1
  # The JavaScript reads DNS_MODE from the explicit `env` argument; shell
  # expansion inside the program would be a quoting bug.
  # shellcheck disable=SC2016
  kctl exec "deployment/${DNS_PROXY}" -n "$WRC_NS" -c dns-proxy -- \
    env DNS_MODE="$selected" node -e '
      const http = require("node:http");
      const request = http.request(
        {host:"127.0.0.1",port:8090,path:`/mode/${process.env.DNS_MODE}`,method:"POST"},
        response => { response.resume(); response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 2)); }
      );
      request.setTimeout(5000, () => request.destroy());
      request.once("error", () => process.exit(3));
      request.end();
    '
}

dns_count_at_least() {
  local key=$1 minimum=$2 current
  current="$(dns_count "$key" 2>/dev/null)" || return 1
  [ "$current" -ge "$minimum" ]
}

acquire_lock() {
  local created existing
  if ! created="$(kctl create configmap "$LOCK_NAME" -n "$WRC_NS" \
    --from-literal="holder=${RUN_ID}" \
    --from-literal="context=${E2E_KUBECONTEXT}" \
    --from-literal="gitHead=$(git -C "${SCRIPT_DIR}/../.." rev-parse HEAD)" \
    -o json 2>/dev/null)"; then
    existing="$(kctl get configmap "$LOCK_NAME" -n "$WRC_NS" -o json 2>/dev/null || true)"
    die "another WRC egress gate owns ${WRC_NS}/${LOCK_NAME}: holder=$(jq -r '.data.holder // "unknown"' <<<"${existing:-{}}"), head=$(jq -r '.data.gitHead // "unknown"' <<<"${existing:-{}}")"
  fi
  LOCK_UID="$(jq -r '.metadata.uid // ""' <<<"$created")"
  [ -n "$LOCK_UID" ] || die "created gate lock has no UID"
  LOCK_ACQUIRED=1
}

release_lock() {
  local current
  [ "$LOCK_ACQUIRED" = 1 ] || return 0
  current="$(kctl get configmap "$LOCK_NAME" -n "$WRC_NS" -o json 2>/dev/null)" || return 1
  [ "$(jq -r '.metadata.uid // ""' <<<"$current")" = "$LOCK_UID" ] || return 1
  [ "$(jq -r '.data.holder // ""' <<<"$current")" = "$RUN_ID" ] || return 1
  kctl delete configmap "$LOCK_NAME" -n "$WRC_NS" --wait=true --timeout=30s >/dev/null || return 1
  LOCK_ACQUIRED=0
}

wrc_restore_verified() {
  local deployment
  deployment="$(kctl get deployment "$WRC_DEPLOY" -n "$WRC_NS" -o json 2>/dev/null)" || return 1
  jq -e --arg policy "$ORIGINAL_DNS_POLICY" --argjson replicas "$ORIGINAL_REPLICAS" '
    .spec.replicas == $replicas and
    (.status.readyReplicas // 0) == $replicas and
    (.status.availableReplicas // 0) == $replicas and
    (.spec.template.spec.dnsPolicy // "ClusterFirst") == $policy and
    (.spec.template.spec.dnsConfig // null) == null
  ' <<<"$deployment" >/dev/null
}

delete_proxy_resources() {
  local failed=0
  kctl delete networkpolicy "$WRC_DNS_POLICY" "$DNS_PROXY_POLICY" -n "$WRC_NS" \
    --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || failed=1
  kctl delete service "$DNS_PROXY" -n "$WRC_NS" \
    --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || failed=1
  kctl delete deployment "$DNS_PROXY" -n "$WRC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete configmap "$DNS_PROXY_CONFIGMAP" -n "$WRC_NS" \
    --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || failed=1
  return "$failed"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local cleanup_failed=0 restore_ok=1

  if [ "$PROXY_CREATED" = 1 ]; then
    set_dns_mode ok >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$RECIPE_CREATED" = 1 ]; then
    kctl delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NAMESPACE" \
      --ignore-not-found --wait=false >/dev/null 2>&1 || cleanup_failed=1
    wait_until 90 "fixture WorkflowRecipe deletion" \
      bash -c "! kubectl --context='${E2E_KUBECONTEXT}' get workflowrecipe '${RECIPE_NAME}' -n '${RECIPE_NAMESPACE}' >/dev/null 2>&1" || cleanup_failed=1
  fi
  if [ "$WRC_MUTATED" = 1 ]; then
    local restore_patch
    restore_patch="$(jq -cn --arg policy "$ORIGINAL_DNS_POLICY" '
      {spec:{template:{spec:{dnsPolicy:$policy,dnsConfig:null}}}}
    ')"
    kctl patch deployment "$WRC_DEPLOY" -n "$WRC_NS" --type=strategic \
      -p "$restore_patch" >/dev/null 2>&1 || restore_ok=0
    kctl rollout status deployment "$WRC_DEPLOY" -n "$WRC_NS" \
      --timeout=180s >/dev/null 2>&1 || restore_ok=0
    wrc_restore_verified || restore_ok=0
  fi
  if [ "$restore_ok" = 1 ]; then
    delete_proxy_resources || cleanup_failed=1
  else
    cleanup_failed=1
  fi
  if [ "$cleanup_failed" = 0 ] && [ "$restore_ok" = 1 ]; then
    release_lock || cleanup_failed=1
  fi
  if [ "$cleanup_failed" != 0 ]; then
    echo "WRC egress E2E cleanup/restore failed; lock retained at ${WRC_NS}/${LOCK_NAME}." >&2
    echo "Inspect: kubectl --context=${E2E_KUBECONTEXT} -n ${WRC_NS} get deployment ${WRC_DEPLOY} -o yaml" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

require_branch_owned_hcc_gate "$WRC_NS"
acquire_lock

[ -r "$DNS_PROXY_SCRIPT" ] || die "DNS proxy fixture is missing at ${DNS_PROXY_SCRIPT}"
deployment_ready "$WRC_NS" "$WRC_DEPLOY" || die "WRC is not Ready before fault injection"
deployment_ready "$WRC_NS" control-api || die "control-api is not Ready before fault injection"
deployment_ready "$WRC_NS" host-context-controller || die "HCC is not Ready before fault injection"

ORIGINAL_REPLICAS="$(kctl get deployment "$WRC_DEPLOY" -n "$WRC_NS" -o jsonpath='{.spec.replicas}')"
[ "$ORIGINAL_REPLICAS" = 1 ] || die "expected one WRC replica, found ${ORIGINAL_REPLICAS:-unknown}"
ORIGINAL_DNS_POLICY="$(kctl get deployment "$WRC_DEPLOY" -n "$WRC_NS" -o json |
  jq -r '.spec.template.spec.dnsPolicy // "ClusterFirst"')"
[ "$ORIGINAL_DNS_POLICY" = ClusterFirst ] || die "WRC already has non-default dnsPolicy"
ORIGINAL_DNS_CONFIG="$(kctl get deployment "$WRC_DEPLOY" -n "$WRC_NS" -o json |
  jq -c '.spec.template.spec.dnsConfig // null')"
[ "$ORIGINAL_DNS_CONFIG" = null ] || die "WRC already has a dnsConfig; refusing non-restorable mutation"
WRC_IMAGE="$(kctl get deployment "$WRC_DEPLOY" -n "$WRC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="workflow-recipes")].image}')"
[ -n "$WRC_IMAGE" ] || die "could not resolve WRC image"
UPSTREAM_DNS_IP="$(kctl get service kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}')"
[ -n "$UPSTREAM_DNS_IP" ] || die "could not resolve kube-dns ClusterIP"

kctl create configmap "$DNS_PROXY_CONFIGMAP" -n "$WRC_NS" \
  --from-file="server.cjs=${DNS_PROXY_SCRIPT}" --dry-run=client -o yaml |
  kctl apply -f - >/dev/null
PROXY_CREATED=1

kctl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DNS_PROXY}
  namespace: ${WRC_NS}
  labels: {e2e.clerum.io/suite: ${SUITE_NAME}, e2e.clerum.io/run: "${RUN_LABEL}"}
spec:
  replicas: 1
  selector: {matchLabels: {app: ${DNS_PROXY}}}
  template:
    metadata:
      labels: {app: ${DNS_PROXY}, e2e.clerum.io/suite: ${SUITE_NAME}, e2e.clerum.io/run: "${RUN_LABEL}"}
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
      - name: dns-proxy
        image: ${WRC_IMAGE}
        imagePullPolicy: IfNotPresent
        command: [node, /fixture/server.cjs]
        env:
        - {name: TARGET_DNS, value: "${TARGET_DNS}"}
        - {name: ANSWER_IP, value: "${ANSWER_IP}"}
        - {name: UPSTREAM_DNS, value: "${UPSTREAM_DNS_IP}"}
        ports:
        - {name: dns-udp, containerPort: 8053, protocol: UDP}
        - {name: dns-tcp, containerPort: 8053, protocol: TCP}
        readinessProbe: {tcpSocket: {port: 8053}, periodSeconds: 1, failureThreshold: 10}
        volumeMounts:
        - {name: fixture, mountPath: /fixture, readOnly: true}
        resources:
          requests: {cpu: 5m, memory: 20Mi}
          limits: {cpu: 75m, memory: 64Mi}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          runAsGroup: 1000
          seccompProfile: {type: RuntimeDefault}
      volumes:
      - name: fixture
        configMap: {name: ${DNS_PROXY_CONFIGMAP}}
---
apiVersion: v1
kind: Service
metadata:
  name: ${DNS_PROXY}
  namespace: ${WRC_NS}
spec:
  selector: {app: ${DNS_PROXY}}
  ports:
  - {name: dns-udp, protocol: UDP, port: 53, targetPort: 8053}
  - {name: dns-tcp, protocol: TCP, port: 53, targetPort: 8053}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${DNS_PROXY_POLICY}
  namespace: ${WRC_NS}
spec:
  podSelector: {matchLabels: {app: ${DNS_PROXY}}}
  policyTypes: [Ingress, Egress]
  ingress:
  - from: [{podSelector: {matchLabels: {app: ${WRC_DEPLOY}}}}]
    ports:
    - {protocol: UDP, port: 53}
    - {protocol: UDP, port: 8053}
    - {protocol: TCP, port: 53}
    - {protocol: TCP, port: 8053}
  egress:
  - to:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}
      podSelector: {matchLabels: {k8s-app: kube-dns}}
    ports:
    - {protocol: UDP, port: 53}
    - {protocol: TCP, port: 53}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${WRC_DNS_POLICY}
  namespace: ${WRC_NS}
spec:
  podSelector: {matchLabels: {app: ${WRC_DEPLOY}}}
  policyTypes: [Egress]
  egress:
  - to: [{podSelector: {matchLabels: {app: ${DNS_PROXY}}}}]
    ports:
    - {protocol: UDP, port: 53}
    - {protocol: UDP, port: 8053}
    - {protocol: TCP, port: 53}
    - {protocol: TCP, port: 8053}
EOF

kctl rollout status deployment "$DNS_PROXY" -n "$WRC_NS" --timeout=90s >/dev/null ||
  die "DNS proxy did not become Ready"
wait_until 30 "DNS proxy listener" \
  bash -c "kubectl --context='${E2E_KUBECONTEXT}' logs deployment/'${DNS_PROXY}' -n '${WRC_NS}' -c dns-proxy | grep -Fq 'wrc egress DNS proxy ready'" ||
  die "DNS proxy did not report readiness"
DNS_PROXY_IP="$(kctl get service "$DNS_PROXY" -n "$WRC_NS" -o jsonpath='{.spec.clusterIP}')"
[ -n "$DNS_PROXY_IP" ] || die "DNS proxy Service has no ClusterIP"

WRC_MUTATED=1
dns_patch="$(jq -cn --arg nameserver "$DNS_PROXY_IP" '
  {spec:{template:{spec:{
    dnsPolicy:"None",
    dnsConfig:{nameservers:[$nameserver],options:[
      {name:"ndots",value:"1"},{name:"timeout",value:"2"},{name:"attempts",value:"1"}
    ]}
  }}}}
')"
kctl patch deployment "$WRC_DEPLOY" -n "$WRC_NS" --type=strategic -p "$dns_patch" >/dev/null
kctl rollout status deployment "$WRC_DEPLOY" -n "$WRC_NS" --timeout=180s >/dev/null ||
  die "WRC did not become Ready with the isolated DNS proxy"
deployment_ready "$WRC_NS" control-api || die "control-api lost readiness during WRC DNS setup"
deployment_ready "$WRC_NS" host-context-controller || die "HCC lost readiness during WRC DNS setup"
ok "isolated WRC DNS proxy is Ready without affecting control-api or HCC"

RECIPE_CREATED=1
kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NAMESPACE}
  labels: {e2e.clerum.io/suite: ${SUITE_NAME}, e2e.clerum.io/run: "${RUN_LABEL}"}
spec:
  description: WRC egress degradation E2E baseline
  contextRef: context1
  workloads:
  - id: frontend
    type: deployment
    image: clerum/mock-mcp-server:test
    port: 3001
    healthCheck: {type: http, path: /, port: 3001}
  - id: worker
    type: deployment
    image: clerum/mock-mcp-server:test
    port: 3001
    healthCheck: {type: http, path: /, port: 3001}
    egressBindings:
    - {dns: ${TARGET_DNS}, port: 443, protocol: TCP}
    - {dns: ${TARGET_DNS}, port: 8443, protocol: TCP}
  ui:
    workloadRef: frontend
    port: 3001
    title: WRC egress degradation fixture
    defaultPath: /
    egress:
      external:
      - {fqdn: ${TARGET_DNS}, port: 443}
      - {fqdn: ${TARGET_DNS}, port: 8443}
  security: {isolationLevel: minimal}
EOF

wait_until 180 "valid fixture recipe to become active" recipe_active ||
  die "fixture recipe did not become active"
wait_until 120 "initial UI egress policy" policy_matches_ports "$UI_NS" "$UI_POLICY" '[443,8443]' ||
  die "initial UI policy did not enforce both declared ports"
wait_until 120 "initial workload egress policy" policy_matches_ports "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" '[443,8443]' ||
  die "initial workload policy did not enforce both declared ports"
wait_until 120 "frontend business health" workload_health "$UI_NS" frontend ||
  die "frontend health endpoint was unavailable"
wait_until 120 "worker business health" workload_health "$RECIPE_NAMESPACE" worker ||
  die "worker health endpoint was unavailable"
ok "valid recipe is active, both workload health endpoints respond, and both policies enforce the declared set"

hold_before="$(dns_count hold)"
set_dns_mode hold || die "could not hold fixture DNS"
reduced_patch="$(jq -cn --arg dns "$TARGET_DNS" '
  [
    {op:"replace",path:"/spec/ui/egress/external",value:[{fqdn:$dns,port:443}]},
    {op:"replace",path:"/spec/workloads/1/egressBindings",value:[{dns:$dns,port:443,protocol:"TCP"}]}
  ]
')"
kctl patch workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NAMESPACE" --type=json \
  -p "$reduced_patch" >/dev/null
wait_until 60 "WRC DNS query to enter the deterministic hold" \
  dns_count_at_least hold "$((hold_before + 1))" || die "WRC never reached the DNS hold"
wait_until 60 "pre-DNS UI contraction" policy_matches_ports "$UI_NS" "$UI_POLICY" '[443]' ||
  die "UI port 8443 was not revoked before DNS completed"
wait_until 60 "pre-DNS workload contraction" policy_matches_ports "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" '[443]' ||
  die "workload port 8443 was not revoked before DNS completed"
recipe_active || die "correctly configured recipe left active before the held DNS completed"
workload_health "$UI_NS" frontend || die "frontend stopped serving during held DNS"
workload_health "$RECIPE_NAMESPACE" worker || die "worker stopped serving during held DNS"
ok "removed UI/workload permissions contracted before DNS completed while both services stayed healthy"

append_policy_port "$UI_NS" "$UI_POLICY" 9443
append_policy_port "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" 9443
policy_has_port "$UI_NS" "$UI_POLICY" 9443 || die "could not inject UI policy race"
policy_has_port "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" 9443 || die "could not inject workload policy race"

servfail_before="$(dns_count servfail)"
set_dns_mode servfail || die "could not release held DNS as SERVFAIL"
wait_until 90 "both WRC lanes to observe SERVFAIL" \
  dns_count_at_least servfail "$((servfail_before + 2))" ||
  die "UI and workload lanes did not both observe the transient DNS failure"
wait_until 90 "post-DNS UI re-contraction" policy_matches_ports "$UI_NS" "$UI_POLICY" '[443]' ||
  die "UI race widening survived transient DNS failure"
wait_until 90 "post-DNS workload re-contraction" policy_matches_ports "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" '[443]' ||
  die "workload race widening survived transient DNS failure"
wait_until 60 "recipe to remain active after proven fail-static" recipe_active ||
  die "correctly configured recipe was cut by transient DNS failure"
workload_health "$UI_NS" frontend || die "frontend health failed after transient DNS failure"
workload_health "$RECIPE_NAMESPACE" worker || die "worker health failed after transient DNS failure"
deployment_ready "$WRC_NS" "$WRC_DEPLOY" || die "WRC lost readiness during fault"
deployment_ready "$WRC_NS" control-api || die "control-api lost readiness during WRC fault"
deployment_ready "$WRC_NS" host-context-controller || die "HCC lost readiness during WRC fault"
ok "transient DNS failure removed concurrent widening, preserved proven port 443, and isolated blast radius"

ok_before="$(dns_count ok)"
set_dns_mode ok || die "could not restore successful DNS"
recovery_patch="$(jq -cn --arg description "WRC egress recovery ${RUN_ID}" \
  '{spec:{description:$description}}')"
kctl patch workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NAMESPACE" --type=merge \
  -p "$recovery_patch" >/dev/null
wait_until 90 "both WRC lanes to resolve after recovery" \
  dns_count_at_least ok "$((ok_before + 2))" || die "DNS recovery was not observed by both lanes"
wait_until 90 "recovered recipe active state" recipe_active || die "recipe did not recover active"
policy_matches_ports "$UI_NS" "$UI_POLICY" '[443]' || die "UI policy drifted after recovery"
policy_matches_ports "$RECIPE_NAMESPACE" "$WORKLOAD_POLICY" '[443]' ||
  die "workload policy drifted after recovery"
workload_health "$UI_NS" frontend || die "frontend health failed after DNS recovery"
workload_health "$RECIPE_NAMESPACE" worker || die "worker health failed after DNS recovery"
ok "successful DNS recovery reconverged both lanes without restoring removed or raced permissions"

echo "WRC_EGRESS_DEGRADATION_E2E_PASS"
echo "recipe=${RECIPE_NAMESPACE}/${RECIPE_NAME}"
echo "uiPolicy=${UI_NS}/${UI_POLICY}"
echo "workloadPolicy=${RECIPE_NAMESPACE}/${WORKLOAD_POLICY}"
