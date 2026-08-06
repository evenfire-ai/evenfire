#!/usr/bin/env bash
set -u
FAIL=0

# deploy/components/ghcr-images/ rewrites every pull_in_ghcr_mode image to its
# ghcr.io/evenfire-ai counterpart at the pinned release tag.
#
# The component carries its OWN copy of the overlay's imagetags.yaml FieldSpec
# because kustomize forbids a component referencing a `configurations:` file
# outside its own directory (reproduced on kubectl v1.31.3 / kustomize v5.4.2:
# "security; file '.../overlays/minikube/kustomizeconfig/imagetags.yaml' is not
# in or below '.../components/ghcr-images'"). `kubectl apply -k` has no
# --load-restrictor escape, so the copy is mandatory and this harness is what
# keeps it byte-identical to its source.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPONENT="$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml"
COMPONENT_FIELDSPEC="$REPO_ROOT/deploy/components/ghcr-images/imagetags.yaml"
SOURCE_FIELDSPEC="$REPO_ROOT/deploy/overlays/minikube/kustomizeconfig/imagetags.yaml"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# The whole point of the copy. `diff` (not a checksum comparison built from two
# separate reads) so the failure message shows exactly which lines drifted.
assert_the_fieldspec_copy_is_byte_identical_to_its_source() {
  local out rc
  out="$(diff -u "$SOURCE_FIELDSPEC" "$COMPONENT_FIELDSPEC" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "the component's imagetags.yaml is byte-identical to the overlay's"
  else
    fail "component FieldSpec has drifted from $SOURCE_FIELDSPEC: $out"
  fi
}

# A component whose configurations: points outside its own directory does not
# build at all. Assert the value is the bare local filename, so a well-meaning
# "de-duplicate this" edit fails here rather than at apply time on a
# contributor's machine.
assert_the_component_references_only_its_own_fieldspec() {
  local out rc
  out="$(node -e '
    const fs = require("node:fs")
    const raw = fs.readFileSync("'"$COMPONENT"'", "utf8")
    const block = raw.match(/^configurations:\n((?:\s+- .*\n)+)/m)
    if (!block) {
      console.log("PARSE_ERROR: no `configurations:` block (a line \"configurations:\" followed by indented \"- \" items) in '"$COMPONENT"'")
      process.exit(1)
    }
    const entries = [...block[1].matchAll(/^\s+-\s*(\S+)\s*$/gm)].map(x => x[1])
    if (entries.length === 0) {
      console.log("PARSE_ERROR: the configurations: block parsed to zero entries")
      process.exit(1)
    }
    console.log(entries.filter(e => e !== "imagetags.yaml").join(","))
  ' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "configurations: parse failed: $out"
  elif [ -z "$out" ]; then
    pass "the component references only its own imagetags.yaml"
  else
    fail "configurations: entries outside the component directory: $out"
  fi
}

assert_it_declares_itself_a_component() {
  local out rc
  out="$(node -e '
    const fs = require("node:fs")
    const raw = fs.readFileSync("'"$COMPONENT"'", "utf8")
    const bad = []
    if (!/^apiVersion: kustomize\.config\.k8s\.io\/v1alpha1$/m.test(raw)) bad.push("apiVersion")
    if (!/^kind: Component$/m.test(raw)) bad.push("kind")
    console.log(bad.join(","))
  ' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "component header read failed: $out"
  elif [ -z "$out" ]; then
    pass "the component declares kustomize.config.k8s.io/v1alpha1 Component"
  else
    fail "wrong component header fields: $out"
  fi
}

# The load-bearing derivation. A row for an image that is NOT pull_in_ghcr_mode
# is not a harmless extra: adding one for workflow-custom-sdk-e2e rewrites
# WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES from the tag-prefix "clerum/workflow-
# custom-sdk-e2e:" to "ghcr.io/evenfire-ai/workflow-custom-sdk-e2e:v0.6.0",
# appending a tag and silently breaking the prefix match against the locally
# built fixture. Set equality in BOTH directions, never a subset check.
assert_component_rows_are_exactly_the_pull_in_ghcr_mode_set() {
  local out rc
  out="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(async m => {
      const fs = await import("node:fs")
      const raw = fs.readFileSync("'"$COMPONENT"'", "utf8")
      const block = raw.match(/^images:\n([\s\S]*)$/m)
      if (!block) {
        console.log("PARSE_ERROR: no `images:` block (a line \"images:\" through end of file) in '"$COMPONENT"'")
        process.exit(1)
      }
      const rows = [...block[1].matchAll(/^\s+- name:\s*(\S+)\n\s+newName:\s*(\S+)\n\s+newTag:\s*(\S+)\s*$/gm)]
        .map(x => ({ name: x[1], newName: x[2], newTag: x[3] }))
      if (rows.length === 0) {
        console.log("PARSE_ERROR: the images: block parsed to zero name/newName/newTag rows")
        process.exit(1)
      }
      const want = m.pullInGhcrMode()
      const wantNames = want.map(i => `clerum/${i.local_name ?? i.name}`).sort()
      const gotNames = rows.map(r => r.name).sort()
      const problems = []
      if (JSON.stringify(wantNames) !== JSON.stringify(gotNames)) {
        const missing = wantNames.filter(n => !gotNames.includes(n))
        const extra = gotNames.filter(n => !wantNames.includes(n))
        if (missing.length) problems.push(`pull_in_ghcr_mode but no component row: ${missing.join("|")}`)
        if (extra.length) problems.push(`component row but not pull_in_ghcr_mode: ${extra.join("|")}`)
        if (!missing.length && !extra.length) problems.push("same names, different multiset (a duplicate row is masking a missing one)")
      }
      const newNameOf = new Map(want.map(i => [`clerum/${i.local_name ?? i.name}`, `ghcr.io/evenfire-ai/${i.name}`]))
      for (const r of rows) {
        const expected = newNameOf.get(r.name)
        if (expected && r.newName !== expected) problems.push(`${r.name}: newName=${r.newName}, expected ${expected}`)
      }
      console.log(problems.join(" / "))
    }).catch(err => {
      console.log(`PARSE_ERROR: ${err.message}`)
      process.exit(1)
    })' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "component row comparison failed: $out"
  elif [ -z "$out" ]; then
    pass "component rows are exactly the pull_in_ghcr_mode set, with the right newName"
  else
    fail "$out"
  fi
}

# Tasks 3, 5, 8 and 9 all read "the pin" as the first newTag: in this file. That
# reading is only correct while every row carries the same tag.
assert_every_row_carries_the_same_pinned_tag() {
  local out rc
  out="$(node -e '
    const fs = require("node:fs")
    const raw = fs.readFileSync("'"$COMPONENT"'", "utf8")
    const tags = [...raw.matchAll(/^\s+newTag:\s*(\S+)\s*$/gm)].map(x => x[1])
    if (tags.length === 0) {
      console.log("PARSE_ERROR: no newTag: lines in '"$COMPONENT"'")
      process.exit(1)
    }
    const distinct = [...new Set(tags)]
    if (distinct.length !== 1) { console.log(`mixed tags: ${distinct.join("|")}`); process.exit(0) }
    if (!/^v\d+\.\d+\.\d+$/.test(distinct[0])) { console.log(`pin ${distinct[0]} is not vMAJOR.MINOR.PATCH`); process.exit(0) }
    console.log("")
  ' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "pin read failed: $out"
  elif [ -z "$out" ]; then
    pass "every component row carries the same vMAJOR.MINOR.PATCH pin"
  else
    fail "$out"
  fi
}

# The committed pin must never be a moving tag. MINIKUBE_IMAGE_TAG=latest is the
# supported bootstrap, and it renders only in a temp copy (Task 5).
assert_the_committed_pin_is_not_a_moving_tag() {
  local out rc
  out="$(node -e '
    const fs = require("node:fs")
    const raw = fs.readFileSync("'"$COMPONENT"'", "utf8")
    const tags = [...raw.matchAll(/^\s+newTag:\s*(\S+)\s*$/gm)].map(x => x[1])
    if (tags.length === 0) {
      console.log("PARSE_ERROR: no newTag: lines in '"$COMPONENT"'")
      process.exit(1)
    }
    console.log([...new Set(tags)].filter(t => t === "latest" || t === "stable" || t.startsWith("sha-")).join(","))
  ' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "pin read failed: $out"
  elif [ -z "$out" ]; then
    pass "the committed pin is an immutable release tag, not a moving one"
  else
    fail "the committed component points at moving tag(s): $out"
  fi
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-ghcr-component.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_the_fieldspec_copy_is_byte_identical_to_its_source
assert_the_component_references_only_its_own_fieldspec
assert_it_declares_itself_a_component
assert_component_rows_are_exactly_the_pull_in_ghcr_mode_set
assert_every_row_carries_the_same_pinned_tag
assert_the_committed_pin_is_not_a_moving_tag
assert_every_defined_case_is_invoked

exit $FAIL
