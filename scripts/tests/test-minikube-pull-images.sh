#!/usr/bin/env bash
set -u
FAIL=0

# scripts/minikube/pull-images.sh replaces the 20-minute local build on the
# default setup path. Every case runs it against PATH stubs for docker/minikube
# (the same technique as scripts/tests/test-minikube-full-setup.sh) so nothing
# here needs a cluster or a network.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/minikube/pull-images.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# Builds a stub bin dir. `docker` logs every invocation and fails any pull whose
# ref appears in $TEST_MISSING_TAGS, which is how the missing-tag cases work.
make_stubs() {
  local d=$1
  mkdir -p "$d/bin"
  cat > "$d/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "${1:-}" in
  pull)
    for missing in ${TEST_MISSING_TAGS:-}; do
      if [[ "${2:-}" == "$missing" ]]; then
        echo "Error response from daemon: manifest unknown" >&2
        exit 1
      fi
    done
    exit 0
    ;;
  tag) exit 0 ;;
  images) echo "sha256:aaaaaaaaaaaa"; exit 0 ;;
  inspect) echo "sha256:aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
if [[ "$*" == *"docker-env"* ]]; then
  echo 'export DOCKER_HOST="tcp://127.0.0.1:2376"'
  exit 0
fi
exit 0
STUB
  chmod +x "$d/bin/docker" "$d/bin/minikube"
}

# Runs the script in an isolated PROJECT_DIR that is a copy of the real repo's
# deploy/ + scripts/, so it reads the REAL deploy/images.json and the REAL
# component pin rather than a fixture that could drift from them.
run_puller() {
  local d=$1; shift
  make_stubs "$d"
  mkdir -p "$d/repo"
  cp -R "$REPO_ROOT/deploy" "$d/repo/deploy"
  cp -R "$REPO_ROOT/scripts" "$d/repo/scripts"
  PATH="$d/bin:$PATH" \
  TEST_LOG_FILE="$d/ops.log" \
  TEST_MISSING_TAGS="${TEST_MISSING_TAGS:-}" \
    bash "$d/repo/scripts/minikube/pull-images.sh" "$@" 2>&1
}

assert_it_pulls_every_pull_in_ghcr_mode_image() {
  local d out rc want got
  d="$(mktemp -d)"
  out="$(run_puller "$d")"; rc=$?
  want="$(node -e '
    import("'"$REPO_ROOT"'/scripts/release/images-manifest.mjs")
      .then(m => console.log(m.pullInGhcrMode().length))' 2>&1)"
  got="$(grep -c '^pull ghcr\.io/evenfire-ai/' "$d/ops.log" || true)"
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then
    pass "pulled all $want pull_in_ghcr_mode images"
  else
    fail "expected $want pulls, got '$got' (rc=$rc): $out"
  fi
  rm -rf "$d"
}

# The derivation guard at the consumer end. The three published:false images
# have no ghcr counterpart at all; pulling one fails with MANIFEST_UNKNOWN and
# takes the whole default setup down with it.
assert_it_never_pulls_an_unpublished_image() {
  local d out bad
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  bad="$(grep -E '^pull ghcr\.io/evenfire-ai/(workflow-custom-sdk-e2e|workflow-plugin-sdk-e2e|doc-generator-mcp):' "$d/ops.log" || true)"
  if [ -z "$bad" ]; then
    pass "no unpublished image was pulled"
  else
    fail "pulled unpublished image(s): $bad"
  fi
  rm -rf "$d"
}

# The behaviour a "smart" puller would delete. A pre-gate shadow build is
# tagged with the exact ghcr ref, so skipping present tags would keep it alive
# across setups and make gates test undeployed code.
assert_it_repulls_a_tag_already_present_in_the_daemon() {
  local d out pulls
  d="$(mktemp -d)"
  # The docker stub answers `images -q` with a digest for every ref, i.e. every
  # tag reports as already present.
  out="$(run_puller "$d" --only=control-api)"
  pulls="$(grep -c '^pull ghcr\.io/evenfire-ai/control-api:' "$d/ops.log" || true)"
  if [ "$pulls" -ge 1 ]; then
    pass "re-pulls a tag the daemon already reports as present"
  else
    fail "skipped a present tag; a shadow build would survive invisibly: $out"
  fi
  rm -rf "$d"
}

# Six pull_in_ghcr_mode images have no overlay row and are consumed under their
# local clerum/ names by McpServer CRD instances and E2E scripts.
assert_it_aliases_each_image_to_its_local_ref() {
  local d out missing
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  missing=""
  for ref in clerum/airtable-mcp-server:test clerum/web-search-mcp:v1 \
             clerum/mock-mcp-server:test clerum/mock-stdio-mcp-server:test \
             clerum/mcp-host-slim:test clerum/mcp-host-full:test \
             clerum/control-api:test; do
    grep -q "^tag ghcr\.io/evenfire-ai/[a-z0-9.:-]* ${ref}\$" "$d/ops.log" || missing+=" $ref"
  done
  if [ -z "$missing" ]; then
    pass "every pulled image is aliased to its local clerum/ ref"
  else
    fail "missing local aliases:$missing"
  fi
  rm -rf "$d"
}

# web-search-mcp uses local_tag v1, not test. Hardcoding :test here would break
# every McpServer instance that names it.
assert_the_alias_honours_local_tag_and_local_name() {
  local d out
  d="$(mktemp -d)"
  out="$(run_puller "$d" --only=web-search-mcp)"
  if grep -q '^tag ghcr\.io/evenfire-ai/web-search-mcp:[^ ]* clerum/web-search-mcp:v1$' "$d/ops.log"; then
    pass "the alias uses localRef(), honouring local_tag"
  else
    fail "web-search-mcp was not aliased to clerum/web-search-mcp:v1: $out"
  fi
  rm -rf "$d"
}

# The promotion-to-tag window is inherent to pinning in the tree (a fresh clone
# of main can pin a tag that is not promoted yet). A raw MANIFEST_UNKNOWN gives
# a new contributor nothing to act on.
assert_a_missing_tag_names_the_tag_and_the_override() {
  local d out rc
  d="$(mktemp -d)"
  # `A=1 out="$(cmd)"` does NOT put A in cmd's environment: every assignment's
  # value is expanded BEFORE any of them takes effect. Export it instead.
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/control-api:v0.6.0"
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_MISSING_TAGS
  if [ "$rc" -ne 0 ] \
     && grep -q "v0.6.0" <<< "$out" \
     && grep -q "MINIKUBE_IMAGE_TAG" <<< "$out" \
     && grep -q "control-api" <<< "$out"; then
    pass "a missing tag fails naming the image, the tag, and MINIKUBE_IMAGE_TAG"
  else
    fail "expected a named failure mentioning control-api, v0.6.0 and MINIKUBE_IMAGE_TAG; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

assert_minikube_image_tag_overrides_the_pin() {
  local d out
  d="$(mktemp -d)"
  out="$(MINIKUBE_IMAGE_TAG=latest run_puller "$d" --only=control-api)"
  if grep -q '^pull ghcr\.io/evenfire-ai/control-api:latest$' "$d/ops.log"; then
    pass "MINIKUBE_IMAGE_TAG overrides the committed pin"
  else
    fail "MINIKUBE_IMAGE_TAG=latest did not reach the pull: $out"
  fi
  rm -rf "$d"
}

# full-setup.sh:608 uses this file as a `find -newer` marker and warns loudly
# when it is absent. Writing it is what keeps the ghcr path from looking like
# "images were never built".
assert_it_writes_the_image_manifest_consumers_read() {
  local d out
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  local f="$d/repo/deploy/minikube/.image-manifest.json"
  if [ ! -f "$f" ]; then
    fail "no .image-manifest.json written: $out"; rm -rf "$d"; return 0
  fi
  local bad
  bad="$(node -e '
    const fs = require("node:fs")
    let j
    try { j = JSON.parse(fs.readFileSync("'"$f"'", "utf8")) }
    catch (e) { console.log(`PARSE_ERROR: ${e.message}`); process.exit(1) }
    const problems = []
    if (typeof j.generated !== "string" || !j.generated) problems.push("generated")
    if (typeof j.profile !== "string" || !j.profile) problems.push("profile")
    if (!j.images || typeof j.images !== "object") problems.push("images")
    else {
      const keys = Object.keys(j.images)
      if (!keys.some(k => k.startsWith("ghcr.io/evenfire-ai/"))) problems.push("no ghcr keys")
      if (!keys.some(k => k.startsWith("clerum/"))) problems.push("no local alias keys")
    }
    console.log(problems.join(","))
  ' 2>&1)"
  if [ -z "$bad" ]; then
    pass "the image manifest has the shape full-setup.sh consumes, with both key forms"
  else
    fail "image manifest shape problems: $bad"
  fi
  rm -rf "$d"
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-minikube-pull-images.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_it_pulls_every_pull_in_ghcr_mode_image
assert_it_never_pulls_an_unpublished_image
assert_it_repulls_a_tag_already_present_in_the_daemon
assert_it_aliases_each_image_to_its_local_ref
assert_the_alias_honours_local_tag_and_local_name
assert_a_missing_tag_names_the_tag_and_the_override
assert_minikube_image_tag_overrides_the_pin
assert_it_writes_the_image_manifest_consumers_read
assert_every_defined_case_is_invoked

exit $FAIL
