#!/usr/bin/env bash
# Hermetic certifying-preflight and inherited-journey lease regressions.
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
source "$ROOT/scripts/minikube/t2-common.sh"
T2_IMAGE_MANIFEST="$tmp/manifest.json"
T2_CONTROL_NAMESPACE=control-plane
T2_REQUIRED_DEPLOYMENTS=control-plane/codex-llm-proxy
T2_PLAN_MODE=false
T2_BOOTSTRAP_REQUIRED=false
t2_fail() { printf '%s: %s\n' "$1" "$2" >&2; return 1; }
# Every runtime entry point is replaced; no cluster or container is contacted.
t2_kc() {
  case "$*" in
    'get deployments -A -o json') cat "$tmp/deployments.json" ;;
    '-n control-plane get pods -l app=codex-llm-proxy -o json') cat "$tmp/pods.json" ;;
    '-n control-plane exec proxy-1 -c codex-llm-proxy -- node -e '*) printf '%s' "$runtime_environment" ;;
    *) printf 'unexpected cluster command\n' >&2; return 1 ;;
  esac
}
t2_mk() {
  [ "$*" = 'image ls --format=json' ] || return 1
  cat "$tmp/inventory.json"
}
make_case() {
  runtime_environment=true
  python3 - "$tmp" "$1" <<'PY'
import copy, json, sys
from pathlib import Path
root, case = Path(sys.argv[1]), sys.argv[2]
base, other = 'sha256:' + 'a'*64, 'sha256:' + 'b'*64
ref = 'clerum/codex-llm-proxy:test'
digest_ref = 'ghcr.io/evenfire-ai/codex-llm-proxy@sha256:' + 'c'*64
manifest = {'profile': 'fake', 'images': {ref: base}}
container = {'name': 'codex-llm-proxy', 'image': ref, 'env': []}
template = {'metadata': {}, 'spec': {'containers': [container]}}
deployment = {'metadata': {'name': 'codex-llm-proxy', 'namespace': 'control-plane', 'generation': 1},
              'spec': {'replicas': 1, 'template': template},
              'status': {'observedGeneration': 1, 'updatedReplicas': 1, 'readyReplicas': 1, 'availableReplicas': 1}}
pod = copy.deepcopy(template)
pod['metadata'] = {'name': 'proxy-1', 'namespace': 'control-plane'}
status = {'name': 'codex-llm-proxy', 'imageID': 'docker://' + base, 'ready': True, 'state': {'running': {'startedAt': '2026-01-01'}}}
pod['status'] = {'containerStatuses': [status]}
inventory = [{'id': base[7:], 'repoTags': ['docker.io/' + ref], 'repoDigests': [digest_ref]}]
if case == 'fixture-image':
    container['image'] = 'clerum/codex-approved-tools-proxy-e2e:test'
    manifest['images'][container['image']] = other
if case == 'fixture-env': container['env'] = [{'name': 'CODEX_APPROVED_TOOLS_TEST_ONLY', 'value': '1'}]
if case == 'fixture-marker': template['metadata']['annotations'] = {'evenfire.ai/codex-tools-fixture-run': 'approved-tools-aabbccddeeff'}
if case == 'old-fixture-pod': pod['spec']['containers'][0]['env'] = [{'name': 'CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE', 'value': 'fake'}]
# The production proxy mounts /tmp; only the fixture volume name is refused.
if case == 'production-tmp':
    for spec in (template['spec'], pod['spec']):
        spec['volumes'] = [{'name': 'tmp', 'emptyDir': {}}]
        spec['containers'][0]['volumeMounts'] = [{'name': 'tmp', 'mountPath': '/tmp'}]
if case == 'fixture-volume': template['spec']['volumes'] = [{'name': 'approved-tools-oauth-tmp', 'emptyDir': {}}]
if case == 'wrong-id': status['imageID'] = 'docker://' + other
if case == 'unknown-id': status['imageID'] = 'unknown'
if case == 'missing-id': del status['imageID']
if case == 'missing-baseline': manifest['images'] = {}
if case == 'missing-proxy': deployment = None
if case == 'wrong-profile': manifest['profile'] = 'other'
if case == 'missing-pods': pod = None
if case == 'missing-inventory': inventory = []
if case == 'ghcr':
    ghcr = 'ghcr.io/evenfire-ai/codex-llm-proxy:v1'
    manifest['images'][ghcr] = base
    container['image'] = ghcr
    pod['spec']['containers'][0]['image'] = ghcr
    inventory[0]['repoTags'].append(ghcr)
    status['imageID'] = 'docker-pullable://' + digest_ref
if case == 'unknown-repo-digest': status['imageID'] = 'docker-pullable://' + digest_ref + 'd'
for name, data in [('manifest', manifest), ('deployments', {'items': [deployment] if deployment else []}),
                   ('pods', {'items': [pod] if pod else []}), ('inventory', inventory)]:
    (root / (name + '.json')).write_text(json.dumps(data))
PY
}
for scenario in restored ghcr production-tmp; do
  make_case "$scenario"
  t2_deployment_check
  t2_proxy_runtime_check "$T2_DEPLOYMENT_JSON"
done
# Keep the production preflight integration under regression coverage.
grep -Fq 't2_proxy_runtime_check "$T2_DEPLOYMENT_JSON"' "$ROOT/scripts/minikube/t2-preflight.sh"
for scenario in fixture-image fixture-volume fixture-env fixture-marker old-fixture-pod wrong-id unknown-id missing-id missing-baseline missing-proxy wrong-profile missing-pods missing-inventory unknown-repo-digest runtime-fixture runtime-unknown; do
  make_case "$scenario"
  case "$scenario" in runtime-fixture) runtime_environment=false ;; runtime-unknown) runtime_environment='' ;; esac
  if t2_proxy_runtime_check "$(cat "$tmp/deployments.json")" >"$tmp/result" 2>&1; then
    printf 'unexpected PASS: %s\n' "$scenario" >&2; exit 1
  fi
  grep -q PROXY_RUNTIME_MISMATCH "$tmp/result"
done
# Exercise the actual journey functions without sourcing the orchestrator main.
python3 - "$ROOT/scripts/minikube/t2.sh" "$tmp/journeys.sh" <<'PY'
import sys
from pathlib import Path
source = Path(sys.argv[1]).read_text()
functions = []
for name in ('run_healthcheck_if_requested', 'run_playwright_if_requested'):
    start = source.index(name + '() {')
    end = source.index('\n}\n', start) + 3
    functions.append(source[start:end])
Path(sys.argv[2]).write_text('\n'.join(functions))
PY
source "$tmp/journeys.sh"
export T2_BRANCH T2_HEAD T2_WORKTREE_ID
export JOURNEY_COMMON="$ROOT/scripts/minikube/t2-common.sh"
cat >"$tmp/child.sh" <<'CHILD'
set -eo pipefail
source "$JOURNEY_COMMON"
t2_fail() { printf '%s\n' "$1" >&2; return 1; }
[ "$T2_SKIP_LOCK" = true ]
t2_lock_validate_inherited
CHILD
T2_HEALTHCHECK_COMMAND="bash '$tmp/child.sh'"
T2_PLAYWRIGHT_COMMAND="$T2_HEALTHCHECK_COMMAND"
T2_DEADLINE_RUNNER="$ROOT/scripts/minikube/run-with-deadline.mjs"
T2_HEALTHCHECK_TIMEOUT_SECONDS=10
T2_HEALTHCHECK_KILL_GRACE_SECONDS=1
T2_HEALTHCHECK_REQUIRED=false
T2_REQUIRE_PLAYWRIGHT=true
T2_PORT_FORWARD_STATUS=SKIPPED
t2_evidence_write() { :; }
# Stable process metadata makes start-time verification hermetic even when
# native sandboxed ps intentionally hides host process details.
ps() {
  case "$*" in *lstart=*) printf 'Tue Sep 15 01:00:00 2026\n' ;; *state=*) printf 'S\n' ;; *) return 1 ;; esac
}
export -f ps
t2_lock_acquire
run_healthcheck_if_requested
run_playwright_if_requested
cp "$T2_LOCK_DIR/owner.env" "$tmp/owner-original"
for key in TOKEN REPOSITORY BRANCH HEAD PROFILE CONTEXT WORKTREE_ID LOCK_KEY PROCESS_START PID; do
  python3 - "$tmp/owner-original" "$T2_LOCK_DIR/owner.env" "$key" <<'PY'
import sys
from pathlib import Path
lines = Path(sys.argv[1]).read_text().splitlines()
Path(sys.argv[2]).write_text('\n'.join(sys.argv[3] + '=wrong' if line.startswith(sys.argv[3] + '=') else line for line in lines) + '\n')
PY
  for journey in run_healthcheck_if_requested run_playwright_if_requested; do
    if "$journey" >"$tmp/result" 2>&1; then
      printf 'journey accepted mismatched %s\n' "$key" >&2; exit 1
    fi
  done
done
cp "$tmp/owner-original" "$T2_LOCK_DIR/owner.env"
t2_lock_release 0
printf 'PASS: proxy baseline and inherited journey lease regressions\n'
