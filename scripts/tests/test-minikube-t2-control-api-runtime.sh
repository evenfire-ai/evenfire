#!/usr/bin/env bash
# Hermetic Control API restoration checks for certifying preflight.
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
T2_REQUIRED_DEPLOYMENTS=control-plane/control-api
T2_PLAN_MODE=false
T2_BOOTSTRAP_REQUIRED=false
t2_fail() { printf '%s: %s\n' "$1" "$2" >&2; return 1; }
# Every runtime entry point is replaced; no cluster or container is contacted.
t2_kc() {
  case "$*" in
    'get deployments -A -o json') cat "$tmp/deployments.json" ;;
    '-n control-plane get pods -l app=control-api -o json') cat "$tmp/pods.json" ;;
    '-n control-plane exec api-1 -c control-api -- node -e '*)
      [ "${11}" = 'EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE APPROVED_TOOLS_RUN_ID' ] || return 1
      [ "${12}" = '/tmp/approved-tools-oauth-active.json' ] || return 1
      [ "$runtime_environment" != unknown ] || return 1
      local environment=(env -u EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE -u APPROVED_TOOLS_RUN_ID NODE_ENV=production)
      case "$runtime_environment" in
        fixture) environment+=(EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE=1) ;;
        run) environment+=(APPROVED_TOOLS_RUN_ID=approved-tools-aabbccddeeff) ;;
        test) environment+=(NODE_ENV=test) ;;
      esac
      "${environment[@]}" node -e "${10}" "${11}" "$tmp/active.json"
      ;;
    *) printf 'unexpected cluster command\n' >&2; return 1 ;;
  esac
}
t2_mk() {
  [ "$*" = 'image ls --format=json' ] || return 1
  cat "$tmp/inventory.json"
}
make_case() {
  runtime_environment=clean
  rm -f "$tmp/active.json"
  python3 - "$tmp" "$1" <<'PY'
import copy, json, sys
from pathlib import Path
root, case = Path(sys.argv[1]), sys.argv[2]
base, other = 'sha256:' + 'a'*64, 'sha256:' + 'b'*64
ref = 'clerum/control-api:test'
digest_ref = 'ghcr.io/evenfire-ai/control-api@sha256:' + 'c'*64
manifest = {'profile': 'fake', 'images': {ref: base}}
container = {'name': 'control-api', 'image': ref, 'env': []}
template = {'metadata': {}, 'spec': {'containers': [container]}}
deployment = {'metadata': {'name': 'control-api', 'namespace': 'control-plane', 'generation': 1},
              'spec': {'replicas': 1, 'template': template},
              'status': {'observedGeneration': 1, 'updatedReplicas': 1, 'readyReplicas': 1, 'availableReplicas': 1}}
pod = copy.deepcopy(template)
pod['metadata'] = {'name': 'api-1', 'namespace': 'control-plane'}
status = {'name': 'control-api', 'imageID': 'docker://' + base, 'ready': True, 'state': {'running': {'startedAt': '2026-01-01'}}}
pod['status'] = {'containerStatuses': [status]}
inventory = [{'id': base[7:], 'repoTags': ['docker.io/' + ref], 'repoDigests': [digest_ref]}]
if case == 'fixture-image':
    container['image'] = 'clerum/codex-approved-tools-control-api-e2e:test'
    manifest['images'][container['image']] = other
if case == 'fixture-run-env': container['env'] = [{'name': 'APPROVED_TOOLS_RUN_ID', 'value': 'approved-tools-aabbccddeeff'}]
if case == 'fixture-node-env': container['env'] = [{'name': 'NODE_ENV', 'value': 'test'}]
if case == 'fixture-env': container['env'] = [{'name': 'EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE', 'value': '1'}]
if case == 'fixture-marker': template['metadata']['annotations'] = {'evenfire.ai/codex-tools-fixture-run': 'approved-tools-aabbccddeeff'}
if case == 'old-fixture-pod': pod['spec']['containers'][0]['env'] = [{'name': 'APPROVED_TOOLS_RUN_ID', 'value': 'fake'}]
if case == 'old-fixture-marker': pod['metadata']['annotations'] = {'evenfire.ai/codex-tools-fixture-run': 'approved-tools-aabbccddeeff'}
if case == 'fixture-image-alias':
    alias = 'clerum/codex-approved-tools-control-api-e2e:test'
    container['image'] = alias
    pod['spec']['containers'][0]['image'] = alias
    manifest['images'][alias] = base
    inventory[0]['repoTags'].append('docker.io/' + alias)
# A5 fixture storage: a fresh emptyDir carries no marker file.
if case == 'fixture-volume': template['spec']['volumes'] = [{'name': 'approved-tools-oauth-tmp', 'emptyDir': {}}]
if case == 'fixture-tmp-mount': container['volumeMounts'] = [{'name': 'scratch', 'mountPath': '/tmp'}]
if case == 'old-fixture-volume-pod': pod['spec']['volumes'] = [{'name': 'approved-tools-oauth-tmp', 'emptyDir': {}}]
if case == 'unrelated-mount':
    for spec in (template['spec'], pod['spec']):
        spec['volumes'] = [{'name': 'config', 'configMap': {'name': 'control-api'}}]
        spec['containers'][0]['volumeMounts'] = [{'name': 'config', 'mountPath': '/etc/control-api'}]
if case == 'wrong-id': status['imageID'] = 'docker://' + other
if case == 'unknown-id': status['imageID'] = 'unknown'
if case == 'missing-id': del status['imageID']
if case == 'missing-baseline': manifest['images'] = {}
if case == 'missing-api': deployment = None
if case == 'wrong-profile': manifest['profile'] = 'other'
if case == 'missing-pods': pod = None
if case == 'missing-inventory': inventory = []
if case == 'ghcr':
    ghcr = 'ghcr.io/evenfire-ai/control-api:v1'
    manifest['images'][ghcr] = base
    container['image'] = ghcr
    pod['spec']['containers'][0]['image'] = ghcr
    inventory[0]['repoTags'].append(ghcr)
    status['imageID'] = 'docker-pullable://' + digest_ref
if case == 'unknown-repo-digest': status['imageID'] = 'docker-pullable://' + digest_ref + 'd'
pods = [pod] if pod else []
if 'migration' in case:
    # Migration Jobs share app=control-api with the serving Deployment.
    migration = {
        'metadata': {'name': 'control-api-db-migrate-test', 'namespace': 'control-plane',
                     'ownerReferences': [{'apiVersion': 'batch/v1', 'kind': 'Job',
                                          'name': 'control-api-db-migrate', 'uid': 'job-fixture',
                                          'controller': True}]},
        'spec': {'containers': [{'name': 'migrate', 'image': ref}]},
        'status': {'phase': 'Succeeded', 'containerStatuses': [
            {'name': 'migrate', 'ready': False, 'imageID': 'docker://' + base,
             'state': {'terminated': {'exitCode': 0}}}]},
    }
    if case == 'running-migration': migration['status']['phase'] = 'Running'
    if case == 'failed-migration': migration['status']['phase'] = 'Failed'
    if case == 'unknown-migration': migration['status']['phase'] = 'Unknown'
    if case == 'migration-running-container': migration['status']['containerStatuses'][0]['state'] = {'running': {'startedAt': '2026-01-01'}}
    if case == 'migration-failed-container': migration['status']['containerStatuses'][0]['state']['terminated']['exitCode'] = 1
    if case == 'migration-unknown-containers': migration['status']['containerStatuses'] = []
    if case == 'migration-running-init': migration['status']['initContainerStatuses'] = [{'name': 'setup', 'state': {'running': {'startedAt': '2026-01-01'}}}]
    if case == 'migration-unknown-owner-api': migration['metadata']['ownerReferences'][0]['apiVersion'] = 'other/v1'
    if case == 'unowned-migration': migration['metadata']['ownerReferences'] = []
    if case == 'noncontroller-migration': migration['metadata']['ownerReferences'][0]['controller'] = False
    if case == 'nonjob-migration': migration['metadata']['ownerReferences'][0]['kind'] = 'ReplicaSet'
    if case == 'migration-only': pods = []
    if case == 'migration-insufficient-serving': deployment['spec']['replicas'] = 2
    if case == 'migration-wrong-serving-id': status['imageID'] = 'docker://' + other
    if case == 'migration-fixture-serving': pod['spec']['containers'][0]['env'] = [{'name': 'EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE', 'value': '1'}]
    pods.append(migration)
for name, data in [('manifest', manifest), ('deployments', {'items': [deployment] if deployment else []}),
                   ('pods', {'items': pods}), ('inventory', inventory)]:
    (root / (name + '.json')).write_text(json.dumps(data))
PY
}
for scenario in restored ghcr completed-migration unrelated-mount; do
  make_case "$scenario"
  t2_deployment_check
  t2_control_api_runtime_check "$T2_DEPLOYMENT_JSON"
done
# Keep the production preflight integration under regression coverage.
# The contract checks literal shell source, not an expanded value.
# shellcheck disable=SC2016
grep -Fq 't2_control_api_runtime_check "$T2_DEPLOYMENT_JSON"' "$ROOT/scripts/minikube/t2-preflight.sh"
for scenario in fixture-image fixture-image-alias fixture-volume fixture-tmp-mount old-fixture-volume-pod fixture-env fixture-run-env fixture-node-env fixture-marker old-fixture-pod old-fixture-marker wrong-id unknown-id missing-id missing-baseline missing-api wrong-profile missing-pods missing-inventory unknown-repo-digest runtime-fixture runtime-run runtime-test runtime-marker runtime-unknown migration-only migration-insufficient-serving running-migration failed-migration unknown-migration unowned-migration noncontroller-migration nonjob-migration migration-wrong-serving-id migration-fixture-serving migration-running-container migration-failed-container migration-unknown-containers migration-running-init migration-unknown-owner-api; do
  make_case "$scenario"
  case "$scenario" in
    runtime-fixture) runtime_environment=fixture ;;
    runtime-run) runtime_environment=run ;;
    runtime-test) runtime_environment='test' ;;
    runtime-marker) printf '{}\n' >"$tmp/active.json" ;;
    runtime-unknown) runtime_environment=unknown ;;
  esac
  if t2_control_api_runtime_check "$(cat "$tmp/deployments.json")" >"$tmp/result" 2>&1; then
    printf 'unexpected PASS: %s\n' "$scenario" >&2; exit 1
  fi
  grep -q CONTROL_API_RUNTIME_MISMATCH "$tmp/result"
done
# Planning/bootstrap never certify this runtime baseline.
make_case missing-api
T2_PLAN_MODE=true
t2_control_api_runtime_check "$(cat "$tmp/deployments.json")"
T2_PLAN_MODE=false
T2_BOOTSTRAP_REQUIRED=true
t2_control_api_runtime_check "$(cat "$tmp/deployments.json")"
printf 'PASS: Control API production baseline, fixture markers and runtime environment regressions\n'
