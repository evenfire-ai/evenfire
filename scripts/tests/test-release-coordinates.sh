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

assert_floor_is_not_dragged_by_a_desktop_bump
assert_floor_above_desktop_is_rejected
assert_explicit_minimum_flag_is_honoured
assert_unreadable_manifest_does_not_synthesize_a_floor
assert_previous_ref_does_not_revert_a_raised_floor
assert_ordering_check_fails_against_unpatched_script

exit $FAIL
