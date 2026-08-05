#!/usr/bin/env bash
set -u
FAIL=0

# resolve-release-images.mjs decides WHICH digest a release promotes. crane is
# stubbed on PATH throughout: these cases are about the decision logic, not the
# registry.
#
# The revision is read from the OCI INDEX's own annotations (`crane manifest`),
# not a per-arch child manifest's config label (`crane config --platform`).
# Both are written by build-publish.yml (Task 3): an index-level
# `--annotation index:org.opencontainers.image.revision=...` on the merged
# manifest list, and a per-leg `labels:` baked into each platform's image
# config. The index read is a single flat lookup with no --platform to pick,
# so the stub below returns `{"annotations": {...}}`.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# make_stub <dir> <digest> <revision>
make_stub() {
  mkdir -p "$1/bin"
  cat > "$1/bin/crane" <<STUB
#!/usr/bin/env bash
case "\$1" in
  digest)   echo "$2" ;;
  manifest) echo '{"annotations":{"org.opencontainers.image.revision":"$3"}}' ;;
  copy)     echo "copied \$2 -> \$3" ;;
  *)        exit 1 ;;
esac
STUB
  chmod +x "$1/bin/crane"
}

# A throwaway repo with two commits, so ancestry is real rather than mocked.
make_repo() {
  local d=$1
  mkdir -p "$d/control-api"
  ( cd "$d" && git init -q .
    echo one > control-api/a.ts && git add -A && git -c user.email=t@t -c user.name=t commit -qm one
    echo two > control-api/a.ts && git add -A && git -c user.email=t@t -c user.name=t commit -qm two )
}

assert_a_revision_that_is_an_ancestor_resolves() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  make_stub "$d" "sha256:abc" "$old"
  # No source change after $old on the paths we ask about, so this must resolve.
  if ( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'unrelated/**' --tag-sha HEAD >/dev/null 2>&1 ); then
    pass "an ancestor revision with no later source change resolves"
  else
    fail "a valid ancestor revision was rejected"
  fi
  rm -rf "$d"
}

assert_a_non_ancestor_revision_is_rejected() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  make_stub "$d" "sha256:abc" "0000000000000000000000000000000000000000"
  # Check for the ancestor guard's own wording, not just a nonzero exit: the
  # bogus revision below is also an unresolvable git object, so if the
  # ancestor check itself were removed, the very next step (the source-paths
  # diff) would independently choke on that same bogus revision and exit
  # nonzero too. A bare rc-only assertion can't tell "the ancestor guard
  # fired" apart from "something downstream happened to crash instead."
  local out
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'control-api/**' --tag-sha HEAD 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "ancestor" <<< "$out"; then
    pass "a revision that is not an ancestor of the release is rejected"
  else
    fail "expected a named failure about the revision not being an ancestor; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_a_source_change_after_the_revision_is_rejected() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  make_stub "$d" "sha256:abc" "$old"
  # control-api/** DID change between $old and HEAD, so promoting $old would
  # ship an image that predates the release's own source.
  if ( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'control-api/**' --tag-sha HEAD >/dev/null 2>&1 ); then
    fail "a source change after the published image was accepted"
  else
    pass "a source change after the published image is rejected"
  fi
  rm -rf "$d"
}

assert_a_missing_revision_label_fails_loudly() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  mkdir -p "$d/bin"
  cat > "$d/bin/crane" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  digest)   echo "sha256:abc" ;;
  manifest) echo '{"annotations":{}}' ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$d/bin/crane"
  local out
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'unrelated/**' --tag-sha HEAD 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "revision label" <<< "$out"; then
    pass "a missing revision label fails loudly rather than promoting blind"
  else
    fail "expected a named failure about the revision label; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_the_digest_is_resolved_once_and_reused() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  mkdir -p "$d/bin"
  # Emit a DIFFERENT digest on each call. If the script resolves :latest more
  # than once, the digest it verified is not the digest it would promote --
  # a time-of-check-to-time-of-use bug, because :latest moves on every dev push.
  cat > "$d/bin/crane" <<STUB
#!/usr/bin/env bash
COUNT_FILE="$d/digest-calls"
case "\$1" in
  digest)   n=\$(( \$(cat "\$COUNT_FILE" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$COUNT_FILE"; echo "sha256:call\$n" ;;
  manifest) echo '{"annotations":{"org.opencontainers.image.revision":"$old"}}' ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$d/bin/crane"
  local out; out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'unrelated/**' --tag-sha HEAD 2>&1 )"
  local calls; calls="$(cat "$d/digest-calls" 2>/dev/null || echo 0)"
  if [ "$calls" = "1" ] && grep -q "sha256:call1" <<< "$out"; then
    pass "the moving :latest tag is resolved to a digest exactly once"
  else
    fail "crane digest called $calls time(s), output '$out'"
  fi
  rm -rf "$d"
}

assert_every_defined_case_is_invoked() {
  # comm -23 over sorted lists. An earlier draft used a `while read` loop fed by
  # `grep -oE ... -P`, which mixes two incompatible matcher flags: the loop body
  # never ran, `missing` stayed empty, and the guard PASSED while printing its
  # own contradiction ("6 defined, 5 invoked"). This is the pattern proven to
  # redden in scripts/tests/test-release-coordinates.sh.
  local defined invoked missing self
  self="$REPO_ROOT/scripts/tests/test-resolve-release-images.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_a_revision_that_is_an_ancestor_resolves
assert_a_non_ancestor_revision_is_rejected
assert_a_source_change_after_the_revision_is_rejected
assert_a_missing_revision_label_fails_loudly
assert_the_digest_is_resolved_once_and_reused
assert_every_defined_case_is_invoked

exit $FAIL
