#!/usr/bin/env bash
set -u

FAIL=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_succeeds_dry() {
  local target="$1"
  if make -n "$target" >/dev/null 2>&1; then
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

assert_succeeds_dry minikube-start
assert_succeeds_dry minikube-deploy-all
assert_succeeds_dry minikube-sync-auth-key-if-present
assert_succeeds_dry minikube-verify-networkpolicies

assert_contains minikube-start "minikube-sync-auth-key-if-present"
assert_contains minikube-start "--context=clerum-test"
assert_contains minikube-deploy-all "minikube-sync-auth-key"
assert_contains minikube-sync-auth-key "--context=clerum-test"
assert_contains minikube-sync-auth-key "scripts/minikube/sync-auth-key.sh"
assert_contains minikube-verify-networkpolicies "verify-networkpolicies.sh --overlay minikube"
assert_contains minikube-sync-auth-key-if-present "rpc-proxy-secrets"

assert_make_contains "deployment/chatllm" minikube-deploy-service SVC=mcp-host NS=mcp-host
assert_make_contains "deployment/chatllm" minikube-restart-deploy SVC=mcp-host NS=mcp-host
assert_make_contains "deployment/control-api" minikube-deploy-service SVC=control-api NS=control-plane
assert_make_contains "deployment/custom-host" minikube-deploy-service SVC=mcp-host NS=mcp-host DEPLOYMENT=custom-host

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
  local out missing=""
  out="$(make -n -C "$REPO_ROOT" minikube-setup-e2e SKIP_PREREQS=true 2>&1)"
  grep -q -- '--only=workflow-custom-sdk-e2e' <<< "$out" || missing+="workflow-custom-sdk-e2e "
  grep -q -- '--only=workflow-plugin-sdk-e2e' <<< "$out" || missing+="workflow-plugin-sdk-e2e "
  if [ -z "$missing" ]; then
    pass "minikube-setup-e2e builds both unpublished E2E fixtures via build-images.sh --only"
  else
    fail "minikube-setup-e2e never builds: $missing"
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
assert_minikube_setup_e2e_still_uses_the_pull_path
assert_the_tag_override_reaches_the_setup_script

exit $FAIL
