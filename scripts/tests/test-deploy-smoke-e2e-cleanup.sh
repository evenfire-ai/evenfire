#!/usr/bin/env bash
set -u
FAIL=0

LEAF_SCRIPTS=(
  "scripts/e2e/e2e-agentic-workflow-baseline.sh"
  "scripts/e2e/e2e-snippet-runtime-smoke.sh"
)
SHARED_SCRIPTS=(
  "scripts/e2e/e2e-lib.sh"
)
ALL_SCRIPTS=("${LEAF_SCRIPTS[@]}" "${SHARED_SCRIPTS[@]}")

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

assert_syntax() {
  local script
  for script in "${ALL_SCRIPTS[@]}"; do
    if bash -n "$script"; then
      pass "$(basename "$script") has valid bash syntax"
    else
      fail "$(basename "$script") has invalid bash syntax"
    fi
  done
}

assert_post_run_cleanup() {
  local script body
  for script in "${LEAF_SCRIPTS[@]}"; do
    body="$(cat "$script")"
    if [[ "$body" == *"trap cleanup_on_exit EXIT"* ]] &&
       [[ "$body" == *"E2E_CREATED_RECIPE=1"* ]] &&
       [[ "$body" == *'if [ "$E2E_CREATED_RECIPE" != "1" ]; then'* ]] &&
       [[ "$body" == *'E2E_KEEP_RESOURCES'* ]]; then
      pass "$(basename "$script") runs cleanup after scripts that create the test recipe"
    else
      fail "$(basename "$script") post-run cleanup guard regressed"
    fi
  done
}

assert_context_guard() {
  local script body bare_kubectl
  for script in "${ALL_SCRIPTS[@]}"; do
    body="$(cat "$script")"
    bare_kubectl="$(grep -nE '(^|[^A-Za-z0-9_])kubectl[[:space:]]' "$script" | grep -v 'KUBECTL_BIN=' || true)"
    if [[ "$script" == *"e2e-lib.sh" ]]; then
      if [[ "$body" == *"kctl()"* ]] &&
         [[ "$body" == *'--context "$E2E_KUBECONTEXT"'* ]] &&
         [[ -z "$bare_kubectl" ]]; then
        pass "$(basename "$script") defines the guarded Kubernetes context wrapper"
      else
        fail "$(basename "$script") bypasses the guarded Kubernetes context wrapper"
      fi
      continue
    fi

    if [[ "$body" == *"require_safe_kube_context"* ]] &&
       [[ "$body" == *"kctl "* ]] &&
       [[ -z "$bare_kubectl" ]]; then
      pass "$(basename "$script") uses the guarded Kubernetes context wrapper"
    else
      fail "$(basename "$script") bypasses the guarded Kubernetes context wrapper"
    fi
  done
}

assert_destructive_scope() {
  local script delete_lines
  for script in "${ALL_SCRIPTS[@]}"; do
    delete_lines="$(grep -nE '(^|[[:space:]])(kctl|kubectl)[[:space:]]+delete' "$script" || true)"
    if printf "%s\n" "$delete_lines" | grep -Eq '(^|[[:space:]])-l([^[:space:]]|$)|--selector|--all|[*]|[$][(]|`|(^|[[:space:]])xargs([[:space:]]|$)|delete[[:space:]]+pvc|[[:space:]]pvc[[:space:]]'; then
      fail "$(basename "$script") contains broad cleanup delete syntax"
    else
      pass "$(basename "$script") cleanup deletes only exact fixture-owned names"
    fi
  done
}

assert_no_shared_data_cleanup() {
  local script delete_lines
  for script in "${ALL_SCRIPTS[@]}"; do
    delete_lines="$(grep -nE '(^|[[:space:]])(kctl|kubectl)[[:space:]]+delete' "$script" || true)"
    if [[ "$delete_lines" == *" delete pvc"* ]] || [[ "$delete_lines" == *"clerum-workflow-output"* ]]; then
      fail "$(basename "$script") attempts to delete shared workflow output data"
    else
      pass "$(basename "$script") does not delete shared PVC data"
    fi
  done
}

assert_cleanup_failures_are_fatal() {
  local script body ignored_cleanup
  for script in "${LEAF_SCRIPTS[@]}"; do
    body="$(cat "$script")"
    ignored_cleanup="$(grep -nE 'cleanup_[A-Za-z0-9_]+[[:space:]]*[|][|][[:space:]]*true' "$script" || true)"
    if [[ -z "$ignored_cleanup" ]] &&
       [[ "$body" == *"pre-run cleanup left E2E resources behind"* ]] &&
       [[ "$body" == *'exit $?'* ]]; then
      pass "$(basename "$script") treats cleanup failure as fatal"
    else
      fail "$(basename "$script") can continue after cleanup failure"
    fi
  done
}

assert_mocked_cleanup_failure_blocks_apply() {
  local script tmpdir log rc
  for script in "${LEAF_SCRIPTS[@]}"; do
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/e2e-cleanup-hardening.XXXXXX")"
    log="${tmpdir}/kubectl.log"
    cat >"${tmpdir}/kubectl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${KUBECTL_CALL_LOG:?}"
if [ "$1" = "--context" ]; then
  shift 2
fi
case "$1" in
  apply)
    printf '%s\n' "APPLY_CALLED" >>"${KUBECTL_CALL_LOG:?}"
    exit 0
    ;;
  cluster-info|get|delete)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
MOCK
    chmod +x "${tmpdir}/kubectl"

    PATH="${tmpdir}:$PATH" KUBECTL_CALL_LOG="$log" KUBECONTEXT=clerum-test \
      TIMEOUT_DELETE=0 POLL_INTERVAL=0 bash "$script" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -ne 0 ] && ! grep -Fq "APPLY_CALLED" "$log"; then
      pass "$(basename "$script") stops before apply when pre-run cleanup fails"
    else
      fail "$(basename "$script") can apply after failed pre-run cleanup"
    fi

    PATH="${tmpdir}:$PATH" KUBECTL_CALL_LOG="$log" KUBECONTEXT=clerum-test \
      TIMEOUT_DELETE=0 POLL_INTERVAL=0 bash "$script" --cleanup-only >/dev/null 2>&1
    rc=$?
    if [ "$rc" -ne 0 ]; then
      pass "$(basename "$script") --cleanup-only reports cleanup failure"
    else
      fail "$(basename "$script") --cleanup-only hides cleanup failure"
    fi
    rm -rf "$tmpdir"
  done
}

assert_deploy_dev_explicitly_allows_dev_context_only_for_smoke() {
  local workflow smoke_block
  workflow="$(cat .github/workflows/deploy-dev.yaml)"
  smoke_block="$(printf '%s\n' "$workflow" | awk '
    /^      - name: Run workflow deploy smoke E2E/ { in_block=1 }
    in_block && /^      - name:/ && !/^      - name: Run workflow deploy smoke E2E/ { exit }
    in_block { print }
  ')"

  if [[ "$smoke_block" == *"KUBECONTEXT: gke_your-gcp-project_us-central1-a_example-dev"* ]] &&
     [[ "$smoke_block" == *"E2E_ALLOWED_CONTEXTS: minikube,clerum-test,gke_your-gcp-project_us-central1-a_example-dev"* ]] &&
     [[ "$smoke_block" == *"bash scripts/e2e/e2e-snippet-runtime-smoke.sh"* ]] &&
     [[ "$workflow" != *"E2E_ALLOWED_CONTEXTS: *"* ]]; then
    pass "deploy-dev explicitly scopes smoke E2E cleanup to the example-dev context and includes Layer 3A snippet smoke"
  else
    fail "deploy-dev smoke E2E can still reject/over-broaden the dev context or miss Layer 3A snippet smoke"
  fi
}

assert_syntax
assert_post_run_cleanup
assert_context_guard
assert_destructive_scope
assert_no_shared_data_cleanup
assert_cleanup_failures_are_fatal
assert_mocked_cleanup_failure_blocks_apply
assert_deploy_dev_explicitly_allows_dev_context_only_for_smoke

exit "$FAIL"
