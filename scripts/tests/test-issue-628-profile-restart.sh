#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/repo/scripts/e2e" "$TMP/repo/scripts/minikube" \
  "$TMP/repo/scripts/minikube-profiles" "$TMP/bin"
cp "$ROOT/scripts/e2e/issue-628-profile-restart.sh" "$TMP/repo/scripts/e2e/"
cp "$ROOT/scripts/e2e/run-issue-628-playwright.sh" "$ROOT/scripts/e2e/load-dotenv.sh" \
  "$ROOT/scripts/e2e/admin-credentials.sh" "$TMP/repo/scripts/e2e/"

cat >"$TMP/repo/scripts/minikube/require-t2-mutation-lock.sh" <<'STUB'
#!/bin/bash
set -euo pipefail
printf 'lease\n' >>"$TEST_CALLS"
[[ "${TEST_LEASE_OK:-true}" == true ]] || exit 1
if [[ "${TEST_CASE:-}" == lost-lease && "$(grep -c '^lease$' "$TEST_CALLS")" -gt 1 ]]; then
  exit 1
fi
STUB
cat >"$TMP/bin/make" <<'STUB'
#!/bin/bash
set -euo pipefail
for arg in "$@"; do target="$arg"; done
printf '%s\n' "$target" >>"$TEST_CALLS"
if [[ "$target" == branch-profile-info ]]; then
  printf '  control-ui:                  28117\n'
  exit 0
fi
if [[ "$target" == branch-profile-stop && "$TEST_CASE" == stop-fails ]]; then exit 1; fi
if [[ "$target" == branch-profile-start && "$TEST_CASE" == start-fails ]]; then exit 1; fi
STUB
cat >"$TMP/bin/minikube" <<'STUB'
#!/bin/bash
set -euo pipefail
[[ "$1" == -p && "$2" == "$TEST_PROFILE" ]] || exit 1
shift 2
printf 'minikube-%s\n' "$1" >>"$TEST_CALLS"
case "$1" in
  ip)
    if [[ "$TEST_CASE" == ip-unknown ]]; then exit 0; fi
    if [[ -f "$TEST_IP_SEEN" && "$TEST_CASE" == ip-changes ]]; then
      printf '192.0.2.2\n'
    else
      printf '192.0.2.1\n'
    fi
    : >"$TEST_IP_SEEN"
    ;;
  status)
    if [[ "$TEST_CASE" == stop-unobserved ]]; then printf '{}\n'; else printf '{"Host":"Stopped"}\n'; fi
    exit 7
    ;;
  *) exit 2 ;;
esac
STUB
cat >"$TMP/bin/kubectl" <<'STUB'
#!/bin/bash
set -euo pipefail
[[ "$1" == "--context=$TEST_PROFILE" && "$2" == --request-timeout=20s && "$3" == -n ]] || exit 1
namespace="$4"
shift 4
[[ "$1" == get ]] || exit 1
case "$2" in
  svc)
    service="$3"
    printf 'service-check=%s/%s\n' "$namespace" "$service" >>"$TEST_CALLS"
    if [[ "$TEST_CASE" == service-read-fails ]]; then exit 1; fi
    if [[ "$TEST_CASE" == optional-read-fails && "$service" == profile-ui ]]; then exit 1; fi
    if [[ "$TEST_CASE" == required-absent && "$service" == control-ui ]]; then exit 0; fi
    if [[ "$TEST_CASE" == optional-absent && ( "$service" == profile-ui || "$service" == member-registration-service || "$service" == registry-api || "$service" == workflow-approval-request-reader ) ]]; then exit 0; fi
    if [[ "$TEST_CASE" == mcp-fallback && "$namespace" == mcp-host && "$service" == chatllm ]]; then exit 0; fi
    printf '{"spec":{"selector":{"app":"%s"}}}\n' "$service"
    ;;
  pods)
    [[ "$3" == -l && "$4" == app=* ]] || exit 1
    service="${4#app=}"
    printf 'pod-check=%s/%s\n' "$namespace" "$service" >>"$TEST_CALLS"
    if [[ "$TEST_CASE" == pod-read-fails ]]; then exit 1; fi
    if [[ "$TEST_CASE" == malformed-pods ]]; then printf '{"items":null}\n'; exit 0; fi
    if [[ "$TEST_CASE" == pending-pod && "$service" == control-ui && ! -e "$TEST_POD_SEEN" ]]; then
      : >"$TEST_POD_SEEN"
      printf '{"items":[{"metadata":{},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"False"}]}}]}\n'
    elif [[ "$TEST_CASE" == terminating-pod && "$service" == control-ui && ! -e "$TEST_POD_SEEN" ]]; then
      : >"$TEST_POD_SEEN"
      printf '{"items":[{"metadata":{"deletionTimestamp":"2026-01-01T00:00:00Z"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}\n'
    else
      printf '{"items":[{"metadata":{},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}\n'
    fi
    ;;
  *) exit 1 ;;
esac
STUB
cat >"$TMP/bin/node" <<'STUB'
#!/bin/bash
set -euo pipefail
if [[ "$1" == */run-with-deadline.mjs ]]; then
  while [[ "$1" != -- ]]; do shift; done
  shift
  exec "$@"
fi
[[ "$E2E_CONTROL_UI_URL" == http://127.0.0.1:28117 ]] || exit 1
[[ "$TEST_ADMIN_USERNAME" == admin && "$TEST_ADMIN_PASSWORD" == fixture-password-only ]] || exit 1
[[ "$E2E_REPORT_PATH" == /* ]] || exit 1
printf 'playwright\n' >>"$TEST_CALLS"
STUB
chmod +x "$TMP/bin/make" "$TMP/bin/minikube" "$TMP/bin/kubectl" "$TMP/bin/node"

run_case() {
  local name="$1"; shift
  TEST_CALLS="$TMP/$name.calls" TEST_IP_SEEN="$TMP/$name.ip" TEST_POD_SEEN="$TMP/$name.pod" TEST_CASE="$name" \
    TEST_PROFILE=clerum-restart-test-1234abcd \
    MINIKUBE_PROFILE=clerum-restart-test-1234abcd \
    CONTROL_API_REAL_PG_CONTEXT=clerum-restart-test-1234abcd \
    T2_PROFILE=clerum-restart-test-1234abcd T2_CONTEXT=clerum-restart-test-1234abcd \
    T2_GATE_ID=issue628-profile-restart T2_MUTATION_LOCK_WRAPPED=true T2_SKIP_LOCK=true \
    PATH="$TMP/bin:$PATH" "$@" /bin/bash "$TMP/repo/scripts/e2e/issue-628-profile-restart.sh" \
    >"$TMP/$name.out" 2>&1
}

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if run_case no-lease env T2_MUTATION_LOCK_WRAPPED=false; then fail 'missing lease accepted'; fi
[[ ! -e "$TMP/no-lease.calls" ]] || fail 'missing lease reached profile commands'
grep -q '^ISSUE628_RESTART_SCOPE_REQUIRED' "$TMP/no-lease.out" || fail 'missing lease lacked the scope reason'
printf 'PASS: restart rejects a missing inherited lease\n'

if run_case wrong-context env CONTROL_API_REAL_PG_CONTEXT=clerum-other-1234abcd; then fail 'wrong context accepted'; fi
[[ ! -e "$TMP/wrong-context.calls" ]] || fail 'wrong context reached profile commands'
grep -q '^ISSUE628_RESTART_SCOPE_REQUIRED' "$TMP/wrong-context.out" || fail 'wrong context lacked the scope reason'
printf 'PASS: restart rejects a mismatched context\n'

if run_case wrong-profile env MINIKUBE_PROFILE=clerum-test; then fail 'shared profile accepted'; fi
[[ ! -e "$TMP/wrong-profile.calls" ]] || fail 'shared profile reached profile commands'
grep -q '^ISSUE628_RESTART_SCOPE_REQUIRED' "$TMP/wrong-profile.out" || fail 'wrong profile lacked the scope reason'
printf 'PASS: restart rejects a shared profile\n'

if run_case wrong-lease-context env T2_CONTEXT=clerum-other-1234abcd; then fail 'wrong lease context accepted'; fi
[[ ! -e "$TMP/wrong-lease-context.calls" ]] || fail 'wrong lease context reached profile commands'
grep -q '^ISSUE628_RESTART_SCOPE_REQUIRED' "$TMP/wrong-lease-context.out" || fail 'wrong lease context lacked the scope reason'
printf 'PASS: restart rejects a mismatched lease context\n'

if run_case wrong-gate env T2_GATE_ID=minikube-t2; then fail 'T2 gate accepted the separate restart mode'; fi
[[ ! -e "$TMP/wrong-gate.calls" ]] || fail 'wrong gate reached profile commands'
grep -q '^ISSUE628_RESTART_SCOPE_REQUIRED' "$TMP/wrong-gate.out" || fail 'wrong gate lacked the scope reason'
printf 'PASS: restart requires the separate restart gate\n'

if run_case invalid-lease env TEST_LEASE_OK=false; then fail 'invalid lease accepted'; fi
! grep -q '^branch-profile-' "$TMP/invalid-lease.calls" || fail 'invalid lease reached profile commands'
printf 'PASS: restart validates the lease before profile operations\n'

if run_case stop-fails env; then fail 'failed stop accepted'; fi
! grep -q '^branch-profile-start$' "$TMP/stop-fails.calls" || fail 'failed stop continued to start'
grep -q '^ISSUE628_RESTART_STOP_FAILED' "$TMP/stop-fails.out" || fail 'failed stop lacked its reason'
printf 'PASS: restart stops after an incomplete profile stop\n'

if run_case lost-lease env; then fail 'lost lease accepted'; fi
grep -q '^branch-profile-stop$' "$TMP/lost-lease.calls" || fail 'lost-lease case did not stop the profile'
! grep -q '^branch-profile-start$' "$TMP/lost-lease.calls" || fail 'lost lease continued to start'
printf 'PASS: restart refuses to start if the inherited lease is lost\n'

if run_case start-fails env; then fail 'failed start accepted'; fi
! grep -q '^branch-profile-pf$' "$TMP/start-fails.calls" || fail 'failed start continued to port-forwards'
grep -q '^ISSUE628_RESTART_START_FAILED' "$TMP/start-fails.out" || fail 'failed start lacked its reason'
printf 'PASS: restart stops after a failed profile start\n'

if run_case ip-unknown env; then fail 'unknown initial node IP accepted'; fi
! grep -q '^branch-profile-stop$' "$TMP/ip-unknown.calls" || fail 'unknown IP reached profile stop'
grep -q '^ISSUE628_RESTART_IP_UNKNOWN' "$TMP/ip-unknown.out" || fail 'unknown IP lacked its reason'
printf 'PASS: restart rejects an unknown initial node IP\n'

if run_case ip-changes env; then fail 'changed node IP accepted'; fi
grep -q '^branch-profile-start$' "$TMP/ip-changes.calls" || fail 'IP case did not start the profile'
! grep -q '^branch-profile-pf$' "$TMP/ip-changes.calls" || fail 'changed IP continued to port-forwards'
grep -q '^ISSUE628_RESTART_IP_CHANGED' "$TMP/ip-changes.out" || fail 'changed IP lacked its reason'
printf 'PASS: restart fails closed on a changed node IP\n'

if run_case stop-unobserved env; then fail 'unobserved stopped state accepted'; fi
grep -q '^branch-profile-start$' "$TMP/stop-unobserved.calls" || fail 'unobserved stop did not restore the profile'
! grep -q '^branch-profile-pf$' "$TMP/stop-unobserved.calls" || fail 'bounded helper created port-forwards'
grep -q '^ISSUE628_RESTART_STOP_UNOBSERVED' "$TMP/stop-unobserved.out" || fail 'unobserved stop lacked its reason'
printf 'PASS: restart restores the profile but fails when stopped state was unobserved\n'

if run_case service-read-fails env; then fail 'service read failure accepted'; fi
! grep -q '^branch-profile-pf$' "$TMP/service-read-fails.calls" || fail 'failed service read reached port-forwards'
grep -q '^ISSUE628_RESTART_READINESS_FAILED' "$TMP/service-read-fails.out" || fail 'service read failure lacked its reason'
printf 'PASS: restart fails closed if forwarded services cannot be inspected\n'

if run_case optional-read-fails env; then fail 'optional service read failure accepted'; fi
! grep -q '^branch-profile-pf$' "$TMP/optional-read-fails.calls" || fail 'optional service read failure reached port-forwards'
grep -q '^ISSUE628_RESTART_READINESS_FAILED' "$TMP/optional-read-fails.out" || fail 'optional service read failure lacked its reason'
printf 'PASS: an API error is not treated as an absent optional service\n'

if run_case required-absent env; then fail 'absent required service accepted'; fi
! grep -q '^branch-profile-pf$' "$TMP/required-absent.calls" || fail 'absent required service reached port-forwards'
grep -q '^ISSUE628_RESTART_READINESS_FAILED' "$TMP/required-absent.out" || fail 'absent required service lacked its reason'
printf 'PASS: restart rejects an absent required service\n'

if run_case pod-read-fails env; then fail 'pod read failure accepted'; fi
! grep -q '^branch-profile-pf$' "$TMP/pod-read-fails.calls" || fail 'failed pod read reached port-forwards'
grep -q '^ISSUE628_RESTART_READINESS_FAILED' "$TMP/pod-read-fails.out" || fail 'pod read failure lacked its reason'
printf 'PASS: restart fails closed if selected Pods cannot be inspected\n'

if run_case malformed-pods env; then fail 'malformed Pod list accepted'; fi
! grep -q '^branch-profile-pf$' "$TMP/malformed-pods.calls" || fail 'malformed Pod list reached port-forwards'
grep -q '^ISSUE628_RESTART_READINESS_FAILED' "$TMP/malformed-pods.out" || fail 'malformed Pod list lacked its reason'
printf 'PASS: restart rejects malformed Pod inventory\n'

if ! run_case pending-pod env; then cat "$TMP/pending-pod.out" >&2; fail 'a Pod that became ready did not recover'; fi
[[ "$(grep -c '^pod-check=control-plane/control-ui$' "$TMP/pending-pod.calls")" -ge 2 ]] || fail 'port-forwards did not wait for the pending Pod'
printf 'PASS: restart waits for a forwarded Pod to become ready\n'

if ! run_case terminating-pod env; then cat "$TMP/terminating-pod.out" >&2; fail 'a replacement Pod did not recover'; fi
[[ "$(grep -c '^pod-check=control-plane/control-ui$' "$TMP/terminating-pod.calls")" -ge 2 ]] || fail 'terminating Pod was accepted as ready'
printf 'PASS: restart waits for a non-terminating ready Pod\n'

if ! run_case optional-absent env; then cat "$TMP/optional-absent.out" >&2; fail 'absent optional services prevented recovery'; fi
grep -q '^RESTART_PHASE=workloads-ready$' "$TMP/optional-absent.out" || fail 'absent optional services prevented readiness'
! grep -q '^pod-check=profiles/profile-ui$' "$TMP/optional-absent.calls" || fail 'absent optional service was treated as present'
printf 'PASS: restart skips only confirmed absent optional services\n'

if ! run_case mcp-fallback env; then cat "$TMP/mcp-fallback.out" >&2; fail 'MCP service fallback did not recover'; fi
grep -q '^pod-check=mcp-host/mcp-host$' "$TMP/mcp-fallback.calls" || fail 'alternate MCP service was not checked'
! grep -q '^pod-check=mcp-host/chatllm$' "$TMP/mcp-fallback.calls" || fail 'absent preferred MCP service was treated as present'
printf 'PASS: restart follows the profile MCP service selection\n'

if ! run_case success env; then cat "$TMP/success.out" >&2; fail 'valid restart failed'; fi
[[ "$(grep -c '^lease$' "$TMP/success.calls")" -eq 2 ]] || fail 'lease was not revalidated before stop and start'
grep -q '^branch-profile-stop$' "$TMP/success.calls" || fail 'stop was not called'
grep -q '^branch-profile-start$' "$TMP/success.calls" || fail 'start was not called'
! grep -q '^branch-profile-pf$' "$TMP/success.calls" || fail 'bounded helper created port-forwards'
[[ "$(grep -c '^branch-profile-health$' "$TMP/success.calls")" -eq 1 ]] || fail 'bounded helper ran health after restart'
grep -q '^RESTART_PHASE=stopped$' "$TMP/success.out" || fail 'stopped state was not recorded'
grep -q '^RESTART_PHASE=running$' "$TMP/success.out" || fail 'running state was not recorded'
grep -q '^RESTART_PHASE=workloads-ready$' "$TMP/success.out" || fail 'workload readiness was not recorded'
printf '%s\n' lease branch-profile-health minikube-ip branch-profile-stop minikube-status \
  lease branch-profile-start minikube-ip >"$TMP/expected-order"
grep -v -E '^(service-check|pod-check)=' "$TMP/success.calls" >"$TMP/success.operations"
cmp -s "$TMP/expected-order" "$TMP/success.operations" || fail 'restart operations ran out of order'
for service in control-plane/control-ui profiles/profile-ui control-plane/control-api profiles/external-rest-api profiles/member-registration-service rpc-proxy/rpc-proxy registry/registry-api channels/workflow-approval-request-reader mcp-host/chatllm; do
  grep -q "^pod-check=$service$" "$TMP/success.calls" || fail "forwarded service was not checked: $service"
done
awk '
  /^minikube-ip$/ { ips++ }
  /^(service-check|pod-check)=/ { if (ips < 2) invalid=1; checks=1 }
  END { exit invalid || !checks }
' "$TMP/success.calls" || fail 'readiness checks ran before the restarted profile was verified'
printf 'PASS: restart preserves the lease and leaves forward creation to its caller\n'

if env -i HOME="$HOME" PATH="$TMP/bin:$PATH" \
  /bin/bash "$TMP/repo/scripts/e2e/run-issue-628-playwright.sh" >"$TMP/runner-missing.out" 2>&1; then
  fail 'Playwright runner accepted a non-isolated environment'
fi
grep -q '^ISSUE628_ISOLATED_ENV_REQUIRED' "$TMP/runner-missing.out" || fail 'runner did not report isolation requirement'
printf 'PASS: Playwright runner rejects a non-isolated environment\n'

if env -i HOME="$HOME" PATH="$TMP/bin:$PATH" E2E_DISABLE_CANONICAL_DOTENV=true \
  /bin/bash "$TMP/repo/scripts/e2e/run-issue-628-playwright.sh" >"$TMP/runner-report-missing.out" 2>&1; then
  fail 'Playwright runner accepted a missing report path'
fi
grep -q '^ISSUE628_REPORT_PATH_REQUIRED' "$TMP/runner-report-missing.out" || fail 'runner omitted the report-path reason'
printf 'PASS: Playwright runner rejects a missing report path\n'

if env -i HOME="$HOME" PATH="$TMP/bin:$PATH" TEST_CALLS="$TMP/runner-no-admin.calls" \
  E2E_DISABLE_CANONICAL_DOTENV=true E2E_REPORT_PATH="$TMP/runner-report.json" \
  /bin/bash "$TMP/repo/scripts/e2e/run-issue-628-playwright.sh" >"$TMP/runner-no-admin.out" 2>&1; then
  fail 'Playwright runner accepted missing admin credentials'
fi
grep -q '^ISSUE628_ADMIN_CREDENTIAL_REQUIRED' "$TMP/runner-no-admin.out" || fail 'runner omitted the admin reason'
! grep -q '^playwright$' "$TMP/runner-no-admin.calls" || fail 'runner launched without admin credentials'
printf 'PASS: Playwright runner rejects missing admin credentials\n'

if ! env -i HOME="$HOME" PATH="$TMP/bin:$PATH" TEST_CALLS="$TMP/runner.calls" \
  E2E_DISABLE_CANONICAL_DOTENV=true E2E_ADMIN_PASSWORD=fixture-password-only \
  E2E_REPORT_PATH="$TMP/runner-report.json" \
  /bin/bash "$TMP/repo/scripts/e2e/run-issue-628-playwright.sh" >"$TMP/runner.out" 2>&1; then
  cat "$TMP/runner.out" >&2
  fail 'Playwright runner failed with an isolated lease and credential fixture'
fi
grep -q '^lease$' "$TMP/runner.calls" || fail 'runner did not validate the lease'
grep -q '^branch-profile-info$' "$TMP/runner.calls" || fail 'runner did not resolve the profile port'
grep -q '^playwright$' "$TMP/runner.calls" || fail 'runner did not launch Playwright'
printf 'PASS: Playwright runner uses the owned port and process-only credential\n'
