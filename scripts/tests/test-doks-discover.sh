#!/usr/bin/env bash
# Behaviour test for .agents/skills/evenfire-digitalocean-doks/scripts/doks-discover.sh
# against stub doctl and kubectl.
set -uo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DISCOVER="${ROOT_DIR}/.agents/skills/evenfire-digitalocean-doks/scripts/doks-discover.sh"
FIX="${ROOT_DIR}/scripts/tests/fixtures"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

[ -x "$DISCOVER" ] || { echo "FAIL: $DISCOVER missing or not executable" >&2; exit 1; }

printf '{"email":"someone@example.test","status":"active","team":{"name":"Example Team","uuid":"t-1"}}' >"$work/account.json"
cluster_json() { # version ha-json-fragment status cluster_subnet
  printf '[{"id":"c-1","name":"test-cluster","region":"fra1","version":"%s",%s"cluster_subnet":"%s","service_subnet":"%s","status":{"state":"%s"},"surge_upgrade":true}]' \
    "$1" "$2" "$4" "$5" "$3"
}

run_case() { # name cluster-json-file [VAR=value ...]
  local name="$1" cj="$2"; shift 2
  dir="$work/$name"; mkdir -p "$dir"
  out="$dir/out"; err="$dir/err"
  env STUB_DIR="$dir" STUB_ACCOUNT_JSON="$work/account.json" STUB_CLUSTER_JSON="$cj" \
    DOCTL="$FIX/doks-stub-doctl.sh" KUBECTL="$FIX/doks-stub-kubectl-discover.sh" \
    DOCTL_CONTEXT=t-ctx CLUSTER_NAME=test-cluster CONTEXT=do-fra1-test-cluster "$@" \
    bash "$DISCOVER" >"$out" 2>"$err"
  rc=$?
}
want() { grep -qx "$2" "$out" || fail "$1: stdout lacks '$2' (got: $(tr '\n' ' ' <"$out"))"; }
stop() { [ "$rc" -ne 0 ] && grep -q 'STOP' "$err" || fail "$1: expected STOP, rc=$rc err=$(cat "$err")"; }

cluster_json 1.36.3-do.5 '"ha":true,' running 10.200.0.0/16 10.201.0.0/19 >"$work/happy.json"
run_case happy "$work/happy.json"
[ "$rc" -eq 0 ] || fail "happy: rc=$rc err=$(cat "$err")"
want happy 'ACCOUNT_TEAM=Example Team'
want happy 'CLUSTER_ID=c-1'
want happy 'VERSION=1.36.3-do.5'
want happy 'HA=true'
want happy 'AUTO_UPGRADE=false'
want happy 'SURGE_UPGRADE=true'
want happy 'VPC_NATIVE=yes'
want happy 'API_IPS=10.201.0.1 10.114.0.2'
want happy 'API_ENDPOINT_PORT=443'
want happy 'DNS_IP=10.201.0.10'
want happy 'NODELOCAL_DNS_IP='
want happy 'DEFAULT_SC=do-block-storage'
want happy 'RETAIN_SC_PRESENT=yes'
want happy 'CNP_CRD=yes'
want happy 'CILIUM_POLICY_CIDR_MATCH_MODE=unset'
want happy 'CILIUM_IMAGE=ghcr.io/digitalocean-packages/cilium:v1.19.3'
want happy 'DO_CCNPS=deny-imds-egress'
want happy 'LB_DEFAULT=REGIONAL_NETWORK'

cluster_json 1.36.3-do.5 '' running 10.200.0.0/16 10.201.0.0/19 >"$work/nobool.json"
run_case missing_bool_keys "$work/nobool.json"
[ "$rc" -eq 0 ] || fail "missing_bool_keys: rc=$rc err=$(cat "$err")"
want missing_bool_keys 'HA=false'
want missing_bool_keys 'AUTO_UPGRADE=false'

cluster_json 1.35.7-do.5 '' running '' '' >"$work/legacy.json"
run_case not_vpc_native "$work/legacy.json"
want not_vpc_native 'VPC_NATIVE=no'

for v in '1.33.0-do.2 REGIONAL' '1.33.1-do.0 REGIONAL_NETWORK' '1.32.9-do.4 REGIONAL' '1.36.3-do.1 REGIONAL_NETWORK' '1.33.10-do.0 REGIONAL_NETWORK'; do
  set -- $v
  cluster_json "$1" '' running 10.200.0.0/16 10.201.0.0/19 >"$work/lb.json"
  run_case "lb_default_$1" "$work/lb.json"
  [ "$rc" -eq 0 ] || fail "lb_default $1: rc=$rc (an old version must not STOP)"
  want "lb_default_$1" "LB_DEFAULT=$2"
done

run_case ipv6_endpoint "$work/happy.json" STUB_API_EP=fd00::2
stop ipv6_endpoint
run_case no_default_sc "$work/happy.json" STUB_NO_DEFAULT_SC=1
stop no_default_sc
cluster_json 1.36.3-do.5 '' provisioning 10.200.0.0/16 10.201.0.0/19 >"$work/prov.json"
run_case not_running "$work/prov.json"
stop not_running
run_case nodelocal "$work/happy.json" STUB_NODELOCAL_RC=0
stop nodelocal

# Pinning: every doctl call carries --context t-ctx, none switches context;
# every kubectl call carries --context do-fra1-test-cluster and is read-only.
run_case pinned "$work/happy.json"
grep -v -- '--context t-ctx' "$dir/doctl.log" | grep -q . && fail "pinned: doctl call without --context t-ctx"
grep -q 'auth switch' "$dir/doctl.log" && fail "pinned: doctl auth switch used"
grep -v -- '--context do-fra1-test-cluster' "$dir/kubectl.log" | grep -q . && fail "pinned: kubectl call without --context"
grep -vE '(^| )get ' "$dir/kubectl.log" | grep -q . && fail "pinned: non-get kubectl call: $(grep -vE '(^| )get ' "$dir/kubectl.log" | head -1)"

if env -u DOCTL_CONTEXT CLUSTER_NAME=x CONTEXT=y bash "$DISCOVER" >/dev/null 2>&1; then fail "missing DOCTL_CONTEXT accepted"; fi

if [ "$fails" -ne 0 ]; then
  echo "test-doks-discover: $fails failure(s)" >&2
  exit 1
fi
echo "test-doks-discover: OK"
