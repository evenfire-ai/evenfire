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
  # A revision that genuinely shares no history with tagSha -- an orphan
  # branch in the SAME repo, so the commit really exists as an object (the
  # existence check added below must NOT fire) and the two are truly
  # unrelated (neither an ancestor nor a descendant of the other), unlike a
  # bogus SHA that is not an object at all (covered separately below).
  local default_branch unrelated
  default_branch="$( cd "$d" && git branch --show-current )"
  unrelated="$( cd "$d" && git checkout -q --orphan unrelated-history \
      && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m unrelated \
      && git rev-parse HEAD )"
  ( cd "$d" && git checkout -q "$default_branch" )
  make_stub "$d" "sha256:abc" "$unrelated"
  # Check for the diverged-history guard's own wording, not just a nonzero
  # exit: an unrelated commit is also not an ancestor either direction, so if
  # the ancestor checks themselves were removed, the very next step (the
  # source-paths diff) would independently choke on an unrelated revision and
  # exit nonzero too. A bare rc-only assertion can't tell "the diverged-
  # history guard fired" apart from "something downstream happened to crash
  # instead."
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'control-api/**' --tag-sha HEAD 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "diverged history" <<< "$out"; then
    pass "a revision that truly shares no ancestry with the release commit is rejected as diverged history"
  else
    fail "expected a named failure about diverged history; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# Distinct from the diverged-history case above: this revision is not an
# object in the checkout AT ALL (a shallow clone, an unfetched ref, or a
# stray hand-edited annotation), so before the git cat-file -e existence
# check was added, BOTH --is-ancestor calls threw here exactly the same way
# they do for genuinely diverged history, and the resolver misreported this
# as "diverged history" even though there was no comparison to make -- the
# annotation just names a commit this checkout has never heard of.
assert_a_revision_absent_from_the_checkout_is_rejected_with_an_accurate_message() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  make_stub "$d" "sha256:abc" "0000000000000000000000000000000000000000"
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'control-api/**' --tag-sha HEAD 2>&1 )" && rc=0 || rc=1
  # "has no such commit" is this guard's own wording. "shares no ancestry" is
  # the OLD diverged-history die message's distinguishing phrase -- its
  # absence here proves this hit the new existence check, not the ancestor
  # comparison (the new message names "diverged history" too, but only to
  # contrast against it, so grepping for that phrase alone can't tell the two
  # guards apart).
  if [ "$rc" -ne 0 ] && grep -qi "has no such commit" <<< "$out" && ! grep -qi "shares no ancestry" <<< "$out"; then
    pass "a revision absent from the checkout is rejected with an accurate message, not misattributed as diverged history"
  else
    fail "expected a named 'has no such commit' failure without the diverged-history guard's wording; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_a_descendant_revision_is_rejected_with_accurate_advice() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local new; new="$( cd "$d" && git rev-parse HEAD )"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  # revision (HEAD, the NEWER commit) was built AFTER the release commit
  # (HEAD~1, the OLDER one): :latest raced ahead on dev while an older
  # commit got tagged for release -- e.g. a hotfix cut from an older base.
  # The generic "predates this release, merge dev into main" advice is
  # backwards here: an already-tagged historical commit cannot be merged
  # into descending from a later one. Distinguished from
  # assert_a_non_ancestor_revision_is_rejected above (which uses an
  # unrelated bogus SHA, i.e. diverged history) by using a revision that
  # IS related to tagSha, just on the wrong side of it.
  make_stub "$d" "sha256:abc" "$new"
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'control-api/**' --tag-sha "$old" 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "AFTER the release" <<< "$out" && ! grep -q "Merge dev into main" <<< "$out"; then
    pass "a revision that descends from the release commit is rejected with accurate, non-backwards advice"
  else
    fail "expected non-backwards descendant advice (\"AFTER the release\", no \"Merge dev into main\"); got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_a_source_change_after_the_revision_is_rejected() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  make_stub "$d" "sha256:abc" "$old"
  # control-api/** DID change between $old and HEAD, so promoting $old would
  # ship an image that predates the release's own source. Checked by message,
  # not rc alone, matching its two siblings above (the ancestor guard and the
  # missing-annotation guard): an rc-only check can't tell this specific
  # guard firing apart from any other failure that happens to exit nonzero.
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'control-api/**' --tag-sha HEAD 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "source changed" <<< "$out"; then
    pass "a source change after the published image is rejected"
  else
    fail "expected a named failure about the source changing after the published image; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_a_missing_revision_annotation_fails_loudly() {
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
  # "annotation", not "label": the value lives on the OCI index's own
  # annotations now, and the resolver's message was corrected to match --
  # this assertion would have masked that wording bug had it kept checking
  # for the old "revision label" phrase.
  if [ "$rc" -ne 0 ] && grep -qi "revision annotation" <<< "$out"; then
    pass "a missing revision annotation fails loudly rather than promoting blind"
  else
    fail "expected a named failure about the revision annotation; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_the_digest_is_resolved_once_and_reused() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local old; old="$( cd "$d" && git rev-parse HEAD~1 )"
  mkdir -p "$d/bin"
  # Two independent counters. `digest-calls` (as before) proves each `crane
  # digest` call returns a fresh value, so a repeated call would be caught by
  # `sha256:call1` no longer being what gets printed. `latest-refs` is the
  # broader net: it fires on ANY crane subcommand whose arguments reference
  # `:latest`, not only `digest`. A stub that only counted `digest` calls
  # cannot see the resolver re-reading the moving tag through a DIFFERENT
  # subcommand (e.g. `crane manifest .../image:latest` in place of
  # `.../image@$digest`) -- proven by mutating the resolver's manifest read
  # to do exactly that: with only the digest-only counter, nothing reddened.
  cat > "$d/bin/crane" <<STUB
#!/usr/bin/env bash
DIGEST_COUNT_FILE="$d/digest-calls"
LATEST_COUNT_FILE="$d/latest-refs"
if printf '%s ' "\$@" | grep -q ':latest'; then
  n=\$(( \$(cat "\$LATEST_COUNT_FILE" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$LATEST_COUNT_FILE"
  if [ "\$n" -gt 1 ]; then
    echo "crane stub: :latest referenced more than once (args: \$*)" >&2
    exit 1
  fi
fi
case "\$1" in
  digest)
    n=\$(( \$(cat "\$DIGEST_COUNT_FILE" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$DIGEST_COUNT_FILE"
    echo "sha256:call\$n"
    ;;
  manifest) echo '{"annotations":{"org.opencontainers.image.revision":"$old"}}' ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$d/bin/crane"
  local out; out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'unrelated/**' --tag-sha HEAD 2>&1 )"
  local digest_calls; digest_calls="$(cat "$d/digest-calls" 2>/dev/null || echo 0)"
  local latest_refs; latest_refs="$(cat "$d/latest-refs" 2>/dev/null || echo 0)"
  if [ "$digest_calls" = "1" ] && [ "$latest_refs" = "1" ] && grep -q "sha256:call1" <<< "$out"; then
    pass "the moving :latest tag is resolved to a digest exactly once"
  else
    fail "crane digest called $digest_calls time(s), :latest referenced $latest_refs time(s), output '$out'"
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
assert_a_revision_absent_from_the_checkout_is_rejected_with_an_accurate_message
assert_a_descendant_revision_is_rejected_with_accurate_advice
assert_a_source_change_after_the_revision_is_rejected
assert_a_missing_revision_annotation_fails_loudly
assert_the_digest_is_resolved_once_and_reused
assert_every_defined_case_is_invoked

exit $FAIL
