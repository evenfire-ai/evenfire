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
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"

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
# Read and mutated by the sourced compare-and-swap lock helper.
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0
# shellcheck disable=SC2034
HCC_GATE_LOCK_NAME=""
# shellcheck disable=SC2034
HCC_GATE_LOCK_UID=""
# shellcheck disable=SC2034
HCC_GATE_FINALIZATION_FAILURE=""

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

profile_env_value() {
  local key=$1 file=$2
  awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "$file"
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

readiness_blocker_suite_absent() {
  local resources
  resources="$(
    kctl get deployment,service,networkpolicy -n "$HCC_NS" \
      -l 'e2e.clerum.io/hcc-readiness' -o name 2>/dev/null
  )" || return 1
  [ -z "$resources" ]
}

probe_hcc_ready_pod() {
  local pod
  pod="$(ready_pod_name "$HCC_NS" "app=${HCC_DEPLOY}")" || return 1
  kctl exec "pod/${pod}" -n "$HCC_NS" -c host-context-controller -- \
    node -e '
      const http = require("node:http");
      const request = http.get(
        {host: "127.0.0.1", port: 8081, path: "/ready"},
        response => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { body += chunk; });
          response.on("end", () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { process.exit(2); }
            process.exit(response.statusCode === 200 && parsed?.ready === true ? 0 : 3);
          });
        }
      );
      request.setTimeout(5000, () => request.destroy(new Error("timeout")));
      request.once("error", () => process.exit(4));
    ' >/dev/null 2>&1
}

hcc_restore_is_verified() {
  local deployment
  deployment="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json)" || return 1
  jq -e \
    --arg controlApiBaseUrl "$ORIGINAL_CONTROL_API_BASE_URL" \
    --argjson replicas "${ORIGINAL_REPLICAS:-1}" '
      .spec.replicas == $replicas and
      .status.observedGeneration == .metadata.generation and
      (.status.updatedReplicas // 0) == $replicas and
      (.status.readyReplicas // 0) == $replicas and
      (.status.availableReplicas // 0) == $replicas and
      (.status.unavailableReplicas // 0) == 0 and
      any(.spec.template.spec.containers[]?;
        .name == "host-context-controller" and
        any(.env[]?;
          .name == "CONTROL_API_BASE_URL" and .value == $controlApiBaseUrl
        )
      )
    ' <<<"$deployment" >/dev/null || return 1
  secret_restored && probe_hcc_ready_pod
}

delete_blocker_fixture() {
  local failed=0
  kctl delete networkpolicy "$BLOCKER_EGRESS_POLICY_NAME" "$BLOCKER_NAME" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete service "$BLOCKER_NAME" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete deployment "$BLOCKER_NAME" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  [ "$failed" = 0 ]
}

print_repair_instructions() {
  cat >&2 <<EOF
HCC readiness bootstrap cleanup could not restore a verified clean state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
Runtime Secret: ${HOST_NS}/${RUNTIME_SECRET:-unknown}
Retained blocker: ${HCC_NS}/${BLOCKER_NAME}

Inspect before changing anything:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment ${HCC_DEPLOY} -o yaml
  kubectl --context=${E2E_KUBECONTEXT} -n ${HOST_NS} get secret ${RUNTIME_SECRET:-unknown}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment,service,networkpolicy -l e2e.clerum.io/hcc-readiness

Do not remove the blocker or HCC gate lock until HCC configuration, rollout, Pod readiness,
/ready, runtime Secret restoration, and fixture absence are verified.
EOF
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1
  trap - EXIT
  set +e

  if [ "$HCC_MUTATED" = 1 ] && [ -n "$ORIGINAL_CONTROL_API_BASE_URL" ]; then
    kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
      "CONTROL_API_BASE_URL=${ORIGINAL_CONTROL_API_BASE_URL}" >/dev/null 2>&1 ||
      restore_ok=0
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1 ||
      restore_ok=0
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s \
      >/dev/null 2>&1 || restore_ok=0
    if [ "$restore_ok" = 1 ]; then
      wait_until 180 \
        "restored HCC config, rollout, Ready pod, /ready, and ${RUNTIME_SECRET}" \
        hcc_restore_is_verified >/dev/null 2>&1 || restore_ok=0
    fi
  fi

  if [ "$restore_ok" = 1 ]; then
    if [ "$BLOCKER_CREATED" = 1 ]; then
      delete_blocker_fixture || cleanup_failed=1
    fi
    wait_until 60 "all HCC readiness blocker resources to disappear" \
      readiness_blocker_suite_absent >/dev/null 2>&1 || cleanup_failed=1
  else
    cleanup_failed=1
  fi

  if ! finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"; then
    cleanup_failed=1
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    echo "HCC readiness gate cleanup failed on context ${E2E_KUBECONTEXT}." >&2
    [ "$restore_ok" = 1 ] || print_repair_instructions
    [ "$status" = 0 ] && status=1
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
expected_short_head="$(git -C "$repo_root" rev-parse --short=8 HEAD)"
expected_branch="$(git -C "$repo_root" branch --show-current)"
[ -n "$expected_branch" ] ||
  die "branch-owned runtime proof requires a named branch, not detached HEAD"
[ -z "${MINIKUBE_PROFILE:-}" ] || [ "$MINIKUBE_PROFILE" = "$E2E_KUBECONTEXT" ] ||
  die "MINIKUBE_PROFILE ${MINIKUBE_PROFILE} disagrees with context ${E2E_KUBECONTEXT}"

profile_env="${E2E_BRANCH_PROFILE_ENV:-${HOME}/.cache/clerum/minikube-profiles/${E2E_KUBECONTEXT}/profile.env}"
[ -r "$profile_env" ] ||
  die "branch-profile helper evidence is missing at ${profile_env}; run a state-writing branch-profile helper action from this worktree"
[ "$(profile_env_value PROFILE "$profile_env")" = "$E2E_KUBECONTEXT" ] ||
  die "branch-profile helper output does not select context ${E2E_KUBECONTEXT}"
[ "$(profile_env_value REPO_DIR "$profile_env")" = "$repo_root" ] ||
  die "branch-profile helper output belongs to a different worktree"
[ "$(profile_env_value BRANCH "$profile_env")" = "$expected_branch" ] ||
  die "branch-profile helper output belongs to a different branch"
[ "$(profile_env_value SHA_SHORT "$profile_env")" = "$expected_short_head" ] ||
  die "branch-profile helper output belongs to a different HEAD"
[ "$(profile_env_value DIRTY "$profile_env")" = false ] ||
  die "branch-profile helper recorded a dirty worktree; refresh it after committing"

pre_gate_state_root="${E2E_PRE_GATE_STATE_ROOT:-${TMPDIR:-/tmp}/clerum-pre-gate-sync}"
cluster_fingerprint_file="${pre_gate_state_root}/${expected_worktree_id}/cluster.sha"
[ -r "$cluster_fingerprint_file" ] ||
  die "pre-gate fingerprint evidence is missing at ${cluster_fingerprint_file}"
expected_cluster_fingerprint="$(sed -n '1p' "$cluster_fingerprint_file")"
printf '%s\n' "$expected_cluster_fingerprint" | grep -Eq '^[0-9a-f]{40}$' ||
  die "pre-gate fingerprint evidence is malformed"
[ -n "${E2E_EXPECTED_PRE_GATE_GATE:-}" ] ||
  die "E2E_EXPECTED_PRE_GATE_GATE must name the gate recorded by the branch-owned pre-gate sync"

sync_marker="$(kctl get configmap clerum-pre-gate-sync-state -n "$HCC_NS" -o json \
  2>/dev/null)" ||
  die "cluster has no readable pre-gate sync marker"
actual_worktree_id="$(jq -r '.data.worktreeId // ""' <<<"$sync_marker")"
actual_head="$(jq -r '.data.gitHead // ""' <<<"$sync_marker")"
actual_cluster_fingerprint="$(jq -r '.data.clusterFingerprint // ""' <<<"$sync_marker")"
actual_gate="$(jq -r '.data.gate // ""' <<<"$sync_marker")"
[ "$actual_worktree_id" = "$expected_worktree_id" ] ||
  die "cluster ownership marker does not match this worktree"
[ "$actual_head" = "$expected_head" ] ||
  die "cluster HEAD marker ${actual_head:-missing} does not match ${expected_head}"
[ "$actual_cluster_fingerprint" = "$expected_cluster_fingerprint" ] ||
  die "cluster fingerprint marker does not match this worktree's last pre-gate sync"
[ "$actual_gate" = "$E2E_EXPECTED_PRE_GATE_GATE" ] ||
  die "cluster gate marker ${actual_gate:-missing} does not match expected ${E2E_EXPECTED_PRE_GATE_GATE}"
ok "branch helper, profile, exact HEAD/fingerprint/gate verified"

kctl get nodes -o json |
  jq -e 'any(.items[]; .metadata.labels["minikube.k8s.io/name"] != null)' >/dev/null ||
  die "target context is not a minikube cluster"
readiness_blocker_suite_absent ||
  die "stale HCC readiness blocker resources exist; inspect them before fault injection"
acquire_hcc_watch_gate_lock ||
  die "another disruptive HCC gate owns context ${E2E_KUBECONTEXT}"
ok "exclusive HCC fault-injection lock acquired"

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
kctl get secret "$RUNTIME_SECRET" -n "$HOST_NS" >/dev/null 2>&1 ||
  die "selected Host ${HOST_REF} has no existing runtime Secret ${RUNTIME_SECRET}; refusing a pre-degraded fixture"
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
