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
  digest)   echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
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
  digest)   echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
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

# shellcheck source=lib/release-registry-stub.sh
. "$REPO_ROOT/scripts/tests/lib/release-registry-stub.sh"

PROMOTE_SRC='ghcr.io/evenfire-ai'
DIGEST_A='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
DIGEST_B='sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
DIGEST_OLD='sha256:0000000000000000000000000000000000000000000000000000000000000000'

# stub_two_images <d>: a two-image repo whose :latest indexes both carry the
# tag commit as their revision and are multi-arch. Sets HEAD_SHA.
stub_two_images() {
  local d=$1
  make_repo_two_images "$d"
  HEAD_SHA="$( cd "$d" && git rev-parse HEAD )"
  stub_install "$d"
  stub_image "$d" widget-a latest "$DIGEST_A" "$HEAD_SHA"
  stub_image "$d" widget-b latest "$DIGEST_B" "$HEAD_SHA"
}

# run_promote <d> <dry-run> <ref>: sets out and rc.
run_promote() {
  local d=$1 dry=$2 ref=$3
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN="$dry" RELEASE_REF="$ref" \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=$?
}

assert_a_refused_image_means_zero_copies() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # widget-b has no rows at all: nothing in the registry.
  : > "$d/registry.tsv"
  stub_image "$d" widget-a latest "$DIGEST_A" "$HEAD_SHA"
  local out rc; run_promote "$d" false v0.2.0
  # Exactly one image failed, and it is widget-b: a resolver that failed every
  # image would also leave the copy log empty.
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] \
      && grep -q '^::error::widget-b: no release candidate passed' <<< "$out" \
      && grep -qxF '::error::1 image(s) failed; promoted nothing' <<< "$out"; then
    pass "an image the resolver refuses blocks every copy"
  else
    fail "expected rc=1, empty copy-log, 'promoted nothing'; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_multi_arch_failure_in_pass_one_means_zero_copies() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  stub_image "$d" widget-b latest "$DIGEST_B" "$HEAD_SHA" amd64
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] && grep -q 'expected amd64,arm64' <<< "$out"; then
    pass "a single-arch image in pass one blocks every copy, even the healthy sibling"
  else
    fail "expected rc=1 and empty copy-log; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_an_existing_version_tag_with_another_digest_blocks_every_copy() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # :v0.2.0 already exists, but its index carries no revision annotation, so
  # the resolver rejects it as a candidate and :latest wins. A :v0.2.0 that
  # passed the checks would win instead and never move (see the re-run case).
  stub_image "$d" widget-a v0.2.0 "$DIGEST_OLD" -
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] \
      && grep -qF "::error::widget-a:v0.2.0 already points at $DIGEST_OLD; refusing to move a published version tag to $DIGEST_A" <<< "$out"; then
    pass "a published version tag pointing elsewhere blocks every copy"
  else
    fail "expected rc=1, empty copy-log, 'already points at'; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_any_other_version_tag_lookup_error_blocks_every_copy() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # Call 1 is the resolver's own-tag candidate, which finds nothing; call 2 is
  # promote's version-tag check, the one under test here.
  stub_error_from_call "$d" digest "$PROMOTE_SRC/widget-b:v0.2.0" 2 "Error: GET https://ghcr.io: DENIED: denied"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] \
      && grep -qF '::error::widget-b:v0.2.0: could not check the existing version tag: Error: GET https://ghcr.io: DENIED: denied' <<< "$out" \
      && grep -qxF '::error::1 image(s) failed; promoted nothing' <<< "$out"; then
    pass "a version-tag lookup error other than MANIFEST_UNKNOWN fails the image and blocks every copy"
  else
    fail "expected rc=1 and empty copy-log; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_rerun_after_a_complete_promotion_is_idempotent() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  printf '%s\t%s\t%s\n' "$PROMOTE_SRC/widget-a:v0.2.0" digest "$DIGEST_A" >> "$d/registry.tsv"
  printf '%s\t%s\t%s\n' "$PROMOTE_SRC/widget-b:v0.2.0" digest "$DIGEST_B" >> "$d/registry.tsv"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 0 ] && [ "$(wc -l < "$d/copy-log" | tr -d ' ')" = 4 ]; then
    pass "a rerun after a complete promotion succeeds and re-copies the same digests"
  else
    fail "expected rc=0 and 4 copies; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

# R7: the full source and destination refs, so a tab or candidate suffix
# leaking into a ref turns this red.
assert_the_full_registry_refs_are_pinned() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  local out rc; run_promote "$d" false v0.2.0
  local want
  want="$(printf '%s\n' \
    "$PROMOTE_SRC/widget-a@$DIGEST_A $PROMOTE_SRC/widget-a:v0.2.0" \
    "$PROMOTE_SRC/widget-b@$DIGEST_B $PROMOTE_SRC/widget-b:v0.2.0" \
    "$PROMOTE_SRC/widget-a@$DIGEST_A $PROMOTE_SRC/widget-a:stable" \
    "$PROMOTE_SRC/widget-b@$DIGEST_B $PROMOTE_SRC/widget-b:stable")"
  if [ "$rc" -eq 0 ] && [ "$(cat "$d/copy-log")" = "$want" ] \
      && grep -qxF "manifest $PROMOTE_SRC/widget-a@$DIGEST_A" "$d/crane-calls" \
      && grep -qxF "manifest $PROMOTE_SRC/widget-b@$DIGEST_B" "$d/crane-calls" \
      && grep -qxF "digest $PROMOTE_SRC/widget-a:v0.2.0" "$d/crane-calls" \
      && ! grep -q "$(printf '\t')" "$d/crane-calls"; then
    pass "every crane manifest, digest and copy ref is the exact registry/name@digest or :tag, with no tab or candidate suffix"
  else
    fail "expected exact refs; got rc=$rc copy-log='$(cat "$d/copy-log")' calls='$(cat "$d/crane-calls")' out='$out'"
  fi
  rm -rf "$d"
}

assert_every_version_tag_is_copied_before_any_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  local out rc; run_promote "$d" false v0.2.0
  local last_version first_stable
  last_version="$(grep -n ':v0.2.0$' "$d/copy-log" | tail -1 | cut -d: -f1)"
  first_stable="$(grep -n ':stable$' "$d/copy-log" | head -1 | cut -d: -f1)"
  if [ "$rc" -eq 0 ] && [ -n "$last_version" ] && [ -n "$first_stable" ] && [ "$last_version" -lt "$first_stable" ]; then
    pass "every :v0.2.0 copy lands before the first :stable copy"
  else
    fail "expected all version copies before stable; got rc=$rc copy-log='$(cat "$d/copy-log")'"
  fi
  rm -rf "$d"
}

assert_stable_does_not_move_backwards() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  ( cd "$d" && git tag v0.3.0 )
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 0 ] && grep -q ':v0.2.0$' "$d/copy-log" && ! grep -q ':stable$' "$d/copy-log" \
      && grep -qxF ':stable stays where it is: v0.2.0 is below v0.3.0, the highest release tag' <<< "$out"; then
    pass "promoting a version below the highest published tag does not move :stable, and says why"
  else
    fail "expected version copies and no :stable; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_raw_sha_rehearsal_names_candidates_and_never_moves_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  local out rc; run_promote "$d" true "$HEAD_SHA"
  if [ "$rc" -eq 0 ] && [ ! -s "$d/copy-log" ] \
      && grep -q "would promote widget-a@sha256:" <<< "$out" \
      && grep -q ' via latest -> :v' <<< "$out"; then
    pass "a raw-SHA dry run names the candidate tag and copies nothing"
  else
    fail "expected 'would promote widget-a@sha256:... via latest -> :v' and no copies; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# --- A copy pass that fails midway, and the re-run ---------------------------

DIGEST_A2='sha256:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2'

# tag_state <d>: what each widget tag points at after the runs so far.
tag_state() {
  local name tag
  for name in widget-a widget-b; do
    for tag in v0.2.0 stable; do
      printf '%s:%s=%s ' "$name" "$tag" "$(stub_tag_digest "$1" "$PROMOTE_SRC/$name:$tag")"
    done
  done
}

assert_a_failed_version_tag_copy_exits_non_zero_and_never_moves_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  stub_copy_error "$d" "$PROMOTE_SRC/widget-b:v0.2.0" "Error: PUT https://ghcr.io/v2/evenfire-ai/widget-b/manifests/v0.2.0: 503 Service Unavailable"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -ne 0 ] && grep -q 'widget-a:v0.2.0$' "$d/copy-log" && ! grep -q ':stable$' "$d/copy-log" \
      && grep -qF '503 Service Unavailable' <<< "$out"; then
    pass "a failed :v0.2.0 copy stops the run with a non-zero exit before any :stable copy"
  else
    fail "expected rc!=0, widget-a:v0.2.0 copied, no :stable; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_failed_stable_copy_exits_non_zero_and_stops() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # widget-a's :stable copy fails. Carrying on would move widget-b:stable and
  # report success with :stable pointing at two releases.
  stub_copy_error "$d" "$PROMOTE_SRC/widget-a:stable" "Error: PUT https://ghcr.io/v2/evenfire-ai/widget-a/manifests/stable: 503 Service Unavailable"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -ne 0 ] && [ "$(grep -c ':v0.2.0$' "$d/copy-log")" -eq 2 ] \
      && ! grep -q 'widget-b:stable$' "$d/copy-log" && grep -qF '503 Service Unavailable' <<< "$out"; then
    pass "a failed :stable copy stops the run with a non-zero exit"
  else
    fail "expected rc!=0, both :v0.2.0 copies and no widget-b:stable copy; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_rerun_after_a_copy_pass_failed_midway_converges() {
  # Run 1 fails at one copy: first at widget-b:v0.2.0 (only widget-a:v0.2.0
  # written), then at widget-b:stable (both version tags written, :stable
  # mixed). Before the re-run widget-a's :latest moves to a rebuild of the same
  # commit with another digest, as every dev push does. The re-run takes each
  # image's own :v0.2.0 first where run 1 wrote it, so it finishes the SAME
  # release instead of refusing to move widget-a:v0.2.0.
  local failing d out rc rc1 bad=''
  for failing in widget-b:v0.2.0 widget-b:stable; do
    d="$(mktemp -d)"; stub_two_images "$d"; stub_copy_writes_tags "$d"
    stub_copy_error "$d" "$PROMOTE_SRC/$failing" "Error: PUT $PROMOTE_SRC/$failing: 503 Service Unavailable"
    run_promote "$d" false v0.2.0; rc1=$rc
    stub_copy_errors_clear "$d"
    stub_image "$d" widget-a latest "$DIGEST_A2" "$HEAD_SHA"
    run_promote "$d" false v0.2.0
    if ! { [ "$rc1" -ne 0 ] && [ "$rc" -eq 0 ] \
        && [ "$(tag_state "$d")" = "widget-a:v0.2.0=$DIGEST_A widget-a:stable=$DIGEST_A widget-b:v0.2.0=$DIGEST_B widget-b:stable=$DIGEST_B " ] \
        && grep -qF "promoted widget-a@$DIGEST_A via v0.2.0 -> :v0.2.0" <<< "$out"; }; then
      bad="$bad [$failing: rc1=$rc1 rc=$rc tags='$(tag_state "$d")' out='$out']"
    fi
    rm -rf "$d"
  done
  if [ -z "$bad" ]; then
    pass "a re-run after a copy pass failed midway converges on the digests already published, with one :stable"
  else
    fail "expected run 2 to exit 0 with every :v0.2.0 and :stable on DIGEST_A/DIGEST_B, widget-a via v0.2.0;$bad"
  fi
}

# --- Guards the cases above do not reach ---------------------------------------

assert_promote_passes_every_source_path_to_the_resolver() {
  local d; d="$(mktemp -d)"; make_repo_two_images "$d"
  # widget-b lists two source paths, and only the second changes after the
  # commit both images were built at. promote must hand the resolver both.
  cat > "$d/deploy/images.json" <<'JSON'
{
  "images": [
    { "name": "widget-a", "path": "widget-a", "source_paths": ["widget-a/**"], "published": true, "deployed_to_minikube": false },
    { "name": "widget-b", "path": "widget-b", "source_paths": ["widget-a/**", "widget-b/**"], "published": true, "deployed_to_minikube": false }
  ]
}
JSON
  local built
  built="$( cd "$d" && git tag -d v0.2.0 >/dev/null && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm manifest && git rev-parse HEAD )"
  ( cd "$d" && echo two > widget-b/a.ts && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm two && git tag v0.2.0 )
  stub_install "$d"
  stub_image "$d" widget-a latest "$DIGEST_A" "$built"
  stub_image "$d" widget-b latest "$DIGEST_B" "$built"
  local out rc; run_promote "$d" true v0.2.0
  if [ "$rc" -eq 1 ] && grep -q 'would promote widget-a@' <<< "$out" \
      && ! grep -q 'would promote widget-b@' <<< "$out" && grep -q 'source changed' <<< "$out"; then
    pass "promote hands the resolver every source path, so drift in widget-b's second path refuses it"
  else
    fail "expected widget-a promoted and widget-b refused for 'source changed'; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# crane 0.22.1's HEAD-fallback warning for a missing tag, captured from
# ghcr.io on 2026-11-13. It shows a bare 404 whatever the GET then says.
PROMOTE_HEAD_FALLBACK_404='2026/11/13 02:10:53 HEAD request failed, falling back on GET: HEAD https://ghcr.io/v2/evenfire-ai/control-api/manifests/no-such-tag-fixture: unexpected status code 404 Not Found (HEAD responses have no body, use GET for details)'

assert_a_bare_not_found_on_the_version_tag_check_fails_the_image() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # The resolver's own-tag lookup (call 1) finds no widget-b:v0.2.0. promote's
  # check (call 2) gets the HEAD-fallback 404 and then a GET error that is not
  # MANIFEST_UNKNOWN, which is not "not found".
  stub_error_from_call "$d" digest "$PROMOTE_SRC/widget-b:v0.2.0" 2 \
    "$PROMOTE_HEAD_FALLBACK_404\nError: GET https://ghcr.io/v2/evenfire-ai/widget-b/manifests/v0.2.0: unexpected status code 404 Not Found"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] \
      && grep -qF '::error::widget-b:v0.2.0: could not check the existing version tag' <<< "$out"; then
    pass "a bare 404 without MANIFEST_UNKNOWN on the version-tag check fails the image"
  else
    fail "expected rc=1, no copies and 'could not check the existing version tag'; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_failing_crane_manifest_in_the_arch_check_fails_the_image() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # promote's own read of widget-b's index (the second one) prints the whole
  # index and then exits 1. Only pipefail sees that exit through the pipe.
  # shellcheck disable=SC2016 # the wrapper expands $1, $2, $* and $state at run time
  stub_wrap "$d" 'if [ "$1" = manifest ] && [ "$2" = '"$PROMOTE_SRC/widget-b@$DIGEST_B"' ] \
    && [ "$(grep -cxF -- "$*" "$state/crane-calls")" -ge 1 ]; then
  "$stub" "$@"; echo "crane stub: connection reset after the body" >&2; exit 1
fi'
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] \
      && grep -qF "::error::widget-b: could not verify the multi-arch manifest at $DIGEST_B" <<< "$out"; then
    pass "a crane manifest that prints the index and then fails still fails the arch check"
  else
    fail "expected rc=1, no copies and 'could not verify the multi-arch manifest'; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

# --- :stable only moves forward -----------------------------------------------

assert_a_higher_tag_pushed_to_origin_meanwhile_keeps_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # Another release pushed v0.3.0 to origin after this checkout was made. The
  # run fetches the tags right before :stable and leaves it alone.
  local origin; origin="$(mktemp -d)"
  git clone -q --bare "$d" "$origin/repo.git"
  git -C "$origin/repo.git" tag v0.3.0 "$HEAD_SHA"
  git -C "$d" remote add origin "$origin/repo.git"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 0 ] && [ "$(grep -c ':v0.2.0$' "$d/copy-log")" -eq 2 ] && ! grep -q ':stable$' "$d/copy-log" \
      && grep -qxF ':stable stays where it is: v0.2.0 is below v0.3.0, the highest release tag' <<< "$out"; then
    pass "a higher tag pushed to origin while the run copied keeps :stable where it is, and says why"
  else
    fail "expected two :v0.2.0 copies, no :stable and the reason line; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d" "$origin"
}

assert_a_failed_tag_fetch_stops_before_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  git -C "$d" remote add origin "$d/no-such-origin.git"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 1 ] && [ "$(grep -c ':v0.2.0$' "$d/copy-log")" -eq 2 ] && ! grep -q ':stable$' "$d/copy-log" \
      && grep -qF '::error::could not fetch the release tags from origin, so :stable was not moved' <<< "$out"; then
    pass "a failed tag fetch stops the run after the version tags and before :stable"
  else
    fail "expected rc=1, two :v0.2.0 copies, no :stable and the fetch error; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_higher_version_tagged_at_an_older_commit_does_not_move_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # v0.2.1 is the next commit. v0.2.2 is then tagged at the OLDER commit: the
  # higher version, without v0.2.1's changes. Moving :stable would roll it back.
  mkdir -p "$d/prep"; echo x > "$d/prep/x"
  ( cd "$d" && git add prep && git -c user.email=t@t -c user.name=t commit -qm two && git tag v0.2.1 \
    && git tag v0.2.2 "$HEAD_SHA" )
  local want=":stable stays where it is: v0.2.1, the highest other release tag, is not an ancestor of the release commit $HEAD_SHA"
  local out rc dry_out; run_promote "$d" true v0.2.2; dry_out=$out
  run_promote "$d" false v0.2.2
  if [ "$rc" -eq 0 ] && [ "$(grep -c ':v0.2.2$' "$d/copy-log")" -eq 2 ] && ! grep -q ':stable$' "$d/copy-log" \
      && grep -qxF "$want" <<< "$out" && grep -qxF "$want" <<< "$dry_out"; then
    pass "a higher version tagged at a commit that lacks the highest release does not move :stable, and says why"
  else
    fail "expected :v0.2.2 copies, no :stable and '$want' in the real and dry runs; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out' dry='$dry_out'"
  fi
  rm -rf "$d"
}

assert_an_ancestry_check_error_fails_instead_of_moving_stable() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # Same tags as the case above, but `git merge-base --is-ancestor` errors
  # (exit 128) instead of answering. That is not a "yes": the run stops before
  # any registry call rather than moving :stable on an unanswered question.
  mkdir -p "$d/prep"; echo x > "$d/prep/x"
  ( cd "$d" && git add prep && git -c user.email=t@t -c user.name=t commit -qm two && git tag v0.2.1 \
    && git tag v0.2.2 "$HEAD_SHA" )
  git_shim_fail_on "$d" 128 "merge-base --is-ancestor v0.2.1 *"
  local out rc; run_promote "$d" false v0.2.2
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] && [ ! -s "$d/crane-calls" ] \
      && grep -qF '::error::could not compare v0.2.2 against the existing release tags' <<< "$out"; then
    pass "an error from the :stable ancestry check fails the run before any copy"
  else
    fail "expected rc=1, no crane call and 'could not compare'; got rc=$rc copy-log='$(cat "$d/copy-log")' out='$out'"
  fi
  rm -rf "$d"
}

# --- Refs, exit codes and output -----------------------------------------------

assert_a_dry_run_from_a_ref_that_is_not_an_image_tag_skips_the_version_tag_check() {
  # HEAD~0 and refs/tags/v0.2.0 are refs git accepts, but :vHEAD~0 is not an
  # image tag: real crane answers "could not parse reference" for it, as
  # stubbed here. The dry run still rehearses every image.
  local ref d out rc bad=''
  for ref in 'HEAD~0' 'refs/tags/v0.2.0'; do
    d="$(mktemp -d)"; stub_two_images "$d"
    stub_error "$d" "$PROMOTE_SRC/widget-a:v$ref" "Error: parsing reference \"$PROMOTE_SRC/widget-a:v$ref\": could not parse reference: $PROMOTE_SRC/widget-a:v$ref"
    stub_error "$d" "$PROMOTE_SRC/widget-b:v$ref" "Error: parsing reference \"$PROMOTE_SRC/widget-b:v$ref\": could not parse reference: $PROMOTE_SRC/widget-b:v$ref"
    run_promote "$d" true "$ref"
    if ! { [ "$rc" -eq 0 ] && grep -qF "would promote widget-a@$DIGEST_A via latest -> :v$ref" <<< "$out" \
        && grep -qF "would promote widget-b@$DIGEST_B via latest -> :v$ref" <<< "$out" \
        && grep -qxF ":v$ref is not a valid image tag, so this dry run skips the existing-version-tag check and the release's own tag candidate" <<< "$out" \
        && ! grep -qF ":v$ref" "$d/crane-calls"; }; then
      bad="$bad [$ref: rc=$rc out='$out' calls='$(tr '\n' ';' < "$d/crane-calls")']"
    fi
    rm -rf "$d"
  done
  if [ -z "$bad" ]; then
    pass "a dry run from a ref that makes no valid image tag skips every :vREF lookup and still rehearses"
  else
    fail "expected exit 0, both 'would promote' lines, the skip line and no :vREF lookup;$bad"
  fi
}

assert_a_real_run_from_a_ref_that_is_not_an_image_tag_fails() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  local out rc; run_promote "$d" false 'HEAD~0'
  if [ "$rc" -eq 1 ] && [ ! -s "$d/copy-log" ] && [ ! -s "$d/crane-calls" ] \
      && grep -qF '::error::HEAD~0 does not make a valid image tag (:vHEAD~0); refusing to promote' <<< "$out"; then
    pass "a real run from a ref that makes no valid image tag fails before any registry call"
  else
    fail "expected rc=1, no crane call and the invalid-tag error; got rc=$rc calls='$(cat "$d/crane-calls")' out='$out'"
  fi
  rm -rf "$d"
}

assert_a_dry_run_with_several_refused_images_exits_one() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  # Both images refused. The status is 1, not the count of failures: a count
  # wraps at 256, and 256 refused images would exit 0.
  : > "$d/registry.tsv"
  local out rc; run_promote "$d" true v0.2.0
  if [ "$rc" -eq 1 ] && [ "$(grep -c 'no release candidate passed' <<< "$out")" -eq 2 ]; then
    pass "a dry run with two refused images exits 1, not the failure count"
  else
    fail "expected rc=1 with two refusals; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_real_run_copy_lines_name_the_candidate() {
  local d; d="$(mktemp -d)"; stub_two_images "$d"
  local out rc; run_promote "$d" false v0.2.0
  if [ "$rc" -eq 0 ] \
      && grep -qxF "promoted widget-a@$DIGEST_A via latest -> :v0.2.0" <<< "$out" \
      && grep -qxF "promoted widget-b@$DIGEST_B via latest -> :v0.2.0" <<< "$out" \
      && grep -qxF "promoted widget-a@$DIGEST_A via latest -> :stable" <<< "$out"; then
    pass "a real run's copy lines name the candidate each digest came from"
  else
    fail "expected 'promoted <name>@<digest> via latest -> :v0.2.0' and '-> :stable' lines; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_a_malformed_resolver_line_fails_the_image() {
  # The resolver is replaced by one that prints a malformed line for every
  # image: a second tab, no tab at all, a digest that is not sha256 hex. Each
  # fails the image rather than being spliced into a crane ref.
  local line d out rc bad=''
  for line in "$DIGEST_A\\tlatest\\textra" "$DIGEST_A" 'sha256:XYZ\tlatest'; do
    d="$(mktemp -d)"; stub_two_images "$d"
    printf 'process.stdout.write("%s\\n")\n' "$line" > "$d/scripts/release/resolve-release-images.mjs"
    run_promote "$d" true v0.2.0
    if ! { [ "$rc" -eq 1 ] && ! grep -q 'would promote' <<< "$out" \
        && [ "$(grep -c '^::error::widget-[ab]: the resolver printed ' <<< "$out")" -eq 2 ]; }; then
      bad="$bad [$line: rc=$rc out='$out']"
    fi
    rm -rf "$d"
  done
  if [ -z "$bad" ]; then
    pass "a resolver line that is not exactly <sha256 digest><TAB><candidate> fails the image"
  else
    fail "expected rc=1, no 'would promote' and a 'the resolver printed' error per image;$bad"
  fi
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
assert_a_refused_image_means_zero_copies
assert_a_multi_arch_failure_in_pass_one_means_zero_copies
assert_an_existing_version_tag_with_another_digest_blocks_every_copy
assert_any_other_version_tag_lookup_error_blocks_every_copy
assert_a_rerun_after_a_complete_promotion_is_idempotent
assert_the_full_registry_refs_are_pinned
assert_every_version_tag_is_copied_before_any_stable
assert_stable_does_not_move_backwards
assert_a_raw_sha_rehearsal_names_candidates_and_never_moves_stable
assert_a_failed_version_tag_copy_exits_non_zero_and_never_moves_stable
assert_a_failed_stable_copy_exits_non_zero_and_stops
assert_a_rerun_after_a_copy_pass_failed_midway_converges
assert_promote_passes_every_source_path_to_the_resolver
assert_a_bare_not_found_on_the_version_tag_check_fails_the_image
assert_a_failing_crane_manifest_in_the_arch_check_fails_the_image
assert_a_higher_tag_pushed_to_origin_meanwhile_keeps_stable
assert_a_failed_tag_fetch_stops_before_stable
assert_a_higher_version_tagged_at_an_older_commit_does_not_move_stable
assert_an_ancestry_check_error_fails_instead_of_moving_stable
assert_a_dry_run_from_a_ref_that_is_not_an_image_tag_skips_the_version_tag_check
assert_a_real_run_from_a_ref_that_is_not_an_image_tag_fails
assert_a_dry_run_with_several_refused_images_exits_one
assert_real_run_copy_lines_name_the_candidate
assert_a_malformed_resolver_line_fails_the_image
assert_every_defined_case_is_invoked

exit $FAIL
