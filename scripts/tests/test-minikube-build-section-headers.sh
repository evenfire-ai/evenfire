#!/usr/bin/env bash
set -u
FAIL=0

# On the default IMAGE_SOURCE=ghcr path, full-setup.sh runs
# `build-images.sh --public-only`, which loads the public third-party images
# (postgres, redis, nginx, ...) and builds NOTHING: --public-only forces
# ONLY_SVC to a sentinel that matches no image, so every build_image call is a
# no-op.
#
# It still printed the four build banners ("=== Building Core Services ===",
# "=== Building UI Services ===", "=== Building MCP Servers ===",
# "=== Building Test Fixtures ===") and closed with "All images built directly
# in minikube". Observed on a real 15-minute run: a developer watching the pull
# path is told the setup is building 28 images while it builds none, which is
# the exact confusion the pull-by-default work exists to remove.
#
# Every case runs the REAL script against PATH stubs for docker/minikube/
# kubectl (same technique as scripts/tests/test-minikube-verify-images.sh), so
# nothing here needs a cluster or a network. The two modes are compared against
# each other, not against source text: --public-only must be silent about
# building AND must build nothing, while an ordinary build run must print every
# banner AND actually invoke `docker build`. Inverting the suppression
# condition fails one direction or the other.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# The build phases under test, named exactly as the script names them. Kept as
# one list so a new phase added without a build_section() wrapper is caught by
# the same assertions. The banner is "=== <phase> ===".
BUILD_PHASES=(
  "Building Core Services"
  "Building UI Services"
  "Building MCP Servers"
  "Building Test Fixtures"
)

make_stubs() {
  local d=$1
  mkdir -p "$d/bin"
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *docker-env*) echo 'export DOCKER_HOST="tcp://127.0.0.1:2376"'; exit 0 ;;
  *"image ls"*--format=json*) cat "${TEST_PRESENT_JSON:?}"; exit 0 ;;
esac
exit 0
STUB
  cat > "$d/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"get nodes"*) echo "minikube  Ready  control-plane  1d  v1.30.0"; exit 0 ;;
esac
exit 0
STUB
  cat > "$d/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "${1:-}" in
  context)
    if [[ "${2:-}" == inspect ]]; then
      effective_host="${DOCKER_HOST:-unix:///tmp/evenfire-docker.sock}"
      if [[ "$*" == *SkipTLSVerify* ]]; then
        printf '%s\tfalse\t{}\n' "$effective_host"
      else
        printf '%s\n' "$effective_host"
      fi
    fi
    ;;
  inspect) echo "sha256:deadbeef0000cafedeadbeef0000cafedeadbeef" ;;
  # Empty: the host daemon holds no public image yet, so the public-image loop
  # takes its `docker pull` branch instead of "already present -- skipping".
  # That is the branch --public-only exists to run.
  images)  : ;;
esac
exit 0
STUB
  chmod +x "$d/bin/minikube" "$d/bin/kubectl" "$d/bin/docker"
}

# The real builder now refuses every Docker/Minikube mutation without the
# inherited branch-profile lease. This fixture is intentionally not a live
# worktree or cluster, so it models only the child boundary; the real lease
# implementation is covered by test-minikube-build-images-hardening.sh.
write_fixture_mutation_lock_stub() {
  local d=$1
  cat > "$d/repo/scripts/minikube/require-t2-mutation-lock.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$d/repo/scripts/minikube/require-t2-mutation-lock.sh"
}

# An isolated PROJECT_DIR that is a copy of the real repo's deploy/ + scripts/,
# so the script under test is the real one and reads the real manifest.
prepare_repo() {
  local d=$1
  make_stubs "$d"
  mkdir -p "$d/repo"
  cp -R "$REPO_ROOT/deploy" "$d/repo/deploy"
  cp -R "$REPO_ROOT/scripts" "$d/repo/scripts"
  rm -rf "$d/repo/deploy/minikube"
  write_fixture_mutation_lock_stub "$d"
  # An empty daemon inventory. Every base/public image then takes the "pull it"
  # branch, which is the slower path through the script and therefore the one
  # most likely to print something unexpected.
  printf '[]' > "$d/present.json"
}

# Runs the real script and leaves its stdout+stderr in $RUN_OUT and its exit
# code in $RUN_RC. `rc=$?` is on its own line on purpose: putting the capture
# in the same statement as a later command substitution resets $?.
RUN_OUT=""
RUN_RC=0
run_build() {
  local d=$1; shift
  : > "$d/ops.log"
  RUN_OUT="$(PATH="$d/bin:$PATH" \
    TEST_LOG_FILE="$d/ops.log" \
    TEST_PRESENT_JSON="$d/present.json" \
    T2_PROJECT_DIR="$d/repo" T2_PROFILE=clerum-test T2_CONTEXT=clerum-test \
    MINIKUBE_PROFILE=clerum-test CONTROL_API_REAL_PG_CONTEXT=clerum-test \
    DOCKER_HOST=unix:///tmp/evenfire-docker.sock \
    bash "$d/repo/scripts/minikube/build-images.sh" "$@" 2>&1)"
  RUN_RC=$?
}

# What the run actually did, read from the stub call log rather than from the
# script's own narration. This is what makes the banner assertions meaningful:
# "prints no build banner" only matters if the same run also built nothing.
docker_build_count() {
  local d=$1
  grep -c '^docker build ' "$d/ops.log" || true
}

banners_present() {
  local out=$1 phase found=""
  for phase in "${BUILD_PHASES[@]}"; do
    if grep -qF "=== ${phase} ===" <<< "$out"; then
      found+="${phase}; "
    fi
  done
  printf '%s' "$found"
}

banners_absent() {
  local out=$1 phase missing=""
  for phase in "${BUILD_PHASES[@]}"; do
    if ! grep -qF "=== ${phase} ===" <<< "$out"; then
      missing+="${phase}; "
    fi
  done
  printf '%s' "$missing"
}

# ---------------------------------------------------------------------------
# The defect: the ghcr path announced builds it never performed
# ---------------------------------------------------------------------------

# The headline case. --public-only is exactly how full-setup.sh invokes this
# script when IMAGE_SOURCE=ghcr.
assert_the_public_only_run_prints_no_build_banner() {
  local d shown
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --public-only
  shown="$(banners_present "$RUN_OUT")"
  if [ "$RUN_RC" -eq 0 ] && [ -z "$shown" ]; then
    pass "--public-only prints no 'Building ...' section banner"
  else
    fail "--public-only announced builds (rc=$RUN_RC): ${shown:-none} :: $RUN_OUT"
  fi
  rm -rf "$d"
}

# The other half of the same claim, and the reason the case above is not
# vacuous: the run that printed nothing about building also built nothing.
assert_the_public_only_run_really_builds_nothing() {
  local d builds
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --public-only
  builds="$(docker_build_count "$d")"
  if [ "$RUN_RC" -eq 0 ] && [ "$builds" -eq 0 ]; then
    pass "--public-only invokes 'docker build' zero times"
  else
    fail "expected no docker build on the ghcr path; got rc=$RUN_RC, $builds builds"
  fi
  rm -rf "$d"
}

# --public-only is not a no-op run that trivially prints nothing: it still does
# the work it exists for. Without this, deleting the whole tail of the script
# would pass every case above.
assert_the_public_only_run_still_loads_the_public_images() {
  local d
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --public-only
  if [ "$RUN_RC" -eq 0 ] \
     && grep -qF '=== Loading Public Images ===' <<< "$RUN_OUT" \
     && grep -q "^docker pull postgres:16-alpine$" "$d/ops.log"; then
    pass "--public-only still loads the public third-party images"
  else
    fail "--public-only stopped doing its real work (rc=$RUN_RC): $RUN_OUT"
  fi
  rm -rf "$d"
}

# The summary line is part of the same false report: "All images built directly
# in minikube" was the last thing the ghcr path printed.
assert_the_public_only_summary_does_not_claim_images_were_built() {
  local d
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --public-only
  if [ "$RUN_RC" -eq 0 ] \
     && ! grep -qi 'All images built' <<< "$RUN_OUT" \
     && grep -qF 'No images were built' <<< "$RUN_OUT"; then
    pass "--public-only closes by saying nothing was built"
  else
    fail "the --public-only summary still claims a build happened (rc=$RUN_RC): $RUN_OUT"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# The build path is untouched -- the fix cannot be "never print the banners"
# ---------------------------------------------------------------------------

# `make minikube-setup-local` reaches build-images.sh without --public-only.
# Every banner must still be there, so suppressing them unconditionally (or
# inverting the condition) fails here.
assert_a_real_build_run_prints_every_build_banner() {
  local d missing
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --skip-public
  missing="$(banners_absent "$RUN_OUT")"
  if [ "$RUN_RC" -eq 0 ] && [ -z "$missing" ]; then
    pass "a build run still prints every 'Building ...' section banner"
  else
    fail "a build run lost banners (rc=$RUN_RC): ${missing:-none} :: $RUN_OUT"
  fi
  rm -rf "$d"
}

# Same pairing as the ghcr case: the run that announced builds performed them.
assert_a_real_build_run_really_builds() {
  local d builds
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --skip-public
  builds="$(docker_build_count "$d")"
  if [ "$RUN_RC" -eq 0 ] && [ "$builds" -ge 10 ]; then
    pass "a build run invokes 'docker build' for the service images ($builds)"
  else
    fail "expected the build path to build; got rc=$RUN_RC, $builds builds"
  fi
  rm -rf "$d"
}

assert_a_real_build_run_still_reports_a_build_summary() {
  local d
  d="$(mktemp -d)"
  prepare_repo "$d"
  run_build "$d" --skip-public
  if [ "$RUN_RC" -eq 0 ] \
     && grep -qF '=== Build Summary ===' <<< "$RUN_OUT" \
     && grep -qi 'All images built' <<< "$RUN_OUT"; then
    pass "a build run still closes with the build summary"
  else
    fail "the build summary went missing (rc=$RUN_RC): $RUN_OUT"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# The banner list itself must not silently empty out
# ---------------------------------------------------------------------------

# banners_present()/banners_absent() iterate BUILD_PHASES. An empty list makes
# both return "" and every case above pass vacuously.
assert_the_phase_list_is_not_empty() {
  if [ "${#BUILD_PHASES[@]}" -ge 4 ]; then
    pass "the phase list under test holds every build phase (${#BUILD_PHASES[@]})"
  else
    fail "BUILD_PHASES has ${#BUILD_PHASES[@]} entries; the assertions above are vacuous"
  fi
}

# A typo'd phase name cannot make the suppression case pass for the wrong
# reason: assert_a_real_build_run_prints_every_build_banner above demands the
# script emit every phase in this list, so a name the script never prints fails
# there.

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-minikube-build-section-headers.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_the_public_only_run_prints_no_build_banner
assert_the_public_only_run_really_builds_nothing
assert_the_public_only_run_still_loads_the_public_images
assert_the_public_only_summary_does_not_claim_images_were_built
assert_a_real_build_run_prints_every_build_banner
assert_a_real_build_run_really_builds
assert_a_real_build_run_still_reports_a_build_summary
assert_the_phase_list_is_not_empty
assert_every_defined_case_is_invoked

exit $FAIL
