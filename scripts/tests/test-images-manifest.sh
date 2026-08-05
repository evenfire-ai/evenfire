#!/usr/bin/env bash
set -u
FAIL=0

# deploy/images.json is the single source of truth for the image list. Three
# lists previously disagreed: build-publish.yml's matrix (28), ALL_IMAGES in
# build-images.sh (28), and the minikube overlay's images: block (18). They are
# overlapping SUBSETS, not one list, so every check below is per-flag rather
# than set equality.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_manifest_parses_and_is_nonempty() {
  local n
  n="$(node -e 'import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m=>console.log(m.IMAGES.length))' 2>/dev/null)"
  if [ "${n:-0}" -ge 28 ]; then
    pass "images.json parses and has $n entries"
  else
    fail "expected at least 28 entries, got '${n:-<none>}'"
  fi
}

assert_every_published_image_has_a_build_matrix_entry() {
  local missing
  missing="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const wf = fs.readFileSync("'"$REPO_ROOT"'/.github/workflows/build-publish.yml", "utf8")
      const gaps = m.publishedImages()
        .filter(i => !wf.includes(`- image: ${i.name}\n`))
        .map(i => i.name)
      console.log(gaps.join(","))
    })' 2>/dev/null)"
  if [ -z "$missing" ]; then
    pass "every published image has a build-matrix entry"
  else
    fail "published but absent from the build matrix: $missing"
  fi
}

assert_every_local_image_maps_to_exactly_one_row() {
  local unmapped
  unmapped="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const sh = fs.readFileSync("'"$REPO_ROOT"'/scripts/minikube/build-images.sh", "utf8")
      const block = sh.match(/ALL_IMAGES=\(([\s\S]*?)\n\)/)
      const refs = [...block[1].matchAll(/"([^"]+)"/g)].map(x => x[1])
      const known = new Set(m.IMAGES.map(i => m.localRef(i)))
      console.log(refs.filter(r => !known.has(r)).join(","))
    })' 2>/dev/null)"
  if [ -z "$unmapped" ]; then
    pass "every ALL_IMAGES entry maps to exactly one manifest row"
  else
    fail "ALL_IMAGES entries with no manifest row: $unmapped"
  fi
}

assert_pull_in_ghcr_mode_is_derived_not_stored() {
  local bad
  bad="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      // pull_in_ghcr_mode must be published && deployed_to_minikube, derived.
      // Storing it invites the three-way conflation that broke an earlier draft:
      // the puller tried to fetch unpublished fixtures.
      const stored = m.IMAGES.filter(i => "pull_in_ghcr_mode" in i).map(i => i.name)
      const wrong = m.pullInGhcrMode().filter(i => !(i.published && i.deployed_to_minikube))
      console.log([...stored, ...wrong.map(i => i.name)].join(","))
    })' 2>/dev/null)"
  if [ -z "$bad" ]; then
    pass "pull_in_ghcr_mode is derived, never stored"
  else
    fail "stored or mis-derived: $bad"
  fi
}

assert_unpublished_images_are_exactly_the_known_three() {
  local got
  got="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m =>
      console.log(m.IMAGES.filter(i=>!i.published).map(i=>i.name).sort().join(",")))' 2>/dev/null)"
  # Verified by anonymous ghcr probe: these three return `denied`. playwright-server
  # IS published (an earlier draft wrongly listed it as a gap; the probe that said
  # otherwise was missing its Accept header).
  local want="doc-generator-mcp,workflow-custom-sdk-e2e,workflow-plugin-sdk-e2e"
  if [ "$got" = "$want" ]; then
    pass "the unpublished set is exactly the known three"
  else
    fail "unpublished set is '$got', expected '$want'"
  fi
}

assert_every_defined_case_is_invoked() {
  local defined called missing
  defined="$(grep -cE '^assert_[a-z_]+\(\) \{' "$REPO_ROOT/scripts/tests/test-images-manifest.sh")"
  called="$(grep -cE '^assert_[a-z_]+$' "$REPO_ROOT/scripts/tests/test-images-manifest.sh")"
  missing=""
  while read -r fn; do
    grep -qE "^${fn}$" "$REPO_ROOT/scripts/tests/test-images-manifest.sh" || missing="$missing $fn"
  done < <(grep -oE '^assert_[a-z_]+(?=\(\) \{)' -P "$REPO_ROOT/scripts/tests/test-images-manifest.sh")
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked ($defined defined, $called invoked)"
  else
    fail "defined but never invoked:$missing"
  fi
}

assert_manifest_parses_and_is_nonempty
assert_every_published_image_has_a_build_matrix_entry
assert_every_local_image_maps_to_exactly_one_row
assert_pull_in_ghcr_mode_is_derived_not_stored
assert_unpublished_images_are_exactly_the_known_three
assert_every_defined_case_is_invoked

exit $FAIL
