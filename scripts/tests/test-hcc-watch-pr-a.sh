#!/usr/bin/env bash
# Fixture globals are consumed by sourced helpers and the evaluated production wait loop.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
source "$ROOT/scripts/e2e/_lib/hcc-watch-pr-a.sh"
HCC_LOG_BUFFER="$tmp/logs"
require_hcc_recovery_log_stream() { return 0; }
printf '%s\n' '{"event":"networkpolicy-recovery-decision","kind":"McpServer","decision":"skip"}' \
  '{"event":"networkpolicy-recovery-decision","kind":"Context","decision":"defer"}' > "$HCC_LOG_BUFFER"
[[ "$(hcc_pr_a_decision_count McpServer skip)" = 1 ]]
hcc_pr_a_decision_after 0 McpServer skip
if hcc_pr_a_decision_after 1 McpServer skip; then echo 'FAIL: old recovery reused'; exit 1; fi
if hcc_pr_a_decision_after 0 Context skip; then echo 'FAIL: deferral counted as optimization'; exit 1; fi
: > "$HCC_LOG_BUFFER"
if hcc_pr_a_decision_after 0 McpServer skip; then echo 'FAIL: empty observations passed'; exit 1; fi
printf 'PASS: recovery observation needs a new explicit omission of the exact kind\n'

NP604_SERVER=fixture-affected MCP_NS=mcp-server HCC_PR_A_SERVICE_UID=old
np604_kctl() { cat "$tmp/service"; }
for variation in new old wrong-label wrong-port; do
  uid=new name=fixture-affected port=3000
  case "$variation" in old) uid=old;; wrong-label) name=other;; wrong-port) port=3001;; esac
  jq -cn --arg uid "$uid" --arg name "$name" --argjson port "$port" \
    '{metadata:{uid:$uid,labels:{"clerum.io/mcpserver":$name}},spec:{ports:[{port:$port}]}}' > "$tmp/service"
  if hcc_pr_a_service_restored; then
    [[ "$variation" = new ]] || { echo "FAIL: accepted $variation Service"; exit 1; }
  else
    [[ "$variation" != new ]] || { echo 'FAIL: valid repaired Service rejected'; exit 1; }
  fi
done
printf 'service/fixture-affected\n' > "$tmp/service"
if hcc_pr_a_service_absent; then echo 'FAIL: delete request replaced absence proof'; exit 1; fi
: > "$tmp/service"
hcc_pr_a_service_absent
printf 'PASS: actual absence and new correctly scoped Service are required\n'

# Execute the scenario until its first arm command with harmless boundary
# doubles. This proves the selected read is before Service repair, rather
# than searching a comment or passing through an unexecuted branch.
(
  NP604_CONTROL=fixture-control
  hcc_pr_a_gate() { :; }
  np604_snapshot() { printf '[]'; }
  hcc_pr_a_periodic_count() { printf 1; }
  hcc_pr_a_periodic_started_count() { printf 1; }
  hcc_pr_a_certified_count() { printf 1; }
  hcc_pr_a_remove_service() { :; }
  hcc_pr_a_cut() { :; }
  hcc_pr_a_service_absent() { :; }
  np604_kctl() { printf '{"metadata":{"uid":"fixture","generation":1},"spec":{}}'; }
  np604_invoke() { :; }
  wait_until() { :; }
  hcc_pr_a_command() { printf '%s\n' "$2" > "$tmp/first-arm"; exit 0; }
  die() { echo "FAIL: unexpected scenario rejection $*" >&2; exit 1; }
  hcc_pr_a_run > "$tmp/scenario-output"
)
[[ "$(cat "$tmp/first-arm")" = '/api/v1/namespaces/mcp-server/services/fixture-affected' ]]
printf 'PASS: interrupted runtime holds the Service GET before its missing effect\n'

# Execute the proxy patch builder without generating material or contacting
# Kubernetes; its allowlist must include the fixture read chosen above.
(
  RUN_ID=fixture PROXY_NAME=fixture-proxy HCC_NS=control-plane
  truncate_rfc1123() { printf '%s' "$1"; }
  node() { printf '{}'; }
  kctl() {
    case "$1" in
      create) cat >/dev/null;;
      patch) printf '%s' "${@: -1}" > "$tmp/proxy-patch";;
      rollout) :;;
      *) exit 1;;
    esac
  }
  hcc_pr_a_enable_proxy
)
jq -e '.spec.template.spec.containers[0].env[0].value|fromjson|index("/api/v1/namespaces/mcp-server/services/np604-fixture-affected")!=null' "$tmp/proxy-patch" >/dev/null
jq -e '.spec.template.spec.containers[0].env[0].value|fromjson|index("/apis/networking.k8s.io/v1/namespaces/mcp-server/networkpolicies/ext-egress-np604-fixture-affected-1-2-3-4-32-443")!=null' "$tmp/proxy-patch" >/dev/null
printf 'PASS: proxy allowlist covers only the declared fixture operations\n'

# Run the shared positive probe builder in both modes up to its actual exec
# boundary. No credentials are read; only the exact public trust arguments
# supplied to the in-pod HTTPS client are observed here.
for mode in 0 1; do
  (
    source "$ROOT/scripts/e2e/_lib/hcc-watch-recovery-fixture.sh"
    E2E_HCC_PR_A=$mode PROXY_NAME=fixture-proxy HCC_NS=control-plane HCC_DEPLOY=host-context-controller
    if [[ "$mode" = 1 ]]; then
      wait_until() { shift 2; "$@"; }
    else
      unset -f wait_until
    fi
    kctl() {
      case "$1/$2" in
        get/service) printf '10.0.0.1';;
        get/configmap)
          jq -cn '{data:{"config.json":"{\"clusters\":[{\"cluster\":{\"certificate-authority-data\":\"cHVibGljLXRlc3QtY2E=\"}}]}"}}';;
        exec/*) printf '%s\n' "$@" > "$tmp/trust-$mode"; exit 0;;
        *) exit 1;;
      esac
    }
    verify_hcc_proxy_network_policy
  )
  grep -q 'rejectUnauthorized:true' "$tmp/trust-$mode"
  [[ "$(tail -3 "$tmp/trust-$mode" | head -1)" = 'fixture-proxy.control-plane.svc' ]]
  if [[ "$mode" = 1 ]]; then
    [[ "$(tail -2 "$tmp/trust-$mode" | head -1)" = 'fixture-proxy.control-plane.svc' ]]
    [[ "$(tail -1 "$tmp/trust-$mode")" = 'cHVibGljLXRlc3QtY2E=' ]]
  else
    [[ "$(tail -2 "$tmp/trust-$mode" | head -1)" = 'kubernetes.default.svc' ]]
    [[ -z "$(tail -1 "$tmp/trust-$mode")" ]]
  fi
done
printf 'PASS: PR A verifies its public fixture CA/name; PR B preserves Kubernetes trust\n'

# Exercise the production wait loop with a virtual clock and only the kubectl
# boundary doubled. TLS failure and HTTP non-200 never count as readiness.
for mode in 0 1; do
  for outcome in success transient permanent; do
    status=0
    (
      source "$ROOT/scripts/e2e/_lib/hcc-watch-recovery-fixture.sh"
      if [[ "$mode" = 1 ]]; then
        eval "$(sed -n '/^wait_until() {/,/^}/p' "$ROOT/scripts/e2e/e2e-hcc-watch-churn-readiness.sh")"
      else
        # CommunicationChannel recovery does not provide this helper at all.
        unset -f wait_until
      fi
      E2E_HCC_PR_A=$mode HCC_PR_A_WORK_DEADLINE=600
      PROXY_NAME=fixture-proxy HCC_NS=fixture HCC_DEPLOY=fixture HCC_IMAGE=fixture
      PROBE_NAME=fixture-negative PROBE_EGRESS_NP=fixture-negative-policy
      clock=0 attempts=0
      date() { printf '%s' "$clock"; }
      sleep() { clock=$((clock + 1)); }
      kctl() {
        case "$1/$2" in
          get/service) printf '10.0.0.1';;
          get/configmap)
            jq -cn '{data:{"config.json":"{\"clusters\":[{\"cluster\":{\"certificate-authority-data\":\"cHVibGljLXRlc3QtY2E=\"}}]}"}}';;
          exec/*)
            attempts=$((attempts + 1))
            [[ "${10}" == *rejectUnauthorized:true* ]] || exit 9
            [[ "${10}" == *'response.statusCode===200?0:2'* ]] || exit 9
            if [[ "$outcome" = success ]]; then return 0; fi
            if [[ "$outcome" = transient && "$attempts" = 3 ]]; then return 0; fi
            if [[ "$outcome" = transient && "$attempts" = 2 ]]; then return 2; fi
            return 3;;
          apply/*) cat >/dev/null; printf '%s' "$attempts" > "$tmp/attempts-$mode-$outcome"; exit 0;;
          logs/*) :;;
          *) exit 9;;
        esac
      }
      die() { printf '%s' "$attempts" > "$tmp/attempts-$mode-$outcome"; exit 1; }
      verify_hcc_proxy_network_policy
    ) > "$tmp/readiness-$mode-$outcome" 2>&1 || status=$?
    attempts="$(cat "$tmp/attempts-$mode-$outcome")"
    if [[ "$outcome" = success ]]; then
      [[ "$status" = 0 && "$attempts" = 1 ]]
    elif [[ "$mode" = 0 ]]; then
      [[ "$status" = 1 && "$attempts" = 1 ]] || {
        echo "FAIL: legacy caller without wait_until exited $status after $attempts attempts" >&2; exit 1;
      }
    elif [[ "$outcome" = transient ]]; then
      [[ "$status" = 0 && "$attempts" = 3 ]] || {
        echo "FAIL: transient readiness exited $status after $attempts attempts (mode $mode)" >&2; exit 1;
      }
    else
      [[ "$status" = 1 && "$attempts" -gt 1 && "$attempts" -le 21 ]] || {
        echo "FAIL: permanent trust failure exited $status after $attempts attempts (mode $mode)" >&2; exit 1;
      }
    fi
  done
done
printf 'PASS: PR A retries within budget; legacy callers without wait_until remain strict and one-shot\n'
