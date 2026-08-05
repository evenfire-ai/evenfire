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

# No unguarded regex index here (wf.includes() can't throw on a content
# mismatch), but a readFileSync failure (workflow file moved/renamed) would
# still throw inside the unguarded .then() and vacuously pass under the same
# 2>/dev/null + empty-output-means-pass shape as the other cases. Same
# .catch()-and-exit-code treatment, no restructuring needed.
assert_every_published_image_has_a_build_matrix_entry() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const wf = fs.readFileSync("'"$REPO_ROOT"'/.github/workflows/build-publish.yml", "utf8")
      const gaps = m.publishedImages()
        .filter(i => !wf.includes(`- image: ${i.name}\n`))
        .map(i => i.name)
      console.log(gaps.join(","))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "build-matrix read failed: $output"
  elif [ -z "$output" ]; then
    pass "every published image has a build-matrix entry"
  else
    fail "published but absent from the build matrix: $output"
  fi
}

# ALL_IMAGES's base array covers most locally-built refs, but two images are
# only added via conditional `ALL_IMAGES+=(...)` appends (mcp-host-desktop,
# playwright-mcp-server) gated behind env flags that default off. Those refs
# must resolve through localRef() too, or a broken local_name/local_tag on
# either image goes unnoticed (this is exactly the field the brief flags as
# a gotcha for playwright-server).
#
# This is the only coverage for local_name/local_tag, and until now it had
# the exact same unguarded-index bug fixed in assert_matrix_fields_match_
# manifest and assert_every_matrix_image_has_a_manifest_row:
# sh.match(/ALL_IMAGES=\(.../) followed by block[1] with no null check. A
# rename of the ALL_IMAGES array made the match return null, null[1] threw
# inside the unguarded .then(), 2>/dev/null swallowed it, and empty stdout
# read as pass -- silently losing the only local_name/local_tag coverage the
# manifest has. Same fix as the other two: guard the match, .catch() the
# chain, surface stderr, check the exit code before checking emptiness.
assert_every_local_image_maps_to_exactly_one_row() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const shPath = "'"$REPO_ROOT"'/scripts/minikube/build-images.sh"
      const sh = fs.readFileSync(shPath, "utf8")
      const block = sh.match(/ALL_IMAGES=\(([\s\S]*?)\n\)/)
      if (!block) {
        console.log(`PARSE_ERROR: could not find the ALL_IMAGES=(...) array in ${shPath}`)
        process.exit(1)
      }
      const baseRefs = [...block[1].matchAll(/"([^"]+)"/g)].map(x => x[1])
      const appendRefs = [...sh.matchAll(/ALL_IMAGES\+=\("([^"]+)"\)/g)].map(x => x[1])
      const refs = [...baseRefs, ...appendRefs]
      const known = new Set(m.IMAGES.map(i => m.localRef(i)))
      console.log(refs.filter(r => !known.has(r)).join(","))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "ALL_IMAGES parse failed: $output"
  elif [ -z "$output" ]; then
    pass "every build-images.sh ref, including conditional appends, maps to exactly one manifest row"
  else
    fail "build-images.sh refs with no manifest row: $output"
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

# The two previous cases only check that a name/ref exists somewhere on both
# sides. Neither reads the substance of what was transcribed: path,
# dockerfile, and rooted feed Task 3's generated build matrix directly, so a
# wrong path or a dropped `rooted` breaks the real build silently here.
#
# The section/name regexes below are guarded and the promise chain has an
# explicit .catch(): an earlier version indexed `wf.match(...)[1]` directly,
# so a structural change to build-publish.yml (e.g. `include:` renamed) made
# the match return null, `null[1]` threw inside the unguarded .then(), the
# stderr redirect swallowed the unhandled-rejection warning, and empty stdout
# read as "no mismatches" -- a silent 8/8-green pass against a workflow whose
# matrix section was never parsed at all. That is the exact failure class
# assert_every_defined_case_is_invoked's -P grep bug was in this file to
# eliminate; keep stderr visible (2>&1, not 2>/dev/null) here so a genuine
# crash still surfaces in the fail message rather than just flipping the
# exit code.
assert_matrix_fields_match_manifest() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const wfPath = "'"$REPO_ROOT"'/.github/workflows/build-publish.yml"
      const wf = fs.readFileSync(wfPath, "utf8")
      const sectionMatch = wf.match(/include:\n([\s\S]*?)\n {4}steps:/)
      if (!sectionMatch) {
        console.log(`PARSE_ERROR: could not find the build-push matrix section (a line "include:" through the next 4-space-indented "steps:") in ${wfPath}`)
        process.exit(1)
      }
      const section = sectionMatch[1]
      const blocks = section.split(/\n(?=\s*- image:)/)
      const matrixMap = {}
      for (const block of blocks) {
        const name = block.match(/- image:\s*(\S+)/)?.[1]
        if (!name) continue
        const path = block.match(/\n\s*path:\s*(\S+)/)?.[1]
        const dockerfile = block.match(/\n\s*dockerfile:\s*(\S+)/)?.[1]
        const rooted = /\n\s*rooted:\s*true/.test(block)
        matrixMap[name] = { path, dockerfile, rooted }
      }
      const bad = []
      for (const i of m.IMAGES) {
        const mm = matrixMap[i.name]
        if (!mm) continue
        if ((i.path ?? "") !== (mm.path ?? "")) bad.push(`${i.name}:path`)
        if ((i.dockerfile ?? "") !== (mm.dockerfile ?? "")) bad.push(`${i.name}:dockerfile`)
        if (!!i.rooted !== mm.rooted) bad.push(`${i.name}:rooted`)
      }
      console.log(bad.join(","))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "matrix section parse failed: $output"
  elif [ -z "$output" ]; then
    pass "manifest path/dockerfile/rooted match the build matrix for every matrix image"
  else
    fail "manifest disagrees with the build matrix: $output"
  fi
}

# assert_every_published_image_has_a_build_matrix_entry only checks
# manifest -> matrix. Nothing checked the other direction, so deleting a
# manifest row entirely (e.g. clerum-workflow-base) stayed invisible as long
# as >= 28 rows remained. This closes that gap.
#
# Same guard-and-.catch() treatment as assert_matrix_fields_match_manifest
# above, for the same reason: an unguarded `wf.match(...)[1]` here is the
# identical vacuous-pass trap on a structural build-publish.yml change.
assert_every_matrix_image_has_a_manifest_row() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const wfPath = "'"$REPO_ROOT"'/.github/workflows/build-publish.yml"
      const wf = fs.readFileSync(wfPath, "utf8")
      const sectionMatch = wf.match(/include:\n([\s\S]*?)\n {4}steps:/)
      if (!sectionMatch) {
        console.log(`PARSE_ERROR: could not find the build-push matrix section (a line "include:" through the next 4-space-indented "steps:") in ${wfPath}`)
        process.exit(1)
      }
      const section = sectionMatch[1]
      const names = [...section.matchAll(/- image:\s*(\S+)/g)].map(x => x[1])
      const known = new Set(m.IMAGES.map(i => i.name))
      console.log(names.filter(n => !known.has(n)).join(","))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "matrix section parse failed: $output"
  elif [ -z "$output" ]; then
    pass "every build-matrix image has a manifest row"
  else
    fail "build-matrix images with no manifest row: $output"
  fi
}

# THREE copies of the 28-image list exist in build-publish.yml, not two:
# build-push's `image:` matrix dimension (the array that, crossed with
# `arch`, produces the 56 base combinations), build-push's `include:` list
# (path/dockerfile/rooted/changed per image), and merge's own `include:`
# list (changed per image, for its own step gating and to know which digest
# artifacts to look for). Nothing at the YAML level keeps all three in sync.
#
# An island in the `image:` dimension is a DIFFERENT failure shape than an
# island in an `include:` list, and it's the one this case used to miss: if
# an image is in both `include:` lists but absent from the `image:`
# dimension, its `include` entry matches no base combination (nothing to
# merge onto), so GitHub creates a brand-new standalone combination from the
# entry alone -- no `arch` set, `runs-on` silently falls through to
# `ubuntu-latest`, and `platforms: linux/${{ matrix.arch }}` renders as the
# malformed `platforms: linux/`. That fails red at runtime, but only on a
# push that changes that specific image, and it was invisible to the harness
# and to every push that leaves that image unchanged -- the exact blind spot
# this case exists to close. (An island in either `include:` list is the
# fail-green shape instead: covered before this round, kept below.)
#
# Same guard-and-.catch() treatment as the other workflow-parsing cases
# above, for the same reason: an unguarded regex index here would be the
# identical vacuous-pass trap on a structural build-publish.yml change.
assert_all_three_image_lists_agree() {
  local output rc
  output="$(node -e '
    import("node:fs").then(fs => {
      const wfPath = "'"$REPO_ROOT"'/.github/workflows/build-publish.yml"
      const wf = fs.readFileSync(wfPath, "utf8")

      const buildPushJobMatch = wf.match(/\n {2}build-push:\n([\s\S]*?)\n {2}merge:\n/)
      if (!buildPushJobMatch) {
        console.log(`PARSE_ERROR: could not find the build-push job body (bounded by the next "  merge:" job header) in ${wfPath}`)
        process.exit(1)
      }
      const buildPushJob = buildPushJobMatch[1]

      const imageDimMatch = buildPushJob.match(/\n {8}image:\n([\s\S]*?)\n {8}include:\n/)
      if (!imageDimMatch) {
        console.log(`PARSE_ERROR: could not find the build-push job'"'"'s "image:" matrix dimension (an 8-space-indented "image:" line through the next 8-space-indented "include:") in ${wfPath}`)
        process.exit(1)
      }
      const buildPushIncludeMatch = buildPushJob.match(/include:\n([\s\S]*?)\n {4}steps:/)
      if (!buildPushIncludeMatch) {
        console.log(`PARSE_ERROR: could not find the build-push job'"'"'s include: list in ${wfPath}`)
        process.exit(1)
      }
      const mergeMatch = wf.match(/\n {2}merge:\n[\s\S]*?include:\n([\s\S]*?)\n {4}steps:/)
      if (!mergeMatch) {
        console.log(`PARSE_ERROR: could not find the merge matrix section in ${wfPath}`)
        process.exit(1)
      }

      // Plain "- value" array items (the image: dimension), distinct from
      // "- image: value" map entries (the two include: lists) below.
      const dimNamesOf = section => [...section.matchAll(/^[ \t]*-[ \t]+(\S+)[ \t]*$/gm)].map(x => x[1])
      const includeNamesOf = section => [...section.matchAll(/- image:\s*(\S+)/g)].map(x => x[1])

      const lists = {
        "build-push image: dimension": dimNamesOf(imageDimMatch[1]).sort(),
        "build-push include: list": includeNamesOf(buildPushIncludeMatch[1]).sort(),
        "merge include: list": includeNamesOf(mergeMatch[1]).sort(),
      }

      const names = Object.keys(lists)
      const problems = []
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = lists[names[i]]
          const b = lists[names[j]]
          if (a.join(",") === b.join(",")) continue
          const missing = a.filter(n => !b.includes(n))
          const extra = b.filter(n => !a.includes(n))
          const parts = []
          if (missing.length) parts.push(`in "${names[i]}" but not "${names[j]}": ${missing.join("|")}`)
          if (extra.length) parts.push(`in "${names[j]}" but not "${names[i]}": ${extra.join("|")}`)
          if (!missing.length && !extra.length) parts.push(`"${names[i]}" and "${names[j]}" have the same names but a different multiset (a duplicate is masking a missing entry)`)
          problems.push(parts.join("; "))
        }
      }
      console.log(problems.join(" / "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "three-way image list comparison failed: $output"
  elif [ -z "$output" ]; then
    pass "build-push's image: dimension, build-push's include: list, and merge's include: list all agree"
  else
    fail "the three image lists disagree: $output"
  fi
}

# Portable across BSD grep (macOS, rejects -P) and GNU grep (conflicting
# matchers with -E -P together): sort both lists and diff with comm instead of
# depending on a PCRE lookahead inside a single grep invocation. The old
# `grep -oE '...' -P` form errored on both greps, so the process substitution
# fed `while read` nothing, `missing` stayed empty, and this case could never
# fail -- verified by commenting out an invocation and seeing it still print
# PASS while under-reporting its own invoked count.
assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-images-manifest.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_manifest_parses_and_is_nonempty
assert_every_published_image_has_a_build_matrix_entry
assert_every_local_image_maps_to_exactly_one_row
assert_pull_in_ghcr_mode_is_derived_not_stored
assert_unpublished_images_are_exactly_the_known_three
assert_matrix_fields_match_manifest
assert_every_matrix_image_has_a_manifest_row
assert_all_three_image_lists_agree
assert_every_defined_case_is_invoked

exit $FAIL
