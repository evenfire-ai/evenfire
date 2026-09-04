#!/usr/bin/env bash
# Contract tests execute the real HTTP probe and observation decisions. Only
# Kubernetes transport, the remote nc process, and elapsed time are fixtures.
# Functions are dispatched through expect_pass/expect_reject and the sourced helper.
# shellcheck disable=SC2329
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wrc-np-probe-contract.XXXXXX")"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT
# shellcheck source=../e2e/_lib/wrc-networkpolicy-convergence.sh
source "$ROOT/scripts/e2e/_lib/wrc-networkpolicy-convergence.sh"

FAIL=0
export POLL_INTERVAL=1
export E2E_PROBE_TIMEOUT=2
export PROBE_SCENARIO=http
export PROBE_SEQUENCE_COUNTER="$FIXTURE_ROOT/nc-counter"
PROBE_TRANSPORT=http
OBSERVATION_SCENARIO=clean
ok() { :; }
fail() { printf '%s\n' "$*" >&2; }

expect_pass() {
  local label=$1
  shift
  if "$@" > "$FIXTURE_ROOT/result" 2>&1; then
    printf 'PASS: %s\n' "$label"
  else
    printf 'FAIL: %s\n' "$label" >&2
    cat "$FIXTURE_ROOT/result" >&2
    FAIL=1
  fi
}

expect_reject() {
  local label=$1
  shift
  if "$@" > "$FIXTURE_ROOT/result" 2>&1; then
    printf 'FAIL: accepted %s\n' "$label" >&2
    cat "$FIXTURE_ROOT/result" >&2
    FAIL=1
  else
    printf 'PASS: rejects %s\n' "$label"
  fi
}

mkdir -p "$FIXTURE_ROOT/tools" "$FIXTURE_ROOT/missing-tools"
for tool in grep base64 tr mktemp rm; do
  ln -s "$(command -v "$tool")" "$FIXTURE_ROOT/tools/$tool"
done
cat > "$FIXTURE_ROOT/tools/nc" <<'NC'
#!/bin/sh
case "$PROBE_SCENARIO" in
  timeout-then-http|http-then-timeout)
    read -r count < "$PROBE_SEQUENCE_COUNTER"
    count=$((count + 1))
    printf '%s\n' "$count" > "$PROBE_SEQUENCE_COUNTER"
    if { [ "$PROBE_SCENARIO" = timeout-then-http ] && [ "$count" -eq 1 ]; } ||
       { [ "$PROBE_SCENARIO" = http-then-timeout ] && [ "$count" -gt 1 ]; }; then
      printf 'nc: connect timed out\n' >&2
      exit 1
    fi
    printf 'HTTP/1.0 200 OK\r\n\r\nfixture-business-signal'
    exit 0 ;;
esac
case "$PROBE_SCENARIO" in
  http) printf 'HTTP/1.0 200 OK\r\n\r\nfixture-business-signal' ;;
  http-403) printf 'HTTP/1.0 403 Forbidden\r\n\r\nfixture-auth-denied' ;;
  timeout) printf 'nc: connect timed out\n' >&2; exit 1 ;;
  refused) printf 'nc: Connection refused\n' >&2; exit 1 ;;
  empty) exit 0 ;;
  malformed) printf 'not an HTTP response' ;;
  *) exit 99 ;;
esac
NC
chmod +x "$FIXTURE_ROOT/tools/nc"

log_event() {
  printf '%s %s\n' "$1" "$2" >> "$FIXTURE_ROOT/logs"
}

noop_event='{"msg":"network policy unchanged; skipping update","namespace":"sandbox-recipes","policy":"policy","family":"workload-ingress"}'
complete_event='{"msg":"recipe reconciliation completed","recipe":"recipe","namespace":"sandbox-recipes","uid":"recipe-uid","generation":2,"phase":"active","requeueAfterMs":0}'
write_event='{"msg":"network policy replaced","namespace":"sandbox-recipes","policy":"policy","family":"wrong-family"}'

kctl() {
  if [ "$1" = exec ]; then
    printf 'exec\n' >> "$FIXTURE_ROOT/exec-calls"
    case "$PROBE_TRANSPORT" in
      exec-forbidden) printf 'forbidden: pods/exec\n' >&2; return 13 ;;
      empty-exec) return 0 ;;
      bad-nonce) printf 'WRC_NP_BEGIN|foreign\nWRC_NP_END|foreign|timeout|\n'; return 0 ;;
      malformed-frame) printf 'WRC_NP_BEGIN|%s\nWRC_NP_END|%s|unknown|\n' "${10}" "${10}"; return 0 ;;
      malformed-base64) printf 'WRC_NP_BEGIN|%s\nWRC_NP_END|%s|http|!!!!\n' "${10}" "${10}"; return 0 ;;
      malformed-http) printf 'WRC_NP_BEGIN|%s\nWRC_NP_END|%s|http|bm90IEhUVFA=\n' "${10}" "${10}"; return 0 ;;
    esac
    while [ "$1" != -- ]; do shift; done
    shift
    [ "$1" = sh ] || return 99
    shift
    if [ "$PROBE_TRANSPORT" = missing-tool ]; then
      PATH="$FIXTURE_ROOT/missing-tools" /bin/sh "$@"
    else
      PATH="$FIXTURE_ROOT/tools" /bin/sh "$@"
    fi
    return
  fi
  case "$1:$2" in
    get:deployment) printf '%s\n' '{"spec":{"replicas":1,"selector":{"matchLabels":{"app":"wrc"}}}}' ;;
    get:pods) cat "$FIXTURE_ROOT/pods" ;;
    logs:*) cat "$FIXTURE_ROOT/logs" ;;
    get:networkpolicy) cat "$FIXTURE_ROOT/policy" ;;
    get:workflowrecipe)
      if [[ "$*" == *'jsonpath='* ]]; then
        cat "$FIXTURE_ROOT/generation"
      else
        printf '%s\n' '{"metadata":{"uid":"recipe-uid","generation":1}}'
      fi ;;
    patch:workflowrecipe) printf '2\n' > "$FIXTURE_ROOT/generation" ;;
    *) printf 'unexpected fixture transport: %s\n' "$*" >&2; return 99 ;;
  esac
}

# A fixed cursor and advancing elapsed clock keep this matrix bounded without
# sleeping or weakening the production minimum observation window of one second.
# Unsetting Bash's special SECONDS removes its wall-clock behaviour; assigning
# zero alone would leave a timing race between the real clock and fixture ticks.
unset SECONDS
SECONDS=0
wrc_now() { printf '2026-09-04T00:00:02.000000000Z\n'; }
sleep() {
  SECONDS=$((SECONDS + $1))
  printf 'tick\n' >> "$FIXTURE_ROOT/ticks"
  if [ "$OBSERVATION_SCENARIO" = delayed-write ]; then
    log_event '2026-09-04T00:00:04.000000000Z' "$write_event"
  elif [ "$OBSERVATION_SCENARIO" = observer-changed ]; then
    printf '%s\n' '{"items":[{"metadata":{"name":"wrc","uid":"pod-uid"},"status":{"phase":"Running","containerStatuses":[{"name":"wrc","ready":true,"containerID":"container-new","restartCount":1}]}}]}' > "$FIXTURE_ROOT/pods"
  fi
}

probe_allowed() {
  wrc_assert_http_allowed 'fixture route' sandbox-recipes pod fixture 8080 fixture-business-signal
}
probe_blocked() {
  wrc_assert_http_blocked 'fixture isolation' sandbox-recipes pod fixture 8080
}

expect_pass 'HTTP probe executes remote tools and validates the application response' probe_allowed
expect_reject 'HTTP response as NetworkPolicy denial' probe_blocked
PROBE_SCENARIO=http-403
expect_reject 'HTTP authorization rejection as NetworkPolicy denial' probe_blocked
PROBE_SCENARIO=timeout
expect_pass 'completed remote connection timeout as a network observation' probe_blocked
expect_reject 'timeout as an allowed route' probe_allowed
for PROBE_SCENARIO in empty malformed refused; do
  expect_reject "remote $PROBE_SCENARIO response as NetworkPolicy denial" probe_blocked
done
PROBE_SCENARIO=http
for PROBE_TRANSPORT in exec-forbidden missing-tool empty-exec bad-nonce malformed-frame malformed-base64 malformed-http; do
  expect_reject "$PROBE_TRANSPORT probe envelope" wrc_http_probe sandbox-recipes pod fixture 8080
done
PROBE_TRANSPORT=http

probe_sequence() {
  local scenario=$1 assertion=$2 count
  PROBE_SCENARIO=$scenario
  printf '0\n' > "$PROBE_SEQUENCE_COUNTER"
  "$assertion" || return 1
  read -r count < "$PROBE_SEQUENCE_COUNTER"
  [ "$count" -eq 2 ]
}

executor_aborts_once() {
  local assertion=$1 before=$SECONDS count
  PROBE_TRANSPORT=exec-forbidden
  : > "$FIXTURE_ROOT/exec-calls"
  if "$assertion"; then return 1; fi
  count="$(wc -l < "$FIXTURE_ROOT/exec-calls")"
  [ "$count" -eq 1 ] && [ "$SECONDS" -eq "$before" ]
}

expect_pass 'allowed route waits through timeout then validates HTTP after CNI propagation' \
  probe_sequence timeout-then-http probe_allowed
expect_pass 'denied route waits through HTTP then observes timeout after CNI propagation' \
  probe_sequence http-then-timeout probe_blocked
expect_pass 'allowed assertion aborts once on exec failure without waiting/retrying' executor_aborts_once probe_allowed
expect_pass 'denied assertion aborts once on exec failure without waiting/retrying' executor_aborts_once probe_blocked
PROBE_SCENARIO=http
PROBE_TRANSPORT=http

observe() {
  local scenario=$1
  OBSERVATION_SCENARIO=$scenario
  : > "$FIXTURE_ROOT/logs"
  : > "$FIXTURE_ROOT/ticks"
  printf '1\n' > "$FIXTURE_ROOT/generation"
  printf '%s\n' '{"metadata":{"uid":"policy-uid","resourceVersion":"1"}}' > "$FIXTURE_ROOT/policy"
  printf '%s\n' '{"items":[{"metadata":{"name":"wrc","uid":"pod-uid"},"status":{"phase":"Running","containerStatuses":[{"name":"wrc","ready":true,"containerID":"container-one","restartCount":0}]}}]}' > "$FIXTURE_ROOT/pods"
  wrc_begin_np_observation || return 1
  wrc_track_np sandbox-recipes policy workload-ingress || return 1
  if [ "$scenario" = pretrigger-rv-drift ]; then
    printf '%s\n' '{"metadata":{"uid":"policy-uid","resourceVersion":"2"}}' > "$FIXTURE_ROOT/policy"
  fi
  case "$scenario" in
    write-before)
      log_event '2026-09-04T00:00:02.100000000Z' "$write_event"
      log_event '2026-09-04T00:00:03.000000000Z' "$noop_event" ;;
    write-after)
      log_event '2026-09-04T00:00:03.000000000Z' "$noop_event"
      log_event '2026-09-04T00:00:03.100000000Z' "$write_event" ;;
    wrong-family)
      log_event '2026-09-04T00:00:03.000000000Z' "${noop_event/workload-ingress/oauth-broker-egress}" ;;
    missing-witness) ;;
    old-logs) log_event '2026-09-04T00:00:01.999999999Z' "$noop_event" ;;
    *) log_event '2026-09-04T00:00:03.000000000Z' "$noop_event" ;;
  esac
  log_event '2026-09-04T00:00:03.200000000Z' "$complete_event"
  wrc_trigger_recipe_reconcile sandbox-recipes recipe 3 || return 1
  SECONDS=0
  wrc_assert_np_observation_clean 1 3 || return 1
  # An initial no-op is insufficient: success must span the full window.
  [ -s "$FIXTURE_ROOT/ticks" ]
}

expect_pass 'complete no-write window with an exact active reconcile and stable observer/UID/RV' observe clean
for scenario in write-before write-after delayed-write wrong-family missing-witness old-logs observer-changed pretrigger-rv-drift; do
  expect_reject "$scenario despite a completed parent reconcile" observe "$scenario"
done

# Exercise the actual OAuth caller sequence as well as the shared assertions.
# A healthy authorised workload cannot substitute for the negative source's
# post-control when that source has an independent persistent route failure.
sed -n '/^wrc_assert_http_allowed "OAuth negative probe reaches/,/^oauth_policy_hash=/p' \
  "$ROOT/scripts/e2e/e2e-sandbox-ui-oauth.sh" | sed '$d' > "$FIXTURE_ROOT/oauth-flow"
cat > "$FIXTURE_ROOT/oauth-runner.sh" <<'OAUTH'
#!/usr/bin/env bash
set -euo pipefail
source "$1/scripts/e2e/_lib/wrc-networkpolicy-convergence.sh"
scenario=$2
flow=$3
WORKFLOW_RECIPE_NS=sandbox-recipes
CONTROL_NS=control-plane
BACKGROUND_PROBE_POD=probe
BACKGROUND_DEPLOYMENT=healthy-background
control_api_ip=192.0.2.1
probe_selector='{"e2e.clerum.io/probe":"probe"}'
E2E_PROBE_TIMEOUT=2
POLL_INTERVAL=1
unset SECONDS
SECONDS=0
control_present=1
permission_removed=0
sleep() { SECONDS=$((SECONDS + $1)); }
ok() { :; }
fail() { printf '%s\n' "$*" >&2; }
wrc_delete_owned() { control_present=0; permission_removed=1; }
wrc_create_connection_policy() { control_present=1; }
wrc_http_probe() {
  if [ "$2" = probe ] && { [ "$control_present" = 0 ] ||
       { [ "$permission_removed" = 1 ] && [ "$scenario" = source-outage ]; }; }; then
    printf '{"outcome":"timeout","body":""}\n'
  else
    printf '{"outcome":"http","body":"SFRUUC8xLjEgMjAwIE9LDQoNCm9r"}\n'
  fi
}
source "$flow"
[ "$permission_removed" = 1 ] && [ "$control_present" = 0 ]
OAUTH

check_oauth_flow() {
  local flow=$1
  [ -s "$flow" ] || return 1
  bash "$FIXTURE_ROOT/oauth-runner.sh" "$ROOT" healthy "$flow" || return 1
  if bash "$FIXTURE_ROOT/oauth-runner.sh" "$ROOT" source-outage "$flow"; then
    printf 'OAuth flow accepted a persistent outage of its negative source\n' >&2
    return 1
  fi
}
expect_pass 'OAuth actual caller validates the same probe after its denial' check_oauth_flow "$FIXTURE_ROOT/oauth-flow"
awk '
  /^wrc_create_connection_policy / { skip=1 }
  /^wrc_assert_http_allowed "OAuth broker remains reachable/ { skip=0 }
  !skip { print }
' "$FIXTURE_ROOT/oauth-flow" > "$FIXTURE_ROOT/oauth-mutated-flow"
expect_reject 'OAuth mutation that replaces the source post-control with a healthy background workload' \
  check_oauth_flow "$FIXTURE_ROOT/oauth-mutated-flow"

exit "$FAIL"
