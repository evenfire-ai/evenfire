#!/usr/bin/env bash
# Static contract for the branch-owned selective watch gate. Runtime behavior
# of the TLS fault is exercised by hcc-watch-api-proxy.test.mjs.
set -euo pipefail
# shellcheck disable=SC2034,SC2329 # Fixture globals/functions are consumed by the sourced helper.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-hcc-stateless-cache-containment.sh"
PROXY="${ROOT}/scripts/e2e/_lib/hcc-watch-api-proxy.mjs"
PROXY_TEST="${ROOT}/scripts/tests/hcc-watch-api-proxy.test.mjs"
HELPER="${ROOT}/scripts/e2e/_lib/hcc-watch-pr-a.sh"
MAKEFILE="${ROOT}/Makefile"
WORKFLOW="${ROOT}/.github/workflows/ci-public.yml"

bash -n "$GATE" "$HELPER" "$0"
node --check "$PROXY"
grep -Fq 'require_branch_owned_hcc_gate' "$GATE"
grep -Fq 'E2E_BRANCH_PROFILE_ENV' "$GATE"
grep -Fq 'E2E_PROFILE_PORTS_ENV' "$GATE"
grep -Fq 'profile_port_value CONTROL_API_URL' "$GATE"
grep -Fq 'acquire_hcc_watch_gate_lock' "$GATE"
# shellcheck disable=SC2016 # Match literal shell source.
grep -Fq 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' "$GATE"
grep -Fq 'hcc_pr_a_command hold-channel 60000' "$GATE"
grep -Fq 'hcc_pr_a_command release-channel' "$GATE"
grep -Fq 'wait_log_count '\''CommunicationChannel watch ended;' "$GATE"
grep -Fq 'CommunicationChannelCacheUnsynced' "$GATE"
# shellcheck disable=SC2016 # Match literal shell source.
grep -Fq 'host_runtime_is_always_on "$HOST_REF"' "$GATE"
grep -Fq 'jq -Sc '\''.spec.template' "$GATE"
grep -Fq 'baseline_pod' "$GATE"
grep -Fq 'CLERUM_SESSION_DB_DIR' "$GATE"
# shellcheck disable=SC2016 # Match literal shell source.
grep -Fq '/sessions/${HOST_REF}/${THREAD_ID}/messages' "$GATE"
grep -Fq '/sessions?agent=${HOST_REF}&limit=100' "$GATE"
grep -Fq 'session_visible || die "cycle' "$GATE"
grep -Fq 'session_listed || die "cycle' "$GATE"
grep -Fq '"host:wake:write"' "$GATE"
grep -Fq '/api/v1/rpc/hosts/${HOST_REF}/messages' "$GATE"
grep -Fq 'channel_hold_is_active' "$GATE"
[ "$(grep -Fc 'channel_hold_is_active "$HCC_PR_A_CHANNEL_HOLD_ID" ||' "$GATE")" -ge 6 ]
[ "$(grep -Fc 'hcc_pr_a_command hold-channel 60000' "$GATE")" -ge 2 ]
grep -Fq 'MAX_CHANNEL_HOLD_BUDGET_MS = 120_000' "$PROXY"
grep -Fq 'channelHold.renewals++' "$PROXY"
grep -Fq 'deadlineAtMs' "$PROXY"
grep -Fq "renewal extends the live hold deadline without a timing sleep" "$PROXY_TEST"
grep -Fq "renewed channel hold still blocks upstream channel requests" "$PROXY_TEST"
grep -Fq 'HCC_PR_A_SELECTIVE_CHANNEL=1 hcc_pr_a_enable_proxy' "$GATE"
grep -Fq 'response.writeHead(503' "$PROXY"
grep -Fq 'url.pathname === channelPath' "$PROXY"
grep -Fq 'CONTROL_UI_BASE_URL="$(profile_port_value CONTROL_UI_URL)"' "$GATE"
grep -Fq 'minikube-t2-hcc-stateless-cache-containment' "$MAKEFILE"
grep -Fq 'T2_HEALTHCHECK_COMMAND=' "$MAKEFILE"
grep -Fq 'MINIKUBE_PROFILE="$$T2_PROFILE"' "$MAKEFILE"
grep -Fq 'T2_GATE_ID=minikube-t2' "$MAKEFILE"
grep -Fq 'MINIKUBE_PROFILE)" = "$$context"' "$MAKEFILE"
grep -Fq 'E2E_EXPECTED_PRE_GATE_GATE=minikube-t2' "$MAKEFILE"
grep -Fq 'bash scripts/tests/test-hcc-stateless-cache-containment.sh' "$WORKFLOW"
if grep -Eq 'scale_proxy|kill .*HCC|kubectl .*delete pod' "$GATE"; then
  echo 'Selective gate contains a broad API or pod fault' >&2
  exit 1
fi

# The proxy image has a read-only root filesystem. Exercise the real fixture
# builder and inspect the Deployment patch, so command/ack files have an owned
# writable mount in the effective pod configuration.
capture="$(mktemp "${TMPDIR:-/tmp}/hcc-channel-patch.XXXXXX")"
trap 'rm -f "$capture"' EXIT
(
  # shellcheck source=scripts/e2e/_lib/hcc-watch-pr-a.sh
  source "$HELPER"
  PROXY_NAME=fixture-proxy HCC_NS=control-plane MCP_NS=mcp-server CHANNEL_NS=channels RUN_ID=fixture-run
  HCC_PR_A_SELECTIVE_CHANNEL=1
  CAPTURE="$capture"
  truncate_rfc1123() { printf '%.63s' "$1"; }
  die() { echo "$*" >&2; exit 1; }
  node() { printf '{}'; }
  kctl() {
    if [ "$1" = patch ]; then
      while [ "$#" -gt 0 ]; do
        if [ "$1" = -p ]; then printf '%s' "$2" > "$CAPTURE"; break; fi
        shift
      done
    fi
  }
  hcc_pr_a_enable_proxy
)
jq -e '
  .spec.template.spec as $pod |
  $pod.securityContext.fsGroup==1000 and
  (any($pod.volumes[]; .name=="churn-control" and .emptyDir=={})) and
  (any($pod.containers[]; .name=="proxy" and
    any(.volumeMounts[]; .name=="churn-control" and .mountPath=="/churn-ctl" and (.readOnly!=true)) and
    any(.env[]; .name=="CHURN_DISABLED" and .value=="1")))
' "$capture" >/dev/null
grep -Fq 'readOnlyRootFilesystem: true' "${ROOT}/scripts/e2e/_lib/hcc-watch-recovery-fixture.sh"
echo 'Selective stateless-cache containment shell contract: PASS'
