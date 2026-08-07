#!/usr/bin/env bash
set -u
FAIL=0

# Tests for the release-cut scripts:
#   scripts/release/update-desktop-release-manifest.mjs  (floor decoupling)
#   scripts/release/prepare-release.mjs                  (the one writer)
#   scripts/release/validate-release-tag.mjs             (the checker)
#
# Each case builds a throwaway git repo containing only the files the script
# under test reads, so nothing here depends on the real tree's versions.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# Write the ghcr pointer component the eighth coordinate reads.
# Usage: make_ghcr_component <dir> <tag> [secondRowTag]
# Two rows, because the component in the real tree has one per published image
# and the coordinate must handle ALL of them. The optional second tag builds a
# deliberately half-rewritten component; it defaults to the first, which is the
# only coherent state.
make_ghcr_component() {
  local d=$1 tag=$2 tag2=${3:-$2}
  mkdir -p "$d/deploy/components/ghcr-images"
  cat > "$d/deploy/components/ghcr-images/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

configurations:
  - imagetags.yaml

images:
  - name: clerum/control-api
    newName: ghcr.io/evenfire-ai/control-api
    newTag: $tag
  - name: clerum/control-ui
    newName: ghcr.io/evenfire-ai/control-ui
    newTag: $tag2
EOF
}

# The DISTINCT set of newTag values in the component, space separated. A
# coherent component collapses to one value; a half-applied rewrite shows both,
# which is the state that must never read as "the first one wins".
component_tags() {
  sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' \
    "$1/deploy/components/ghcr-images/kustomization.yaml" | sort -u | tr '\n' ' '
}

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
  # The ghcr pin is a coordinate like any other, so every fixture carries one.
  # Without it the checker's read would blow up on a missing file and every
  # negative case below would "pass" on the crash instead of on the thing it
  # claims to test. Pinned to v<desktopVersion> so a fixture that is coherent
  # for the desktop coordinates is coherent for this one too.
  make_ghcr_component "$d" "v$dv"
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
  # Coherent ghcr pin: the ONLY disagreement in this tree must be the manifest.
  make_ghcr_component "$d" v0.6.0
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
  # Coherent ghcr pin: the ONLY disagreement in this tree must be the manifest.
  make_ghcr_component "$d" v0.6.0
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

  # Append an extra coordinate whose assert kind the checker does not
  # implement, carrying a deliberately garbage value that would never agree
  # with anything. If an unrecognized assert kind falls through every branch
  # instead of failing closed, this coordinate is never actually checked and
  # the tree still reports success -- the exact bug this case guards against.
  #
  # The injected kind must be one the checker genuinely has no case for. This
  # used to inject 'pointer', which worked only while 'pointer' was unimplemented;
  # once the ghcr pin landed as a real pointer coordinate, that injection was
  # caught by the pointer case (garbage != v0.6.0) and this case would have kept
  # passing with the `default:` branch deleted.
  node -e '
    const fs = require("fs")
    const p = process.argv[1]
    let s = fs.readFileSync(p, "utf8")
    const marker = "export function readCounterPackage"
    if (!s.includes(marker)) throw new Error("marker not found")
    s = s.replace(
      marker,
      "COORDINATES.push({\n" +
        "  name: \"test-only-unimplemented-kind-coordinate\",\n" +
        "  assert: \"no-such-assert-kind\",\n" +
        "  read: () => \"garbage-value-that-is-never-checked\",\n" +
        "})\n\n" +
        marker
    )
    fs.writeFileSync(p, s)
  ' "$d/scripts/release/release-coordinates.mjs"

  if ( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 >/dev/null 2>&1 ); then
    fail "validate-release-tag passed with an unhandled assert kind ('no-such-assert-kind') on a coordinate"
  else
    pass "validate-release-tag fails closed on an unhandled assert kind instead of skipping it silently"
  fi
  rm -rf "$d"
}

# The pin must be a full coordinate, not a hand-bumped file. A release cut that
# moves the desktop version and leaves the pin behind ships a v0.6.0 whose
# desktop app reports 0.6.0 while minikube-setup pulls v0.5.0 images -- the
# exact skew the one-writer rule exists to prevent.
assert_prepare_release_writes_the_ghcr_pin() {
  local d out rc; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  make_ghcr_component "$d" v0.5.0
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  out="$( cd "$d" && node scripts/release/prepare-release.mjs \
      --version 0.6.0 --release-id t 2>&1 )"; rc=$?
  local got; got="$(component_tags "$d")"
  if [ "$rc" -eq 0 ] && [ "$got" = "v0.6.0 " ]; then
    pass "prepare-release.mjs writes the ghcr component pin"
  else
    fail "component tags after the cut were '${got}', expected 'v0.6.0 ' (rc=$rc out='$out')"
  fi
  rm -rf "$d"
}

# The pin is v-prefixed; the release version is not. Writing 0.6.0 into the
# component would produce a tag that never exists.
assert_the_pin_is_written_v_prefixed() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  make_ghcr_component "$d" v0.5.0
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  ( cd "$d" && node scripts/release/prepare-release.mjs \
      --version 0.6.0 --release-id t >/dev/null 2>&1 )
  local component="$d/deploy/components/ghcr-images/kustomization.yaml"
  if grep -q 'newTag: v0.6.0' "$component" && ! grep -qE 'newTag: 0\.6\.0' "$component"; then
    pass "the pin is written as v0.6.0, not 0.6.0"
  else
    fail "the written pin is not v-prefixed: $(component_tags "$d")"
  fi
  rm -rf "$d"
}

# EVERY row, not just the first. A rewrite that missed rows would produce a
# component with mixed tags, and the puller would fetch two different releases.
assert_every_component_row_is_rewritten() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  make_ghcr_component "$d" v0.5.0
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  ( cd "$d" && node scripts/release/prepare-release.mjs \
      --version 0.6.0 --release-id t >/dev/null 2>&1 )
  local count
  count="$(grep -c 'newTag: v0.6.0' "$d/deploy/components/ghcr-images/kustomization.yaml")"
  if [ "$count" = "2" ]; then
    pass "every component row was rewritten, not just the first"
  else
    fail "only $count of 2 rows carry the new pin"
  fi
  rm -rf "$d"
}

assert_validate_release_tag_catches_a_stale_pin() {
  local d out rc; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  make_ghcr_component "$d" v0.5.0
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  out="$( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 2>&1 )"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q "ghcr" <<< "$out" && grep -q "v0.5.0" <<< "$out"; then
    pass "the checker catches a stale ghcr pin, naming it"
  else
    fail "expected a failure naming the ghcr pin and v0.5.0; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# The checker must NOT reach the registry. The v<version> images are created by
# release-images.yml ON THE TAG, so they cannot exist when the release-prep PR
# is checked. Asserting existence here would make every release-prep PR red.
assert_the_pointer_check_does_not_require_the_artifact_to_exist() {
  local d out rc; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  make_ghcr_component "$d" v0.6.0
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  # No network, no registry, no tag: a pure tree read must still pass.
  out="$( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 2>&1 )"; rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "the pointer check is a pure tree read; artifact existence is release-images.yml's half"
  else
    fail "the checker rejected an agreeing tree (rc=$rc): $out"
  fi
  rm -rf "$d"
}

# A component with mixed newTag values is not "the first one wins" -- it is a
# half-applied write, and reading only the first would hide it.
assert_a_mixed_tag_component_is_rejected() {
  local d out rc; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  # First row already bumped, second row left behind: the first-row read that
  # this case exists to forbid would see v0.6.0 and pass.
  make_ghcr_component "$d" v0.6.0 v0.5.0
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  out="$( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 2>&1 )"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q "MIXED" <<< "$out"; then
    pass "a component with mixed newTag values is rejected"
  else
    fail "a half-rewritten component passed the checker (rc=$rc): $out"
  fi
  rm -rf "$d"
}

# Gut the component's images list: a file that still parses as a Component but
# carries no pin at all.
gut_ghcr_component() {
  cat > "$1/deploy/components/ghcr-images/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component

configurations:
  - imagetags.yaml

images: []
EOF
}

# A writer that wrote nothing is a failed cut, not a no-op. Silently rewriting
# zero rows would hand the operator a "prepared release 0.6.0" over a tree with
# no pin in it at all.
assert_prepare_release_fails_loudly_when_no_row_can_be_written() {
  local d out rc; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  gut_ghcr_component "$d"
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  out="$( cd "$d" && node scripts/release/prepare-release.mjs \
      --version 0.6.0 --release-id t 2>&1 )"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q "ghcr-images/kustomization.yaml" <<< "$out"; then
    pass "prepare-release fails loudly, naming the file, when no pin row can be written"
  else
    fail "a cut over a component with no pin rows reported rc=$rc: $out"
  fi
  rm -rf "$d"
}

# A guard that scanned zero rows is a broken guard, not a passing one. A
# component whose images list was gutted must fail, not read as agreement.
assert_a_component_with_no_rows_is_rejected() {
  local d out rc; d="$(mktemp -d)"
  make_fixture "$d" 0.6.0 0.1.60 0.1.51 0.6.0 0.1.252 0.1.60 0.1.51
  gut_ghcr_component "$d"
  cp -R "$REPO_ROOT/scripts" "$d/scripts"
  out="$( cd "$d" && node scripts/release/validate-release-tag.mjs --version 0.6.0 2>&1 )"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q "empty" <<< "$out"; then
    pass "a component carrying no newTag rows is rejected, not read as agreement"
  else
    fail "a component with zero newTag rows was accepted (rc=$rc): $out"
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

assert_floor_above_version_is_rejected_before_any_write() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  ( cd "$d" && node scripts/release/prepare-release.mjs \
      --version 0.6.0 --release-id t --minimum-desktop-version 0.7.0 >/dev/null 2>&1 )
  local pkg; pkg="$(node -e 'console.log(require(process.argv[1]).version)' "$d/desktop-app/package.json")"

  # The delegated updater rejects floor > desktopVersion. Discovering that AFTER
  # the coordinate loop has written package.json leaves the tree half-cut, so
  # the range check has to happen up front.
  if [ "$pkg" = "0.5.0" ]; then
    pass "a floor above the release version is rejected before any coordinate is written"
  else
    fail "desktop-app/package.json was written to $pkg despite an impossible floor"
  fi
  rm -rf "$d"
}

assert_a_half_cut_release_can_be_completed_by_rerunning() {
  local d; d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  # Force the manifest write to fail AFTER package.json has been written.
  chmod -w "$d/external-rest-api/src/releaseManifest.ts"
  ( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6.0 --release-id t >/dev/null 2>&1 )
  chmod +w "$d/external-rest-api/src/releaseManifest.ts"

  # Re-running the SAME command must work. The monotonic guard compares against
  # the last COMMITTED version, not the value the failed run left on disk --
  # otherwise the remediation both this script and validate-release-tag.mjs
  # print is a dead end ("not greater than the current desktop version").
  ( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6.0 --release-id t >/dev/null 2>&1 )
  local dv min; dv="$(manifest_field "$d" desktopVersion)"; min="$(manifest_field "$d" minimumDesktopVersion)"
  if [ "$dv" = "0.6.0" ] && [ "$min" = "0.1.252" ]; then
    pass "re-running a half-cut release completes it and leaves the floor alone"
  else
    fail "after re-run desktopVersion=$dv minimumDesktopVersion=$min; expected 0.6.0 / 0.1.252"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# The half-cut recovery instruction
# ---------------------------------------------------------------------------
#
# The message printed when the manifest update fails told the operator to
# `git checkout -- desktop-app/package.json desktop-app/package-lock.json`.
# The ghcr pin became the eighth coordinate and the writer started touching it,
# but the instruction kept naming two files out of three: following it verbatim
# reverted the version and left the pin bumped -- a tree still half-cut,
# produced by the command offered to un-cut it.

# Mutation coverage: hardcode the old two-file list back (the ghcr path
# disappears from both the prose and the checkout command), or invert the
# filter to `c => !c.write` (the checkout command names releaseManifest fields
# that are not files at all). Both are caught -- the assertion pins the EXACT
# path set the writer touches, in the checkout command specifically, not merely
# "the string appears somewhere".
assert_a_half_cut_release_names_every_file_the_writer_touched() {
  local d out checkout_cmd problems=""
  d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  # Force the manifest write to fail AFTER the coordinate loop has written
  # package.json, the lockfile and the ghcr component.
  chmod -w "$d/external-rest-api/src/releaseManifest.ts"
  out="$( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6.0 --release-id t 2>&1 )"
  chmod +w "$d/external-rest-api/src/releaseManifest.ts"

  # The tree really is half-cut, or this case proves nothing about recovery.
  local pin; pin="$(component_tags "$d")"
  [ "$pin" = "v0.6.0 " ] || problems+="the ghcr pin was not written before the failure (tags: '${pin}'); "

  checkout_cmd="$(grep -o 'git checkout -- [^`]*' <<< "$out")"
  [ -n "$checkout_cmd" ] || problems+="no 'git checkout --' recovery command in the output; "
  for f in desktop-app/package.json desktop-app/package-lock.json \
           deploy/components/ghcr-images/kustomization.yaml; do
    grep -q -- "$f" <<< "$checkout_cmd" || problems+="the discard command omits ${f}; "
  done
  # Every path it names must be a file the writer actually touched: a list that
  # names releaseManifest fields would "contain" nothing useful to checkout.
  for named in $checkout_cmd; do
    case "$named" in
      git | checkout | --) continue ;;
    esac
    [ -f "$d/$named" ] || problems+="the discard command names '${named}', which is not a file in the tree; "
  done

  if [ -z "$problems" ]; then
    pass "a half-cut release's discard command names every file the writer touched, including the ghcr pin"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

# The list is derived from the coordinate table, so a future coordinate that
# owns a write but forgets to declare its path must fail the cut LOUDLY rather
# than reintroduce a silently short recovery list.
#
# Mutation coverage: turn the throw in writtenCoordinatePaths() into a
# `return ''`/skip and this case sees a successful cut instead of a refusal;
# move the resolution after the coordinate loop and the tree is half-written
# when it dies, which the package.json assertion below catches.
assert_a_write_coordinate_without_a_path_stops_the_cut_before_any_write() {
  local d out rc pkg problems=""
  d="$(mktemp -d)"
  make_fixture "$d" 0.5.0 0.1.60 0.1.51 0.5.0 0.1.252 0.1.60 0.1.51
  cp -R "$REPO_ROOT/scripts" "$d/scripts"

  # A ninth coordinate that writes a file and never says which one.
  cat >> "$d/scripts/release/release-coordinates.mjs" <<'EOF'

COORDINATES.push({
  name: 'test-only/undeclared-path',
  assert: 'equals',
  read: () => '',
  write: () => {},
})
EOF

  out="$( cd "$d" && node scripts/release/prepare-release.mjs --version 0.6.0 --release-id t 2>&1 )"; rc=$?
  pkg="$(node -e 'console.log(require(process.argv[1]).version)' "$d/desktop-app/package.json")"
  [ "$rc" -ne 0 ] || problems+="the cut succeeded despite a write coordinate with no path; "
  grep -q 'test-only/undeclared-path' <<< "$out" || problems+="the refusal does not name the offending coordinate: ${out}; "
  [ "$pkg" = "0.5.0" ] || problems+="desktop-app/package.json was written to ${pkg} before the refusal; "

  if [ -z "$problems" ]; then
    pass "a write coordinate with no declared path stops the cut, by name, before anything is written"
  else
    fail "$problems"
  fi
  rm -rf "$d"
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
assert_floor_above_version_is_rejected_before_any_write
assert_a_half_cut_release_can_be_completed_by_rerunning
assert_prepare_release_writes_the_ghcr_pin
assert_the_pin_is_written_v_prefixed
assert_every_component_row_is_rewritten
assert_validate_release_tag_catches_a_stale_pin
assert_the_pointer_check_does_not_require_the_artifact_to_exist
assert_a_mixed_tag_component_is_rejected
assert_prepare_release_fails_loudly_when_no_row_can_be_written
assert_a_component_with_no_rows_is_rejected
assert_a_half_cut_release_names_every_file_the_writer_touched
assert_a_write_coordinate_without_a_path_stops_the_cut_before_any_write
assert_every_coordinate_has_a_case
assert_every_defined_case_is_invoked

exit $FAIL
