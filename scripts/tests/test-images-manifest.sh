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

# A published image with no source_paths let resolve-release-images.mjs's
# drift check silently no-op: promote-release-images.sh builds its
# --source-paths argument via `(i.source_paths||[]).join(',')`, which
# produces '' for a missing (or empty) array, and the resolver's
# `if (sourcePaths)` then reads '' as "no check requested" instead of
# "nothing to check" -- the release gate prints a digest and exits 0 across a
# window with a real diff, never complaining. Closed at the source here
# rather than relying on that one consumer to notice the gap.
#
# The real images-manifest.mjs is copied (not symlinked) into a throwaway
# tree, same reasoning as test-promote-release-images.sh's make_repo: it
# resolves deploy/images.json relative to its OWN file location via
# import.meta.url, which Node follows through a symlink back to this repo's
# real manifest -- only a real copy next to a throwaway deploy/images.json
# reads the throwaway one.
assert_a_published_image_with_no_source_paths_is_rejected() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/scripts/release" "$d/deploy"
  cp "$REPO_ROOT/scripts/release/images-manifest.mjs" "$d/scripts/release/"
  cat > "$d/deploy/images.json" <<'JSON'
{
  "images": [
    {
      "name": "widget",
      "path": "widget",
      "published": true,
      "deployed_to_minikube": false
    }
  ]
}
JSON
  local out rc
  out="$( cd "$d" && node -e '
    import("./scripts/release/images-manifest.mjs").catch(err => {
      console.log(err.message)
      process.exit(1)
    })' 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "source_paths" <<< "$out"; then
    pass "a published image with no source_paths is rejected at load time"
  else
    fail "expected a named failure about missing source_paths; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# check-image-visibility.mjs interpolates image.name straight into GHCR
# token/manifest URLs, and promote-release-images.sh interpolates it into
# shell `crane` refs -- a name with characters either of those would treat
# specially (path separators, whitespace, shell metacharacters) must be
# rejected at the one place both consumers read from, not discovered by
# either consumer individually.
#
# Same real-copy-into-a-throwaway-tree reasoning as
# assert_a_published_image_with_no_source_paths_is_rejected above.
assert_an_invalid_image_name_is_rejected() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/scripts/release" "$d/deploy"
  cp "$REPO_ROOT/scripts/release/images-manifest.mjs" "$d/scripts/release/"
  cat > "$d/deploy/images.json" <<'JSON'
{
  "images": [
    {
      "name": "widget/../evil",
      "path": "widget",
      "source_paths": ["widget/**"],
      "published": true,
      "deployed_to_minikube": false
    }
  ]
}
JSON
  local out rc
  out="$( cd "$d" && node -e '
    import("./scripts/release/images-manifest.mjs").catch(err => {
      console.log(err.message)
      process.exit(1)
    })' 2>&1 )" && rc=0 || rc=1
  if [ "$rc" -ne 0 ] && grep -qi "not a valid image name" <<< "$out"; then
    pass "an invalid image name is rejected at load time"
  else
    fail "expected a named failure about an invalid image name; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_unpublished_images_are_exactly_the_known_two() {
  local got
  got="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m =>
      console.log(m.IMAGES.filter(i=>!i.published).map(i=>i.name).sort().join(",")))' 2>/dev/null)"
  # Verified by anonymous ghcr probe: these two return `denied`. playwright-server
  # IS published (an earlier draft wrongly listed it as a gap; the probe that said
  # otherwise was missing its Accept header). doc-generator-mcp used to be the
  # third; it has no manifest row at all now (see
  # assert_doc_generator_mcp_has_been_removed_from_the_image_system).
  local want="workflow-custom-sdk-e2e,workflow-plugin-sdk-e2e"
  if [ "$got" = "$want" ]; then
    pass "the unpublished set is exactly the known two"
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

# deploy/images.json's source_paths is a FOURTH hand-maintained copy of the
# same path data as build-publish.yml's `filters:` block (the paths-filter
# step in the detect job) -- on top of the image/path/dockerfile/rooted
# copies the cases above already guard. `filters:` decides which images get
# rebuilt; resolve-release-images.mjs reads source_paths to decide which
# images the release gate still watches for source changes after the
# published build. They agree today (checked programmatically), but nothing
# enforced it: add a path to one image's `filters:` entry and forget
# source_paths, and builds stay correct while the release gate silently
# stops watching that path -- letting a release promote an image whose
# source moved after it was built.
#
# Several images share one filter (mcp-host/-slim/-full/-desktop all read
# needs.detect.outputs.mcp-host; the four workflow-recipes-family images
# share needs.detect.outputs.workflow-recipes), so each image is mapped to
# its filter via its own `changed: ${{ needs.detect.outputs.<key> }}`
# expression in the build-push include: list, not by assuming the image
# name equals the filter key.
#
# \x27 stands in for a literal apostrophe (the filters: block quotes its
# paths, e.g. - 'control-api/**') so the regex source needs no single quote
# that would otherwise close the outer bash '...' this whole script is
# wrapped in.
#
# Same guard-and-.catch() treatment as the other workflow-parsing cases
# above, for the same reason: an unguarded regex miss here must be a loud
# fail, not empty stdout read as "no mismatches". Additionally, any line
# inside the filters: block that matches neither a "key:" line nor a
# "- 'path'" line is itself a parse failure rather than a silently dropped
# line -- a structural change to the block (e.g. a multi-line YAML anchor)
# must not quietly shrink the parsed path list to something that happens to
# still match.
assert_source_paths_match_filters() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const wfPath = "'"$REPO_ROOT"'/.github/workflows/build-publish.yml"
      const wf = fs.readFileSync(wfPath, "utf8")

      const filtersMatch = wf.match(/filters: \|\n([\s\S]*?)\n\n {2}build-push:/)
      if (!filtersMatch) {
        console.log(`PARSE_ERROR: could not find the paths-filter "filters:" block (a line "filters: |" through the blank line before "  build-push:") in ${wfPath}`)
        process.exit(1)
      }

      const filters = {}
      let currentKey = null
      for (const line of filtersMatch[1].split("\n")) {
        if (!line.trim()) continue
        const keyMatch = line.match(/^\s*([\w.-]+):\s*$/)
        const pathMatch = line.match(/^\s*-\s*\x27([^\x27]+)\x27\s*$/)
        if (keyMatch) {
          currentKey = keyMatch[1]
          filters[currentKey] = []
        } else if (pathMatch && currentKey) {
          filters[currentKey].push(pathMatch[1])
        } else {
          console.log(`PARSE_ERROR: unrecognized line in the filters: block: ${JSON.stringify(line)}`)
          process.exit(1)
        }
      }
      if (Object.keys(filters).length === 0) {
        console.log("PARSE_ERROR: the filters: block parsed to zero filter keys")
        process.exit(1)
      }

      const sectionMatch = wf.match(/include:\n([\s\S]*?)\n {4}steps:/)
      if (!sectionMatch) {
        console.log(`PARSE_ERROR: could not find the build-push matrix section (a line "include:" through the next 4-space-indented "steps:") in ${wfPath}`)
        process.exit(1)
      }
      const blocks = sectionMatch[1].split(/\n(?=\s*- image:)/)
      const filterKeyOf = {}
      for (const block of blocks) {
        const name = block.match(/- image:\s*(\S+)/)?.[1]
        if (!name) continue
        const changedKey = block.match(/\n\s*changed:\s*\$\{\{\s*needs\.detect\.outputs\.([\w.-]+)\s*\}\}/)?.[1]
        if (!changedKey) {
          console.log(`PARSE_ERROR: matrix entry ${name} has no "changed: \${{ needs.detect.outputs.<key> }}" line`)
          process.exit(1)
        }
        filterKeyOf[name] = changedKey
      }
      if (Object.keys(filterKeyOf).length === 0) {
        console.log("PARSE_ERROR: parsed zero image -> filter-key mappings from the build-push matrix")
        process.exit(1)
      }

      const bad = []
      for (const [name, filterKey] of Object.entries(filterKeyOf)) {
        const img = m.IMAGES.find(i => i.name === name)
        if (!img) { bad.push(`${name}:no-manifest-row`); continue }
        const filterPaths = filters[filterKey]
        if (!filterPaths) { bad.push(`${name}:no-filters-block-for-${filterKey}`); continue }
        const manifestPaths = [...(img.source_paths || [])].sort()
        const wfPaths = [...filterPaths].sort()
        if (JSON.stringify(manifestPaths) !== JSON.stringify(wfPaths)) {
          bad.push(`${name}:source_paths=[${manifestPaths.join("|")}] filter[${filterKey}]=[${wfPaths.join("|")}]`)
        }
      }
      console.log(bad.join(","))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "source_paths/filters comparison failed: $output"
  elif [ -z "$output" ]; then
    pass "every image's source_paths matches its filter's path list in build-publish.yml"
  else
    fail "source_paths disagrees with filters: $output"
  fi
}

# A change in the shared egress core must rebuild both direct controller
# consumers. HCC owns its own filter, while four published artifacts share the
# workflow-recipes filter: the controller, coordinator, snippet runner, and
# published workflow base. The base is deliberately not Minikube-deployed; it
# remains a published SDK build base rather than acquiring a runtime overlay.
#
# This is intentionally more specific than the generic source_paths/filter
# parity guard above. A synchronized omission from both hand-maintained copies
# would otherwise stay green while a core-only change selected no image at all.
assert_network_policy_core_change_rebuilds_all_consumers() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const wfPath = "'"$REPO_ROOT"'/.github/workflows/build-publish.yml"
      const wf = fs.readFileSync(wfPath, "utf8")
      const sourcePath = "packages/network-policy-core/**"

      const filtersMatch = wf.match(/filters: \|\n([\s\S]*?)\n\n {2}build-push:/)
      if (!filtersMatch) {
        console.log(`PARSE_ERROR: could not find the paths-filter filters block in ${wfPath}`)
        process.exit(1)
      }
      const filters = {}
      let currentKey = null
      for (const line of filtersMatch[1].split("\n")) {
        if (!line.trim()) continue
        const keyMatch = line.match(/^\s*([\w.-]+):\s*$/)
        const pathMatch = line.match(/^\s*-\s*\x27([^\x27]+)\x27\s*$/)
        if (keyMatch) {
          currentKey = keyMatch[1]
          filters[currentKey] = []
        } else if (pathMatch && currentKey) {
          filters[currentKey].push(pathMatch[1])
        } else {
          console.log(`PARSE_ERROR: unrecognized line in the filters block: ${JSON.stringify(line)}`)
          process.exit(1)
        }
      }

      const expectedFilterKeys = ["control-api", "host-context-controller", "workflow-recipes"]
      const coreFilterKeys = Object.entries(filters)
        .filter(([, paths]) => paths.includes(sourcePath))
        .map(([key]) => key)
        .sort()
      const problems = []
      if (coreFilterKeys.join(",") !== expectedFilterKeys.join(",")) {
        problems.push(`filters for ${sourcePath} are ${coreFilterKeys.join(",") || "<none>"}, expected ${expectedFilterKeys.join(",")}`)
      }

      const sectionMatch = wf.match(/include:\n([\s\S]*?)\n {4}steps:/)
      if (!sectionMatch) {
        console.log(`PARSE_ERROR: could not find the build-push matrix section in ${wfPath}`)
        process.exit(1)
      }
      const imageFilterKeys = {}
      for (const block of sectionMatch[1].split(/\n(?=\s*- image:)/)) {
        const image = block.match(/- image:\s*(\S+)/)?.[1]
        if (!image) continue
        const changedKey = block.match(/\n\s*changed:\s*\$\{\{\s*needs\.detect\.outputs\.([\w.-]+)\s*\}\}/)?.[1]
        if (!changedKey) {
          console.log(`PARSE_ERROR: matrix entry ${image} has no detect output mapping`)
          process.exit(1)
        }
        imageFilterKeys[image] = changedKey
      }

      const expectedImages = [
        "clerum-workflow-base",
        "control-api",
        "host-context-controller",
        "workflow-coordinator",
        "workflow-recipes",
        "workflow-snippet-runner",
      ]
      const selectedImages = Object.entries(imageFilterKeys)
        .filter(([, filterKey]) => coreFilterKeys.includes(filterKey))
        .map(([image]) => image)
        .sort()
      if (selectedImages.join(",") !== expectedImages.join(",")) {
        problems.push(`core-only selection is ${selectedImages.join(",") || "<none>"}, expected ${expectedImages.join(",")}`)
      }

      const manifestByName = new Map(m.IMAGES.map(image => [image.name, image]))
      for (const imageName of expectedImages) {
        const image = manifestByName.get(imageName)
        if (!image) {
          problems.push(`${imageName} has no deploy/images.json row`)
        } else if (!image.source_paths?.includes(sourcePath)) {
          problems.push(`${imageName} does not mirror ${sourcePath} in source_paths`)
        }
      }
      const workflowBase = manifestByName.get("clerum-workflow-base")
      if (!workflowBase) {
        problems.push("clerum-workflow-base has no deploy/images.json row")
      } else {
        if (workflowBase.published !== true) problems.push("clerum-workflow-base must remain published")
        if (workflowBase.deployed_to_minikube !== false) problems.push("clerum-workflow-base must remain non-deployed")
      }
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "network-policy-core changed-path contract parse failed: $output"
  elif [ -z "$output" ]; then
    pass "a network-policy-core-only change rebuilds HCC and the four-artifact WRC fan-out"
  else
    fail "network-policy-core changed-path contract failed: $output"
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
# NOTE: the case that used to sit here grepped build-images.sh for the strings
# IMAGE_SOURCE, pullInGhcrMode and VERIFY_IMAGES. It died the moment the
# derivation moved into minikubeVerifyRefs() -- while `if (false && ...)` around
# the same derivation would have left it green. Its intent, "--verify-only
# checks the ref the CLUSTER runs", is now covered by execution instead: the
# derivation by the minikubeVerifyRefs cases below, and the end-to-end
# behaviour (including which mode is chosen) by
# scripts/tests/test-minikube-verify-images.sh, which runs the real script
# against a stubbed daemon holding one mode's refs only.

# The rule has to hold in BOTH modes, not just ghcr: the published:false images
# have no ghcr counterpart at all, so whenever they are verified they are
# verified under their local clerum/* ref, IMAGE_SOURCE notwithstanding.
# (WHETHER each one is verified in ghcr mode is a separate question, settled by
# e2e_only in the cases below: the two sdk-e2e fixtures are acquired only by
# `make minikube-setup-e2e`.)
assert_the_verify_set_splits_on_published_not_on_mode() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const ghcrNames = new Set(m.pullInGhcrMode().map(i => i.name))
      const bad = []
      for (const i of m.IMAGES) {
        if (!i.deployed_to_minikube) continue
        const inGhcrSet = ghcrNames.has(i.name)
        if (i.published !== inGhcrSet) {
          bad.push(`${i.name}: published=${i.published} but pull_in_ghcr_mode=${inGhcrSet}`)
        }
      }
      console.log(bad.join(","))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "verify-set derivation failed: $output"
  elif [ -z "$output" ]; then
    pass "for every minikube-deployed image, ghcr-vs-local verification splits on published"
  else
    fail "$output"
  fi
}

# `make minikube-setup` (default ghcr, SEED_PROFILE=minimal) builds nothing at
# all now. The two sdk-e2e fixtures are built by `make minikube-setup-e2e` alone
# and no pull can supply them (published:false), so demanding them on the
# default path fails a healthy cluster with a remedy that can never work.
#
# doc-generator-mcp used to be the one exception -- unpublished but built on
# both paths. It has no manifest row at all now (never published, so no cluster
# could ever acquire it), so it is not in the verify set in any mode.
#
# The expected refs are spelled out rather than re-derived from the manifest:
# a test that recomputes minikubeVerifyRefs()'s own rule proves nothing.
assert_the_default_ghcr_verify_set_omits_only_the_e2e_fixtures() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const refs = m.minikubeVerifyRefs({ mode: "ghcr", tag: "vTEST" })
      const problems = []
      const deployed = m.IMAGES.filter(i => i.deployed_to_minikube).length
      for (const gone of ["workflow-custom-sdk-e2e", "workflow-plugin-sdk-e2e"]) {
        if (refs.some(r => r.includes(gone))) problems.push(`${gone} is still demanded in ghcr mode`)
      }
      if (!refs.includes("ghcr.io/evenfire-ai/control-api:vTEST")) {
        problems.push("a published image is not verified at its ghcr ref")
      }
      if (refs.length !== deployed - 2) {
        problems.push(`expected ${deployed - 2} refs, got ${refs.length}`)
      }
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "verify-set derivation failed: $output"
  elif [ -z "$output" ]; then
    pass "the default ghcr verify set drops the two E2E fixtures and nothing else"
  else
    fail "$output"
  fi
}

# THE REGRESSION GUARD for this change. MCP servers are distributed through the
# evenfire registry and installed on demand: a registry install copies the
# catalog entry's fully-qualified imageRef straight into McpServer.spec.image
# (control-api/src/routes/admin/registry.ts:1088) and the kubelet pulls it, so
# no locally loaded clerum/* alias is involved and minikube setup must neither
# build nor pull these images.
#
# Named explicitly, and asserted at every derived consumer at once, because the
# single manifest flag fans out to four different answers. Re-deriving any of
# them from deployed_to_minikube would make this pass no matter what the flag
# says.
#
# `published` is deliberately NOT asserted false: the registry serves these
# images from ghcr, so publishing must continue. That is exactly the pair this
# case exists to hold apart -- published:true, deployed_to_minikube:false.
assert_registry_distributed_mcp_servers_are_out_of_the_minikube_set() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const registryServed = ["airtable-mcp-server", "web-search-mcp"]
      const problems = []
      const byName = new Map(m.IMAGES.map(i => [i.name, i]))
      const ghcrNames = new Set(m.pullInGhcrMode().map(i => i.name))
      const ghcrRefs = m.minikubeVerifyRefs({ mode: "ghcr", tag: "vTEST" })
      const localRefs = m.minikubeVerifyRefs({ mode: "local" })
      const e2eRefs = m.minikubeVerifyRefs({ mode: "ghcr", tag: "vTEST", includeE2eFixtures: true })
      for (const name of registryServed) {
        const image = byName.get(name)
        if (!image) {
          problems.push(`${name} has no manifest row at all`)
          continue
        }
        if (image.deployed_to_minikube) problems.push(`${name} is still deployed_to_minikube`)
        // The pull half: pullInGhcrMode() is what pull-images.sh iterates.
        if (ghcrNames.has(name)) problems.push(`${name} is still pulled in ghcr mode`)
        // The verify half, in all three modes -- a ref demanded here would fail
        // a healthy cluster that correctly never acquired the image.
        for (const [label, refs] of [["ghcr", ghcrRefs], ["local", localRefs], ["ghcr+e2e", e2eRefs]]) {
          if (refs.some(r => r.includes(name))) problems.push(`${name} is still verified in ${label} mode`)
        }
      }
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "registry-distributed derivation failed: $output"
  elif [ -z "$output" ]; then
    pass "the registry-distributed MCP servers are neither deployed, pulled, nor verified"
  else
    fail "$output"
  fi
}

# The other half of the pair above, and the reason it cannot simply assert
# "these two are absent from deploy/images.json". Dropping the rows would stop
# publishing them, and the registry serves these images from ghcr -- so the rows
# must stay, with published untouched.
#
# doc-generator-mcp was the third name here, pinned as published:false. That
# combination was unserveable -- the registry cannot install an image no one
# pushes -- so the image was removed from the system outright instead of being
# published; assert_doc_generator_mcp_has_been_removed_from_the_image_system
# holds that.
assert_registry_distributed_mcp_servers_keep_their_published_flag() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const expected = new Map([
        ["airtable-mcp-server", true],
        ["web-search-mcp", true],
      ])
      const problems = []
      const byName = new Map(m.IMAGES.map(i => [i.name, i]))
      const publishedNames = new Set(m.publishedImages().map(i => i.name))
      for (const [name, want] of expected) {
        const image = byName.get(name)
        if (!image) {
          problems.push(`${name} has no manifest row at all`)
          continue
        }
        if (image.published !== want) {
          problems.push(`${name}.published is ${image.published}, expected ${want}`)
        }
        if (publishedNames.has(name) !== want) {
          problems.push(`${name} publishedImages() membership is ${publishedNames.has(name)}, expected ${want}`)
        }
      }
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "published-flag derivation failed: $output"
  elif [ -z "$output" ]; then
    pass "the registry-distributed MCP servers keep publishing"
  else
    fail "$output"
  fi
}

# THE REGRESSION GUARD for the removal. doc-generator-mcp was published:false
# AND deployed_to_minikube:false: nothing built it, nothing pulled it, and
# ghcr.io/evenfire-ai/doc-generator-mcp answers 403 because it was never
# pushed. An image obtainable nowhere is not a gap to publish, it is a row to
# delete -- so the row is gone, and every set derived from it must stay empty
# of the name.
#
# Asserted against the derived sets by NAME rather than by re-deriving the
# absence rule, and across every consumer at once: the missing row fans out to
# the build matrix, the puller, the ghcr overlay component, and all three
# verify modes, and a check on IMAGES alone would not notice a name
# reintroduced further down the chain.
#
# The source directory mcp-servers/doc-generator deliberately survives: it is
# an npm workspace package (@clerum/doc-generator-mcp) that scripts/build-
# preflight.sh type-checks and scripts/prettier/paths.mjs formats. This case is
# about the IMAGE, so it must not grow an assertion about the tree.
assert_doc_generator_mcp_has_been_removed_from_the_image_system() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const gone = "doc-generator-mcp"
      const problems = []
      if (m.IMAGES.some(i => i.name === gone)) problems.push("still has a row in deploy/images.json")
      if (m.publishedImages().some(i => i.name === gone)) problems.push("still in publishedImages()")
      if (m.pullInGhcrMode().some(i => i.name === gone)) problems.push("still in pullInGhcrMode()")
      const modes = [
        ["ghcr", m.minikubeVerifyRefs({ mode: "ghcr", tag: "vTEST" })],
        ["local", m.minikubeVerifyRefs({ mode: "local" })],
        ["ghcr+e2e", m.minikubeVerifyRefs({ mode: "ghcr", tag: "vTEST", includeE2eFixtures: true })],
      ]
      for (const [label, refs] of modes) {
        if (refs.some(r => r.includes(gone))) problems.push(`still verified in ${label} mode`)
      }
      // The two hand-written lists the manifest does not generate. Read rather
      // than derived, because a stale entry in either is exactly what a
      // manifest-only check cannot see.
      const wf = fs.readFileSync("'"$REPO_ROOT"'/.github/workflows/build-publish.yml", "utf8")
      if (wf.includes(gone)) problems.push("still named in the build-publish.yml matrix")
      const sh = fs.readFileSync("'"$REPO_ROOT"'/scripts/minikube/build-images.sh", "utf8")
      const block = sh.match(/ALL_IMAGES=\(([\s\S]*?)\n\)/)
      if (!block) {
        console.log("PARSE_ERROR: could not find the ALL_IMAGES=(...) array in build-images.sh")
        process.exit(1)
      }
      const refs = [
        ...[...block[1].matchAll(/"([^"]+)"/g)].map(x => x[1]),
        ...[...sh.matchAll(/ALL_IMAGES\+=\("([^"]+)"\)/g)].map(x => x[1]),
      ]
      if (refs.some(r => r.includes(gone))) problems.push("still built by build-images.sh")
      const overlay = fs.readFileSync("'"$REPO_ROOT"'/deploy/overlays/minikube/kustomization.yaml", "utf8")
      if (overlay.includes(gone)) problems.push("still named in the minikube overlay")
      const component = fs.readFileSync("'"$REPO_ROOT"'/deploy/components/ghcr-images/kustomization.yaml", "utf8")
      if (component.includes(gone)) problems.push("still named in the ghcr-images component")
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "doc-generator-mcp removal check failed: $output"
  elif [ -z "$output" ]; then
    pass "doc-generator-mcp is gone from the manifest and every derived set"
  else
    fail "doc-generator-mcp: $output"
  fi
}

# The exclusion is an opt-out, not a deletion. `make minikube-setup-e2e` builds
# both fixtures, and a full LOCAL build builds every fixture unconditionally --
# origin/dev verified them, and dropping them there would lose real coverage.
assert_the_e2e_opt_in_and_local_mode_both_keep_the_fixtures() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const problems = []
      const wanted = ["clerum/workflow-custom-sdk-e2e:test", "clerum/workflow-plugin-sdk-e2e:test"]
      const optedIn = m.minikubeVerifyRefs({ mode: "ghcr", tag: "vTEST", includeE2eFixtures: true })
      for (const ref of wanted) {
        if (!optedIn.includes(ref)) problems.push(`ghcr+opt-in is missing ${ref}`)
      }
      const local = m.minikubeVerifyRefs({ mode: "local" })
      for (const ref of wanted) {
        if (!local.includes(ref)) problems.push(`local mode is missing ${ref}`)
      }
      if (local.some(r => r.startsWith("ghcr.io/"))) problems.push("local mode emitted a ghcr ref")
      if (local.length !== m.IMAGES.filter(i => i.deployed_to_minikube).length) {
        problems.push(`local mode dropped an image: ${local.length} refs`)
      }
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "verify-set derivation failed: $output"
  elif [ -z "$output" ]; then
    pass "both the e2e opt-in and local mode keep the E2E fixtures in the verify set"
  else
    fail "$output"
  fi
}

# A mode this function cannot serve must throw, not fall through to some
# default: a silent fallback would emit `...:undefined` refs, and every one of
# them would then be reported MISSING against a healthy cluster.
assert_verify_refs_refuses_a_mode_or_tag_it_cannot_serve() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const problems = []
      const mustThrow = (label, fn) => {
        try {
          const refs = fn()
          problems.push(`${label} returned ${refs.length} refs instead of throwing`)
        } catch {
          /* expected */
        }
      }
      mustThrow("an unknown mode", () => m.minikubeVerifyRefs({ mode: "gcr", tag: "vTEST" }))
      mustThrow("a missing mode", () => m.minikubeVerifyRefs({}))
      mustThrow("ghcr with no tag", () => m.minikubeVerifyRefs({ mode: "ghcr" }))
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "verify-set derivation failed: $output"
  elif [ -z "$output" ]; then
    pass "an unknown mode and a tagless ghcr call both throw"
  else
    fail "$output"
  fi
}

# e2e_only removes a ref from the default verify set, so a published image must
# never carry it -- that would silently stop verifying an image every cluster
# pulls.
assert_e2e_only_images_are_unpublished_minikube_fixtures() {
  local output rc
  output="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      const flagged = m.IMAGES.filter(i => i.e2e_only)
      const problems = []
      const names = flagged.map(i => i.name).sort().join(",")
      if (names !== "workflow-custom-sdk-e2e,workflow-plugin-sdk-e2e") {
        problems.push(`unexpected e2e_only set: ${names || "<none>"}`)
      }
      for (const i of flagged) {
        if (i.published) problems.push(`${i.name} is published AND e2e_only`)
        if (!i.deployed_to_minikube) problems.push(`${i.name} is e2e_only but not deployed_to_minikube`)
      }
      console.log(problems.join("; "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "e2e_only read failed: $output"
  elif [ -z "$output" ]; then
    pass "e2e_only marks exactly the two unpublished minikube E2E fixtures"
  else
    fail "$output"
  fi
}

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
assert_a_published_image_with_no_source_paths_is_rejected
assert_an_invalid_image_name_is_rejected
assert_unpublished_images_are_exactly_the_known_two
assert_matrix_fields_match_manifest
assert_every_matrix_image_has_a_manifest_row
assert_source_paths_match_filters
assert_network_policy_core_change_rebuilds_all_consumers
assert_all_three_image_lists_agree
assert_the_verify_set_splits_on_published_not_on_mode
assert_the_default_ghcr_verify_set_omits_only_the_e2e_fixtures
assert_registry_distributed_mcp_servers_are_out_of_the_minikube_set
assert_registry_distributed_mcp_servers_keep_their_published_flag
assert_doc_generator_mcp_has_been_removed_from_the_image_system
assert_the_e2e_opt_in_and_local_mode_both_keep_the_fixtures
assert_verify_refs_refuses_a_mode_or_tag_it_cannot_serve
assert_e2e_only_images_are_unpublished_minikube_fixtures
assert_every_defined_case_is_invoked

exit $FAIL
