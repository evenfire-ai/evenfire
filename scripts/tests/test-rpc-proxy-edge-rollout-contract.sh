#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/minikube/rpc-proxy-edge-rollout-gate.sh"
ROLLOUT="${ROOT}/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh"
PRE_GATE_SYNC="${ROOT}/scripts/minikube/pre-gate-sync.sh"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
FAKE_KUBECTL="${TMP}/kubectl"
FAKE_LOG="${TMP}/kubectl.log"
STRICT='signed-assertion-v1'
# Any value other than the strict one: an HCC or Host on a rolled-back release.
PREVIOUS='previous-edge-protocol'

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

bash -n "$GATE" || fail 'rollout gate shell syntax'
bash -n "$ROLLOUT" || fail 'rollout coordinator shell syntax'
bash -n "$PRE_GATE_SYNC" || fail 'pre-gate shell syntax'
bash -n "${ROOT}/scripts/minikube/pre-gate-incremental.sh" || fail 'incremental shell syntax'

cat >"$FAKE_KUBECTL" <<'FAKE_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
[[ "$args" == *'--context=fixture-context'* ]] || exit 91
printf '%s\n' "$args" >>"${FAKE_LOG}"
label='clerum.io/rpc-proxy-edge-protocol'
strict='signed-assertion-v1'
previous='previous-edge-protocol'
scenario="${FAKE_SCENARIO:-proxy-strict}"
protocol="${FAKE_HCC_PROTOCOL:-signed-assertion-v1}"

if [[ "$scenario" == 'blocked-read' ]]; then
  printf '%s\n' "$$" >"${FAKE_CHILD_PID:?missing fake child pid path}"
  sleep 10
fi

if [[ "$args" == *' kustomize '* ]]; then
  target_proxy="${FAKE_TARGET_PROXY:-$strict}"
  target_host="${FAKE_TARGET_HOST:-$strict}"
  target_env="[{\"name\": \"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL\", \"value\": \"${target_host}\"}]"
  [[ "$target_host" != 'none' ]] || target_env='[]'
  cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rpc-proxy
  namespace: rpc-proxy
spec:
  template:
    metadata:
      labels:
        clerum.io/rpc-proxy-edge-protocol: ${target_proxy}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: host-context-controller
  namespace: control-plane
spec:
  template:
    metadata:
      labels: {}
    spec:
      containers:
        - name: host-context-controller
          env: ${target_env}
YAML
  exit 0
fi

pod() {
  local pod_label="$1" extra="${2:-}"
  printf '{"metadata":{"labels":{"%s":"%s"}%s},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}' \
    "$label" "$pod_label" "$extra"
}

if [[ "$args" == *'get deployment rpc-proxy '* ]]; then
  desired=2
  [[ "$scenario" != 'proxy-zero' ]] || desired=0
  marker="$strict"
  [[ "$scenario" != 'proxy-old' ]] || marker="$previous"
  printf '{"metadata":{"generation":7},"spec":{"replicas":%s,"template":{"metadata":{"labels":{"%s":"%s"}}}},"status":{"observedGeneration":7,"updatedReplicas":%s,"readyReplicas":%s,"availableReplicas":%s}}\n' \
    "$desired" "$label" "$marker" "$desired" "$desired" "$desired"
  exit 0
fi
if [[ "$args" == *'get pods -n rpc-proxy '* ]]; then
  case "$scenario" in
    proxy-zero) echo '{"items":[]}' ;;
    proxy-old) printf '{"items":[%s,%s]}\n' "$(pod "$previous")" "$(pod "$previous")" ;;
    proxy-mixed) printf '{"items":[%s,%s]}\n' "$(pod "$strict")" "$(pod "$previous")" ;;
    proxy-terminating) printf '{"items":[%s,%s]}\n' "$(pod "$strict")" "$(pod "$strict" ',"deletionTimestamp":"now"')" ;;
    *) printf '{"items":[%s,%s]}\n' "$(pod "$strict")" "$(pod "$strict")" ;;
  esac
  exit 0
fi
if [[ "$args" == *'get deployment host-context-controller '* ]]; then
  env_json="{\"name\":\"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL\",\"value\":\"$protocol\"}"
  hcc_labels="{\"clerum.io/host-runtime-edge-protocol\":\"$protocol\"}"
  if [[ "$protocol" == 'none' ]]; then
    # An HCC Deployment with no edge protocol selector and no marker.
    env_json='{"name":"CONTEXT_MAPPER_HOST_NAMESPACE","value":"mcp-host"}'
    hcc_labels='{"app":"host-context-controller"}'
  fi
  printf '{"metadata":{"generation":3},"spec":{"replicas":1,"template":{"metadata":{"labels":%s},"spec":{"containers":[{"name":"host-context-controller","env":[%s]}]}}},"status":{"observedGeneration":3,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}\n' \
    "$hcc_labels" "$env_json"
  exit 0
fi
if [[ "$args" == *'get deployments -n control-plane '* ]]; then
  printf '%s\n' host-context-controller control-api api-worker
  exit 0
fi
if [[ "$args" == *'get deployments -n mcp-server '* ]]; then
  echo mcp-server
  exit 0
fi
if [[ "$args" == *'get deployments -n profiles '* ]]; then
  echo external-rest-api
  exit 0
fi
if [[ "$args" == *'get deployments -n rpc-proxy '* ]]; then
  echo rpc-proxy
  exit 0
fi
if [[ "$args" == *'get deployments -n channels '* ]]; then
  echo channel-reader
  exit 0
fi
if [[ "$args" == *'get pods -n control-plane '* ]]; then
  echo '{"items":[{"metadata":{"labels":{"app":"host-context-controller"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
  exit 0
fi
if [[ "$args" == *'get deployments -n mcp-host -l clerum.io/managed-by=host-context-controller '* ]]; then
  marker="$previous"
  ready=1
  [[ "$scenario" != 'hosts-strict' && "$scenario" != 'hosts-terminating' ]] || marker="$strict"
  [[ "$scenario" != 'hosts-notready' ]] || ready=0
  printf '{"items":[{"metadata":{"generation":2},"spec":{"replicas":1,"template":{"metadata":{"labels":{"%s":"%s"}}}},"status":{"observedGeneration":2,"updatedReplicas":1,"readyReplicas":%s,"availableReplicas":%s}}]}\n' \
    "$label" "$marker" "$ready" "$ready"
  exit 0
fi
if [[ "$args" == *'get pods -n mcp-host '* ]]; then
  if [[ "$scenario" == 'hosts-strict' || "$scenario" == 'hosts-terminating' ]]; then
    deletion=''
    [[ "$scenario" != 'hosts-terminating' ]] || deletion=',"deletionTimestamp":"now"'
    printf '{"items":[%s]}\n' "$(pod "$strict" "$deletion")"
  else
    echo '{"items":[]}'
  fi
  exit 0
fi
if [[ "$args" == *'get deployments -n mcp-host '* ]]; then
  echo 'chatllm'
  exit 0
fi
if [[ "$args" == *'rollout restart '* || "$args" == *'rollout status '* || "$args" == *'rollout undo '* ]]; then
  exit 0
fi
echo "unexpected kubectl invocation: $args" >&2
exit 92
FAKE_KUBECTL
chmod +x "$FAKE_KUBECTL"

# An accepted cohort returns on the first poll, so a long timeout costs nothing.
# A rejected cohort costs the whole timeout. The gate counts whole seconds, so a
# 1 s timeout can expire before the first read: never expect a pass under it.
ACCEPT_TIMEOUT=30
REJECT_TIMEOUT=5

run_gate() {
  FAKE_SCENARIO="$1" FAKE_HCC_PROTOCOL="${2:-$STRICT}" \
    FAKE_LOG="$FAKE_LOG" KUBECTL_BIN="$FAKE_KUBECTL" \
    bash "$GATE" "$3" --context fixture-context --timeout-seconds "${4:-1}" --poll-seconds 1
}

run_rollout() {
  local scenario="$1" hcc_protocol="$2" timeout="$3"
  shift 3
  FAKE_SCENARIO="$scenario" FAKE_HCC_PROTOCOL="$hcc_protocol" \
    FAKE_LOG="$FAKE_LOG" KUBECTL_BIN="$FAKE_KUBECTL" \
    bash "$ROLLOUT" "$@" --context fixture-context --timeout-seconds "$timeout"
}

# Line number of the first logged call that contains $1; empty when none.
first_log_line() {
  { grep -nF -- "$1" "$FAKE_LOG" || true; } | head -n 1 | cut -d: -f1
}

# A rejected cohort must be rejected after the gate read it, not because the
# deadline expired first: each poll reads every object before it decides, so
# the poll's last read ($4) is the witness that one full poll ran.
expect_gate_reject() {
  local scenario="$1" hcc_protocol="$2" mode="$3" witness="$4" message="$5"
  : >"$FAKE_LOG"
  if run_gate "$scenario" "$hcc_protocol" "$mode" "$REJECT_TIMEOUT" >/dev/null 2>&1; then
    fail "$message"
  fi
  [[ -n "$(first_log_line "$witness")" ]] || fail "rejection without a full poll: $message"
}
PROXY_POLL_WITNESS='get pods -n rpc-proxy '
HOST_POLL_WITNESS="get pods -n mcp-host -l clerum.io/rpc-proxy-edge-protocol=${STRICT}"
HCC_SELECTOR_READ='get deployment host-context-controller -n control-plane'

run_apply_preflight() {
  FAKE_TARGET_PROXY="$1" FAKE_TARGET_HOST="$2" \
    FAKE_LOG="$FAKE_LOG" KUBECTL_BIN="$FAKE_KUBECTL" \
    RUBYOPT=--disable=gems ruby \
      "${ROOT}/scripts/minikube/assert-rpc-proxy-edge-apply-safe.rb" \
      --context fixture-context --overlay fixture-overlay
}

: >"$FAKE_LOG"
run_apply_preflight "$STRICT" "$STRICT" >/dev/null ||
  fail 'signed-assertion target pair rejected by full-apply guard'
[[ -n "$(first_log_line ' kustomize fixture-overlay')" ]] || fail 'full-apply guard never rendered the overlay'
if run_apply_preflight "$PREVIOUS" "$STRICT" >/dev/null 2>&1; then
  fail 'full overlay allowed a Proxy that does not sign for signed-assertion Hosts'
fi
if run_apply_preflight "$STRICT" "$PREVIOUS" >/dev/null 2>&1; then
  fail 'full overlay allowed an HCC that does not select signed-assertion-v1'
fi
if run_apply_preflight "$STRICT" none >/dev/null 2>&1; then
  fail 'full overlay allowed an HCC without an edge protocol selector'
fi
pass 'full-overlay guard admits only the signed-assertion pair'

run_gate proxy-strict "$STRICT" wait-proxy "$ACCEPT_TIMEOUT" >/dev/null || fail 'signed-assertion Proxy cohort rejected'
expect_gate_reject proxy-old "$STRICT" wait-proxy "$PROXY_POLL_WITNESS" 'old Proxy cohort passed'
expect_gate_reject proxy-mixed "$STRICT" wait-proxy "$PROXY_POLL_WITNESS" 'mixed Proxy cohort passed'
expect_gate_reject proxy-zero "$STRICT" wait-proxy "$PROXY_POLL_WITNESS" 'zero Proxy replicas passed'
expect_gate_reject proxy-terminating "$STRICT" wait-proxy "$PROXY_POLL_WITNESS" 'terminating Proxy pod passed'
pass 'upgrade gate accepts only the full current Ready signed-assertion Proxy cohort'

blocked_pid="${TMP}/blocked-kubectl.pid"
started="$(date +%s)"
if FAKE_SCENARIO=blocked-read FAKE_HCC_PROTOCOL="$STRICT" FAKE_LOG="$FAKE_LOG" \
  FAKE_CHILD_PID="$blocked_pid" KUBECTL_BIN="$FAKE_KUBECTL" \
  bash "$GATE" wait-proxy --context fixture-context --timeout-seconds 2 --poll-seconds 1 \
    >/dev/null 2>&1; then
  fail 'blocking Kubernetes read unexpectedly passed'
fi
elapsed=$(( $(date +%s) - started ))
(( elapsed <= 4 )) || fail "blocking Kubernetes read exceeded gate deadline: ${elapsed}s"
[[ -s "$blocked_pid" ]] || fail 'blocking Kubernetes read did not start'
if kill -0 "$(cat "$blocked_pid")" 2>/dev/null; then
  fail 'deadline runner left its owned blocking Kubernetes child alive'
fi
pass 'gate deadline bounds and reaps a blocking Kubernetes read'

run_gate hosts-unsigned "$PREVIOUS" wait-hosts-unsigned "$ACCEPT_TIMEOUT" >/dev/null ||
  fail 'rolled-back Host cohort rejected'
run_gate hosts-unsigned none wait-hosts-unsigned "$ACCEPT_TIMEOUT" >/dev/null ||
  fail 'rolled-back HCC without a selector rejected'
expect_gate_reject hosts-strict "$PREVIOUS" wait-hosts-unsigned "$HOST_POLL_WITNESS" 'signed-assertion Host passed rollback gate'
expect_gate_reject hosts-terminating "$PREVIOUS" wait-hosts-unsigned "$HOST_POLL_WITNESS" 'terminating signed-assertion Host passed rollback gate'
expect_gate_reject hosts-notready "$PREVIOUS" wait-hosts-unsigned "$HOST_POLL_WITNESS" 'unready rolled-back Host cohort passed rollback gate'
expect_gate_reject hosts-unsigned "$STRICT" wait-hosts-unsigned "$HOST_POLL_WITNESS" 'HCC still selecting signed-assertion-v1 passed rollback gate'
pass 'rollback gate waits until no HCC or Host workload carries signed-assertion-v1'

: >"$FAKE_LOG"
run_rollout proxy-strict "$STRICT" "$ACCEPT_TIMEOUT" restart-targets \
  --restart-proxy --restart-hcc --restart-host chatllm >/dev/null ||
  fail 'ordered restart failed'
proxy_line="$(first_log_line 'rollout restart deployment/rpc-proxy -n rpc-proxy')"
proxy_wait_line="$(first_log_line "$PROXY_POLL_WITNESS")"
hcc_line="$(first_log_line 'rollout restart deployment/host-context-controller -n control-plane')"
host_line="$(first_log_line 'rollout restart deployment/chatllm -n mcp-host')"
[[ -n "$proxy_line" && -n "$proxy_wait_line" && -n "$hcc_line" && -n "$host_line" &&
   "$proxy_line" -lt "$proxy_wait_line" && "$proxy_wait_line" -lt "$hcc_line" &&
   "$hcc_line" -lt "$host_line" ]] || fail 'upgrade order is not Proxy, Proxy gate, HCC, Host'
pass 'restart-targets restarts Proxy, waits for its cohort, then HCC and Host'

# The Makefile restarts the Proxy alone, with no Host option, after an image build.
: >"$FAKE_LOG"
run_rollout proxy-strict "$STRICT" "$ACCEPT_TIMEOUT" restart-targets --restart-proxy >/dev/null ||
  fail 'Proxy-only restart failed'
[[ "$(grep -Fc 'rollout restart ' "$FAKE_LOG")" -eq 1 ]] ||
  fail 'Proxy-only restart did not restart exactly one Deployment'
grep -Fq 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" ||
  fail 'Proxy-only restart did not restart the RPC Proxy'
pass 'Proxy-only restart works without any Host option'

for refused in "$PREVIOUS" none; do
  : >"$FAKE_LOG"
  if run_rollout proxy-strict "$refused" "$REJECT_TIMEOUT" restart-targets \
    --restart-proxy --restart-hcc --restart-host chatllm >/dev/null 2>"${TMP}/reject.err"; then
    fail "restart-targets accepted HCC selector $refused"
  fi
  [[ -n "$(first_log_line "$HCC_SELECTOR_READ")" ]] ||
    fail "selector $refused was refused without reading the HCC selector"
  grep -Fq 'HCC Host edge protocol selector' "${TMP}/reject.err" ||
    fail "selector $refused was not refused by the selector check"
  if grep -Fq 'rollout restart ' "$FAKE_LOG"; then
    fail "selector $refused restarted a workload before it was refused"
  fi
done
pass 'restart-targets refuses an HCC that does not select signed-assertion-v1 before any restart'

: >"$FAKE_LOG"
if run_rollout hosts-strict "$PREVIOUS" 2 rollback-proxy \
  --to-hcc-revision 4 --to-proxy-revision 7 >/dev/null 2>&1; then
  fail 'Proxy rollback proceeded while a signed-assertion Host remained'
fi
[[ -n "$(first_log_line "$HOST_POLL_WITNESS")" ]] || fail 'Proxy rollback refusal never read the Host cohort'
if grep -Fq 'rollout undo deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG"; then
  fail 'Proxy rollback was attempted before the Host gate passed'
fi
pass 'a signed-assertion Host blocks the Proxy rollback mutation'

: >"$FAKE_LOG"
run_rollout hosts-unsigned "$PREVIOUS" "$ACCEPT_TIMEOUT" rollback-proxy \
  --to-hcc-revision 4 --to-proxy-revision 7 >/dev/null ||
  fail 'rolled-back Host cohort did not permit Proxy rollback'
hcc_undo_line="$(first_log_line 'rollout undo deployment/host-context-controller -n control-plane')"
host_read_line="$(first_log_line "$HOST_POLL_WITNESS")"
proxy_undo_line="$(first_log_line 'rollout undo deployment/rpc-proxy -n rpc-proxy')"
[[ -n "$hcc_undo_line" && -n "$host_read_line" && -n "$proxy_undo_line" &&
   "$hcc_undo_line" -lt "$host_read_line" && "$host_read_line" -lt "$proxy_undo_line" ]] ||
  fail 'Proxy rollback did not follow HCC rollback and the Host gate'
pass 'Proxy rollback is admitted only after HCC and Hosts leave signed-assertion-v1'

# The strict branch of pre-gate-sync, run as written against the fake cluster.
edge_block="$(awk '
  /^  hcc_edge_protocol="\$\(/ { s = 1 }
  s { print }
  s && /^  rollout_namespace_deployments mcp-host$/ { exit }
' "$PRE_GATE_SYNC")"
[[ "$edge_block" == *'rollout_namespace_deployments mcp-host'* ]] ||
  fail 'unable to extract the pre-gate-sync edge protocol block'
run_pre_gate_edge_block() {
  FAKE_SCENARIO=proxy-strict FAKE_HCC_PROTOCOL="$1" FAKE_LOG="$FAKE_LOG" \
    KUBECTL_BIN="$FAKE_KUBECTL" SCRIPT_DIR="${ROOT}/scripts/minikube" EDGE_BLOCK="$edge_block" \
    bash -c '
      set -euo pipefail
      PROFILE=fixture-context
      KC="${KUBECTL_BIN} --context=${PROFILE}"
      log() { echo "$*" >&2; }
      rollout_if_present() { printf "rollout_if_present %s/%s\n" "$1" "$2" >>"$FAKE_LOG"; }
      rollout_namespace_deployments() { printf "rollout_namespace_deployments %s\n" "$1" >>"$FAKE_LOG"; }
      eval "$EDGE_BLOCK"
    '
}
: >"$FAKE_LOG"
run_pre_gate_edge_block "$STRICT" >/dev/null 2>&1 || fail 'pre-gate-sync edge block failed on signed-assertion-v1'
selector_line="$(first_log_line "$HCC_SELECTOR_READ")"
proxy_line="$(first_log_line 'rollout_if_present rpc-proxy/rpc-proxy')"
proxy_wait_line="$(first_log_line "$PROXY_POLL_WITNESS")"
hcc_line="$(first_log_line 'rollout_if_present control-plane/host-context-controller')"
hosts_line="$(first_log_line 'rollout_namespace_deployments mcp-host')"
[[ -n "$selector_line" && -n "$proxy_line" && -n "$proxy_wait_line" && -n "$hcc_line" && -n "$hosts_line" &&
   "$selector_line" -lt "$proxy_line" && "$proxy_line" -lt "$proxy_wait_line" &&
   "$proxy_wait_line" -lt "$hcc_line" && "$hcc_line" -lt "$hosts_line" ]] ||
  fail 'pre-gate-sync order is not Proxy, Proxy gate, HCC, Hosts'
[[ "$(grep -Fc 'rollout_if_present rpc-proxy/rpc-proxy' "$FAKE_LOG")" -eq 1 &&
   "$(grep -Fc 'rollout_if_present control-plane/host-context-controller' "$FAKE_LOG")" -eq 1 &&
   "$(grep -Fc 'rollout_namespace_deployments mcp-host' "$FAKE_LOG")" -eq 1 ]] ||
  fail 'pre-gate-sync rolls an edge workload more than once'
for refused in "$PREVIOUS" none; do
  : >"$FAKE_LOG"
  if run_pre_gate_edge_block "$refused" >/dev/null 2>&1; then
    fail "pre-gate-sync accepted HCC selector $refused"
  fi
  [[ -n "$(first_log_line "$HCC_SELECTOR_READ")" ]] ||
    fail "pre-gate-sync refused selector $refused without reading it"
  if grep -Fq 'rollout_' "$FAKE_LOG"; then
    fail "pre-gate-sync rolled a workload before refusing selector $refused"
  fi
done
# control-api, which signs the assertion, is restored and restarted before the edge block.
block_start="$(grep -n '^  hcc_edge_protocol="\$(' "$PRE_GATE_SYNC" | cut -d: -f1)"
restore_line="$(grep -n '^  restore_control_api$' "$PRE_GATE_SYNC" | tail -n 1 | cut -d: -f1)"
targets_line="$(grep -n '^  incremental_restart_targets$' "$PRE_GATE_SYNC" | tail -n 1 | cut -d: -f1)"
[[ -n "$block_start" && -n "$restore_line" && -n "$targets_line" &&
   "$restore_line" -lt "$block_start" && "$targets_line" -lt "$block_start" ]] ||
  fail 'pre-gate-sync does not converge control-api before the RPC Proxy'
pass 'pre-gate-sync runs control-api, then Proxy, Proxy gate, HCC and Hosts, and refuses any other selector'

# The pair deploy/base ships must pass its own rollout machinery. It is read
# from the manifests, so these cases follow them.
shipped="$(RUBYOPT=--disable=gems ruby -ryaml -e '
  find = lambda do |path, name|
    YAML.load_stream(File.read(path)).compact.find do |doc|
      doc.is_a?(Hash) && doc["kind"] == "Deployment" && doc.dig("metadata", "name") == name
    end || abort("#{path} has no #{name} Deployment")
  end
  proxy = find.call(ARGV[0], "rpc-proxy")
  hcc = find.call(ARGV[1], "host-context-controller")
  selectors = Array(hcc.dig("spec", "template", "spec", "containers"))
    .flat_map { |container| Array(container["env"]) }
    .select { |entry| entry["name"] == "CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL" }
  abort("shipped HCC must set the edge protocol selector exactly once") unless selectors.length == 1
  label = proxy.dig("spec", "template", "metadata", "labels", "clerum.io/rpc-proxy-edge-protocol")
  puts "#{label || "none"} #{selectors.first["value"]}"
' "${ROOT}/deploy/base/rpc-proxy/rpc-proxy.yaml" \
  "${ROOT}/deploy/base/control-plane/host-context-controller.yaml")" ||
  fail 'unable to read the shipped edge protocol pair from deploy/base'
read -r shipped_proxy_label shipped_hcc_selector <<<"$shipped"
run_apply_preflight "$shipped_proxy_label" "$shipped_hcc_selector" >/dev/null ||
  fail "full-apply guard rejects the shipped pair: proxy ${shipped_proxy_label}, HCC ${shipped_hcc_selector}"
: >"$FAKE_LOG"
run_rollout proxy-strict "$shipped_hcc_selector" "$ACCEPT_TIMEOUT" restart-targets \
  --restart-proxy --restart-hcc --restart-host chatllm >/dev/null ||
  fail 'ordered restart rejects the shipped HCC selector'
grep -Fq 'rollout restart deployment/chatllm -n mcp-host' "$FAKE_LOG" ||
  fail 'ordered restart with the shipped HCC selector never reached the Host'
pass 'shipped HCC selector and RPC Proxy label pass the apply guard and the ordered restart'

make_plan="$(make -n minikube-restart-all MINIKUBE_PROFILE=fixture-context)"
[[ "$make_plan" == *'--restart-all-non-edge --restart-proxy'* &&
   "$make_plan" == *'--restart-hcc --restart-all-hosts'* ]] ||
  fail 'Makefile restart-all argv no longer includes the documented rollout options'
: >"$FAKE_LOG"
run_rollout proxy-strict "$STRICT" "$ACCEPT_TIMEOUT" restart-targets \
  --restart-all-non-edge --restart-proxy --restart-hcc --restart-all-hosts >/dev/null ||
  fail 'Make-produced restart-all options were rejected or failed'
for expected in \
  'rollout restart deployment/control-api -n control-plane' \
  'rollout restart deployment/api-worker -n control-plane' \
  'rollout restart deployment/mcp-server -n mcp-server' \
  'rollout restart deployment/external-rest-api -n profiles' \
  'rollout restart deployment/channel-reader -n channels'; do
  grep -Fq "$expected" "$FAKE_LOG" || fail "restart-all branch omitted $expected"
done
[[ "$(grep -Fc 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG")" -eq 1 &&
   "$(grep -Fc 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG")" -eq 1 ]] ||
  fail 'restart-all-non-edge duplicated an edge-owned restart'
control_api_line="$(first_log_line 'rollout restart deployment/control-api -n control-plane')"
proxy_line="$(first_log_line 'rollout restart deployment/rpc-proxy -n rpc-proxy')"
[[ "$control_api_line" -lt "$proxy_line" ]] || fail 'restart-all restarted the RPC Proxy before control-api'
pass 'Make restart-all restarts control-api before the Proxy and excludes edge Deployments from the non-edge sweep'

: >"$FAKE_LOG"
if KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
  --unknown-option >/dev/null 2>&1; then
  fail 'unknown rollout option was accepted'
fi
if KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
  --restart-host >/dev/null 2>&1; then
  fail 'missing restart-host argument was accepted'
fi
if KUBECTL_BIN="$FAKE_KUBECTL" bash "$GATE" wait-proxy-legacy --context fixture-context >/dev/null 2>&1; then
  fail 'removed gate mode was accepted'
fi
[[ ! -s "$FAKE_LOG" ]] || fail 'invalid rollout arguments reached kubectl'
pass 'unknown options, removed modes and missing arguments remain rejected before runtime calls'

echo 'PASS: RPC Proxy edge rollout contract'
