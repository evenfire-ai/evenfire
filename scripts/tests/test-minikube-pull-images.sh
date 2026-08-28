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
# A TEST_MISSING_TAGS failure is verbose on purpose -- 20 lines of fake
# layer-progress noise followed by a distinguishing marker line -- so tests can
# assert the real diagnostic is surfaced (not dropped) *and* trimmed (not
# dumped in full). $TEST_FLAKY_TAGS is separate: refs listed there fail the
# first $TEST_FLAKY_FAIL_COUNT pulls (tracked per-ref in
# $TEST_FLAKY_COUNTER_DIR) and then succeed, which is how the
# retries-then-succeeds cases work.
make_stubs() {
  local d=$1
  mkdir -p "$d/bin"
  cat > "$d/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "${1:-}" in
  pull)
    ref="${2:-}"
    if [ "${TEST_HANG_PULL:-false}" = true ]; then
      while :; do sleep 60; done
    fi
    for missing in ${TEST_MISSING_TAGS:-}; do
      if [[ "$ref" == "$missing" ]]; then
        for i in $(seq 1 20); do
          echo "Downloading layer sha256:deadbeef${i} (${i}/20)" >&2
        done
        echo "Error response from daemon: manifest unknown: TESTMARKER-DIAG-42" >&2
        exit 1
      fi
    done
    for flaky in ${TEST_FLAKY_TAGS:-}; do
      if [[ "$ref" == "$flaky" ]]; then
        counter_file="${TEST_FLAKY_COUNTER_DIR:?}/$(echo "$ref" | tr -c 'a-zA-Z0-9' '_').count"
        count=0
        [ -f "$counter_file" ] && count="$(cat "$counter_file")"
        count=$((count + 1))
        echo "$count" > "$counter_file"
        if [ "$count" -le "${TEST_FLAKY_FAIL_COUNT:-1}" ]; then
          echo "Error response from daemon: transient TLS handshake timeout (attempt ${count})" >&2
          exit 1
        fi
        exit 0
      fi
    done
    exit 0
    ;;
  context)
    if [[ "${2:-}" == inspect ]]; then
      if [[ "$*" == *SkipTLSVerify* ]]; then
        printf 'unix:///tmp/evenfire-docker.sock\tfalse\t{}\n'
      else
        printf 'unix:///tmp/evenfire-docker.sock\n'
      fi
    fi
    exit 0
    ;;
  tag) exit 0 ;;
  images) echo "sha256:aaaaaaaaaaaa"; exit 0 ;;
  inspect)
    if [ "${TEST_INSPECT_FAIL:-false}" = true ]; then
      exit 1
    fi
    if [ "${TEST_INSPECT_HANG:-false}" = true ]; then
      while :; do sleep 60; done
    fi
    if [ "${TEST_INSPECT_EMPTY:-false}" = true ]; then
      exit 0
    fi
    echo "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    exit 0
    ;;
  *) exit 0 ;;
esac
STUB
  cat > "$d/bin/minikube" <<'STUB'
#!/usr/bin/env bash
printf 'minikube %s\n' "$*" >>"${TEST_LOG_FILE:?}"
if [[ "$*" == *"docker-env"* ]]; then
  if [ "${TEST_EMPTY_DOCKER_ENV:-false}" = true ]; then
    exit 0
  fi
  echo 'export DOCKER_HOST="tcp://127.0.0.1:2376"'
  exit 0
fi
if [[ "$*" == *"image load clerum/"* ]] &&
   [ "${TEST_IMAGE_LOAD_ALIAS_FAIL:-false}" = true ]; then
  exit 1
fi
exit 0
STUB
  chmod +x "$d/bin/docker" "$d/bin/minikube"
}

# Copies the real repo's deploy/ + scripts/ into an isolated PROJECT_DIR, so
# every case reads the REAL deploy/images.json and the REAL component pin
# rather than a fixture that could drift from them.
#
# deploy/minikube/.image-manifest.json is REMOVED from the copy unless a case
# asks for one. It is gitignored, so CI never has it and a developer machine
# that has run a real setup always does -- and since the puller now prefers the
# RECORDED tag over the pin, leaving it in would make every pinned-tag case
# here pass or fail depending on whose laptop it ran on.
#
# Usage: copy_repo <dir> [manifest-json]
copy_repo() {
  local d=$1 manifest=${2:-}
  mkdir -p "$d/repo"
  cp -R "$REPO_ROOT/deploy" "$d/repo/deploy"
  cp -R "$REPO_ROOT/scripts" "$d/repo/scripts"
  rm -f "$d/repo/deploy/minikube/.image-manifest.json"
  # The real puller is a mutating child and validates the inherited lease.
  # This fixture is intentionally a no-op child validator; the puller's
  # explicit profile/project/context contract is still exercised below.
  cat > "$d/repo/scripts/minikube/require-t2-mutation-lock.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$d/repo/scripts/minikube/require-t2-mutation-lock.sh"
  if [ -n "$manifest" ]; then
    mkdir -p "$d/repo/deploy/minikube"
    printf '%s' "$manifest" > "$d/repo/deploy/minikube/.image-manifest.json"
  fi
}

# What pull-images.sh and build-images.sh actually write, trimmed to the two
# fields image-mode.sh reads. Usage: recorded_manifest <imageSource> <imageTag>
recorded_manifest() {
  printf '{\n  "generated": "2026-08-06T00:00:00Z",\n  "profile": "clerum-test",\n  "imageSource": "%s",\n  "imageTag": "%s",\n  "images": {}\n}\n' \
    "$1" "$2"
}

run_puller() {
  local d=$1; shift
  make_stubs "$d"
  copy_repo "$d"
  run_puller_prepared "$d" "$@"
}

# The second half of run_puller, for cases that must patch the throwaway tree
# (deploy/images.json) between the copy and the run. Splitting it is what keeps
# the stub/env wiring in ONE place: a copy-pasted invocation would drift from
# run_puller's the first time a variable is added here.
run_puller_prepared() {
  local d=$1; shift
  PATH="$d/bin:$PATH" \
  TEST_LOG_FILE="$d/ops.log" \
  TEST_MISSING_TAGS="${TEST_MISSING_TAGS:-}" \
  TEST_FLAKY_TAGS="${TEST_FLAKY_TAGS:-}" \
  TEST_FLAKY_FAIL_COUNT="${TEST_FLAKY_FAIL_COUNT:-}" \
  TEST_FLAKY_COUNTER_DIR="${TEST_FLAKY_COUNTER_DIR:-}" \
  TEST_EMPTY_DOCKER_ENV="${TEST_EMPTY_DOCKER_ENV:-}" \
  TEST_IMAGE_LOAD_ALIAS_FAIL="${TEST_IMAGE_LOAD_ALIAS_FAIL:-}" \
  TEST_INSPECT_FAIL="${TEST_INSPECT_FAIL:-}" \
  TEST_INSPECT_HANG="${TEST_INSPECT_HANG:-}" \
  TEST_INSPECT_EMPTY="${TEST_INSPECT_EMPTY:-}" \
  MINIKUBE_IMAGE_TAG="${MINIKUBE_IMAGE_TAG:-}" \
  MINIKUBE_IMAGE_PULL_RETRIES="${MINIKUBE_IMAGE_PULL_RETRIES:-}" \
  MINIKUBE_IMAGE_PULL_DELAY_SECS="${MINIKUBE_IMAGE_PULL_DELAY_SECS:-}" \
  MINIKUBE_PULL_PARALLELISM="${MINIKUBE_PULL_PARALLELISM:-}" \
  TEST_HANG_PULL="${TEST_HANG_PULL:-}" \
  MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS:-}" \
  MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS:-}" \
  MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS:-}" \
  T2_PROJECT_DIR="$d/repo" \
  T2_PROFILE=clerum-test T2_CONTEXT=clerum-test \
  MINIKUBE_PROFILE=clerum-test CONTROL_API_REAL_PG_CONTEXT=clerum-test \
  DOCKER_HOST=unix:///tmp/evenfire-docker.sock \
    bash "$d/repo/scripts/minikube/pull-images.sh" "$@" 2>&1
}

run_puller_without_lease() {
  local d=$1; shift
  make_stubs "$d"
  copy_repo "$d"
  env -u T2_PROJECT_DIR -u T2_PROFILE -u T2_CONTEXT \
    -u CONTROL_API_REAL_PG_CONTEXT \
    PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" \
    MINIKUBE_PROFILE=clerum-test DOCKER_HOST=unix:///tmp/evenfire-docker.sock \
    bash "$d/repo/scripts/minikube/pull-images.sh" "$@" 2>&1
}

assert_puller_requires_the_inherited_profile_lease() {
  local d out rc
  d="$(mktemp -d)"
  out="$(run_puller_without_lease "$d" --only=control-api)"; rc=$?
  if [ "$rc" -ne 0 ] && grep -Fq 'PROFILE_LOCK_REQUIRED' <<< "$out" \
     && [ ! -s "$d/ops.log" ]; then
    pass "puller refuses mutation without the inherited profile lease"
  else
    fail "puller did not fail before Docker mutation without its lease: rc=$rc out=$out"
  fi
  rm -rf "$d"
}

assert_hung_pull_hits_the_finite_deadline() {
  local d out rc
  d="$(mktemp -d)"
  export TEST_HANG_PULL=true
  export MINIKUBE_IMAGE_TAG=deadline-test
  export MINIKUBE_IMAGE_PULL_RETRIES=1
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  export MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS=1
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_HANG_PULL MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES \
    MINIKUBE_IMAGE_PULL_DELAY_SECS MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS
  if [ "$rc" -ne 0 ] && grep -Eq 'HARNESS_DEADLINE.*pull-image-control-api.*timeout' <<< "$out"; then
    pass "a hung image pull is terminated by its finite deadline"
  else
    fail "hung pull did not produce the bounded deadline failure: rc=$rc out=$out"
  fi
  rm -rf "$d"
}

assert_empty_docker_env_fails_closed() {
  local d out rc
  d="$(mktemp -d)"
  export TEST_EMPTY_DOCKER_ENV=true
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_EMPTY_DOCKER_ENV
  if [ "$rc" -ne 0 ] \
     && grep -Fq 'DOCKER_ENV_UNRESOLVED' <<<"$out" \
     && ! grep -q '^pull ' "$d/ops.log"; then
    pass "empty successful minikube docker-env output fails closed"
  else
    fail "empty docker-env output returned success or reached Docker: rc=$rc out=$out"
  fi
  rm -rf "$d"
}

assert_multinode_alias_load_failure_fails_closed() {
  local d out rc
  d="$(mktemp -d)"
  export MINIKUBE_MULTI_NODE=true TEST_IMAGE_LOAD_ALIAS_FAIL=true
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset MINIKUBE_MULTI_NODE TEST_IMAGE_LOAD_ALIAS_FAIL
  if [ "$rc" -ne 0 ] &&
     grep -Fq 'alias load to clerum/control-api:test' <<<"$out" &&
     ! grep -Fq 'All published images pulled successfully' <<<"$out"; then
    pass "multi-node alias-load failure prevents a false acquisition success"
  else
    fail "multi-node alias-load failure was hidden: rc=$rc out=$out"
  fi
  rm -rf "$d"
}

assert_invalid_pull_knobs_fail_closed() {
  local d out rc
  d="$(mktemp -d)"

  export MINIKUBE_PULL_PARALLELISM=0
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset MINIKUBE_PULL_PARALLELISM
  if [ "$rc" -ne 2 ] || ! grep -Fq 'MINIKUBE_PULL_PARALLELISM must be an integer' <<<"$out"; then
    fail "parallelism=0 did not fail with the parameter error: rc=$rc out=$out"
    rm -rf "$d"
    return
  fi

  export MINIKUBE_IMAGE_PULL_DELAY_SECS=301
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset MINIKUBE_IMAGE_PULL_DELAY_SECS
  if [ "$rc" -eq 2 ] && grep -Fq 'MINIKUBE_IMAGE_PULL_DELAY_SECS must be an integer' <<<"$out"; then
    pass "parallelism, retry, and delay knobs fail closed outside their finite ranges"
  else
    fail "delay=301 did not fail with the parameter error: rc=$rc out=$out"
  fi
  rm -rf "$d"
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

# The derivation guard at the consumer end. The two published:false images
# have no ghcr counterpart at all; pulling one fails with MANIFEST_UNKNOWN and
# takes the whole default setup down with it.
assert_it_never_pulls_an_unpublished_image() {
  local d out bad
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  bad="$(grep -E '^pull ghcr\.io/evenfire-ai/(workflow-custom-sdk-e2e|workflow-plugin-sdk-e2e):' "$d/ops.log" || true)"
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

# Four pull_in_ghcr_mode images have no overlay row and are consumed under their
# local clerum/ names by McpServer CRD instances and E2E scripts. mock-mcp-server
# is the load-bearing one: the minikube registry catalog seed publishes the
# mcp-airtable entry with imageRef clerum/mock-mcp-server:test, so the registry
# install specs resolve to that alias.
assert_it_aliases_each_image_to_its_local_ref() {
  local d out missing
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  missing=""
  for ref in clerum/mock-mcp-server:test clerum/mock-stdio-mcp-server:test \
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

# The alias must come from localRef(), which honours local_name and local_tag,
# not from a hardcoded `clerum/<name>:test`. Getting this wrong breaks every
# McpServer instance that names the image.
#
# This used to ride on web-search-mcp (local_tag v1). No pull_in_ghcr_mode image
# carries a local_name/local_tag override any more -- the two that did are
# registry-distributed and deployed_to_minikube:false now, and playwright-server
# (local_name) never was in the minikube set. Rather than delete the only
# coverage localRef() has on this path, the row is INJECTED into the throwaway
# manifest: the assertion still runs the real script through the real reader,
# and it now fails for a name override as well as a tag override, which the
# web-search-mcp version never checked.
assert_the_alias_honours_local_tag_and_local_name() {
  local d out
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d"

  # Append a published+deployed row whose local ref differs from its name in
  # BOTH dimensions. node, not sed: the manifest is JSON and a text patch would
  # silently produce something the reader rejects.
  if ! node -e '
    const fs = require("node:fs")
    const p = process.argv[1]
    const m = JSON.parse(fs.readFileSync(p, "utf8"))
    m.images.push({
      name: "alias-probe",
      path: "alias-probe",
      source_paths: ["alias-probe/**"],
      local_name: "renamed-alias-probe",
      local_tag: "v9",
      published: true,
      deployed_to_minikube: true,
    })
    fs.writeFileSync(p, JSON.stringify(m, null, 2))
  ' "$d/repo/deploy/images.json"; then
    fail "could not inject the alias-probe row into the throwaway manifest"
    rm -rf "$d"
    return
  fi

  out="$(run_puller_prepared "$d" --only=alias-probe)"
  if grep -q '^tag ghcr\.io/evenfire-ai/alias-probe:[^ ]* clerum/renamed-alias-probe:v9$' "$d/ops.log"; then
    pass "the alias uses localRef(), honouring local_name and local_tag"
  else
    fail "alias-probe was not aliased to clerum/renamed-alias-probe:v9: $out"
  fi
  rm -rf "$d"
}

# The regression this whole change is about: minikube setup must neither build
# nor PULL the registry-distributed MCP servers. This is the pull half.
#
# Spelled out by name rather than re-derived from pullInGhcrMode(): a test that
# recomputes the production rule passes no matter what the rule says.
assert_it_never_pulls_a_registry_distributed_mcp_server() {
  local d out bad aliased
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  bad="$(grep -E '^pull ghcr\.io/evenfire-ai/(airtable-mcp-server|web-search-mcp):' "$d/ops.log" || true)"
  # The alias is the other half: a `docker tag` onto clerum/airtable-mcp-server
  # would put the image in the daemon under the exact name the old McpServer
  # instance expects, hiding the removal from every consumer.
  aliased="$(grep -E '^tag [^ ]+ clerum/(airtable-mcp-server|web-search-mcp):' "$d/ops.log" || true)"
  if [ -z "$bad" ] && [ -z "$aliased" ]; then
    pass "no registry-distributed MCP server was pulled or aliased"
  else
    fail "registry-distributed MCP server acquired: ${bad}${aliased}"
  fi
  rm -rf "$d"
}

# The promotion-to-tag window is inherent to pinning in the tree (a fresh clone
# of main can pin a tag that is not promoted yet). A raw MANIFEST_UNKNOWN gives
# a new contributor nothing to act on.
assert_a_missing_tag_names_the_tag_and_the_override() {
  local d out rc pin
  d="$(mktemp -d)"
  # The tag has to be the one the puller will actually ask for, which is the
  # committed pin. Hardcoding the release of the day made this assertion pass
  # vacuously the moment the next release was cut: the simulated 404 was for a
  # tag nobody requested, the pull succeeded, and rc=0 failed the assert.
  pin="$(committed_pin)"
  # `A=1 out="$(cmd)"` does NOT put A in cmd's environment: every assignment's
  # value is expanded BEFORE any of them takes effect. Export it instead.
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/control-api:${pin}"
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_MISSING_TAGS
  if [ "$rc" -ne 0 ] \
     && grep -q "$pin" <<< "$out" \
     && grep -q "MINIKUBE_IMAGE_TAG" <<< "$out" \
     && grep -q "control-api" <<< "$out"; then
    pass "a missing tag fails naming the image, the tag, and MINIKUBE_IMAGE_TAG"
  else
    fail "expected a named failure mentioning control-api, ${pin} and MINIKUBE_IMAGE_TAG; got rc=$rc out='$out'"
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

# Manifest publication must be transactional. Mutation coverage: restoring the
# old `|| echo NOT_PULLED` fallback or writing directly to MANIFEST_FILE makes
# this case either return success or destroy the known-good manifest.
assert_manifest_inspect_failure_preserves_previous_manifest() {
  local d out rc before after
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d" "$(recorded_manifest ghcr previous-good-tag)"
  before="$(cat "$d/repo/deploy/minikube/.image-manifest.json")"
  export TEST_INSPECT_FAIL=true MINIKUBE_IMAGE_TAG=inspect-fail-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=1 MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller_prepared "$d" --only=control-api)"; rc=$?
  unset TEST_INSPECT_FAIL MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  after="$(cat "$d/repo/deploy/minikube/.image-manifest.json")"
  if [ "$rc" -ne 0 ] \
     && [ "$after" = "$before" ] \
     && ! grep -Fq 'NOT_PULLED' <<<"$out" \
     && ! grep -Fq 'published image(s) pulled at' <<<"$out"; then
    pass "docker inspect failure preserves the previous manifest and fails closed"
  else
    fail "docker inspect failure published false evidence: rc=$rc unchanged=$([ "$after" = "$before" ] && echo yes || echo no) out=$out"
  fi
  rm -rf "$d"
}

# A deadline is an inspect failure too. Mutation coverage: removing the
# inspect deadline or turning its status into NOT_PULLED makes this case pass
# without the required HARNESS_DEADLINE evidence and manifest preservation.
assert_manifest_inspect_deadline_preserves_previous_manifest() {
  local d out rc before after
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d" "$(recorded_manifest ghcr previous-good-tag)"
  before="$(cat "$d/repo/deploy/minikube/.image-manifest.json")"
  export TEST_INSPECT_HANG=true MINIKUBE_IMAGE_TAG=inspect-hang-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=1 MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  export MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS=1
  out="$(run_puller_prepared "$d" --only=control-api)"; rc=$?
  unset TEST_INSPECT_HANG MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES \
    MINIKUBE_IMAGE_PULL_DELAY_SECS MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS
  after="$(cat "$d/repo/deploy/minikube/.image-manifest.json")"
  if [ "$rc" -ne 0 ] \
     && grep -Eq 'HARNESS_DEADLINE.*inspect-image' <<<"$out" \
     && [ "$after" = "$before" ] \
     && ! grep -Fq 'published image(s) pulled at' <<<"$out"; then
    pass "docker inspect deadline preserves the previous manifest and fails closed"
  else
    fail "docker inspect deadline did not preserve the manifest: rc=$rc unchanged=$([ "$after" = "$before" ] && echo yes || echo no) out=$out"
  fi
  rm -rf "$d"
}

assert_empty_manifest_inspect_output_fails_closed() {
  local d out rc before after
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d" "$(recorded_manifest ghcr previous-good-tag)"
  before="$(cat "$d/repo/deploy/minikube/.image-manifest.json")"
  export TEST_INSPECT_EMPTY=true MINIKUBE_IMAGE_TAG=inspect-empty-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=1 MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller_prepared "$d" --only=control-api)"; rc=$?
  unset TEST_INSPECT_EMPTY MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  after="$(cat "$d/repo/deploy/minikube/.image-manifest.json")"
  if [ "$rc" -ne 0 ] \
     && [ "$after" = "$before" ] \
     && ! grep -Fq 'published image(s) pulled at' <<<"$out"; then
    pass "empty docker inspect output is rejected without changing the manifest"
  else
    fail "empty docker inspect output was accepted: rc=$rc unchanged=$([ "$after" = "$before" ] && echo yes || echo no) out=$out"
  fi
  rm -rf "$d"
}

assert_successful_manifest_contains_valid_digests_and_aliases() {
  local d out rc manifest problems
  d="$(mktemp -d)"
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  manifest="$d/repo/deploy/minikube/.image-manifest.json"
  problems="$(node -e '
    const fs = require("node:fs")
    const path = process.argv[1]
    const j = JSON.parse(fs.readFileSync(path, "utf8"))
    const entries = Object.entries(j.images || {})
    const bad = entries.filter(([, id]) => !/^sha256:[0-9a-f]{64}$/.test(id))
    const keys = entries.map(([ref]) => ref)
    if (bad.length) console.log("invalid image id")
    if (entries.some(([, id]) => id === "NOT_PULLED")) console.log("NOT_PULLED")
    if (!keys.includes("ghcr.io/evenfire-ai/control-api:manifest-success-tag")) console.log("missing ghcr ref")
    if (!keys.includes("clerum/control-api:test")) console.log("missing local alias")
  ' "$manifest" 2>&1)"
  if [ "$rc" -eq 0 ] && [ -z "$problems" ] && [ -f "$manifest" ]; then
    pass "successful manifest publication records valid digests and GHCR/local refs"
  else
    fail "successful manifest publication was invalid: rc=$rc problems=$problems out=$out"
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
    // Not decoration: build-images.sh --verify-only reads imageSource back to
    // decide whether to check ghcr.io/evenfire-ai/* or clerum/* refs. Without
    // it, verify falls back to the IMAGE_SOURCE env default.
    if (j.imageSource !== "ghcr") problems.push(`imageSource=${JSON.stringify(j.imageSource)}`)
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

# ---------------------------------------------------------------------------
# Real minikube run (2026-08-06): ghcr.io/evenfire-ai/nginx-egress-proxy:latest
# failed transiently 24 images into a 25-image pull, aborting the whole setup.
# A manual `docker pull` of the exact ref immediately after succeeded -- the
# image existed, the tag existed, the failure was a one-shot network blip. The
# three cases below cover the fixes: bounded retry, surfaced diagnostics, and
# remediation text that never recommends the tag that just failed.
# ---------------------------------------------------------------------------

# Mutation coverage for this one: bound the retry loop at 1 attempt (`if false
# && ...` around the retry body, or `attempt -le 1`) and this fails both ways
# -- rc becomes nonzero (the flaky ref needed 3 attempts) and pulls drops to 1.
assert_a_transient_pull_failure_is_retried_until_it_succeeds() {
  local d out rc pulls
  d="$(mktemp -d)"
  mkdir -p "$d/flaky-counters"
  export TEST_FLAKY_TAGS="ghcr.io/evenfire-ai/control-api:flaky-test-tag"
  export TEST_FLAKY_FAIL_COUNT=2
  export TEST_FLAKY_COUNTER_DIR="$d/flaky-counters"
  export MINIKUBE_IMAGE_TAG=flaky-test-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=5
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_FLAKY_TAGS TEST_FLAKY_FAIL_COUNT TEST_FLAKY_COUNTER_DIR \
    MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  pulls="$(grep -c '^pull ghcr\.io/evenfire-ai/control-api:flaky-test-tag$' "$d/ops.log" || true)"
  # 2 failures + 1 success = 3 attempts logged, well inside the 5-attempt
  # budget -- proves retry happens AND stops as soon as a pull succeeds
  # (a mutation that always burns the full budget would log 5, not 3).
  if [ "$rc" -eq 0 ] && [ "$pulls" -eq 3 ]; then
    pass "a transient pull failure is retried and the pull eventually succeeds (3 attempts logged)"
  else
    fail "expected rc=0 and exactly 3 logged pull attempts, got rc=$rc pulls=$pulls: $out"
  fi
  rm -rf "$d"
}

# Mutation coverage: an unbounded/ignored retry loop (dropping the `-le`
# comparison, or `if false && attempt=$((attempt + 1))` on the increment)
# either hangs this test or logs more than 3 attempts; a bound stuck at 1
# logs 1 attempt instead of 3. Both are caught by the exact-count assertion.
assert_a_permanently_failing_pull_stops_after_the_retry_bound() {
  local d out rc pulls
  d="$(mktemp -d)"
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/control-api:permafail-test-tag"
  export MINIKUBE_IMAGE_TAG=permafail-test-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=3
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_MISSING_TAGS MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  pulls="$(grep -c '^pull ghcr\.io/evenfire-ai/control-api:permafail-test-tag$' "$d/ops.log" || true)"
  if [ "$rc" -ne 0 ] && [ "$pulls" -eq 3 ]; then
    pass "a permanently failing pull is retried exactly MINIKUBE_IMAGE_PULL_RETRIES times, then reported failed"
  else
    fail "expected rc!=0 and exactly 3 logged pull attempts, got rc=$rc pulls=$pulls: $out"
  fi
  rm -rf "$d"
}

# Mutation coverage: wrap the diagnostic-printing block in `if false && ...`
# (marker_hits drops to 0) or replace `tail -n 5` with `cat` / no trim at all
# (filler_hits jumps from a handful to 20) -- either mutation is caught.
assert_a_pull_failure_surfaces_the_captured_diagnostic_trimmed() {
  local d out marker_hits filler_hits
  d="$(mktemp -d)"
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/control-api:diag-test-tag"
  export MINIKUBE_IMAGE_TAG=diag-test-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=1
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller "$d" --only=control-api)"
  unset TEST_MISSING_TAGS MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  marker_hits="$(grep -c 'TESTMARKER-DIAG-42' <<< "$out" || true)"
  filler_hits="$(grep -c 'Downloading layer' <<< "$out" || true)"
  if [ "$marker_hits" -ge 1 ] && [ "$filler_hits" -ge 1 ] && [ "$filler_hits" -le 5 ]; then
    pass "the real docker diagnostic is surfaced, trimmed rather than dumped in full"
  else
    fail "expected the marker line present and filler trimmed to <=5 lines; got marker_hits=$marker_hits filler_hits=$filler_hits: $out"
  fi
  rm -rf "$d"
}

# The exact bug from the real run: MINIKUBE_IMAGE_TAG=latest failed, and the
# script told the operator to retry with `MINIKUBE_IMAGE_TAG=latest`.
# Mutation coverage: drop the `[ "$IMAGE_TAG" != "latest" ]` guard (or invert
# it to `==`) and the forbidden string reappears in the output.
assert_a_failure_at_the_latest_override_never_suggests_the_tag_that_just_failed() {
  local d out rc
  d="$(mktemp -d)"
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/control-api:latest"
  export MINIKUBE_IMAGE_TAG=latest
  export MINIKUBE_IMAGE_PULL_RETRIES=1
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller "$d" --only=control-api)"; rc=$?
  unset TEST_MISSING_TAGS MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  if [ "$rc" -ne 0 ] \
     && grep -q "came from the MINIKUBE_IMAGE_TAG override" <<< "$out" \
     && ! grep -q "MINIKUBE_IMAGE_TAG=latest" <<< "$out"; then
    pass "a failure at the 'latest' override never advises retrying with the tag that just failed"
  else
    fail "expected rc!=0, the tag-origin line, and no 'MINIKUBE_IMAGE_TAG=latest' suggestion; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# The real-run shape: 24 of 25 images pulled fine at the tag and only one
# failed, which proves the tag exists. Mutation coverage: swap the branch
# condition (`-gt 0` -> `-eq 0`, or `if false && ...` around it) and the
# missing-tag remediation (or its "latest" line) leaks back in even though
# other images plainly succeeded at this exact tag.
assert_a_partial_failure_says_the_tag_exists_and_advises_a_retry() {
  local d out rc
  d="$(mktemp -d)"
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/nginx-egress-proxy:partial-fail-tag"
  export MINIKUBE_IMAGE_TAG=partial-fail-tag
  export MINIKUBE_IMAGE_PULL_RETRIES=1
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller "$d")"; rc=$?
  unset TEST_MISSING_TAGS MINIKUBE_IMAGE_TAG MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  if [ "$rc" -ne 0 ] \
     && grep -qi "pulled fine at" <<< "$out" \
     && ! grep -q "MINIKUBE_IMAGE_TAG=latest" <<< "$out" \
     && ! grep -qi "has not been promoted yet" <<< "$out"; then
    pass "a partial failure says other images pulled fine at the tag and advises a retry, not a missing-tag remediation"
  else
    fail "expected rc!=0, 'pulled fine at' messaging, and no missing-tag remediation; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# WHICH TAG THIS CLUSTER PULLS
# ---------------------------------------------------------------------------
# The puller used to read MINIKUBE_IMAGE_TAG else the committed pin, and never
# the tag the last acquisition RECORDED. On the documented bootstrap
# (`MINIKUBE_IMAGE_TAG=latest make minikube-setup`), a later
# `make minikube-pull-images` therefore went looking for the pinned v0.6.0 --
# which is 404 on ghcr until the tag is cut. That command is the remedy the
# docs and this script's own failure text point people at, so it failed exactly
# when someone followed the advice.

# The committed pin, read from the real tree so this cannot drift the next time
# a release is cut.
committed_pin() {
  sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' \
    "$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml" | sort -u | head -1
}

# Mutation coverage: swap the precedence in image_mode_ghcr_tag so the pin is
# consulted before the recorded value (or turn `[ -n "$recorded" ]` into
# `[ -z "$recorded" ]`) and the pulled ref becomes the pin -- both asserted
# here, in both directions.
assert_the_recorded_tag_beats_the_committed_pin() {
  local d out pin
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d" "$(recorded_manifest ghcr recorded-test-tag)"
  out="$(run_puller_prepared "$d" --only=control-api)"
  pin="$(committed_pin)"
  if grep -q '^pull ghcr\.io/evenfire-ai/control-api:recorded-test-tag$' "$d/ops.log" \
     && ! grep -q "^pull ghcr\.io/evenfire-ai/control-api:${pin}\$" "$d/ops.log"; then
    pass "the tag recorded by the last acquisition beats the committed pin"
  else
    fail "expected a pull at recorded-test-tag and none at the pin '${pin}': $out"
  fi
  rm -rf "$d"
}

# The other half of the precedence: an explicit override still wins over the
# record, so an operator can move a cluster forward off a bad tag. Mutation:
# reorder image_mode_ghcr_tag to consult the record first and this pulls
# recorded-test-tag instead.
assert_minikube_image_tag_beats_the_recorded_tag() {
  local d out
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d" "$(recorded_manifest ghcr recorded-test-tag)"
  export MINIKUBE_IMAGE_TAG=override-test-tag
  out="$(run_puller_prepared "$d" --only=control-api)"
  unset MINIKUBE_IMAGE_TAG
  if grep -q '^pull ghcr\.io/evenfire-ai/control-api:override-test-tag$' "$d/ops.log" \
     && ! grep -q '^pull ghcr\.io/evenfire-ai/control-api:recorded-test-tag$' "$d/ops.log"; then
    pass "MINIKUBE_IMAGE_TAG beats the recorded tag"
  else
    fail "expected a pull at override-test-tag and none at recorded-test-tag: $out"
  fi
  rm -rf "$d"
}

# The floor of the precedence, and the fresh-clone path: with nothing recorded
# the committed pin is what gets pulled. Mutation: drop the pin fallback (or
# return the empty recorded value) and the pull ref loses its tag entirely.
assert_the_committed_pin_is_used_when_nothing_is_recorded() {
  local d out pin
  d="$(mktemp -d)"
  pin="$(committed_pin)"
  if [ -z "$pin" ]; then
    fail "could not read the committed pin from the real component"
    rm -rf "$d"
    return
  fi
  out="$(run_puller "$d" --only=control-api)"
  if grep -q "^pull ghcr\.io/evenfire-ai/control-api:${pin}\$" "$d/ops.log"; then
    pass "with nothing recorded, the committed pin (${pin}) is what gets pulled"
  else
    fail "expected a pull at the committed pin '${pin}': $out"
  fi
  rm -rf "$d"
}

# Pulling IS a ghcr acquisition -- this script rewrites the manifest with
# imageSource "ghcr" when it finishes -- so a cluster whose CURRENT record says
# "local" must still resolve a tag. Routing this through image_mode_tag (which
# gates on the recorded mode and returns empty for "local") instead of
# image_mode_ghcr_tag makes `make minikube-pull-images` fail on exactly the
# cluster an operator is trying to switch over to published images.
#
# Mutation: call image_mode_tag here instead and the run exits non-zero having
# pulled nothing.
assert_a_locally_built_cluster_still_resolves_a_tag_to_pull() {
  local d out rc pin
  d="$(mktemp -d)"
  make_stubs "$d"
  # What a full local build writes: mode local, and the ghcr coordinate cleared.
  copy_repo "$d" "$(recorded_manifest local "")"
  out="$(run_puller_prepared "$d" --only=control-api)"; rc=$?
  pin="$(committed_pin)"
  if [ "$rc" -eq 0 ] && grep -q "^pull ghcr\.io/evenfire-ai/control-api:${pin}\$" "$d/ops.log"; then
    pass "a cluster recorded as locally built still pulls, at the committed pin"
  else
    fail "expected rc=0 and a pull at '${pin}' on a local-recorded cluster; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# An error that names the committed pin when the tag actually came from the
# manifest sends the operator to edit a file that has no effect on the run.
# Mutation: hardcode the pin wording in image_mode_tag_origin and the manifest
# filename disappears from the failure text.
assert_a_failure_names_the_manifest_when_the_tag_came_from_the_record() {
  local d out rc
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d" "$(recorded_manifest ghcr recorded-test-tag)"
  export TEST_MISSING_TAGS="ghcr.io/evenfire-ai/control-api:recorded-test-tag"
  export MINIKUBE_IMAGE_PULL_RETRIES=1
  export MINIKUBE_IMAGE_PULL_DELAY_SECS=0
  out="$(run_puller_prepared "$d" --only=control-api)"; rc=$?
  unset TEST_MISSING_TAGS MINIKUBE_IMAGE_PULL_RETRIES MINIKUBE_IMAGE_PULL_DELAY_SECS
  if [ "$rc" -ne 0 ] \
     && grep -q "came from the tag recorded in deploy/minikube/.image-manifest.json" <<< "$out" \
     && ! grep -q "came from the committed pin" <<< "$out"; then
    pass "a failure at a recorded tag names the manifest, not the committed pin"
  else
    fail "expected the failure to name the recorded manifest as the tag origin; got rc=$rc: $out"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# --skip-uis
# ---------------------------------------------------------------------------
# The -no-uis-ghcr overlay DELETES the control-ui and profile-ui Deployments,
# so pulling them spends ~470 MiB of transfer and disk on images no pod will
# ever reference.

# Mutation: `if false && [ "$SKIP_UIS" = true ]` around the filter, or `!=`
# for `=`, and the two UI pulls reappear. The control-api half is what stops a
# filter that drops everything from passing.
assert_skip_uis_drops_the_ui_images_from_the_pull() {
  local d out uis backend
  d="$(mktemp -d)"
  out="$(run_puller "$d" --skip-uis)"
  uis="$(grep -cE '^pull ghcr\.io/evenfire-ai/(control-ui|profile-ui):' "$d/ops.log" || true)"
  backend="$(grep -cE '^pull ghcr\.io/evenfire-ai/control-api:' "$d/ops.log" || true)"
  if [ "$uis" -eq 0 ] && [ "$backend" -ge 1 ]; then
    pass "--skip-uis pulls neither control-ui nor profile-ui, and still pulls the backend images"
  else
    fail "expected 0 UI pulls and >=1 control-api pull, got uis=$uis backend=$backend: $out"
  fi
  rm -rf "$d"
}

# The complement, so the filter cannot be "never pull the UIs".
assert_the_uis_are_pulled_when_skip_uis_is_not_set() {
  local d out uis
  d="$(mktemp -d)"
  out="$(run_puller "$d")"
  uis="$(grep -cE '^pull ghcr\.io/evenfire-ai/(control-ui|profile-ui):' "$d/ops.log" || true)"
  if [ "$uis" -eq 2 ]; then
    pass "without --skip-uis both UI images are pulled"
  else
    fail "expected 2 UI pulls on the default path, got $uis: $out"
  fi
  rm -rf "$d"
}

# The env spelling full-setup.sh and build-images.sh already share. Mutation:
# drop MINIKUBE_SKIP_UIS from the SKIP_UIS default and this pulls the UIs.
assert_minikube_skip_uis_env_is_honoured() {
  local d out uis
  d="$(mktemp -d)"
  make_stubs "$d"
  copy_repo "$d"
  export MINIKUBE_SKIP_UIS=true
  out="$(run_puller_prepared "$d")"
  unset MINIKUBE_SKIP_UIS
  uis="$(grep -cE '^pull ghcr\.io/evenfire-ai/(control-ui|profile-ui):' "$d/ops.log" || true)"
  if [ "$uis" -eq 0 ]; then
    pass "MINIKUBE_SKIP_UIS=true drops the UI images without the flag"
  else
    fail "expected 0 UI pulls under MINIKUBE_SKIP_UIS=true, got $uis: $out"
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
assert_puller_requires_the_inherited_profile_lease
assert_hung_pull_hits_the_finite_deadline
assert_empty_docker_env_fails_closed
assert_multinode_alias_load_failure_fails_closed
assert_invalid_pull_knobs_fail_closed
assert_it_never_pulls_an_unpublished_image
assert_it_never_pulls_a_registry_distributed_mcp_server
assert_it_repulls_a_tag_already_present_in_the_daemon
assert_it_aliases_each_image_to_its_local_ref
assert_the_alias_honours_local_tag_and_local_name
assert_a_missing_tag_names_the_tag_and_the_override
assert_minikube_image_tag_overrides_the_pin
assert_manifest_inspect_failure_preserves_previous_manifest
assert_manifest_inspect_deadline_preserves_previous_manifest
assert_empty_manifest_inspect_output_fails_closed
export MINIKUBE_IMAGE_TAG=manifest-success-tag
assert_successful_manifest_contains_valid_digests_and_aliases
unset MINIKUBE_IMAGE_TAG
assert_it_writes_the_image_manifest_consumers_read
assert_a_transient_pull_failure_is_retried_until_it_succeeds
assert_a_permanently_failing_pull_stops_after_the_retry_bound
assert_a_pull_failure_surfaces_the_captured_diagnostic_trimmed
assert_a_failure_at_the_latest_override_never_suggests_the_tag_that_just_failed
assert_a_partial_failure_says_the_tag_exists_and_advises_a_retry
assert_the_recorded_tag_beats_the_committed_pin
assert_minikube_image_tag_beats_the_recorded_tag
assert_the_committed_pin_is_used_when_nothing_is_recorded
assert_a_locally_built_cluster_still_resolves_a_tag_to_pull
assert_a_failure_names_the_manifest_when_the_tag_came_from_the_record
assert_skip_uis_drops_the_ui_images_from_the_pull
assert_the_uis_are_pulled_when_skip_uis_is_not_set
assert_minikube_skip_uis_env_is_honoured
assert_every_defined_case_is_invoked

exit $FAIL
