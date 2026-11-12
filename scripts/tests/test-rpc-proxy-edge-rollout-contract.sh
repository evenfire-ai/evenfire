#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/minikube/rpc-proxy-edge-rollout-gate.sh"
ROLLOUT="${ROOT}/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
FAKE_KUBECTL="${TMP}/kubectl"
FAKE_LOG="${TMP}/kubectl.log"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

bash -n "$GATE" || fail 'rollout gate shell syntax'
bash -n "$ROLLOUT" || fail 'rollout coordinator shell syntax'
bash -n "${ROOT}/scripts/minikube/pre-gate-sync.sh" || fail 'pre-gate shell syntax'
bash -n "${ROOT}/scripts/minikube/pre-gate-incremental.sh" || fail 'incremental shell syntax'

cat >"$FAKE_KUBECTL" <<'FAKE_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
[[ "$args" == *'--context=fixture-context'* ]] || exit 91
printf '%s\n' "$args" >>"${FAKE_LOG}"
label='clerum.io/rpc-proxy-edge-protocol'
strict='dedicated-header-v1'
scenario="${FAKE_SCENARIO:-proxy-strict}"
protocol="${FAKE_HCC_PROTOCOL:-dedicated-header-v1}"

if [[ "$scenario" == 'blocked-read' ]]; then
  printf '%s\n' "$$" >"${FAKE_CHILD_PID:?missing fake child pid path}"
  sleep 10
fi

if [[ "$args" == *' kustomize '* ]]; then
  target_proxy="${FAKE_TARGET_PROXY:-dedicated-header-v1}"
  target_host="${FAKE_TARGET_HOST:-dedicated-header-v1}"
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
          env:
            - name: CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL
              value: ${target_host}
YAML
  exit 0
fi

if [[ "$args" == *'get deployment rpc-proxy '* ]]; then
  if [[ "$scenario" == 'proxy-missing' || "$scenario" == 'proxy-missing-no-hosts' ]]; then
    echo 'Error from server (NotFound): deployments.apps "rpc-proxy" not found' >&2
    exit 1
  fi
  desired=2
  [[ "$scenario" != 'proxy-zero' ]] || desired=0
  marker="$strict"
  [[ "$scenario" != 'proxy-old' ]] || marker='legacy-headers'
  [[ "$scenario" != 'proxy-unsupported' ]] || marker='future-edge-protocol'
  proxy_labels="{\"$label\":\"$marker\"}"
  [[ "$scenario" != 'proxy-unlabelled' ]] || proxy_labels='{"app":"rpc-proxy"}'
  printf '{"metadata":{"generation":7},"spec":{"replicas":%s,"template":{"metadata":{"labels":%s}}},"status":{"observedGeneration":7,"updatedReplicas":%s,"readyReplicas":%s,"availableReplicas":%s}}\n' \
    "$desired" "$proxy_labels" "$desired" "$desired" "$desired"
  exit 0
fi
if [[ "$args" == *'get pods -n rpc-proxy '* ]]; then
  case "$scenario" in
    proxy-missing|proxy-missing-no-hosts) echo '{"items":[]}' ;;
    proxy-zero) echo '{"items":[]}' ;;
    proxy-old) echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"legacy-headers"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"legacy-headers"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
    proxy-unlabelled) echo '{"items":[{"metadata":{"labels":{"app":"rpc-proxy"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"app":"rpc-proxy"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
    proxy-unsupported) echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"future-edge-protocol"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"future-edge-protocol"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
    proxy-mixed) echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"legacy-headers"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
    proxy-terminating) echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"deletionTimestamp":"now","labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
    *) echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
  esac
  exit 0
fi
if [[ "$args" == *'get deployment host-context-controller '* ]]; then
  marker="$strict"
  [[ "$protocol" != "$strict" ]] || hcc_marker="$strict"
  [[ "$protocol" == "$strict" ]] || hcc_marker='legacy-headers'
  env_json="{\"name\":\"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL\",\"value\":\"$protocol\"}"
  hcc_labels="{\"clerum.io/host-runtime-edge-protocol\":\"$hcc_marker\"}"
  if [[ "$protocol" == 'preselector' ]]; then
    # An HCC Deployment from before the selector existed: no selector, no marker.
    env_json='{"name":"CONTEXT_MAPPER_HOST_NAMESPACE","value":"mcp-host"}'
    hcc_labels='{"app":"host-context-controller"}'
  fi
  printf '{"metadata":{"generation":3},"spec":{"replicas":1,"template":{"metadata":{"labels":%s},"spec":{"containers":[{"name":"host-context-controller","env":[%s]}]}}},"status":{"observedGeneration":3,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}\n' \
    "$hcc_labels" "$env_json"
  exit 0
fi
if [[ "$args" == *'get deployments -n control-plane '* ]]; then
  printf '%s\n' host-context-controller api-worker
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
  marker='legacy-headers'
  ready=1
  [[ "$scenario" != 'hosts-strict' && "$scenario" != 'hosts-terminating' && "$scenario" != 'proxy-missing' ]] || marker='dedicated-header-v1'
  [[ "$scenario" != 'hosts-notready' ]] || ready=0
  printf '{"items":[{"metadata":{"generation":2},"spec":{"replicas":1,"template":{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"%s"}}}},"status":{"observedGeneration":2,"updatedReplicas":1,"readyReplicas":%s,"availableReplicas":%s}}]}\n' \
    "$marker" "$ready" "$ready"
  exit 0
fi
if [[ "$args" == *'get pods -n mcp-host '* ]]; then
  if [[ "$scenario" == 'hosts-strict' || "$scenario" == 'hosts-terminating' || "$scenario" == 'proxy-missing' ]]; then
    deletion=''
    [[ "$scenario" != 'hosts-terminating' ]] || deletion=',"deletionTimestamp":"now"'
    printf '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}%s},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}\n' "$deletion"
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
  FAKE_SCENARIO="$1" FAKE_HCC_PROTOCOL="${2:-dedicated-header-v1}" \
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

# Line number of the first logged kubectl call that contains $1; empty when none.
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
HOST_POLL_WITNESS='get pods -n mcp-host -l clerum.io/rpc-proxy-edge-protocol=dedicated-header-v1'

run_apply_preflight() {
  FAKE_SCENARIO="$1" FAKE_TARGET_PROXY="$2" FAKE_TARGET_HOST="$3" \
    FAKE_LOG="$FAKE_LOG" KUBECTL_BIN="$FAKE_KUBECTL" \
    RUBYOPT=--disable=gems ruby \
      "${ROOT}/scripts/minikube/assert-rpc-proxy-edge-apply-safe.rb" \
      --context fixture-context --overlay fixture-overlay
}

run_apply_preflight proxy-strict dedicated-header-v1 dedicated-header-v1 >/dev/null ||
  fail 'safe strict target rejected by full-apply guard'
run_apply_preflight proxy-old dedicated-header-v1 legacy-headers >/dev/null ||
  fail 'new Proxy/legacy Host bridge rejected by full-apply guard'
if run_apply_preflight proxy-strict legacy-headers legacy-headers >/dev/null 2>&1; then
  fail 'full overlay bypassed the ordered strict-Proxy rollback'
fi
if run_apply_preflight proxy-old legacy-headers dedicated-header-v1 >/dev/null 2>&1; then
  fail 'full overlay allowed the forbidden old-Proxy/strict-Host target pair'
fi
if run_apply_preflight proxy-missing legacy-headers legacy-headers >/dev/null 2>&1; then
  fail 'full overlay allowed Proxy rollback while strict Hosts remain and Proxy Deployment is absent'
fi
run_apply_preflight proxy-missing-no-hosts legacy-headers legacy-headers >/dev/null ||
  fail 'fresh bootstrap with no current Proxy or strict Hosts was rejected'
pass 'full-overlay guard blocks unsafe rollback and forbidden target pairs'

run_gate proxy-strict dedicated-header-v1 wait-proxy "$ACCEPT_TIMEOUT" >/dev/null || fail 'strict Proxy cohort accepted'
expect_gate_reject proxy-old dedicated-header-v1 wait-proxy "$PROXY_POLL_WITNESS" 'old Proxy cohort passed'
expect_gate_reject proxy-mixed dedicated-header-v1 wait-proxy "$PROXY_POLL_WITNESS" 'mixed Proxy cohort passed'
expect_gate_reject proxy-zero dedicated-header-v1 wait-proxy "$PROXY_POLL_WITNESS" 'zero Proxy replicas passed'
expect_gate_reject proxy-terminating dedicated-header-v1 wait-proxy "$PROXY_POLL_WITNESS" 'terminating old Proxy pod passed'
pass 'upgrade gate accepts only the full current Ready strict Proxy cohort'

blocked_pid="${TMP}/blocked-kubectl.pid"
started="$(date +%s)"
if FAKE_SCENARIO=blocked-read FAKE_HCC_PROTOCOL=dedicated-header-v1 FAKE_LOG="$FAKE_LOG" \
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

run_gate hosts-legacy legacy-headers wait-hosts-legacy "$ACCEPT_TIMEOUT" >/dev/null || fail 'legacy Host cohort rejected'
expect_gate_reject hosts-strict legacy-headers wait-hosts-legacy "$HOST_POLL_WITNESS" 'strict Host cohort passed rollback gate'
expect_gate_reject hosts-terminating legacy-headers wait-hosts-legacy "$HOST_POLL_WITNESS" 'terminating strict Host passed rollback gate'
expect_gate_reject hosts-notready legacy-headers wait-hosts-legacy "$HOST_POLL_WITNESS" 'unready legacy Host cohort passed rollback gate'
pass 'rollback gate waits for the complete compatible HCC/Host cohort'

: >"$FAKE_LOG"
FAKE_SCENARIO=proxy-strict FAKE_HCC_PROTOCOL=dedicated-header-v1 FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
    --restart-proxy --restart-hcc --restart-host chatllm --timeout-seconds "$ACCEPT_TIMEOUT" >/dev/null ||
  fail 'strict ordered restart failed'
proxy_line="$(grep -nF 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" | cut -d: -f1)"
hcc_line="$(grep -nF 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG" | cut -d: -f1)"
host_line="$(grep -nF 'rollout restart deployment/chatllm -n mcp-host' "$FAKE_LOG" | cut -d: -f1)"
[[ "$proxy_line" -lt "$hcc_line" && "$hcc_line" -lt "$host_line" ]] || fail 'strict upgrade order is wrong'
pass 'strict upgrade restarts Proxy before HCC and Host'

: >"$FAKE_LOG"
FAKE_SCENARIO=hosts-legacy FAKE_HCC_PROTOCOL=legacy-headers FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
    --restart-proxy --restart-hcc --restart-host chatllm --timeout-seconds "$ACCEPT_TIMEOUT" >/dev/null ||
  fail 'legacy ordered restart failed'
hcc_line="$(grep -nF 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG" | cut -d: -f1)"
host_line="$(grep -nF 'rollout restart deployment/chatllm -n mcp-host' "$FAKE_LOG" | cut -d: -f1)"
proxy_line="$(grep -nF 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" | cut -d: -f1)"
[[ "$hcc_line" -lt "$host_line" && "$host_line" -lt "$proxy_line" ]] || fail 'legacy transition order is wrong'
pass 'legacy rollback restarts HCC/Hosts before Proxy'

# The Makefile restarts the Proxy alone, with no Host option, after an image build.
: >"$FAKE_LOG"
run_rollout hosts-legacy legacy-headers "$ACCEPT_TIMEOUT" restart-targets --restart-proxy >/dev/null ||
  fail 'Proxy-only restart failed'
[[ "$(grep -Fc 'rollout restart ' "$FAKE_LOG")" -eq 1 ]] ||
  fail 'Proxy-only restart did not restart exactly one Deployment'
grep -Fq 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" ||
  fail 'Proxy-only restart did not restart the RPC Proxy'
pass 'Proxy-only restart works without any Host option'

: >"$FAKE_LOG"
if FAKE_SCENARIO=hosts-strict FAKE_HCC_PROTOCOL=legacy-headers FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" rollback-proxy --context fixture-context \
    --to-hcc-revision 4 --to-proxy-revision 7 --timeout-seconds 2 >/dev/null 2>&1; then
  fail 'Proxy rollback proceeded while a strict Host remained'
fi
if grep -Fq 'rollout undo deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG"; then
  fail 'Proxy rollback was attempted before the strict Host gate passed'
fi
pass 'strict Host blocks the Proxy rollback mutation'

: >"$FAKE_LOG"
FAKE_SCENARIO=proxy-old FAKE_HCC_PROTOCOL=legacy-headers FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" rollback-proxy --context fixture-context \
    --to-hcc-revision 4 --to-proxy-revision 7 --timeout-seconds "$ACCEPT_TIMEOUT" >/dev/null ||
  fail 'compatible Host cohort did not permit Proxy rollback'
hcc_undo_line="$(grep -nF 'rollout undo deployment/host-context-controller -n control-plane' "$FAKE_LOG" | cut -d: -f1)"
proxy_undo_line="$(grep -nF 'rollout undo deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" | cut -d: -f1)"
[[ "$hcc_undo_line" -lt "$proxy_undo_line" ]] || fail 'Proxy rollback preceded HCC rollback'
pass 'Proxy rollback is admitted only after HCC/Host compatibility is proven'

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
case "$shipped_proxy_label" in
  dedicated-header-v1) shipped_proxy=proxy-strict ;;
  legacy-headers) shipped_proxy=proxy-old ;;
  none) shipped_proxy=proxy-unlabelled ;;
  *) fail "shipped RPC Proxy label is not a supported edge protocol: $shipped_proxy_label" ;;
esac
[[ "$shipped_hcc_selector" == 'legacy-headers' ]] ||
  fail "these cases cover a shipped legacy-headers HCC selector; deploy/base ships $shipped_hcc_selector"

run_apply_preflight "$shipped_proxy" "$shipped_proxy_label" "$shipped_hcc_selector" >/dev/null ||
  fail 'full-apply guard rejects re-applying the shipped pair over itself'
run_gate "$shipped_proxy" "$shipped_hcc_selector" wait-proxy-legacy "$ACCEPT_TIMEOUT" >/dev/null ||
  fail 'legacy-compatible Proxy gate rejects the shipped RPC Proxy cohort'

# A profile last deployed before the selector existed has a selector-free HCC.
: >"$FAKE_LOG"
run_rollout "$shipped_proxy" preselector "$ACCEPT_TIMEOUT" restart-targets \
  --restart-proxy --restart-hcc --restart-host chatllm >/dev/null ||
  fail 'selector-free HCC with the shipped RPC Proxy cohort was rejected'
proxy_read_line="$(first_log_line 'get pods -n rpc-proxy ')"
first_restart_line="$(first_log_line 'rollout restart ')"
hcc_line="$(first_log_line 'rollout restart deployment/host-context-controller -n control-plane')"
host_line="$(first_log_line 'rollout restart deployment/chatllm -n mcp-host')"
proxy_line="$(first_log_line 'rollout restart deployment/rpc-proxy -n rpc-proxy')"
[[ -n "$proxy_read_line" && -n "$first_restart_line" &&
   "$proxy_read_line" -lt "$first_restart_line" ]] ||
  fail 'selector-free cohort proof did not finish before the first restart'
[[ -n "$hcc_line" && -n "$host_line" && -n "$proxy_line" &&
   "$hcc_line" -lt "$host_line" && "$host_line" -lt "$proxy_line" ]] ||
  fail 'selector-free HCC did not use the legacy restart order'

: >"$FAKE_LOG"
run_rollout "$shipped_proxy" "$shipped_hcc_selector" "$ACCEPT_TIMEOUT" rollback-proxy \
  --to-hcc-revision 4 --to-proxy-revision 7 >/dev/null ||
  fail 'rollback ending on the shipped RPC Proxy label was rejected'
grep -Fq 'rollout undo deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" ||
  fail 'rollback to the shipped RPC Proxy label skipped the Proxy undo'
pass 'shipped HCC selector and RPC Proxy label pass the gate, a selector-free restart and a rollback'

for supported in proxy-unlabelled proxy-old proxy-strict; do
  run_gate "$supported" legacy-headers wait-proxy-legacy "$ACCEPT_TIMEOUT" >/dev/null ||
    fail "legacy-compatible Proxy gate rejected a supported cohort: $supported"
done
: >"$FAKE_LOG"
if run_gate proxy-unsupported legacy-headers wait-proxy-legacy "$REJECT_TIMEOUT" \
  >/dev/null 2>"${TMP}/reject.err"; then
  fail 'legacy-compatible Proxy gate accepted an unsupported RPC Proxy label'
fi
grep -Fq 'legacy-compatible cohort did not become fully Ready' "${TMP}/reject.err" ||
  fail 'unsupported RPC Proxy label was not rejected by the legacy-compatible gate'
[[ -n "$(first_log_line 'get deployment rpc-proxy ')" && -n "$(first_log_line 'get pods -n rpc-proxy ')" ]] ||
  fail 'unsupported-label rejection never read the RPC Proxy cohort'
pass 'legacy-compatible Proxy gate accepts every supported label and rejects an unknown one'

: >"$FAKE_LOG"
if run_rollout proxy-unsupported preselector "$REJECT_TIMEOUT" restart-targets \
  --restart-proxy --restart-hcc --restart-host chatllm >/dev/null 2>"${TMP}/reject.err"; then
  fail 'selector-free HCC accepted an unsupported RPC Proxy label'
fi
grep -Fq 'legacy-compatible cohort did not become fully Ready' "${TMP}/reject.err" ||
  fail 'selector-free restart was not rejected by the legacy-compatible Proxy gate'
[[ -n "$(first_log_line 'get pods -n rpc-proxy ')" ]] ||
  fail 'selector-free rejection never read the RPC Proxy cohort'
if grep -Fq 'rollout restart ' "$FAKE_LOG"; then
  fail 'selector-free rejection restarted a workload'
fi
pass 'selector-free HCC with an unsupported RPC Proxy label is rejected before any restart'

: >"$FAKE_LOG"
if run_rollout proxy-unsupported legacy-headers "$REJECT_TIMEOUT" rollback-proxy \
  --to-hcc-revision 4 --to-proxy-revision 7 >/dev/null 2>"${TMP}/reject.err"; then
  fail 'rollback ending on an unsupported RPC Proxy label reported success'
fi
grep -Fq 'legacy-compatible cohort did not become fully Ready' "${TMP}/reject.err" ||
  fail 'rollback was not rejected by the legacy-compatible Proxy gate'
grep -Fq 'rollout undo deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" ||
  fail 'rollback rejection came before the Proxy undo'
pass 'rollback reports failure when the restored RPC Proxy cohort has an unsupported label'

make_plan="$(make -n minikube-restart-all MINIKUBE_PROFILE=fixture-context)"
[[ "$make_plan" == *'--restart-all-non-edge --restart-proxy'* &&
   "$make_plan" == *'--restart-hcc --restart-all-hosts'* ]] ||
  fail 'Makefile restart-all argv no longer includes the documented rollout options'
: >"$FAKE_LOG"
FAKE_SCENARIO=proxy-strict FAKE_HCC_PROTOCOL=dedicated-header-v1 FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
    --restart-all-non-edge --restart-proxy --restart-hcc --restart-all-hosts >/dev/null ||
  fail 'Make-produced restart-all options were rejected or failed'
for expected in \
  'rollout restart deployment/api-worker -n control-plane' \
  'rollout restart deployment/mcp-server -n mcp-server' \
  'rollout restart deployment/external-rest-api -n profiles' \
  'rollout restart deployment/channel-reader -n channels'; do
  grep -Fq "$expected" "$FAKE_LOG" || fail "restart-all branch omitted $expected"
done
[[ "$(grep -Fc 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG")" -eq 1 &&
   "$(grep -Fc 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG")" -eq 1 ]] ||
  fail 'restart-all-non-edge duplicated an edge-owned restart'
pass 'Make restart-all argv reaches the non-edge restart branch and excludes edge Deployments'

: >"$FAKE_LOG"
if KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
  --unknown-option >/dev/null 2>&1; then
  fail 'unknown rollout option was accepted'
fi
if KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
  --restart-host >/dev/null 2>&1; then
  fail 'missing restart-host argument was accepted'
fi
[[ ! -s "$FAKE_LOG" ]] || fail 'invalid rollout arguments reached kubectl'
pass 'unknown options and missing arguments remain rejected before runtime calls'

echo 'PASS: RPC Proxy edge rollout contract'
