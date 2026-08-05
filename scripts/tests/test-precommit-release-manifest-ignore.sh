#!/usr/bin/env bash
set -u
FAIL=0

# The precommit bumper must ignore external-rest-api/src/releaseManifest.ts.
# A later task adds scripts/release/prepare-release.mjs as that file's writer;
# if staging it bumps external-rest-api/package.json, the manifest is stale
# the instant it is written and --validate-only fails on every release-prep
# PR, forever.
#
# It must also keep the manifest's own counters (externalRestApiVersion,
# rpcProxyVersion) in sync with the package.json versions it bumps, without
# ever touching desktopVersion (that's a separate release flow), without
# fabricating a releaseId, without clobbering a contributor's unstaged
# manifest edit, and without permanently disarming itself if a re-sync fails
# partway through.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# desktop-app/package.json is deliberately set ABOVE the manifest's
# desktopVersion (0.1.333 vs 0.1.252). desktop-app is not in packageRoots (this
# hook never bumps it) and is not a MANIFEST_COUNTER_PACKAGES entry, so a
# fixture that pinned them equal would be structurally incapable of catching
# a re-sync that wrongly published desktopVersion from desktop-app/package.json.
make_repo() {
  local d=$1
  mkdir -p "$d/external-rest-api/src" "$d/rpc-proxy/src" "$d/desktop-app" "$d/scripts/precommit" "$d/scripts/prettier" "$d/scripts/release"
  cp "$REPO_ROOT/scripts/precommit/bump-staged-package-versions.mjs" "$d/scripts/precommit/"
  cp "$REPO_ROOT/scripts/prettier/paths.mjs" "$d/scripts/prettier/"
  cp "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" "$d/scripts/release/"
  cp "$REPO_ROOT/scripts/release/release-coordinates.mjs" "$d/scripts/release/"
  printf '{\n  "name": "external-rest-api",\n  "version": "0.1.60"\n}\n' \
    > "$d/external-rest-api/package.json"
  printf '{\n  "name": "rpc-proxy",\n  "version": "0.1.51"\n}\n' \
    > "$d/rpc-proxy/package.json"
  printf '{\n  "name": "desktop-app",\n  "version": "0.1.333"\n}\n' \
    > "$d/desktop-app/package.json"
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'fixture-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
  echo "export const x = 1" > "$d/external-rest-api/src/other.ts"
  echo "export const y = 1" > "$d/rpc-proxy/src/other.ts"
  ( cd "$d" && git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init )
}

version_of() { grep '"version"' "$1/external-rest-api/package.json" | sed 's/.*: "\(.*\)".*/\1/'; }
rpc_version_of() { grep '"version"' "$1/rpc-proxy/package.json" | sed 's/.*: "\(.*\)".*/\1/'; }
manifest_field() {
  # $1=dir $2=field name
  grep -E "^  $2: '" "$1/external-rest-api/src/releaseManifest.ts" | sed "s/.*'\(.*\)'.*/\1/"
}

assert_release_manifest_does_not_bump() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" \
    && echo "export const releaseManifest = { desktopVersion: '0.5.0' }" \
       > external-rest-api/src/releaseManifest.ts \
    && git add external-rest-api/src/releaseManifest.ts \
    && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  if [ "$(version_of "$d")" = "0.1.60" ]; then
    pass "staging releaseManifest.ts does not bump external-rest-api"
  else
    fail "releaseManifest.ts bumped external-rest-api to $(version_of "$d")"
  fi
  rm -rf "$d"
}

assert_other_source_still_bumps() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" \
    && echo "export const x = 2" > external-rest-api/src/other.ts \
    && git add external-rest-api/src/other.ts \
    && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  if [ "$(version_of "$d")" = "0.1.61" ]; then
    pass "an ordinary external-rest-api source change still bumps"
  else
    fail "expected 0.1.61 after an ordinary change, got $(version_of "$d")"
  fi
  rm -rf "$d"
}

assert_a_counter_bump_resyncs_the_manifest() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" \
    && echo "export const x = 2" > external-rest-api/src/other.ts \
    && git add external-rest-api/src/other.ts \
    && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )

  local manifest_ers staged
  manifest_ers="$(manifest_field "$d" externalRestApiVersion)"
  staged="$(cd "$d" && git diff --cached --name-only | grep -c releaseManifest.ts)"

  if [ "$manifest_ers" = "0.1.61" ] && [ "$staged" = "1" ]; then
    pass "a counter bump re-syncs the manifest and stages it"
  else
    fail "manifest externalRestApiVersion=$manifest_ers staged=$staged, expected 0.1.61 / 1"
  fi
  rm -rf "$d"
}

assert_rpc_proxy_bump_resyncs_the_manifest() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" \
    && echo "export const y = 2" > rpc-proxy/src/other.ts \
    && git add rpc-proxy/src/other.ts \
    && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )

  local pkg_rpc manifest_rpc
  pkg_rpc="$(rpc_version_of "$d")"
  manifest_rpc="$(manifest_field "$d" rpcProxyVersion)"

  if [ "$pkg_rpc" = "0.1.52" ] && [ "$manifest_rpc" = "0.1.52" ]; then
    pass "an rpc-proxy bump also re-syncs the manifest"
  else
    fail "rpc-proxy/package.json=$pkg_rpc manifest rpcProxyVersion=$manifest_rpc, expected 0.1.52 / 0.1.52"
  fi
  rm -rf "$d"
}

assert_desktop_version_not_touched_by_counter_resync() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  local status
  ( cd "$d" \
    && echo "export const x = 2" > external-rest-api/src/other.ts \
    && git add external-rest-api/src/other.ts \
    && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  status=$?

  local manifest_desktop manifest_ers manifest_min
  manifest_desktop="$(manifest_field "$d" desktopVersion)"
  manifest_ers="$(manifest_field "$d" externalRestApiVersion)"
  manifest_min="$(manifest_field "$d" minimumDesktopVersion)"

  # Assert the re-sync actually ran and succeeded (exit 0, ers moved), not
  # just that desktopVersion happens to be untouched -- a dead hook, or one
  # missing --defer-desktop-release entirely (which makes the updater's own
  # validate() reject 0.1.252 != 0.1.333 and exit nonzero), would ALSO leave
  # desktopVersion untouched, but only because the re-sync never completed.
  #
  # minimumDesktopVersion is asserted explicitly here too, not just implied
  # by desktopVersion staying put: this is the invariant the whole
  # workstream protects (a floor that ever equals desktopVersion force-
  # updates every existing desktop install), and the pre-commit path is the
  # one most likely to run on an ordinary service PR, so it must guard the
  # floor directly rather than by inference.
  if [ "$status" -eq 0 ] && [ "$manifest_ers" = "0.1.61" ] && [ "$manifest_desktop" = "0.1.252" ] \
    && [ "$manifest_min" = "0.1.252" ]; then
    pass "a counter re-sync succeeds and never touches desktopVersion or minimumDesktopVersion, even though desktop-app/package.json is ahead"
  else
    fail "status=$status externalRestApiVersion=$manifest_ers desktopVersion=$manifest_desktop minimumDesktopVersion=$manifest_min; expected 0 / 0.1.61 / 0.1.252 / 0.1.252"
  fi
  rm -rf "$d"
}

assert_resync_preserves_the_release_id() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" \
    && echo "export const x = 3" > external-rest-api/src/other.ts \
    && git add external-rest-api/src/other.ts \
    && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  local rid ers
  rid="$(manifest_field "$d" releaseId)"
  ers="$(manifest_field "$d" externalRestApiVersion)"
  # Also assert the counter actually moved, so this case can't pass simply
  # because the re-sync never ran at all.
  if [ "$rid" = "fixture-0000000" ] && [ "$ers" = "0.1.61" ]; then
    pass "the re-sync preserves releaseId instead of stamping 'local'"
  else
    fail "releaseId='$rid' externalRestApiVersion=$ers; the updater defaults releaseId to 'local' when --release-id is omitted"
  fi
  rm -rf "$d"
}

assert_unstaged_manifest_changes_block_the_resync() {
  local d; d="$(mktemp -d)"; make_repo "$d"

  # Edit the manifest on disk WITHOUT staging it -- a contributor's scratch
  # edit -- then trigger a counter bump that would otherwise re-sync it.
  (
    cd "$d" || exit 1
    cat > external-rest-api/src/releaseManifest.ts <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'UNSTAGED-SCRATCH',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
  )
  ( cd "$d" && echo "export const x = 2" > external-rest-api/src/other.ts && git add external-rest-api/src/other.ts )

  local status stderr_output
  stderr_output="$( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs 2>&1 >/dev/null )"
  status=$?

  local rid staged
  rid="$(manifest_field "$d" releaseId)"
  staged="$(cd "$d" && git diff --cached --name-only | grep -c releaseManifest.ts)"

  # Assert on the refusal MESSAGE, not just a nonzero exit code -- any other
  # unrelated failure would also exit nonzero and leave the manifest
  # untouched, which would let this case pass for the wrong reason.
  if [ "$status" -ne 0 ] && [ "$rid" = "UNSTAGED-SCRATCH" ] && [ "$staged" = "0" ] \
    && echo "$stderr_output" | grep -q "unstaged changes"; then
    pass "an unstaged manifest edit blocks the re-sync with a refusal message, instead of being silently committed"
  else
    fail "expected nonzero exit + refusal message + untouched + unstaged manifest; got status=$status releaseId='$rid' staged=$staged stderr='$stderr_output'"
  fi
  rm -rf "$d"
}

assert_a_failed_resync_recovers_on_retry() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  ( cd "$d" && echo "export const x = 2" > external-rest-api/src/other.ts && git add external-rest-api/src/other.ts )

  # Corrupt the manifest with conflict markers and STAGE the corruption, so
  # the bump loop still runs cleanly (no unstaged-changes refusal) but the
  # re-sync subprocess's own JSON.parse fails.
  (
    cd "$d" || exit 1
    cat > external-rest-api/src/releaseManifest.ts <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'fixture-0000000',
<<<<<<< HEAD
  externalRestApiVersion: '0.1.60',
=======
  externalRestApiVersion: '0.1.99',
>>>>>>> feature
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
    git add external-rest-api/src/releaseManifest.ts
  )

  local status1 ers_after_run1
  ( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  status1=$?
  ers_after_run1="$(version_of "$d")"

  # Resolve the "conflict": restore a valid, still-stale manifest and stage it.
  (
    cd "$d" || exit 1
    cat > external-rest-api/src/releaseManifest.ts <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'fixture-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
    git add external-rest-api/src/releaseManifest.ts
  )

  local status2 ers_field_after_retry
  ( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  status2=$?
  ers_field_after_retry="$(manifest_field "$d" externalRestApiVersion)"

  if [ "$status1" -ne 0 ] && [ "$ers_after_run1" = "0.1.61" ] && [ "$status2" -eq 0 ] && [ "$ers_field_after_retry" = "0.1.61" ]; then
    pass "a failed re-sync recovers on retry instead of permanently disarming itself"
  else
    fail "run1 status=$status1 package=$ers_after_run1; run2 status=$status2 manifest=$ers_field_after_retry"
  fi
  rm -rf "$d"
}

assert_missing_release_id_is_refused_not_fabricated() {
  local d; d="$(mktemp -d)"; make_repo "$d"
  (
    cd "$d" || exit 1
    cat > external-rest-api/src/releaseManifest.ts <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
    git add external-rest-api/src/releaseManifest.ts
    git -c user.email=t@t -c user.name=t commit -qm "drop releaseId"
  )
  ( cd "$d" && echo "export const x = 2" > external-rest-api/src/other.ts && git add external-rest-api/src/other.ts )

  local status
  ( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  status=$?

  if [ "$status" -ne 0 ] && ! grep -q "'local'" "$d/external-rest-api/src/releaseManifest.ts"; then
    pass "a missing releaseId is refused instead of fabricated as 'local'"
  else
    fail "expected nonzero exit and no fabricated 'local' releaseId; got status=$status, manifest: $(tr '\n' ' ' < "$d/external-rest-api/src/releaseManifest.ts")"
  fi
  rm -rf "$d"
}

assert_unstaged_package_json_drift_is_not_leaked_into_the_manifest() {
  local d; d="$(mktemp -d)"; make_repo "$d"

  # Edit external-rest-api/package.json on disk WITHOUT staging it, then make
  # an entirely unrelated staged commit (docs-only). Nothing about this commit
  # legitimately touches external-rest-api or rpc-proxy, so the manifest must
  # come out exactly as committed before -- reading disk here (instead of the
  # index) would falsely report drift and leak the never-to-be-committed
  # 0.9.99 into the manifest.
  ( cd "$d" && printf '{\n  "name": "external-rest-api",\n  "version": "0.9.99"\n}\n' > external-rest-api/package.json )
  ( cd "$d" && mkdir -p docs && echo "# docs" > docs/readme.md && git add docs/readme.md )

  local status
  ( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  status=$?

  local manifest_ers staged
  manifest_ers="$(manifest_field "$d" externalRestApiVersion)"
  staged="$(cd "$d" && git diff --cached --name-only | grep -c releaseManifest.ts)"

  if [ "$status" -eq 0 ] && [ "$manifest_ers" = "0.1.60" ] && [ "$staged" = "0" ]; then
    pass "an unstaged package.json edit is not read for drift detection (index, not disk)"
  else
    fail "status=$status manifest externalRestApiVersion=$manifest_ers staged=$staged; an unstaged 0.9.99 on disk must not leak into a committed manifest"
  fi
  rm -rf "$d"
}

assert_unrelated_unstaged_package_json_blocks_a_real_resync() {
  local d; d="$(mktemp -d)"; make_repo "$d"

  # rpc-proxy gets a legitimate, staged bump -- a real trigger for the
  # re-sync -- while external-rest-api/package.json has an unrelated UNSTAGED
  # edit. The updater re-reads every counter package.json from disk on every
  # invocation (not just the one that triggered it), so without a guard this
  # would leak the unstaged 0.9.99 into the manifest via a resync that had a
  # legitimate reason to run.
  ( cd "$d" && echo "export const y = 2" > rpc-proxy/src/other.ts && git add rpc-proxy/src/other.ts )
  ( cd "$d" && printf '{\n  "name": "external-rest-api",\n  "version": "0.9.99"\n}\n' > external-rest-api/package.json )

  local status
  ( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs >/dev/null 2>&1 )
  status=$?

  local manifest_ers staged
  manifest_ers="$(manifest_field "$d" externalRestApiVersion)"
  staged="$(cd "$d" && git diff --cached --name-only | grep -c releaseManifest.ts)"

  if [ "$status" -ne 0 ] && [ "$manifest_ers" = "0.1.60" ] && [ "$staged" = "0" ]; then
    pass "a real resync (triggered by rpc-proxy) refuses to run while an unrelated counter package.json has unstaged changes"
  else
    fail "status=$status manifest externalRestApiVersion=$manifest_ers staged=$staged; unstaged 0.9.99 must not leak via a resync triggered by a different package"
  fi
  rm -rf "$d"
}

assert_a_self_concealing_manifest_edit_cannot_suppress_the_resync() {
  local d; d="$(mktemp -d)"; make_repo "$d"

  # Trigger a REAL counter bump (ers 0.1.60 -> 0.1.61 gets staged by the loop)...
  ( cd "$d" && echo "export const x = 2" > external-rest-api/src/other.ts && git add external-rest-api/src/other.ts )

  # ...then, BEFORE running the hook, hand-edit the manifest ON DISK (never
  # staged) so its externalRestApiVersion already reads '0.1.61' -- the value
  # package.json is about to become. A disk-based drift check would see
  # currentVersion === manifestVersion and conclude nothing is out of sync,
  # even though the manifest that will actually be COMMITTED (the index,
  # still '0.1.60') was never touched. That's the self-concealing case: the
  # dirty file's content happens to make the drift check stay silent.
  (
    cd "$d" || exit 1
    cat > external-rest-api/src/releaseManifest.ts <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'fixture-0000000',
  externalRestApiVersion: '0.1.61',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
  )

  local status stderr_output
  stderr_output="$( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs 2>&1 >/dev/null )"
  status=$?

  local staged committed_ers
  staged="$(cd "$d" && git diff --cached --name-only | grep -c releaseManifest.ts)"
  committed_ers="$(cd "$d" && git show :external-rest-api/src/releaseManifest.ts 2>/dev/null | grep -E "^  externalRestApiVersion: '" | sed "s/.*'\(.*\)'.*/\1/")"

  # Must refuse (nonzero exit, refusal message) precisely BECAUSE the
  # unstaged-changes check now runs before the drift read can be fooled by
  # it -- not just "the manifest wasn't staged", which is also true of a
  # silent, broken success.
  if [ "$status" -ne 0 ] && [ "$staged" = "0" ] && [ "$committed_ers" = "0.1.60" ] \
    && echo "$stderr_output" | grep -q "unstaged changes"; then
    pass "an unstaged manifest edit that happens to already match disk cannot suppress the re-sync"
  else
    fail "expected refusal; got status=$status staged=$staged committed externalRestApiVersion=$committed_ers stderr='$stderr_output'"
  fi
  rm -rf "$d"
}

assert_a_corrupted_committed_package_json_is_refused_not_crashed() {
  local d; d="$(mktemp -d)"; make_repo "$d"

  # Simulate a package.json that slipped through with conflict markers still
  # in it (e.g. a bypassed hook, or a force-committed unresolved merge) --
  # already COMMITTED, not staged in THIS run, so the ordinary bump loop
  # (which only processes staged files) never touches it. The only code path
  # that reads it here is the drift check's readIndexedPackageVersion.
  (
    cd "$d" || exit 1
    cat > external-rest-api/package.json <<'EOF'
{
  "name": "external-rest-api",
<<<<<<< HEAD
  "version": "0.1.60"
=======
  "version": "0.1.61"
>>>>>>> feature
}
EOF
    git add external-rest-api/package.json
    git -c user.email=t@t -c user.name=t commit -qm "corrupt external-rest-api/package.json"
  )

  # An entirely unrelated, legitimate trigger for the drift check to run at all.
  ( cd "$d" && echo "export const y = 2" > rpc-proxy/src/other.ts && git add rpc-proxy/src/other.ts )

  local status stderr_output
  stderr_output="$( cd "$d" && node scripts/precommit/bump-staged-package-versions.mjs 2>&1 >/dev/null )"
  status=$?

  if [ "$status" -ne 0 ] && ! echo "$stderr_output" | grep -q "SyntaxError" \
    && echo "$stderr_output" | grep -q "external-rest-api/package.json"; then
    pass "a corrupted counter package.json is refused with a named message, not a raw parse-crash stack trace"
  else
    fail "expected nonzero exit naming external-rest-api/package.json with no raw SyntaxError; got status=$status stderr='$stderr_output'"
  fi
  rm -rf "$d"
}

assert_release_manifest_does_not_bump
assert_other_source_still_bumps
assert_a_counter_bump_resyncs_the_manifest
assert_rpc_proxy_bump_resyncs_the_manifest
assert_desktop_version_not_touched_by_counter_resync
assert_resync_preserves_the_release_id
assert_unstaged_manifest_changes_block_the_resync
assert_a_failed_resync_recovers_on_retry
assert_missing_release_id_is_refused_not_fabricated
assert_unstaged_package_json_drift_is_not_leaked_into_the_manifest
assert_unrelated_unstaged_package_json_blocks_a_real_resync
assert_a_self_concealing_manifest_edit_cannot_suppress_the_resync
assert_a_corrupted_committed_package_json_is_refused_not_crashed

exit $FAIL
