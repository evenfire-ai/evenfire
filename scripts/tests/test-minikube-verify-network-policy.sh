#!/usr/bin/env bash
set -u
FAIL=0

# `make minikube-verify-network-policy` probes NetworkPolicy enforcement with
# pods built from clerum/workflow-custom-sdk-e2e:test. That ref is an E2E-ONLY
# FIXTURE (published:false + e2e_only:true in deploy/images.json): before this
# branch every setup built it, so the target worked on any cluster. Now the
# default `make minikube-setup` PULLS published images and never builds it, and
# the target itself builds nothing -- deliberately, because a verification
# script that acquires images makes the thing it verifies depend on the act of
# verifying it.
#
# Reproduced: fresh default setup, then `make minikube-verify-network-policy` ->
# every probe pod in ErrImageNeverPull, a 90s wait, and a failure that reads as
# broken enforcement.
#
# Every case runs the REAL script against PATH stubs for minikube/kubectl, so
# nothing here needs a cluster or a network. The assertions observe what the
# script DID -- which image it looked for, whether it touched the cluster at all
# -- so inverting the preflight's test (or wrapping it in `if false && ...`)
# fails them; renaming an identifier is not what they detect.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/minikube/verify-network-policy-enforcement.sh"
PROBE_REF="clerum/workflow-custom-sdk-e2e:test"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# The daemon listing the stub serves, minus the probe image: enough other refs
# that "not found" cannot come from an empty list.
OTHER_REFS='docker.io/clerum/control-api:test
ghcr.io/evenfire-ai/control-api:latest
ghcr.io/evenfire-ai/workflow-recipes:latest
registry.k8s.io/pause:3.9'

make_stubs() {
  local d=$1
  mkdir -p "$d/bin"
  # `image ls` serves the declared listing; TEST_MINIKUBE_LS_RC makes the read
  # itself fail, which is a different case from "the image is absent".
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *"image ls"*)
    if [ "${TEST_MINIKUBE_LS_RC:-0}" != "0" ]; then
      echo "minikube: simulated daemon failure" >&2
      exit "${TEST_MINIKUBE_LS_RC}"
    fi
    cat "${TEST_IMAGE_LIST_FILE:?}"
    exit 0
    ;;
esac
exit 0
STUB
  # Answers just enough for the script to get past its cluster preconditions and
  # apply the server pod; the Ready wait then fails, which ends the run without
  # a 90s timeout. Everything is logged so "did it touch the cluster?" is an
  # observation, not an inference.
  cat > "$d/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *"k8s-app=calico-node"*) echo "calico-node-abcde  1/1  Running  0  1d"; exit 0 ;;
  *wait*) echo "error: timed out waiting for the condition" >&2; exit 1 ;;
esac
exit 0
STUB
  chmod +x "$d/bin/minikube" "$d/bin/kubectl"
}

# $2 is the newline-separated listing the stubbed daemon holds.
prepare() {
  local d=$1 listing=$2
  make_stubs "$d"
  printf '%s\n' "$listing" > "$d/images.txt"
  : > "$d/ops.log"
}

# One namespace keeps the run short; the preflight is not per-namespace logic.
run_verify_np() {
  local d=$1; shift
  env "$@" \
    PATH="$d/bin:$PATH" \
    TEST_LOG_FILE="$d/ops.log" \
    TEST_IMAGE_LIST_FILE="$d/images.txt" \
    CONTEXT=clerum-test \
    NAMESPACES=sandbox-recipes \
    bash "$SCRIPT" 2>&1
}

# ---------------------------------------------------------------------------

# The reported failure. The remedy has to name the target that supplies the
# image, and nothing may be applied to the cluster first: a half-applied probe
# leaves pods and NetworkPolicies behind for the next run to trip over.
assert_a_missing_probe_image_fails_before_the_cluster_is_touched() {
  local d out rc problems=""
  d="$(mktemp -d)"
  prepare "$d" "$OTHER_REFS"
  out="$(run_verify_np "$d")"
  rc=$?
  [ "$rc" -ne 0 ] || problems+="exited 0 with the probe image absent; "
  grep -Fq "$PROBE_REF" <<< "$out" || problems+="the error did not name the missing image; "
  grep -Fq 'make minikube-build-custom-coordinator-fixture' <<< "$out" \
    || problems+="the error did not name the target that builds it; "
  # It looked, and it looked in the right profile.
  grep -Fq 'minikube -p clerum-test image ls' "$d/ops.log" \
    || problems+="the preflight never listed the profile's images; "
  # And it stopped there.
  if grep -q '^kubectl' "$d/ops.log"; then
    problems+="the cluster was touched anyway: $(grep -c '^kubectl' "$d/ops.log") kubectl call(s); "
  fi
  if [ -z "$problems" ]; then
    pass "a missing probe image fails immediately, naming the image and the target that builds it"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

# The complement, so the fix cannot be "always fail": a cluster that HAS the
# fixture proceeds to the probe. minikube prints the docker.io-normalised
# spelling, and a hand-loaded image can carry the plain one, so both must pass.
assert_a_present_probe_image_passes_the_preflight() {
  local d out rc listing spelling problems=""
  for spelling in "$PROBE_REF" "docker.io/${PROBE_REF}"; do
    d="$(mktemp -d)"
    listing="${OTHER_REFS}"$'\n'"${spelling}"
    prepare "$d" "$listing"
    out="$(run_verify_np "$d")"
    rc=$?
    # The run still ends non-zero: the stubbed Ready wait fails on purpose, so
    # the case cannot pass by the script doing nothing at all.
    grep -Fq 'is not loaded in minikube profile' <<< "$out" \
      && problems+="[${spelling}] the preflight rejected a present image; "
    grep -Fq 'kubectl --context=clerum-test apply' "$d/ops.log" \
      || problems+="[${spelling}] the probe never reached the cluster (rc=$rc); "
    rm -rf "$d"
  done
  if [ -z "$problems" ]; then
    pass "a probe image present under either spelling passes the preflight and the probe runs"
  else
    fail "$problems"
  fi
}

# PROBE_IMAGE is an override, and the diagnostic has to describe what was
# actually looked for. A hardcoded ref in the message would send the operator
# to build the wrong image.
assert_the_preflight_follows_the_probe_image_override() {
  local d out rc problems=""
  d="$(mktemp -d)"
  # The DEFAULT fixture is present; the overridden ref is not.
  prepare "$d" "${OTHER_REFS}"$'\n'"docker.io/${PROBE_REF}"
  out="$(run_verify_np "$d" PROBE_IMAGE=fixtures/custom-probe:v2)"
  rc=$?
  [ "$rc" -ne 0 ] || problems+="exited 0 with the overridden probe image absent; "
  # Anchored on the ERROR line, not on any mention of the ref: the script echoes
  # `image=<ref>` in its own banner, so a bare `grep -F` would be satisfied by a
  # run that sailed past the preflight entirely.
  grep -Eq "ERROR: probe image fixtures/custom-probe:v2 is not loaded" <<< "$out" \
    || problems+="the error did not name the override; "
  if grep -q '^kubectl' "$d/ops.log"; then
    problems+="the probe ran anyway with an image the cluster does not have; "
  fi
  if [ -z "$problems" ]; then
    pass "the preflight checks the PROBE_IMAGE the caller asked for, not the default"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

# A daemon that cannot be listed is an unknown, and an unknown is not a pass.
# `2>/dev/null || true` here would let an unreadable daemon look like a loaded
# image and put the probe back where it started.
assert_an_unlistable_daemon_is_a_failure_not_a_pass() {
  local d out rc problems=""
  d="$(mktemp -d)"
  prepare "$d" "${OTHER_REFS}"$'\n'"docker.io/${PROBE_REF}"
  out="$(run_verify_np "$d" TEST_MINIKUBE_LS_RC=7)"
  rc=$?
  [ "$rc" -ne 0 ] || problems+="a failed image listing exited 0; "
  grep -Fq 'could not list the images' <<< "$out" || problems+="the failure was not reported; "
  if grep -q '^kubectl' "$d/ops.log"; then
    problems+="the probe ran against an unverifiable daemon; "
  fi
  if [ -z "$problems" ]; then
    pass "an image listing that fails stops the run instead of being read as present"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

# The preflight is a diagnostic, not a build step. A verification target that
# builds its own fixture would report success on an image it just created.
assert_the_verify_target_builds_nothing() {
  local out rc
  out="$(cd "$REPO_ROOT" && make -n minikube-verify-network-policy 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -q 'verify-network-policy-enforcement.sh' <<< "$out" \
     && ! grep -q 'build-images.sh' <<< "$out" \
     && ! grep -q 'docker build' <<< "$out"; then
    pass "make minikube-verify-network-policy still builds nothing"
  else
    fail "expected a build-free verify target; rc=$rc out=$out"
  fi
}

assert_the_touched_scripts_parse() {
  local f bad=""
  for f in scripts/minikube/verify-network-policy-enforcement.sh \
           scripts/tests/test-minikube-verify-network-policy.sh; do
    bash -n "$REPO_ROOT/$f" || bad+="$f "
  done
  if [ -z "$bad" ]; then
    pass "every script this harness touches parses"
  else
    fail "bash -n failed for: $bad"
  fi
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-minikube-verify-network-policy.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_a_missing_probe_image_fails_before_the_cluster_is_touched
assert_a_present_probe_image_passes_the_preflight
assert_the_preflight_follows_the_probe_image_override
assert_an_unlistable_daemon_is_a_failure_not_a_pass
assert_the_verify_target_builds_nothing
assert_the_touched_scripts_parse
assert_every_defined_case_is_invoked

exit $FAIL
