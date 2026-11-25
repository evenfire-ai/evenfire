#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROLLOUT="${ROOT}/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
FAKE_KUBECTL="${TMP}/kubectl"
FAKE_LOG="${TMP}/kubectl.log"

cat >"$FAKE_KUBECTL" <<'FAKE_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
args="$*"
[[ "$args" == *'--context=fixture-context'* ]] || exit 91
printf '%s\n' "$args" >>"${FAKE_LOG}"
case "$args" in
  *'get deployment host-context-controller '* )
    printf '%s\n' '{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"legacy-headers"}]}]}}}}'
    ;;
  *'get deployments -n control-plane '* ) printf '%s\n' host-context-controller api-worker ;;
  *'get deployments -n mcp-host '* ) echo chatllm ;;
  *'get deployments -n mcp-server '* ) echo mcp-server ;;
  *'get deployments -n profiles '* ) echo external-rest-api ;;
  *'get deployments -n rpc-proxy '* ) echo rpc-proxy ;;
  *'get deployments -n channels '* ) echo channel-reader ;;
  *'rollout restart '*|*'rollout status '* ) ;;
  * ) echo "unexpected kubectl invocation: $args" >&2; exit 92 ;;
esac
FAKE_KUBECTL
chmod +x "$FAKE_KUBECTL"

make_plan="$(make -n minikube-restart-all MINIKUBE_PROFILE=fixture-context)"
[[ "$make_plan" == *'--restart-all-non-edge --restart-proxy'* &&
   "$make_plan" == *'--restart-hcc --restart-all-hosts'* ]] || {
  echo 'FAIL: Makefile restart-all argv changed unexpectedly' >&2
  exit 1
}

FAKE_LOG="$FAKE_LOG" KUBECTL_BIN="$FAKE_KUBECTL" \
  bash "$ROLLOUT" restart-targets --context fixture-context --restart-all-non-edge
for expected in \
  'rollout restart deployment/api-worker -n control-plane' \
  'rollout restart deployment/mcp-server -n mcp-server' \
  'rollout restart deployment/external-rest-api -n profiles' \
  'rollout restart deployment/channel-reader -n channels'; do
  grep -Fq "$expected" "$FAKE_LOG" || {
    echo "FAIL: restart-all branch omitted $expected" >&2
    exit 1
  }
done
if grep -Fq 'rollout restart deployment/host-context-controller -n control-plane' "$FAKE_LOG" ||
   grep -Fq 'rollout restart deployment/rpc-proxy -n rpc-proxy' "$FAKE_LOG" ||
   grep -Fq 'rollout restart deployment/chatllm -n mcp-host' "$FAKE_LOG"; then
  echo 'FAIL: non-edge restart touched an edge-owned Deployment' >&2
  exit 1
fi
echo 'PASS: Make restart-all option parses and dispatches only non-edge restarts'
