#!/usr/bin/env bash
# Hermetic orchestration contract. These receipts prove aggregate execution and
# failure propagation, not NetworkPolicy convergence or real dataplane traffic.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGGREGATE="${ROOT}/scripts/e2e/e2e-wrc-networkpolicy-live-convergence.sh"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wrc-np-aggregate-contract.XXXXXX")"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

suites=(
  e2e-wrc-networkpolicy-service-routes.sh
  e2e-wrc-internal-dependency-networkpolicy.sh
  e2e-sandbox-ui-oauth.sh
  e2e-webhooks-basic.sh
)
CONTEXT='owned-profile-contract'
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

for script in "$AGGREGATE" "${suites[@]/#/${ROOT}/scripts/e2e/}" \
  "${ROOT}/scripts/e2e/_lib/wrc-networkpolicy-convergence.sh"; do
  if bash -n "$script"; then
    pass "$(basename "$script") has valid bash syntax"
  else
    fail "$(basename "$script") has invalid bash syntax"
  fi
done

# This is a static wiring check only. Behaviour is exercised below.
if grep -Fq 'e2e-wrc-networkpolicy-live-convergence.sh' "${ROOT}/Makefile"; then
  pass 'Makefile references the aggregate entry point (static wiring)'
else
  fail 'Makefile does not reference the aggregate entry point'
fi

mkdir -p "$FIXTURE_ROOT/scripts/e2e/_lib"
cp "$AGGREGATE" "$FIXTURE_ROOT/aggregate-original.sh"

# Only the fixture copy substitutes the external runtime/lease boundary. The
# production aggregate has no flag or environment variable to bypass it.
cat > "$FIXTURE_ROOT/scripts/e2e/_lib/wrc-networkpolicy-convergence.sh" <<'STUB'
wrc_require_networkpolicy_lease() {
  : "${KUBECONTEXT:?KUBECONTEXT is required}"
  printf 'lease|%s\n' "$KUBECONTEXT" >> "$CONTRACT_RECEIPTS"
  return "${CONTRACT_LEASE_EXIT:-0}"
}
STUB

write_children() {
  local suite
  for suite in "${suites[@]}"; do
    cat > "$FIXTURE_ROOT/scripts/e2e/$suite" <<'CHILD'
#!/usr/bin/env bash
set -euo pipefail
suite="${0##*/}"
printf 'child|%s|%s\n' "$suite" "${KUBECONTEXT-<missing>}" >> "$CONTRACT_RECEIPTS"
if [ "$suite" = "${CONTRACT_FAIL_SUITE:-}" ]; then
  exit "$CONTRACT_CHILD_EXIT"
fi
CHILD
  done
}

# Verify the exact receipts, not a name or counter appearing in source/output.
# Prefix length also proves no child after a failed/missing child was executed.
check_run() {
  local variant="$1" label="$2" expected_status="$3" child_count="$4" context_mode="$5"
  local failed_suite="${6:-}" child_exit="${7:-0}" lease_exit="${8:-0}" status=0 index marker_count
  : > "$FIXTURE_ROOT/receipts"
  : > "$FIXTURE_ROOT/expected"
  if [ "$context_mode" = 'present' ]; then
    printf 'lease|%s\n' "$CONTEXT" >> "$FIXTURE_ROOT/expected"
    for ((index = 0; index < child_count; index++)); do
      printf 'child|%s|%s\n' "${suites[$index]}" "$CONTEXT" >> "$FIXTURE_ROOT/expected"
    done
  fi

  local environment=(
    env -i PATH=/usr/bin:/bin
    "CONTRACT_RECEIPTS=$FIXTURE_ROOT/receipts"
    "CONTRACT_FAIL_SUITE=$failed_suite" "CONTRACT_CHILD_EXIT=$child_exit"
    "CONTRACT_LEASE_EXIT=$lease_exit"
  )
  case "$context_mode" in
    present) environment+=("KUBECONTEXT=$CONTEXT") ;;
    empty) environment+=(KUBECONTEXT=) ;;
    absent) ;;
    *) printf 'invalid contract context mode\n' >&2; return 1 ;;
  esac
  "${environment[@]}" bash "$FIXTURE_ROOT/scripts/e2e/e2e-wrc-networkpolicy-live-convergence.sh" \
    > "$FIXTURE_ROOT/output" 2>&1 || status=$?

  marker_count="$(awk '/WRC_NETWORKPOLICY_E2E_PASS/ { count++ } END { print count+0 }' "$FIXTURE_ROOT/output")"
  if [ "$status" -ne "$expected_status" ] ||
    ! cmp -s "$FIXTURE_ROOT/expected" "$FIXTURE_ROOT/receipts" ||
    { [ "$expected_status" -eq 0 ] &&
      { [ "$marker_count" -ne 1 ] || [ "$(tail -n 1 "$FIXTURE_ROOT/output")" != 'WRC_NETWORKPOLICY_E2E_PASS suites=4' ]; }; } ||
    { [ "$expected_status" -ne 0 ] && [ "$marker_count" -ne 0 ]; }; then
    if [ "$variant" = original ]; then
      printf 'FAIL: %s (exit=%s expected=%s, PASS markers=%s)\n' "$label" "$status" "$expected_status" "$marker_count" >&2
      diff -u "$FIXTURE_ROOT/expected" "$FIXTURE_ROOT/receipts" >&2 || true
    fi
    return 1
  fi
  if [ "$variant" = original ]; then pass "$label"; fi
}

verify_aggregate() {
  local variant="$1" rejected=0 index child_exit
  cp "$FIXTURE_ROOT/aggregate-$variant.sh" "$FIXTURE_ROOT/scripts/e2e/e2e-wrc-networkpolicy-live-convergence.sh"
  write_children
  check_run "$variant" 'lease then four unique suites execute in order with the explicit context' 0 4 present || rejected=1
  for ((index = 0; index < ${#suites[@]}; index++)); do
    child_exit=$((41 + index))
    check_run "$variant" "child $((index + 1)) failure preserves exit $child_exit and prevents later children/PASS" \
      "$child_exit" "$((index + 1))" present "${suites[$index]}" "$child_exit" || rejected=1
  done
  for ((index = 0; index < ${#suites[@]}; index++)); do
    rm -- "$FIXTURE_ROOT/scripts/e2e/${suites[$index]}"
    check_run "$variant" "missing child $((index + 1)) fails before later children/PASS" 1 "$index" present || rejected=1
    write_children
  done
  check_run "$variant" 'absent context fails before the lease or any child' 1 0 absent || rejected=1
  check_run "$variant" 'empty context fails before the lease or any child' 1 0 empty || rejected=1
  check_run "$variant" 'lease rejection propagates before any child or PASS' 67 0 present '' 0 67 || rejected=1
  return "$rejected"
}

if ! verify_aggregate original; then fail 'real aggregate violates its execution contract'; fi

# Mutation controls prove the contract cannot be fooled by keeping the suite
# names, executed counter, set -e, and terminal PASS text while removing the work
# or masking child failure. They mutate only a disposable aggregate copy.
for mutation in skipped-child ignored-error; do
  if ! awk -v mutation="$mutation" '
    /KUBECONTEXT="\$KUBECONTEXT" bash "\$path"/ {
      count++
      if (mutation == "skipped-child") {
        sub(/KUBECONTEXT="\$KUBECONTEXT" bash "\$path"/, ": # skipped child")
      } else {
        sub(/KUBECONTEXT="\$KUBECONTEXT" bash "\$path"/, "KUBECONTEXT=\"$KUBECONTEXT\" bash \"$path\" || true")
      }
    }
    { print }
    END { if (count != 1) exit 1 }
  ' "$FIXTURE_ROOT/aggregate-original.sh" > "$FIXTURE_ROOT/aggregate-$mutation.sh"; then
    fail "cannot construct $mutation mutation; update its injection site"
    continue
  fi
  if verify_aggregate "$mutation"; then
    fail "contract accepted $mutation despite preserved names/counter/PASS"
  else
    pass "contract rejects $mutation despite preserved names/counter/PASS"
  fi
done

exit "$FAIL"
