#!/usr/bin/env bash
set -u
FAIL=0

# promote-release-images.sh is the driver test-resolve-release-images.sh does
# NOT cover: it loops deploy/images.json (via images-manifest.mjs), builds
# the promoted tag string, and decides whether a broken or empty image list
# is a loud failure or a silent no-op success. crane is stubbed on PATH; git
# and node are real, against a small throwaway repo -- these cases are about
# the driver's own plumbing, not the registry.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# A throwaway repo carrying real copies of the three release scripts (not
# symlinks: images-manifest.mjs computes its manifest path relative to its
# OWN file location via import.meta.url, which Node resolves through a
# symlink back to this repo's real deploy/images.json -- only a real copy
# reads the throwaway one) plus a one-image deploy/images.json and a
# v0.1.0 tag two commits deep, so ancestry is real rather than mocked.
make_repo() {
  local d=$1
  mkdir -p "$d/widget" "$d/scripts/release" "$d/deploy"
  cp "$REPO_ROOT/scripts/release/images-manifest.mjs" "$d/scripts/release/"
  cp "$REPO_ROOT/scripts/release/resolve-release-images.mjs" "$d/scripts/release/"
  cp "$REPO_ROOT/scripts/release/promote-release-images.sh" "$d/scripts/release/"
  # resolve-release-images.mjs imports argValue from here.
  cp "$REPO_ROOT/scripts/release/release-coordinates.mjs" "$d/scripts/release/"
  cat > "$d/deploy/images.json" <<'JSON'
{
  "images": [
    {
      "name": "widget",
      "path": "widget",
      "source_paths": ["widget/**"],
      "published": true,
      "deployed_to_minikube": false
    }
  ]
}
JSON
  ( cd "$d" && git init -q .
    echo one > widget/a.ts && git add -A && git -c user.email=t@t -c user.name=t commit -qm one
    echo two > widget/a.ts && git add -A && git -c user.email=t@t -c user.name=t commit -qm two
    git tag v0.1.0 )
}

# A manifest with the SAME one entry, minus `published`. images-manifest.mjs
# throws for this at import time -- the case this reproduces is the reviewer's:
# a broken manifest must fail the run, not vanish into an empty image list.
write_broken_manifest() {
  cat > "$1/deploy/images.json" <<'JSON'
{
  "images": [
    {
      "name": "widget",
      "path": "widget",
      "source_paths": ["widget/**"],
      "deployed_to_minikube": false
    }
  ]
}
JSON
}

# A manifest that PARSES successfully but publishes nothing. This is the
# "succeeded, but shipped zero images" trap, distinct from write_broken_manifest
# above ("failed to even parse"): both must be loud failures, but only the
# empty-list guard (not the command-substitution fix) catches this one.
write_empty_manifest() {
  cat > "$1/deploy/images.json" <<'JSON'
{
  "images": []
}
JSON
}

# make_stub <dir> <revision> [manifests_json]
# manifests_json defaults to a real amd64+arm64 pair; pass a single-entry
# array to simulate a non-multi-arch (amd64-only) index for the arch-guard
# case below.
make_stub() {
  local dir=$1 revision=$2
  local manifests=${3:-'[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]'}
  mkdir -p "$dir/bin"
  cat > "$dir/bin/crane" <<STUB
#!/usr/bin/env bash
COPY_LOG="$dir/copy-log"
case "\$1" in
  digest)   echo "sha256:widgetdigest00000000000000000000000000000000000000000000000000" ;;
  manifest) echo '{"annotations":{"org.opencontainers.image.revision":"$revision"},"manifests":$manifests}' ;;
  copy)     echo "\$2 \$3" >> "\$COPY_LOG"; echo "copied \$2 -> \$3" ;;
  *)        exit 1 ;;
esac
STUB
  chmod +x "$dir/bin/crane"
}

assert_a_broken_image_manifest_fails_loudly_not_silently() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  make_stub "$d" "$old"
  write_broken_manifest "$d"
  # This is the reviewer's exact repro: images-manifest.mjs's load() throws
  # at import time. `mapfile -t IMAGES < <(...)` used to hide that failure
  # from `set -e` entirely -- the run printed a Node stack trace, exited 0,
  # and promoted nothing.
  #
  # Message-shaped, not rc-shaped: an rc-only check (plus "no promotion
  # line") is satisfied by ANY failure anywhere in the script -- proven by
  # inserting a bare `exit 1` at the top of the driver, which left this case
  # passing while the driver did nothing resembling the actual guard. This
  # must name the specific reason, the same pattern that caught the masking
  # bug in the sibling resolver harness ("ancestor" / "revision annotation").
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=true RELEASE_REF=v0.1.0 \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -q 'could not load the published image list' <<< "$out"; then
    pass "a broken image manifest fails the release loudly with a named reason, not silently"
  else
    fail "expected the 'could not load the published image list' message; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_a_healthy_manifest_still_dry_run_promotes() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  # revision == tag_sha (HEAD, which v0.1.0 also points to): a commit is
  # trivially its own ancestor and its own diff is always empty, so the
  # resolver succeeds regardless of what changed between commits -- this
  # case is about the driver's tag construction, not the resolver's
  # ancestor/diff guards (already covered by test-resolve-release-images.sh).
  local head; head="$( cd "$d" && git rev-parse HEAD )"
  make_stub "$d" "$head"
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=true RELEASE_REF=v0.1.0 \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=1
  # Regression guard for the fix above: a HEALTHY manifest must still reach
  # the promotion line, not just an unhealthy one failing loudly.
  if [ "$rc" -eq 0 ] && grep -q ':v0.1.0' <<< "$out"; then
    pass "a healthy manifest still dry-run promotes, with the v-prefixed tag in the echo"
  else
    fail "expected exit 0 and a :v0.1.0 dry-run line; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_the_real_promotion_copies_to_the_v_prefixed_tag() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  # Same reasoning as the dry-run case above: revision == tag_sha so the
  # resolver's own guards are a non-issue here.
  local head; head="$( cd "$d" && git rev-parse HEAD )"
  make_stub "$d" "$head"
  ( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=false RELEASE_REF=v0.1.0 \
        bash scripts/release/promote-release-images.sh >/dev/null 2>&1 )
  local log; log="$(cat "$d/copy-log" 2>/dev/null || echo '')"
  # The tag that lands must carry a "v" prefix -- the consuming workstream
  # pins a v-prefixed image tag downstream. This checks the actual `crane
  # copy` destination argument, not just an echo string, since the echo and
  # the real copy target were two separate lines that could drift from each
  # other.
  if grep -q 'ghcr.io/evenfire-ai/widget:v0.1.0$' <<< "$log" && grep -q 'ghcr.io/evenfire-ai/widget:stable$' <<< "$log"; then
    pass "a real promotion copies to the v-prefixed version tag and moves :stable for a strict release"
  else
    fail "expected copy destinations ending :v0.1.0 and :stable; got copy-log '$log'"
  fi
  rm -rf "$d"
}

assert_an_empty_image_list_fails_loudly() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local head; head="$( cd "$d" && git rev-parse HEAD )"
  make_stub "$d" "$head"
  write_empty_manifest "$d"
  # Distinct from the broken-manifest case above: images-manifest.mjs's
  # load() does not throw here (an empty `images` array is valid), so the
  # command-substitution fix alone would let this through with IMAGES_TSV
  # empty. Only the separate non-empty check catches it. Checked by message,
  # not rc, for the same reason as the broken-manifest case: without this
  # guard, an empty list still happens to exit nonzero (mapfile on an empty
  # here-string yields one empty row, which the resolver then rejects for
  # missing --image) -- but with the WRONG message, so an rc-only assertion
  # would pass against either the real guard or that coincidence.
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=true RELEASE_REF=v0.1.0 \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -q 'the published image list is empty' <<< "$out"; then
    pass "an empty published-image list fails the release loudly instead of silently promoting nothing"
  else
    fail "expected the 'published image list is empty' message; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_stable_does_not_move_for_a_pre_release() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" && git tag v0.1.0-rc1 )
  local head; head="$( cd "$d" && git rev-parse HEAD )"
  make_stub "$d" "$head"
  ( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=false RELEASE_REF=v0.1.0-rc1 \
        bash scripts/release/promote-release-images.sh >/dev/null 2>&1 )
  local log; log="$(cat "$d/copy-log" 2>/dev/null || echo '')"
  # The strict-semver gate (MOVE_STABLE) exists precisely so a pre-release
  # cannot re-point :stable, the tag the docs tell people to use. This is the
  # negative counterpart to assert_the_real_promotion_copies_to_the_v_prefixed_tag
  # above, which checks :stable DOES move for a strict release -- together
  # they bracket the gate in both directions.
  if grep -q 'ghcr.io/evenfire-ai/widget:v0.1.0-rc1$' <<< "$log" && ! grep -q ':stable$' <<< "$log"; then
    pass "a pre-release tag is promoted without moving :stable"
  else
    fail "expected a version-tag copy but no :stable copy for a pre-release; got copy-log '$log'"
  fi
  rm -rf "$d"
}

assert_a_single_arch_index_is_rejected() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local head; head="$( cd "$d" && git rev-parse HEAD )"
  # amd64 only: the failure mode this entire workstream exists to eliminate
  # is a single-platform copy silently promoted as if it were the multi-arch
  # index the pipeline is supposed to guarantee.
  make_stub "$d" "$head" '[{"platform":{"architecture":"amd64"}}]'
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=true RELEASE_REF=v0.1.0 \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -q 'expected amd64,arm64' <<< "$out"; then
    pass "a single-arch index is rejected instead of promoted"
  else
    fail "expected a nonzero exit naming 'expected amd64,arm64'; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# A two-image manifest, real copies of the three release scripts, and one
# commit on a v0.2.0 tag -- same real-copy reasoning as make_repo above, just
# with two source dirs and two manifest rows so a per-image failure has a
# sibling to keep promoting.
make_repo_two_images() {
  local d=$1
  mkdir -p "$d/widget-a" "$d/widget-b" "$d/scripts/release" "$d/deploy"
  cp "$REPO_ROOT/scripts/release/images-manifest.mjs" "$d/scripts/release/"
  cp "$REPO_ROOT/scripts/release/resolve-release-images.mjs" "$d/scripts/release/"
  cp "$REPO_ROOT/scripts/release/promote-release-images.sh" "$d/scripts/release/"
  cp "$REPO_ROOT/scripts/release/release-coordinates.mjs" "$d/scripts/release/"
  cat > "$d/deploy/images.json" <<'JSON'
{
  "images": [
    {
      "name": "widget-a",
      "path": "widget-a",
      "source_paths": ["widget-a/**"],
      "published": true,
      "deployed_to_minikube": false
    },
    {
      "name": "widget-b",
      "path": "widget-b",
      "source_paths": ["widget-b/**"],
      "published": true,
      "deployed_to_minikube": false
    }
  ]
}
JSON
  ( cd "$d" && git init -q .
    echo one > widget-a/a.ts && echo one > widget-b/a.ts
    git add -A && git -c user.email=t@t -c user.name=t commit -qm one
    git tag v0.2.0 )
}

# make_stub_manifest_fails_for <dir> <revision> <failing-image-name>
# Like make_stub above, but `crane manifest` fails outright (rather than
# returning a payload) on the SECOND call made against one named image --
# simulating the transient registry failure or malformed response this guard
# exists to survive without aborting the whole run.
#
# `crane manifest "$REGISTRY/$name@$digest"` is called with the exact same
# arguments TWICE per image: once inside resolve-release-images.mjs (to read
# the revision annotation) and once more by promote-release-images.sh itself
# (the arch-verification line this case targets). A stub that fails on every
# call for the named image can't tell those two call sites apart -- proven by
# writing exactly that first and watching this case pass even with the
# arch-check guard reverted, because the resolver's own (already-guarded)
# manifest read failed first and never reached the line under test. Only
# failing the SECOND call isolates the arch-check's own crane invocation.
make_stub_manifest_fails_for() {
  local dir=$1 revision=$2 failing=$3
  mkdir -p "$dir/bin"
  cat > "$dir/bin/crane" <<STUB
#!/usr/bin/env bash
COPY_LOG="$dir/copy-log"
CALL_COUNT_FILE="$dir/$failing-manifest-calls"
case "\$1" in
  digest)   echo "sha256:widgetdigest00000000000000000000000000000000000000000000000000" ;;
  manifest)
    case "\$2" in
      *"$failing@"*)
        n=\$(( \$(cat "\$CALL_COUNT_FILE" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$CALL_COUNT_FILE"
        if [ "\$n" -eq 1 ]; then
          echo '{"annotations":{"org.opencontainers.image.revision":"$revision"},"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}'
        else
          echo "crane stub: transient manifest fetch failure for $failing (call \$n)" >&2
          exit 1
        fi
        ;;
      *)
        echo '{"annotations":{"org.opencontainers.image.revision":"$revision"},"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}'
        ;;
    esac
    ;;
  copy)     echo "\$2 \$3" >> "\$COPY_LOG"; echo "copied \$2 -> \$3" ;;
  *)        exit 1 ;;
esac
STUB
  chmod +x "$dir/bin/crane"
}

assert_an_arch_verification_failure_for_one_image_does_not_abort_the_loop() {
  local d; d="$(mktemp -d)"; make_repo_two_images "$d"
  local head; head="$( cd "$d" && git rev-parse HEAD )"
  # widget-b's `crane manifest` call fails outright; widget-a's succeeds.
  # Before this was guarded with the same `if ! ...; then failed=1; continue;
  # fi` shape as the resolver call one line up, this bare assignment aborted
  # the WHOLE loop under `set -euo pipefail` the instant widget-b's pipe
  # failed -- so a transient registry hiccup on one image would have silently
  # skipped promoting every image after it too, the opposite of the
  # continue-on-one-failure pattern the resolver call already follows.
  make_stub_manifest_fails_for "$d" "$head" "widget-b"
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=true RELEASE_REF=v0.2.0 \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] \
      && grep -q 'would promote widget-a@' <<< "$out" \
      && ! grep -q 'would promote widget-b@' <<< "$out" \
      && grep -q 'widget-b:' <<< "$out"; then
    pass "an arch-verification failure for one image doesn't abort the loop; the other image still promotes, run still exits nonzero"
  else
    fail "expected widget-a promoted, widget-b named as failed, nonzero exit; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_every_defined_case_is_invoked() {
  # comm -23 over sorted lists -- same pattern as
  # test-resolve-release-images.sh and test-release-coordinates.sh.
  local defined invoked missing self
  self="$REPO_ROOT/scripts/tests/test-promote-release-images.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_a_broken_image_manifest_fails_loudly_not_silently
assert_a_healthy_manifest_still_dry_run_promotes
assert_the_real_promotion_copies_to_the_v_prefixed_tag
assert_an_empty_image_list_fails_loudly
assert_stable_does_not_move_for_a_pre_release
assert_a_single_arch_index_is_rejected
assert_an_arch_verification_failure_for_one_image_does_not_abort_the_loop
assert_every_defined_case_is_invoked

exit $FAIL
