#!/usr/bin/env bash
# Proves that HCC exposes its real readiness and discovery endpoints while the
# initial Host fleet reconciliation is still demonstrably in progress.
#
# The gate temporarily routes HCC's control-api token issuance to an isolated
# in-cluster HTTP blocker, creates a gate-owned fleet while HCC is stopped, and
# restarts HCC. There are more fixture Hosts than two complete bounded worker
# waves, so the initial pass remains deterministically active even though each
# individual held token request has its own client timeout. No real Host or
# runtime-token Secret is modified.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-logs.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-logs.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-fixture.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"

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
HCC_GATEWAY_DEPLOY="${HCC_GATEWAY_DEPLOY:-host-context-controller-api-gateway}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
MCP_NS="${MCP_SERVER_NS:-mcp-server}"
TOKEN_REQUEST_PATH="/api/v1/auth/mcp-host/${HOST_NS}/standalone/tokens"
TOKEN_REQUEST_LOG_PREFIX="holding-token POST ${TOKEN_REQUEST_PATH} host="
RUN_ID="$(date +%s)-$$"
BLOCKER_NAME="$(truncate_rfc1123 "e2e-hcc-readiness-blocker-${RUN_ID}")"
BLOCKER_EGRESS_POLICY_NAME="$(truncate_rfc1123 "${BLOCKER_NAME}-egress")"
SUITE_NAME="hcc-readiness-bootstrap"
FIXTURE_HOST_PREFIX="$(truncate_rfc1123 "e2e-hcc-ready-${RUN_ID}")"
FIXTURE_CONTEXT="$(truncate_rfc1123 "e2e-hcc-ready-context-${RUN_ID}")"
FIXTURE_SECRET="$(truncate_rfc1123 "e2e-hcc-ready-llm-${RUN_ID}")"
START_MARKER='Starting initial Host background convergence'
COMPLETE_MARKER='Completed Host reconciliation after initial Host reconciliation'
FAIL_MARKER='Host reconciliation after initial Host reconciliation failed'
ORIGINAL_CONTROL_API_BASE_URL=""
ORIGINAL_REPLICAS=""
HCC_PORT=""
HOST_RECONCILE_CONCURRENCY=""
FIXTURE_HOST_COUNT=0
FIXTURE_HOST_NAMES=()
HCC_MUTATED=0
BLOCKER_CREATED=0
FIXTURES_CREATED=0
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
  local deadline now
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    "$@" && return 0
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

running_hcc_pod() {
  local rows
  rows="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null)" || return 1
  awk -F '\t' '$1 != "" && $2 == "" { print $1; exit }' <<<"$rows"
}

hcc_pods_absent() {
  local pods
  pods="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o name 2>/dev/null)" ||
    return 1
  [ -z "$pods" ]
}

hcc_logs() {
  local pod=$1
  kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller 2>/dev/null
}

hcc_log_contains() {
  local pod=$1 marker=$2 logs
  logs="$(hcc_logs "$pod")" || return 1
  hcc_log_snapshot_contains "$logs" "$marker"
}

blocker_holds_token_request() {
  local logs
  logs="$(kctl logs "deployment/${BLOCKER_NAME}" -n "$HCC_NS" 2>/dev/null)" || return 1
  hcc_log_snapshot_contains "$logs" \
    "${TOKEN_REQUEST_LOG_PREFIX}${FIXTURE_HOST_PREFIX}-"
}

blocker_fixture_request_count() {
  local logs
  logs="$(kctl logs "deployment/${BLOCKER_NAME}" -n "$HCC_NS" 2>/dev/null)" || return 1
  awk -v prefix="${TOKEN_REQUEST_LOG_PREFIX}${FIXTURE_HOST_PREFIX}-" '
    index($0, prefix) {
      host = substr($0, index($0, "host=") + length("host="))
      sub(/[[:space:]].*$/, "", host)
      if (!(host in seen)) {
        seen[host] = 1
        count += 1
      }
    }
    END { print count + 0 }
  ' <<<"$logs"
}

blocker_observed_more_than_one_worker_wave() {
  local count
  count="$(blocker_fixture_request_count)" || return 1
  [ "$count" -gt "$HOST_RECONCILE_CONCURRENCY" ]
}

initial_host_pass_is_active() {
  local pod=$1 logs
  logs="$(hcc_logs "$pod")" || return 1
  hcc_initial_pass_snapshot_is_active \
    "$logs" "$START_MARKER" "$COMPLETE_MARKER" "$FAIL_MARKER"
}

control_api_service_excludes_blocker() {
  kctl get endpointslice -n "$HCC_NS" -l 'kubernetes.io/service-name=control-api' -o json |
    jq -e --arg blocker "$BLOCKER_NAME" \
      'all(.items[]?.endpoints[]?; .targetRef.name != $blocker)' >/dev/null
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
    env "HCC_E2E_PORT=${HCC_PORT}" \
    node -e '
      const http = require("node:http");
      const request = http.get(
        {host: "127.0.0.1", port: Number(process.env.HCC_E2E_PORT), path: "/ready"},
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

running_hcc_gateway_pod() {
  ready_pod_name "$HCC_NS" "app=${HCC_GATEWAY_DEPLOY}"
}

hcc_gateway_deployment_ready() {
  kctl get deployment "$HCC_GATEWAY_DEPLOY" -n "$HCC_NS" -o json |
    jq -e '
      .spec.replicas == 1 and
      .status.observedGeneration == .metadata.generation and
      (.status.updatedReplicas // 0) == 1 and
      (.status.readyReplicas // 0) == 1 and
      (.status.availableReplicas // 0) == 1 and
      (.status.unavailableReplicas // 0) == 0
    ' >/dev/null
}

hcc_gateway_local_health_ok() {
  local pod
  pod="$(running_hcc_gateway_pod)" || return 1
  kctl exec "pod/${pod}" -n "$HCC_NS" -c nginx -- \
    wget -qO- http://127.0.0.1:8081/health |
    jq -e '.status == "ok"' >/dev/null
}

hcc_gateway_ready_proxy_unavailable() {
  local pod output status
  pod="$(running_hcc_gateway_pod)" || return 1
  output="$(
    kctl exec "pod/${pod}" -n "$HCC_NS" -c nginx -- \
      wget -T 70 -t 1 -O /dev/null -S http://127.0.0.1:8081/ready 2>&1
  )" && return 1
  status="$(
    awk '
      /^[[:space:]]*HTTP\/[0-9.]+[[:space:]]+[0-9][0-9][0-9]([[:space:]]|$)/ {
        code = $2
      }
      END {
        if (code != "") print code
      }
    ' <<<"$output"
  )"
  case "$status" in
    502|503|504) return 0 ;;
    *) return 1 ;;
  esac
}

hcc_gateway_remains_ready_without_hcc() {
  local duration=$1 deadline
  deadline=$(( $(date +%s) + duration ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    hcc_gateway_deployment_ready &&
      hcc_gateway_local_health_ok &&
      hcc_gateway_ready_proxy_unavailable &&
      hcc_gateway_deployment_ready &&
      hcc_gateway_local_health_ok ||
      return 1
    sleep 1
  done
}

hcc_gateway_ready_proxy_recovers() {
  local pod
  pod="$(running_hcc_gateway_pod)" || return 1
  kctl exec "pod/${pod}" -n "$HCC_NS" -c nginx -- \
    wget -qO- http://127.0.0.1:8081/ready |
    jq -e '.ready == true and .status == "ready"' >/dev/null
}

fixture_inputs_absent() {
  local hosts contexts secrets
  hosts="$(kctl get host -n "$HOST_NS" -l "e2e.clerum.io/suite=${SUITE_NAME}" \
    -o name 2>/dev/null)" || return 1
  contexts="$(kctl get context -n "$MCP_NS" -l "e2e.clerum.io/suite=${SUITE_NAME}" \
    -o name 2>/dev/null)" || return 1
  secrets="$(kctl get secret -n "$HOST_NS" -l "e2e.clerum.io/suite=${SUITE_NAME}" \
    -o name 2>/dev/null)" || return 1
  [ -z "${hosts}${contexts}${secrets}" ]
}

fixture_runtime_absent() {
  local host resources
  [ "${#FIXTURE_HOST_NAMES[@]}" -eq 0 ] && return 0
  for host in "${FIXTURE_HOST_NAMES[@]}"; do
    resources="$(
      kctl get deployment,service,serviceaccount,role,rolebinding,secret,persistentvolumeclaim,networkpolicy \
        -A -l "clerum.io/managed-by=host-context-controller,clerum.io/host=${host}" \
        -o name 2>/dev/null
    )" || return 1
    [ -z "$resources" ] || return 1
  done
}

fixture_resources_absent() {
  fixture_inputs_absent && fixture_runtime_absent
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
  probe_hcc_ready_pod && fixture_resources_absent
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

create_host_fixtures() {
  local index host
  FIXTURES_CREATED=1

  kctl apply -f - >/dev/null <<EOF || return 1
apiVersion: v1
kind: Secret
metadata:
  name: ${FIXTURE_SECRET}
  namespace: ${HOST_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_ID}"
type: Opaque
stringData:
  # Test-only placeholder: Host secret validation checks existence, while token
  # issuance is intentionally held before any mcp-host Deployment is created.
  OPENAI_API_KEY: "e2e-readiness-not-a-real-key"
---
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${FIXTURE_CONTEXT}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_ID}"
spec:
  contextId: ${FIXTURE_CONTEXT}
  description: Gate-owned Context for HCC Host bootstrap readiness.
  mcpServers: []
EOF

  for ((index = 1; index <= FIXTURE_HOST_COUNT; index++)); do
    host="$(printf '%s-%02d' "$FIXTURE_HOST_PREFIX" "$index")"
    FIXTURE_HOST_NAMES+=("$host")
    kctl apply -f - >/dev/null <<EOF || return 1
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: ${host}
  namespace: ${HOST_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE_NAME}
    e2e.clerum.io/run: "${RUN_ID}"
spec:
  host: ${host}
  contextRef: ${FIXTURE_CONTEXT}
  secretRef: ${FIXTURE_SECRET}
  model:
    provider: openai
    name: e2e-readiness
EOF
  done
}

delete_host_fixtures() {
  local failed=0 host
  kctl delete host -n "$HOST_NS" -l "e2e.clerum.io/suite=${SUITE_NAME}" \
    --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || failed=1
  kctl delete context -n "$MCP_NS" -l "e2e.clerum.io/suite=${SUITE_NAME}" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete secret -n "$HOST_NS" -l "e2e.clerum.io/suite=${SUITE_NAME}" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  [ "${#FIXTURE_HOST_NAMES[@]}" -eq 0 ] && return "$failed"
  for host in "${FIXTURE_HOST_NAMES[@]}"; do
    kctl delete \
      deployment,service,serviceaccount,role,rolebinding,secret,persistentvolumeclaim,networkpolicy \
      -A -l "clerum.io/managed-by=host-context-controller,clerum.io/host=${host}" \
      --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || failed=1
  done
  [ "$failed" = 0 ] || return 1
  wait_until 60 "all gate-owned Host inputs and managed runtime resources to disappear" \
    fixture_resources_absent
}

print_repair_instructions() {
  cat >&2 <<EOF
HCC readiness bootstrap cleanup could not restore a verified clean state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
Fixture Hosts: ${HOST_NS}/${FIXTURE_HOST_PREFIX}-*
Fixture Context: ${MCP_NS}/${FIXTURE_CONTEXT}
Fixture LLM Secret: ${HOST_NS}/${FIXTURE_SECRET}
Retained blocker: ${HCC_NS}/${BLOCKER_NAME}

Inspect before changing anything:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment ${HCC_DEPLOY} -o yaml
  kubectl --context=${E2E_KUBECONTEXT} -n ${HOST_NS} get host,secret -l e2e.clerum.io/suite=${SUITE_NAME}
  kubectl --context=${E2E_KUBECONTEXT} -n ${MCP_NS} get context -l e2e.clerum.io/suite=${SUITE_NAME}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment,service,networkpolicy -l e2e.clerum.io/hcc-readiness

Do not remove the blocker or HCC gate lock until HCC configuration, rollout, Pod readiness,
/ready, and fixture absence are verified.

Restore the original HCC replica count before verifying rollout and /ready:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} rollout status deployment/${HCC_DEPLOY} --timeout=180s
EOF
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1 hcc_stopped=1
  trap - EXIT
  set +e

  # Remove every gate-owned input while HCC is stopped. Restarting HCC with a
  # partially deleted fixture fleet would let the real control-api path mutate
  # those leftovers and make cleanup non-deterministic.
  if [ "$HCC_MUTATED" = 1 ]; then
    hcc_stopped=0
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 \
      >/dev/null 2>&1 || restore_ok=0
    if [ "$restore_ok" = 1 ]; then
      wait_until 120 "HCC pods to stop before fixture deletion" \
        hcc_pods_absent >/dev/null 2>&1 || restore_ok=0
    fi
    [ "$restore_ok" = 1 ] && hcc_stopped=1
  fi

  if [ "$FIXTURES_CREATED" = 1 ]; then
    if [ "$hcc_stopped" = 1 ]; then
      delete_host_fixtures >/dev/null 2>&1 || restore_ok=0
    else
      restore_ok=0
    fi
  fi

  if [ "$HCC_MUTATED" = 1 ] && [ "$restore_ok" = 1 ] &&
     [ -n "$ORIGINAL_CONTROL_API_BASE_URL" ]; then
    kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
      "CONTROL_API_BASE_URL=${ORIGINAL_CONTROL_API_BASE_URL}" >/dev/null 2>&1 ||
      restore_ok=0
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1 ||
      restore_ok=0
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s \
      >/dev/null 2>&1 || restore_ok=0
    if [ "$restore_ok" = 1 ]; then
      wait_until 240 \
        "restored HCC config, rollout, Ready pod, /ready, and fixture absence" \
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
  if [ "$status" = 0 ] && [ "$cleanup_failed" = 0 ] && [ "$restore_ok" = 1 ]; then
    header "HCC readiness bootstrap gate passed"
  fi
  exit "$status"
}
trap cleanup EXIT

header "HCC readiness during initial Host fleet reconciliation"

require_branch_owned_hcc_gate "$HCC_NS"
ok "branch helper, profile, exact HEAD/fingerprint/gate verified"

kctl get nodes -o json |
  jq -e --arg context "$E2E_KUBECONTEXT" \
    'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $context)' >/dev/null ||
  die "target context is not a minikube cluster"
readiness_blocker_suite_absent ||
  die "stale HCC readiness blocker resources exist; inspect them before fault injection"
fixture_inputs_absent ||
  die "stale ${SUITE_NAME} Host, Context, or Secret fixtures exist; inspect them before fault injection"
acquire_hcc_watch_gate_lock ||
  die "another disruptive HCC gate owns context ${E2E_KUBECONTEXT}"
ok "exclusive HCC fault-injection lock acquired"

HCC_DEPLOYMENT_JSON="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json)" ||
  die "could not read HCC Deployment"
ORIGINAL_REPLICAS="$(jq -r '.spec.replicas // empty' <<<"$HCC_DEPLOYMENT_JSON")"
[ "$ORIGINAL_REPLICAS" = 1 ] ||
  die "expected exactly one HCC replica, found ${ORIGINAL_REPLICAS:-unknown}"
ORIGINAL_CONTROL_API_BASE_URL="$(jq -r '
  first(
    .spec.template.spec.containers[]? |
    select(.name == "host-context-controller") |
    .env[]? |
    select(.name == "CONTROL_API_BASE_URL") |
    .value
  ) // empty
' <<<"$HCC_DEPLOYMENT_JSON")"
[ -n "$ORIGINAL_CONTROL_API_BASE_URL" ] ||
  die "HCC CONTROL_API_BASE_URL is missing"
HCC_PORT="$(jq -r '
  .spec.template.spec.containers[]? |
  select(.name == "host-context-controller") as $container |
  (
    [$container.env[]? | select(.name == "CONTEXT_MAPPER_PORT") | .value][0] //
    [$container.ports[]? | select(.name == "http") | .containerPort][0] //
    empty
  )
' <<<"$HCC_DEPLOYMENT_JSON")"
[[ "$HCC_PORT" =~ ^[0-9]+$ ]] && [ "$HCC_PORT" -ge 1 ] && [ "$HCC_PORT" -le 65535 ] ||
  die "could not resolve a valid HCC HTTP port from the Deployment"
HOST_RECONCILE_CONCURRENCY="$(jq -r '
  first(
    .spec.template.spec.containers[]? |
    select(.name == "host-context-controller") |
    .env[]? |
    select(.name == "HCC_HOST_FULL_RECONCILE_CONCURRENCY") |
    .value
  ) // "2"
' <<<"$HCC_DEPLOYMENT_JSON")"
[[ "$HOST_RECONCILE_CONCURRENCY" =~ ^[1-8]$ ]] ||
  die "HCC_HOST_FULL_RECONCILE_CONCURRENCY must be 1..8, found ${HOST_RECONCILE_CONCURRENCY}"
FIXTURE_HOST_COUNT=$((HOST_RECONCILE_CONCURRENCY * 2 + 1))
HCC_IMAGE="$(jq -r '
  first(
    .spec.template.spec.containers[]? |
    select(.name == "host-context-controller") |
    .image
  ) // empty
' <<<"$HCC_DEPLOYMENT_JSON")"
[ -n "$HCC_IMAGE" ] || die "could not resolve the HCC image"
ok "planned ${FIXTURE_HOST_COUNT} gate-owned Hosts for concurrency ${HOST_RECONCILE_CONCURRENCY}"

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
        image: ${HCC_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
        - name: EXPECTED_TOKEN_PATH
          value: ${TOKEN_REQUEST_PATH}
        command: [node, -e]
        args:
        - >-
          require('http').createServer((request,response) => {
            if(request.method!=='POST'||request.url!==process.env.EXPECTED_TOKEN_PATH){
              console.log('rejecting '+request.method+' '+request.url);
              request.resume();
              request.on('end',()=>{response.statusCode=404;response.end()});
              return;
            }
            let body='';
            request.setEncoding('utf8');
            request.on('data',chunk=>{if(body.length<65536)body+=chunk;});
            request.on('end',()=>{
              let host='unknown';
              try{const parsed=JSON.parse(body);if(typeof parsed.host==='string')
              host=parsed.host;}catch{}
              console.log('holding-token '+request.method+' '+request.url+' host='+host);
            });
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
wait_until 120 "existing HCC pods to stop" hcc_pods_absent ||
  die "existing HCC pod did not stop"
hcc_gateway_remains_ready_without_hcc 20 ||
  die "HCC API gateway did not remain Ready on local /health while proxied /ready was unavailable"
ok "API gateway remained Ready for a complete probe-failure window while /ready reflected HCC unavailability"
create_host_fixtures ||
  die "could not create the gate-owned Host fleet while HCC was stopped"
ok "created ${FIXTURE_HOST_COUNT} gate-owned Hosts without modifying any real Host or Secret"
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
wait_until 120 "a gate-owned Host token request to reach the blocker" blocker_holds_token_request ||
  die "initial Host reconciliation never reached the deterministic blocker"
wait_until 180 "more than one bounded Host worker wave to reach the blocker" \
  blocker_observed_more_than_one_worker_wave ||
  die "fixture fleet did not prove progress beyond the first bounded Host worker wave"
initial_host_pass_is_active "$new_hcc_pod" ||
  die "initial Host reconciliation failed or completed before the readiness assertion"
ok "initial Host reconciliation is active beyond one bounded worker wave"

probe_script="$(cat <<'NODE'
const http = require('http');
function get(path) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {host: '127.0.0.1', port: Number(process.env.HCC_E2E_PORT), path},
      response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({status: response.statusCode, body}));
      }
    );
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
  env "HCC_E2E_PORT=${HCC_PORT}" node -e "$probe_script")" ||
  die "real HCC readiness/discovery HTTP probe failed while the fleet pass was active"
echo "$probe_result" | jq -e \
  '.readyStatus == 200 and .discoveryStatus == 200 and (.discoveredServers | type == "number")' \
  >/dev/null ||
  die "HCC HTTP probe returned an invalid result: ${probe_result}"
hcc_gateway_ready_proxy_recovers ||
  die "HCC API gateway /ready did not recover after HCC became ready"
initial_host_pass_is_active "$new_hcc_pod" ||
  die "initial Host reconciliation failed or completed before the HTTP assertions finished"
ok "/ready returned 200 while the initial Host fleet pass remained active"
ok "API gateway /ready recovered without changing its local readiness"
ok "/api/v1/mcpservers returned a valid live discovery response during that same pass"

header "HCC readiness assertions passed; restoring branch-owned runtime"
echo "$probe_result"
