#!/usr/bin/env bash
# Stub kubectl for scripts/tests/test-doks-api-egress-probe.sh.
#
# Keeps cluster state as files in $STUB_DIR and answers only the calls
# api-egress-probe.sh makes. Connectivity from `exec … nc <ip> <port>` is
# decided by which policies are present (Cilium unions allow rules):
#   no deny-all-egress            -> $STUB_BASELINE_RC (default 0)
#   deny-all only                 -> $STUB_DENY_RC (default 1)
#   deny-all: reachable if the ipBlock policy is present and $STUB_IPBLOCK_RC
#   is 0 (default 1), or the CNP is present and $STUB_CNP_RC is 0 (default 0)
#   and the IP is not listed in $STUB_CNP_BLOCK_IPS.
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
  if [ -f "$STUB_DIR/cnp" ] && [ -f "$STUB_DIR/ipblock" ]; then echo cnp+ipblock
  elif [ -f "$STUB_DIR/cnp" ]; then echo cnp
  elif [ -f "$STUB_DIR/ipblock" ]; then echo ipblock
  elif [ -f "$STUB_DIR/denyall" ]; then echo deny
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
  "delete networkpolicy")
    [ "${3:-}" = allow-api-ipblock ] && rm -f "$STUB_DIR/ipblock"
    printf 'delete networkpolicy %s\n' "${3:-}" >>"$STUB_DIR/exec.log" ;;
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
    grep -q 'name: allow-api-ipblock' "$f" && touch "$STUB_DIR/ipblock"
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
    [ "$p" = baseline ] && exit "${STUB_BASELINE_RC:-0}"
    if [ -f "$STUB_DIR/ipblock" ] && [ "${STUB_IPBLOCK_RC:-1}" = 0 ]; then exit 0; fi
    if [ -f "$STUB_DIR/cnp" ] && [ "${STUB_CNP_RC:-0}" = 0 ]; then
      for b in ${STUB_CNP_BLOCK_IPS:-}; do [ "$b" = "$ip" ] && exit 1; done
      exit 0
    fi
    if [ ! -f "$STUB_DIR/ipblock" ] && [ ! -f "$STUB_DIR/cnp" ]; then exit "${STUB_DENY_RC:-1}"; fi
    exit 1 ;;
  *)
    echo "doks-stub-kubectl: unexpected call: $*" >&2
    exit 99 ;;
esac
