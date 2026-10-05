#!/usr/bin/env bash
# Stub kubectl for scripts/tests/test-doks-api-egress-probe.sh.
#
# Keeps cluster state as files in $STUB_DIR and answers only the calls
# api-egress-probe.sh makes. Connectivity from `exec … nc <ip> <port>` is
# decided by which policies have been applied:
#   no deny-all-egress applied    -> $STUB_BASELINE_RC (default 0)
#   deny-all + ipBlock, no CNP    -> $STUB_IPBLOCK_RC  (default 1)
#   CiliumNetworkPolicy applied   -> $STUB_CNP_RC      (default 0), except IPs
#                                    listed in $STUB_CNP_BLOCK_IPS (return 1)
# Every exec is logged to $STUB_DIR/exec.log as "<phase> <pod> <ip> <port>".
set -uo pipefail

: "${STUB_DIR:?set STUB_DIR}"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --context) shift 2 ;;
    -n) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"
joined=" $* "

phase() {
  if [ -f "$STUB_DIR/cnp" ]; then echo cnp
  elif [ -f "$STUB_DIR/denyall" ]; then echo ipblock
  else echo baseline
  fi
}

case "$1 ${2:-}" in
  "get namespace")
    [ -f "$STUB_DIR/ns" ] ;;
  "create namespace")
    touch "$STUB_DIR/ns" ;;
  "delete namespace")
    rm -f "$STUB_DIR/ns" ;;
  "get service")
    printf '%s' "${STUB_API_CLUSTERIP:-10.0.0.1}" ;;
  "get endpointslices")
    if [[ "$joined" == *ports* ]]; then
      printf '%s' "${STUB_API_PORT:-443}"
    else
      printf '%s' "${STUB_API_EP:-198.51.100.10}"
    fi ;;
  "get crd")
    exit "${STUB_CRD_RC:-0}" ;;
  "apply -f")
    n=$(find "$STUB_DIR" -maxdepth 1 -name 'applied-*.yaml' | wc -l | tr -d ' ')
    f="$STUB_DIR/applied-$n.yaml"
    cat >"$f"
    grep -q 'name: deny-all-egress' "$f" && touch "$STUB_DIR/denyall"
    grep -q 'kind: CiliumNetworkPolicy' "$f" && touch "$STUB_DIR/cnp"
    exit 0 ;;
  "rollout status")
    exit 0 ;;
  "get pods")
    printf '%b\n' "${STUB_NODES:-probe-a node-1\nprobe-b node-2}" ;;
  "exec "*)
    pod="$2"
    # … -- timeout 5 nc -w 3 <ip> <port>
    port="${!#}"
    ip="${*: -2:1}"
    p="$(phase)"
    printf '%s %s %s %s\n' "$p" "$pod" "$ip" "$port" >>"$STUB_DIR/exec.log"
    case "$p" in
      baseline) exit "${STUB_BASELINE_RC:-0}" ;;
      ipblock) exit "${STUB_IPBLOCK_RC:-1}" ;;
      cnp)
        for b in ${STUB_CNP_BLOCK_IPS:-}; do [ "$b" = "$ip" ] && exit 1; done
        exit "${STUB_CNP_RC:-0}" ;;
    esac ;;
  *)
    echo "doks-stub-kubectl: unexpected call: $*" >&2
    exit 99 ;;
esac
