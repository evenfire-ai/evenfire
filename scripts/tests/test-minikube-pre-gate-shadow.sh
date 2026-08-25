#!/usr/bin/env bash
set -u
FAIL=0

# A ghcr cluster runs RELEASE images. Before this harness existed, the pre-gate
# had no idea: it built clerum/<svc>:test, restarted the Deployment, and the pod
# came back on the SAME release digest, because nothing referenced the image it
# had just built. The gate then passed against code that was never deployed --
# the worst outcome this whole change can produce.
#
# Every case here runs the REAL scripts against PATH stubs for
# docker/minikube/kubectl/make, in a throwaway copy of deploy/ + scripts/ with a
# real git history. Nothing needs a cluster or a network.
#
# The assertions are written to die on INVERTED LOGIC, not on a renamed
# identifier: they observe the docker/make/kubectl calls the scripts actually
# make and the refs those calls carry. Swapping the ghcr and local refs in the
# retag, or wrapping the shadow loop in `if false`, fails them.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GHCR_COMPONENT="$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

PIN_TAG="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$GHCR_COMPONENT" | sort -u)"
if [ -z "$PIN_TAG" ] || [ "$(printf '%s\n' "$PIN_TAG" | wc -l | tr -d ' ')" != "1" ]; then
  echo "FAIL: could not read a single committed pin from $GHCR_COMPONENT (got '$PIN_TAG')"
  exit 1
fi

# Derived from the manifest, deliberately NOT from the code under test.
ghcr_refs_for_selector() {
  local selector="$1" tag="$2"
  node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      for (const i of m.pullInGhcrMode()) {
        if (!i.name.includes(process.argv[1]) && !m.localRef(i).includes(process.argv[1])) continue
        console.log(`ghcr.io/evenfire-ai/${i.name}:${process.argv[2]}`)
      }
    }).catch(e => { console.error(e.message); process.exit(1) })' "$selector" "$tag"
}

local_ref_for_image() {
  node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const i = m.IMAGES.find(x => x.name === process.argv[1])
      if (!i) { console.error("no such image"); process.exit(1) }
      console.log(m.localRef(i))
    }).catch(e => { console.error(e.message); process.exit(1) })' "$1"
}

make_stubs() {
  local d=$1
  mkdir -p "$d/bin"
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
  inspect)
    # The only inspect the pre-gate makes is the OCI revision-label read that
    # gives it the commit a release image was built from.
    printf '%s\n' "${TEST_IMAGE_REVISION:-}"
    exit 0
    ;;
  tag)
    if [ "${TEST_DOCKER_TAG_FAILS:-0}" = "1" ]; then
      echo "Error response from daemon: simulated retag failure" >&2
      exit 1
    fi
    exit 0
    ;;
esac
exit 0
STUB
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *docker-env*)
    if [ "${TEST_MINIKUBE_HANG_DOCKER_ENV:-0}" = "1" ]; then
      trap '' TERM
      while :; do sleep 1; done
    fi
    if [ "${TEST_EMPTY_DOCKER_ENV:-0}" = "1" ]; then
      exit 0
    fi
    echo 'export DOCKER_HOST="tcp://127.0.0.1:2376"'
    exit 0
    ;;
esac
exit 0
STUB
  cat > "$d/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *"get nodes"*) echo "minikube  Ready  control-plane  1d  v1.30.0"; exit 0 ;;
  *"get configmap"*jsonpath*)
    key="$(printf '%s' "$*" | sed -n 's/.*{\.data\.\([A-Za-z]*\)}.*/\1/p')"
    file="${TEST_MARKER_DIR:-/nonexistent}/${key}"
    [ -n "$key" ] || exit 1
    [ -f "$file" ] || exit 1
    cat "$file"
    exit 0
    ;;
esac
exit 0
STUB
  cat > "$d/bin/make" <<'STUB'
#!/usr/bin/env bash
printf 'make %s\n' "$*" >>"${TEST_LOG_FILE:?}"
exit 0
STUB
  chmod +x "$d/bin/docker" "$d/bin/minikube" "$d/bin/kubectl" "$d/bin/make"
}

# A throwaway repo carrying the REAL deploy/ and scripts/, with a real git
# history so incremental_plan's diffs work, and a stubbed build-images.sh so a
# "build" is observable without Docker.
prepare_repo() {
  local d=$1
  make_stubs "$d"
  mkdir -p "$d/repo"
  cp -R "$REPO_ROOT/deploy" "$d/repo/deploy"
  cp -R "$REPO_ROOT/scripts" "$d/repo/scripts"
  rm -rf "$d/repo/deploy/minikube"
  cat > "$d/repo/scripts/minikube/require-t2-mutation-lock.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$d/repo/scripts/minikube/require-t2-mutation-lock.sh"
  # patches/k8s-api-ip.yaml is GENERATED and gitignored (the overlay commits
  # only the .template), so whether the developer's tree has one is incidental.
  # Materialise it deterministically: by the time anything renders, `make
  # minikube-setup` / `make minikube-deploy-all` have written it. Its absence is
  # its own case (assert_a_render_copy_without_the_generated_patch_...), which
  # deletes this file again.
  cp "$d/repo/deploy/overlays/minikube/patches/k8s-api-ip.yaml.template" \
    "$d/repo/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
  cat > "$d/repo/scripts/minikube/build-images.sh" <<'STUB'
#!/usr/bin/env bash
printf 'build-images %s\n' "$*" >>"${TEST_LOG_FILE:?}"
exit 0
STUB
  mkdir -p "$d/repo/control-api/src"
  echo "export const x = 1" > "$d/repo/control-api/src/index.ts"
  (
    cd "$d/repo"
    git init -q .
    git add -A
    git -c user.email=t@t -c user.name=t commit -qm base
  )
}

write_manifest() {
  local d=$1 body=$2
  mkdir -p "$d/repo/deploy/minikube"
  printf '%s' "$body" > "$d/repo/deploy/minikube/.image-manifest.json"
}

repo_head() { git -C "$1/repo" rev-parse HEAD; }

# Loads pre-gate-incremental.sh the way pre-gate-sync.sh does, in a subshell the
# caller controls, and runs $2 with the callers' contract satisfied.
run_incremental() {
  local d=$1 fn=$2
  (
    set +u
    PROJECT_DIR="$d/repo"
    PROFILE="clerum-test"
    KC="kubectl --context=${PROFILE}"
    CLUSTER_SYNC_STATE_CONFIGMAP="clerum-pre-gate-sync-state"
    FORCE_CLUSTER_SYNC="${FORCE_CLUSTER_SYNC:-false}"
    log() { printf '[pre-gate-sync] %s\n' "$*"; }
    rollout_if_present() { :; }
    # shellcheck source=/dev/null
    . "$PROJECT_DIR/scripts/minikube/pre-gate-incremental.sh"
    eval "$fn"
  ) 2>&1
}

# ---------------------------------------------------------------------------
# The shadow build itself
# ---------------------------------------------------------------------------

# The whole trick: build LOCALLY, then tag that build with the exact ghcr ref
# the Deployment already references, so IfNotPresent picks it up with no
# manifest edit. Building clerum/control-api:test alone leaves the pod on the
# release digest.
assert_a_targeted_ghcr_build_is_retagged_onto_the_running_ghcr_ref() {
  local d out rc want_local want_ghcr
  d="$(mktemp -d)"
  prepare_repo "$d"
  want_local="$(local_ref_for_image control-api)"
  want_ghcr="ghcr.io/evenfire-ai/control-api:${PIN_TAG}"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
    INCREMENTAL_TARGETS_INIT="control-api|control-plane|control-api" \
      run_incremental "$d" 'INCREMENTAL_TARGETS=("control-api|control-plane|control-api"); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq "build-images --only=control-api" "$d/ops.log" \
     && grep -Fq "docker tag ${want_local} ${want_ghcr}" "$d/ops.log"; then
    pass "a targeted ghcr build is retagged onto the ref the Deployment runs"
  else
    fail "expected 'docker tag ${want_local} ${want_ghcr}'; rc=$rc log=$(cat "$d/ops.log") out=$out"
  fi
  rm -rf "$d"
}

# A SELECTOR IS NOT AN IMAGE NAME. build-images.sh's --only does SUBSTRING
# matching, so --only=workflow builds four images. Resolving the selector to one
# name would shadow one and leave three on their release digests while the
# report claimed the whole selector was covered.
assert_a_multi_image_selector_shadows_every_image_it_builds() {
  local d out rc ref missing="" count
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
      run_incremental "$d" 'INCREMENTAL_TARGETS=("workflow|control-plane|workflow-recipes"); incremental_build_images'
  )"
  rc=$?
  count=0
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    count=$((count + 1))
    grep -Fq "docker tag " "$d/ops.log" && grep -Fq " ${ref}" "$d/ops.log" || missing+="${ref} "
  done < <(ghcr_refs_for_selector workflow "$PIN_TAG")
  # An image with no published counterpart carries `-` as its ghcr ref; tagging
  # onto that would put a literal `-` image in the daemon.
  if grep -q 'docker tag .* -$' "$d/ops.log"; then
    missing+="(retagged an unpublished image onto '-') "
  fi
  if [ "$rc" -eq 0 ] && [ "$count" -ge 4 ] && [ -z "$missing" ]; then
    pass "a multi-image selector shadows every image build-images.sh --only builds (${count})"
  else
    fail "selector 'workflow' resolved to ${count} image(s), not shadowed: ${missing:-none}; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The other direction, so the fix cannot be "always retag": a locally built
# cluster runs clerum/* refs, and inventing a ghcr tag there would put an image
# in the daemon that no pod references and no verify expects.
assert_local_mode_never_retags_onto_a_ghcr_ref() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=local IMAGE_TAG="" \
      run_incremental "$d" 'INCREMENTAL_TARGETS=("control-api|control-plane|control-api"); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq "build-images --only=control-api" "$d/ops.log" \
     && ! grep -q 'docker tag' "$d/ops.log" \
     && ! grep -q 'SHADOWED' <<< "$out"; then
    pass "local mode builds the image and never retags it onto a ghcr ref"
  else
    fail "local mode retagged or reported a shadow; rc=$rc log=$(cat "$d/ops.log") out=$out"
  fi
  rm -rf "$d"
}

# Nobody can act on a shadow they cannot see. The report is the difference
# between "the gate is green" and "the gate is green about these two images".
assert_the_shadow_set_is_reported_with_every_ref() {
  local d out rc want
  d="$(mktemp -d)"
  prepare_repo "$d"
  want="ghcr.io/evenfire-ai/control-api:${PIN_TAG}"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
      run_incremental "$d" 'INCREMENTAL_TARGETS=("control-api|control-plane|control-api"); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'SHADOWED' <<< "$out" && grep -Fq "$want" <<< "$out"; then
    pass "the shadow set is reported explicitly, naming every shadowed ref"
  else
    fail "expected a SHADOWED report naming ${want}; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# With nothing to shadow the report must still run and must say so, or an
# operator reads silence as "my code is deployed".
assert_an_empty_shadow_set_is_reported_as_release_only() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
      run_incremental "$d" 'INCREMENTAL_TARGETS=(); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'SHADOWED: none' <<< "$out" && grep -Fq "$PIN_TAG" <<< "$out"; then
    pass "an empty shadow set is reported as 'every image is the release build'"
  else
    fail "expected an explicit empty-shadow report naming ${PIN_TAG}; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# A retag that fails leaves the pod on the release digest with a freshly built
# local image nothing references -- exactly the silent-wrong-code state. It has
# to stop the gate.
assert_a_failed_retag_fails_the_pre_gate() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_DOCKER_TAG_FAILS=1 \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
      run_incremental "$d" 'INCREMENTAL_TARGETS=("control-api|control-plane|control-api"); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -qi 'undeployed\|could not shadow' <<< "$out"; then
    pass "a failed retag stops the pre-gate instead of reporting a build success"
  else
    fail "expected a non-zero exit naming the failed shadow; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# What INCREMENTAL_FULL_IMAGE_BUILD means in each mode
# ---------------------------------------------------------------------------

# "Build everything" is the wrong recovery in ghcr mode: it reinstates the
# 20-minute build this change exists to remove and leaves the cluster holding
# clerum/* images the ghcr overlay never references.
assert_a_full_sync_in_ghcr_mode_repulls_instead_of_building_everything() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
      run_incremental "$d" 'INCREMENTAL_REPULL_ALL=true; INCREMENTAL_TARGETS=("control-api|control-plane|control-api"); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq "make minikube-pull-images" "$d/ops.log" \
     && ! grep -Fq "make minikube-build-images" "$d/ops.log" \
     && grep -Fq "docker tag $(local_ref_for_image control-api) ghcr.io/evenfire-ai/control-api:${PIN_TAG}" "$d/ops.log"; then
    pass "a ghcr full sync re-pulls the release set, then shadows the changed set on top"
  else
    fail "expected a re-pull followed by the shadow build; rc=$rc log=$(cat "$d/ops.log") out=$out"
  fi
  rm -rf "$d"
}

# Local mode is untouched: a full image build still means build everything.
assert_local_mode_still_builds_everything_on_a_full_image_build() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=local IMAGE_TAG="" \
      run_incremental "$d" 'INCREMENTAL_FULL_IMAGE_BUILD=true; incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq "make minikube-build-images" "$d/ops.log" \
     && ! grep -Fq "make minikube-pull-images" "$d/ops.log"; then
    pass "local mode still builds every image when the change cannot be targeted"
  else
    fail "expected a full local build and no pull; rc=$rc log=$(cat "$d/ops.log") out=$out"
  fi
  rm -rf "$d"
}

# An unmapped runtime path in ghcr mode is the one case the shadow cannot cover:
# there is no image to build. Passing here would gate against undeployed code,
# so it must stop, name the path, and name a remedy that works.
assert_an_unmapped_change_hard_fails_in_ghcr_mode_with_a_remedy() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" \
      run_incremental "$d" 'INCREMENTAL_FULL_IMAGE_BUILD=true; INCREMENTAL_FULL_IMAGE_BUILD_REASON=unmapped; INCREMENTAL_UNMAPPED=("some/unmapped/file.ts"); incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -Fq 'some/unmapped/file.ts' <<< "$out" \
     && grep -Fq 'minikube-setup-local' <<< "$out"; then
    pass "an unmapped change in ghcr mode hard-fails, naming the path and a working remedy"
  else
    fail "expected a hard fail naming the unmapped path and minikube-setup-local; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The same rule for the other unrecoverable case: no baseline means the shadow
# set is unknowable, and "shadow nothing" would read as "everything is fine".
assert_an_unresolvable_baseline_hard_fails_in_ghcr_mode() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    IMAGE_SOURCE=ghcr IMAGE_TAG=latest \
      run_incremental "$d" 'INCREMENTAL_FULL_IMAGE_BUILD=true; INCREMENTAL_FULL_IMAGE_BUILD_REASON=no-baseline; incremental_build_images'
  )"
  rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -Fq 'minikube-setup-local' <<< "$out" \
     && grep -q 'baseline' <<< "$out"; then
    pass "an unresolvable release baseline hard-fails instead of gating on release code"
  else
    fail "expected a hard fail naming the missing baseline and a remedy; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# Where the shadow baseline comes from
# ---------------------------------------------------------------------------

# Published images carry org.opencontainers.image.revision (build-publish.yml),
# so a ghcr cluster with no usable marker still knows exactly which commit its
# release images were built from -- including on the `latest` bootstrap tag,
# which resolves to no git ref at all.
assert_the_release_image_revision_label_supplies_the_missing_baseline() {
  local d out rc base
  d="$(mktemp -d)"
  prepare_repo "$d"
  base="$(repo_head "$d")"
  echo "// changed" >> "$d/repo/control-api/src/index.ts"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_IMAGE_REVISION="$base" \
    TEST_MARKER_DIR="$d/nomarker" \
    IMAGE_SOURCE=ghcr IMAGE_TAG=latest \
      run_incremental "$d" 'incremental_plan; echo "targets=$(incremental_target_summary) full=${INCREMENTAL_FULL_IMAGE_BUILD} repull=${INCREMENTAL_REPULL_ALL}"'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq 'targets=control-api' <<< "$out" \
     && grep -Fq 'full=false' <<< "$out" \
     && grep -Fq 'repull=true' <<< "$out"; then
    pass "the release image's revision label supplies the baseline when no marker exists"
  else
    fail "expected a control-api-only plan from the revision label; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# Without a marker AND without a resolvable release revision there is no
# baseline at all, and the plan must say so rather than compute an empty delta.
assert_no_marker_and_no_revision_label_fails_closed() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  echo "// changed" >> "$d/repo/control-api/src/index.ts"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_IMAGE_REVISION="" \
    TEST_MARKER_DIR="$d/nomarker" \
    IMAGE_SOURCE=ghcr IMAGE_TAG=latest \
      run_incremental "$d" 'incremental_plan; echo "full=${INCREMENTAL_FULL_IMAGE_BUILD} reason=${INCREMENTAL_FULL_IMAGE_BUILD_REASON}"'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq 'full=true' <<< "$out" \
     && grep -Fq 'reason=no-baseline' <<< "$out"; then
    pass "no marker and no revision label fails closed with an explicit reason"
  else
    fail "expected full=true reason=no-baseline; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The baseline read runs inside a command substitution, so a diagnostic printed
# on stdout there would be captured AS the baseline and then diffed against.
# The Docker boundary now proves ownership before planning; an unreachable
# profile must therefore fail before it can publish any baseline or plan.
assert_an_unreachable_docker_daemon_fails_before_planning() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
echo "minikube: profile not found" >&2
exit 1
STUB
  chmod +x "$d/bin/minikube"
  echo "// changed" >> "$d/repo/control-api/src/index.ts"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_MARKER_DIR="$d/nomarker" \
    IMAGE_SOURCE=ghcr IMAGE_TAG=latest \
      run_incremental "$d" 'incremental_plan; echo "full=${INCREMENTAL_FULL_IMAGE_BUILD} reason=${INCREMENTAL_FULL_IMAGE_BUILD_REASON}"'
  )"
  rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -Fq 'DOCKER_ENV_UNRESOLVED' <<< "$out" \
     && ! grep -Fq 'full=' <<< "$out"; then
    pass "an unreachable Docker daemon fails before publishing a baseline or plan"
  else
    fail "expected an early DOCKER_ENV_UNRESOLVED failure without a plan; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# A `make minikube-setup` between two pre-gates re-pulls every release image and
# DISCARDS the shadows, while leaving the marker untouched. Trusting the
# marker's gitHead there computes an empty delta and gates on release code.
assert_a_re_acquisition_invalidates_the_marker_baseline_in_ghcr_mode() {
  local d out rc head
  d="$(mktemp -d)"
  prepare_repo "$d"
  head="$(repo_head "$d")"
  mkdir -p "$d/marker"
  printf '%s' "$head" > "$d/marker/gitHead"
  printf '%s' "2026-08-06T00:00:00Z" > "$d/marker/imagesGeneratedAt"
  write_manifest "$d" '{"generated":"2026-08-06T09:99:99Z","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_MARKER_DIR="$d/marker" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" IMAGES_GENERATED_AT="2026-08-06T09:99:99Z" \
      run_incremental "$d" 'echo "baseline=[$(incremental_marker_git_head)]"'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] && grep -Fq 'baseline=[]' <<< "$out"; then
    pass "a re-acquisition since the marker invalidates its gitHead baseline in ghcr mode"
  else
    fail "expected an empty baseline after a re-acquisition; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# A local rebuild can also replace image IDs without changing gitHead. The
# incremental planner must not treat that newer acquisition as proof that the
# old deployment is still the image set being tested.
assert_a_re_acquisition_invalidates_the_marker_baseline_in_local_mode() {
  local d out rc head
  d="$(mktemp -d)"
  prepare_repo "$d"
  head="$(repo_head "$d")"
  mkdir -p "$d/marker"
  printf '%s' "$head" > "$d/marker/gitHead"
  printf '%s' "2026-08-06T00:00:00Z" > "$d/marker/imagesGeneratedAt"
  write_manifest "$d" '{"generated":"2026-08-06T09:99:99Z","imageSource":"local","imageTag":"","images":{}}'
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_MARKER_DIR="$d/marker" \
    IMAGE_SOURCE=local IMAGE_TAG="" IMAGES_GENERATED_AT="2026-08-06T09:99:99Z" \
      run_incremental "$d" 'echo "baseline=[$(incremental_marker_git_head)]"'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] && grep -Fq 'baseline=[]' <<< "$out"; then
    pass "a newer local image acquisition invalidates its gitHead baseline"
  else
    fail "expected an empty local baseline after a re-acquisition; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The complement, so the fix cannot be "never trust the marker": an untouched
# image set keeps its baseline, which is what makes the incremental path fast.
assert_an_untouched_image_set_keeps_the_marker_baseline() {
  local d out rc head
  d="$(mktemp -d)"
  prepare_repo "$d"
  head="$(repo_head "$d")"
  mkdir -p "$d/marker"
  printf '%s' "$head" > "$d/marker/gitHead"
  printf '%s' "2026-08-06T00:00:00Z" > "$d/marker/imagesGeneratedAt"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_MARKER_DIR="$d/marker" \
    IMAGE_SOURCE=ghcr IMAGE_TAG="$PIN_TAG" IMAGES_GENERATED_AT="2026-08-06T00:00:00Z" \
      run_incremental "$d" 'echo "baseline=[$(incremental_marker_git_head)]"'
  )"
  rc=$?
  if [ "$rc" -eq 0 ] && grep -Fq "baseline=[${head}]" <<< "$out"; then
    pass "an untouched image set keeps the marker's gitHead as the shadow baseline"
  else
    fail "expected baseline=[${head}]; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# The mode the pre-gate assumes, and the marker that records it
# ---------------------------------------------------------------------------

# Runs pre-gate-sync.sh up to its configuration seam. No cluster call happens
# before that point.
run_pre_gate_config() {
  local d=$1; shift
  (
    cd "$d/repo" || exit 1
    PATH="$d/bin:$PATH" \
    TEST_LOG_FILE="$d/ops.log" \
    TMPDIR="$d/state" \
    PRE_GATE_SYNC_CONFIG_ONLY=true \
    env "$@" bash "$d/repo/scripts/minikube/pre-gate-sync.sh" --gate manual
  ) 2>&1
}

# A cluster set up in one mode and pre-gated in the other must not silently
# agree. What the cluster RUNS decides, and that is recorded by whichever writer
# last acquired images -- not by whatever IMAGE_SOURCE this shell defaults to.
assert_the_pre_gate_adopts_the_recorded_cluster_mode_over_the_environment() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  out="$(run_pre_gate_config "$d" IMAGE_SOURCE=local)"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq "imageSource=ghcr" <<< "$out" \
     && grep -Fq "imageTag=${PIN_TAG}" <<< "$out" \
     && grep -Fq "renderDir=${d}/repo/deploy/overlays/minikube-ghcr" <<< "$out"; then
    pass "the pre-gate adopts the mode the cluster's images were acquired in"
  else
    fail "expected the recorded ghcr mode to win over IMAGE_SOURCE=local; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The other direction, so the fix cannot be "always ghcr": a locally built
# cluster must render the local overlay even though ghcr is the default.
assert_a_recorded_local_build_renders_the_local_overlay() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"local","images":{}}'
  out="$(run_pre_gate_config "$d")"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq "imageSource=local" <<< "$out" \
     && grep -Fq "renderDir=${d}/repo/deploy/overlays/minikube" <<< "$out" \
     && ! grep -q "minikube-ghcr" <<< "$out"; then
    pass "a recorded local build renders the local overlay despite the ghcr default"
  else
    fail "expected the local overlay for a recorded local build; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The migration Job EXTRACTS THE CONTROL-API IMAGE from the overlay it renders.
# Rendering the local overlay on a ghcr cluster yields clerum/control-api:test,
# which does not exist there, so the Job ImagePullBackOffs on every ghcr
# pre-gate; rendering the pinned ghcr overlay when the cluster runs an
# overridden tag pulls an image the cluster never had.
assert_the_migration_job_renders_the_overlay_the_cluster_runs() {
  local d out rc hardcoded
  d="$(mktemp -d)"
  prepare_repo "$d"
  hardcoded='--overlay "${PROJECT_DIR}/deploy/overlays/minikube"'
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"latest","images":{}}'
  out="$(run_pre_gate_config "$d")"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -q "renderDir=.*/deploy/overlays/minikube-ghcr" <<< "$out" \
     && grep -Fq 'newTag: latest' "$(grep -o 'renderDir=.*' <<< "$out" | head -1 | cut -d= -f2-)/../../components/ghcr-images/kustomization.yaml" \
     && ! grep -Fq -- "$hardcoded" "$REPO_ROOT/scripts/minikube/pre-gate-sync.sh" \
     && grep -Fq -- '--overlay "${PRE_GATE_RENDER_DIR}"' "$REPO_ROOT/scripts/minikube/pre-gate-sync.sh"; then
    pass "the migration Job renders the overlay (and tag) the cluster actually runs"
  else
    fail "the migration overlay does not follow the cluster's mode/tag; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# Sourcing the script stops at the same seam, which leaves its marker functions
# defined and callable against the stubbed kubectl.
source_pre_gate_marker_fns() {
  local d=$1
  cd "$d/repo" || return 1
  PRE_GATE_SYNC_CONFIG_ONLY=true
  export PRE_GATE_SYNC_CONFIG_ONLY
  # A sourced script sees the SOURCING function's positional parameters, and
  # pre-gate-sync.sh rejects unknown arguments. Clear them first.
  set --
  # shellcheck source=/dev/null
  . "$d/repo/scripts/minikube/pre-gate-sync.sh"
}

# gitHead alone cannot tell a ghcr cluster from a local one, nor v0.6.0 from
# latest. Both belong in the marker or a mode change reads as "in sync".
assert_the_marker_records_the_image_source_and_tag() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g7","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  out="$(
    (
      set +u
      PATH="$d/bin:$PATH"
      TEST_LOG_FILE="$d/ops.log"
      TMPDIR="$d/state"
      export PATH TEST_LOG_FILE TMPDIR
      source_pre_gate_marker_fns "$d" >/dev/null
      persist_cluster_marker fingerprint-a fingerprint-b
    ) 2>&1
  )"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -Fq -- "--from-literal=imageSource=ghcr" "$d/ops.log" \
     && grep -Fq -- "--from-literal=imageTag=${PIN_TAG}" "$d/ops.log" \
     && grep -Fq -- "--from-literal=imagesGeneratedAt=g7" "$d/ops.log" \
     && grep -Fq -- "--from-literal=gitHead=" "$d/ops.log"; then
    pass "the marker records imageSource, imageTag and the image-acquisition stamp beside gitHead"
  else
    fail "the marker does not record the image mode; rc=$rc log=$(cat "$d/ops.log") out=$out"
  fi
  rm -rf "$d"
}

# A marker written by a ghcr pre-gate must not match a local one.
marker_matches_for() {
  local d=$1
  (
    set +u
    PATH="$d/bin:$PATH"
    TEST_LOG_FILE="$d/ops.log"
    TEST_MARKER_DIR="$d/marker"
    TMPDIR="$d/state"
    export PATH TEST_LOG_FILE TEST_MARKER_DIR TMPDIR
    source_pre_gate_marker_fns "$d" >/dev/null
    printf '%s' "$WORKTREE_ID" > "$d/marker/worktreeId"
    cluster_marker_matches fingerprint-a "$WORKTREE_ID"
  ) >/dev/null 2>&1
}

assert_a_mode_change_forces_a_full_resync() {
  local d rc_same rc_diff head
  d="$(mktemp -d)"
  prepare_repo "$d"
  head="$(repo_head "$d")"
  write_manifest "$d" '{"generated":"g7","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  mkdir -p "$d/marker"
  printf '%s' "fingerprint-a" > "$d/marker/clusterFingerprint"
  printf '%s' "$head" > "$d/marker/gitHead"
  printf '%s' "g7" > "$d/marker/imagesGeneratedAt"
  printf '%s' "$PIN_TAG" > "$d/marker/imageTag"
  printf '%s' "ghcr" > "$d/marker/imageSource"
  marker_matches_for "$d"; rc_same=$?
  printf '%s' "local" > "$d/marker/imageSource"
  marker_matches_for "$d"; rc_diff=$?
  if [ "$rc_same" -eq 0 ] && [ "$rc_diff" -ne 0 ]; then
    pass "an identical marker matches and a changed imageSource forces a resync"
  else
    fail "expected match=0 and mode-change!=0; got same=$rc_same changed=$rc_diff"
  fi
  rm -rf "$d"
}

# The tag is half the coordinate: v0.6.0 and latest are different clusters.
assert_a_tag_change_forces_a_full_resync() {
  local d rc_same rc_diff head
  d="$(mktemp -d)"
  prepare_repo "$d"
  head="$(repo_head "$d")"
  write_manifest "$d" '{"generated":"g7","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  mkdir -p "$d/marker"
  printf '%s' "fingerprint-a" > "$d/marker/clusterFingerprint"
  printf '%s' "$head" > "$d/marker/gitHead"
  printf '%s' "g7" > "$d/marker/imagesGeneratedAt"
  printf '%s' "ghcr" > "$d/marker/imageSource"
  printf '%s' "$PIN_TAG" > "$d/marker/imageTag"
  marker_matches_for "$d"; rc_same=$?
  printf '%s' "some-other-tag" > "$d/marker/imageTag"
  marker_matches_for "$d"; rc_diff=$?
  if [ "$rc_same" -eq 0 ] && [ "$rc_diff" -ne 0 ]; then
    pass "an identical marker matches and a changed image tag forces a resync"
  else
    fail "expected match=0 and tag-change!=0; got same=$rc_same changed=$rc_diff"
  fi
  rm -rf "$d"
}

# A setup between two pre-gates replaces every image and discards the shadows.
# Without this the marker still matches and no sync runs at all.
assert_a_re_acquisition_forces_a_full_resync() {
  local d rc_same rc_diff head
  d="$(mktemp -d)"
  prepare_repo "$d"
  head="$(repo_head "$d")"
  write_manifest "$d" '{"generated":"g8","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  mkdir -p "$d/marker"
  printf '%s' "fingerprint-a" > "$d/marker/clusterFingerprint"
  printf '%s' "$head" > "$d/marker/gitHead"
  printf '%s' "ghcr" > "$d/marker/imageSource"
  printf '%s' "$PIN_TAG" > "$d/marker/imageTag"
  printf '%s' "g8" > "$d/marker/imagesGeneratedAt"
  marker_matches_for "$d"; rc_same=$?
  printf '%s' "g7" > "$d/marker/imagesGeneratedAt"
  marker_matches_for "$d"; rc_diff=$?
  if [ "$rc_same" -eq 0 ] && [ "$rc_diff" -ne 0 ]; then
    pass "a marker stamped before the last image acquisition forces a full resync"
  else
    fail "expected match=0 and stale-acquisition!=0; got same=$rc_same stale=$rc_diff"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# The other mode-crossing path: the full overlay apply
# ---------------------------------------------------------------------------

# `make minikube-deploy-all` hardcoded deploy/overlays/minikube, so a deploy/*
# change on a ghcr cluster applied manifests referencing clerum/*:test tags that
# were never built there -- cluster-wide ImagePullBackOff.
assert_make_deploy_all_renders_the_mode_aware_overlay() {
  local out
  # The public target now wraps its private body with the branch-profile lease;
  # inspect that body for the overlay resolver while the wrapper contract is
  # covered by test-minikube-makefile.sh.
  out="$(cd "$REPO_ROOT" && make -n minikube-deploy-all-body 2>&1)"
  if grep -q 'image-mode.sh --render-dir' <<< "$out" \
     && ! grep -q 'kustomize deploy/overlays/minikube |' <<< "$out"; then
    pass "make minikube-deploy-all resolves the overlay from the cluster's image mode"
  else
    fail "make minikube-deploy-all still hardcodes the local overlay: $out"
  fi
}

# The resolver is the single mechanism both call sites use, so its own
# behaviour is checked directly: a recorded mode wins over the environment.
assert_the_render_dir_resolver_follows_the_recorded_mode() {
  local d ghcr_out local_out
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  ghcr_out="$(IMAGE_SOURCE=local bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  write_manifest "$d" '{"generated":"g1","imageSource":"local","images":{}}'
  local_out="$(bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  if [ "$ghcr_out" = "$d/repo/deploy/overlays/minikube-ghcr" ] \
     && [ "$local_out" = "$d/repo/deploy/overlays/minikube" ]; then
    pass "the render-dir resolver follows the recorded mode, not the environment"
  else
    fail "resolver returned ghcr='$ghcr_out' local='$local_out'"
  fi
  rm -rf "$d"
}

# An overridden tag is not committed anywhere, so rendering the committed
# overlay would apply the PINNED tag to a cluster running the override.
assert_an_overridden_tag_renders_from_a_copy_carrying_that_tag() {
  local d out rendered
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"latest","images":{}}'
  out="$(bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  rendered="${out}/../../components/ghcr-images/kustomization.yaml"
  if [ -d "$out" ] \
     && [ "${out#"$d/repo/deploy"}" = "$out" ] \
     && [ -f "$rendered" ] \
     && grep -q 'newTag: latest' "$rendered" \
     && ! grep -q "newTag: ${PIN_TAG}" "$rendered" \
     && grep -q "newTag: ${PIN_TAG}" "$d/repo/deploy/components/ghcr-images/kustomization.yaml"; then
    pass "an overridden tag renders from a copy carrying it, leaving the committed pin alone"
  else
    fail "expected an out-of-tree render dir pinned to 'latest'; got '$out'"
  fi
  rm -rf "$d"
}

# The copy has to carry the GENERATED patch, not just the committed files.
# overlays/minikube-ghcr renders `resources: ../minikube`, which patches with
# patches/k8s-api-ip.yaml -- gitignored, written by minikube-detect-k8s-api-ip.sh.
assert_a_render_copy_carries_the_generated_api_ip_patch() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"latest","images":{}}'
  out="$(bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] \
     && [ -d "$out" ] \
     && [ -f "${out}/../minikube/patches/k8s-api-ip.yaml" ]; then
    pass "the tag-override render copy carries the generated k8s-api-ip.yaml"
  else
    fail "expected the copy to carry patches/k8s-api-ip.yaml; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# Reproduced before the fix: a fresh clone plus
# `MINIKUBE_IMAGE_TAG=latest make minikube-setup` generated the patch only into
# the setup's own mktemp copy, so the next pre-gate rendered a copy without one
# and kustomize failed with `evalsymlink failure on <temp>/patches/
# k8s-api-ip.yaml: no such file or directory` -- a path inside a temp dir, and
# no remedy. Fail before the copy is handed out, naming the file in the
# developer's tree and the command that writes it.
assert_a_render_copy_without_the_generated_api_ip_patch_fails_with_a_remedy() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"latest","images":{}}'
  rm -f "$d/repo/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
  out="$(bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -Fq "$d/repo/deploy/overlays/minikube/patches/k8s-api-ip.yaml" <<< "$out" \
     && grep -Fq 'deploy/scripts/minikube-detect-k8s-api-ip.sh' <<< "$out" \
     && ! grep -q 'evalsymlink' <<< "$out"; then
    pass "a copy missing the generated patch fails naming the file and how to regenerate it"
  else
    fail "expected a named, actionable failure; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# The pinned path renders the committed overlay in place, so it must NOT be
# gated on the generated patch: kustomize is what reports a missing patch there,
# and only the copy can be silently built without one.
assert_the_pinned_render_dir_is_not_gated_on_the_generated_patch() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"'"$PIN_TAG"'","images":{}}'
  rm -f "$d/repo/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
  out="$(bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] && [ "$out" = "$d/repo/deploy/overlays/minikube-ghcr" ]; then
    pass "the pinned render dir resolves without the generated patch"
  else
    fail "expected the committed ghcr overlay; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# A mode that is neither ghcr nor local is a typo, and guessing one silently
# picks a cluster shape.
assert_an_unknown_image_source_is_rejected() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(IMAGE_SOURCE=gcr bash "$d/repo/scripts/minikube/image-mode.sh" --render-dir 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'gcr' <<< "$out"; then
    pass "an unknown IMAGE_SOURCE is rejected instead of guessed"
  else
    fail "expected a non-zero exit naming the bad mode; rc=$rc out=$out"
  fi
  rm -rf "$d"
}

# A shadow build rewrites the image manifest through build-images.sh --only. If
# that run dropped the recorded tag, the next pre-gate would fall back to the
# committed pin and declare the cluster out of sync on every run.
# A shadow build is an --only run of build-images.sh, and that run REWRITES the
# image manifest. Dropping the recorded coordinate there would make the next
# pre-gate fall back to the committed pin, decide the cluster changed tag, and
# force a full resync on every single run.
assert_a_targeted_build_carries_the_recorded_coordinate_forward() {
  local d rc manifest mode tag
  d="$(mktemp -d)"
  prepare_repo "$d"
  # The REAL build-images.sh, not the stub prepare_repo installs.
  cp "$REPO_ROOT/scripts/minikube/build-images.sh" "$d/repo/scripts/minikube/build-images.sh"
  write_manifest "$d" '{"generated":"g1","imageSource":"ghcr","imageTag":"latest","images":{}}'
  (
    cd "$d/repo" || exit 1
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
      T2_PROJECT_DIR="$d/repo" T2_PROFILE=clerum-test T2_CONTEXT=clerum-test \
      MINIKUBE_PROFILE=clerum-test CONTROL_API_REAL_PG_CONTEXT=clerum-test \
      DOCKER_HOST=unix:///tmp/evenfire-docker.sock \
      bash "$d/repo/scripts/minikube/build-images.sh" --only=control-api
  ) >"$d/build.log" 2>&1
  rc=$?
  manifest="$d/repo/deploy/minikube/.image-manifest.json"
  mode="$(IMAGE_SOURCE=local bash "$d/repo/scripts/minikube/image-mode.sh" --image-source 2>&1)"
  tag="$(IMAGE_SOURCE=local bash "$d/repo/scripts/minikube/image-mode.sh" --image-tag 2>&1)"
  if [ "$rc" -eq 0 ] \
     && [ -f "$manifest" ] \
     && [ "$mode" = "ghcr" ] \
     && [ "$tag" = "latest" ]; then
    pass "a targeted build carries the recorded imageSource and imageTag forward"
  else
    fail "after --only the manifest records mode='$mode' tag='$tag' (rc=$rc): $(tail -3 "$d/build.log")"
  fi
  rm -rf "$d"
}

assert_the_touched_scripts_parse() {
  local f bad=""
  for f in scripts/minikube/image-mode.sh scripts/minikube/pre-gate-marker.sh \
           scripts/minikube/pre-gate-sync.sh \
           scripts/minikube/pre-gate-incremental.sh scripts/minikube/build-images.sh \
           scripts/tests/test-minikube-pre-gate-shadow.sh; do
    bash -n "$REPO_ROOT/$f" || bad+="$f "
  done
  if [ -z "$bad" ]; then
    pass "every script this harness touches parses"
  else
    fail "bash -n failed for: $bad"
  fi
}

assert_incremental_runtime_calls_are_bounded() {
  local d out rc=0
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    TEST_MINIKUBE_HANG_DOCKER_ENV=1 \
    INCREMENTAL_RUNTIME_TIMEOUT_SECONDS=1 \
    MINIKUBE_DOCKER_KILL_GRACE_SECONDS=1 \
      run_incremental "$d" 'incremental_use_minikube_docker'
  )" || rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -Fq '[HARNESS_DEADLINE] label=incremental-docker-env event=timeout' <<< "$out"; then
    pass "incremental Docker daemon selection terminates at its explicit deadline"
  else
    fail "incremental docker-env was not bounded (rc=$rc out=$out)"
  fi
  rm -rf "$d"
}

assert_empty_incremental_docker_env_fails_closed() {
  local d out rc=0
  d="$(mktemp -d)"
  prepare_repo "$d"
  export TEST_EMPTY_DOCKER_ENV=1
  out="$(run_incremental "$d" 'incremental_use_minikube_docker')" || rc=$?
  unset TEST_EMPTY_DOCKER_ENV
  if [ "$rc" -ne 0 ] && grep -Fq 'DOCKER_ENV_UNRESOLVED' <<<"$out"; then
    pass "empty incremental minikube docker-env output fails closed"
  else
    fail "incremental docker-env returned success without a Docker host: rc=$rc out=$out"
  fi
  rm -rf "$d"
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-minikube-pre-gate-shadow.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_a_targeted_ghcr_build_is_retagged_onto_the_running_ghcr_ref
assert_a_multi_image_selector_shadows_every_image_it_builds
assert_local_mode_never_retags_onto_a_ghcr_ref
assert_the_shadow_set_is_reported_with_every_ref
assert_an_empty_shadow_set_is_reported_as_release_only
assert_a_failed_retag_fails_the_pre_gate
assert_a_full_sync_in_ghcr_mode_repulls_instead_of_building_everything
assert_local_mode_still_builds_everything_on_a_full_image_build
assert_an_unmapped_change_hard_fails_in_ghcr_mode_with_a_remedy
assert_an_unresolvable_baseline_hard_fails_in_ghcr_mode
assert_the_release_image_revision_label_supplies_the_missing_baseline
assert_no_marker_and_no_revision_label_fails_closed
assert_an_unreachable_docker_daemon_fails_before_planning
assert_a_re_acquisition_invalidates_the_marker_baseline_in_ghcr_mode
assert_a_re_acquisition_invalidates_the_marker_baseline_in_local_mode
assert_an_untouched_image_set_keeps_the_marker_baseline
assert_the_pre_gate_adopts_the_recorded_cluster_mode_over_the_environment
assert_a_recorded_local_build_renders_the_local_overlay
assert_the_migration_job_renders_the_overlay_the_cluster_runs
assert_the_marker_records_the_image_source_and_tag
assert_a_mode_change_forces_a_full_resync
assert_a_tag_change_forces_a_full_resync
assert_a_re_acquisition_forces_a_full_resync
assert_make_deploy_all_renders_the_mode_aware_overlay
assert_the_render_dir_resolver_follows_the_recorded_mode
assert_an_overridden_tag_renders_from_a_copy_carrying_that_tag
assert_a_render_copy_carries_the_generated_api_ip_patch
assert_a_render_copy_without_the_generated_api_ip_patch_fails_with_a_remedy
assert_the_pinned_render_dir_is_not_gated_on_the_generated_patch
assert_an_unknown_image_source_is_rejected
assert_a_targeted_build_carries_the_recorded_coordinate_forward
assert_the_touched_scripts_parse
assert_incremental_runtime_calls_are_bounded
assert_empty_incremental_docker_env_fails_closed
assert_every_defined_case_is_invoked

exit $FAIL
