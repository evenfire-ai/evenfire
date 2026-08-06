#!/usr/bin/env bash
set -u
FAIL=0

# `build-images.sh --verify-only` decides WHICH refs a cluster must have. Two
# ways it got that wrong, both reproduced on a real cluster:
#
#   1. It read the IMAGE_SOURCE env var, which defaults to ghcr. After
#      `make minikube-setup-local` (whose IMAGE_SOURCE=local is scoped to that
#      one sub-make) `make minikube-verify-images` reported "25 of 28 images
#      missing!" on a healthy cluster, and told the user to pull -- which would
#      have overwritten their local clerum/*:test tags with release images.
#
#   2. Its ghcr verify set demanded the two E2E-only fixtures that the default
#      ghcr path never builds and no pull can supply (they are published:false).
#
# Every case runs the real script against PATH stubs for docker/minikube/kubectl
# (same technique as scripts/tests/test-minikube-pull-images.sh), so nothing
# here needs a cluster or a network. The stubbed daemon's contents are declared
# per case, which is what makes these assertions fail on inverted LOGIC rather
# than on a renamed identifier: a case that expects clerum/* refs is run against
# a daemon that holds ONLY clerum/* refs, so checking the other mode's refs
# fails it.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GHCR_COMPONENT="$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

PIN_TAG="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$GHCR_COMPONENT" | sort -u)"
if [ -z "$PIN_TAG" ] || [ "$(printf '%s\n' "$PIN_TAG" | wc -l | tr -d ' ')" != "1" ]; then
  echo "FAIL: could not read a single committed pin from $GHCR_COMPONENT (got '$PIN_TAG')"
  exit 1
fi

# The ref lists are derived from IMAGES/localRef/pullInGhcrMode -- deliberately
# NOT from minikubeVerifyRefs(), which is the function under test. Deriving the
# expectation from the implementation would make every case below tautological.
all_local_refs() {
  node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      for (const i of m.IMAGES) if (i.deployed_to_minikube) console.log(m.localRef(i))
    }).catch(e => { console.error(e.message); process.exit(1) })'
}

all_ghcr_refs() {
  node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs").then(m => {
      for (const i of m.pullInGhcrMode()) console.log(`ghcr.io/evenfire-ai/${i.name}:'"$PIN_TAG"'`)
    }).catch(e => { console.error(e.message); process.exit(1) })'
}

# The payload the stubbed `minikube image ls --format=json` serves. Each ref is
# listed under its plain and docker.io-prefixed spellings because
# minikube_image_id() normalises a ref before matching it.
write_present_json() {
  local out=$1 refs=$2
  printf '%s' "$refs" | node -e '
    const fs = require("node:fs")
    const refs = fs.readFileSync(0, "utf8").split("\n").map(s => s.trim()).filter(Boolean)
    const items = refs.map((ref, i) => ({
      id: `deadbeef${String(i).padStart(4, "0")}cafe`,
      repoTags: [ref, `docker.io/${ref}`, `docker.io/library/${ref}`],
    }))
    fs.writeFileSync(process.argv[1], JSON.stringify(items))
  ' "$out"
}

make_stubs() {
  local d=$1
  mkdir -p "$d/bin"
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *docker-env*) echo 'export DOCKER_HOST="tcp://127.0.0.1:2376"'; exit 0 ;;
  *"image ls"*--format=json*) cat "${TEST_PRESENT_JSON:?}"; exit 0 ;;
esac
exit 0
STUB
  cat > "$d/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"get nodes"*) echo "minikube  Ready  control-plane  1d  v1.30.0"; exit 0 ;;
esac
exit 0
STUB
  cat > "$d/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "${1:-}" in
  inspect) echo "sha256:deadbeef0000cafedeadbeef0000cafedeadbeef" ;;
  images)  echo "sha256:deadbeef0000" ;;
esac
exit 0
STUB
  chmod +x "$d/bin/minikube" "$d/bin/kubectl" "$d/bin/docker"
}

# An isolated PROJECT_DIR that is a copy of the real repo's deploy/ + scripts/,
# so the script reads the REAL deploy/images.json and the REAL committed pin
# rather than a fixture that could drift from them.
prepare_repo() {
  local d=$1
  make_stubs "$d"
  mkdir -p "$d/repo"
  cp -R "$REPO_ROOT/deploy" "$d/repo/deploy"
  cp -R "$REPO_ROOT/scripts" "$d/repo/scripts"
  rm -rf "$d/repo/deploy/minikube"
}

# $2 is the newline-separated set of refs the stubbed daemon holds.
run_verify() {
  local d=$1 present=$2; shift 2
  write_present_json "$d/present.json" "$present"
  PATH="$d/bin:$PATH" \
  TEST_LOG_FILE="$d/ops.log" \
  TEST_PRESENT_JSON="$d/present.json" \
    bash "$d/repo/scripts/minikube/build-images.sh" --verify-only "$@" 2>&1
}

write_recorded_manifest() {
  local d=$1 body=$2
  mkdir -p "$d/repo/deploy/minikube"
  printf '%s' "$body" > "$d/repo/deploy/minikube/.image-manifest.json"
}

# ---------------------------------------------------------------------------
# FINDING A -- the mode comes from what the cluster actually holds
# ---------------------------------------------------------------------------

# The headline regression. IMAGE_SOURCE is unset, so the script's own default
# (ghcr) applies, and the daemon holds ONLY clerum/* refs -- exactly the state
# `make minikube-setup-local` leaves behind. Reading the env instead of the
# recorded mode reports every published image missing.
assert_a_recorded_local_build_is_verified_locally_despite_the_ghcr_default() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"local","images":{}}'
  out="$(run_verify "$d" "$(all_local_refs)")"; rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -q 'clerum/control-api:test' <<< "$out" \
     && ! grep -q 'ghcr\.io/evenfire-ai/control-api' <<< "$out" \
     && grep -q 'All .* images present' <<< "$out"; then
    pass "a recorded local build is verified against clerum/* even with IMAGE_SOURCE unset"
  else
    fail "expected a clean local-mode verify (rc=0, clerum/ refs, no ghcr refs); got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# The other direction, so the fix cannot be "always verify local refs": the
# daemon holds exactly the ghcr refs and IMAGE_SOURCE=local is explicitly in
# the environment.
assert_a_recorded_ghcr_pull_is_verified_against_ghcr_despite_a_local_env() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
  present="$(all_ghcr_refs)"
  out="$(IMAGE_SOURCE=local run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -eq 0 ] \
     && grep -q "ghcr\.io/evenfire-ai/control-api:${PIN_TAG}" <<< "$out" \
     && ! grep -q 'clerum/control-api:test' <<< "$out"; then
    pass "a recorded ghcr pull is verified against ghcr refs even when IMAGE_SOURCE=local"
  else
    fail "expected a ghcr-mode verify (rc=0, ghcr refs, no clerum/control-api); got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# Nothing has been built or pulled here yet, so there is no cluster state to
# read and the env var is the only signal left.
assert_the_env_is_the_fallback_when_no_manifest_exists() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  out="$(IMAGE_SOURCE=local run_verify "$d" "$(all_local_refs)")"; rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'clerum/control-api:test' <<< "$out"; then
    pass "IMAGE_SOURCE is honoured when no image manifest exists"
  else
    fail "expected the env fallback to select local mode; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# A manifest written before this key existed, and a truncated one, must not
# abort the verify or silently pin the mode to a garbage value.
assert_a_manifest_with_no_usable_mode_falls_back_to_the_env() {
  local d out rc bad=""
  for body in \
    '{"generated":"x","profile":"clerum-test","images":{}}' \
    '{"generated":"x","imageSource":"gcr","images":{}}' \
    '{"generated": "truncated"'; do
    d="$(mktemp -d)"
    prepare_repo "$d"
    write_recorded_manifest "$d" "$body"
    out="$(IMAGE_SOURCE=local run_verify "$d" "$(all_local_refs)")"; rc=$?
    if [ "$rc" -ne 0 ] || ! grep -q 'clerum/control-api:test' <<< "$out"; then
      bad+="[$body -> rc=$rc] "
    fi
    rm -rf "$d"
  done
  if [ -z "$bad" ]; then
    pass "a manifest with no usable imageSource falls back to the env instead of failing"
  else
    fail "these manifests did not fall back cleanly: $bad"
  fi
}

# The remedy is part of the diagnostic. Telling a locally built cluster to pull
# replaces its clerum/*:test tags with release images.
assert_a_local_cluster_is_never_told_to_pull() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"local","images":{}}'
  present="$(all_local_refs | grep -v '^clerum/control-api:test$')"
  out="$(run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -q 'MISSING: clerum/control-api:test' <<< "$out" \
     && grep -q 'make minikube-build-images' <<< "$out" \
     && ! grep -q 'minikube-pull-images' <<< "$out"; then
    pass "a locally built cluster is told to rebuild, never to pull"
  else
    fail "expected a build remedy and no pull advice; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# The complement: a pulled cluster IS told to pull, and the tag it should pull
# is named (the pin can legitimately point at a tag that is not promoted yet).
assert_a_pulled_cluster_is_told_to_pull_at_the_named_tag() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
  present="$(all_ghcr_refs | grep -v "^ghcr.io/evenfire-ai/control-api:${PIN_TAG}\$")"
  out="$(run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -q "MISSING: ghcr\.io/evenfire-ai/control-api:${PIN_TAG}" <<< "$out" \
     && grep -q 'minikube-pull-images' <<< "$out" \
     && grep -q "$PIN_TAG" <<< "$out"; then
    pass "a pulled cluster is told to pull, and the remedy names the tag"
  else
    fail "expected a pull remedy naming ${PIN_TAG}; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# FINDING A -- both writers record the mode
# ---------------------------------------------------------------------------

# End-to-end across the two scripts: the puller writes the manifest, the
# verifier reads it back. IMAGE_SOURCE=local is in the environment for the
# verify run, so a pass here can only come from the recorded value.
assert_the_puller_records_ghcr_and_the_verifier_reads_it_back() {
  local d out rc pull_rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    bash "$d/repo/scripts/minikube/pull-images.sh" >"$d/pull.out" 2>&1
  pull_rc=$?
  if [ "$pull_rc" -ne 0 ]; then
    fail "the stubbed pull run failed: $(cat "$d/pull.out")"; rm -rf "$d"; return 0
  fi
  present="$(all_ghcr_refs)"
  out="$(IMAGE_SOURCE=local run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -eq 0 ] && grep -q "ghcr\.io/evenfire-ai/control-api:${PIN_TAG}" <<< "$out"; then
    pass "pull-images.sh records ghcr and --verify-only verifies ghcr refs off it"
  else
    fail "after a pull, verify did not resolve ghcr mode; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# The build-side writer. The copied PROJECT_DIR has no service source trees, so
# every build_image call skips and only the manifest writer runs -- which is the
# part under test. IMAGE_SOURCE is left at its ghcr default to prove the writer
# records what it DID, not what the env says.
assert_a_full_build_records_local_and_the_verifier_reads_it_back() {
  local d build_rc out rc recorded
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_present_json "$d/present.json" "$(all_local_refs)"
  PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_PRESENT_JSON="$d/present.json" \
  MINIKUBE_PRELOAD_BASE_IMAGES=false \
    bash "$d/repo/scripts/minikube/build-images.sh" --skip-public >"$d/build.out" 2>&1
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    fail "the stubbed full build failed: $(tail -20 "$d/build.out")"; rm -rf "$d"; return 0
  fi
  recorded="$(node -e '
    const j = require("node:fs").readFileSync(process.argv[1], "utf8")
    process.stdout.write(String(JSON.parse(j).imageSource))
  ' "$d/repo/deploy/minikube/.image-manifest.json" 2>&1)"
  out="$(run_verify "$d" "$(all_local_refs)")"; rc=$?
  if [ "$recorded" = "local" ] && [ "$rc" -eq 0 ] && grep -q 'clerum/control-api:test' <<< "$out"; then
    pass "a full build records imageSource=local and --verify-only verifies clerum/* off it"
  else
    fail "expected imageSource=local (got '$recorded') and a local-mode verify (rc=$rc): $out"
  fi
  rm -rf "$d"
}

# A partial build acquires a subset and must NOT redefine the mode:
# `make minikube-setup-e2e` runs two --only builds AFTER the ghcr pull, and
# `make minikube-setup` runs one BEFORE it.
assert_an_only_build_carries_the_recorded_mode_forward() {
  local d build_rc recorded
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
  write_present_json "$d/present.json" "$(all_local_refs)"
  PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" TEST_PRESENT_JSON="$d/present.json" \
  MINIKUBE_PRELOAD_BASE_IMAGES=false \
    bash "$d/repo/scripts/minikube/build-images.sh" --only=workflow-custom-sdk-e2e \
      >"$d/build.out" 2>&1
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    fail "the stubbed --only build failed: $(tail -20 "$d/build.out")"; rm -rf "$d"; return 0
  fi
  recorded="$(node -e '
    const j = require("node:fs").readFileSync(process.argv[1], "utf8")
    process.stdout.write(String(JSON.parse(j).imageSource))
  ' "$d/repo/deploy/minikube/.image-manifest.json" 2>&1)"
  if [ "$recorded" = "ghcr" ]; then
    pass "an --only build preserves the recorded mode instead of claiming the cluster is local"
  else
    fail "an --only build rewrote imageSource to '$recorded'; a ghcr cluster would be verified as local"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# FINDING B -- the E2E-only fixtures
# ---------------------------------------------------------------------------

# The exact reported reproduction: default ghcr setup, SEED_PROFILE=minimal, so
# the daemon has exactly what the puller put there and NEITHER fixture. No pod
# references either fixture, and no pull could supply them (published:false),
# so demanding them is a lying diagnostic.
#
# The daemon fixture is now `all_ghcr_refs` alone. It used to carry
# clerum/doc-generator-mcp:v1 as well, because full-setup.sh built that one
# unpublished image before the pull; nothing builds it on this path any more.
assert_the_default_ghcr_verify_passes_without_the_e2e_fixtures() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
  present="$(all_ghcr_refs)"
  out="$(run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -eq 0 ] \
     && ! grep -q 'workflow-custom-sdk-e2e' <<< "$out" \
     && ! grep -q 'workflow-plugin-sdk-e2e' <<< "$out"; then
    pass "the default ghcr verify set omits the E2E fixtures and passes on exactly what the puller supplied"
  else
    fail "expected a clean ghcr verify with no fixture refs; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# The end-to-end half of the manifest guard, through the REAL script: a cluster
# that correctly never acquired the registry-distributed MCP servers must
# verify CLEAN. If any of the three were still demanded, the daemon fixture
# above (which does not contain them) would make this rc!=0 -- so the run has to
# be green AND silent about all three, in every mode the verifier supports.
#
# rc is checked before the greps: "no mention of airtable" is also true of a
# crashed run that printed nothing.
assert_the_verify_set_never_demands_a_registry_distributed_mcp_server() {
  local d out rc present named mode
  for mode in default e2e local; do
    d="$(mktemp -d)"
    prepare_repo "$d"
    case "$mode" in
      local)
        write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"local","images":{}}'
        present="$(all_local_refs)"
        out="$(run_verify "$d" "$present")"; rc=$?
        ;;
      e2e)
        write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
        present="$(all_ghcr_refs)"$'\n'"clerum/workflow-custom-sdk-e2e:test"$'\n'"clerum/workflow-plugin-sdk-e2e:test"
        out="$(MINIKUBE_SEED_PROFILE=e2e run_verify "$d" "$present")"; rc=$?
        ;;
      *)
        write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
        present="$(all_ghcr_refs)"
        out="$(run_verify "$d" "$present")"; rc=$?
        ;;
    esac
    named="$(grep -E 'airtable-mcp-server|web-search-mcp|doc-generator-mcp' <<< "$out" || true)"
    if [ "$rc" -eq 0 ] && [ -z "$named" ]; then
      pass "the ${mode} verify set demands no registry-distributed MCP server"
    else
      fail "expected a clean ${mode} verify with no MCP-server refs; got rc=$rc named='$named': $out"
    fi
    rm -rf "$d"
  done
}

# The exclusion is an opt-out, not a deletion: after `make minikube-setup-e2e`
# (SEED_PROFILE=e2e) the fixtures ARE part of what the cluster runs, and a
# missing one must still be reported.
assert_the_e2e_seed_profile_puts_the_fixtures_back() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
  present="$(all_ghcr_refs)"
  out="$(MINIKUBE_SEED_PROFILE=e2e run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -q 'MISSING: clerum/workflow-custom-sdk-e2e:test' <<< "$out" \
     && grep -q 'MISSING: clerum/workflow-plugin-sdk-e2e:test' <<< "$out"; then
    pass "MINIKUBE_SEED_PROFILE=e2e restores both fixtures to the ghcr verify set"
  else
    fail "expected both fixtures reported missing under SEED_PROFILE=e2e; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

assert_the_include_flag_puts_the_fixtures_back() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"ghcr","images":{}}'
  present="$(all_ghcr_refs)"
  out="$(run_verify "$d" "$present" --include-e2e-fixtures)"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'MISSING: clerum/workflow-custom-sdk-e2e:test' <<< "$out"; then
    pass "--include-e2e-fixtures restores the fixtures to the ghcr verify set"
  else
    fail "expected --include-e2e-fixtures to demand the fixtures; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# Local mode is NOT exempt: a full local build builds both fixtures, and
# origin/dev verified them. Dropping them there would lose real coverage.
assert_local_mode_still_demands_the_e2e_fixtures() {
  local d out rc present
  d="$(mktemp -d)"
  prepare_repo "$d"
  write_recorded_manifest "$d" '{"generated":"x","profile":"clerum-test","imageSource":"local","images":{}}'
  present="$(all_local_refs | grep -v 'sdk-e2e')"
  out="$(run_verify "$d" "$present")"; rc=$?
  if [ "$rc" -ne 0 ] \
     && grep -q 'MISSING: clerum/workflow-custom-sdk-e2e:test' <<< "$out" \
     && grep -q 'MISSING: clerum/workflow-plugin-sdk-e2e:test' <<< "$out"; then
    pass "local mode still verifies both E2E fixtures"
  else
    fail "expected local mode to report both fixtures missing; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------

# The verify set has to come from deploy/images.json through the one reader, not
# from a list hand-copied into the script. Adding a row to the copied manifest
# must change what the script demands; a hardcoded list would ignore it.
assert_the_verify_set_is_read_from_the_manifest_not_hardcoded() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  node -e '
    const fs = require("node:fs")
    const p = process.argv[1]
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    j.images.push({
      name: "synthetic-verify-probe",
      path: "tests/fixtures/synthetic",
      published: false,
      deployed_to_minikube: true,
    })
    fs.writeFileSync(p, JSON.stringify(j, null, 2))
  ' "$d/repo/deploy/images.json"
  # The daemon does NOT hold the probe, so a manifest-driven verify must fail
  # naming it. Present-but-ignored would be indistinguishable from a hardcoded
  # list.
  out="$(IMAGE_SOURCE=local run_verify "$d" "$(all_local_refs)")"; rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'MISSING: clerum/synthetic-verify-probe:test' <<< "$out"; then
    pass "a row added to deploy/images.json changes what --verify-only demands"
  else
    fail "the verify set ignored a new manifest row; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# An empty verify set would make every case above pass vacuously.
assert_an_empty_verify_set_is_a_failure_not_a_pass() {
  local d out rc
  d="$(mktemp -d)"
  prepare_repo "$d"
  printf '{"images":[]}' > "$d/repo/deploy/images.json"
  out="$(IMAGE_SOURCE=local run_verify "$d" "clerum/control-api:test")"; rc=$?
  if [ "$rc" -ne 0 ] && grep -qi 'zero images to verify' <<< "$out"; then
    pass "an empty verify set fails loudly instead of reporting success"
  else
    fail "expected a hard failure on an empty verify set; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-minikube-verify-images.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_a_recorded_local_build_is_verified_locally_despite_the_ghcr_default
assert_a_recorded_ghcr_pull_is_verified_against_ghcr_despite_a_local_env
assert_the_env_is_the_fallback_when_no_manifest_exists
assert_a_manifest_with_no_usable_mode_falls_back_to_the_env
assert_a_local_cluster_is_never_told_to_pull
assert_a_pulled_cluster_is_told_to_pull_at_the_named_tag
assert_the_puller_records_ghcr_and_the_verifier_reads_it_back
assert_a_full_build_records_local_and_the_verifier_reads_it_back
assert_an_only_build_carries_the_recorded_mode_forward
assert_the_default_ghcr_verify_passes_without_the_e2e_fixtures
assert_the_verify_set_never_demands_a_registry_distributed_mcp_server
assert_the_e2e_seed_profile_puts_the_fixtures_back
assert_the_include_flag_puts_the_fixtures_back
assert_local_mode_still_demands_the_e2e_fixtures
assert_the_verify_set_is_read_from_the_manifest_not_hardcoded
assert_an_empty_verify_set_is_a_failure_not_a_pass
assert_every_defined_case_is_invoked

exit $FAIL
