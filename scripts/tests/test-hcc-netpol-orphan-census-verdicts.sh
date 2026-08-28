#!/usr/bin/env bash
# Executable, cluster-free verdict tests for the HCC NetworkPolicy orphan
# census (#495 / #484). Fixtures + SAMPLE_GAP_SEC=0 — never a 90s sleep,
# never a real cluster. Proves membership and adjudication, not a live CLEAN.
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GENERIC="${ROOT}/scripts/ops/hcc-netpol-orphan-census.sh"
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

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/hcc-census-verdicts.XXXXXX")"
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
  key=""
  if [[ "$output" == *'@.name=="'* ]]; then
    key="${output#*@.name==\"}"
    key="${key%%\"*}"
  fi
  varname="STUB_ENV_${key}"
  printf '%s' "${!varname-}"
  exit 0
fi
if [ "$resource" = namespaces ]; then
  echo "namespace/${name}"
  exit 0
fi
if [ "$resource" = contexts.clerum.io ]; then
  count_file="${CENSUS_STUB_DIR:?}/call-count-contexts"
  n=0
  if [ -f "$count_file" ]; then
    n="$(cat "$count_file")"
  fi
  n=$((n + 1))
  printf '%s\n' "$n" >"$count_file"
  if [ "$n" -ge 2 ] && [ -n "${STUB_CONTEXTS_FIXTURE_2:-}" ]; then
    cat "${STUB_CONTEXTS_FIXTURE_2}"
  else
    cat "${STUB_CONTEXTS_FIXTURE:?}"
  fi
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
    rpc-proxy) cat "${STUB_NP_RPC_FIXTURE:?}" ;;
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
printf '%s\n' '{"items":[{"spec":{"contextId":"ctx-alpha"}},{"spec":{"contextId":"ctx-extra"}}]}' >"${WORKDIR}/contexts-churn.json"
printf '%s\n' '{"items":[{"metadata":{"name":"srv-a"}}]}' >"${WORKDIR}/servers.json"
printf '%s\n' '{"items":[]}' >"${WORKDIR}/empty-np.json"

# V1: HCC member + foreign typed policy shaped as a pre-#484 orphan.
jq -n '{
  items: [
    {
      metadata: {
        uid: "uid-member",
        namespace: "mcp-server",
        name: "ctx-alpha-allow",
        labels: {
          "clerum.io/managed-by": "host-context-controller",
          "clerum.io/policy-type": "context-allow",
          "clerum.io/context": "ctx-alpha"
        }
      }
    },
    {
      metadata: {
        uid: "uid-foreign",
        namespace: "mcp-server",
        name: "ctx-ghost-allow",
        labels: {
          "clerum.io/managed-by": "someone-else",
          "clerum.io/policy-type": "context-allow",
          "clerum.io/context": "ctx-ghost"
        }
      }
    }
  ]
}' >"${WORKDIR}/np-v1.json"

# V4: member + typed orphan + untyped repairable orphan.
jq -n '{
  items: [
    {
      metadata: {
        uid: "uid-member",
        namespace: "mcp-server",
        name: "ctx-alpha-allow",
        labels: {
          "clerum.io/managed-by": "host-context-controller",
          "clerum.io/policy-type": "context-allow",
          "clerum.io/context": "ctx-alpha"
        }
      }
    },
    {
      metadata: {
        uid: "uid-typed-orphan",
        namespace: "mcp-server",
        name: "ctx-gone-allow",
        labels: {
          "clerum.io/managed-by": "host-context-controller",
          "clerum.io/policy-type": "context-allow",
          "clerum.io/context": "ctx-gone"
        }
      }
    },
    {
      metadata: {
        uid: "uid-repairable",
        namespace: "mcp-server",
        name: "ctx-orphaned-thing",
        labels: {
          "clerum.io/managed-by": "host-context-controller"
        }
      }
    }
  ]
}' >"${WORKDIR}/np-v4.json"

# V5: 1 member + 11 typed orphans (listed=12, orphans=11 > compiled abs 10).
jq -n '
  {
    items: (
      [range(0; 11) | {
        metadata: {
          uid: ("uid-orphan-" + tostring),
          namespace: "mcp-server",
          name: ("ctx-gone-allow-" + tostring),
          labels: {
            "clerum.io/managed-by": "host-context-controller",
            "clerum.io/policy-type": "context-allow",
            "clerum.io/context": "ctx-gone"
          }
        }
      }]
      + [{
        metadata: {
          uid: "uid-member",
          namespace: "mcp-server",
          name: "ctx-alpha-allow",
          labels: {
            "clerum.io/managed-by": "host-context-controller",
            "clerum.io/policy-type": "context-allow",
            "clerum.io/context": "ctx-alpha"
          }
        }
      }]
    )
  }
' >"${WORKDIR}/np-v5.json"

run_census() {
  : >"$CASE_LOG"
  rm -f "${WORKDIR}/call-count-contexts"
  OUT="$(
    env -i \
      HOME="$HOME" \
      TMPDIR="$WORKDIR" \
      KUBECONFIG="$FAKE_KUBECONFIG" \
      PATH="${STUB_BIN}:${PATH}" \
      CENSUS_STUB_LOG="$CASE_LOG" \
      CENSUS_STUB_DIR="$WORKDIR" \
      SAMPLE_GAP_SEC=0 \
      CONTEXT="$TEST_CTX" \
      STUB_ENV_CONTEXT_MAPPER_NAMESPACE="$MAPPER_NS" \
      STUB_ENV_CONTEXT_MAPPER_HOST_NAMESPACE="$HOST_NS" \
      STUB_CONTEXTS_FIXTURE="${WORKDIR}/contexts.json" \
      STUB_SERVERS_FIXTURE="${WORKDIR}/servers.json" \
      STUB_NP_MAPPER_FIXTURE="${WORKDIR}/empty-np.json" \
      STUB_NP_HOST_FIXTURE="${WORKDIR}/empty-np.json" \
      STUB_NP_RPC_FIXTURE="${WORKDIR}/empty-np.json" \
      "$@" \
      bash "$GENERIC" 2>&1
  )"
  RC=$?
  cat "$CASE_LOG" >>"$ALL_LOG"
}

# V1
run_census STUB_NP_MAPPER_FIXTURE="${WORKDIR}/np-v1.json"
if [ "$RC" -ne 0 ]; then
  fail "foreign-owned typed policy is excluded — exit ${RC}; got: $(head -c 400 <<<"$OUT")"
elif ! grep -Fq 'listed_managed=1' <<<"$OUT" || ! grep -Fq 'orphan_count=0' <<<"$OUT"; then
  fail "foreign-owned typed policy is excluded — listed/orphan mismatch; got: $(head -c 400 <<<"$OUT")"
elif ! grep -Fq 'VERDICT=CLEAN' <<<"$OUT"; then
  fail "foreign-owned typed policy is excluded — missing CLEAN"
else
  pass "foreign-owned typed policy is excluded from listed and orphans (#484)"
fi

# V2
run_census
if [ "$RC" -ne 4 ]; then
  fail "zero managed policies is INCONCLUSIVE_EMPTY — exit ${RC}, want 4"
elif ! grep -Fq 'VERDICT=INCONCLUSIVE_EMPTY' <<<"$OUT"; then
  fail "zero managed policies is INCONCLUSIVE_EMPTY — missing verdict"
elif ! grep -Fq '"found nothing" is not CLEAN' <<<"$OUT"; then
  fail "zero managed policies is INCONCLUSIVE_EMPTY — missing found-nothing needle"
elif grep -Fq 'VERDICT=CLEAN' <<<"$OUT"; then
  fail "zero managed policies is INCONCLUSIVE_EMPTY — printed CLEAN"
else
  pass "zero managed policies is INCONCLUSIVE_EMPTY, never CLEAN"
fi

# V3
run_census STUB_CONTEXTS_FIXTURE_2="${WORKDIR}/contexts-churn.json" \
  STUB_NP_MAPPER_FIXTURE="${WORKDIR}/np-v1.json"
if [ "$RC" -ne 3 ]; then
  fail "desired-set churn is INCONCLUSIVE_RERUN — exit ${RC}, want 3"
elif ! grep -Fq 'VERDICT=INCONCLUSIVE_RERUN' <<<"$OUT"; then
  fail "desired-set churn is INCONCLUSIVE_RERUN — missing verdict"
elif ! grep -Fq 'desired Context+McpServer set changed between samples' <<<"$OUT"; then
  fail "desired-set churn is INCONCLUSIVE_RERUN — missing change needle"
else
  pass "desired-set churn between samples is INCONCLUSIVE_RERUN"
fi

# V4
run_census STUB_NP_MAPPER_FIXTURE="${WORKDIR}/np-v4.json"
if [ "$RC" -ne 0 ]; then
  fail "genuine orphan and untyped-repairable are counted — exit ${RC}"
elif ! grep -Fq 'listed_managed=3' <<<"$OUT" ||
  ! grep -Fq 'repairable_untyped=1' <<<"$OUT" ||
  ! grep -Fq 'orphan_count=2' <<<"$OUT"; then
  fail "genuine orphan and untyped-repairable are counted — counters mismatch; got: $(head -c 500 <<<"$OUT")"
elif ! grep -Fq 'VERDICT=ORPHANS_PRESENT' <<<"$OUT"; then
  fail "genuine orphan and untyped-repairable are counted — missing ORPHANS_PRESENT"
elif ! grep -Fq $'mcp-server\tctx-gone-allow\tcontext-allow' <<<"$OUT" ||
  ! grep -Fq $'mcp-server\tctx-orphaned-thing\trepairable-untyped' <<<"$OUT"; then
  fail "genuine orphan and untyped-repairable are counted — TSV lines missing; got: $(head -c 500 <<<"$OUT")"
else
  pass "genuine orphan and untyped-repairable are counted and reported"
fi

# V5
run_census STUB_NP_MAPPER_FIXTURE="${WORKDIR}/np-v5.json"
if [ "$RC" -ne 0 ]; then
  fail "cap two-tier UNSET vs compiled — exit ${RC}"
elif ! grep -Fq 'live_cap_would_trip=UNSET' <<<"$OUT"; then
  fail "cap two-tier UNSET vs compiled — live cap is not UNSET; got: $(grep live_cap <<<"$OUT")"
elif grep -Fq 'live_cap_would_trip=none' <<<"$OUT"; then
  fail "cap two-tier UNSET vs compiled — live cap collapsed to none"
elif ! grep -Fq 'controller_cap_would_trip=absolute' <<<"$OUT"; then
  fail "cap two-tier UNSET vs compiled — controller trip is not absolute"
elif ! grep -Fq 'compiled_default_absolute=10 compiled_default_percent=20' <<<"$OUT"; then
  fail "cap two-tier UNSET vs compiled — compiled defaults line missing"
elif ! grep -Fq 'VERDICT=ORPHANS_PRESENT' <<<"$OUT"; then
  fail "cap two-tier UNSET vs compiled — missing ORPHANS_PRESENT"
else
  pass "cap two-tier: UNSET live caps report UNSET, controller trip uses compiled defaults"
fi

# V6
v6_start="$(date +%s)"
run_census STUB_NP_MAPPER_FIXTURE="${WORKDIR}/np-v1.json"
v6_elapsed=$(($(date +%s) - v6_start))
if ! grep -Fq 'waiting 0s for second sample' <<<"$OUT"; then
  fail "SAMPLE_GAP_SEC is honored — missing waiting 0s needle"
elif [ "$v6_elapsed" -gt 60 ]; then
  fail "SAMPLE_GAP_SEC is honored — run took ${v6_elapsed}s (hardcoded sleep?)"
else
  pass "SAMPLE_GAP_SEC is honored (no fixed 90s sleep)"
fi

if grep -Eq '(^|[[:space:]])(set|delete|apply|patch|rollout|scale|create|replace|annotate|label|exec|drain|edit|expose)([[:space:]]|$)' "$ALL_LOG"; then
  fail "census stayed read-only — mutating verb recorded"
else
  pass "fake kubectl saw only get verbs (no mutation)"
fi

exit "$FAIL"
