#!/usr/bin/env bash
set -u
FAIL=0

# Tests for the release-cut scripts:
#   scripts/release/update-desktop-release-manifest.mjs  (floor decoupling)
#   scripts/release/prepare-release.mjs                  (the one writer, added by a later task)
#   scripts/release/validate-release-tag.mjs             (the checker)
#
# Each case builds a throwaway git repo containing only the files the script
# under test reads, so nothing here depends on the real tree's versions.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# Build a scratch repo with the given desktop/ers/rpc versions and manifest.
# Usage: make_fixture <dir> <desktopVersion> <ersVersion> <rpcVersion> \
#                     <manifestDesktop> <manifestMinimum> <manifestErs> <manifestRpc>
make_fixture() {
  local d=$1 dv=$2 ev=$3 rv=$4 mdv=$5 mmin=$6 mev=$7 mrv=$8
  mkdir -p "$d/desktop-app" "$d/external-rest-api/src" "$d/rpc-proxy"
  printf '{\n  "name": "desktop-app",\n  "version": "%s"\n}\n' "$dv" > "$d/desktop-app/package.json"
  printf '{\n  "name": "desktop-app",\n  "version": "%s",\n  "packages": {\n    "": {\n      "version": "%s"\n    }\n  }\n}\n' "$dv" "$dv" > "$d/desktop-app/package-lock.json"
  printf '{\n  "name": "external-rest-api",\n  "version": "%s"\n}\n' "$ev" > "$d/external-rest-api/package.json"
  printf '{\n  "name": "rpc-proxy",\n  "version": "%s"\n}\n' "$rv" > "$d/rpc-proxy/package.json"
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<EOF
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'fixture-0000000',
  externalRestApiVersion: '$mev',
  rpcProxyVersion: '$mrv',
  desktopVersion: '$mdv',
  minimumDesktopVersion: '$mmin',
}
EOF
  ( cd "$d" && git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init )
}

manifest_field() {
  # manifest_field <dir> <field>
  # The quote in the pattern is load-bearing: renderManifest emits a TypeScript
  # type block above the object, so "^  desktopVersion:" alone also matches
  # "  desktopVersion: string" and sed passes that line straight through.
  grep -E "^  $2: '" "$1/external-rest-api/src/releaseManifest.ts" | sed "s/.*'\(.*\)'.*/\1/"
}

assert_floor_is_not_dragged_by_a_desktop_bump() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.1.252 0.1.252 0.1.60 0.1.51

  if ( cd "$d" && node "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" \
        --release-id test-0000000 >/dev/null 2>&1 ); then
    local dv min
    dv="$(manifest_field "$d" desktopVersion)"
    min="$(manifest_field "$d" minimumDesktopVersion)"
    if [ "$dv" = "0.5.0" ] && [ "$min" = "0.1.252" ]; then
      pass "desktop bump advances desktopVersion and leaves the floor alone"
    else
      fail "expected desktopVersion=0.5.0 minimumDesktopVersion=0.1.252, got $dv / $min"
    fi
  else
    fail "update-desktop-release-manifest.mjs rejected a floor below desktopVersion"
  fi
  rm -rf "$d"
}

assert_floor_above_desktop_is_rejected() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.9.9 0.1.60 0.1.51

  if ( cd "$d" && node "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" \
        --validate-only >/dev/null 2>&1 ); then
    fail "minimumDesktopVersion greater than desktopVersion was accepted"
  else
    pass "minimumDesktopVersion greater than desktopVersion is rejected"
  fi
  rm -rf "$d"
}

assert_explicit_minimum_flag_is_honoured() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51

  # 0.5.5 deliberately differs from BOTH the old floor (0.1.252) and the new
  # desktop version (0.6.0). Asking for 0.6.0 here would pass against the
  # unpatched script too, since its forced write lands on exactly that value.
  if ( cd "$d" && node "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" \
        --release-id test-0000000 --minimum-desktop-version 0.5.5 >/dev/null 2>&1 ); then
    local min; min="$(manifest_field "$d" minimumDesktopVersion)"
    if [ "$min" = "0.5.5" ]; then
      pass "--minimum-desktop-version raises the floor when asked"
    else
      fail "expected floor 0.5.5 after explicit raise, got $min"
    fi
  else
    fail "--minimum-desktop-version was not accepted"
  fi
  rm -rf "$d"
}

assert_unreadable_manifest_does_not_synthesize_a_floor() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/desktop-app" "$d/external-rest-api/src" "$d/rpc-proxy"
  printf '{\n  "name": "desktop-app",\n  "version": "0.5.0"\n}\n' > "$d/desktop-app/package.json"
  printf '{\n  "name": "external-rest-api",\n  "version": "0.1.60"\n}\n' > "$d/external-rest-api/package.json"
  printf '{\n  "name": "rpc-proxy",\n  "version": "0.1.51"\n}\n' > "$d/rpc-proxy/package.json"
  # The export is renamed so parseManifest's regex cannot find `releaseManifest`
  # and returns null -- simulates an unreadable/corrupted manifest with no
  # --minimum-desktop-version flag to fall back on.
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifestRENAMED: ReleaseManifest = {
  releaseId: 'fixture-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
  ( cd "$d" && git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init )

  if ( cd "$d" && node "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" \
        --release-id t-3 >/dev/null 2>&1 ); then
    fail "unreadable manifest with no explicit floor was silently accepted"
  elif grep -q "minimumDesktopVersion: '0.5.0'" "$d/external-rest-api/src/releaseManifest.ts"; then
    fail "unreadable manifest run was rejected but still wrote desktopVersion as the floor"
  else
    pass "unreadable manifest with no explicit floor is rejected, not silently defaulted to desktopVersion"
  fi
  rm -rf "$d"
}

assert_previous_ref_does_not_revert_a_raised_floor() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/desktop-app" "$d/external-rest-api/src" "$d/rpc-proxy"

  # Earlier state, tagged v1: desktop 0.1.252, floor 0.1.252.
  printf '{\n  "name": "desktop-app",\n  "version": "0.1.252"\n}\n' > "$d/desktop-app/package.json"
  printf '{\n  "name": "external-rest-api",\n  "version": "0.1.60"\n}\n' > "$d/external-rest-api/package.json"
  printf '{\n  "name": "rpc-proxy",\n  "version": "0.1.51"\n}\n' > "$d/rpc-proxy/package.json"
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'v1-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.1.252',
  minimumDesktopVersion: '0.1.252',
}
EOF
  ( cd "$d" && git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm v1 && git tag v1 )

  # HEAD: an operator already raised the floor to 0.4.0 and bumped desktop to 0.5.0.
  printf '{\n  "name": "desktop-app",\n  "version": "0.5.0"\n}\n' > "$d/desktop-app/package.json"
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'head-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.5.0',
  minimumDesktopVersion: '0.4.0',
}
EOF
  ( cd "$d" && git add -A && git -c user.email=t@t -c user.name=t commit -qm head )

  if ( cd "$d" && node "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" \
        --release-id t-2 --previous v1 >/dev/null 2>&1 ); then
    local min; min="$(manifest_field "$d" minimumDesktopVersion)"
    if [ "$min" = "0.4.0" ]; then
      pass "--previous does not revert a floor already raised on HEAD"
    else
      fail "expected floor to stay at HEAD's 0.4.0, got $min (reverted to the --previous ref's floor)"
    fi
  else
    fail "--previous v1 with a floor already raised on HEAD was unexpectedly rejected"
  fi
  rm -rf "$d"
}

assert_ordering_check_fails_against_unpatched_script() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51

  # Case 2 above (floor > desktopVersion) also gets rejected by the unpatched
  # `!==` check, so it does not prove ordering semantics. This case uses a
  # floor STRICTLY BELOW desktopVersion, which the unpatched equality check
  # rejects (0.1.252 !== 0.5.0) but the patched ordering check accepts
  # (0.1.252 <= 0.5.0) -- the only kind of case that discriminates the two.
  local unpatched="$d/unpatched-update-desktop-release-manifest.mjs"
  if ! git -C "$REPO_ROOT" show 75e44f8e:scripts/release/update-desktop-release-manifest.mjs \
        > "$unpatched" 2>/dev/null; then
    fail "could not materialise the unpatched script from 75e44f8e"
    rm -rf "$d"
    return
  fi

  local unpatched_exit patched_exit
  ( cd "$d" && node "$unpatched" --validate-only >/dev/null 2>&1 )
  unpatched_exit=$?
  ( cd "$d" && node "$REPO_ROOT/scripts/release/update-desktop-release-manifest.mjs" \
        --validate-only >/dev/null 2>&1 )
  patched_exit=$?

  if [ "$unpatched_exit" -ne 0 ] && [ "$patched_exit" -eq 0 ]; then
    pass "ordering check (0.1.252 <= 0.5.0) is rejected by the unpatched equality check and accepted by the patched ordering check"
  else
    fail "expected unpatched exit!=0 and patched exit=0, got unpatched=$unpatched_exit patched=$patched_exit"
  fi
  rm -rf "$d"
}

assert_prepare_release_writes_every_coordinate() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  if ( cd "$d" && node scripts/release/prepare-release.mjs \
        --version 0.6.0 --release-id test-1111111 >/dev/null 2>&1 ); then
    local pv lv dv min
    pv="$(grep '"version"' "$d/desktop-app/package.json" | sed 's/.*: "\(.*\)".*/\1/')"
    lv="$(node -e 'const j=require(process.argv[1]);console.log(j.version,j.packages[""].version)' "$d/desktop-app/package-lock.json")"
    dv="$(manifest_field "$d" desktopVersion)"
    min="$(manifest_field "$d" minimumDesktopVersion)"
    if [ "$pv" = "0.6.0" ] && [ "$lv" = "0.6.0 0.6.0" ] && [ "$dv" = "0.6.0" ] && [ "$min" = "0.1.252" ]; then
      pass "prepare-release writes package.json, both lockfile sites, and the manifest"
    else
      fail "coordinates after prepare-release: pkg=$pv lock='$lv' manifest=$dv floor=$min"
    fi
  else
    fail "prepare-release.mjs exited non-zero"
  fi
  rm -rf "$d"
}

assert_prepare_release_leaves_a_same_string_dependency_alone() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  node -e '
    const fs = require("fs"), p = process.argv[1]
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    j.dependencies = { "some-dep": "0.5.0" }
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n")
  ' "$d/desktop-app/package.json"

  ( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6.0 --release-id t >/dev/null 2>&1 )
  local dep; dep="$(node -e 'console.log(require(process.argv[1]).dependencies["some-dep"])' "$d/desktop-app/package.json")"
  if [ "$dep" = "0.5.0" ]; then
    pass "a dependency pinned to the old version string is untouched"
  else
    fail "dependency pin was rewritten to $dep"
  fi
  rm -rf "$d"
}

assert_prepare_release_rejects_a_non_greater_version() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/prepare-release.mjs --version 0.5.0 --release-id t >/dev/null 2>&1 ); then
    fail "prepare-release accepted a version not greater than current"
  else
    pass "prepare-release rejects a version not greater than current"
  fi
  rm -rf "$d"
}

assert_prepare_release_rejects_a_bad_version_shape() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6 --release-id t >/dev/null 2>&1 ); then
    fail "prepare-release accepted a non MAJOR.MINOR.PATCH version"
  else
    pass "prepare-release rejects a non MAJOR.MINOR.PATCH version"
  fi
  rm -rf "$d"
}

assert_release_id_is_never_local() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "prepare-release ran without --release-id"
  else
    pass "prepare-release requires an explicit --release-id"
  fi
  rm -rf "$d"
}

assert_validate_release_tag_catches_each_coordinate() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  if ! ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag rejected a coherent tree"
    rm -rf "$d"; return
  fi

  # This breaks a single `equals` coordinate (desktop-app/package.json) and
  # confirms the checker catches it. The other assertion kinds -- floor,
  # explicit, counter -- get their own dedicated negative cases below
  # (assert_floor_above_release_version_is_rejected_by_the_checker,
  # assert_floor_non_semver_is_rejected_by_the_checker,
  # assert_explicit_release_id_is_rejected_when_local_or_empty,
  # assert_counter_mismatch_is_rejected_by_the_checker), not by looping here.
  local broke_all=1
  node -e '
    const fs=require("fs"),p=process.argv[1]
    const j=JSON.parse(fs.readFileSync(p,"utf8")); j.version="0.6.1"
    fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")
  ' "$d/desktop-app/package.json"
  ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ) && broke_all=0

  if [ "$broke_all" = "1" ]; then
    pass "validate-release-tag catches a disagreeing coordinate"
  else
    fail "validate-release-tag passed with desktop-app/package.json at 0.6.1"
  fi
  rm -rf "$d"
}

assert_validate_release_tag_rejects_a_renamed_manifest_export() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/desktop-app" "$d/external-rest-api/src" "$d/rpc-proxy"
  printf '{\n  "name": "desktop-app",\n  "version": "0.6.0"\n}\n' > "$d/desktop-app/package.json"
  printf '{\n  "name": "desktop-app",\n  "version": "0.6.0",\n  "packages": {\n    "": {\n      "version": "0.6.0"\n    }\n  }\n}\n' > "$d/desktop-app/package-lock.json"
  printf '{\n  "name": "external-rest-api",\n  "version": "0.1.60"\n}\n' > "$d/external-rest-api/package.json"
  printf '{\n  "name": "rpc-proxy",\n  "version": "0.1.51"\n}\n' > "$d/rpc-proxy/package.json"
  # The export is renamed but the field values are otherwise coherent with
  # the release. A field-by-field regex over the whole file would still find
  # these lines and pass; manifestField must instead fail to find the
  # `releaseManifest` export at all, so every manifest coordinate reads as
  # empty and the checker rejects the tree.
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifestRENAMED: ReleaseManifest = {
  releaseId: 'fixture-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.6.0',
  minimumDesktopVersion: '0.1.252',
}
EOF
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag passed against a renamed releaseManifest export"
  else
    pass "validate-release-tag rejects a manifest whose export is renamed"
  fi
  rm -rf "$d"
}

assert_validate_release_tag_ignores_a_decoy_object() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/desktop-app" "$d/external-rest-api/src" "$d/rpc-proxy"
  printf '{\n  "name": "desktop-app",\n  "version": "0.6.0"\n}\n' > "$d/desktop-app/package.json"
  printf '{\n  "name": "desktop-app",\n  "version": "0.6.0",\n  "packages": {\n    "": {\n      "version": "0.6.0"\n    }\n  }\n}\n' > "$d/desktop-app/package-lock.json"
  printf '{\n  "name": "external-rest-api",\n  "version": "0.1.60"\n}\n' > "$d/external-rest-api/package.json"
  printf '{\n  "name": "rpc-proxy",\n  "version": "0.1.51"\n}\n' > "$d/rpc-proxy/package.json"
  # A decoy object with the SAME field names sits above the real export and
  # carries values that would pass. The real `releaseManifest` export below
  # it carries values that must fail. A field-by-field regex over the whole
  # file matches the decoy's lines first (they appear first) and passes; the
  # checker must read the actual `releaseManifest` export instead.
  cat > "$d/external-rest-api/src/releaseManifest.ts" <<'EOF'
export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

const decoy = {
  releaseId: 'decoy-0000000',
  externalRestApiVersion: '0.1.60',
  rpcProxyVersion: '0.1.51',
  desktopVersion: '0.6.0',
  minimumDesktopVersion: '0.1.252',
}

export const releaseManifest: ReleaseManifest = {
  releaseId: 'wrong-0000000',
  externalRestApiVersion: '9.9.9',
  rpcProxyVersion: '9.9.9',
  desktopVersion: '9.9.9',
  minimumDesktopVersion: '9.9.9',
}
EOF
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag passed by reading a decoy object instead of the real export"
  else
    pass "validate-release-tag reads the real releaseManifest export, not a decoy placed above it"
  fi
  rm -rf "$d"
}

assert_floor_is_checked_as_a_ceiling_not_an_equality() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    pass "a floor below the release version is accepted, not required to equal it"
  else
    fail "validate-release-tag required minimumDesktopVersion to equal the version"
  fi
  rm -rf "$d"
}

assert_floor_above_release_version_is_rejected_by_the_checker() {
  local d; d="$(mktemp -d)"
  # Floor 0.9.9 is ABOVE the release version 0.6.0 -- the dangerous
  # direction. This whole workstream exists because a wrong floor
  # force-updates every existing desktop install; the checker must catch
  # this before the tag, not just accept a floor that happens to be low.
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.9.9 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag accepted a floor (0.9.9) above the release version (0.6.0)"
  else
    pass "validate-release-tag rejects a floor above the release version"
  fi
  rm -rf "$d"
}

assert_floor_non_semver_is_rejected_by_the_checker() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag accepted a non MAJOR.MINOR.PATCH floor (0.1)"
  else
    pass "validate-release-tag rejects a non MAJOR.MINOR.PATCH floor"
  fi
  rm -rf "$d"
}

assert_explicit_release_id_is_rejected_when_local_or_empty() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  local manifest="$d/external-rest-api/src/releaseManifest.ts"

  sed -i.bak "s/releaseId: 'fixture-0000000'/releaseId: 'local'/" "$manifest"
  local local_rejected=0
  ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ) || local_rejected=1

  sed -i.bak "s/releaseId: 'local'/releaseId: ''/" "$manifest"
  local empty_rejected=0
  ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ) || empty_rejected=1

  if [ "$local_rejected" = "1" ] && [ "$empty_rejected" = "1" ]; then
    pass "validate-release-tag rejects releaseId of 'local' and of an empty string"
  else
    fail "expected both 'local' and empty releaseId rejected (local_rejected=$local_rejected empty_rejected=$empty_rejected)"
  fi
  rm -rf "$d"
}

assert_counter_mismatch_is_rejected_by_the_checker() {
  local d; d="$(mktemp -d)"
  # manifest externalRestApiVersion (0.1.61) disagrees with
  # external-rest-api/package.json (0.1.60) -- checked against the counter's
  # OWN package, not the release version.
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.61 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag accepted externalRestApiVersion disagreeing with external-rest-api/package.json"
  else
    pass "validate-release-tag rejects a counter that disagrees with its own package.json"
  fi
  rm -rf "$d"
}

assert_unhandled_assert_kind_fails_closed() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  # Append an 8th coordinate whose assert kind ('pointer') the checker does
  # not implement, carrying a deliberately garbage value that would never
  # agree with anything. If an unrecognized assert kind falls through every
  # branch instead of failing closed, this coordinate is never actually
  # checked and the tree still reports success -- the exact bug this case
  # guards against.
  node -e '
    const fs = require("fs")
    const p = process.argv[1]
    let s = fs.readFileSync(p, "utf8")
    const marker = "export function readCounterPackage"
    if (!s.includes(marker)) throw new Error("marker not found")
    s = s.replace(
      marker,
      "COORDINATES.push({\n" +
        "  name: \"test-only-pointer-coordinate\",\n" +
        "  assert: \"pointer\",\n" +
        "  read: () => \"garbage-value-that-is-never-checked\",\n" +
        "})\n\n" +
        marker
    )
    fs.writeFileSync(p, s)
  ' "$d/scripts/release/release-coordinates.mjs"

  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag passed with an unhandled assert kind ('pointer') on a coordinate"
  else
    pass "validate-release-tag fails closed on an unhandled assert kind instead of skipping it silently"
  fi
  rm -rf "$d"
}

assert_every_coordinate_has_a_case() {
  local declared cases
  declared="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/release-coordinates.mjs")
      .then(m => console.log(m.COORDINATES.length))
  ')"
  # Count DEFINITIONS only. A bare "^assert_" also counts every invocation in
  # the call block at the bottom, which roughly doubles the number and makes
  # this check pass no matter what.
  cases="$(grep -cE '^assert_[a-z_]+\(\) \{' "$REPO_ROOT/scripts/tests/test-release-coordinates.sh")"
  if [ "$cases" -ge "$declared" ]; then
    pass "each declared coordinate has at least one case ($declared coordinates, $cases assertions)"
  else
    fail "$declared coordinates declared but only $cases assertions"
  fi
}

# Guards against the opposite failure mode from assert_every_coordinate_has_a_case:
# a case can be DEFINED (so it counts toward that check) and still never be
# CALLED from the block below, which makes it permanently dead -- the suite
# prints all-PASS while the dead case never runs. A stated PASS-count in a
# plan document is a description, not a source of truth; this check compares
# against what the file itself defines and calls, so it can't go stale that
# way.
assert_every_defined_case_is_invoked() {
  local defined invoked missing
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$REPO_ROOT/scripts/tests/test-release-coordinates.sh" \
    | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$REPO_ROOT/scripts/tests/test-release-coordinates.sh" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_floor_is_not_dragged_by_a_desktop_bump
assert_floor_above_desktop_is_rejected
assert_explicit_minimum_flag_is_honoured
assert_unreadable_manifest_does_not_synthesize_a_floor
assert_previous_ref_does_not_revert_a_raised_floor
assert_ordering_check_fails_against_unpatched_script
assert_prepare_release_writes_every_coordinate
assert_prepare_release_leaves_a_same_string_dependency_alone
assert_prepare_release_rejects_a_non_greater_version
assert_prepare_release_rejects_a_bad_version_shape
assert_release_id_is_never_local
assert_validate_release_tag_catches_each_coordinate
assert_validate_release_tag_rejects_a_renamed_manifest_export
assert_validate_release_tag_ignores_a_decoy_object
assert_floor_is_checked_as_a_ceiling_not_an_equality
assert_floor_above_release_version_is_rejected_by_the_checker
assert_floor_non_semver_is_rejected_by_the_checker
assert_explicit_release_id_is_rejected_when_local_or_empty
assert_counter_mismatch_is_rejected_by_the_checker
assert_unhandled_assert_kind_fails_closed
assert_every_coordinate_has_a_case
assert_every_defined_case_is_invoked

exit $FAIL
