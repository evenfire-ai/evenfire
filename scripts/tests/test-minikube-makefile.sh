#!/usr/bin/env bash
set -u

FAIL=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_succeeds_dry() {
  local target="$1"
  if make -n MAKE=: "$target" >/dev/null 2>&1; then
    echo "PASS: make -n $target parses"
  else
    echo "FAIL: make -n $target failed to parse"
    FAIL=1
  fi
}

assert_contains() {
  local target="$1" needle="$2"
  local out
  out="$(make -n "$target" 2>&1 || true)"
  if [[ "$out" == *"$needle"* ]]; then
    echo "PASS: make -n $target contains '$needle'"
  else
    echo "FAIL: make -n $target missing '$needle'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

assert_file_contains() {
  local path="$1" needle="$2"
  if grep -Fq -- "$needle" "$REPO_ROOT/$path"; then
    echo "PASS: $path contains '$needle'"
  else
    echo "FAIL: $path missing '$needle'"
    FAIL=1
  fi
}

assert_file_not_contains() {
  local path="$1" needle="$2"
  if grep -Fq -- "$needle" "$REPO_ROOT/$path"; then
    echo "FAIL: $path unexpectedly contains '$needle'"
    FAIL=1
  else
    echo "PASS: $path omits '$needle'"
  fi
}

assert_not_contains() {
  local target="$1" needle="$2"
  local out
  out="$(make -n "$target" 2>&1 || true)"
  if [[ "$out" == *"$needle"* ]]; then
    echo "FAIL: make -n $target unexpectedly contains '$needle'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  else
    echo "PASS: make -n $target omits '$needle'"
  fi
}

assert_make_contains() {
  local needle="$1"
  shift
  local out
  out="$(make -n "$@" 2>&1 || true)"
  if [[ "$out" == *"$needle"* ]]; then
    echo "PASS: make -n $* contains '$needle'"
  else
    echo "FAIL: make -n $* missing '$needle'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

assert_deploy_rejected_without_mutation() {
  local stub_root="$1" description="$2" target="$3" expected_lock="$4" expected_error="$5"
  shift 5
  local mutation_log="$stub_root/mutations.log"
  local lock_log="$stub_root/lock.log"
  local output_file="$stub_root/output.log"
  local status=0 problem=""

  : > "$mutation_log"
  : > "$lock_log"
  if PATH="$stub_root/bin:$PATH" FAKE_MUTATION_LOG="$mutation_log" FAKE_LOCK_LOG="$lock_log" \
    make -C "$stub_root" "$target" "$@" >"$output_file" 2>&1; then
    problem+="unexpectedly succeeded; "
  else
    status=$?
  fi

  if [ "$status" -eq 0 ]; then
    problem+="exit status was zero; "
  fi
  if ! grep -Fq -- "$expected_error" "$output_file"; then
    problem+="missing error '$expected_error'; "
  fi
  if [ -s "$mutation_log" ]; then
    problem+="ran mutation commands: $(<"$mutation_log"); "
  fi
  if [ "$expected_lock" = true ]; then
    grep -Fxq 'lock-check' "$lock_log" || problem+="body validation did not follow the lock check; "
  elif [ -s "$lock_log" ]; then
    problem+="public validation acquired the mutation lock; "
  fi

  if [ -z "$problem" ]; then
    pass "$description fails before image build or deployment"
  else
    fail "$description: $problem output=$(<"$output_file")"
  fi
}

assert_deploy_runs_expected_fake_commands() {
  local stub_root="$1" description="$2" selector="$3" namespace="$4" deployment="$5" target="$6"
  shift 6
  local mutation_log="$stub_root/mutations.log"
  local lock_log="$stub_root/lock.log"
  local output_file="$stub_root/output.log"
  local problem="" calls expected_calls

  : > "$mutation_log"
  : > "$lock_log"
  if ! PATH="$stub_root/bin:$PATH" FAKE_MUTATION_LOG="$mutation_log" FAKE_LOCK_LOG="$lock_log" \
    make -C "$stub_root" "$target" "$@" >"$output_file" 2>&1; then
    fail "$description failed: $(<"$output_file")"
    return
  fi

  [ "$(<"$lock_log")" = 'lock-check' ] || problem+="unexpected lock sequence; "
  calls="$(<"$mutation_log")"
  printf -v expected_calls \
    'build --only=%s\nkubectl --context=clerum-test -n %s rollout restart deployment/%s\nkubectl --context=clerum-test -n %s rollout status deployment/%s --timeout=180s' \
    "$selector" "$namespace" "$deployment" "$namespace" "$deployment"
  [ "$calls" = "$expected_calls" ] || problem+="unexpected mutation sequence; "

  if [ -z "$problem" ]; then
    pass "$description preserves its targeted build/deploy mapping"
  else
    fail "$description: $problem calls=$(<"$mutation_log")"
  fi
}

assert_minikube_deploy_service_fail_fast() {
  local stub_root
  stub_root="$(mktemp -d)"
  mkdir -p "$stub_root/bin" "$stub_root/scripts/minikube"
  cp "$REPO_ROOT/Makefile" "$stub_root/Makefile"

  cat > "$stub_root/scripts/minikube/with-t2-mutation-lock.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
[ "${1:-}" = "--" ] || exit 2
shift
exec "$@"
STUB
  cat > "$stub_root/scripts/minikube/require-t2-mutation-lock.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
printf '%s\n' 'lock-check' >> "${FAKE_LOCK_LOG:?}"
STUB
  cat > "$stub_root/scripts/minikube/build-images.sh" <<'STUB'
#!/usr/bin/env bash
set -eu
printf 'build %s\n' "$*" >> "${FAKE_MUTATION_LOG:?}"
STUB
  cat > "$stub_root/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -eu
printf 'kubectl %s\n' "$*" >> "${FAKE_MUTATION_LOG:?}"
STUB
  chmod +x "$stub_root/scripts/minikube/build-images.sh" "$stub_root/bin/kubectl"

  assert_deploy_rejected_without_mutation "$stub_root" "public target with missing SVC" \
    minikube-deploy-service false "ERROR: SVC required" NS=control-plane DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "public target with empty SVC" \
    minikube-deploy-service false "ERROR: SVC required" SVC= NS=control-plane DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "public target with whitespace SVC" \
    minikube-deploy-service false "ERROR: SVC required" "SVC=   " NS=control-plane DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "public target with unsupported SVC" \
    minikube-deploy-service false "ERROR: unsupported SVC selector" SVC=unknown NS=control-plane DEPLOYMENT=unknown
  assert_deploy_rejected_without_mutation "$stub_root" "public target with missing NS" \
    minikube-deploy-service false "ERROR: NS required" SVC=control-api DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "public target with empty NS" \
    minikube-deploy-service false "ERROR: NS required" SVC=control-api NS= DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "public target with whitespace NS" \
    minikube-deploy-service false "ERROR: NS required" SVC=control-api "NS=   " DEPLOYMENT=control-api

  # The private body is callable directly, so it repeats every input check
  # after proving that the caller holds the mutation lease and before either
  # fake mutator can record a call.
  assert_deploy_rejected_without_mutation "$stub_root" "body target with missing SVC" \
    minikube-deploy-service-body true "ERROR: SVC required" NS=control-plane DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "body target with empty SVC" \
    minikube-deploy-service-body true "ERROR: SVC required" SVC= NS=control-plane DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "body target with whitespace SVC" \
    minikube-deploy-service-body true "ERROR: SVC required" "SVC=   " NS=control-plane DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "body target with unsupported SVC" \
    minikube-deploy-service-body true "ERROR: unsupported SVC selector" SVC=unknown NS=control-plane DEPLOYMENT=unknown
  assert_deploy_rejected_without_mutation "$stub_root" "body target with missing NS" \
    minikube-deploy-service-body true "ERROR: NS required" SVC=control-api DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "body target with empty NS" \
    minikube-deploy-service-body true "ERROR: NS required" SVC=control-api NS= DEPLOYMENT=control-api
  assert_deploy_rejected_without_mutation "$stub_root" "body target with whitespace NS" \
    minikube-deploy-service-body true "ERROR: NS required" SVC=control-api "NS=   " DEPLOYMENT=control-api

  assert_deploy_runs_expected_fake_commands "$stub_root" "omitted mcp-host DEPLOYMENT" \
    mcp-host mcp-host chatllm minikube-deploy-service SVC=mcp-host NS=mcp-host
  assert_deploy_runs_expected_fake_commands "$stub_root" "empty mcp-host DEPLOYMENT" \
    mcp-host mcp-host chatllm minikube-deploy-service SVC=mcp-host NS=mcp-host DEPLOYMENT=
  assert_deploy_runs_expected_fake_commands "$stub_root" "whitespace mcp-host DEPLOYMENT" \
    mcp-host mcp-host chatllm minikube-deploy-service-body \
    SVC=mcp-host NS=mcp-host "DEPLOYMENT=   "
  assert_deploy_runs_expected_fake_commands "$stub_root" "control-api identity default" \
    control-api control-plane control-api minikube-deploy-service-body SVC=control-api NS=control-plane
  assert_deploy_runs_expected_fake_commands "$stub_root" "control-ui identity default" \
    control-ui control-plane control-ui minikube-deploy-service-body SVC=control-ui NS=control-plane
  assert_deploy_runs_expected_fake_commands "$stub_root" "external-rest-api identity default" \
    external-rest-api profiles external-rest-api minikube-deploy-service-body SVC=external-rest-api NS=profiles
  assert_deploy_runs_expected_fake_commands "$stub_root" "profile-ui identity default" \
    profile-ui profiles profile-ui minikube-deploy-service-body SVC=profile-ui NS=profiles
  assert_deploy_runs_expected_fake_commands "$stub_root" "rpc-proxy identity default" \
    rpc-proxy rpc-proxy rpc-proxy minikube-deploy-service-body SVC=rpc-proxy NS=rpc-proxy
  assert_deploy_runs_expected_fake_commands "$stub_root" "hcc explicit deployment" \
    hcc control-plane host-context-controller minikube-deploy-service-body \
    SVC=hcc NS=control-plane DEPLOYMENT=host-context-controller
  assert_deploy_runs_expected_fake_commands "$stub_root" "custom mcp-host override" \
    mcp-host mcp-host custom-host minikube-deploy-service \
    SVC=mcp-host NS=mcp-host DEPLOYMENT=custom-host

  rm -rf "$stub_root"
}

assert_succeeds_dry minikube-start
assert_succeeds_dry minikube-deploy-all
assert_succeeds_dry minikube-deploy-all-body
assert_succeeds_dry minikube-verify-networkpolicies

assert_contains minikube-start "minikube-sync-auth-key-if-present"
assert_contains minikube-start "--context=clerum-test"
assert_contains minikube-start "MINIKUBE_STARTUP_AUTH_SYNC_MODE=shared-profile-mcp"
assert_contains minikube-start "docker-cli-env.sh --check-info"
assert_contains minikube-start "docker-cli-env.sh --wait-for-info"
assert_contains minikube-start 'MINIKUBE_DOCKER_START_TIMEOUT_SECONDS'
assert_contains minikube-start 'open -a "Docker Desktop"'
assert_not_contains minikube-start "docker info"
assert_contains minikube-deploy-all "with-t2-mutation-lock.sh"
assert_contains minikube-deploy-all-body "minikube-sync-auth-key"
assert_contains minikube-build-images "with-t2-mutation-lock.sh"
assert_contains minikube-build-images-body "require-t2-mutation-lock.sh"
assert_contains minikube-build-custom-coordinator-fixture "with-t2-mutation-lock.sh"
assert_contains minikube-build-custom-coordinator-fixture-body "require-t2-mutation-lock.sh"
assert_contains minikube-build-e2e-fixtures "with-t2-mutation-lock.sh"
assert_contains minikube-build-e2e-fixtures-body "require-t2-mutation-lock.sh"
assert_contains minikube-setup-e2e "minikube-build-e2e-fixtures"
assert_not_contains minikube-verify-images "with-t2-mutation-lock.sh"
assert_contains minikube-deploy-service "with-t2-mutation-lock.sh"
assert_contains minikube-deploy-service-body "require-t2-mutation-lock.sh"
assert_contains minikube-deploy-service "unsupported SVC selector"
assert_contains minikube-deploy-service-body "unsupported SVC selector"
assert_contains minikube-deploy-service "effective DEPLOYMENT could not be resolved from SVC"
assert_contains minikube-deploy-service-body "effective DEPLOYMENT could not be resolved from SVC"
assert_contains minikube-restart-deploy "with-t2-mutation-lock.sh"
assert_contains minikube-restart-deploy-body "require-t2-mutation-lock.sh"
assert_contains minikube-restart-deploy "unsupported SVC selector"
assert_contains minikube-restart-deploy-body "unsupported SVC selector"
assert_contains minikube-sync-auth-key "with-t2-mutation-lock.sh"
assert_contains minikube-sync-auth-key-body "--context=clerum-test"
assert_contains minikube-sync-auth-key-body "scripts/minikube/sync-auth-key.sh"
assert_contains minikube-verify-networkpolicies "verify-networkpolicies.sh --overlay minikube"
assert_contains minikube-sync-auth-key-if-present "rpc-proxy-secrets"
assert_file_contains Makefile "T2_MUTATION_LOCK_WRAPPED"
# Literal Make syntax, not shell expansion.
# shellcheck disable=SC2016
assert_file_contains Makefile 'DEPLOYMENT ?= $(call minikube_deployment,$(MINIKUBE_DEPLOY_SERVICE))'
# shellcheck disable=SC2016
assert_file_contains Makefile 'MINIKUBE_EFFECTIVE_DEPLOYMENT := $(or $(strip $(DEPLOYMENT)),$(call minikube_deployment,$(MINIKUBE_DEPLOY_SERVICE)))'
assert_file_not_contains Makefile "MINIKUBE_DEPLOYMENT"
assert_contains minikube-sync-auth-key-if-present "minikube-sync-auth-key"
assert_contains minikube-sync-auth-key-if-present "NotFound"
assert_contains minikube-sync-auth-key-if-present "rpc_probe_status"
assert_not_contains minikube-sync-auth-key-if-present "canonical T2 profile lock is not held"
assert_contains minikube-sync-auth-key-shared-profile "--shared-profile-bootstrap"
assert_not_contains minikube-sync-auth-key-shared-profile "with-t2-mutation-lock.sh"
assert_file_contains scripts/minikube/sync-auth-key.sh "--shared-profile-bootstrap"
assert_contains minikube-deploy-all-body "set -o pipefail"
assert_contains minikube-deploy-all-body "mktemp"
assert_contains minikube-deploy-all-body "filtered_manifest"
assert_contains minikube-deploy-crds-body '!= "true"'

assert_make_contains "deployment/chatllm" minikube-deploy-service-body SVC=mcp-host NS=mcp-host
assert_make_contains "deployment/chatllm" minikube-restart-deploy-body SVC=mcp-host NS=mcp-host
assert_make_contains "deployment/chatllm" minikube-restart-deploy-body SVC=mcp-host NS=mcp-host DEPLOYMENT=
assert_make_contains "deployment/control-api" minikube-deploy-service-body SVC=control-api NS=control-plane
assert_make_contains "deployment/control-ui" minikube-deploy-service-body SVC=control-ui NS=control-plane
assert_make_contains "deployment/external-rest-api" minikube-deploy-service-body SVC=external-rest-api NS=profiles
assert_make_contains "deployment/profile-ui" minikube-deploy-service-body SVC=profile-ui NS=profiles
assert_make_contains "deployment/rpc-proxy" minikube-deploy-service-body SVC=rpc-proxy NS=rpc-proxy
assert_make_contains "deployment/host-context-controller" minikube-deploy-service-body SVC=hcc NS=control-plane DEPLOYMENT=host-context-controller
assert_make_contains "deployment/custom-host" minikube-deploy-service-body SVC=mcp-host NS=mcp-host DEPLOYMENT=custom-host
assert_make_contains "deployment/custom-host" minikube-restart-deploy-body SVC=mcp-host NS=mcp-host DEPLOYMENT=custom-host

assert_minikube_deploy_service_fail_fast

# `make minikube-setup` is the first command a new contributor runs. Its
# default has to be the fast path, and the slow path has to be a named target
# rather than an env var people have to know about.
# Reads the resolved value out of the dry-run text instead of grepping for the
# absence of a substring: an unquoted-substring check (`! grep IMAGE_SOURCE=local`)
# passes vacuously once the printed form is quoted (`IMAGE_SOURCE="local"`), which
# would let a flipped `IMAGE_SOURCE ?= ghcr` default through undetected. This only
# covers the Makefile's own default -- it cannot see a compiled-in default changed
# inside full-setup.sh/build-images.sh (`${IMAGE_SOURCE:-local}`), since the
# Makefile always forwards an explicit value to those scripts. That layer is
# test-minikube-full-setup.sh's job, not this harness's.
assert_minikube_setup_defaults_to_ghcr() {
  local out resolved
  out="$(make -n -C "$REPO_ROOT" minikube-setup SKIP_PREREQS=true 2>&1)"
  resolved="$(grep -o 'IMAGE_SOURCE="[^"]*"' <<< "$out" | head -1)"
  if [ "$resolved" = 'IMAGE_SOURCE="ghcr"' ]; then
    pass "minikube-setup defaults IMAGE_SOURCE to ghcr"
  else
    fail "minikube-setup did not resolve IMAGE_SOURCE to ghcr (got '${resolved:-<none>}'): $out"
  fi
}

assert_minikube_setup_local_forces_the_build() {
  local out
  out="$(make -n -C "$REPO_ROOT" minikube-setup-local SKIP_PREREQS=true 2>&1)"
  if grep -q 'IMAGE_SOURCE=local' <<< "$out"; then
    pass "minikube-setup-local forces IMAGE_SOURCE=local"
  else
    fail "minikube-setup-local does not force a local build: $out"
  fi
}

assert_minikube_pull_images_mirrors_build_images() {
  local out
  out="$(make -n -C "$REPO_ROOT" minikube-pull-images 2>&1)"
  if grep -q 'scripts/minikube/pull-images.sh' <<< "$out"; then
    pass "minikube-pull-images invokes the puller"
  else
    fail "minikube-pull-images does not invoke pull-images.sh: $out"
  fi
}

# The two E2E coordinator fixtures are published:false, so the pull path cannot
# supply them. They must be built through the EXISTING --only flag rather than
# a second build entry point.
assert_minikube_setup_e2e_builds_both_fixtures() {
  local setup_out body_out missing=""
  setup_out="$(make -n -C "$REPO_ROOT" minikube-setup-e2e SKIP_PREREQS=true 2>&1)"
  body_out="$(make -n -C "$REPO_ROOT" minikube-build-e2e-fixtures-body 2>&1)"
  grep -q -- 'minikube-build-e2e-fixtures' <<< "$setup_out" \
    || missing+="leased fixture target "
  grep -q -- '--only=workflow-custom-sdk-e2e' <<< "$body_out" \
    || missing+="workflow-custom-sdk-e2e "
  grep -q -- '--only=workflow-plugin-sdk-e2e' <<< "$body_out" \
    || missing+="workflow-plugin-sdk-e2e "
  if [ -z "$missing" ]; then
    pass "minikube-setup-e2e builds both unpublished E2E fixtures via build-images.sh --only"
  else
    fail "minikube-setup-e2e never builds: $missing"
  fi
}

# `make -n` never evaluates a shell `if` embedded in a recipe -- it only
# substitutes make variables into the recipe text and echoes it verbatim. So
# `assert_minikube_setup_e2e_builds_both_fixtures` above proves the --only
# calls exist in the recipe text, but NOT that they are gated on IMAGE_SOURCE;
# flipping Makefile's `[ "$(IMAGE_SOURCE)" = "ghcr" ]` to `= "local"` still
# prints the exact same body (verified live: both modes dry-run identically,
# only the printed comparison operand differs), so that grep-based check
# cannot see the inversion.
#
# This extracts the REAL if/fi block from `make -n`'s output -- anchored on
# the mode-independent "Building the two unpublished..." echo text, with the
# enclosing `if [`/`\tfi` bounds found structurally rather than by line
# number -- and `eval`s it for real (not `-n`) against a stubbed
# recursive fixture target, once per IMAGE_SOURCE value. That is genuine
# evaluated behaviour: the fixtures must be built in ghcr mode and must NOT be
# built in local mode (full-setup.sh's own local build already covers them; a
# second build here would waste minutes on every `minikube-setup-local`+e2e
# run). The stub Makefile below models only that recursive target; lease
# enforcement itself is covered by test-minikube-mutation-boundary.sh.
extract_minikube_setup_e2e_fixture_recipe() {
  local mode="$1"
  make -n -C "$REPO_ROOT" minikube-setup-e2e SKIP_PREREQS=true IMAGE_SOURCE="$mode" 2>&1 | awk '
    { line[NR] = $0 }
    /Building the two unpublished E2E coordinator fixtures/ { echo_ln = NR }
    END {
      if (echo_ln == 0) { exit 1 }
      start = echo_ln
      while (start > 1 && line[start] !~ /^if \[/) start--
      end = echo_ln
      while (end < NR && line[end] !~ /^\tfi$/) end++
      for (i = start; i <= end; i++) print line[i]
    }
  '
}

assert_minikube_setup_e2e_fixtures_are_gated_on_evaluated_image_source() {
  local mode recipe stub_root call_log problem=""
  for mode in ghcr local; do
    recipe="$(extract_minikube_setup_e2e_fixture_recipe "$mode")"
    if [ -z "$recipe" ]; then
      problem+="could not locate the fixture-build if/fi block for mode=$mode; "
      continue
    fi
    stub_root="$(mktemp -d)"
    mkdir -p "$stub_root/scripts/minikube"
    call_log="$stub_root/calls.log"
    : > "$call_log"
    cat > "$stub_root/scripts/minikube/build-images.sh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$call_log"
STUB
    cat > "$stub_root/Makefile" <<'STUB'
.PHONY: minikube-build-e2e-fixtures
minikube-build-e2e-fixtures:
	@scripts/minikube/build-images.sh --only=workflow-custom-sdk-e2e
	@scripts/minikube/build-images.sh --only=workflow-plugin-sdk-e2e
STUB
    chmod +x "$stub_root/scripts/minikube/build-images.sh"

    ( cd "$stub_root" && eval "$recipe" ) >/dev/null 2>&1

    local calls
    calls="$(cat "$call_log")"
    if [ "$mode" = ghcr ]; then
      grep -q -- '--only=workflow-custom-sdk-e2e' <<< "$calls" || problem+="ghcr mode (evaluated) never builds workflow-custom-sdk-e2e; "
      grep -q -- '--only=workflow-plugin-sdk-e2e' <<< "$calls" || problem+="ghcr mode (evaluated) never builds workflow-plugin-sdk-e2e; "
    else
      [ -z "$calls" ] || problem+="local mode (evaluated) wrongly built E2E fixtures: $calls; "
    fi
    rm -rf "$stub_root"
  done
  if [ -z "$problem" ]; then
    pass "minikube-setup-e2e's evaluated conditional builds the E2E fixtures in ghcr mode only"
  else
    fail "$problem"
  fi
}

# The E2E path must not silently fall back to a full local build; that is the
# 20-minute wait this whole change removes.
assert_minikube_setup_e2e_still_uses_the_pull_path() {
  local out
  out="$(make -n -C "$REPO_ROOT" minikube-setup-e2e SKIP_PREREQS=true 2>&1)"
  if grep -q 'IMAGE_SOURCE=local' <<< "$out"; then
    fail "minikube-setup-e2e forces a full local build: $out"
  else
    pass "minikube-setup-e2e keeps the pull path and only adds the fixtures"
  fi
}

assert_the_tag_override_reaches_the_setup_script() {
  local out
  out="$(make -n -C "$REPO_ROOT" minikube-setup SKIP_PREREQS=true MINIKUBE_IMAGE_TAG=latest 2>&1)"
  if grep -q 'MINIKUBE_IMAGE_TAG="\?latest' <<< "$out"; then
    pass "MINIKUBE_IMAGE_TAG on the make command line reaches full-setup.sh"
  else
    fail "MINIKUBE_IMAGE_TAG did not reach the script: $out"
  fi
}

assert_minikube_setup_defaults_to_ghcr
assert_minikube_setup_local_forces_the_build
assert_minikube_pull_images_mirrors_build_images
assert_minikube_setup_e2e_builds_both_fixtures
assert_minikube_setup_e2e_fixtures_are_gated_on_evaluated_image_source
assert_minikube_setup_e2e_still_uses_the_pull_path
assert_the_tag_override_reaches_the_setup_script

# Resource probes may skip only an explicit NotFound. A forbidden/API failure
# must stop the target before it can certify a partially reachable profile.
assert_auth_probe_error_handling() {
  local stub_root output status
  stub_root="$(mktemp -d)"
  output="$stub_root/output"
  cat > "$stub_root/kubectl" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *"get configmap mcp-host-config"* ]]; then
  printf '%s\n' "${KUBECTL_MCP_PROBE_ERROR:-${KUBECTL_PROBE_ERROR:-}}" >&2
  exit "${KUBECTL_MCP_PROBE_STATUS:-${KUBECTL_PROBE_STATUS:-1}}"
fi
printf '%s\n' "${KUBECTL_PROBE_ERROR:-}" >&2
exit "${KUBECTL_PROBE_STATUS:-1}"
STUB
  chmod +x "$stub_root/kubectl"

  if KUBECTL_PROBE_ERROR='Error from server (NotFound): secrets "rpc-proxy-secrets" not found' \
    PATH="$stub_root:$PATH" make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    pass "minikube-sync-auth-key-if-present skips an explicit NotFound"
  else
    fail "minikube-sync-auth-key-if-present did not skip an explicit NotFound: $(cat "$output")"
  fi

  if KUBECTL_PROBE_ERROR='Error from server (NotFound): configmaps "rpc-proxy-secrets" not found' \
    PATH="$stub_root:$PATH" make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    fail "minikube-sync-auth-key-if-present confused a wrong-kind NotFound with the Secret probe"
  else
    status=$?
    if [ "$status" -ne 0 ]; then
      pass "minikube-sync-auth-key-if-present rejects a wrong-kind NotFound"
    else
      fail "minikube-sync-auth-key-if-present returned an unexpected status for a wrong-kind NotFound"
    fi
  fi

  if KUBECTL_PROBE_STATUS=0 \
    KUBECTL_MCP_PROBE_ERROR='Error from server (NotFound): configmaps "mcp-host-config" not found' \
    KUBECTL_MCP_PROBE_STATUS=1 PATH="$stub_root:$PATH" \
    make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    pass "minikube-sync-auth-key-if-present skips an explicit ConfigMap NotFound"
  else
    fail "minikube-sync-auth-key-if-present did not skip an explicit ConfigMap NotFound: $(cat "$output")"
  fi

  if KUBECTL_PROBE_ERROR='Error from server (Forbidden): secrets is forbidden' \
    PATH="$stub_root:$PATH" make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    fail "minikube-sync-auth-key-if-present swallowed a Forbidden probe error: $(cat "$output")"
  else
    status=$?
    if [ "$status" -ne 0 ]; then
      pass "minikube-sync-auth-key-if-present fails closed on a Forbidden probe error"
    else
      fail "minikube-sync-auth-key-if-present returned an unexpected status for a Forbidden probe error"
    fi
  fi

  if KUBECTL_PROBE_STATUS=0 \
    KUBECTL_MCP_PROBE_ERROR='Error from server (Forbidden): configmaps is forbidden' \
    KUBECTL_MCP_PROBE_STATUS=1 PATH="$stub_root:$PATH" \
    make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    fail "minikube-sync-auth-key-if-present swallowed a ConfigMap Forbidden probe error: $(cat "$output")"
  else
    status=$?
    if [ "$status" -ne 0 ]; then
      pass "minikube-sync-auth-key-if-present fails closed on a ConfigMap Forbidden probe error"
    else
      fail "minikube-sync-auth-key-if-present returned an unexpected status for a ConfigMap Forbidden probe error"
    fi
  fi

  if KUBECTL_PROBE_ERROR='/bin/bash: kubectl: command not found' \
    KUBECTL_PROBE_STATUS=127 PATH="$stub_root:$PATH" \
    make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    fail "minikube-sync-auth-key-if-present swallowed command-not-found"
  else
    status=$?
    if [ "$status" -ne 0 ] && grep -Fq 'command not found' "$output"; then
      pass "minikube-sync-auth-key-if-present propagates command-not-found"
    else
      fail "minikube-sync-auth-key-if-present did not preserve command-not-found failure: status=$status output=$(cat "$output")"
    fi
  fi

  if KUBECTL_PROBE_ERROR='Unable to connect to the server: net/http: TLS handshake timeout' \
    KUBECTL_PROBE_STATUS=1 PATH="$stub_root:$PATH" \
    make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    fail "minikube-sync-auth-key-if-present swallowed a timeout probe error"
  else
    status=$?
    if [ "$status" -ne 0 ]; then
      pass "minikube-sync-auth-key-if-present propagates timeout probe errors"
    else
      fail "minikube-sync-auth-key-if-present returned an unexpected status for a timeout probe error"
    fi
  fi

  if KUBECTL_PROBE_ERROR='error: context "probe-contract" does not exist' \
    KUBECTL_PROBE_STATUS=1 PATH="$stub_root:$PATH" \
    make -C "$REPO_ROOT" minikube-sync-auth-key-if-present \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    fail "minikube-sync-auth-key-if-present swallowed a context probe error"
  else
    status=$?
    if [ "$status" -ne 0 ]; then
      pass "minikube-sync-auth-key-if-present propagates context probe errors"
    else
      fail "minikube-sync-auth-key-if-present returned an unexpected status for a context probe error"
    fi
  fi

  if KUBECTL_PROBE_STATUS=0 KUBECTL_MCP_PROBE_STATUS=0 PATH="$stub_root:$PATH" \
    make -C "$REPO_ROOT" minikube-sync-auth-key-if-present MAKE=: \
    MINIKUBE_PROFILE=probe-contract >"$output" 2>&1; then
    pass "minikube-sync-auth-key-if-present proceeds when both probes succeed"
  else
    fail "minikube-sync-auth-key-if-present rejected successful probes: $(cat "$output")"
  fi
  rm -rf "$stub_root"
}

assert_auth_probe_error_handling

exit $FAIL
