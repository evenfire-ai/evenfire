#!/usr/bin/env bash
# Behaviour test for .agents/skills/evenfire-digitalocean-doks/scripts/api-egress-probe.sh
# against a stub kubectl (scripts/tests/fixtures/doks-stub-kubectl.sh).
set -uo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="${ROOT_DIR}/.agents/skills/evenfire-digitalocean-doks/scripts/api-egress-probe.sh"
STUB="${ROOT_DIR}/scripts/tests/fixtures/doks-stub-kubectl.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

[ -x "$PROBE" ] || { echo "FAIL: $PROBE missing or not executable" >&2; exit 1; }

# run_case <name> [VAR=value ...]: runs the probe, leaves $out, $err, $rc, $dir
run_case() {
  local name="$1"; shift
  dir="$work/$name"; mkdir -p "$dir"
  out="$dir/stdout"; err="$dir/stderr"
  env STUB_DIR="$dir" KUBECTL="$STUB" CONTEXT=test-ctx \
    PROBE_SLEEP=0 PROBE_RETRY_SLEEP=0 ATTEMPTS=2 "$@" \
    bash "$PROBE" >"$out" 2>"$err"
  rc=$?
}
expect_rc() { [ "$rc" -eq "$2" ] || fail "$1: exit $rc, want $2 ($(tail -1 "$err"))"; }
expect_out() { grep -qx "$2" "$out" || fail "$1: stdout lacks '$2'"; }
expect_ns_gone() { [ ! -f "$dir/ns" ] || fail "$1: probe namespace was not deleted"; }

run_case doks_expected
expect_rc doks_expected 0
expect_out doks_expected 'BASELINE=reach'
expect_out doks_expected 'DENY_ONLY=blocked'
expect_out doks_expected 'IPBLOCK_PATH=blocked'
expect_out doks_expected 'CNP_PATH=works'
expect_out doks_expected 'API_EGRESS_PATH=cnp'
expect_out doks_expected 'NODES_TESTED=2'
expect_ns_gone doks_expected
cnp_file="$(grep -l 'kind: CiliumNetworkPolicy' "$dir"/applied-*.yaml 2>/dev/null | head -1)"
if [ -z "$cnp_file" ]; then
  fail "doks_expected: no CiliumNetworkPolicy applied"
else
  grep -q 'kube-apiserver' "$cnp_file" || fail "doks_expected: CNP lacks toEntities kube-apiserver"
  grep -q 'toPorts' "$cnp_file" || fail "doks_expected: CNP egress has no toPorts"
fi
grep -q 'port: 53' "$dir"/applied-*.yaml && fail "doks_expected: probe applied a DNS allow policy (not needed when connecting by IP)"
# every pod x every target in the phases that pass (a failing phase may stop at
# the first unreachable target)
for p in baseline cnp; do
  for pod in probe-a probe-b; do
    for t in '10.0.0.1 443' '198.51.100.10 443'; do
      grep -q "^$p $pod $t\$" "$dir/exec.log" || fail "doks_expected: no $p-phase attempt from $pod to $t"
    done
  done
done
# blocked only after all ATTEMPTS
n_ipblock="$(grep -c '^ipblock probe-a 10.0.0.1 443$' "$dir/exec.log")"
[ "$n_ipblock" -eq 2 ] || fail "doks_expected: ipblock phase tried $n_ipblock times, want ATTEMPTS=2"

run_case ipblock_works STUB_IPBLOCK_RC=0
expect_rc ipblock_works 0
expect_out ipblock_works 'IPBLOCK_PATH=works'
expect_out ipblock_works 'API_EGRESS_PATH=cnp'

grep -q '^delete networkpolicy allow-api-ipblock$' "$work/doks_expected/exec.log" \
  || fail "doks_expected: ipBlock policy not removed before the CNP phase"
grep -q '^cnp+ipblock ' "$work/doks_expected/exec.log" \
  && fail "doks_expected: CNP phase measured with the ipBlock policy still present"

run_case ipblock_only STUB_IPBLOCK_RC=0 STUB_CNP_RC=1
expect_rc ipblock_only 0
expect_out ipblock_only 'CNP_PATH=blocked'
expect_out ipblock_only 'API_EGRESS_PATH=ipblock'

run_case neither_path_works STUB_CNP_RC=1
expect_rc neither_path_works 1
expect_out neither_path_works 'API_EGRESS_PATH=none'
expect_ns_gone neither_path_works

run_case no_crd STUB_CRD_RC=1
expect_rc no_crd 1
expect_out no_crd 'CNP_PATH=no-crd'
grep -q 'kind: CiliumNetworkPolicy' "$dir"/applied-*.yaml && fail "no_crd: applied a CNP without the CRD"

run_case partial_reach STUB_API_EP='198.51.100.10 198.51.100.11' STUB_CNP_BLOCK_IPS=198.51.100.11
expect_rc partial_reach 1
expect_out partial_reach 'CNP_PATH=blocked'
expect_out partial_reach 'API_IPS=10.0.0.1 198.51.100.10 198.51.100.11'

run_case nonstandard_port STUB_API_PORT=6443
expect_rc nonstandard_port 0
grep -q '^cnp probe-a 198.51.100.10 6443$' "$dir/exec.log" || fail "nonstandard_port: endpoint not probed on its EndpointSlice port"
grep -q '^cnp probe-a 10.0.0.1 443$' "$dir/exec.log" || fail "nonstandard_port: ClusterIP not probed on 443"
grep -q '"6443"' "$dir"/applied-*.yaml || fail "nonstandard_port: CNP toPorts does not include the endpoint port"

run_case mixed_ports STUB_API_PORT='443 6443'
expect_rc mixed_ports 2

run_case baseline_blocked STUB_BASELINE_RC=1
expect_rc baseline_blocked 2
expect_ns_gone baseline_blocked

run_case deny_not_enforced STUB_DENY_RC=0
expect_rc deny_not_enforced 2
expect_out deny_not_enforced 'DENY_ONLY=reach'
expect_out deny_not_enforced 'API_EGRESS_PATH=none'
expect_ns_gone deny_not_enforced

run_case single_node STUB_NODES='probe-a node-1\nprobe-b node-1'
expect_rc single_node 0
expect_out single_node 'NODES_TESTED=1'
grep -q 'cross-node case not tested' "$err" || fail "single_node: no cross-node warning"

dir="$work/existing_ns"; mkdir -p "$dir"; touch "$dir/ns"
env STUB_DIR="$dir" KUBECTL="$STUB" CONTEXT=test-ctx PROBE_SLEEP=0 PROBE_RETRY_SLEEP=0 \
  bash "$PROBE" >/dev/null 2>&1
rc=$?
expect_rc existing_ns 2
[ -f "$dir/ns" ] || fail "existing_ns: probe deleted a namespace it did not create"
ls "$dir"/applied-*.yaml >/dev/null 2>&1 && fail "existing_ns: probe applied objects into an existing namespace"

if env -u CONTEXT bash "$PROBE" >/dev/null 2>&1; then fail "missing CONTEXT accepted"; fi

# Every kubectl call must go through the k() wrapper so the context is pinned.
if grep -vE '^[[:space:]]*#' "$PROBE" | grep -nE '(^|[^A-Za-z_:-])kubectl[[:space:]]' >/dev/null; then
  fail "probe calls kubectl outside the k() wrapper"
fi

if [ "$fails" -ne 0 ]; then
  echo "test-doks-api-egress-probe: $fails failure(s)" >&2
  exit 1
fi
echo "test-doks-api-egress-probe: OK"
