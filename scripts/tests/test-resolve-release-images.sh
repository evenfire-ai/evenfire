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

# Per-tag crane stub, git shim and the release-line fixture repo. The cases
# below that predate it keep their own one-answer-for-every-ref make_stub.
# shellcheck source=scripts/tests/lib/release-registry-stub.sh
source "$REPO_ROOT/scripts/tests/lib/release-registry-stub.sh"

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
  # No source change after $old on the paths we ask about, so this must
  # resolve, and print the digest and the candidate: an exit status alone is
  # also what a resolver that printed nothing would give.
  local out rc
  out="$( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
        --image control-api --source-paths 'unrelated/**' --tag-sha HEAD 2>/dev/null )" && rc=0 || rc=1
  if [ "$rc" -eq 0 ] && [ "$out" = "$(printf 'sha256:abc\tlatest')" ]; then
    pass "an ancestor revision with no later source change resolves to its digest via latest"
  else
    fail "expected exit 0 and stdout 'sha256:abc<TAB>latest'; got rc=$rc out='$out'"
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

# resolve_in <d> <image> <source-paths> <tag-sha> [release-tag]
# Runs the resolver inside <d> with "$d/bin" first on PATH, keeping stdout
# ("$d/stdout") apart from stderr ("$d/stderr"): stdout is the contract the
# promote script parses, so it is checked on its own. A fifth argument is
# passed as --release-tag. Returns the exit status.
resolve_in() {
  local d=$1
  ( cd "$d" && PATH="$d/bin:$PATH" node "$REPO_ROOT/scripts/release/resolve-release-images.mjs" \
      --image "$2" --source-paths "$3" --tag-sha "$4" ${5:+--release-tag "$5"} >"$d/stdout" 2>"$d/stderr" )
}

# load_shas <d>
# Sets C0 D1 M1 D3 F1 H1 T from the "$d/shas.env" that make_release_repo
# wrote. Bash scoping is dynamic, so they land in the caller's `local`s.
load_shas() {
  # shellcheck source=/dev/null # make_release_repo writes it at run time
  . "$1/shas.env"
}

assert_success_prints_digest_tab_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # other/** is untouched between C0 and T, so a :latest built at C0 passes
  # every check. Compared byte for byte, trailing newline included: the
  # promote script splits this line on the tab.
  stub_image "$d" other latest sha256:aaa "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:aaa\tlatest\n'); then
    pass "a passing candidate prints <digest><TAB><candidate tag> and nothing else on stdout"
  else
    fail "expected stdout 'sha256:aaa<TAB>latest'; got rc=$rc stdout='$(cat "$d/stdout")' stderr='$(cat "$d/stderr")'"
  fi
  rm -rf "$d"
}

assert_a_missing_latest_is_refused_not_crashed() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # No rows at all: :latest answers MANIFEST_UNKNOWN, which rejects that
  # candidate rather than failing the image. With every candidate rejected,
  # the image is refused with the per-candidate reasons and the remedy.
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
      && grep -q "no release candidate passed" "$d/stderr" \
      && grep -q "hotfix_images=widget" "$d/stderr"; then
    pass "a missing :latest is refused with the candidate list and the remedy, not crashed on"
  else
    fail "expected rc=1, empty stdout and a refusal naming the remedy; got rc=$rc stdout='$(cat "$d/stdout")' stderr='$(cat "$d/stderr")'"
  fi
  rm -rf "$d"
}

assert_an_is_ancestor_error_fails_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Without the shim this candidate passes (see the success case above).
  # `git merge-base --is-ancestor` exits 1 for "not an ancestor" and 128 for
  # an error. Reading 128 as "not an ancestor" would report diverged history
  # (or, in a longer chain, move on to the next candidate) on a checkout that
  # never answered the question.
  stub_image "$d" other latest sha256:aaa "$C0"
  git_shim_install "$d" 128
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && grep -q "exit 128" "$d/stderr" \
      && ! grep -qi "diverged history" "$d/stderr" \
      && ! grep -q "no release candidate passed" "$d/stderr"; then
    pass "an --is-ancestor error (exit 128) fails the image instead of reading as not-an-ancestor"
  else
    fail "expected rc=1 naming 'exit 128', without 'diverged history' or a refusal; got rc=$rc stdout='$(cat "$d/stdout")' stderr='$(cat "$d/stderr")'"
  fi
  rm -rf "$d"
}

assert_a_registry_error_on_latest_fails_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Only MANIFEST_UNKNOWN means "this tag does not exist". A rate limit says
  # nothing about the tag, so it fails the image: it is not reported as a
  # refusal, and (once there are later candidates) never falls through.
  stub_error "$d" "ghcr.io/evenfire-ai/other:latest" "TOOMANYREQUESTS: slow down"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && grep -q "TOOMANYREQUESTS" "$d/stderr" \
      && ! grep -q "no release candidate passed" "$d/stderr"; then
    pass "a registry error other than MANIFEST_UNKNOWN on :latest fails the image"
  else
    fail "expected rc=1 naming TOOMANYREQUESTS, not a refusal; got rc=$rc stdout='$(cat "$d/stdout")' stderr='$(cat "$d/stderr")'"
  fi
  rm -rf "$d"
}

# --- The previous release as the next candidate ------------------------------
#
# Every case below uses make_release_repo. Unless a case says otherwise,
# :latest was built at D3, dev's unmerged tip, so it is rejected as diverged
# history and the chain moves on to the previous release. Presence, absence
# and uniqueness are asserted, never exact call counts: more candidates may
# be inserted between :latest and the previous release.

# with_passing_previous_release <d>
# Tags v0.1.0 at C0 and publishes other:v0.1.0 as sha256:prev, built at C0.
# other/** has not changed since C0, so that candidate passes whenever the
# resolver reaches it.
with_passing_previous_release() {
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; only C0 is read here
  local C0 D1 M1 D3 F1 H1 T; load_shas "$1"
  git -C "$1" tag v0.1.0 "$C0"
  stub_image "$1" other v0.1.0 sha256:prev "$C0"
}

# candidate_line <d> <tag>: the "  <tag>: <reason>" line(s) on stderr.
candidate_line() {
  awk -v prefix="  $2: " 'index($0, prefix) == 1' "$1/stderr"
}

# error_line <d>: the "::error::" line on stderr.
error_line() {
  grep '^::error::' "$1/stderr"
}

# only_latest_was_queried <d>: crane was called, and only for :latest or for
# an index read by digest, so no later candidate's tag was ever looked up.
only_latest_was_queried() {
  [ -s "$1/crane-calls" ] && ! grep -v -e ':latest' -e '@sha256:' "$1/crane-calls" >/dev/null
}

# failed_at_latest <d> <rc> <phrase>
# The run failed the image while it was checking :latest: rc 1, nothing on
# stdout, <phrase> on stderr, no refusal, and no call for a later candidate.
# Callers publish a passing :v0.1.0, so falling through instead would
# succeed and print it.
failed_at_latest() {
  [ "$2" -eq 1 ] && [ ! -s "$1/stdout" ] && grep -qF -- "$3" "$1/stderr" \
    && ! grep -q "no release candidate passed" "$1/stderr" && only_latest_was_queried "$1"
}

# run_summary <d> <rc>: what one run produced, for a FAIL message.
run_summary() {
  printf "rc=%s stdout='%s' stderr='%s' crane-calls='%s'" \
    "$2" "$(cat "$1/stdout")" "$(cat "$1/stderr")" "$(tr '\n' ';' < "$1/crane-calls")"
}

assert_previous_release_wins_when_latest_is_dev_only() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # The v0.12.1 shape: :latest is dev's build, so it shares no history with
  # the release commit, and the previous release's image still matches the
  # source.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:prev\tv0.1.0\n'); then
    pass "a dev-only :latest falls back to the previous release's image"
  else
    fail "expected stdout 'sha256:prev<TAB>v0.1.0'; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_registry_errors_other_than_manifest_unknown_fail_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  # None of these says the tag is missing, so none may fall through to the
  # previous release (which would pass, and promote an older image).
  local e rc bad=''
  for e in UNAUTHORIZED DENIED TOOMANYREQUESTS NAME_UNKNOWN; do
    stub_install "$d"
    stub_image "$d" other v0.1.0 sha256:prev "$C0"
    stub_error "$d" "ghcr.io/evenfire-ai/other:latest" "$e: x"
    rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
    failed_at_latest "$d" "$rc" "$e" || bad="$bad [$e: $(run_summary "$d" "$rc")]"
  done
  if [ -z "$bad" ]; then
    pass "UNAUTHORIZED, DENIED, TOOMANYREQUESTS and NAME_UNKNOWN on :latest fail the image without trying the previous release"
  else
    fail "expected each registry error to fail the image at :latest;$bad"
  fi
  rm -rf "$d"
}

assert_a_transient_error_on_the_previous_release_fails_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  # A rate limit on the previous release's tag, and on its index read by
  # digest. Either one fails the image. The output still lists the candidate
  # rejected before it (:latest, diverged), so the log shows the whole chain.
  local ref rc bad=''
  for ref in ghcr.io/evenfire-ai/other:v0.1.0 ghcr.io/evenfire-ai/other@sha256:prev; do
    stub_install "$d"
    stub_image "$d" other latest sha256:lat "$D3"
    stub_image "$d" other v0.1.0 sha256:prev "$C0"
    stub_error "$d" "$ref" "TOOMANYREQUESTS: slow down"
    rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
    if ! { [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
        && error_line "$d" | grep -q '^::error::other: v0\.1\.0: .*TOOMANYREQUESTS' \
        && ! grep -q "no release candidate passed" "$d/stderr" \
        && candidate_line "$d" latest | grep -q "diverged history"; }; then
      bad="$bad [$ref: $(run_summary "$d" "$rc")]"
    fi
  done
  if [ -z "$bad" ]; then
    pass "a transient error on the previous release fails the image and still lists the rejected :latest"
  else
    fail "expected rc=1, '::error::other: v0.1.0: ...TOOMANYREQUESTS', no refusal and a '  latest: ' rejection line;$bad"
  fi
  rm -rf "$d"
}

assert_a_previous_release_on_the_tag_commit_or_rc_is_ignored() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # v0.2.0 is the release being cut (it points at the tag commit), and an rc
  # is not a release. Both would pass if queried, so picking either shows up
  # on stdout as well as in the call log.
  with_passing_previous_release "$d"
  git -C "$d" tag v0.1.5-rc1 "$M1"
  git -C "$d" tag v0.2.0 "$T"
  stub_image "$d" other latest sha256:lat "$D3"
  stub_image "$d" other v0.1.5-rc1 sha256:rc "$M1"
  stub_image "$d" other v0.2.0 sha256:self "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:prev\tv0.1.0\n') \
      && grep -qF ':v0.1.0' "$d/crane-calls" \
      && ! grep -qF ':v0.2.0' "$d/crane-calls" && ! grep -qF ':v0.1.5-rc1' "$d/crane-calls"; then
    pass "a tag on the tag commit itself, or an rc tag, is never taken as the previous release"
  else
    fail "expected v0.1.0 to be the previous release, with no :v0.2.0 or :v0.1.5-rc1 lookup; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_the_highest_reachable_release_wins_numerically() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # v0.10.0 beats v0.9.0 as a number (not as a string), and v0.11.0 sits on
  # D3, which the release commit does not contain. All three would pass.
  git -C "$d" tag v0.9.0 "$C0"
  git -C "$d" tag v0.10.0 "$M1"
  git -C "$d" tag v0.11.0 "$D3"
  stub_image "$d" other latest sha256:lat "$D3"
  stub_image "$d" other v0.9.0 sha256:nine "$C0"
  stub_image "$d" other v0.10.0 sha256:ten "$M1"
  stub_image "$d" other v0.11.0 sha256:eleven "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:ten\tv0.10.0\n') \
      && grep -qF ':v0.10.0' "$d/crane-calls" \
      && ! grep -qF ':v0.9.0' "$d/crane-calls" && ! grep -qF ':v0.11.0' "$d/crane-calls"; then
    pass "the highest release tag reachable from the tag commit wins, compared numerically"
  else
    fail "expected v0.10.0 only (not v0.9.0, not the unreachable v0.11.0); got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_an_annotated_previous_release_tag_works() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Today's release tags are lightweight; an annotated one must work the same.
  git -C "$d" -c user.email=t@t -c user.name=t -c tag.gpgSign=false tag -a v0.1.0 -m r "$C0"
  stub_image "$d" other v0.1.0 sha256:prev "$C0"
  stub_image "$d" other latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:prev\tv0.1.0\n'); then
    pass "an annotated previous-release tag is found like a lightweight one"
  else
    fail "expected stdout 'sha256:prev<TAB>v0.1.0' from an annotated v0.1.0; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_no_previous_release_tries_only_latest() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && grep -q "no release candidate passed" "$d/stderr" \
      && grep -qF "no previous release reachable from $T" "$d/stderr" \
      && only_latest_was_queried "$d"; then
    pass "with no previous release, only :latest is tried and the image is refused"
  else
    fail "expected a refusal after :latest alone; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_every_candidate_missing_is_refused_with_the_remedy() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # No rows: neither :latest nor :v0.1.0 exists, as for an image first
  # published after v0.1.0. Each candidate gets its own line, and the
  # missing previous release says how a failed release tag is cleared.
  git -C "$d" tag v0.1.0 "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
      && grep -q "no release candidate passed" "$d/stderr" \
      && grep -q "hotfix_images=other" "$d/stderr" \
      && candidate_line "$d" latest | grep -qF 'ghcr.io/evenfire-ai/other:latest does not exist' \
      && candidate_line "$d" v0.1.0 | grep -qF 'ghcr.io/evenfire-ai/other:v0.1.0 does not exist' \
      && candidate_line "$d" v0.1.0 | grep -qF 'delete the v0.1.0 tag and push v0.1.0 again at the fixed commit'; then
    pass "every candidate missing is refused with one line per candidate and the remedy"
  else
    fail "expected '  latest: ' and '  v0.1.0: ' lines, the failed-tag hint and hotfix_images=other; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_candidate_without_annotation_is_rejected_and_the_next_wins() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat -
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$(cut -f2 "$d/stdout")" = v0.1.0 ]; then
    pass "a candidate with no revision annotation is rejected and the next candidate wins"
  else
    fail "expected the previous release to win after an unannotated :latest; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_each_candidate_tag_is_resolved_once() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Each tag is turned into a digest once, and everything else about that
  # candidate is read through the digest: a tag can be re-pointed between two
  # reads, so a second read could check one image and promote another.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] \
      && grep -qFx 'digest ghcr.io/evenfire-ai/other:latest' "$d/crane-calls" \
      && grep -qFx 'digest ghcr.io/evenfire-ai/other:v0.1.0' "$d/crane-calls" \
      && [ -z "$(grep '^digest ' "$d/crane-calls" | sort | uniq -d)" ] \
      && ! grep '^manifest ' "$d/crane-calls" | grep -qv '@sha256:'; then
    pass "each candidate tag is resolved to a digest once, and its index is read by digest"
  else
    fail "expected one 'digest' call per candidate tag and every 'manifest' call by digest; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

# --- Errors fail the image; they never fall through ---------------------------
#
# Each case breaks :latest in one way that says nothing about the candidate,
# and publishes a :v0.1.0 that passes. Moving on would print sha256:prev; the
# image must fail instead, before any later candidate is queried.

assert_a_revision_missing_from_the_checkout_fails_without_trying_the_next_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat 0123456789abcdef0123456789abcdef01234567
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if failed_at_latest "$d" "$rc" "has no such commit"; then
    pass "a revision missing from the checkout fails the image without trying the previous release"
  else
    fail "expected 'has no such commit' to fail the image at :latest; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_manifest_read_error_fails_without_trying_the_next_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$M1"
  stub_error "$d" "ghcr.io/evenfire-ai/other@sha256:lat" "UNAUTHORIZED: authentication required"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if failed_at_latest "$d" "$rc" "UNAUTHORIZED"; then
    pass "a crane manifest error on :latest's index fails the image without trying the previous release"
  else
    fail "expected the manifest read error to fail the image at :latest; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_an_unreadable_manifest_fails_without_trying_the_next_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  # Text that is not JSON, and JSON that is not an object: neither is an
  # index, so neither may read as "this index has no revision annotation".
  local payload rc bad=''
  for payload in 'not json' 'null' '[]' '42'; do
    stub_install "$d"
    stub_image "$d" other v0.1.0 sha256:prev "$C0"
    stub_image "$d" other latest sha256:lat "$M1"
    stub_manifest "$d" "ghcr.io/evenfire-ai/other@sha256:lat" "$payload"
    rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
    failed_at_latest "$d" "$rc" "could not read the image manifest" \
      || bad="$bad [$payload: $(run_summary "$d" "$rc")]"
  done
  if [ -z "$bad" ]; then
    pass "a manifest that is not JSON, or is JSON but not an object, fails the image without trying the previous release"
  else
    fail "expected each unreadable manifest to fail the image at :latest;$bad"
  fi
  rm -rf "$d"
}

assert_a_git_diff_error_fails_without_trying_the_next_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # :latest (M1) reaches the source diff, and only its diff fails. The
  # previous release (C0) would diff cleanly and pass.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$M1"
  git_shim_fail_on "$d" 128 "diff --name-only $M1 *"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if failed_at_latest "$d" "$rc" "could not diff"; then
    pass "a git diff error fails the image without trying the previous release"
  else
    fail "expected the git diff error to fail the image at :latest; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_forward_is_ancestor_error_fails_without_trying_the_next_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$M1"
  git_shim_fail_on "$d" 128 "merge-base --is-ancestor $M1 $T"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if failed_at_latest "$d" "$rc" "exit 128"; then
    pass "an --is-ancestor error on :latest fails the image without trying the previous release"
  else
    fail "expected the --is-ancestor error to fail the image at :latest; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_reverse_is_ancestor_error_fails_instead_of_reading_as_diverged() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # D3 really is not an ancestor of T, so the first --is-ancestor call
  # answers 1. Only the reverse call (is T an ancestor of D3?) errors.
  # Reading that error as "no" would report diverged history and move on.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  git_shim_fail_on "$d" 128 "merge-base --is-ancestor $T $D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if failed_at_latest "$d" "$rc" "exit 128" && ! grep -qi "diverged history" "$d/stderr"; then
    pass "an error on the reverse --is-ancestor check fails the image instead of reading as diverged history"
  else
    fail "expected the reverse --is-ancestor error to fail the image at :latest, without 'diverged history'; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_git_tag_error_fails_instead_of_meaning_no_previous_release() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # :latest is rejected; listing the release tags then errors. That is not
  # "there is no previous release", so it must not end in a refusal.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  git_shim_fail_on "$d" 128 'tag *'
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && error_line "$d" | grep -q '^::error::other: finding the previous release: git tag.*exit 128' \
      && ! grep -q "no release candidate passed" "$d/stderr" && only_latest_was_queried "$d" \
      && candidate_line "$d" latest | grep -q "diverged history"; then
    pass "a git error while finding the previous release fails the image, listing the rejected :latest"
  else
    fail "expected a 'git tag ... exit 128' failure, no refusal, and the '  latest: ' rejection; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_passing_latest_never_looks_for_a_previous_release() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # The previous release is looked up only once :latest was rejected. With
  # `git tag` broken, a resolver that looked it up first would fail here.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$C0"
  git_shim_fail_on "$d" 128 'tag *'
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:lat\tlatest\n') && only_latest_was_queried "$d"; then
    pass "a passing :latest never looks up the previous release"
  else
    fail "expected :latest to win without any git tag lookup; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

# --- Reasons that fit the candidate -----------------------------------------

assert_a_descendant_reason_blames_dev_only_for_latest() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Releasing H1, both candidates were built at T, which descends from H1.
  # ":latest moved ahead on dev" is true of :latest only.
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" other latest sha256:lat "$T"
  stub_image "$d" other v0.1.0 sha256:prev "$T"
  local rc=0; resolve_in "$d" other 'other/**' "$H1" || rc=$?
  if [ "$rc" -eq 1 ] \
      && candidate_line "$d" latest | grep -q 'AFTER the release.*:latest moved ahead on dev' \
      && candidate_line "$d" v0.1.0 | grep -q 'AFTER the release' \
      && ! candidate_line "$d" v0.1.0 | grep -q ':latest'; then
    pass "a descendant revision blames dev for :latest and only for :latest"
  else
    fail "expected the dev-specific descendant reason on '  latest: ' only; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_source_drift_reason_says_push_to_dev_only_for_latest() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # widget/a.ts changed after M1 (F1) and after C0, so both candidates drift.
  # Pushing to dev can refresh :latest, but never a released tag.
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$M1"
  stub_image "$d" widget v0.1.0 sha256:prev "$C0"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] \
      && candidate_line "$d" latest | grep -q 'source changed.*Push to dev' \
      && candidate_line "$d" v0.1.0 | grep -q 'source changed' \
      && ! candidate_line "$d" v0.1.0 | grep -q 'Push to dev'; then
    pass "a source-drift reason says 'Push to dev' for :latest and only for :latest"
  else
    fail "expected 'Push to dev' on '  latest: ' only; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

# --- main's first-parent sha-<c7> candidates ----------------------------------
#
# All use tag v0.1.0 at C0, image widget (widget/**) and :latest built at D3
# (dev only, rejected). First-parent history of v0.1.0..T is T, H1, M1, so the
# candidates run :latest, :sha-T, :sha-H1, :sha-M1, :v0.1.0. widget/** is
# unchanged between H1 and T, but changed between M1 and T.

assert_a_main_built_hotfix_image_wins_over_the_previous_release() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$D3"
  stub_image "$d" widget "sha-${H1:0:7}" sha256:hot "$H1"
  stub_image "$d" widget v0.1.0 sha256:prev "$C0"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:hot\tsha-%s\n' "${H1:0:7}"); then
    pass "a main-built sha- image at the exact commit wins over the previous release"
  else
    fail "expected 'sha256:hot<TAB>sha-${H1:0:7}'; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_the_newest_passing_sha_candidate_wins() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$D3"
  stub_image "$d" widget "sha-${H1:0:7}" sha256:hot "$H1"
  stub_image "$d" widget "sha-${T:0:7}" sha256:tee "$T"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$(cut -f2 "$d/stdout")" = "sha-${T:0:7}" ] \
      && [ "$(cut -f1 "$d/stdout")" = "sha256:tee" ]; then
    pass "the newest passing sha- candidate wins"
  else
    fail "expected the sha-${T:0:7} candidate; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_sha_candidate_with_a_different_revision_is_rejected() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$D3"
  # The tag names H1 but the image says M1.
  stub_image "$d" widget "sha-${H1:0:7}" sha256:odd "$M1"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && grep -qF "expected $H1" "$d/stderr" \
      && candidate_line "$d" "sha-${H1:0:7}" | grep -qF "built from $M1, expected $H1"; then
    pass "a sha- candidate built from another revision than its tag names is rejected"
  else
    fail "expected a rejection 'built from $M1, expected $H1'; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_second_parent_commits_are_never_queried() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  # D1 (M1's second parent) and F1 (H1's) were merged in, never pushed to
  # main. The first-parent commits T, H1 and M1 were looked up.
  if grep -qF "sha-${H1:0:7}" "$d/crane-calls" && grep -qF "sha-${M1:0:7}" "$d/crane-calls" \
      && ! grep -qF "sha-${D1:0:7}" "$d/crane-calls" && ! grep -qF "sha-${F1:0:7}" "$d/crane-calls"; then
    pass "second-parent commits are never queried as sha- candidates"
  else
    fail "expected sha- lookups for H1 and M1 only; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

# walk_of <d> <n>: adds empty commits to main so v0.1.0..HEAD has exactly <n>
# first-parent commits (T, H1 and M1 already make three), and prints the tip.
walk_of() {
  local i
  for i in $(seq 1 $(( $2 - 3 ))); do
    _release_stub_git "$1" commit -q --allow-empty -m "extra $i" || return 1
  done
  git -C "$1" rev-parse HEAD
}

assert_a_walk_of_exactly_the_bound_is_probed_and_one_more_fails_the_image() {
  local n d tip rc
  for n in 50 51; do
    d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
    # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
    local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
    git -C "$d" tag v0.1.0 "$C0"
    stub_image "$d" widget latest sha256:lat "$D3"
    tip="$(walk_of "$d" "$n")" || return 1
    rc=0; resolve_in "$d" widget 'widget/**' "$tip" || rc=$?
    if [ "$n" -eq 50 ]; then
      # At the bound: no bound failure, and every commit's sha- tag is probed.
      if [ "$rc" -eq 1 ] && ! grep -qF "more than 50" "$d/stderr" \
          && grep -q "no release candidate passed" "$d/stderr" \
          && [ "$(grep -c ':sha-' "$d/crane-calls")" -eq 50 ]; then
        pass "a walk of exactly 50 first-parent commits is probed, not refused for its length"
      else
        fail "expected 50 sha- probes and a normal refusal; got $(run_summary "$d" "$rc")"
      fi
    else
      if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && grep -qF "more than 50" "$d/stderr" \
          && ! grep -q "no release candidate passed" "$d/stderr" \
          && ! grep -q ':sha-' "$d/crane-calls"; then
        pass "a walk of 51 first-parent commits fails the image before any sha- tag is probed"
      else
        fail "expected 'more than 50' and no sha- probe; got $(run_summary "$d" "$rc")"
      fi
    fi
    rm -rf "$d"
  done
}

assert_the_sha_candidates_are_tried_before_the_previous_release() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Both the hotfix image and the previous release's image pass for `other`,
  # so only the order decides.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  stub_image "$d" other "sha-${H1:0:7}" sha256:hot "$H1"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:hot\tsha-%s\n' "${H1:0:7}"); then
    pass "a passing sha- candidate is chosen before a passing previous release"
  else
    fail "expected 'sha256:hot<TAB>sha-${H1:0:7}'; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_mislabelled_sha_tag_that_would_otherwise_pass_does_not_win() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$D3"
  # :sha-T records H1: an ancestor of T with widget/** unchanged H1..T, so it
  # would pass if the tag were taken at its word. Only the exact check stops it.
  stub_image "$d" widget "sha-${T:0:7}" sha256:wrong "$H1"
  stub_image "$d" widget "sha-${H1:0:7}" sha256:hot "$H1"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:hot\tsha-%s\n' "${H1:0:7}"); then
    pass "a sha- tag recording another commit does not win even when that commit would pass"
  else
    fail "expected sha-${H1:0:7} to win; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_git_rev_list_error_fails_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$D3"
  git_shim_fail_on "$d" 128 'rev-list *'
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && error_line "$d" | grep -q 'rev-list.*exit 128' \
      && ! grep -q "no release candidate passed" "$d/stderr" && only_latest_was_queried "$d"; then
    pass "a git rev-list error fails the image instead of being a refusal"
  else
    fail "expected a 'rev-list ... exit 128' failure and no refusal; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_latest_passing_skips_every_other_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:lat\tlatest\n') && only_latest_was_queried "$d"; then
    pass "a passing :latest makes no lookup for any sha- or version candidate"
  else
    fail "expected only :latest to be queried; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_non_latest_reasons_give_no_latest_or_dev_advice() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  stub_image "$d" widget latest sha256:lat "$D3"
  # :sha-T carries no annotation; :v0.1.0 is built on diverged history (D3).
  stub_image "$d" widget "sha-${T:0:7}" sha256:noann -
  stub_image "$d" widget v0.1.0 sha256:div "$D3"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" || rc=$?
  local t1 t2
  t1="$(candidate_line "$d" "sha-${T:0:7}")"; t2="$(candidate_line "$d" v0.1.0)"
  if [ "$rc" -eq 1 ] && grep -qF 'revision annotation' <<< "$t1" && grep -qF 'diverged history' <<< "$t2" \
      && ! grep -qiE 'build_all|:latest|dev' <<< "$t1" \
      && ! grep -qiE 'Re-publish|:latest|dev' <<< "$t2" && grep -qF 'hotfix_images=widget' <<< "$t2"; then
    pass "no-annotation and diverged reasons for a non-latest candidate give no :latest or dev advice"
  else
    fail "expected neutral reasons; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

# --- The release's own tag (--release-tag) ------------------------------------
#
# promote-release-images.sh passes the version tag it promotes to. It is the
# first candidate, so a re-run after a copy pass that failed midway converges
# on what the first run already published.

assert_the_release_own_tag_wins_before_latest() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # An earlier run copied other:v0.2.0 from an image built at C0, and :latest
  # has since moved to another build that would pass too. The own tag wins,
  # with no exact-revision rule (C0 is not T), and :latest is never queried.
  git -C "$d" tag v0.2.0 "$T"
  stub_image "$d" other v0.2.0 sha256:own "$C0"
  stub_image "$d" other latest sha256:lat "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" v0.2.0 || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:own\tv0.2.0\n') \
      && ! grep -qF ':latest' "$d/crane-calls"; then
    pass "the release's own existing tag wins before :latest, which is never queried"
  else
    fail "expected 'sha256:own<TAB>v0.2.0' and no :latest lookup; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_missing_release_own_tag_is_rejected_without_the_failed_tag_hint() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # On a first run the own tag does not exist yet. That is normal, so its
  # reason says so and gives none of the "delete the tag" advice that the
  # previous release's missing tag still gets.
  git -C "$d" tag v0.1.0 "$C0"
  git -C "$d" tag v0.2.0 "$T"
  stub_image "$d" other latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" v0.2.0 || rc=$?
  local own; own="$(candidate_line "$d" v0.2.0)"
  if [ "$rc" -eq 1 ] && grep -q "no release candidate passed" "$d/stderr" \
      && grep -qF 'ghcr.io/evenfire-ai/other:v0.2.0 does not exist' <<< "$own" \
      && grep -qF 'this release has not promoted other yet' <<< "$own" \
      && ! grep -qF 'delete the' <<< "$own" \
      && candidate_line "$d" v0.1.0 | grep -qF 'delete the v0.1.0 tag'; then
    pass "a missing own tag is rejected as not promoted yet, without the failed-tag advice"
  else
    fail "expected a '  v0.2.0: ' line saying it was not promoted yet, with no 'delete the' advice; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_release_own_tag_that_fails_a_check_is_rejected_and_the_chain_continues() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # The own tag goes through the same checks as any candidate. Built at M1,
  # widget/** has changed since (F1), so it is rejected and :latest is tried.
  git -C "$d" tag v0.2.0 "$T"
  stub_image "$d" widget v0.2.0 sha256:own "$M1"
  stub_image "$d" widget latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" widget 'widget/**' "$T" v0.2.0 || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
      && candidate_line "$d" v0.2.0 | grep -q 'source changed' \
      && ! candidate_line "$d" v0.2.0 | grep -q 'Push to dev' \
      && candidate_line "$d" latest | grep -q 'diverged history'; then
    pass "an own tag that fails a check is rejected like any candidate, and the chain goes on to :latest"
  else
    fail "expected '  v0.2.0: source changed' (no 'Push to dev') then a '  latest: ' rejection; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_registry_error_on_the_release_own_tag_fails_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # A rate limit says nothing about whether the own tag exists, so it fails
  # the image; :latest, which would pass, is never queried.
  git -C "$d" tag v0.2.0 "$T"
  stub_error "$d" "ghcr.io/evenfire-ai/other:v0.2.0" "TOOMANYREQUESTS: slow down"
  stub_image "$d" other latest sha256:lat "$C0"
  local rc=0; resolve_in "$d" other 'other/**' "$T" v0.2.0 || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
      && error_line "$d" | grep -q '^::error::other: v0\.2\.0: .*TOOMANYREQUESTS' \
      && ! grep -q "no release candidate passed" "$d/stderr" && ! grep -qF ':latest' "$d/crane-calls"; then
    pass "a registry error on the own tag fails the image without trying :latest"
  else
    fail "expected '::error::other: v0.2.0: ...TOOMANYREQUESTS' and no :latest lookup; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

# --- Guards the cases above do not reach ---------------------------------------

assert_drift_in_the_second_source_path_rejects_the_candidate() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # Many published images list several source paths. widget/** changed after
  # M1 (F1, via H1) and other/** did not, so drift in the SECOND path alone
  # must reject the candidate.
  stub_image "$d" widget latest sha256:lat "$M1"
  local rc=0; resolve_in "$d" widget 'other/**,widget/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
      && candidate_line "$d" latest | grep -q 'source changed' \
      && grep -qx '    widget/a.ts' "$d/stderr"; then
    pass "drift in the second of two source paths rejects the candidate"
  else
    fail "expected '  latest: source changed' listing widget/a.ts; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_transient_error_on_a_sha_candidate_fails_the_image() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  # A rate limit on the hotfix image's tag, and on its index read by digest.
  # Either one fails the image; the previous release, which would pass, is
  # never queried.
  local ref rc bad=''
  for ref in "ghcr.io/evenfire-ai/other:sha-${H1:0:7}" ghcr.io/evenfire-ai/other@sha256:hot; do
    stub_install "$d"
    stub_image "$d" other v0.1.0 sha256:prev "$C0"
    stub_image "$d" other latest sha256:lat "$D3"
    stub_image "$d" other "sha-${H1:0:7}" sha256:hot "$H1"
    stub_error "$d" "$ref" "TOOMANYREQUESTS: slow down"
    rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
    if ! { [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] \
        && error_line "$d" | grep -q "^::error::other: sha-${H1:0:7}: .*TOOMANYREQUESTS" \
        && ! grep -q "no release candidate passed" "$d/stderr" \
        && ! grep -qF ':v0.1.0' "$d/crane-calls"; }; then
      bad="$bad [$ref: $(run_summary "$d" "$rc")]"
    fi
  done
  if [ -z "$bad" ]; then
    pass "a transient error on a sha- candidate (tag or index) fails the image and never reaches the previous release"
  else
    fail "expected '::error::other: sha-${H1:0:7}: ...TOOMANYREQUESTS' and no :v0.1.0 lookup;$bad"
  fi
  rm -rf "$d"
}

# crane 0.22.1's stderr for a missing tag, captured from ghcr.io on 2026-11-13
# (`crane digest ghcr.io/evenfire-ai/control-api:no-such-tag-fixture`): the
# HEAD-fallback warning, which shows a bare 404, then the GET error.
CRANE_HEAD_FALLBACK_404='2026/11/13 02:10:53 HEAD request failed, falling back on GET: HEAD https://ghcr.io/v2/evenfire-ai/control-api/manifests/no-such-tag-fixture: unexpected status code 404 Not Found (HEAD responses have no body, use GET for details)'
CRANE_GET_MANIFEST_UNKNOWN='Error: GET https://ghcr.io/v2/evenfire-ai/control-api/manifests/no-such-tag-fixture: MANIFEST_UNKNOWN: manifest unknown'

assert_a_head_fallback_not_found_counts_only_with_manifest_unknown() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  git -C "$d" tag v0.1.0 "$C0"
  # The captured stderr as is: :latest does not exist, so it is rejected and
  # the previous release wins. The same HEAD line followed by any other GET
  # error fails the image: the 404 on the HEAD line alone is not "not found".
  local get rc bad=''
  for get in "$CRANE_GET_MANIFEST_UNKNOWN" \
      'Error: GET https://ghcr.io/v2/evenfire-ai/control-api/manifests/no-such-tag-fixture: unexpected status code 404 Not Found' \
      'Error: GET https://ghcr.io/v2/evenfire-ai/control-api/manifests/no-such-tag-fixture: unexpected status code 502 Bad Gateway'; do
    stub_install "$d"
    stub_image "$d" other v0.1.0 sha256:prev "$C0"
    printf '%s\n%s\n' "$CRANE_HEAD_FALLBACK_404" "$get" > "$d/crane-stderr"
    stub_error_file "$d" ghcr.io/evenfire-ai/other:latest "$d/crane-stderr"
    rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
    if [ "$get" = "$CRANE_GET_MANIFEST_UNKNOWN" ]; then
      { [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:prev\tv0.1.0\n'); } \
        || bad="$bad [MANIFEST_UNKNOWN should reject: $(run_summary "$d" "$rc")]"
    else
      failed_at_latest "$d" "$rc" "${get##*: }" || bad="$bad [${get##*: } should fail: $(run_summary "$d" "$rc")]"
    fi
  done
  if [ -z "$bad" ]; then
    pass "crane's HEAD-fallback 404 rejects a candidate only with MANIFEST_UNKNOWN from the GET; any other GET error fails the image"
  else
    fail "expected MANIFEST_UNKNOWN to reject and every other GET error to fail the image at :latest;$bad"
  fi
  rm -rf "$d"
}

assert_a_two_part_tag_is_never_the_previous_release() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # v0.2 is reachable and above v0.1.0 on its first two parts, and its image
  # would pass. It is not a strict vX.Y.Z tag, so it is not a release.
  with_passing_previous_release "$d"
  git -C "$d" tag v0.2 "$M1"
  stub_image "$d" other v0.2 sha256:two "$C0"
  stub_image "$d" other latest sha256:lat "$D3"
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:prev\tv0.1.0\n') \
      && ! grep -qxF 'digest ghcr.io/evenfire-ai/other:v0.2' "$d/crane-calls"; then
    pass "a two-part v0.2 tag is never taken as the previous release"
  else
    fail "expected v0.1.0 to win with no :v0.2 lookup; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_an_empty_revision_annotation_is_rejected_and_the_next_wins() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # An annotation that is present but empty names no commit: the candidate
  # is rejected like one with no annotation, not failed as a git error.
  with_passing_previous_release "$d"
  stub_image "$d" other latest sha256:lat ""
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$d/stdout" <(printf 'sha256:prev\tv0.1.0\n'); then
    pass "an empty revision annotation is rejected and the next candidate wins"
  else
    fail "expected 'sha256:prev<TAB>v0.1.0'; got $(run_summary "$d" "$rc")"
  fi
  rm -rf "$d"
}

assert_a_crane_killed_by_a_signal_fails_the_image_whatever_it_printed() {
  local d; d="$(mktemp -d)"; make_release_repo "$d"; stub_install "$d"
  # shellcheck disable=SC2034 # load_shas sets all seven fixture SHAs; each case reads what it needs
  local C0 D1 M1 D3 F1 H1 T; load_shas "$d"
  # crane printed MANIFEST_UNKNOWN, then was killed. A process that did not
  # exit says nothing reliable, so this is not "not found".
  with_passing_previous_release "$d"
  # shellcheck disable=SC2016 # the wrapper expands $1, $2 and $$ at run time
  stub_wrap "$d" 'if [ "$1" = digest ] && [ "$2" = ghcr.io/evenfire-ai/other:latest ]; then
  echo "Error: GET https://ghcr.io/v2/evenfire-ai/other/manifests/latest: MANIFEST_UNKNOWN: manifest unknown" >&2
  kill -KILL $$
fi'
  local rc=0; resolve_in "$d" other 'other/**' "$T" || rc=$?
  if [ "$rc" -eq 1 ] && [ ! -s "$d/stdout" ] && grep -q 'signal SIGKILL' "$d/stderr" \
      && ! grep -q "no release candidate passed" "$d/stderr"; then
    pass "a crane killed by a signal fails the image even after printing MANIFEST_UNKNOWN"
  else
    fail "expected rc=1 naming 'signal SIGKILL', not a fall-through; got $(run_summary "$d" "$rc")"
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
assert_success_prints_digest_tab_candidate
assert_a_missing_latest_is_refused_not_crashed
assert_an_is_ancestor_error_fails_the_image
assert_a_registry_error_on_latest_fails_the_image
assert_previous_release_wins_when_latest_is_dev_only
assert_registry_errors_other_than_manifest_unknown_fail_the_image
assert_a_transient_error_on_the_previous_release_fails_the_image
assert_a_previous_release_on_the_tag_commit_or_rc_is_ignored
assert_the_highest_reachable_release_wins_numerically
assert_an_annotated_previous_release_tag_works
assert_no_previous_release_tries_only_latest
assert_every_candidate_missing_is_refused_with_the_remedy
assert_a_candidate_without_annotation_is_rejected_and_the_next_wins
assert_each_candidate_tag_is_resolved_once
assert_a_revision_missing_from_the_checkout_fails_without_trying_the_next_candidate
assert_a_manifest_read_error_fails_without_trying_the_next_candidate
assert_an_unreadable_manifest_fails_without_trying_the_next_candidate
assert_a_git_diff_error_fails_without_trying_the_next_candidate
assert_a_forward_is_ancestor_error_fails_without_trying_the_next_candidate
assert_a_reverse_is_ancestor_error_fails_instead_of_reading_as_diverged
assert_a_git_tag_error_fails_instead_of_meaning_no_previous_release
assert_a_passing_latest_never_looks_for_a_previous_release
assert_a_descendant_reason_blames_dev_only_for_latest
assert_a_source_drift_reason_says_push_to_dev_only_for_latest
assert_a_main_built_hotfix_image_wins_over_the_previous_release
assert_the_newest_passing_sha_candidate_wins
assert_a_sha_candidate_with_a_different_revision_is_rejected
assert_second_parent_commits_are_never_queried
assert_a_walk_of_exactly_the_bound_is_probed_and_one_more_fails_the_image
assert_the_sha_candidates_are_tried_before_the_previous_release
assert_a_mislabelled_sha_tag_that_would_otherwise_pass_does_not_win
assert_a_git_rev_list_error_fails_the_image
assert_latest_passing_skips_every_other_candidate
assert_non_latest_reasons_give_no_latest_or_dev_advice
assert_the_release_own_tag_wins_before_latest
assert_a_missing_release_own_tag_is_rejected_without_the_failed_tag_hint
assert_a_release_own_tag_that_fails_a_check_is_rejected_and_the_chain_continues
assert_a_registry_error_on_the_release_own_tag_fails_the_image
assert_drift_in_the_second_source_path_rejects_the_candidate
assert_a_transient_error_on_a_sha_candidate_fails_the_image
assert_a_head_fallback_not_found_counts_only_with_manifest_unknown
assert_a_two_part_tag_is_never_the_previous_release
assert_an_empty_revision_annotation_is_rejected_and_the_next_wins
assert_a_crane_killed_by_a_signal_fails_the_image_whatever_it_printed
assert_every_defined_case_is_invoked

exit $FAIL
