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
chmod +x "$TMP/bin/make" "$TMP/bin/minikube" "$TMP/bin/node"

run_case() {
  local name="$1"; shift
  TEST_CALLS="$TMP/$name.calls" TEST_IP_SEEN="$TMP/$name.ip" TEST_CASE="$name" \
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
grep -q '^branch-profile-pf$' "$TMP/stop-unobserved.calls" || fail 'unobserved stop did not restore port-forwards'
grep -q '^ISSUE628_RESTART_STOP_UNOBSERVED' "$TMP/stop-unobserved.out" || fail 'unobserved stop lacked its reason'
printf 'PASS: restart restores the profile but fails when stopped state was unobserved\n'

if ! run_case success env; then cat "$TMP/success.out" >&2; fail 'valid restart failed'; fi
[[ "$(grep -c '^lease$' "$TMP/success.calls")" -eq 2 ]] || fail 'lease was not revalidated before stop and start'
grep -q '^branch-profile-stop$' "$TMP/success.calls" || fail 'stop was not called'
grep -q '^branch-profile-start$' "$TMP/success.calls" || fail 'start was not called'
grep -q '^branch-profile-pf$' "$TMP/success.calls" || fail 'port-forwards were not restored'
grep -q '^RESTART_PHASE=stopped$' "$TMP/success.out" || fail 'stopped state was not recorded'
grep -q '^RESTART_PHASE=running$' "$TMP/success.out" || fail 'running state was not recorded'
printf '%s\n' lease branch-profile-health minikube-ip branch-profile-stop minikube-status \
  lease branch-profile-start minikube-ip branch-profile-pf branch-profile-health >"$TMP/expected-order"
cmp -s "$TMP/expected-order" "$TMP/success.calls" || fail 'restart operations ran out of order'
printf 'PASS: restart preserves the lease and restores the owned profile\n'

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
