#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/tests/lib/minikube-fixture-repo.sh
source "${REPO_ROOT}/scripts/tests/lib/minikube-fixture-repo.sh"

FIXTURE_ROOT="$(mktemp -d)"
cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "${MINIKUBE_TEST_HOST_STATUS_HASH:-}" ]; then
    minikube_test_assert_host_unchanged || status=1
  fi
  rm -rf -- "$FIXTURE_ROOT"
  exit "$status"
}
trap cleanup EXIT
MINIKUBE_TEST_PROFILE=registry-optin-fixture
MINIKUBE_TEST_CONTEXT=registry-optin-fixture
minikube_test_fixture_repo_init "$REPO_ROOT" "$FIXTURE_ROOT"

SECTIONS_DIR="$FIXTURE_ROOT/sections"
mkdir -p "$SECTIONS_DIR"
# Extract and execute the actual bootstrap decisions. Exact boundaries fail
# loudly if the production layout changes; no default block or copied logic is used.
python3 - "$REPO_ROOT/scripts/minikube/full-setup.sh" "$SECTIONS_DIR" <<'PY_SECTIONS'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
output = Path(sys.argv[2])

def unique(marker):
    if source.count(marker) != 1:
        raise RuntimeError(f"Expected one source boundary: {marker.strip()}")
    return source.index(marker)

def section(name, begin, end):
    start = unique(begin)
    tail = source[start:]
    if tail.count(end) != 1:
        raise RuntimeError(f"Expected one ending boundary for {name}")
    stop = start + tail.index(end)
    if stop <= start:
        raise RuntimeError(f"Empty live source section: {name}")
    output.joinpath(name + ".sh").write_text(source[start:stop], encoding="utf-8")
    return start

flag = section(
    "flag",
    'MINIKUBE_DEPLOY_EVENFIRE_REGISTRY="${MINIKUBE_DEPLOY_EVENFIRE_REGISTRY:-false}"\n',
    'SEED_PROFILE="${MINIKUBE_SEED_PROFILE:-minimal}"\n',
)
preflight = section(
    "preflight",
    '# Resolve an explicitly requested local Registry before any cluster operation.\n',
    '# MINIKUBE_IMAGE_TAG overrides the committed pin AT RENDER TIME ONLY.\n',
)
deploy = section(
    "deploy",
    'step_header 7 $TOTAL_STEPS "evenfire-registry side-by-side deploy"\n',
    '# member-registration-service was extracted to a sibling repo too. Build +\n',
)
seed = section(
    "seed",
    'step_header 9 $TOTAL_STEPS "Seed Registry Catalog"\n',
    'step_header 10 $TOTAL_STEPS "Seed Test User"\n',
)
summary = section(
    "summary",
    'if [ "${REGISTRY_CATALOG_SEEDED}" = true ]; then\n',
    'echo ""\n',
)
if not flag < preflight < unique("t2_mutation_lock\n") < deploy < seed < summary:
    raise RuntimeError("Registry validation must precede the cluster mutation lease and deployment")
PY_SECTIONS

REGISTRY_FIXTURE="$FIXTURE_ROOT/evenfire-registry"
mkdir -p "$REGISTRY_FIXTURE/deploy/overlays/minikube"
# These empty files only witness bootstrap prerequisites; nothing builds an image.
: > "$REGISTRY_FIXTURE/Dockerfile"
: > "$REGISTRY_FIXTURE/deploy/overlays/minikube/kustomization.yaml"
mkdir -p "$MINIKUBE_TEST_PROJECT_DIR/scripts/minikube"
cat > "$MINIKUBE_TEST_PROJECT_DIR/scripts/minikube/deploy-evenfire-registry.sh" <<'STUB_DEPLOY'
#!/usr/bin/env bash
set -euo pipefail
printf 'DEPLOY:%s:%s\n' "$MINIKUBE_PROFILE" "$EVENFIRE_REGISTRY_DIR" >> "$CALL_LOG"
exit "$REGISTRY_DEPLOY_EXIT"
STUB_DEPLOY

HARNESS="$FIXTURE_ROOT/run-registry-sections.sh"
cat > "$HARNESS" <<'HARNESS_SOURCE'
#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$REGISTRY_PROJECT_DIR"
T2_PROJECT_DIR="$PROJECT_DIR"
PROFILE="$REGISTRY_CONTEXT"
KC="fixture_kubectl --context=$PROFILE"
TOTAL_STEPS=12
GREEN=""
YELLOW=""
NC=""
export EVENFIRE_REGISTRY_DIR="$REGISTRY_CASE_CHECKOUT"
# Valid boundary inputs make an erroneous unconditional deployment reach the
# stub and fail the no-call assertion rather than an unrelated unset-variable error.
EVENFIRE_DIR="$EVENFIRE_REGISTRY_DIR"
REGISTRY_CATALOG_SEEDED=false
CLERUM_REGISTRY_URL=https://registry.evenfire.ai
REGISTRY_CONNECTION_MODE=self-hosted
original_registry_url="$CLERUM_REGISTRY_URL"
original_registry_mode="$REGISTRY_CONNECTION_MODE"
if [ "$REGISTRY_REQUEST" = default ]; then
  unset MINIKUBE_DEPLOY_EVENFIRE_REGISTRY
else
  MINIKUBE_DEPLOY_EVENFIRE_REGISTRY="$REGISTRY_REQUEST"
fi
log() { printf 'LOG:%s\n' "$*"; }
ok() { printf 'OK:%s\n' "$*"; }
warn() { printf 'WARN:%s\n' "$*"; }
err() { printf 'ERROR:%s\n' "$*" >&2; }
step_header() { printf 'STEP:%s\n' "$1" >> "$CALL_LOG"; }
fixture_kubectl() {
  if [ "$*" != "--context=$PROFILE get deployment registry-api -n registry" ]; then
    err "Unexpected fixture Kubernetes command"
    return 97
  fi
  printf 'DEPLOYMENT_QUERY\n' >> "$CALL_LOG"
}
make() {
  if [ "$*" = "-n minikube-seed" ]; then
    printf 'SEED_PROBE:%s\n' "$PWD" >> "$CALL_LOG"
    [ "$REGISTRY_SEED_AVAILABLE" = true ]
  elif [ "$*" = minikube-seed ]; then
    printf 'SEED:%s\n' "$PWD" >> "$CALL_LOG"
    printf 'local seed fixture executed\n'
    return "$REGISTRY_SEED_EXIT"
  else
    err "Unexpected fixture Make target"
    return 98
  fi
}
source "$REGISTRY_SECTIONS_DIR/flag.sh"
source "$REGISTRY_SECTIONS_DIR/preflight.sh"
printf 'CLUSTER_BOUNDARY\n' >> "$CALL_LOG"
source "$REGISTRY_SECTIONS_DIR/deploy.sh"
source "$REGISTRY_SECTIONS_DIR/seed.sh"
printf 'SUMMARY_REACHED\n' >> "$CALL_LOG"
source "$REGISTRY_SECTIONS_DIR/summary.sh"
if [ "$CLERUM_REGISTRY_URL" != "$original_registry_url" ] ||
   [ "$REGISTRY_CONNECTION_MODE" != "$original_registry_mode" ]; then
  err "Bootstrap changed the configured centralized Registry connection"
  exit 99
fi
printf 'CENTRAL_CONFIG_UNCHANGED\n' >> "$CALL_LOG"
HARNESS_SOURCE

CASE_NUMBER=0
CURRENT_TEST=""
fail() { printf 'FAIL: %s: %s\n' "$CURRENT_TEST" "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$CURRENT_TEST"; }
run_case() {
  local request="$1" checkout="$2" deploy_exit="$3" seed_exit="$4" seed_available="$5"
  CASE_NUMBER=$((CASE_NUMBER + 1))
  local case_dir="$FIXTURE_ROOT/case-$CASE_NUMBER"
  mkdir -p "$case_dir"
  LAST_CALLS="$case_dir/calls.txt"
  LAST_OUTPUT="$case_dir/output.txt"
  : > "$LAST_CALLS"
  if CALL_LOG="$LAST_CALLS" REGISTRY_PROJECT_DIR="$MINIKUBE_TEST_PROJECT_DIR" \
     REGISTRY_CONTEXT="$MINIKUBE_TEST_CONTEXT" REGISTRY_SECTIONS_DIR="$SECTIONS_DIR" \
     REGISTRY_CASE_CHECKOUT="$checkout" REGISTRY_REQUEST="$request" \
     REGISTRY_DEPLOY_EXIT="$deploy_exit" REGISTRY_SEED_EXIT="$seed_exit" \
     REGISTRY_SEED_AVAILABLE="$seed_available" bash "$HARNESS" > "$LAST_OUTPUT" 2>&1; then
    LAST_STATUS=0
  else
    LAST_STATUS=$?
  fi
}
assert_status() { [ "$LAST_STATUS" -eq "$1" ] || fail "expected exit $1, got $LAST_STATUS"; }
assert_event() { grep -Eq "^${1}(:|$)" "$LAST_CALLS" || fail "missing live event $1"; }
assert_no_event() {
  if grep -Eq "^${1}(:|$)" "$LAST_CALLS"; then fail "unexpected event $1"; fi
}
assert_output() { grep -Fq -- "$1" "$LAST_OUTPUT" || fail "missing expected output: $1"; }
assert_no_output() {
  if grep -Fq -- "$1" "$LAST_OUTPUT"; then fail "unexpected output: $1"; fi
}
assert_successful_optin() {
  run_case true "$REGISTRY_FIXTURE" 0 0 true
  assert_status 0
  assert_event CLUSTER_BOUNDARY
  grep -Fxq "DEPLOY:$MINIKUBE_TEST_CONTEXT:$REGISTRY_FIXTURE" "$LAST_CALLS" || fail "wrong deployment profile or checkout"
  grep -Fxq "SEED:$REGISTRY_FIXTURE" "$LAST_CALLS" || fail "seed did not execute in the requested sibling"
  assert_event SEED_PROBE
  assert_event SUMMARY_REACHED
  assert_event CENTRAL_CONFIG_UNCHANGED
  assert_output "Registry catalog seeded (MCP servers + recipes)"
  assert_no_output "Local Registry catalog seed not completed"
}

test_default_off() {
  CURRENT_TEST="default-off and explicit false skip local deployment and seed despite sibling presence"
  local request
  for request in default false; do
    run_case "$request" "$REGISTRY_FIXTURE" 0 0 true
    assert_status 0
    assert_event CLUSTER_BOUNDARY
    assert_event STEP
    assert_event SUMMARY_REACHED
    assert_event CENTRAL_CONFIG_UNCHANGED
    assert_no_event DEPLOY
    assert_no_event DEPLOYMENT_QUERY
    assert_no_event SEED_PROBE
    assert_no_event SEED
    assert_output "Local Registry deployment and catalog seed not requested"
    assert_no_output "Registry catalog seeded"
    assert_successful_optin
  done
  pass
}
test_invalid_flag() {
  CURRENT_TEST="invalid Registry opt-in fails before cluster commands"
  local request
  for request in invalid yes 1; do
    run_case "$request" "$REGISTRY_FIXTURE" 0 0 true
    assert_status 1
    assert_output "MINIKUBE_DEPLOY_EVENFIRE_REGISTRY must be true or false"
    [ ! -s "$LAST_CALLS" ] || fail "invalid option reached a bootstrap operation"
    assert_successful_optin
  done
  pass
}
test_missing_repo() {
  CURRENT_TEST="requested missing Registry checkout fails before cluster commands"
  run_case true "$FIXTURE_ROOT/missing-checkout" 0 0 true
  assert_status 1
  assert_output "requires an evenfire-registry checkout with a Dockerfile"
  [ ! -s "$LAST_CALLS" ] || fail "missing checkout reached a bootstrap operation"
  assert_successful_optin
  pass
}
test_explicit_deploy_and_seed() {
  CURRENT_TEST="explicit opt-in deploys the selected sibling and executes its available local seed"
  assert_successful_optin
  pass
}
test_deploy_failure() {
  CURRENT_TEST="requested deployment failure stops seed and setup success"
  run_case true "$REGISTRY_FIXTURE" 7 0 true
  assert_status 7
  assert_event CLUSTER_BOUNDARY
  assert_event DEPLOY
  assert_no_event SEED_PROBE
  assert_no_event SEED
  assert_no_event SUMMARY_REACHED
  assert_no_output "Local evenfire-registry deployed"
  assert_no_output "Registry catalog seeded"
  assert_successful_optin
  pass
}
test_seed_failure() {
  CURRENT_TEST="an available requested local seed failure is not swallowed"
  run_case true "$REGISTRY_FIXTURE" 0 9 true
  assert_status 1
  assert_event DEPLOY
  assert_event SEED_PROBE
  assert_event SEED
  assert_output "The requested local Registry catalog seed failed"
  assert_no_event SUMMARY_REACHED
  assert_no_output "Registry catalog seeded"
  assert_successful_optin
  pass
}
test_unavailable_seed_summary() {
  CURRENT_TEST="unavailable local seed warns and reports an incomplete catalog without a false success"
  run_case true "$REGISTRY_FIXTURE" 0 0 false
  assert_status 0
  assert_event DEPLOY
  assert_event DEPLOYMENT_QUERY
  assert_event SEED_PROBE
  assert_no_event SEED
  assert_event SUMMARY_REACHED
  assert_output "has no 'minikube-seed' target"
  assert_output "Local Registry catalog seed not completed"
  assert_no_output "Registry catalog seeded"
  assert_successful_optin
  pass
}
test_central_config_unchanged() {
  CURRENT_TEST="centralized Registry configuration survives both local deployment choices"
  local config_file="$REPO_ROOT/deploy/overlays/minikube/configmaps/control-api-config.yaml"
  local before after
  before="$(shasum -a 256 "$config_file" | awk '{print $1}')"
  run_case false "$REGISTRY_FIXTURE" 0 0 true
  assert_status 0
  assert_event SUMMARY_REACHED
  assert_event CENTRAL_CONFIG_UNCHANGED
  assert_no_event DEPLOY
  assert_successful_optin
  after="$(shasum -a 256 "$config_file" | awk '{print $1}')"
  [ "$before" = "$after" ] || fail "centralized Registry ConfigMap changed"
  pass
}

test_default_off
test_invalid_flag
test_missing_repo
test_explicit_deploy_and_seed
test_deploy_failure
test_seed_failure
test_unavailable_seed_summary
test_central_config_unchanged
