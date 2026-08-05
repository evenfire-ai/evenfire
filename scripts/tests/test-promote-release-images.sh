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

# make_stub <dir> <revision>
make_stub() {
  mkdir -p "$1/bin"
  cat > "$1/bin/crane" <<STUB
#!/usr/bin/env bash
COPY_LOG="$1/copy-log"
case "\$1" in
  digest)   echo "sha256:widgetdigest00000000000000000000000000000000000000000000000000" ;;
  manifest) echo '{"annotations":{"org.opencontainers.image.revision":"$2"},"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}' ;;
  copy)     echo "\$2 \$3" >> "\$COPY_LOG"; echo "copied \$2 -> \$3" ;;
  *)        exit 1 ;;
esac
STUB
  chmod +x "$1/bin/crane"
}

assert_a_broken_image_manifest_fails_loudly_not_silently() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  make_stub "$d" "$old"
  write_broken_manifest "$d"
  # This is the reviewer's exact repro: images-manifest.mjs's load() throws
  # at import time. `mapfile -t IMAGES < <(...)` used to hide that failure
  # from `set -e` entirely -- the run printed a Node stack trace, exited 0,
  # and promoted nothing. It must now exit nonzero and print no promotion
  # line.
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" DRY_RUN=true RELEASE_REF=v0.1.0 \
        bash scripts/release/promote-release-images.sh 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && ! grep -qE 'would promote|^promoted ' <<< "$out"; then
    pass "a broken image manifest fails the release loudly instead of silently promoting nothing"
  else
    fail "expected a nonzero exit and no promotion line; got rc=$rc out='$out'"
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
  # The consuming kustomize component and the operator recovery docs pin
  # newTag: v0.6.0 / MINIKUBE_IMAGE_TAG=v0.6.1 -- WITH the v. This checks the
  # actual `crane copy` destination argument, not just an echo string, since
  # the echo and the real copy target were two separate lines that could
  # drift from each other.
  if grep -q 'ghcr.io/evenfire-ai/widget:v0.1.0$' <<< "$log" && grep -q 'ghcr.io/evenfire-ai/widget:stable$' <<< "$log"; then
    pass "a real promotion copies to the v-prefixed version tag and moves :stable for a strict release"
  else
    fail "expected copy destinations ending :v0.1.0 and :stable; got copy-log '$log'"
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
assert_every_defined_case_is_invoked

exit $FAIL
