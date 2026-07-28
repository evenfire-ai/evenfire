#!/usr/bin/env bash
# Proves that HCC exposes its real readiness and discovery endpoints while the
# initial Host fleet reconciliation is still demonstrably in progress.
#
# The gate temporarily routes HCC's control-api token issuance to an isolated
# in-cluster HTTP blocker, removes one HCC-owned Host bootstrap Secret, and
# restarts HCC. The blocker holds the resulting token request open, providing a
# deterministic boundary around the initial fleet pass without production test
# hooks or timing a large synthetic fleet.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"

[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT or E2E_K8S_CONTEXT must select an explicit branch-scoped minikube context." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing HCC readiness fault injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
[ "${E2E_HCC_READINESS_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_HCC_READINESS_FAULT_INJECTION=1 to acknowledge temporary HCC fault injection." >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}

HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
RUN_ID="$(date +%s)-$$"
BLOCKER_NAME="$(truncate_rfc1123 "e2e-hcc-readiness-blocker-${RUN_ID}")"
BLOCKER_EGRESS_POLICY_NAME="$(truncate_rfc1123 "${BLOCKER_NAME}-egress")"
START_MARKER='Starting initial Host background convergence'
COMPLETE_MARKER='Completed Host reconciliation after initial Host reconciliation'
FAIL_MARKER='Host reconciliation after initial Host reconciliation failed'
ORIGINAL_CONTROL_API_BASE_URL=""
ORIGINAL_REPLICAS=""
HOST_REF=""
RUNTIME_SECRET=""
HCC_MUTATED=0
BLOCKER_CREATED=0

die() {
  if [ -n "${new_hcc_pod:-}" ]; then
    echo "Recent HCC logs from ${new_hcc_pod}:" >&2
    kctl logs "pod/${new_hcc_pod}" -n "$HCC_NS" -c host-context-controller --tail=300 >&2 || true
  fi
  fail "$*"
  exit 1
}

wait_until() {
  local timeout=$1 description=$2
  shift 2
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    "$@" && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

running_hcc_pod() {
  kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null |
    awk -F '\t' '$1 != "" && $2 == "" { print $1; exit }'
}

hcc_log_contains() {
  local pod=$1 marker=$2
  kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller 2>/dev/null |
    grep -Fq "$marker"
}

blocker_holds_token_request() {
  kctl logs "deployment/${BLOCKER_NAME}" -n "$HCC_NS" 2>/dev/null |
    grep -Fq 'holding POST /api/v1/auth/mcp-host/'
}

control_api_service_excludes_blocker() {
  kctl get endpointslice -n "$HCC_NS" -l 'kubernetes.io/service-name=control-api' -o json |
    jq -e --arg blocker "$BLOCKER_NAME" \
      'all(.items[]?.endpoints[]?; .targetRef.name != $blocker)' >/dev/null
}

secret_restored() {
  kctl get secret "$RUNTIME_SECRET" -n "$HOST_NS" >/dev/null 2>&1
}

cleanup() {
  local status=$? cleanup_failed=0
  set +e

  if [ "$HCC_MUTATED" = 1 ] && [ -n "$ORIGINAL_CONTROL_API_BASE_URL" ]; then
    kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
      "CONTROL_API_BASE_URL=${ORIGINAL_CONTROL_API_BASE_URL}" >/dev/null 2>&1 ||
      cleanup_failed=1
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1 ||
      cleanup_failed=1
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1 ||
      cleanup_failed=1
    if [ -n "$RUNTIME_SECRET" ]; then
      wait_until 180 "HCC to restore ${RUNTIME_SECRET}" secret_restored >/dev/null 2>&1 ||
        cleanup_failed=1
    fi
  fi

  if [ "$BLOCKER_CREATED" = 1 ]; then
    kctl delete networkpolicy "$BLOCKER_EGRESS_POLICY_NAME" -n "$HCC_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 ||
      cleanup_failed=1
    kctl delete networkpolicy "$BLOCKER_NAME" -n "$HCC_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 ||
      cleanup_failed=1
    kctl delete service "$BLOCKER_NAME" -n "$HCC_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 ||
      cleanup_failed=1
    kctl delete deployment "$BLOCKER_NAME" -n "$HCC_NS" \
      --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 ||
      cleanup_failed=1
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    echo "HCC readiness gate cleanup failed on context ${E2E_KUBECONTEXT}." >&2
    echo "Verify deployment/${HCC_DEPLOY}, secret/${RUNTIME_SECRET:-unknown}, and ${BLOCKER_NAME}." >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT

header "HCC readiness during initial Host fleet reconciliation"

repo_root="$(git -C "${SCRIPT_DIR}/../.." rev-parse --show-toplevel)"
[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ] ||
  die "worktree has uncommitted changes; commit and pre-gate sync before runtime proof"
expected_worktree_id="$(printf '%s' "$repo_root" | shasum | awk '{print $1}')"
expected_head="$(git -C "$repo_root" rev-parse HEAD)"
actual_worktree_id="$(kctl get configmap clerum-pre-gate-sync-state -n "$HCC_NS" \
  -o jsonpath='{.data.worktreeId}' 2>/dev/null || true)"
actual_head="$(kctl get configmap clerum-pre-gate-sync-state -n "$HCC_NS" \
  -o jsonpath='{.data.gitHead}' 2>/dev/null || true)"
[ "$actual_worktree_id" = "$expected_worktree_id" ] ||
  die "cluster ownership marker does not match this worktree"
[ "$actual_head" = "$expected_head" ] ||
  die "cluster HEAD marker ${actual_head:-missing} does not match ${expected_head}"
ok "branch-scoped cluster ownership matches this clean worktree and HEAD"

kctl get nodes -o json |
  jq -e 'any(.items[]; .metadata.labels["minikube.k8s.io/name"] != null)' >/dev/null ||
  die "target context is not a minikube cluster"

ORIGINAL_REPLICAS="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.replicas}')"
[ "$ORIGINAL_REPLICAS" = 1 ] ||
  die "expected exactly one HCC replica, found ${ORIGINAL_REPLICAS:-unknown}"
ORIGINAL_CONTROL_API_BASE_URL="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="CONTROL_API_BASE_URL")].value}')"
[ -n "$ORIGINAL_CONTROL_API_BASE_URL" ] ||
  die "HCC CONTROL_API_BASE_URL is missing"

HOST_REF="${E2E_HCC_READY_HOST_REF:-$(kctl get hosts -n "$HOST_NS" -o json |
  jq -r '.items | sort_by(.metadata.name) | .[0].metadata.name // empty')}"
[ -n "$HOST_REF" ] || die "no Host exists in ${HOST_NS}"
RUNTIME_SECRET="host-${HOST_REF}-mcp-host-runtime-tokens"
ok "selected existing Host ${HOST_REF} as the real initial-fleet work item"

BLOCKER_CREATED=1
kctl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${BLOCKER_NAME}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/hcc-readiness: "${RUN_ID}"
spec:
  replicas: 1
  selector:
    matchLabels:
      e2e.clerum.io/hcc-readiness: "${RUN_ID}"
  template:
    metadata:
      labels:
        e2e.clerum.io/hcc-readiness: "${RUN_ID}"
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
      - name: blocker
        image: $(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')
        imagePullPolicy: IfNotPresent
        command: [node, -e]
        args:
        - >-
          require('http').createServer((request) => {
            console.log('holding ' + request.method + ' ' + request.url);
            request.resume();
          }).listen(8090, '0.0.0.0');
        readinessProbe:
          tcpSocket: {port: 8090}
          periodSeconds: 1
        resources:
          requests: {cpu: 5m, memory: 16Mi}
          limits: {cpu: 50m, memory: 48Mi}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          runAsGroup: 1000
          seccompProfile: {type: RuntimeDefault}
---
apiVersion: v1
kind: Service
metadata:
  name: ${BLOCKER_NAME}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/hcc-readiness: "${RUN_ID}"
spec:
  selector:
    e2e.clerum.io/hcc-readiness: "${RUN_ID}"
  ports:
  - name: http
    port: 8090
    targetPort: 8090
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${BLOCKER_EGRESS_POLICY_NAME}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/hcc-readiness: "${RUN_ID}"
spec:
  podSelector:
    matchLabels:
      app: ${HCC_DEPLOY}
  policyTypes: [Egress]
  egress:
  - to:
    - podSelector:
        matchLabels:
          e2e.clerum.io/hcc-readiness: "${RUN_ID}"
    ports:
    - protocol: TCP
      port: 8090
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${BLOCKER_NAME}
  namespace: ${HCC_NS}
  labels:
    e2e.clerum.io/hcc-readiness: "${RUN_ID}"
spec:
  podSelector:
    matchLabels:
      e2e.clerum.io/hcc-readiness: "${RUN_ID}"
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ${HCC_DEPLOY}
    ports:
    - protocol: TCP
      port: 8090
EOF
kctl rollout status deployment "$BLOCKER_NAME" -n "$HCC_NS" --timeout=90s >/dev/null ||
  die "isolated token-issuance blocker did not become ready"
control_api_service_excludes_blocker ||
  die "isolated blocker was selected by the real control-api Service"
ok "isolated in-cluster blocker is ready"

HCC_MUTATED=1
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null
kctl wait pod -n "$HCC_NS" -l "app=${HCC_DEPLOY}" --for=delete --timeout=120s >/dev/null ||
  die "existing HCC pod did not stop"
kctl delete secret "$RUNTIME_SECRET" -n "$HOST_NS" --ignore-not-found >/dev/null
kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
  "CONTROL_API_BASE_URL=http://${BLOCKER_NAME}.${HCC_NS}.svc.cluster.local:8090" >/dev/null
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1 >/dev/null

new_hcc_pod=""
capture_running_hcc() {
  new_hcc_pod="$(running_hcc_pod)"
  [ -n "$new_hcc_pod" ]
}
wait_until 120 "replacement HCC pod to enter Running" capture_running_hcc ||
  die "replacement HCC pod did not start"
wait_until 60 "initial Host reconciliation to start" \
  hcc_log_contains "$new_hcc_pod" "$START_MARKER" ||
  die "HCC never started the initial Host reconciliation"
wait_until 60 "the selected Host token request to reach the blocker" blocker_holds_token_request ||
  die "initial Host reconciliation never reached the deterministic blocker"
hcc_log_contains "$new_hcc_pod" "$FAIL_MARKER" &&
  die "initial Host reconciliation failed before the readiness assertion"
hcc_log_contains "$new_hcc_pod" "$COMPLETE_MARKER" &&
  die "initial Host reconciliation completed before the readiness assertion"
ok "initial Host fleet reconciliation is demonstrably active and blocked"

probe_script="$(cat <<'NODE'
const http = require('http');
function get(path) {
  return new Promise((resolve, reject) => {
    const request = http.get({host: '127.0.0.1', port: 8081, path}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({status: response.statusCode, body}));
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.once('error', reject);
  });
}
(async () => {
  const ready = await get('/ready');
  const readyBody = JSON.parse(ready.body);
  if (ready.status !== 200 || readyBody.status !== 'ready' || readyBody.ready !== true) {
    throw new Error('unexpected readiness response: ' + ready.status + ' ' + ready.body);
  }
  const discovery = await get('/api/v1/mcpservers');
  if (discovery.status !== 200) {
    throw new Error('unexpected discovery response: ' + discovery.status);
  }
  const discoveryBody = JSON.parse(discovery.body);
  if (!Array.isArray(discoveryBody.servers) || discoveryBody.contextRef !== '*') {
    throw new Error('discovery response does not match the live API contract');
  }
  console.log(JSON.stringify({readyStatus: ready.status, discoveryStatus: discovery.status,
    discoveredServers: discoveryBody.servers.length}));
})().catch(error => { console.error(error.message); process.exit(1); });
NODE
)"
probe_result="$(kctl exec "pod/${new_hcc_pod}" -n "$HCC_NS" -c host-context-controller -- \
  node -e "$probe_script")" ||
  die "real HCC readiness/discovery HTTP probe failed while the fleet pass was active"
echo "$probe_result" | jq -e \
  '.readyStatus == 200 and .discoveryStatus == 200 and (.discoveredServers | type == "number")' \
  >/dev/null ||
  die "HCC HTTP probe returned an invalid result: ${probe_result}"
hcc_log_contains "$new_hcc_pod" "$COMPLETE_MARKER" &&
  die "initial Host reconciliation completed before the HTTP assertions finished"
ok "/ready returned 200 while the initial Host fleet pass remained active"
ok "/api/v1/mcpservers returned a valid live discovery response during that same pass"

header "HCC readiness bootstrap gate passed"
echo "$probe_result"
