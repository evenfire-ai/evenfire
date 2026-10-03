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
  printf '{"metadata":{"generation":7},"spec":{"replicas":%s,"template":{"metadata":{"labels":{"%s":"%s"}}}},"status":{"observedGeneration":7,"updatedReplicas":%s,"readyReplicas":%s,"availableReplicas":%s}}\n' \
    "$desired" "$label" "$marker" "$desired" "$desired" "$desired"
  exit 0
fi
if [[ "$args" == *'get pods -n rpc-proxy '* ]]; then
  case "$scenario" in
    proxy-missing|proxy-missing-no-hosts) echo '{"items":[]}' ;;
    proxy-zero) echo '{"items":[]}' ;;
    proxy-old) echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"legacy-headers"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"legacy-headers"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
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
  printf '{"metadata":{"generation":3},"spec":{"replicas":1,"template":{"metadata":{"labels":{"clerum.io/host-runtime-edge-protocol":"%s"}},"spec":{"containers":[{"name":"host-context-controller","env":[%s]}]}}},"status":{"observedGeneration":3,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}\n' \
    "$hcc_marker" "$env_json"
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

run_gate() {
  FAKE_SCENARIO="$1" FAKE_HCC_PROTOCOL="${2:-dedicated-header-v1}" \
    FAKE_LOG="$FAKE_LOG" KUBECTL_BIN="$FAKE_KUBECTL" \
    bash "$GATE" "$3" --context fixture-context --timeout-seconds 1 --poll-seconds 1
}

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

run_gate proxy-strict dedicated-header-v1 wait-proxy >/dev/null || fail 'strict Proxy cohort accepted'
if run_gate proxy-old dedicated-header-v1 wait-proxy >/dev/null 2>&1; then fail 'old Proxy cohort passed'; fi
if run_gate proxy-mixed dedicated-header-v1 wait-proxy >/dev/null 2>&1; then fail 'mixed Proxy cohort passed'; fi
if run_gate proxy-zero dedicated-header-v1 wait-proxy >/dev/null 2>&1; then fail 'zero Proxy replicas passed'; fi
if run_gate proxy-terminating dedicated-header-v1 wait-proxy >/dev/null 2>&1; then fail 'terminating old Proxy pod passed'; fi
pass 'upgrade gate accepts only the full current Ready strict Proxy cohort'

run_gate hosts-legacy legacy-headers wait-hosts-legacy >/dev/null || fail 'legacy Host cohort rejected'
if run_gate hosts-strict legacy-headers wait-hosts-legacy >/dev/null 2>&1; then fail 'strict Host cohort passed rollback gate'; fi
if run_gate hosts-terminating legacy-headers wait-hosts-legacy >/dev/null 2>&1; then fail 'terminating strict Host passed rollback gate'; fi
if run_gate hosts-notready legacy-headers wait-hosts-legacy >/dev/null 2>&1; then fail 'unready legacy Host cohort passed rollback gate'; fi
pass 'rollback gate waits for the complete compatible HCC/Host cohort'

: >"$FAKE_LOG"
FAKE_SCENARIO=proxy-strict FAKE_HCC_PROTOCOL=dedicated-header-v1 FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
    --restart-proxy --restart-hcc --restart-host chatllm --timeout-seconds 2 >/dev/null ||
  fail 'strict ordered restart failed'
proxy_line="$(grep -nF 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" | cut -d: -f1)"
hcc_line="$(grep -nF 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG" | cut -d: -f1)"
host_line="$(grep -nF 'rollout restart deployment/chatllm -n mcp-host' "$FAKE_LOG" | cut -d: -f1)"
[[ "$proxy_line" -lt "$hcc_line" && "$hcc_line" -lt "$host_line" ]] || fail 'strict upgrade order is wrong'
pass 'strict upgrade restarts Proxy before HCC and Host'

: >"$FAKE_LOG"
FAKE_SCENARIO=hosts-legacy FAKE_HCC_PROTOCOL=legacy-headers FAKE_LOG="$FAKE_LOG" \
  KUBECTL_BIN="$FAKE_KUBECTL" bash "$ROLLOUT" restart-targets --context fixture-context \
    --restart-proxy --restart-hcc --restart-host chatllm --timeout-seconds 2 >/dev/null ||
  fail 'legacy ordered restart failed'
hcc_line="$(grep -nF 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG" | cut -d: -f1)"
host_line="$(grep -nF 'rollout restart deployment/chatllm -n mcp-host' "$FAKE_LOG" | cut -d: -f1)"
proxy_line="$(grep -nF 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" | cut -d: -f1)"
[[ "$hcc_line" -lt "$host_line" && "$host_line" -lt "$proxy_line" ]] || fail 'legacy transition order is wrong'
pass 'legacy rollback restarts HCC/Hosts before Proxy'

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
    --to-hcc-revision 4 --to-proxy-revision 7 --timeout-seconds 2 >/dev/null ||
  fail 'compatible Host cohort did not permit Proxy rollback'
hcc_undo_line="$(grep -nF 'rollout undo deployment/host-context-controller -n control-plane' "$FAKE_LOG" | cut -d: -f1)"
proxy_undo_line="$(grep -nF 'rollout undo deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" | cut -d: -f1)"
[[ "$hcc_undo_line" -lt "$proxy_undo_line" ]] || fail 'Proxy rollback preceded HCC rollback'
pass 'Proxy rollback is admitted only after HCC/Host compatibility is proven'

echo 'PASS: RPC Proxy edge rollout contract'
