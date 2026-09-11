#!/usr/bin/env bash
# Values in the eval-based fixture harness are consumed by extracted gate
# functions, which static shell analysis cannot follow.
# shellcheck disable=SC2034
set -u

FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="${ROOT}/scripts/e2e"
WATCH_GATE="${SCRIPT_DIR}/e2e-hcc-communicationchannel-watch-recovery.sh"
READINESS_GATE="${SCRIPT_DIR}/e2e-hcc-readiness-bootstrap.sh"
MCP_READINESS_GATE="${SCRIPT_DIR}/e2e-hcc-mcp-context-readiness.sh"
HOST_BUNDLE_MEASURE="${SCRIPT_DIR}/measure-host-bundle-reconcile.sh"
HOST_STORM_GATE="${SCRIPT_DIR}/e2e-host-storm-gate.sh"
GATES=("$WATCH_GATE" "$READINESS_GATE" "$MCP_READINESS_GATE")
LOCK_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
LOG_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-logs.sh"
FIXTURE_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
HCC_K8S_CLIENT="${ROOT}/host-context-controller/src/k8sClient.ts"
HCC_EGRESS_COORDINATOR="$(
  printf '%s' "${ROOT}/host-context-controller/src/externalEgressConvergenceCoordinator.ts"
)"
HCC_NETWORK_POLICY_RECONCILER="$(
  printf '%s' "${ROOT}/host-context-controller/src/networkPolicyReconciler.ts"
)"
WATCH_GATE_TARGET="$(sed -n '/^test-e2e-hcc-communicationchannel-watch-recovery:/,/^$/p' "${ROOT}/Makefile")"
MOCK_STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/hcc-lock-test.XXXXXX")"
MOCK_LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/hcc-log-test.XXXXXX")"
MOCK_PROFILE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hcc-profile-test.XXXXXX")"
rm -f "$MOCK_STATE_FILE"
trap 'rm -f "$MOCK_STATE_FILE" "$MOCK_LOG_FILE"; rm -rf "$MOCK_PROFILE_ROOT"' EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

for script in "${GATES[@]}" "$LOCK_HELPER" "$LOG_HELPER" "$FIXTURE_HELPER"; do
  if bash -n "$script"; then
    pass "$(basename "$script") has valid bash syntax"
  else
    fail "$(basename "$script") has invalid bash syntax"
  fi
done

# A node carrying a minikube label from another profile must not satisfy the
# destructive-gate boundary. Each gate binds the label value to the explicit
# context instead of accepting any non-null label.
matching_nodes='{"items":[{"metadata":{"labels":{"minikube.k8s.io/name":"branch-profile"}}}]}'
mismatched_nodes='{"items":[{"metadata":{"labels":{"minikube.k8s.io/name":"other-profile"}}}]}'
if jq -e --arg context branch-profile \
     'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $context)' \
     <<<"$matching_nodes" >/dev/null &&
   ! jq -e --arg context branch-profile \
     'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $context)' \
     <<<"$mismatched_nodes" >/dev/null &&
   [ "$(grep -Fl 'minikube.k8s.io/name"] == $context' "${GATES[@]}" | wc -l | tr -d ' ')" = 3 ] &&
   ! grep -Fq 'minikube.k8s.io/name"] != null' "${GATES[@]}"; then
  pass "all destructive HCC gates bind the minikube node label to the explicit profile"
else
  fail "an HCC gate can accept a minikube node owned by another profile"
fi

# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$WATCH_GATE_TARGET" == *'E2E_EXPECTED_PRE_GATE_GATE="$(E2E_EXPECTED_PRE_GATE_GATE)"'* ]] &&
   [[ "$WATCH_GATE_TARGET" == *'MINIKUBE_PROFILE=$(E2E_KUBECONTEXT)'* ]]; then
  pass "CommunicationChannel gate target propagates exact pre-gate and profile ownership"
else
  fail "CommunicationChannel gate target omits exact pre-gate or profile ownership"
fi

proxy_rollout_function="$(
  sed -n '/^print_hcc_proxy_rollout_diagnostics() {$/,/^}$/p' "$WATCH_GATE"
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$proxy_rollout_function" == *'kctl get pods'* ]] &&
   [[ "$proxy_rollout_function" == *'--previous --tail=120'* ]] &&
   [[ "$proxy_rollout_function" == *'status.containerStatuses'* ]] &&
   [[ "$proxy_rollout_function" == *'// "unknown"'* ]] &&
   [[ "$proxy_rollout_function" != *'\\"unknown\\"'* ]] &&
   grep -Fq 'if ! kctl rollout status deployment "$HCC_DEPLOY"' "$WATCH_GATE" &&
   [ "$(grep -Fc 'print_hcc_proxy_rollout_diagnostics' "$WATCH_GATE")" = 2 ]; then
  pass "proxy rollout failure emits bounded HCC pod and previous-container diagnostics"
else
  fail "proxy rollout failure can discard the distinguishing HCC startup evidence"
fi

if (
  HCC_NS=control-plane
  HCC_DEPLOY='host-context-controller'
  kctl() {
    if [ "$1" = get ] && [ "$2" = pods ] && [[ "$*" == *"-o jsonpath="* ]]; then
      printf '%s\n' hcc-pod
    elif [ "$1" = get ] && [ "$2" = pods ]; then
      printf '%s\n' '{"items":[{"metadata":{"name":"hcc-pod"},"status":{"phase":"Pending","containerStatuses":[{"name":"host-context-controller","ready":false,"restartCount":2,"state":{"waiting":{"reason":"CrashLoopBackOff"}},"lastState":{}}]}}]}'
    elif [ "$1" = logs ]; then
      printf '%s\n' 'bounded diagnostic log'
    else
      return 1
    fi
  }
  eval "$proxy_rollout_function"
  output="$(print_hcc_proxy_rollout_diagnostics 2>&1)"
  [[ "$output" == *"pod=hcc-pod phase=Pending"* ]] &&
    [[ "$output" != *"pod=null"* ]] &&
    [[ "$output" != *"phase=null"* ]]
); then
  pass "proxy rollout diagnostics retain the parent pod identity and phase"
else
  fail "proxy rollout diagnostics lose pod metadata inside container status iteration"
fi

# The proxy changes only the HCC client's target hostname.  The HCC's
# allow-k8s-api-egress policies must retain the Kubernetes-injected API IP,
# which is the explicit fail-closed configuration seam for CIDR policy data.
# shellcheck disable=SC2016
if grep -Fq 'K8S_API_SERVICE_HOST="$(kctl exec deployment/"$HCC_DEPLOY"' "$WATCH_GATE" &&
   grep -Fq 'K8S_API_CIDR="${K8S_API_SERVICE_HOST}/32"' "$WATCH_GATE" &&
   grep -Fq -- '--arg api_cidr "$K8S_API_CIDR"' "$WATCH_GATE" &&
   grep -Fq 'CONTEXT_MAPPER_K8S_API_CIDRS",value:$api_cidr' "$WATCH_GATE" &&
   grep -Fq 'allow-k8s-api-egress-${MCP_NS}' "$WATCH_GATE" &&
   grep -Fq '[ "$proxy_policy_cidrs" = "$K8S_API_CIDR" ]' "$WATCH_GATE" &&
   grep -Fq 'CONTEXT_MAPPER_K8S_API_CIDRS-' "$FIXTURE_HELPER"; then
  pass "proxy fault injection preserves an explicit valid API egress CIDR and restores it"
else
  fail "proxy fault injection can turn a DNS hostname into an invalid API egress CIDR"
fi

if grep -Fq 'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"' "$READINESS_GATE" &&
   [ "$(grep -Fc 'require_branch_owned_hcc_gate "$HCC_NS"' "$READINESS_GATE")" = 1 ] &&
   ! grep -Fq 'HCC_BRANCH_GATE_SYNC_MARKER' "$READINESS_GATE" &&
   ! grep -Fq 'cluster_fingerprint_file=' "$READINESS_GATE" &&
   ! grep -Fq 'profile_env=' "$READINESS_GATE"; then
  pass "readiness gate delegates ownership, HEAD, profile, fingerprint, and gate proof once"
else
  fail "readiness gate duplicates, bypasses, or splits the shared branch-owned proof"
fi

bootstrap_repair_function="$(
  sed -n '/^print_repair_instructions() {$/,/^}$/p' "$READINESS_GATE"
)"
mcp_repair_function="$(
  sed -n '/^print_repair_instructions() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
# Literal source-code assertions: every fail-closed repair path must restore
# the captured replica count before treating rollout health as repair proof.
# shellcheck disable=SC2016
if [[ "$bootstrap_repair_function" == *'scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}'* ]] &&
   [[ "$bootstrap_repair_function" == *'rollout status deployment/${HCC_DEPLOY} --timeout=180s'* ]] &&
   [[ "$mcp_repair_function" == *'scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}'* ]] &&
   [[ "$mcp_repair_function" == *'rollout status deployment/${HCC_DEPLOY} --timeout=240s'* ]] &&
   grep -Fq 'scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}' "$WATCH_GATE" &&
   grep -Fq 'rollout status deployment/${HCC_DEPLOY} --timeout=180s' "$WATCH_GATE"; then
  pass "all HCC repair instructions restore the original replica count and verify rollout"
else
  fail "an HCC repair path can leave the controller scaled to zero"
fi

fixture_gate_function="$(sed -n '/^require_branch_owned_hcc_gate() {$/,/^}$/p' "$FIXTURE_HELPER")"
marker_get_count="$(
  grep -Fc 'kctl get configmap clerum-pre-gate-sync-state' <<<"$fixture_gate_function"
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [ "$marker_get_count" = 1 ] &&
   [[ "$fixture_gate_function" == *'-o json'* ]] &&
   [[ "$fixture_gate_function" == *'.data.worktreeId'* ]] &&
   [[ "$fixture_gate_function" == *'.data.gitHead'* ]] &&
   [[ "$fixture_gate_function" == *'<<<"$HCC_BRANCH_GATE_SYNC_MARKER"'* ]]; then
  pass "shared branch gate derives ownership and HEAD from one exported ConfigMap JSON snapshot"
else
  fail "shared branch gate can split ownership and HEAD across marker reads"
fi

# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$fixture_gate_function" == *'expected_branch="$(git -C "$HCC_BRANCH_GATE_REPO_ROOT" branch --show-current)"'* ]] &&
   [[ "$fixture_gate_function" == *'[ -n "$expected_branch" ]'* ]] &&
   [[ "$fixture_gate_function" == *'[ "${MINIKUBE_PROFILE:-}" = "$E2E_KUBECONTEXT" ]'* ]] &&
   [[ "$fixture_gate_function" == *'profile_env="${E2E_BRANCH_PROFILE_ENV:-'* ]] &&
   [[ "$fixture_gate_function" == *'profile_env_value PROFILE'* ]] &&
   [[ "$fixture_gate_function" == *'profile_env_value REPO_DIR'* ]] &&
   [[ "$fixture_gate_function" == *'profile_env_value BRANCH'* ]] &&
   [[ "$fixture_gate_function" != *'profile_env_value SHA_SHORT'* ]] &&
   [[ "$fixture_gate_function" == *'profile_env_value DIRTY'* ]] &&
   [[ "$fixture_gate_function" == *'cluster_fingerprint_file='* ]] &&
   [[ "$fixture_gate_function" == *'.data.clusterFingerprint'* ]] &&
   [[ "$fixture_gate_function" == *'.data.gate'* ]] &&
   [[ "$fixture_gate_function" == *'E2E_EXPECTED_PRE_GATE_GATE'* ]]; then
  pass "shared branch gate owns the complete profile, fingerprint, and expected-gate proof"
else
  fail "shared branch gate omits a required profile, fingerprint, or expected-gate boundary"
fi

for gate in "${GATES[@]}"; do
  marker_reads="$(grep -Fc 'kctl get configmap clerum-pre-gate-sync-state' "$gate")"
  if [ "$marker_reads" = 0 ] &&
     ! grep -Fq 'profile_env=' "$gate" &&
     ! grep -Fq 'cluster_fingerprint_file=' "$gate" &&
     grep -Fq 'require_branch_owned_hcc_gate' "$gate"; then
    pass "$(basename "$gate") delegates its branch-owned proof to the shared authority"
  else
    fail "$(basename "$gate") duplicates or bypasses the shared branch-owned proof"
  fi
done

run_branch_gate_case() (
  local mode=$1
  local repo_root="${MOCK_PROFILE_ROOT}/repo"
  local context="clerum-codex-profile-test-1234abcd"
  local head="1111111111111111111111111111111111111111"
  local short_head="11111111"
  local branch="codex/profile-test"
  local fingerprint="2222222222222222222222222222222222222222"
  local marker_fingerprint="$fingerprint"
  local expected_gate="full"
  local marker_gate="$expected_gate"
  local minikube_profile="$context"
  local profile="$context"
  local profile_repo="$repo_root"
  local profile_branch="$branch"
  local profile_sha="$short_head"
  local profile_dirty=false
  local mock_worktree_dirty=""
  local worktree_id
  worktree_id="$(printf '%s' "$repo_root" | shasum | awk '{print $1}')"

  case "$mode" in
    success) ;;
    detached) branch="" ;;
    minikube-profile-missing) minikube_profile="" ;;
    minikube-profile) minikube_profile="clerum-other-profile-1234abcd" ;;
    profile-name) profile="clerum-other-profile-1234abcd" ;;
    profile-repo) profile_repo="${repo_root}-other" ;;
    profile-branch) profile_branch="codex/other" ;;
    reused-profile) profile_sha="aaaaaaaa" ;;
    profile-dirty) profile_dirty=true ;;
    dirty-worktree) mock_worktree_dirty=" M changed.ts" ;;
    fingerprint) marker_fingerprint="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
    gate) marker_gate="targeted" ;;
    *) exit 98 ;;
  esac

  mkdir -p "${MOCK_PROFILE_ROOT}/state/${worktree_id}"
  printf '%s\n' "$fingerprint" >"${MOCK_PROFILE_ROOT}/state/${worktree_id}/cluster.sha"
  printf '%s\n' \
    "PROFILE=${profile}" \
    "REPO_DIR=${profile_repo}" \
    "BRANCH=${profile_branch}" \
    "SHA_SHORT=${profile_sha}" \
    "DIRTY=${profile_dirty}" >"${MOCK_PROFILE_ROOT}/profile.env"

  E2E_KUBECONTEXT="$context"
  MINIKUBE_PROFILE="$minikube_profile"
  E2E_BRANCH_PROFILE_ENV="${MOCK_PROFILE_ROOT}/profile.env"
  E2E_PRE_GATE_STATE_ROOT="${MOCK_PROFILE_ROOT}/state"
  E2E_EXPECTED_PRE_GATE_GATE="$expected_gate"
  HCC_NS=control-plane
  SCRIPT_DIR="${ROOT}/scripts/e2e"
  MOCK_MARKER="$(
    jq -cn --arg worktreeId "$worktree_id" --arg gitHead "$head" \
      --arg clusterFingerprint "$marker_fingerprint" --arg gate "$marker_gate" \
      '{data:{worktreeId:$worktreeId,gitHead:$gitHead,
        clusterFingerprint:$clusterFingerprint,gate:$gate}}'
  )"

  is_branch_scoped_e2e_context() { return 0; }
  die() { exit 97; }
  git() {
    local command=$3
    shift 3
    case "$command $*" in
      "rev-parse --show-toplevel") printf '%s\n' "$repo_root" ;;
      "status --porcelain --untracked-files=normal") printf '%s\n' "$mock_worktree_dirty" ;;
      "rev-parse HEAD") printf '%s\n' "$head" ;;
      "rev-parse --short=8 HEAD") printf '%s\n' "$short_head" ;;
      "branch --show-current") printf '%s\n' "$branch" ;;
      *) return 96 ;;
    esac
  }
  kctl() { printf '%s\n' "$MOCK_MARKER"; }
  # shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-fixture.sh
  source "$FIXTURE_HELPER"
  require_branch_owned_hcc_gate "$HCC_NS"
)

if run_branch_gate_case success; then
  pass "shared branch gate accepts matching branch-profile evidence"
else
  fail "shared branch gate rejects matching branch-profile evidence"
fi
if run_branch_gate_case reused-profile; then
  pass "shared branch gate accepts a reused same-branch profile after an exact-head pre-gate sync"
else
  fail "shared branch gate rejects a reused same-branch profile despite exact-head pre-gate evidence"
fi
for case_name in detached minikube-profile-missing minikube-profile profile-name profile-repo profile-branch \
  profile-dirty dirty-worktree fingerprint gate; do
  if run_branch_gate_case "$case_name" >/dev/null 2>&1; then
    fail "shared branch gate accepted mismatched ${case_name} evidence"
  else
    pass "shared branch gate rejects mismatched ${case_name} evidence"
  fi
done

retry_progress_function="$(
  sed -n '/^external_egress_retry_progress_is_observed() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
retry_query_function="$(
  sed -n '/^dns_retry_query_observed_since_schedule() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
if (
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  CONTEXT_NAME=e2e-context
  MOCK_HCC_LOG='
[K8s] Initial external egress reconciliation failed for mcp-server/e2e-held-server; runtime reconciliation will stay blocked until retry succeeds: dns timeout
[K8s] Scheduling external egress retry 1/3 for McpServer "e2e-held-server" in 5000ms
'
  kctl() { printf '%s\n' "$MOCK_HCC_LOG"; }
  eval "$retry_progress_function"
  external_egress_retry_progress_is_observed
); then
  pass "DNS failure is attributed to the dedicated external-egress retry lane"
else
  fail "the injected DNS hold cannot prove dedicated external-egress retry progress"
fi
if (
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  CONTEXT_NAME=e2e-context
  MOCK_HCC_LOG='
[K8s] Initial external egress reconciliation failed for mcp-server/e2e-held-server; runtime reconciliation will stay blocked until retry succeeds: dns timeout
[K8s] Scheduling external egress retry 1/3 for McpServer "different-server" in 5000ms
[K8s] unrelated message for McpServer "e2e-held-server"
'
  kctl() { printf '%s\n' "$MOCK_HCC_LOG"; }
  eval "$retry_progress_function"
  ! external_egress_retry_progress_is_observed
); then
  pass "external-egress retry evidence cannot combine a peer retry with the fixture server marker"
else
  fail "external-egress retry evidence can be assembled from different log lines or servers"
fi
if (
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  CONTEXT_NAME=e2e-context
  MOCK_HCC_LOG='
[K8s] Initial external egress reconciliation failed for mcp-server/e2e-held-server; runtime reconciliation will stay blocked until retry succeeds: dns timeout
[K8s] Scheduling external egress retry 1/3 for McpServer "e2e-held-server" in 5000ms
'
  for ((line = 0; line < 4096; line++)); do
    MOCK_HCC_LOG+=$'\n[K8s] unrelated high-volume log line'
  done
  kctl() { printf '%s\n' "$MOCK_HCC_LOG"; }
  eval "$retry_progress_function"
  external_egress_retry_progress_is_observed
); then
  pass "an early matching retry line survives a high-volume log buffer without SIGPIPE ambiguity"
else
  fail "a valid early retry marker is lost in a high-volume log buffer"
fi
if (
  DNS_HOLD_COUNT_AT_RETRY_SCHEDULE=3
  dns_hold_count() { printf '%s\n' 4; }
  eval "$retry_query_function"
  dns_retry_query_observed_since_schedule
); then
  pass "a post-schedule DNS query proves the dedicated retry executed"
else
  fail "a fresh DNS query after scheduling does not prove retry execution"
fi
if (
  DNS_HOLD_COUNT_AT_RETRY_SCHEDULE=3
  dns_hold_count() { printf '%s\n' 3; }
  eval "$retry_query_function"
  ! dns_retry_query_observed_since_schedule
); then
  pass "a pre-schedule DNS query cannot satisfy retry execution"
else
  fail "stale DNS evidence can masquerade as retry execution"
fi
if grep -Fq '{name:"timeout",value:"30"}' "$MCP_READINESS_GATE" &&
   grep -Fq '{name:"attempts",value:"1"}' "$MCP_READINESS_GATE"; then
  pass "the DNS fixture disables resolver retransmits that could counterfeit retry execution"
else
  fail "the DNS fixture can mistake a resolver retransmit for a dedicated retry"
fi

# Full marker inventory: every runtime log marker any HCC gate consumes, paired
# with the producer statement that emits it. Both sides are matched as fixed
# source text, never as a rendered string: a template literal is pinned by its
# fixed prefix plus the variable that supplies the dynamic identity, so a
# marker that only ever exists rendered (`${config.hostNamespace}`,
# `${reason}`, `${type}`, `${snapshot.channels.length}`) still resolves without
# reporting false drift. Matching the consumer side too means a rename on
# either side breaks the pair instead of silently disarming a live gate: the
# marker no longer matches any log line, the count stays zero, and the gate
# passes on evidence it never observed.
# Entries are flat 4-tuples: consumer file, consumer text, producer file,
# producer text.
# shellcheck disable=SC2016
marker_bindings=(
  "$WATCH_GATE" 'CommunicationChannel watch ended;'
  "$HCC_K8S_CLIENT" 'CommunicationChannel watch ended; holding stateless lifecycle active'

  "$WATCH_GATE" 'Starting CommunicationChannel watch'
  "$HCC_K8S_CLIENT" '[K8s] Starting CommunicationChannel watch'

  "$WATCH_GATE" 'Recovered [0-9]+ CommunicationChannel\(s\) into cache'
  "$HCC_K8S_CLIENT" 'Recovered ${snapshot.channels.length} CommunicationChannel(s) into cache'

  "$WATCH_GATE" 'cache recovery failed;'
  "$HCC_K8S_CLIENT" 'CommunicationChannel cache recovery failed; stateless lifecycle remains held active'

  "$WATCH_GATE" 'Listing all CommunicationChannels in namespace ${CHANNEL_NS}'
  "$HCC_K8S_CLIENT" 'Listing all CommunicationChannels in namespace ${config.channelsNamespace}'

  "$WATCH_GATE" 'Listing all Hosts in namespace ${HOST_NS}'
  "$HCC_K8S_CLIENT" 'Listing all Hosts in namespace ${config.hostNamespace}'

  "$WATCH_GATE" 'Completed Host reconciliation after (CommunicationChannel recovery|Host watch recovery convergence)$'
  "$HCC_K8S_CLIENT" 'Completed Host reconciliation after ${reason}'

  "$WATCH_GATE" 'CommunicationChannel watch event: DELETED for ${FIXTURE_CHANNEL}'
  "$HCC_K8S_CLIENT" 'CommunicationChannel watch event: ${type} for ${cc.name}'

  "$WATCH_GATE" 'CommunicationChannel watch event: ADDED for ${FIXTURE_CHANNEL}'
  "$HCC_K8S_CLIENT" 'CommunicationChannel watch event: ${type} for ${cc.name}'

  "$LOG_HELPER" 'CommunicationChannel watch ended;'
  "$HCC_K8S_CLIENT" 'CommunicationChannel watch ended; holding stateless lifecycle active'

  "$LOG_HELPER" 'Recovered [0-9]+ CommunicationChannel\(s\) into cache'
  "$HCC_K8S_CLIENT" 'Recovered ${snapshot.channels.length} CommunicationChannel(s) into cache'

  "$LOG_HELPER" 'Listing all Hosts in namespace '
  "$HCC_K8S_CLIENT" 'Listing all Hosts in namespace ${config.hostNamespace}'

  "$LOG_HELPER" 'Host(s) for lifecycle after CommunicationChannel recovery'
  "$HCC_K8S_CLIENT" 'Reconciling ${hosts.length} Host(s) for lifecycle after ${reason}'

  "$LOG_HELPER" 'Host(s) after Host watch recovery convergence'
  "$HCC_K8S_CLIENT" 'Reconciling ${hosts.length} Host(s) after ${reason}'

  "$LOG_HELPER" 'Completed Host reconciliation after CommunicationChannel recovery$'
  "$HCC_K8S_CLIENT" "requestHostFleetReconcile('CommunicationChannel recovery'"

  "$LOG_HELPER" 'Completed Host reconciliation after Host watch recovery convergence$'
  "$HCC_K8S_CLIENT" "convergenceReason = 'Host watch recovery convergence'"

  "$LOG_HELPER" 'Periodic resync'
  "$HCC_K8S_CLIENT" "requestHostFleetReconcile('Periodic resync'"

  "$READINESS_GATE" "START_MARKER='Starting initial Host background convergence'"
  "$HCC_K8S_CLIENT" 'Starting initial Host background convergence...'

  "$READINESS_GATE" "COMPLETE_MARKER='Completed Host reconciliation after initial Host reconciliation'"
  "$HCC_K8S_CLIENT" 'Completed Host reconciliation after ${reason}'

  "$READINESS_GATE" "FAIL_MARKER='Host reconciliation after initial Host reconciliation failed'"
  "$HCC_K8S_CLIENT" 'Host reconciliation after ${reason} failed:'

  "$READINESS_GATE" 'after initial Host reconciliation'
  "$HCC_K8S_CLIENT" "'initial Host reconciliation',"

  "$HOST_BUNDLE_MEASURE" "HCC_PASS_STARTED_MARKER='Starting initial Host background convergence'"
  "$HCC_K8S_CLIENT" 'Starting initial Host background convergence...'

  "$HOST_BUNDLE_MEASURE" "HCC_PASS_COMPLETED_MARKER='Completed Host reconciliation after initial Host reconciliation'"
  "$HCC_K8S_CLIENT" 'Completed Host reconciliation after ${reason}'

  "$HOST_BUNDLE_MEASURE" "HCC_PASS_FAILED_MARKER='Host reconciliation after initial Host reconciliation failed'"
  "$HCC_K8S_CLIENT" 'Host reconciliation after ${reason} failed:'

  "$HOST_STORM_GATE" "HCC_PASS_COMPLETED_MARKER='Completed Host reconciliation after initial Host reconciliation'"
  "$HCC_K8S_CLIENT" 'Completed Host reconciliation after ${reason}'

  "$HOST_STORM_GATE" "HCC_PASS_FAILED_MARKER='Host reconciliation after initial Host reconciliation failed'"
  "$HCC_K8S_CLIENT" 'Host reconciliation after ${reason} failed:'

  "$MCP_READINESS_GATE" 'Initial external egress reconciliation failed for ${MCP_NS}/${MCP_NAME};'
  "$HCC_EGRESS_COORDINATOR" 'Initial external egress reconciliation failed for ${key};'

  "$MCP_READINESS_GATE" 'Scheduling external egress retry '
  "$HCC_EGRESS_COORDINATOR" 'Scheduling external egress retry ${attempt}/${EXTERNAL_EGRESS_RETRY_DELAYS_MS.length}'

  "$MCP_READINESS_GATE" 'for McpServer \"${MCP_NAME}\"'
  "$HCC_EGRESS_COORDINATOR" 'for McpServer "${this.retryIntents.get(key)!.server.name}"'

  "$MCP_READINESS_GATE" 'Context watch event: MODIFIED for ${CONTEXT_NAME}'
  "$HCC_K8S_CLIENT" 'Context watch event: ${type} for ${context.name}'

  "$MCP_READINESS_GATE" '.msg == "reconciling context network policies"'
  "$HCC_NETWORK_POLICY_RECONCILER" "hccLogger.info('reconciling context network policies', { contextId, allowedServers })"

  "$MCP_READINESS_GATE" "NETPOL_INITIAL_FAILED_MARKER='Initial NetworkPolicy background reconciliation failed:'"
  "$HCC_K8S_CLIENT" 'Initial NetworkPolicy background reconciliation failed:'

  "$MCP_READINESS_GATE" "NETPOL_ADDITIVE_FAILED_MARKER='Initial NetworkPolicy post-certification additive reconciliation failed:'"
  "$HCC_K8S_CLIENT" 'Initial NetworkPolicy post-certification additive reconciliation failed:'

  "$MCP_READINESS_GATE" "NETPOL_RETRY_SCHEDULED_MARKER='Scheduling initial NetworkPolicy background convergence retry'"
  "$HCC_K8S_CLIENT" 'Scheduling initial ${lane} background convergence retry'

  "$MCP_READINESS_GATE" "NETPOL_CONTEXT_FAILED_MARKER='NetworkPolicy reconciliation failed for context '"
  "$HCC_K8S_CLIENT" 'NetworkPolicy reconciliation failed for context ${context.name}:'
)
marker_drift=""
marker_binding_count=0
for ((marker_index = 0; marker_index < ${#marker_bindings[@]}; marker_index += 4)); do
  consumer_file="${marker_bindings[marker_index]}"
  consumer_marker="${marker_bindings[marker_index + 1]}"
  producer_file="${marker_bindings[marker_index + 2]}"
  producer_marker="${marker_bindings[marker_index + 3]}"
  marker_binding_count=$((marker_binding_count + 1))
  # `grep -Fq -- ""` matches every file, so an empty marker would disarm this
  # pair while still reporting a pass. Refuse it instead of searching for it.
  if [ -z "$consumer_marker" ] || [ -z "$producer_marker" ]; then
    marker_drift+="  marker pair at index ${marker_index} has an empty marker"$'\n'
    continue
  fi
  if ! grep -Fq -- "$consumer_marker" "$consumer_file"; then
    marker_drift+="  consumer $(basename "$consumer_file") no longer reads: ${consumer_marker}"$'\n'
  fi
  if ! grep -Fq -- "$producer_marker" "$producer_file"; then
    marker_drift+="  producer $(basename "$producer_file") no longer emits: ${producer_marker}"$'\n'
  fi
done
# The stride loop consumes 4 elements per pair, so an array whose length is not
# a multiple of 4 silently shifts every entry after the edit and leaves the tail
# unset. Assert the arity explicitly rather than relying on the pair count to
# happen to notice.
if [ $((${#marker_bindings[@]} % 4)) -eq 0 ] &&
  [ "$marker_binding_count" -eq 35 ] &&
  [ -z "$marker_drift" ]; then
  pass "all ${marker_binding_count} consumed HCC log markers stay bound to their runtime producers"
else
  printf '%s' "$marker_drift" >&2
  fail "a consumed HCC log marker drifted from its runtime producer (${marker_binding_count} pairs checked)"
fi

# Completeness fence: every static single-quoted *_MARKER defined in the e2e
# gates MUST be inventoried above as a consumer_marker, so a NEW marker cannot be
# born outside the drift fence (the pinned count only catches removals). The scan
# covers both the gates themselves and the _lib/ helpers they source — a marker
# born in a sourced helper is the same escape class. Scoped to single-quoted
# literals — a dynamic id like C_MARKER="refusal-c-${RUN_ID}" (double-quoted, a
# per-run test id, not a cross-file HCC log marker) is not the class this fence
# covers and is excluded by the quote style, not a hard-coded allow-list.
marker_is_inventoried() {
  local needle="$1" i
  for ((i = 1; i < ${#marker_bindings[@]}; i += 4)); do
    [ "${marker_bindings[i]}" = "$needle" ] && return 0
  done
  return 1
}
uninventoried_markers=""
while IFS= read -r marker_def; do
  [ -n "$marker_def" ] || continue
  marker_is_inventoried "$marker_def" ||
    uninventoried_markers+="  ${marker_def}"$'\n'
done < <(
  grep -rhoE "^[[:space:]]*(readonly[[:space:]]+)?[A-Z_]+_MARKER='[^']*'" \
    "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}"/_lib/*.sh |
    sed -E "s/^[[:space:]]*(readonly[[:space:]]+)?//"
)
if [ -z "$uninventoried_markers" ]; then
  pass "every single-quoted *_MARKER defined in the e2e gates is inventoried in the drift fence"
else
  printf '%s' "$uninventoried_markers" >&2
  fail "an e2e gate defines a *_MARKER absent from marker_bindings (drift fence would miss it)"
fi

# The initial Context witness must come from the structured HCC event for the
# exact fixture Context, not a substring in an unrelated event or old text log.
# These are local log fixtures; kctl never contacts a cluster.
initial_empty_context_function="$(
  sed -n '/^hcc_initial_empty_context_observed() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
run_initial_empty_context_case() (
  local mode=$1
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  CONTEXT_ID='fixture-context'
  MOCK_CONTEXT_LOG="$(jq -cn --arg context "$CONTEXT_ID" '{
    svc:"host-context-controller",level:"info",
    msg:"reconciling context network policies",contextId:$context,allowedServers:[]
  }')"
  case "$mode" in
    exact) ;;
    mixed) MOCK_CONTEXT_LOG="unstructured bootstrap line
not-json
null
42
[]
$MOCK_CONTEXT_LOG
trailing diagnostic" ;;
    reordered) MOCK_CONTEXT_LOG="$(jq '{allowedServers,contextId,msg,level,svc}' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    wrong-context) MOCK_CONTEXT_LOG="$(jq '.contextId="another-context"' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    nonempty) MOCK_CONTEXT_LOG="$(jq '.allowedServers=["server-a"]' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    missing-servers) MOCK_CONTEXT_LOG="$(jq 'del(.allowedServers)' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    null-servers) MOCK_CONTEXT_LOG="$(jq '.allowedServers=null' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    wrong-service) MOCK_CONTEXT_LOG="$(jq '.svc="another-service"' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    wrong-event) MOCK_CONTEXT_LOG="$(jq '.msg="context reconciliation failed"' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    nested) MOCK_CONTEXT_LOG="$(jq '{detail:.}' <<<"$MOCK_CONTEXT_LOG" | jq -c .)" ;;
    legacy) MOCK_CONTEXT_LOG="[NetPol] Reconciling context \"${CONTEXT_ID}\" — allowed servers: []" ;;
    empty) MOCK_CONTEXT_LOG='' ;;
    api-error) ;;
    no-pod) NEW_HCC_POD='' ;;
    *) return 1 ;;
  esac
  kctl() {
    [[ "$*" == 'logs pod/hcc-pod -n control-plane -c host-context-controller' ]] || return 1
    printf '%s\n' "$MOCK_CONTEXT_LOG"
    [ "$mode" != api-error ]
  }
  [ -n "$initial_empty_context_function" ] || return 1
  eval "$initial_empty_context_function"
  hcc_initial_empty_context_observed
)
for context_log_case in exact mixed reordered; do
  if run_initial_empty_context_case "$context_log_case"; then
    pass "initial Context witness accepts $context_log_case structured HCC evidence"
  else
    fail "initial Context witness rejects $context_log_case structured HCC evidence"
  fi
done
for context_log_case in wrong-context nonempty missing-servers null-servers wrong-service wrong-event nested legacy empty api-error no-pod; do
  if run_initial_empty_context_case "$context_log_case"; then
    fail "initial Context witness accepts $context_log_case evidence"
  else
    pass "initial Context witness rejects $context_log_case evidence"
  fi
done
initial_context_wait="$(sed -n '/initial NetworkPolicy pass to reconcile the fixture/,/initial NetworkPolicy pass never reconciled/p' "$MCP_READINESS_GATE")"
if [[ "$initial_context_wait" == *'hcc_initial_empty_context_observed'* ]] &&
   [[ "$initial_context_wait" != *'hcc_log_contains'* ]]; then
  pass "initial Context readiness wait uses the structured identity-bound witness"
else
  fail "initial Context readiness wait does not use the structured identity-bound witness"
fi

fixture_mcp_runtime_absent_function="$(
  sed -n '/^fixture_mcp_runtime_absent() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
hcc_kubernetes_readiness_function="$(
  sed -n '/^hcc_kubernetes_readiness_is_exact() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
external_policy_protocol_function="$(
  sed -n '/^external_egress_policy_converged_with_protocol() {$/,/^}$/p' \
    "$MCP_READINESS_GATE"
)"
hcc_ready_after_revoke_function="$(
  sed -n '/^hcc_ready_after_stale_policy_revoked() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
ready_probe_function="$(
  sed -n '/^probe_new_hcc_ready_endpoint() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"

run_ready_probe_failure_case() (
  local expected=$1
  MOCK_READY_PROBE_OUTPUT=$2
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  HCC_PORT=8080
  HCC_READY_PROBE_DIAGNOSTIC=""
  kctl() {
    printf '%s\n' "$MOCK_READY_PROBE_OUTPUT"
    return 1
  }
  eval "$ready_probe_function"
  ! probe_new_hcc_ready_endpoint &&
    [ "$HCC_READY_PROBE_DIAGNOSTIC" = "HCC_READY_PROBE category=${expected}" ]
)

if run_ready_probe_failure_case timeout 'HCC_READY_PROBE category=timeout' &&
   run_ready_probe_failure_case transport 'HCC_READY_PROBE category=transport' &&
   run_ready_probe_failure_case 'http-status status=503' \
     'HCC_READY_PROBE category=http-status status=503' &&
   run_ready_probe_failure_case json-ready-false \
     'HCC_READY_PROBE category=json-ready-false'; then
  pass "ready probe preserves distinct timeout, transport, HTTP, and ready=false diagnostics"
else
  fail "ready probe collapses a failure boundary into an indiagnostic boolean"
fi
if (
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  HCC_PORT=8080
  HCC_READY_PROBE_DIAGNOSTIC="stale"
  kctl() { return 0; }
  eval "$ready_probe_function"
  probe_new_hcc_ready_endpoint && [ -z "$HCC_READY_PROBE_DIAGNOSTIC" ]
); then
  pass "successful ready probe clears stale failure diagnostics"
else
  fail "successful ready probe retains a misleading prior diagnostic"
fi

# H6 gate-fix mutation (E4): the clean-window NetworkPolicy negative must FAIL
# against an injection-window log (moving it inside the injected window would
# false-fail — the scoping is load-bearing), PASS against a clean log, and fail
# closed when kubectl errors. The gate itself can't run (minikube churn), so
# this statically pins the predicate.
clean_window_netpol_negatives_function="$(
  sed -n '/^clean_window_netpol_log_negatives_hold() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
clean_window_marker_defs="$(grep -E "^NETPOL_[A-Z_]+_MARKER='" "$MCP_READINESS_GATE")"
run_clean_window_negative_case() (
  local mode=$1
  CONTEXT_NAME=alpha
  HCC_NS=control-plane
  eval "$clean_window_marker_defs"
  case $mode in
    injected)
      kctl() {
        printf '%s\n' \
          '[K8s] Initial NetworkPolicy post-certification additive reconciliation failed: dns timeout' \
          '[K8s] Scheduling initial NetworkPolicy background convergence retry 1 in 5000ms'
      } ;;
    clean) kctl() { printf '%s\n' '[K8s] NetworkPolicy convergence certified'; } ;;
    api-error) kctl() { return 1; } ;;
  esac
  eval "$clean_window_netpol_negatives_function"
  clean_window_netpol_log_negatives_hold hcc-pod
)
if ! run_clean_window_negative_case injected &&
  run_clean_window_negative_case clean &&
  ! run_clean_window_negative_case api-error; then
  pass "clean-window NetworkPolicy negative fails inside the injected window, passes clean, and fails closed"
else
  fail "clean-window NetworkPolicy negative does not distinguish injected-window failures or fails open"
fi

# Static ordering fence: a clean-window negative invocation must exist in the
# MAIN BODY (after `trap cleanup EXIT`) and before the DNS mutation. cleanup()
# is defined earlier in the file than the mutation but runs on EXIT, so a plain
# "first line < mutation line" test would be satisfied by the cleanup-window
# invocation alone; excluding everything at or before the trap line pins the
# pre-injection (window A) invocation specifically.
trap_line="$(grep -n '^trap cleanup EXIT' "$MCP_READINESS_GATE" | head -1 | cut -d: -f1)"
dns_mutation_line="$(grep -n '^HCC_MUTATED=1' "$MCP_READINESS_GATE" | head -1 | cut -d: -f1)"
body_clean_window_negative_line="$(
  grep -n 'clean_window_netpol_log_negatives_hold "' "$MCP_READINESS_GATE" |
    awk -F: -v t="${trap_line:-0}" -v m="${dns_mutation_line:-0}" \
      '$1 > t && $1 < m { print $1; exit }'
)"
if [ -n "$body_clean_window_negative_line" ]; then
  pass "clean-window NetworkPolicy negative runs in the body before the DNS fault injection"
else
  fail "clean-window NetworkPolicy negative is missing from the pre-injection body window"
fi
if (
  NEW_HCC_POD=hcc-pod
  HCC_NS=control-plane
  HCC_PORT=8080
  HCC_READY_PROBE_DIAGNOSTIC=""
  kctl() {
    printf '%s\n' 'untrusted kubectl output containing super-secret material'
    return 1
  }
  eval "$ready_probe_function"
  ! probe_new_hcc_ready_endpoint &&
    [ "$HCC_READY_PROBE_DIAGNOSTIC" = 'HCC_READY_PROBE category=kubectl-exec' ]
); then
  pass "ready probe replaces untrusted exec output with a bounded sanitized category"
else
  fail "ready probe can leak untrusted exec output into diagnostics"
fi
# Literal source-code assertions guarantee one request and bounded categories,
# without logging the response body, headers, URL, or transport error text.
if [ "$(grep -Fc 'kctl exec' <<<"$ready_probe_function")" = 1 ] &&
   [[ "$ready_probe_function" == *'finish(4, "timeout")'* ]] &&
   [[ "$ready_probe_function" == *'finish(5, "transport")'* ]] &&
   [[ "$ready_probe_function" == *'finish(3, "http-status"'* ]] &&
   [[ "$ready_probe_function" == *'finish(3, "json-ready-false")'* ]] &&
   [[ "$ready_probe_function" == *"printf -v HCC_READY_PROBE_DIAGNOSTIC '%.240s'"* ]] &&
   [[ "$ready_probe_function" != *'console.error(body'* ]] &&
   [[ "$ready_probe_function" != *'error.message'* ]]; then
  pass "ready probe uses one request and emits only bounded non-secret failure categories"
else
  fail "ready probe duplicates requests or exposes an unbounded diagnostic surface"
fi

if (
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  MCP_SERVER_LABEL=clerum.io/mcp-server
  POLICY_TYPE_LABEL=clerum.io/policy-type
  fixture_runtime_absent() { return 0; }
  kctl() { return 0; }
  eval "$fixture_mcp_runtime_absent_function"
  fixture_mcp_runtime_absent
); then
  pass "fixture absence predicate accepts an absent runtime and external-egress policy"
else
  fail "fixture absence predicate rejects an actually absent runtime"
fi
if (
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  MCP_SERVER_LABEL=clerum.io/mcp-server
  POLICY_TYPE_LABEL=clerum.io/policy-type
  fixture_runtime_absent() { return 0; }
  kctl() { printf '%s\n' 'networkpolicy.networking.k8s.io/stale-policy'; }
  eval "$fixture_mcp_runtime_absent_function"
  ! fixture_mcp_runtime_absent
); then
  pass "fixture absence predicate rejects a surviving external-egress policy"
else
  fail "fixture absence predicate can hide a surviving external-egress policy"
fi
if (
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  MCP_SERVER_LABEL=clerum.io/mcp-server
  POLICY_TYPE_LABEL=clerum.io/policy-type
  fixture_runtime_absent() { return 1; }
  kctl() { return 0; }
  eval "$fixture_mcp_runtime_absent_function"
  ! fixture_mcp_runtime_absent
); then
  pass "fixture absence predicate rejects a surviving MCP runtime"
else
  fail "fixture absence predicate can hide a surviving MCP runtime"
fi

if (
  NEW_HCC_POD=hcc-pod
  HCC_UID=pod-uid
  HCC_NS=control-plane
  HCC_DEPLOY='host-context-controller'
  kctl() {
    case "$2" in
      pod)
        printf '%s\n' '{"metadata":{"uid":"pod-uid"},"status":{"conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"name":"host-context-controller","ready":true}]}}'
        ;;
      deployment)
        printf '%s\n' '{"metadata":{"generation":4},"spec":{"replicas":1},"status":{"observedGeneration":4,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}'
        ;;
      *) return 1 ;;
    esac
  }
  eval "$hcc_kubernetes_readiness_function"
  hcc_kubernetes_readiness_is_exact
); then
  pass "exact Kubernetes readiness accepts one current Ready HCC identity"
else
  fail "exact Kubernetes readiness rejects current Ready HCC evidence"
fi
# Kubelet reports an indeterminate pod as Ready=Unknown, not Ready=False. Only
# an Unknown fixture separates the exact `== "True"` readiness contract from a
# weakened `!= "False"` one, so this red case pins the exact comparison instead
# of the single status value both spellings already reject. Every other field is
# healthy, which leaves the Ready condition as the only reason to refuse.
if (
  NEW_HCC_POD=hcc-pod
  HCC_UID=pod-uid
  HCC_NS=control-plane
  HCC_DEPLOY='host-context-controller'
  kctl() {
    case "$2" in
      pod)
        printf '%s\n' '{"metadata":{"uid":"pod-uid"},"status":{"conditions":[{"type":"Ready","status":"Unknown"}],"containerStatuses":[{"name":"host-context-controller","ready":true}]}}'
        ;;
      deployment)
        printf '%s\n' '{"metadata":{"generation":4},"spec":{"replicas":1},"status":{"observedGeneration":4,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}'
        ;;
      *) return 1 ;;
    esac
  }
  eval "$hcc_kubernetes_readiness_function"
  ! hcc_kubernetes_readiness_is_exact
); then
  pass "exact Kubernetes readiness rejects a current pod whose Ready condition is Unknown"
else
  fail "exact Kubernetes readiness can accept an indeterminate HCC pod"
fi
if (
  NEW_HCC_POD=hcc-pod
  HCC_UID=pod-uid
  HCC_NS=control-plane
  HCC_DEPLOY='host-context-controller'
  kctl() {
    case "$2" in
      pod)
        printf '%s\n' '{"metadata":{"uid":"pod-uid"},"status":{"conditions":[{"type":"Ready","status":"False"}],"containerStatuses":[{"name":"host-context-controller","ready":true}]}}'
        ;;
      deployment)
        printf '%s\n' '{"metadata":{"generation":4},"spec":{"replicas":1},"status":{"observedGeneration":4,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}'
        ;;
      *) return 1 ;;
    esac
  }
  eval "$hcc_kubernetes_readiness_function"
  ! hcc_kubernetes_readiness_is_exact
); then
  pass "exact Kubernetes readiness rejects a current pod whose Ready condition is False"
else
  fail "exact Kubernetes readiness can accept a non-Ready HCC pod"
fi
# The container-level readiness clause has its own red case: a pod whose Ready
# condition is True while the host-context-controller container is not ready
# must still be refused, so deleting or weakening that clause cannot pass.
if (
  NEW_HCC_POD=hcc-pod
  HCC_UID=pod-uid
  HCC_NS=control-plane
  HCC_DEPLOY='host-context-controller'
  kctl() {
    case "$2" in
      pod)
        printf '%s\n' '{"metadata":{"uid":"pod-uid"},"status":{"conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"name":"host-context-controller","ready":false}]}}'
        ;;
      deployment)
        printf '%s\n' '{"metadata":{"generation":4},"spec":{"replicas":1},"status":{"observedGeneration":4,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}'
        ;;
      *) return 1 ;;
    esac
  }
  eval "$hcc_kubernetes_readiness_function"
  ! hcc_kubernetes_readiness_is_exact
); then
  pass "exact Kubernetes readiness rejects a Ready pod whose HCC container is not ready"
else
  fail "exact Kubernetes readiness can accept an unready host-context-controller container"
fi
if (
  NEW_HCC_POD=hcc-pod
  HCC_UID=pod-uid
  HCC_NS=control-plane
  HCC_DEPLOY='host-context-controller'
  kctl() {
    case "$2" in
      pod)
        printf '%s\n' '{"metadata":{"uid":"pod-uid"},"status":{"conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"name":"host-context-controller","ready":true}]}}'
        ;;
      deployment)
        printf '%s\n' '{"metadata":{"generation":5},"spec":{"replicas":1},"status":{"observedGeneration":4,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}'
        ;;
      *) return 1 ;;
    esac
  }
  eval "$hcc_kubernetes_readiness_function"
  ! hcc_kubernetes_readiness_is_exact
); then
  pass "exact Kubernetes readiness rejects a stale Deployment generation"
else
  fail "exact Kubernetes readiness can accept stale Deployment status"
fi

if (
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  MCP_SERVER_LABEL=clerum.io/mcp-server
  POLICY_TYPE_LABEL=clerum.io/policy-type
  MANAGED_BY_LABEL=app.kubernetes.io/managed-by
  MANAGED_BY_VALUE='host-context-controller'
  EXTERNAL_EGRESS_CIDR=203.0.113.10/32
  EXTERNAL_EGRESS_PORT=443
  kctl() {
    printf '%s\n' '{"items":[{"metadata":{"labels":{"app.kubernetes.io/managed-by":"host-context-controller","clerum.io/policy-type":"external-egress","clerum.io/mcp-server":"e2e-held-server"}},"spec":{"podSelector":{"matchLabels":{"clerum.io/mcp-server":"e2e-held-server"}},"policyTypes":["Egress"],"egress":[{"ports":[{"port":443,"protocol":"UDP"}],"to":[{"ipBlock":{"cidr":"203.0.113.10/32"}}]}]}}]}'
  }
  eval "$external_policy_protocol_function"
  external_egress_policy_converged_with_protocol UDP &&
    ! external_egress_policy_converged_with_protocol TCP
); then
  pass "external-egress convergence binds the exact current protocol"
else
  fail "external-egress convergence can accept a stale protocol"
fi

mcpserver_current_ready_function="$(
  sed -n '/^mcpserver_current_ready() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
mcpserver_current_ready_absent_function="$(
  sed -n '/^mcpserver_current_ready_absent() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
fixture_runtime_and_ready_absent_function="$(
  sed -n '/^fixture_runtime_and_ready_absent() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
fixture_runtime_converged_function="$(
  sed -n '/^fixture_runtime_converged_with_protocol() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
peer_fleet_converged_function="$(
  sed -n '/^peer_fleet_converged() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
fixture_converged_function="$(
  sed -n '/^fixture_converged() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
if (
  MCP_NS=mcp-server
  GENERATION=7
  OBSERVED_GENERATION=7
  kctl() {
    printf '{"metadata":{"generation":%s},"status":{"conditions":[{"type":"Ready","status":"True","observedGeneration":%s}]}}\n' \
      "$GENERATION" "$OBSERVED_GENERATION"
  }
  eval "$mcpserver_current_ready_function"
  eval "$mcpserver_current_ready_absent_function"
  mcpserver_current_ready current &&
    ! mcpserver_current_ready_absent current &&
    OBSERVED_GENERATION=6 &&
    ! mcpserver_current_ready stale &&
    mcpserver_current_ready_absent stale
) &&
   [[ "$fixture_runtime_and_ready_absent_function" == *'mcpserver_current_ready_absent "$MCP_NAME"'* ]] &&
   [[ "$fixture_runtime_converged_function" == *'mcpserver_current_ready "$MCP_NAME"'* ]] &&
   [[ "$peer_fleet_converged_function" == *'mcpserver_current_ready "$server"'* ]] &&
   [[ "$fixture_converged_function" == *'mcpserver_current_ready "$MCP_NAME"'* ]]; then
  pass "McpServer runtime predicates accept only Ready status observed for the current generation"
else
  fail "McpServer runtime predicates can accept stale Ready status or bypass the canonical check"
fi

if (
  MCP_NS=mcp-server
  MCP_NAME=e2e-held-server
  fixture_runtime_absent() { return 0; }
  kctl() { return 1; }
  eval "$mcpserver_current_ready_absent_function"
  eval "$fixture_runtime_and_ready_absent_function"
  ! fixture_runtime_and_ready_absent
); then
  pass "McpServer Ready absence fails closed when the API read is unavailable"
else
  fail "an unavailable McpServer API read can masquerade as Ready absence"
fi

if (
  probe_new_hcc_ready_endpoint() { return 0; }
  external_egress_policy_absent() { return 0; }
  eval "$hcc_ready_after_revoke_function"
  hcc_ready_after_stale_policy_revoked
); then
  pass "divergent DNS hold permits global readiness only after stale-policy revocation"
else
  fail "divergent DNS hold rejects globally safe readiness evidence"
fi
if (
  HCC_READY_PROBE_DIAGNOSTIC=""
  probe_new_hcc_ready_endpoint() { return 0; }
  external_egress_policy_absent() { return 1; }
  eval "$hcc_ready_after_revoke_function"
  rc=0
  hcc_ready_after_stale_policy_revoked || rc=$?
  # A1: /ready 200 WITH the stale policy present is the kubelet window.
  # Retry (rc=1). rc=2 here would abort the first poll after watches sync.
  [ "$rc" -eq 1 ]
); then
  pass "global readiness retries while a divergent policy still survives after /ready 200"
else
  fail "global readiness treats /ready 200 with a surviving divergent policy as terminal"
fi
# The loop must KEEP polling through that window and PASS only once the
# stale policy is gone. wait_until_fast still treats rc=2 as fatal for the
# identity-stable retain path; this predicate must not emit rc=2.
wait_until_fast_function="$(
  sed -n '/^wait_until_fast() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
if (
  HCC_READY_PROBE_DIAGNOSTIC=""
  POLL=0
  probe_new_hcc_ready_endpoint() { return 0; }
  # Stale for the first polls, revoked later. A1 must retry, not die on poll 1.
  external_egress_policy_absent() { POLL=$((POLL + 1)); [ "$POLL" -gt 4 ]; }
  eval "$hcc_ready_after_revoke_function"
  eval "$wait_until_fast_function"
  rc=0
  wait_until_fast 10 "A1 probe window retry" hcc_ready_after_stale_policy_revoked || rc=$?
  # Each predicate call samples absence twice. Success needs POLL>4 so the
  # before/after pair is both absent.
  [ "$rc" -eq 0 ] && [ "$POLL" -gt 4 ]
); then
  pass "wait_until_fast retries /ready 200 with a surviving policy until revocation"
else
  fail "wait_until_fast no longer waits through the A1 probe window"
fi

# M6: the third contract signal adjudicates a real /metrics scrape. Extract the
# PURE predicate (the wrapper does kctl exec, untestable here) and feed it
# synthetic scrapes. The family-name literals are exactly what a metric rename
# would break — a rename leaves the vi.fn() unit tests green but must turn this
# and the real gate red.
safety_pass_metrics_predicate="$(
  sed -n '/^safety_pass_metrics_are_certified() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
[ -n "$safety_pass_metrics_predicate" ] ||
  fail "could not extract safety_pass_metrics_are_certified from the readiness gate"
metrics_with_revocation='clerum_hcc_networkpolicy_safety_pass_duration_seconds_count 1
clerum_hcc_networkpolicy_safety_pass_policies_total{operation="listed"} 5
clerum_hcc_networkpolicy_safety_pass_policies_total{operation="revoked"} 1'
metrics_without_family='clerum_hcc_some_other_family_total 3'
metrics_zero_revoked='clerum_hcc_networkpolicy_safety_pass_duration_seconds_count 1
clerum_hcc_networkpolicy_safety_pass_policies_total{operation="revoked"} 0'
if (
  eval "$safety_pass_metrics_predicate"
  safety_pass_metrics_are_certified "$metrics_with_revocation"
); then
  pass "safety_pass metrics predicate certifies a scrape with >=1 revoked policy"
else
  fail "safety_pass metrics predicate rejected a valid certifying scrape"
fi
if (
  eval "$safety_pass_metrics_predicate"
  ! safety_pass_metrics_are_certified "$metrics_without_family"
); then
  pass "safety_pass metrics predicate rejects a scrape missing the duration family (rename guard)"
else
  fail "safety_pass metrics predicate passed with the safety_pass family absent"
fi
if (
  eval "$safety_pass_metrics_predicate"
  ! safety_pass_metrics_are_certified "$metrics_zero_revoked"
); then
  pass "safety_pass metrics predicate rejects a scrape with zero revoked policies"
else
  fail "safety_pass metrics predicate passed with zero policies revoked"
fi
if (
  probe_new_hcc_ready_endpoint() { return 1; }
  external_egress_policy_absent() { return 0; }
  eval "$hcc_ready_after_revoke_function"
  ! hcc_ready_after_stale_policy_revoked
); then
  pass "stale-policy revocation alone cannot substitute for global readiness"
else
  fail "divergent hold evidence can pass without HCC readiness"
fi

baseline_policy_snapshot_function="$(
  sed -n '/^baseline_policy_snapshot() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
baseline_policies_unchanged_function="$(
  sed -n '/^baseline_policies_unchanged() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
valid_baseline_policies='{"items":[
  {"metadata":{"name":"deny-all-mcp-server","labels":{"clerum.io/managed-by":"host-context-controller","clerum.io/policy-type":"default-deny"}},"spec":{"podSelector":{},"policyTypes":["Ingress","Egress"]}},
  {"metadata":{"name":"allow-dns-egress-mcp-server","labels":{"clerum.io/managed-by":"host-context-controller","clerum.io/policy-type":"infrastructure"}},"spec":{"podSelector":{},"policyTypes":["Egress"],"egress":[{"ports":[{"port":53,"protocol":"UDP"},{"port":53,"protocol":"TCP"}]}]}},
  {"metadata":{"name":"allow-host-context-controller-api","labels":{"clerum.io/managed-by":"host-context-controller","clerum.io/policy-type":"allow-api"}},"spec":{"podSelector":{"matchLabels":{"app":"host-context-controller"}},"policyTypes":["Ingress"]}}
]}'
if (
  MCP_NS=mcp-server
  MANAGED_BY_VALUE='host-context-controller'
  MOCK_POLICY_JSON="$valid_baseline_policies"
  kctl() { printf '%s\n' "$MOCK_POLICY_JSON"; }
  eval "$baseline_policy_snapshot_function"
  eval "$baseline_policies_unchanged_function"
  BASELINE_POLICY_SNAPSHOT="$(baseline_policy_snapshot)"
  baseline_policies_unchanged &&
    MOCK_POLICY_JSON="$(jq -c '
      .items[0].metadata.labels["clerum.io/managed-by"] = "foreign-controller"
    ' <<<"$valid_baseline_policies")" &&
    ! baseline_policies_unchanged &&
    MOCK_POLICY_JSON="$(jq -c '.items[1].spec.egress[0].ports[0].port = 5353' \
      <<<"$valid_baseline_policies")" &&
    ! baseline_policies_unchanged
); then
  pass "baseline safety proof rejects ownership and spec drift under stable policy names"
else
  fail "baseline safety proof can pass after ownership or spec drift"
fi

peer_fleet_policies_absent_function="$(
  sed -n '/^peer_fleet_policies_absent() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
fixture_resources_absent_function="$(
  sed -n '/^fixture_resources_absent() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
delete_peer_fleet_runtime_function="$(
  sed -n '/^delete_peer_fleet_runtime() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
if (
  MCP_NS=mcp-server
  HOST_NS=mcp-host
  RPC_PROXY_NS=rpc-proxy
  MCP_SERVER_LABEL=clerum.io/mcpserver
  POLICY_TYPE_LABEL=clerum.io/policy-type
  MCP_FLEET_NAMES=(primary peer)
  CONTEXT_FLEET_NAMES=(primary-context peer-context)
  SURVIVOR_NS=""
  resource_absent() { [ "$3" != "$SURVIVOR_NS" ]; }
  kctl() { return 0; }
  eval "$peer_fleet_policies_absent_function"
  peer_fleet_policies_absent &&
    SURVIVOR_NS=mcp-host &&
    ! peer_fleet_policies_absent &&
    SURVIVOR_NS=rpc-proxy &&
    ! peer_fleet_policies_absent
) &&
   [[ "$fixture_resources_absent_function" == *'peer_fleet_policies_absent'* ]] &&
   [[ "$delete_peer_fleet_runtime_function" == *'"${context_policy}-egress"'* ]] &&
   [[ "$delete_peer_fleet_runtime_function" == *'"rpc-egress-${context}-${server}"'* ]]; then
  pass "peer fleet cleanup rejects surviving mcp-host or rpc-proxy policies"
else
  fail "peer fleet cleanup can release ownership with residual derived policies"
fi

# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-logs.sh
source "$LOG_HELPER"
HCC_LOG_BUFFER="$MOCK_LOG_FILE"
START_TIME=2026-07-14T00:00:00Z
HOST_NS=mcp-host

blocker_holds_function="$(sed -n '/^blocker_holds_token_request() {$/,/^}$/p' "$READINESS_GATE")"
blocker_count_function="$(sed -n '/^blocker_fixture_request_count() {$/,/^}$/p' "$READINESS_GATE")"
if (
  BLOCKER_NAME=readiness-blocker
  HCC_NS=control-plane
  FIXTURE_HOST_PREFIX=e2e-hcc-ready-test
  TOKEN_REQUEST_LOG_PREFIX='holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host='
  kctl() { cat "$MOCK_LOG_FILE"; }
  eval "$blocker_holds_function"
  eval "$blocker_count_function"
  printf '%s\n' \
    'holding-token GET /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-01' \
    'holding-token POST /wrong/path host=e2e-hcc-ready-test-02' \
    'holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-03' \
    'holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-03' \
    'holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-04' \
    >"$MOCK_LOG_FILE"
  [ "$(blocker_fixture_request_count)" = 2 ] &&
    blocker_holds_token_request
); then
  pass "blocker evidence counts unique fixtures only on the canonical token issuance method and path"
else
  fail "wrong-method, wrong-path, or duplicate blocker traffic can satisfy the fleet evidence"
fi

create_fixtures_function="$(sed -n '/^create_host_fixtures() {$/,/^}$/p' "$READINESS_GATE")"
if (
  RUN_ID=fixture-failure
  SUITE_NAME=hcc-readiness-bootstrap
  HOST_NS=mcp-host
  MCP_NS=mcp-server
  FIXTURE_SECRET=e2e-secret
  FIXTURE_CONTEXT=e2e-context
  FIXTURE_HOST_PREFIX=e2e-host
  FIXTURE_HOST_COUNT=4
  FIXTURE_HOST_NAMES=()
  FIXTURES_CREATED=0
  KCTL_APPLY_COUNT=0
  kctl() {
    KCTL_APPLY_COUNT=$((KCTL_APPLY_COUNT + 1))
    cat >/dev/null
    [ "$KCTL_APPLY_COUNT" -ne 3 ]
  }
  eval "$create_fixtures_function"
  if create_host_fixtures; then
    exit 1
  fi
  [ "$KCTL_APPLY_COUNT" = 3 ]
); then
  pass "an intermediate Host apply failure aborts fixture creation even from an OR-list"
else
  fail "fixture creation can continue or report success after an intermediate apply failure"
fi

bootstrap_runtime_absent_function="$(
  sed -n '/^fixture_runtime_absent() {$/,/^}$/p' "$READINESS_GATE"
)"
bootstrap_delete_fixtures_function="$(
  sed -n '/^delete_host_fixtures() {$/,/^}$/p' "$READINESS_GATE"
)"
# Literal source-code assertions for macOS bash 3.2, where expanding an empty
# array under set -u terminates the shell before cleanup can release its lock.
# shellcheck disable=SC2016
if [[ "$bootstrap_runtime_absent_function" == *'[ "${#FIXTURE_HOST_NAMES[@]}" -eq 0 ] && return 0'* ]] &&
   [[ "$bootstrap_delete_fixtures_function" == *'[ "${#FIXTURE_HOST_NAMES[@]}" -eq 0 ] && return "$failed"'* ]]; then
  pass "bootstrap cleanup guards empty fixture arrays before bash 3.2 expansion"
else
  fail "bootstrap cleanup can abort on an empty fixture array before lock finalization"
fi

create_peer_fleet_function="$(
  sed -n '/^create_peer_fleet() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
peer_flag_line="$(grep -nF '  PEER_FLEET_CREATED=1' <<<"$create_peer_fleet_function" | head -1 | cut -d: -f1)"
peer_loop_line="$(grep -nF '  for ((index = 1;' <<<"$create_peer_fleet_function" | head -1 | cut -d: -f1)"
if [ -n "$peer_flag_line" ] && [ -n "$peer_loop_line" ] &&
   [ "$peer_flag_line" -lt "$peer_loop_line" ]; then
  pass "peer fleet cleanup is armed before the first partial apply can fail"
else
  fail "peer fleet cleanup is armed only after all applies complete"
fi

divergent_ready_function="$(
  sed -n '/^hcc_ready_after_stale_policy_revoked() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
divergent_ready_line="$(
  grep -nF 'wait_until_fast 120 "HCC readiness after revoking the divergent stale policy"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
divergent_context_line="$(
  grep -nF 'wait_until 120 "all three latest-Context NetworkPolicies to converge during the MCP hold"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
divergent_release_line="$(
  grep -nF 'release_dns_blocker ||' "$MCP_READINESS_GATE" | tail -1 | cut -d: -f1
)"
udp_policy_line="$(
  grep -nF 'wait_until 120 "current UDP external-egress policy after DNS release"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
# shellcheck disable=SC2016
if [[ "$divergent_ready_function" == *'probe_new_hcc_ready_endpoint || return 1'* ]] &&
   [[ "$divergent_ready_function" == *'external_egress_policy_absent'* ]] &&
   [ -n "$divergent_ready_line" ] && [ -n "$divergent_context_line" ] &&
   [ -n "$divergent_release_line" ] && [ -n "$udp_policy_line" ] &&
   [ "$divergent_ready_line" -lt "$divergent_context_line" ] &&
   [ "$divergent_context_line" -lt "$divergent_release_line" ] &&
   [ "$divergent_release_line" -lt "$udp_policy_line" ] &&
   ! grep -Fq 'probe_new_hcc_unready_endpoint' "$MCP_READINESS_GATE" &&
   ! grep -Fq '/ready is 503' "$MCP_READINESS_GATE"; then
  pass "divergent DNS hold proves global readiness, fail-closed runtime isolation, and post-release UDP convergence"
else
  fail "the MCP gate still couples global readiness to divergent DNS replacement"
fi

initial_tcp_policy_line="$(
  grep -nF 'wait_until 180 "HCC to create the real initial TCP external-egress policy"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
# B3 retain-identity-stable contract: a same-intent restart RETAINS the
# identity-stable DNS-derived allow (no deny window), certifies /ready with it
# still present, keeps the affected runtime blocked, and converges the additive
# TCP lane only AFTER the DNS hold releases — the inverse of the pre-B3
# revoke-before-ready ordering this gate previously asserted.
same_intent_snapshot_line="$(
  grep -nF 'SAME_INTENT_EGRESS_SNAPSHOT="$(external_egress_policy_snapshot)"' \
    "$MCP_READINESS_GATE" | head -1 | cut -d: -f1
)"
same_intent_retained_ready_line="$(
  grep -nF 'wait_until_fast 60 "HCC readiness while the same-intent identity-stable DNS policy is retained"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
same_intent_retain_guard_line="$(
  grep -nF 'the same-intent identity-stable DNS policy was revoked at readiness (retain regression / deny window)' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
same_intent_runtime_blocked_line="$(
  grep -nF 'the affected runtime or Ready status escaped the held same-intent DNS boundary' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
same_intent_release_line="$(
  grep -nF 'release_dns_blocker || die "could not release the same-intent DNS query"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
same_intent_tcp_policy_line="$(
  grep -nF 'wait_until 120 "current TCP external-egress policy after same-intent DNS release"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
divergent_revoke_line="$(
  grep -nF 'wait_until_fast 120 "HCC readiness after revoking the divergent stale policy"' \
    "$MCP_READINESS_GATE" | cut -d: -f1
)"
if [ -n "$initial_tcp_policy_line" ] && [ -n "$same_intent_snapshot_line" ] &&
   [ -n "$same_intent_retained_ready_line" ] && [ -n "$same_intent_retain_guard_line" ] &&
   [ -n "$same_intent_runtime_blocked_line" ] && [ -n "$same_intent_release_line" ] &&
   [ -n "$same_intent_tcp_policy_line" ] && [ -n "$divergent_revoke_line" ] &&
   [ "$initial_tcp_policy_line" -lt "$same_intent_snapshot_line" ] &&
   [ "$same_intent_snapshot_line" -lt "$same_intent_retained_ready_line" ] &&
   [ "$same_intent_retained_ready_line" -lt "$same_intent_retain_guard_line" ] &&
   [ "$same_intent_retain_guard_line" -lt "$same_intent_runtime_blocked_line" ] &&
   [ "$same_intent_runtime_blocked_line" -lt "$same_intent_release_line" ] &&
   [ "$same_intent_release_line" -lt "$same_intent_tcp_policy_line" ] &&
   [ "$same_intent_tcp_policy_line" -lt "$divergent_revoke_line" ] &&
   grep -Fq 'hcc_ready_with_identity_stable_policy_retained' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'HCC readiness after revoking the same-intent DNS policy' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'a real same-intent external-egress retry to be scheduled' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'CERTIFIED_POLICY_IDENTITY' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'external_egress_policy_identity' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'UID/spec' "$MCP_READINESS_GATE"; then
  pass "same-intent safety retains the identity-stable DNS policy at readiness; additive TCP convergence follows DNS release"
else
  fail "the MCP readiness gate no longer proves B3 retain-identity-stable (or regressed to revoke-same-intent before readiness)"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  pass "fresh Host LIST before channel recovery is attributed to the same interruption"
else
  fail "valid LIST-to-recovery ordering was rejected"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) after Host watch recovery convergence' \
  '[K8s] Completed Host reconciliation after Host watch recovery convergence' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  pass "a causally ordered Host-watch pass may cover the recovered CC and fresh Host inventories"
else
  fail "a valid covering Host-watch recovery pass was rejected"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Reconciling 5 Host(s) after Host watch recovery convergence' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Completed Host reconciliation after Host watch recovery convergence' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  fail "a Host-watch pass selected before CC recovery satisfied the covering assertion"
else
  pass "covering Host-watch recovery requires recovered CC state before pass selection"
fi

printf '%s\n' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  fail "a Host LIST from before the interruption satisfied the recovery assertion"
else
  pass "a stale pre-interruption Host LIST cannot satisfy recovery"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 4 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  fail "a stale Host inventory count satisfied recovery"
else
  pass "recovery requires the exact fresh Host inventory count"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 1 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 4 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 2 5; then
  pass "recovery attribution selects the requested interruption cycle"
else
  fail "the second recovery cycle was not isolated from the first"
fi

large_log_tail="$(awk 'BEGIN {
  for (i = 1; i <= 20000; i++) {
    printf "trailing-log-line-%05d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n", i
  }
}')"
large_active_snapshot="${START_MARKER:-Starting initial Host background convergence}
${large_log_tail}"
if hcc_log_snapshot_contains \
     "$large_active_snapshot" 'Starting initial Host background convergence'; then
  pass "buffered marker lookup survives a log tail larger than a pipe buffer"
else
  fail "large trailing logs can hide a marker from buffered lookup"
fi

if hcc_initial_pass_snapshot_is_active \
     "$large_active_snapshot" \
     'Starting initial Host background convergence' \
     'Completed Host reconciliation after initial Host reconciliation' \
     'Host reconciliation after initial Host reconciliation failed'; then
  pass "Host pass snapshot is active only with START and no terminal marker"
else
  fail "valid active Host pass snapshot was rejected"
fi

for terminal_marker in \
  'Completed Host reconciliation after initial Host reconciliation' \
  'Host reconciliation after initial Host reconciliation failed'; do
  if hcc_initial_pass_snapshot_is_active \
       "${large_active_snapshot}
${terminal_marker}" \
       'Starting initial Host background convergence' \
       'Completed Host reconciliation after initial Host reconciliation' \
       'Host reconciliation after initial Host reconciliation failed'; then
    fail "terminal Host marker '${terminal_marker}' can still satisfy the active-pass guard"
  else
    pass "terminal Host marker '${terminal_marker}' invalidates the active-pass guard"
  fi
done

readiness_log_function="$(
  sed -n '/^hcc_log_contains() {$/,/^}$/p' "$READINESS_GATE"
)"
running_pod_function="$(
  sed -n '/^running_hcc_pod() {$/,/^}$/p' "$READINESS_GATE"
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$readiness_log_function" == *'logs="$(hcc_logs "$pod")"'* ]] &&
   [[ "$readiness_log_function" == *'hcc_log_snapshot_contains "$logs" "$marker"'* ]] &&
   [[ "$running_pod_function" == *'rows="$(kctl get pods'* ]] &&
   [[ "$running_pod_function" == *'<<<"$rows"'* ]]; then
  pass "readiness log and Running-pod selection buffer producers before early-exit consumers"
else
  fail "readiness log or Running-pod selection reintroduced a pipefail/SIGPIPE path"
fi

active_guard_function="$(
  sed -n '/^initial_host_pass_is_active() {$/,/^}$/p' "$READINESS_GATE"
)"
initial_host_startup_producer="$(
  sed -n \
    '/Starting initial Host background convergence/,/const resyncSec = config.hostResyncIntervalSec/p' \
    "$HCC_K8S_CLIENT"
)"
# The bootstrap guard's negative COMPLETE/FAIL checks are safe only while all
# three consumed markers remain bound to the runtime templates and the startup
# call supplies the exact reason that renders the terminal pair.
if grep -Fq 'Starting initial Host background convergence...' \
     "$HCC_K8S_CLIENT" &&
   grep -Fq 'Completed Host reconciliation after ${reason}' \
     "$HCC_K8S_CLIENT" &&
   grep -Fq 'Host reconciliation after ${reason} failed:' \
     "$HCC_K8S_CLIENT" &&
   [[ "$initial_host_startup_producer" == *'await this.recoverHostInventoryAndWatch('* ]] &&
   [[ "$initial_host_startup_producer" == *"'initial Host reconciliation',"* ]]; then
  pass "bootstrap START/COMPLETE/FAIL markers remain bound to the initial Host producer reason"
else
  fail "bootstrap Host pass markers drifted from their runtime producer or reason binding"
fi

# The destructive Host-bundle measurement uses the same cold-start transition
# as the bootstrap readiness gate. Keep its active-pass marker tied to the
# emitted producer rather than an obsolete reason-string log line.
if grep -Fq "readonly HCC_PASS_STARTED_MARKER='Starting initial Host background convergence'" \
     "$HOST_BUNDLE_MEASURE" &&
   grep -Fq 'Starting initial Host background convergence...' "$HCC_K8S_CLIENT"; then
  pass "Host-bundle measurement START marker remains bound to the cold-start producer"
else
  fail "Host-bundle measurement can wait for a stale HCC START marker"
fi
# shellcheck disable=SC2016
probe_result_line="$(grep -nF 'probe_result="$(kctl exec' "$READINESS_GATE" | cut -d: -f1)"
# shellcheck disable=SC2016
final_active_guard_line="$(
  grep -nF 'initial_host_pass_is_active "$new_hcc_pod"' "$READINESS_GATE" |
    tail -1 |
    cut -d: -f1
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$active_guard_function" == *'"$COMPLETE_MARKER"'* ]] &&
   [[ "$active_guard_function" == *'"$FAIL_MARKER"'* ]] &&
   [ -n "$probe_result_line" ] &&
   [ -n "$final_active_guard_line" ] &&
   [ "$final_active_guard_line" -gt "$probe_result_line" ]; then
  pass "final readiness assertion rejects both failed and completed Host passes"
else
  fail "final readiness assertion does not enforce both terminal Host markers"
fi

cleanup_body="$(sed -n '/^cleanup() {$/,/^}$/p' "$READINESS_GATE")"
fixture_cleanup_body="$(sed -n '/^delete_host_fixtures() {$/,/^}$/p' "$READINESS_GATE")"
# shellcheck disable=SC2016
cleanup_stop_line="$(grep -nF 'kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0' \
  <<<"$cleanup_body" | head -1 | cut -d: -f1)"
cleanup_fixture_line="$(grep -nF 'delete_host_fixtures' <<<"$cleanup_body" | head -1 | cut -d: -f1)"
# shellcheck disable=SC2016
cleanup_restore_line="$(grep -nF 'kctl set env deployment/"$HCC_DEPLOY"' \
  <<<"$cleanup_body" | head -1 | cut -d: -f1)"
# Literal source-code assertion.
# shellcheck disable=SC2016
if grep -Fq 'FIXTURE_HOST_COUNT=$((HOST_RECONCILE_CONCURRENCY * 2 + 1))' "$READINESS_GATE" &&
   grep -Fq 'kind: Host' "$READINESS_GATE" &&
   grep -Fq "host='+host" "$READINESS_GATE" &&
   grep -Fq 'blocker_fixture_request_count' "$READINESS_GATE" &&
   [[ "$fixture_cleanup_body" == *'clerum.io/managed-by=host-context-controller,clerum.io/host=${host}'* ]] &&
   [[ "$fixture_cleanup_body" == *'fixture_resources_absent'* ]] &&
   ! grep -Fq 'RUNTIME_SECRET' "$READINESS_GATE" &&
   ! grep -Fq 'HOST_REF' "$READINESS_GATE" &&
   [ -n "$cleanup_stop_line" ] &&
   [ -n "$cleanup_fixture_line" ] &&
   [ -n "$cleanup_restore_line" ] &&
   [ "$cleanup_stop_line" -lt "$cleanup_fixture_line" ] &&
   [ "$cleanup_fixture_line" -lt "$cleanup_restore_line" ]; then
  pass "readiness gate uses a multi-wave owned Host fleet and deletes it while HCC is stopped"
else
  fail "readiness gate can mutate a real Host Secret or restore HCC before fixture deletion"
fi

if [[ "$cleanup_body" == *'header "HCC readiness bootstrap gate passed"'* ]] &&
   grep -Fq 'header "HCC readiness assertions passed; restoring branch-owned runtime"' \
     "$READINESS_GATE" &&
   [ "$(grep -Fc 'header "HCC readiness bootstrap gate passed"' "$READINESS_GATE")" = 1 ]; then
  pass "readiness gate emits its final pass banner only after verified restoration and lock finalization"
else
  fail "readiness gate can announce a final pass before cleanup and ownership release finish"
fi

mcp_cleanup_body="$(sed -n '/^cleanup() {$/,/^}$/p' "$MCP_READINESS_GATE")"
# shellcheck disable=SC2016
mcp_input_absence_line="$(
  grep -nF 'fixture_inputs_absent' <<<"$mcp_cleanup_body" | head -1 | cut -d: -f1
)"
# shellcheck disable=SC2016
mcp_restore_line="$(
  grep -nF 'restore_patch="$(jq -cn' <<<"$mcp_cleanup_body" | head -1 | cut -d: -f1
)"
if [[ "$mcp_cleanup_body" == *'fixture_inputs_removed=0'* ]] &&
   [[ "$mcp_cleanup_body" == *'if [ "$fixture_inputs_removed" = 1 ] && [ "$restore_ok" = 1 ]; then'* ]] &&
   [ -n "$mcp_input_absence_line" ] &&
   [ -n "$mcp_restore_line" ] &&
   [ "$mcp_input_absence_line" -lt "$mcp_restore_line" ]; then
  pass "MCP readiness cleanup keeps HCC stopped until fixture input deletion is verified"
else
  fail "MCP readiness cleanup can restart HCC after an unverified Context or McpServer deletion"
fi

mcp_finalize_line="$(
  grep -nF 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' \
    <<<"$mcp_cleanup_body" | head -1 | cut -d: -f1
)"
mcp_pass_line="$(
  grep -nF 'header "HCC McpServer/Context readiness gate passed"' \
    <<<"$mcp_cleanup_body" | head -1 | cut -d: -f1
)"
if [ "$(grep -Fc 'header "HCC McpServer/Context readiness gate passed"' \
       "$MCP_READINESS_GATE")" = 1 ] &&
   [ -n "$mcp_finalize_line" ] &&
   [ -n "$mcp_pass_line" ] &&
   [ "$mcp_finalize_line" -lt "$mcp_pass_line" ]; then
  pass "MCP readiness gate announces PASS only after cleanup and lock finalization"
else
  fail "MCP readiness gate can announce PASS before cleanup and lock finalization"
fi

wait_until_body="$(sed -n '/^wait_until() {$/,/^}$/p' "$READINESS_GATE")"
# Literal source-code assertion.
# shellcheck disable=SC2016
if [[ "$wait_until_body" == *'deadline=$(( $(date +%s) + timeout ))'* ]] &&
   ! grep -Fq -- '--for=delete' "$READINESS_GATE" &&
   ! grep -Fq 'port: 8081' "$READINESS_GATE" &&
   grep -Fq 'HCC_E2E_PORT' "$READINESS_GATE"; then
  pass "readiness gate uses wall-clock deadlines, absence waits, and the deployed HCC port"
else
  fail "readiness gate retains a command-latency, zero-pod wait, or hard-coded-port edge"
fi

mcp_wait_until_body="$(sed -n '/^wait_until() {$/,/^}$/p' "$MCP_READINESS_GATE")"
mcp_port_probe_count="$(grep -Fc 'env "HCC_E2E_PORT=${HCC_PORT}"' "$MCP_READINESS_GATE")"
mcp_pod_absence_count="$(grep -Fc 'hcc_pods_absent' "$MCP_READINESS_GATE")"
# Literal source-code assertions.
# shellcheck disable=SC2016
if grep -Fq 'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"' \
     "$MCP_READINESS_GATE" &&
   [ "$(grep -Fc 'require_branch_owned_hcc_gate "$HCC_NS"' "$MCP_READINESS_GATE")" = 1 ] &&
   ! grep -Fq 'HCC_BRANCH_GATE_SYNC_MARKER' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'cluster_fingerprint_file=' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'profile_env=' "$MCP_READINESS_GATE" &&
   [[ "$mcp_wait_until_body" == *'deadline=$(( $(date +%s) + timeout ))'* ]] &&
   grep -Fq 'hcc_pods_absent' "$MCP_READINESS_GATE" &&
   ! grep -Fq -- '--for=delete' "$MCP_READINESS_GATE" &&
   ! grep -Fq 'port: 8081' "$MCP_READINESS_GATE" &&
   [ "$mcp_port_probe_count" = 4 ] &&
   [ "$mcp_pod_absence_count" = 4 ]; then
  pass "MCP readiness gate shares exact-head ownership and uses bounded portable runtime probes"
else
  fail "MCP readiness gate duplicates ownership or retains a deadline, pod-absence, or port edge"
fi

# The caller-selected v1 Context route is a 410 tombstone. This readiness gate
# may use the temporary PR 2 global metadata inventory, but it must bind the
# uniquely named fixture back to the expected Context before claiming success.
mcp_final_context_probe="$(
  sed -n '/^probe_hcc_final_context() {$/,/^probe_hcc_ready_pod() {$/p' \
    "$MCP_READINESS_GATE"
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$mcp_final_context_probe" == *"get('/api/v1/mcpservers')"* ]] &&
   [[ "$mcp_final_context_probe" == *'server.contextRef === context'* ]] &&
   [[ "$mcp_final_context_probe" == *'fixture.status?.ready !== true'* ]] &&
   [[ "$mcp_final_context_probe" != *'/api/v1/mcpservers/context/'* ]]; then
  pass "MCP readiness final probe uses global metadata and binds the fixture to its Context"
else
  fail "MCP readiness final probe calls a retired route or loses Context binding"
fi

# A single held McpServer proves the minimal failure, but this gate must also
# cross the controller's bounded worker width with independent, gate-owned
# McpServer/Context pairs. Keep this as a static contract so future edits do
# not silently reduce the fleet scenario back to one fixture. The fixture
# must exist while HCC is stopped, otherwise it would not exercise startup.
mcp_peer_create_line="$(grep -nF 'create_peer_fleet || die' "$MCP_READINESS_GATE" | cut -d: -f1)"
mcp_restart_line="$(grep -nF 'kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1' "$MCP_READINESS_GATE" | tail -1 | cut -d: -f1)"
peer_fleet_converged_body="$(
  sed -n '/^peer_fleet_converged() {$/,/^}$/p' "$MCP_READINESS_GATE"
)"
if grep -Fq 'MCP_FLEET_SIZE="${E2E_HCC_MCP_FLEET_SIZE:-11}"' "$MCP_READINESS_GATE" &&
   grep -Fq '[ "$MCP_FLEET_SIZE" -gt 10 ]' "$MCP_READINESS_GATE" &&
   grep -Fq 'create_peer_fleet' "$MCP_READINESS_GATE" &&
   grep -Fq 'peer_fleet_converged' "$MCP_READINESS_GATE" &&
   [[ "$peer_fleet_converged_body" == *'mcpserver_current_ready "$server"'* ]] &&
   [[ "$peer_fleet_converged_body" == *'context_policies_converged "$context" "$context" "$server"'* ]] &&
   grep -Fq 'all peer MCP/Context runtimes to converge after releasing the held primary egress' "$MCP_READINESS_GATE" &&
   [ -n "$mcp_peer_create_line" ] && [ -n "$mcp_restart_line" ] &&
   [ "$mcp_peer_create_line" -lt "$mcp_restart_line" ]; then
  pass "MCP readiness gate crosses the bounded worker width with gate-owned MCP and Context peers"
else
  fail "MCP readiness gate does not prove a fleet larger than the worker width"
fi

for gate in "${GATES[@]}"; do
  acquire_line="$(grep -nF 'acquire_hcc_watch_gate_lock' "$gate" | tail -1 | cut -d: -f1)"
  case "$gate" in
    "$WATCH_GATE")
      # Literal source-code assertion.
      # shellcheck disable=SC2016
      mutation_line="$(grep -nF 'kctl patch deployment "$HCC_DEPLOY"' "$gate" | tail -1 | cut -d: -f1)"
      ;;
    *)
      mutation_line="$(grep -nF 'HCC_MUTATED=1' "$gate" | tail -1 | cut -d: -f1)"
      ;;
  esac
  # The grep pattern intentionally matches literal shell variable references.
  # shellcheck disable=SC2016
  if [ -n "$acquire_line" ] && [ -n "$mutation_line" ] &&
     [ "$acquire_line" -lt "$mutation_line" ] &&
     grep -Fq 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' "$gate"; then
    pass "$(basename "$gate") acquires before mutation and finalizes ownership from cleanup"
  else
    fail "$(basename "$gate") does not hold the shared lock across its full fault-injection window"
  fi
done

kctl() {
  local action=$1 body expected_rv current_rv current_uid next_rv
  case "$action" in
    create)
      [ ! -s "$MOCK_STATE_FILE" ] || return 1
      body="$(cat)"
      if [ "${MOCK_CREATE_WITHOUT_UID:-0}" = 1 ]; then
        jq -c '.metadata.resourceVersion="1"' <<<"$body" >"$MOCK_STATE_FILE"
      else
        jq -c '.metadata.uid="uid-1" | .metadata.resourceVersion="1"' <<<"$body" >"$MOCK_STATE_FILE"
      fi
      cat "$MOCK_STATE_FILE"
      ;;
    get)
      [ -s "$MOCK_STATE_FILE" ] || return 1
      cat "$MOCK_STATE_FILE"
      ;;
    replace)
      body="$(cat)"
      [ -s "$MOCK_STATE_FILE" ] || return 1
      if [ "${MOCK_REPLACE_RACE:-0}" = 1 ]; then
        jq -c '.metadata.uid="uid-race" | .metadata.resourceVersion="99" |
          .data.state="active" | .data.holder="intruder"' "$MOCK_STATE_FILE" >"${MOCK_STATE_FILE}.next"
        mv "${MOCK_STATE_FILE}.next" "$MOCK_STATE_FILE"
        return 1
      fi
      expected_rv="$(jq -r '.metadata.resourceVersion' <<<"$body")"
      current_rv="$(jq -r '.metadata.resourceVersion' "$MOCK_STATE_FILE")"
      [ "$expected_rv" = "$current_rv" ] || return 1
      current_uid="$(jq -r '.metadata.uid' "$MOCK_STATE_FILE")"
      next_rv=$((current_rv + 1))
      jq -c --arg uid "$current_uid" --arg rv "$next_rv" \
        '.metadata.uid=$uid | .metadata.resourceVersion=$rv' <<<"$body" >"$MOCK_STATE_FILE"
      cat "$MOCK_STATE_FILE"
      ;;
    *) return 1 ;;
  esac
}
truncate_rfc1123() { printf '%.63s' "$1"; }
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
source "$LOCK_HELPER"

HCC_NS=control-plane
HCC_DEPLOY="host-context-controller"
E2E_KUBECONTEXT=clerum-codex-lock-test-1234abcd
RUN_ID=owner-1
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_NAME=""
HCC_GATE_LOCK_UID=""
HCC_GATE_FINALIZATION_FAILURE=""
if acquire_hcc_watch_gate_lock &&
   [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = owner-1 ] &&
   [ "$(jq -r '.data.state' "$MOCK_STATE_FILE")" = active ]; then
  pass "first gate atomically creates an active lock with diagnostic metadata"
else
  fail "first gate could not acquire the lock"
fi

RUN_ID=contender-2
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
if acquire_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "second gate acquired an active lock"
else
  pass "second gate is rejected while the lock is active"
fi

HCC_GATE_LOCK_ACQUIRED=1
HCC_GATE_LOCK_UID="uid-1"
if release_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "non-owner released the lock"
else
  pass "non-owner cannot release the lock"
fi

RUN_ID=owner-1
if finalize_hcc_watch_gate_lock 0 1 &&
   [ "$(jq -r '.data.state' "$MOCK_STATE_FILE")" = released ] &&
   [ -z "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" ]; then
  pass "clean finalization releases ownership through resourceVersion CAS"
else
  fail "owner could not release the lock after clean finalization"
fi

RUN_ID=contender-2
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
if acquire_hcc_watch_gate_lock && [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = contender-2 ]; then
  pass "a released semaphore can be reacquired through resourceVersion CAS"
else
  fail "released semaphore could not be reacquired"
fi

retained_output="$(finalize_hcc_watch_gate_lock 1 1 2>&1)" && retained_rc=0 || retained_rc=$?
if [ "$retained_rc" -ne 0 ] && [ "$HCC_GATE_LOCK_ACQUIRED" = 1 ] &&
   [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = contender-2 ] &&
   [[ "$retained_output" == *'cause=fixture_cleanup_failed'* ]] &&
   [[ "$retained_output" == *'Observed: state=active, holder=contender-2, uid=uid-1'* ]] &&
   [[ "$retained_output" != *'delete configmap'* ]]; then
  pass "failed cleanup retains ownership and emits verified, non-destructive diagnostics"
else
  fail "failed cleanup can silently release or misreport lock ownership"
fi

restore_output="$(finalize_hcc_watch_gate_lock 0 0 2>&1)" && restore_rc=0 || restore_rc=$?
if [ "$restore_rc" -ne 0 ] && [[ "$restore_output" == *'cause=hcc_restore_failed'* ]] &&
   [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = contender-2 ]; then
  pass "failed HCC restoration retains ownership and reports its distinct cause"
else
  fail "failed HCC restoration can release the lock or report the wrong cause"
fi

release_hcc_watch_gate_lock || fail "test setup could not release retained owner"
RUN_ID=race-owner
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
acquire_hcc_watch_gate_lock || fail "test setup could not acquire race owner"
MOCK_REPLACE_RACE=1
race_output="$(finalize_hcc_watch_gate_lock 0 1 2>&1)" && race_rc=0 || race_rc=$?
unset MOCK_REPLACE_RACE
if [ "$race_rc" -ne 0 ] && [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = intruder ] &&
   [[ "$race_output" == *'cause=lock_finalization_failed'* ]] &&
   [[ "$race_output" == *'Observed: state=active, holder=intruder, uid=uid-race'* ]]; then
  pass "release CAS cannot overwrite a replacement owner and reports lock finalization"
else
  fail "release race can clear or misreport the replacement owner's lock"
fi

RUN_ID=late-contender
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
if acquire_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "active lock left by an interrupted owner was stolen"
else
  pass "stale or interrupted active locks remain fail-closed"
fi

rm -f "$MOCK_STATE_FILE"
RUN_ID=missing-uid-owner
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
MOCK_CREATE_WITHOUT_UID=1
if acquire_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "lock acquisition trusted a response without a UID"
else
  missing_uid_output="$(finalize_hcc_watch_gate_lock 0 1 2>&1)" && missing_uid_rc=0 || missing_uid_rc=$?
  if [ "$missing_uid_rc" -ne 0 ] && [ "$HCC_GATE_LOCK_ACQUIRED" = 1 ] &&
     [ "$(jq -r '.data.state' "$MOCK_STATE_FILE")" = active ] &&
     [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = missing-uid-owner ] &&
     [[ "$missing_uid_output" == *'cause=lock_finalization_failed'* ]] &&
     [[ "$missing_uid_output" == *'uid=unknown'* ]]; then
    pass "an unverifiable acquisition UID retains the lock fail-closed"
  else
    fail "a lock without a verified UID can be released or misreported"
  fi
fi
unset MOCK_CREATE_WITHOUT_UID

cleanup_fail_line="$(grep -nF 'fail "fixture cleanup, HCC restoration, or lock finalization did not complete' "$WATCH_GATE" | cut -d: -f1)"
results_line="$(grep -nF '  print_results' "$WATCH_GATE" | head -1 | cut -d: -f1)"
if [ -n "$cleanup_fail_line" ] && [ -n "$results_line" ] && [ "$cleanup_fail_line" -lt "$results_line" ]; then
  pass "cleanup failure is counted before the final result summary"
else
  fail "cleanup can still print a false all-passed summary"
fi

# --- H3: SIGPIPE/pipefail sweep on HCC pass-marker log probes -------------
# A `printf '%s[\n]' "$logs" | grep -Fq "$..._MARKER"` probe is a false-green
# trap: on a large log with the marker near the top, `grep -Fq` exits early,
# `printf` takes SIGPIPE, and under `set -o pipefail` the whole pipeline reports
# failure — so a PRESENT marker reads as MISSING (deterministic 3/3 repro in the
# round-2 storm gate). The safe idiom is a here-string: no producer to signal.
#     grep -Fq -- "$MARKER" <<<"$logs"
#
# Scope: HCC pass-marker gates only (storm + measure). Explicitly OUT OF SCOPE
# (tracked separately — a different failure class, or a non-HCC gate outside
# this PR's blast radius):
#   - e2e-gke-secrets.sh:291-294  grep -oE|wc leak COUNT: reads the whole log,
#                                 no early-exit, so it is NOT the SIGPIPE class.
#   - e2e-plugin-workload-sdk.sh  SDK markers (non-HCC).
#   - e2e-lib.sh / e2e-prod-lib.sh / e2e-channel-reader-per-host.sh (non-HCC).
HCC_STORM_GATE="${SCRIPT_DIR}/e2e-host-storm-gate.sh"
# shellcheck disable=SC2016
sigpipe_offenders="$(
  grep -nE 'printf[^|]*\| *grep -Fq[^<]*_MARKER' \
    "$HCC_STORM_GATE" "$HOST_BUNDLE_MEASURE" 2>/dev/null || true
)"
if [ -z "$sigpipe_offenders" ]; then
  pass "HCC pass-marker probes use here-strings, not pipefail/SIGPIPE pipes"
else
  fail "HCC pass-marker probe reintroduced a printf|grep -Fq SIGPIPE path:
${sigpipe_offenders}"
fi

# Corroborating repro of the mechanism the sweep guards against. The here-string
# form MUST find a marker on line 1 of a 1.6 MB log (hard invariant). The pipe
# form is expected to miss it under pipefail (SIGPIPE) — that miss is the bug,
# demonstrated, not a standing assertion, so a platform that does not reproduce
# it is not a suite failure: the static sweep above is the real enforcement.
h3_marker='HCC_PASS_COMPLETED: h3 repro sentinel'
h3_bulk="$(yes 'xxxxxxxxxxxxxxxx' | head -c 1600000)"
h3_log="${h3_marker}
${h3_bulk}"
if grep -Fq -- "$h3_marker" <<<"$h3_log"; then
  pass "here-string probe finds a marker on line 1 of a 1.6 MB log"
else
  fail "here-string probe MISSED a present marker on a large log (regression)"
fi
h3_pipe_found=0
( set -o pipefail; printf '%s\n' "$h3_log" | grep -Fq -- "$h3_marker" ) && h3_pipe_found=1
if [ "$h3_pipe_found" -eq 0 ]; then
  pass "pipe+pipefail probe misses the same marker (SIGPIPE repro confirmed)"
else
  pass "pipe probe did not SIGPIPE on this platform; static sweep still enforces the idiom"
fi

exit "$FAIL"
