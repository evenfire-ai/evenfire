#!/usr/bin/env bash
# Hermetic residue, phase, and manifest-integrity checks for the optional
# image-capability fixture. No cluster, container, Docker, or Minikube call is
# made; the temporary fixture repository proves the host checkout is untouched.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$ROOT/scripts/tests/lib/minikube-fixture-repo.sh"
tmp="$(mktemp -d)"
cleanup() {
  local status=$?
  minikube_test_assert_host_unchanged || status=1
  rm -rf "$tmp"
  exit "$status"
}
minikube_test_fixture_repo_init "$ROOT" "$tmp"
trap cleanup EXIT
export T2_PROJECT_DIR="$MINIKUBE_TEST_PROJECT_DIR"
export T2_BRANCH="$MINIKUBE_TEST_BRANCH" T2_HEAD="$MINIKUBE_TEST_HEAD"
export T2_WORKTREE_ID="$MINIKUBE_TEST_WORKTREE_ID"
export T2_PROFILE=fake T2_CONTEXT=fake T2_LOCK_ROOT="$tmp/locks"

# t2-common.sh resolves T2_IMAGE_MANIFEST from T2_PROJECT_DIR when it loads, so
# the default manifest lives in the fixture repository. The custom override
# below has to win over that default.
source "$ROOT/scripts/minikube/t2-common.sh"
DEFAULT_MANIFEST="$T2_IMAGE_MANIFEST"
CUSTOM_MANIFEST="$tmp/custom-image-manifest.json"
mkdir -p "$(dirname -- "$DEFAULT_MANIFEST")"
T2_PLAN_MODE=false
T2_BOOTSTRAP_REQUIRED=false
t2_fail() { printf '%s: %s\n' "$1" "$2" >&2; return 1; }

MANIFEST_ACQUIRED='{"generated":"fixture","imageSource":"local","imageTag":"","images":{"clerum/image-capabilities-mcp-host:test":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}'
MANIFEST_EMPTY='{"generated":"fixture","imageSource":"local","imageTag":"","images":{}}'
CONFIG_CLEAN='{"data":{},"metadata":{}}'
DEPLOYMENTS_CLEAN='{"items":[{"metadata":{},"spec":{"template":{"spec":{"containers":[{"image":"clerum/mcp-host:test","env":[]}]}}}}]}'
DEPLOYMENT_ANNOTATION='{"items":[{"metadata":{"annotations":{"evenfire.ai/image-capabilities-run":"1"}},"spec":{"template":{"spec":{"containers":[{"image":"clerum/mcp-host:test","env":[]}]}}}}]}'
DEPLOYMENT_IMAGE='{"items":[{"metadata":{},"spec":{"template":{"spec":{"containers":[{"image":"clerum/image-capabilities-mcp-host:test","env":[]}]}}}}]}'
DEPLOYMENT_ENV='{"items":[{"metadata":{},"spec":{"template":{"spec":{"containers":[{"image":"clerum/mcp-host:test","env":[{"name":"IMAGE_CAPABILITIES_FIXTURE_IMAGE","value":"clerum/image-capabilities-mcp-host:test"}]}]}}}}]}'
RUNTIME_CLEAN=true
PREFLIGHT_CALLS="$tmp/cluster-calls"
: >"$PREFLIGHT_CALLS"

# Every cluster interaction is replaced; an unexpected command is a test bug.
# The caller observes commands through command substitution, so the log is a
# file: a subshell cannot update a counter variable.
t2_kc() {
  printf '%s\n' "$*" >>"$PREFLIGHT_CALLS"
  case "$*" in
    '-n mcp-host get configmap mcp-host-config -o json')
      [ "$HOST_UNREADY" != true ] || return 1
      printf '%s' "$CONFIG"
      ;;
    '-n mcp-host exec deployment/chatllm -- node -e '*)
      [ "$HOST_UNREADY" != true ] || return 1
      printf '%s' "$RUNTIME"
      ;;
    *)
      printf 'unexpected cluster command: %s\n' "$*" >&2
      return 99
      ;;
  esac
}

CONFIG="$CONFIG_CLEAN"
DEPLOYMENTS="$DEPLOYMENTS_CLEAN"
RUNTIME="$RUNTIME_CLEAN"
HOST_UNREADY=false

reset_case() {
  : >"$PREFLIGHT_CALLS"
  CONFIG="$CONFIG_CLEAN"
  DEPLOYMENTS="$DEPLOYMENTS_CLEAN"
  RUNTIME="$RUNTIME_CLEAN"
  HOST_UNREADY=false
  T2_PLAN_MODE=false
  T2_BOOTSTRAP_REQUIRED=false
  T2_IMAGE_MANIFEST="$DEFAULT_MANIFEST"
  printf '%s' "$MANIFEST_ACQUIRED" >"$DEFAULT_MANIFEST"
}

expect_pass() {
  local label="$1"
  if ! t2_image_capability_fixture_check "$DEPLOYMENTS" >"$tmp/out" 2>&1; then
    printf 'FAIL: %s did not pass\n' "$label" >&2
    cat "$tmp/out" >&2
    exit 1
  fi
}

expect_fail() {
  local label="$1" expected="$2"
  if t2_image_capability_fixture_check "$DEPLOYMENTS" >"$tmp/out" 2>&1; then
    printf 'FAIL: %s unexpectedly passed\n' "$label" >&2
    exit 1
  fi
  grep -Fq -- "$expected" "$tmp/out" || {
    printf '%s\n' "$(cat "$tmp/out")" >&2
    printf 'FAIL: %s did not report %s\n' "$label" "$expected" >&2
    exit 1
  }
}

expect_no_traceback() {
  local label="$1"
  if grep -Fq 'Traceback (most recent call last)' "$tmp/out"; then
    cat "$tmp/out" >&2
    printf 'FAIL: %s leaked a Python traceback\n' "$label" >&2
    exit 1
  fi
}

expect_cluster_calls() {
  local label="$1" expected="$2" actual
  actual="$(awk 'END { print NR + 0 }' "$PREFLIGHT_CALLS")"
  if [ "$actual" -ne "$expected" ]; then
    printf 'FAIL: %s made %s cluster calls, expected %s\n' "$label" "$actual" "$expected" >&2
    exit 1
  fi
}

expect_probe() {
  local label="$1"
  if [ "$(awk 'END { print NR + 0 }' "$PREFLIGHT_CALLS")" -le 0 ]; then
    printf 'FAIL: %s skipped the cluster probe\n' "$label" >&2
    exit 1
  fi
}

# The strict final preflight probes the certified Host and passes when clean.
reset_case
expect_pass 'strict clean'
expect_probe 'strict clean'

# Runs without the opt-in image keep the probe set unchanged.
reset_case
printf '%s' "$MANIFEST_EMPTY" >"$DEFAULT_MANIFEST"
expect_pass 'not acquired'
expect_cluster_calls 'not acquired' 0

# Residue in configuration, deployments, or the running Host must fail.
reset_case
CONFIG='{"data":{"IMAGE_CAPABILITIES_RUN_ID":"image-capabilities-123456abcdef"},"metadata":{}}'
expect_fail 'configmap residue' HOST_RUNTIME_MISMATCH
reset_case
CONFIG='{"data":{"NODE_ENV":"test"},"metadata":{}}'
expect_fail 'configmap test environment' HOST_RUNTIME_MISMATCH
reset_case
CONFIG='{"data":{},"metadata":{"annotations":{"evenfire.ai/image-capabilities-run":"1"}}}'
expect_fail 'configmap annotation' HOST_RUNTIME_MISMATCH
reset_case
DEPLOYMENTS="$DEPLOYMENT_ANNOTATION"
expect_fail 'deployment annotation' HOST_RUNTIME_MISMATCH
reset_case
DEPLOYMENTS="$DEPLOYMENT_IMAGE"
expect_fail 'fixture image in deployment' HOST_RUNTIME_MISMATCH
reset_case
DEPLOYMENTS="$DEPLOYMENT_ENV"
expect_fail 'fixture value in deployment environment' HOST_RUNTIME_MISMATCH
reset_case
RUNTIME=false
expect_fail 'runtime residue' HOST_RUNTIME_MISMATCH

# Malformed input is a crash, reported as one, never read as residue.
reset_case
DEPLOYMENTS='{"items":'
expect_fail 'malformed deployments' 'image capability residue check crashed: '
expect_fail 'malformed deployments' 'JSONDecodeError'
expect_no_traceback 'malformed deployments'
if grep -Fq 'configuration remains installed' "$tmp/out"; then
  printf 'FAIL: malformed deployments were reported as residue\n' >&2
  exit 1
fi

# stderr is merged into the verdict. An interpreter warning printed before the
# manifest verdict must fail the strict check, not skip the cluster probe.
reset_case
python3() {
  printf 'DeprecationWarning: interpreter notice\n' >&2
  command python3 "$@"
}
expect_fail 'interpreter warning before the manifest verdict' 'unexpected verdict: yes'
expect_cluster_calls 'interpreter warning before the manifest verdict' 0
unset -f python3

# Planning and bootstrap never certify the live Host, so they never probe it.
reset_case
T2_PLAN_MODE=true
T2_BOOTSTRAP_REQUIRED=true
rm -f "$DEFAULT_MANIFEST"
expect_pass 'planner/bootstrap without a manifest'
expect_no_traceback 'planner/bootstrap without a manifest'
expect_cluster_calls 'planner/bootstrap without a manifest' 0

reset_case
T2_PLAN_MODE=true
HOST_UNREADY=true
expect_pass 'planner with an unready Host'
expect_cluster_calls 'planner with an unready Host' 0

reset_case
T2_BOOTSTRAP_REQUIRED=true
HOST_UNREADY=true
expect_pass 'bootstrap with an unready Host'
expect_cluster_calls 'bootstrap with an unready Host' 0

# A custom manifest override is authoritative over the project default.
reset_case
T2_IMAGE_MANIFEST="$CUSTOM_MANIFEST"
printf '%s' "$MANIFEST_EMPTY" >"$DEFAULT_MANIFEST"
printf '%s' "$MANIFEST_ACQUIRED" >"$CUSTOM_MANIFEST"
expect_pass 'custom manifest with the acquired image'
expect_probe 'custom manifest with the acquired image'

reset_case
T2_IMAGE_MANIFEST="$CUSTOM_MANIFEST"
printf '%s' "$MANIFEST_ACQUIRED" >"$DEFAULT_MANIFEST"
printf '%s' "$MANIFEST_EMPTY" >"$CUSTOM_MANIFEST"
expect_pass 'custom manifest without the acquired image'
expect_cluster_calls 'custom manifest without the acquired image' 0

# Manifest integrity is a stable strict failure, never a silent crash.
reset_case
rm -f "$DEFAULT_MANIFEST"
expect_fail 'strict missing manifest' IMAGE_MANIFEST_MISMATCH
expect_no_traceback 'strict missing manifest'

reset_case
printf '%s' '{"images":' >"$DEFAULT_MANIFEST"
expect_fail 'strict corrupt manifest' IMAGE_MANIFEST_MISMATCH
expect_fail 'strict corrupt manifest' 'JSONDecodeError'
expect_no_traceback 'strict corrupt manifest'

reset_case
printf '%s' '{"images":[]}' >"$DEFAULT_MANIFEST"
expect_fail 'strict non-object images' IMAGE_MANIFEST_MISMATCH
expect_no_traceback 'strict non-object images'

# Keep the production preflight integration under regression coverage.
# The contract checks literal shell source, not an expanded value.
# shellcheck disable=SC2016
grep -Fq 't2_image_capability_fixture_check "$T2_DEPLOYMENT_JSON"' "$ROOT/scripts/minikube/t2-preflight.sh"

printf 'PASS: optional image fixture cannot survive a T2 runtime verdict\n'
