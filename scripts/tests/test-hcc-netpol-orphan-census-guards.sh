#!/usr/bin/env bash
# Executable, cluster-free guard tests for the HCC NetworkPolicy orphan census
# (#495). Proves the route (argv, fail-loud ordering, wrapper CONTEXT pin),
# not a live CLEAN destination. Never contacts a real cluster.
#
# Sibling: test-hcc-netpol-orphan-census-verdicts.sh (adjudication).
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GENERIC="${ROOT}/scripts/ops/hcc-netpol-orphan-census.sh"
WRAPPER="${ROOT}/scripts/ops/hcc-netpol-orphan-census-clerum-dev.sh"
PLACEHOLDER='gke_your-gcp-project_us-central1-a_example-dev'
TEST_CTX='census-hermetic-ctx'
MAPPER_NS='mcp-server'
HOST_NS='mcp-host'

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

command -v jq >/dev/null 2>&1 || {
  echo "FAIL: this harness requires jq on PATH" >&2
  exit 1
}

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/hcc-census-guards.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
FAKE_KUBECONFIG="${WORKDIR}/empty-kubeconfig"
: >"$FAKE_KUBECONFIG"
STUB_BIN="${WORKDIR}/stub-bin"
mkdir -p "$STUB_BIN"
ALL_LOG="${WORKDIR}/all-kubectl.log"
: >"$ALL_LOG"
CASE_LOG="${WORKDIR}/kubectl.log"

cat >"${STUB_BIN}/kubectl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${CENSUS_STUB_LOG:?}"
ctx=""
ns=""
output=""
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --context) ctx="$2"; shift 2 ;;
    --context=*) ctx="${1#--context=}"; shift ;;
    -n|--namespace) ns="$2"; shift 2 ;;
    -n=*|--namespace=*) ns="${1#*=}"; shift ;;
    -o|--output) output="$2"; shift 2 ;;
    -o=*|--output=*) output="${1#*=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
verb="${args[0]:-}"
resource="${args[1]:-}"
name="${args[2]:-}"
case "$verb" in
  set|delete|apply|patch|rollout|scale|create|replace|annotate|label|exec|drain|edit|expose|autoscale|cordon|uncordon|taint)
    echo "fake-kubectl: refusing mutating verb ${verb}" >&2
    exit 2
    ;;
esac
if [ "$verb" != get ]; then
  echo "fake-kubectl: unexpected invocation verb=${verb} argv=${args[*]}" >&2
  exit 2
fi
if [ "$resource" = deployments ]; then
  if [ "${STUB_FAIL_ENV_READ:-0}" = 1 ]; then
    exit 1
  fi
  key=""
  if [[ "$output" == *'@.name=="'* ]]; then
    key="${output#*@.name==\"}"
    key="${key%%\"*}"
  fi
  varname="STUB_ENV_${key}"
  printf '%s' "${!varname-}"
  exit 0
fi
if [ "$resource" = deploy ]; then
  echo "fake-kubectl: unexpected invocation resource=deploy (want deployments)" >&2
  exit 2
fi
if [ "$resource" = namespaces ]; then
  if [ -n "${STUB_MISSING_NS:-}" ] && [ "$name" = "$STUB_MISSING_NS" ]; then
    echo "Error from server (NotFound): namespaces \"${name}\" not found" >&2
    exit 1
  fi
  echo "namespace/${name}"
  exit 0
fi
if [ "$resource" = contexts.clerum.io ]; then
  cat "${STUB_CONTEXTS_FIXTURE:?}"
  exit 0
fi
if [ "$resource" = mcpservers.clerum.io ]; then
  cat "${STUB_SERVERS_FIXTURE:?}"
  exit 0
fi
if [ "$resource" = networkpolicy ] || [ "$resource" = networkpolicies ]; then
  case "$ns" in
    "${STUB_ENV_CONTEXT_MAPPER_NAMESPACE:-mcp-server}") cat "${STUB_NP_MAPPER_FIXTURE:?}" ;;
    "${STUB_ENV_CONTEXT_MAPPER_HOST_NAMESPACE:-mcp-host}") cat "${STUB_NP_HOST_FIXTURE:?}" ;;
    rpc-proxy|"${STUB_ENV_CONTEXT_MAPPER_RPC_PROXY_NAMESPACE:-}") cat "${STUB_NP_RPC_FIXTURE:?}" ;;
    *)
      echo "fake-kubectl: unexpected networkpolicy namespace ${ns}" >&2
      exit 2
      ;;
  esac
  exit 0
fi
echo "fake-kubectl: unexpected invocation ctx=${ctx} argv=${args[*]}" >&2
exit 2
STUB
chmod +x "${STUB_BIN}/kubectl"

printf '%s\n' '{"items":[{"spec":{"contextId":"ctx-alpha"}}]}' >"${WORKDIR}/contexts.json"
printf '%s\n' '{"items":[{"metadata":{"name":"srv-a"}}]}' >"${WORKDIR}/servers.json"
printf '%s\n' '{"items":[]}' >"${WORKDIR}/empty-np.json"

run_census() {
  local script="$1"
  shift
  : >"$CASE_LOG"
  OUT="$(
    env -i \
      HOME="$HOME" \
      TMPDIR="$WORKDIR" \
      KUBECONFIG="$FAKE_KUBECONFIG" \
      PATH="${STUB_BIN}:${PATH}" \
      CENSUS_STUB_LOG="$CASE_LOG" \
      SAMPLE_GAP_SEC=0 \
      STUB_ENV_CONTEXT_MAPPER_NAMESPACE="$MAPPER_NS" \
      STUB_ENV_CONTEXT_MAPPER_HOST_NAMESPACE="$HOST_NS" \
      STUB_CONTEXTS_FIXTURE="${WORKDIR}/contexts.json" \
      STUB_SERVERS_FIXTURE="${WORKDIR}/servers.json" \
      STUB_NP_MAPPER_FIXTURE="${WORKDIR}/empty-np.json" \
      STUB_NP_HOST_FIXTURE="${WORKDIR}/empty-np.json" \
      STUB_NP_RPC_FIXTURE="${WORKDIR}/empty-np.json" \
      "$@" \
      bash "$script" 2>&1
  )"
  RC=$?
  cat "$CASE_LOG" >>"$ALL_LOG"
}

# G1
run_census "$GENERIC"
if [ "${RC:-0}" -eq 0 ]; then
  fail "refuses when CONTEXT is unset — exited 0"
elif ! grep -Fq 'must set CONTEXT' <<<"$OUT"; then
  fail "refuses when CONTEXT is unset — missing needle; got: $(head -c 300 <<<"$OUT")"
elif [ -s "$CASE_LOG" ]; then
  fail "refuses when CONTEXT is unset — kubectl ran before the guard"
else
  pass "refuses when CONTEXT is unset"
fi

# G2
run_census "$GENERIC" CONTEXT="$TEST_CTX"
if ! grep -Fq 'get deployments' "$CASE_LOG"; then
  fail "deployment read uses get deployments — log missing token; got: $(tr '\n' '|' <"$CASE_LOG")"
elif grep -Eq '(^|[[:space:]])get deploy([[:space:]]|$)' "$CASE_LOG"; then
  fail "deployment read uses get deployments — found abbreviated get deploy"
else
  pass "deployment read uses get deployments on the explicit context"
fi

# G3
run_census "$GENERIC" CONTEXT="$TEST_CTX" STUB_FAIL_ENV_READ=1
if [ "$RC" -ne 2 ]; then
  fail "kubectl failure reading Deployment env is FATAL — exit ${RC}, want 2"
elif ! grep -Fq 'FATAL: kubectl failed reading' <<<"$OUT"; then
  fail "kubectl failure reading Deployment env is FATAL — missing needle"
elif grep -Fq 'VERDICT=' <<<"$OUT"; then
  fail "kubectl failure reading Deployment env is FATAL — printed a verdict"
else
  pass "kubectl failure reading Deployment env is FATAL, not UNSET"
fi

# G4
run_census "$GENERIC" CONTEXT="$TEST_CTX" \
  STUB_ENV_CONTEXT_MAPPER_NAMESPACE= \
  STUB_ENV_CONTEXT_MAPPER_HOST_NAMESPACE=
if [ "$RC" -ne 2 ]; then
  fail "refuses UNSET mapper/host namespaces — exit ${RC}, want 2"
elif ! grep -Fq 'refusing to invent defaults' <<<"$OUT"; then
  fail "refuses UNSET mapper/host namespaces — missing needle"
elif grep -Fq 'contexts.clerum.io' "$CASE_LOG"; then
  fail "refuses UNSET mapper/host namespaces — sampled anyway"
else
  pass "refuses when mapper/host namespaces are UNSET on the Deployment"
fi

# G5
run_census "$GENERIC" CONTEXT="$TEST_CTX" STUB_MISSING_NS="$MAPPER_NS"
if [ "$RC" -ne 2 ]; then
  fail "missing namespace exits 2 — exit ${RC}, want 2"
elif ! grep -Fq 'refusing to sample an empty inventory' <<<"$OUT"; then
  fail "missing namespace exits 2 — missing FATAL needle"
elif grep -Fq 'VERDICT=' <<<"$OUT"; then
  fail "missing namespace exits 2 — printed a verdict"
elif grep -Fq 'contexts.clerum.io' "$CASE_LOG"; then
  fail "missing namespace exits 2 — sampled before refusing"
else
  pass "missing namespace exits 2 and NEVER prints VERDICT=CLEAN"
fi

# G6
run_census "$GENERIC" CONTEXT="$TEST_CTX"
if ! grep -Fq 'UNSET (controller applies compiled default: rpc-proxy)' <<<"$OUT"; then
  fail "UNSET rpc-proxy is two-tier — missing live label"
elif ! grep -Fq 'get networkpolicy -n rpc-proxy' "$CASE_LOG" &&
  ! grep -Fq 'get networkpolicy --namespace rpc-proxy' "$CASE_LOG" &&
  ! grep -Eq -- '-n rpc-proxy get networkpolicy|get networkpolicy -n rpc-proxy' "$CASE_LOG"; then
  # kubectl is invoked as: --context X -n rpc-proxy get networkpolicy -o json
  # logged as the raw argv string from $*.
  if ! grep -Fq -- '-n rpc-proxy' "$CASE_LOG" || ! grep -Fq 'networkpolicy' "$CASE_LOG"; then
    fail "UNSET rpc-proxy is two-tier — did not sample rpc-proxy; got: $(tr '\n' '|' <"$CASE_LOG")"
  else
    pass "UNSET rpc-proxy namespace is labelled two-tier and sampled with the compiled default"
  fi
else
  pass "UNSET rpc-proxy namespace is labelled two-tier and sampled with the compiled default"
fi

# G7
run_census "$WRAPPER" CONTEXT=gke_evil_inherited_ctx STUB_FAIL_ENV_READ=1
if ! grep -Fq -- "--context ${PLACEHOLDER}" "$CASE_LOG" &&
  ! grep -Fq -- "--context=${PLACEHOLDER}" "$CASE_LOG"; then
  fail "wrapper pins CONTEXT unconditionally — placeholder missing from argv; got: $(tr '\n' '|' <"$CASE_LOG")"
elif grep -Fq 'gke_evil_inherited_ctx' "$CASE_LOG" || grep -Fq 'gke_evil_inherited_ctx' <<<"$OUT"; then
  fail "wrapper pins CONTEXT unconditionally — hostile inherited context leaked"
else
  pass "wrapper pins CONTEXT unconditionally over a hostile inherited value"
fi

# G8
if grep -Fxq "CONTEXT=${PLACEHOLDER}" "$WRAPPER" &&
  ! grep -Eq 'CONTEXT=.*:-|\$\{CONTEXT:-' "$WRAPPER" &&
  grep -Eq 'exec .*hcc-netpol-orphan-census\.sh' "$WRAPPER"; then
  pass "wrapper source pins: unconditional assignment + exec of the generic census"
else
  fail "wrapper source pins — unconditional CONTEXT= or exec of the generic census is missing"
fi

if grep -Eq '(^|[[:space:]])(set|delete|apply|patch|rollout|scale|create|replace|annotate|label|exec|drain|edit|expose)([[:space:]]|$)' "$ALL_LOG"; then
  fail "census stayed read-only — mutating verb recorded; got: $(tr '\n' '|' <"$ALL_LOG")"
else
  pass "fake kubectl saw only get verbs (no mutation)"
fi

exit "$FAIL"
