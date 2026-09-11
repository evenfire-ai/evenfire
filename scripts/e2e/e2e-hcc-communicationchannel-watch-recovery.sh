#!/usr/bin/env bash
# Focused HCC CommunicationChannel watch-recovery gate.
#
# The gate routes HCC Kubernetes traffic through an ephemeral TCP proxy, drops
# the proxy twice without restarting HCC, and proves snapshot plus replacement
# watch convergence on an isolated stateless Host fixture.
# Fail-closed state while the API is unreachable is covered deterministically
# in unit tests; HCC cannot persist status through this deliberate outage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT or E2E_K8S_CONTEXT must select an explicit branch-scoped minikube context." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing HCC fault injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
[ "${E2E_HCC_WATCH_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_HCC_WATCH_FAULT_INJECTION=1 to acknowledge temporary HCC fault injection." >&2
  exit 1
}
kctl get nodes -o json | jq -e \
  --arg context "$E2E_KUBECONTEXT" \
  'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $context)' >/dev/null || {
  echo "Refusing HCC fault injection: target is not a minikube cluster." >&2
  exit 1
}

HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
MCP_NS="${MCP_NS:-mcp-server}"
SOURCE_HOST="${E2E_SOURCE_HOST_REF:-chatllm-stateless}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
CHANNEL_NS="${CHANNELS_NS:-channels}"
RUN_ID="$(date +%s)-$$"
CONTROL_HOST="$(truncate_rfc1123 "e2e-hcc-watch-control-${RUN_ID}")"
FIXTURE_HOST="$(truncate_rfc1123 "e2e-hcc-watch-${RUN_ID}")"
SIBLING_HOST="$(truncate_rfc1123 "e2e-hcc-watch-sibling-${RUN_ID}")"
RECOVERY_HOST="$(truncate_rfc1123 "e2e-hcc-watch-recovery-${RUN_ID}")"
FIXTURE_CHANNEL="$(truncate_rfc1123 "e2e-hcc-watch-channel-${RUN_ID}")"
PROXY_NAME="$(truncate_rfc1123 "e2e-hcc-api-proxy-${RUN_ID}")"
PROBE_NAME="$(truncate_rfc1123 "${PROXY_NAME}-negative-probe")"
PROXY_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-api")"
HCC_PROXY_NP="$(truncate_rfc1123 "${PROXY_NAME}-from-hcc")"
PROBE_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-from-probe")"
LOG_ARTIFACT="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-recovery.XXXXXX")"
HCC_LOG_BUFFER="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-stream.XXXXXX")"
NON_FIXTURE_BASELINE="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-baseline.XXXXXX")"
NON_FIXTURE_AFTER="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-after.XXXXXX")"
CLEANUP_KINDS="deployments,services,secrets,serviceaccounts,roles,rolebindings,networkpolicies,persistentvolumeclaims"
START_TIME="" HCC_UID="" HCC_RESTARTS="" CONTROL_IDENTITY="" ORIGINAL_REPLICAS=""
HCC_LOG_STREAM_PID=""
# Mirrors COMMUNICATION_CHANNEL_CACHE_RECOVERY_RETRY_MS in k8sClient.ts.
CC_RECOVERY_RETRY_SECONDS=5
POST_RECOVERY_QUIET_SECONDS=$((CC_RECOVERY_RETRY_SECONDS * 2))
TOTAL_RETRY_FAILURES=0 TOTAL_RETRY_FAILURE_LIMIT=0
HCC_PATCHED=0 CONTROL_CREATED=0 FIXTURE_CREATED=0 SIBLING_CREATED=0 RECOVERY_HOST_CREATED=0
CHANNEL_CREATED=0 PROXY_CREATED=0 PROBE_CREATED=0
HCC_GATE_LOCK_ACQUIRED=0 HCC_GATE_LOCK_NAME="" HCC_GATE_LOCK_UID=""
HCC_GATE_FINALIZATION_FAILURE=""

die() { fail "$*"; exit 1; }
now_rfc3339() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# This gate deliberately changes only the HCC Kubernetes API path.  If its
# rollout fails before the normal recovery log stream starts, preserve the
# bounded pod state and both container log buffers that distinguish a proxy,
# policy, or process-startup failure.  Cleanup still restores HCC afterwards.
print_hcc_proxy_rollout_diagnostics() {
  local pod

  echo "HCC proxy rollout diagnostics (before restoration):" >&2
  kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o json |
    jq -r '
      .items[] |
      .metadata.name as $pod |
      .status.phase as $phase |
      .status.containerStatuses[]? |
      "pod=\($pod) phase=\($phase // "unknown") ready=\(.ready) restarts=\(.restartCount) waiting=\(.state.waiting.reason // "none") terminated=\(.state.terminated.reason // "none") exitCode=\(.state.terminated.exitCode // "none") lastTerminated=\(.lastState.terminated.reason // "none") lastExitCode=\(.lastState.terminated.exitCode // "none")"
    ' >&2 || true

  while IFS= read -r pod; do
    [ -n "$pod" ] || continue
    echo "HCC proxy rollout previous logs for pod/${pod}:" >&2
    kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller \
      --previous --tail=120 >&2 || true
    echo "HCC proxy rollout current logs for pod/${pod}:" >&2
    kctl logs "pod/${pod}" -n "$HCC_NS" -c host-context-controller \
      --tail=120 >&2 || true
  done < <(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1 host remaining
  set +e
  stop_hcc_recovery_log_stream
  hcc_recovery_logs >"$LOG_ARTIFACT" 2>/dev/null || true
  if [ "$HCC_PATCHED" = 1 ]; then
    if restore_hcc_after_fault_injection >/dev/null 2>&1; then
      HCC_PATCHED=0
    else
      restore_ok=0
    fi
  fi
  if [ "$CHANNEL_CREATED" = 1 ]; then
    kctl delete communicationchannel "$FIXTURE_CHANNEL" -n "$CHANNEL_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    kctl wait --for=delete "communicationchannel/${FIXTURE_CHANNEL}" -n "$CHANNEL_NS" --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$FIXTURE_CREATED" = 1 ]; then
    kctl delete host "$FIXTURE_HOST" -n "$HOST_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    kctl wait --for=delete "host/${FIXTURE_HOST}" -n "$HOST_NS" --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$SIBLING_CREATED" = 1 ]; then
    kctl delete host "$SIBLING_HOST" -n "$HOST_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    kctl wait --for=delete "host/${SIBLING_HOST}" -n "$HOST_NS" --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$RECOVERY_HOST_CREATED" = 1 ]; then
    kctl delete host "$RECOVERY_HOST" -n "$HOST_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    kctl wait --for=delete "host/${RECOVERY_HOST}" -n "$HOST_NS" --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$CONTROL_CREATED" = 1 ]; then
    kctl delete host "$CONTROL_HOST" -n "$HOST_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    kctl wait --for=delete "host/${CONTROL_HOST}" -n "$HOST_NS" --timeout=60s >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [ "$restore_ok" = 1 ]; then
    for host in "$FIXTURE_HOST" "$SIBLING_HOST" "$RECOVERY_HOST" "$CONTROL_HOST"; do
      for _ in {1..45}; do
        remaining="$(kctl get "$CLEANUP_KINDS" -A -l "clerum.io/host=${host}" -o name 2>/dev/null)" || remaining=lookup-failed
        [ -z "$remaining" ] && break
        sleep 2
      done
      [ -z "$remaining" ] || cleanup_failed=1
    done
  fi
  if [ "$PROBE_CREATED" = 1 ]; then
    kctl delete pod "$PROBE_NAME" -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    PROBE_CREATED=0
  fi
  if [ "$restore_ok" = 1 ]; then
    [ "$PROXY_CREATED" = 0 ] || delete_hcc_proxy_fixture || cleanup_failed=1
  else
    cleanup_failed=1
    print_hcc_repair_instructions
    echo "  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}" >&2
    echo "  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} rollout status deployment/${HCC_DEPLOY} --timeout=180s" >&2
  fi
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  rm -f "$HCC_LOG_BUFFER" "$NON_FIXTURE_BASELINE" "$NON_FIXTURE_AFTER"
  if [ "$cleanup_failed" = 1 ]; then
    fail "fixture cleanup, HCC restoration, or lock finalization did not complete (${HCC_GATE_FINALIZATION_FAILURE:-unknown})"
    [ "$status" = 0 ] && status=1
  fi
  print_results
  echo "Filtered recovery log: ${LOG_ARTIFACT}"
  exit "$status"
}
trap cleanup EXIT

header "HCC CommunicationChannel watch recovery"
require_branch_owned_hcc_gate
acquire_hcc_watch_gate_lock || die "another HCC watch-recovery gate owns this profile"
kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" >/dev/null
ORIGINAL_REPLICAS="$(
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.replicas}'
)"
[ "$ORIGINAL_REPLICAS" = 1 ] ||
  die "expected exactly one HCC replica, found ${ORIGINAL_REPLICAS:-unknown}"
kctl get host "$SOURCE_HOST" -n "$HOST_NS" >/dev/null

host_override="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="KUBERNETES_SERVICE_HOST")].name}')"
port_override="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="KUBERNETES_SERVICE_PORT")].name}')"
api_cidrs_override="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="CONTEXT_MAPPER_K8S_API_CIDRS")].name}')"
[ -z "$host_override$port_override$api_cidrs_override" ] ||
  die "HCC already has an explicit Kubernetes service or API CIDR override"
[ -z "$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.hostAliases}')" ] ||
  die "HCC already has hostAliases; refusing a non-restorable fault injection"

HCC_IMAGE="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
[ -n "$HCC_IMAGE" ] || die "could not resolve the running HCC image"
K8S_API_SERVICE_HOST="$(kctl exec deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
  -c host-context-controller -- printenv KUBERNETES_SERVICE_HOST)" ||
  die "could not read the Kubernetes-injected API service IP"
kctl exec deployment/"$HCC_DEPLOY" -n "$HCC_NS" -c host-context-controller -- \
  node -e 'const { isIP } = require("node:net"); process.exit(isIP(process.argv[1]) === 4 ? 0 : 1)' \
  "$K8S_API_SERVICE_HOST" >/dev/null ||
  die "Kubernetes-injected API service host is not an IPv4 address"
K8S_API_CIDR="${K8S_API_SERVICE_HOST}/32"

log "Creating an isolated TCP proxy for the Kubernetes API"
create_hcc_api_proxy
verify_hcc_proxy_network_policy

PROXY_IP="$(kctl get service "$PROXY_NAME" -n "$HCC_NS" -o jsonpath='{.spec.clusterIP}')"
[ -n "$PROXY_IP" ] || die "proxy Service has no ClusterIP"
HCC_PATCHED=1
hcc_proxy_patch="$(jq -cn --arg ip "$PROXY_IP" --arg api_cidr "$K8S_API_CIDR" '{spec:{template:{spec:{
  hostAliases:[{ip:$ip,hostnames:["kubernetes.default.svc"]}],
  containers:[{name:"host-context-controller",env:[
    {name:"KUBERNETES_SERVICE_HOST",value:"kubernetes.default.svc"},
    {name:"KUBERNETES_SERVICE_PORT",value:"443"},
    {name:"CONTEXT_MAPPER_K8S_API_CIDRS",value:$api_cidr}
  ]}]
}}}}')"
kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=strategic -p "$hcc_proxy_patch" >/dev/null
if ! kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null; then
  print_hcc_proxy_rollout_diagnostics
  die "HCC did not become ready through the API proxy"
fi
initial_hcc_identity="$(wait_for_hcc_identity 30)" || die "could not capture HCC pod identity"
read -r HCC_UID HCC_RESTARTS <<<"$initial_hcc_identity"
[ -n "$HCC_UID" ] && [ "$HCC_UID" != invalid ] || die "could not capture HCC pod identity"
proxy_policy_cidrs="$(kctl get networkpolicy "allow-k8s-api-egress-${MCP_NS}" -n "$MCP_NS" -o json |
  jq -r '[.spec.egress[0].to[]?.ipBlock.cidr] | join(",")')" ||
  die "could not read the proxy-run API egress policy"
[ "$proxy_policy_cidrs" = "$K8S_API_CIDR" ] ||
  die "proxy-run API egress policy did not retain the injected Kubernetes API CIDR"
ok "HCC is healthy through the proxy (pod=${HCC_UID}, restarts=${HCC_RESTARTS})"

log "Creating one stateful control and two stateless Host fixtures"
CONTROL_CREATED=1
kctl get host "$SOURCE_HOST" -n "$HOST_NS" -o json |
  jq --arg name "$CONTROL_HOST" '{apiVersion,kind,
    metadata:{name:$name,namespace:.metadata.namespace,
      labels:{"e2e.clerum.io/suite":"hcc-watch-recovery"}},
    spec:((.spec + {host:$name,lifecycle:((.spec.lifecycle // {}) + {stateless:false})}) |
          del(.channels))}' |
  kctl apply -f - >/dev/null

FIXTURE_CREATED=1
CONTEXT="$E2E_KUBECONTEXT" E2E_HOST_REF="$SOURCE_HOST" \
  E2E_STATELESS_HOST_REF="$FIXTURE_HOST" STATELESS_SEED_SKIP_ASSOCIATION=1 \
  bash "${SCRIPT_DIR}/seed-stateless-host.sh" >/dev/null
kctl label host "$FIXTURE_HOST" -n "$HOST_NS" \
  e2e.clerum.io/suite=hcc-watch-recovery --overwrite >/dev/null
SIBLING_CREATED=1
CONTEXT="$E2E_KUBECONTEXT" E2E_HOST_REF="$SOURCE_HOST" \
  E2E_STATELESS_HOST_REF="$SIBLING_HOST" STATELESS_SEED_SKIP_ASSOCIATION=1 \
  bash "${SCRIPT_DIR}/seed-stateless-host.sh" >/dev/null
kctl label host "$SIBLING_HOST" -n "$HOST_NS" \
  e2e.clerum.io/suite=hcc-watch-recovery --overwrite >/dev/null

wait_for_deployment "$HOST_NS" "$CONTROL_HOST" 180 || die "stateful control Host did not become ready"
wait_host_mode "$FIXTURE_HOST" accepted || die "primary stateless fixture was not accepted"
wait_host_mode "$SIBLING_HOST" accepted || die "sibling stateless fixture was not accepted"
CONTROL_IDENTITY="$(deployment_identity "$CONTROL_HOST")"
assert_stateful_control
snapshot_non_fixture_invariants >"$NON_FIXTURE_BASELINE"
START_TIME="$(now_rfc3339)"
start_hcc_recovery_log_stream
ok "isolated Host fleet reached its baseline"

run_recovery_cycle() {
  local cycle=$1 cycle_logs recovery_logs outage_started outage_seconds max_retry_failures list_pattern
  local host_list_pattern ended_before started_before recovered_before failed_before
  local list_before host_list_before expected_host_count
  local failed_after retry_failures
  cycle_logs="$(hcc_recovery_logs)"
  ended_before="$(log_count_from "$cycle_logs" 'CommunicationChannel watch ended;')"
  started_before="$(log_count_from "$cycle_logs" 'Starting CommunicationChannel watch')"
  recovered_before="$(log_count_from "$cycle_logs" 'Recovered [0-9]+ CommunicationChannel\(s\) into cache')"
  failed_before="$(log_count_from "$cycle_logs" 'cache recovery failed;')"
  list_pattern="Listing all CommunicationChannels in namespace ${CHANNEL_NS}"
  host_list_pattern="Listing all Hosts in namespace ${HOST_NS}"
  list_before="$(log_count_from "$cycle_logs" "$list_pattern")"
  host_list_before="$(log_count_from "$cycle_logs" "$host_list_pattern")"
  log "Recovery cycle ${cycle}: disconnecting the HCC watch"
  outage_started="$(date +%s)"
  scale_proxy 0 || die "proxy did not stop in cycle ${cycle}"
  wait_log_count 'CommunicationChannel watch ended;' "$((ended_before + 1))" 60 ||
    die "HCC did not observe watch closure in cycle ${cycle}"
  assert_hcc_identity
  # An endpointless Service may leave the snapshot request in TCP connect until
  # endpoints return. Failed retry timing is deterministic unit-test territory;
  # this live gate proves that recovery starts and converges without a restart.
  wait_log_count "$list_pattern" "$((list_before + 1))" 30 ||
    die "cycle ${cycle} did not start snapshot recovery"

  if [ "$cycle" = 1 ]; then
    CHANNEL_CREATED=1
    apply_fixture_channel "$FIXTURE_HOST"
    RECOVERY_HOST_CREATED=1
    CONTEXT="$E2E_KUBECONTEXT" E2E_HOST_REF="$SOURCE_HOST" \
      E2E_STATELESS_HOST_REF="$RECOVERY_HOST" STATELESS_SEED_SKIP_ASSOCIATION=1 \
      bash "${SCRIPT_DIR}/seed-stateless-host.sh" >/dev/null
    kctl label host "$RECOVERY_HOST" -n "$HOST_NS" \
      e2e.clerum.io/suite=hcc-watch-recovery --overwrite >/dev/null
  fi
  expected_host_count="$(kctl get hosts -n "$HOST_NS" -o json | jq -r '.items | length')"
  [[ "$expected_host_count" =~ ^[1-9][0-9]*$ ]] ||
    die "cycle ${cycle} could not resolve the expected Host inventory size"

  scale_proxy 1 || die "proxy did not recover in cycle ${cycle}"
  wait_log_count 'Starting CommunicationChannel watch' "$((started_before + 1))" 60 ||
    die "replacement watch missing"
  wait_log_count 'Recovered [0-9]+ CommunicationChannel\(s\) into cache' \
    "$((recovered_before + 1))" 60 ||
    die "snapshot recovery missing in cycle ${cycle}"
  wait_log_count "$host_list_pattern" "$((host_list_before + 1))" 60 ||
    die "cycle ${cycle} did not obtain a fresh Host inventory"
  outage_seconds=$(( $(date +%s) - outage_started ))
  max_retry_failures=$((
    (outage_seconds + CC_RECOVERY_RETRY_SECONDS - 1) / CC_RECOVERY_RETRY_SECONDS + 2
  ))
  wait_recovery_cycle_fresh_host_inventory "$cycle" "$expected_host_count" 180 ||
    die "cycle ${cycle} did not reconcile the fresh ${expected_host_count}-Host inventory"
  recovery_logs="$(hcc_recovery_logs)"
  failed_after="$(log_count_from "$recovery_logs" 'cache recovery failed;')"
  retry_failures=$((failed_after - failed_before))
  [ "$retry_failures" -ge 0 ] && [ "$retry_failures" -le "$max_retry_failures" ] ||
    die "cycle ${cycle} used ${retry_failures} failed retries over ${outage_seconds}s; maximum ${max_retry_failures}"
  TOTAL_RETRY_FAILURES=$((TOTAL_RETRY_FAILURES + retry_failures))
  TOTAL_RETRY_FAILURE_LIMIT=$((TOTAL_RETRY_FAILURE_LIMIT + max_retry_failures))
  assert_hcc_identity

  if [ "$cycle" = 1 ]; then
    wait_host_mode "$RECOVERY_HOST" accepted ||
      die "fresh Host created during the outage did not converge from the recovery inventory"
    wait_host_mode "$FIXTURE_HOST" blocked || die "recovered snapshot missed the disconnected channel"
    wait_host_mode "$SIBLING_HOST" accepted || die "channel state leaked to the sibling Host"
    kctl delete communicationchannel "$FIXTURE_CHANNEL" -n "$CHANNEL_NS" >/dev/null
    wait_log_count "CommunicationChannel watch event: DELETED for ${FIXTURE_CHANNEL}" 1 60 ||
      die "replacement watch missed the channel deletion"
    CHANNEL_CREATED=0
  else
    CHANNEL_CREATED=1
    apply_fixture_channel "$SIBLING_HOST"
    wait_log_count "CommunicationChannel watch event: ADDED for ${FIXTURE_CHANNEL}" 1 60 ||
      die "second replacement watch missed the channel addition"
    wait_host_mode "$SIBLING_HOST" blocked || die "second replacement watch did not enforce always-on"
    wait_host_mode "$FIXTURE_HOST" accepted || die "sibling channel state leaked to the primary Host"
    kctl delete communicationchannel "$FIXTURE_CHANNEL" -n "$CHANNEL_NS" >/dev/null
    wait_log_count "CommunicationChannel watch event: DELETED for ${FIXTURE_CHANNEL}" 2 60 ||
      die "second replacement watch missed the channel deletion"
    CHANNEL_CREATED=0
  fi
  wait_host_mode "$FIXTURE_HOST" accepted || die "primary Host did not return to stateless mode"
  wait_host_mode "$SIBLING_HOST" accepted || die "sibling Host did not return to stateless mode"
  [ "$RECOVERY_HOST_CREATED" = 0 ] ||
    wait_host_mode "$RECOVERY_HOST" accepted || die "recovery Host did not remain stateless"
  assert_stateful_control
  ok "cycle ${cycle} recovered without restarting HCC or changing the stateful control Deployment/pods"
}

run_recovery_cycle 1
run_recovery_cycle 2

final_logs="$(hcc_recovery_logs)"
ended="$(log_count_from "$final_logs" 'CommunicationChannel watch ended;')"
started="$(log_count_from "$final_logs" 'Starting CommunicationChannel watch')"
recovered="$(log_count_from "$final_logs" 'Recovered [0-9]+ CommunicationChannel\(s\) into cache')"
failed="$(log_count_from "$final_logs" 'cache recovery failed;')"
fleet_passes="$(
  log_count_from "$final_logs" \
    'Completed Host reconciliation after (CommunicationChannel recovery|Host watch recovery convergence)$'
)"
[ "$ended" = 2 ] && [ "$started" = 2 ] && [ "$recovered" = 2 ] && \
  [ "$failed" = "$TOTAL_RETRY_FAILURES" ] && [ "$failed" -le "$TOTAL_RETRY_FAILURE_LIMIT" ] ||
  die "unexpected watch lifecycle counts: ended=${ended}, started=${started}, recovered=${recovered}, failed=${failed}"
[ "$fleet_passes" -ge 2 ] && [ "$fleet_passes" -le 4 ] ||
  die "unexpected successful fleet reconcile count ${fleet_passes}; expected 2..4 passes"
# Each recovered snapshot requires one causally ordered successful pass; a
# Host-watch recovery pass may cover the same fresh CC+Host inventories. At
# most one already queued covering pass may also finish per cycle. The deterministic
# max-concurrency=1 proof stays in k8sClient unit tests where overlapping passes
# can be barrier-controlled.

# Detect a replacement watch that ends again immediately after reported
# recovery. The complete 5s..300s retry ladder and timer cancellation are
# barrier/fake-timer controlled in k8sClient unit tests, not wall-clocked here.
sleep "$POST_RECOVERY_QUIET_SECONDS"
require_hcc_recovery_log_stream || die "HCC log stream ended during the quiet window"
quiet_logs="$(hcc_recovery_logs)"
[ "$(log_count_from "$quiet_logs" 'CommunicationChannel watch ended;')" = "$ended" ] &&
  [ "$(log_count_from "$quiet_logs" 'Starting CommunicationChannel watch')" = "$started" ] &&
  [ "$(log_count_from "$quiet_logs" 'Recovered [0-9]+ CommunicationChannel\(s\) into cache')" = "$recovered" ] &&
  [ "$(log_count_from "$quiet_logs" 'cache recovery failed;')" = "$failed" ] ||
  die "watch did not remain stable"
assert_hcc_identity
assert_stateful_control
snapshot_non_fixture_invariants >"$NON_FIXTURE_AFTER"
if ! cmp -s "$NON_FIXTURE_BASELINE" "$NON_FIXTURE_AFTER"; then
  diff -u "$NON_FIXTURE_BASELINE" "$NON_FIXTURE_AFTER" >&2 || true
  die "a non-fixture Host changed stateless eligibility or stateful Deployment/pod identity"
fi
ok "two watch recoveries converged with bounded fleet reconciliation and a stable replacement watch"
