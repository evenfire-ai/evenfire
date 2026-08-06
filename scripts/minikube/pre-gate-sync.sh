#!/usr/bin/env bash
# Enforces the "sync to minikube before every gate" rule from the platform E2E plan.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"
WORKTREE_ID="$(printf '%s' "${PROJECT_DIR}" | shasum | awk '{print $1}')"
STATE_ROOT="${TMPDIR:-/tmp}/clerum-pre-gate-sync"
STATE_DIR="${STATE_ROOT}/${WORKTREE_ID}"
CLUSTER_SYNC_STATE_CONFIGMAP="${CLERUM_PRE_GATE_SYNC_CONFIGMAP:-clerum-pre-gate-sync-state}"
mkdir -p "${STATE_DIR}"

GATE_NAME="pre-gate"
FORCE_CLUSTER_SYNC=false
FORCE_RESTART=false
SKIP_PORT_FORWARDS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate)
      GATE_NAME="${2:?missing gate name}"
      shift 2
      ;;
    --force-cluster-sync)
      FORCE_CLUSTER_SYNC=true
      shift
      ;;
    --force-restart)
      FORCE_RESTART=true
      shift
      ;;
    --skip-port-forwards)
      SKIP_PORT_FORWARDS=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

log() {
  printf '[pre-gate-sync] %s\n' "$*"
}

# shellcheck source=scripts/minikube/pre-gate-runtime.sh
source "${SCRIPT_DIR}/pre-gate-runtime.sh"
# shellcheck source=scripts/minikube/pre-gate-incremental.sh
source "${SCRIPT_DIR}/pre-gate-incremental.sh"

# A database/schema migration must not race the eager workflow reconciler. Keep
# the existing replica count so a failed gate restores the branch-owned
# control-plane shape instead of silently leaving reconciliation disabled.
WRC_FENCED=false
WRC_REPLICAS=1
CONTROL_API_FENCED=false
CONTROL_API_REPLICAS=1

fence_workflow_reconciler() {
  if ! ${KC} get deployment/workflow-recipes -n control-plane >/dev/null 2>&1; then
    log "Workflow reconciler is not present; no rollout fence is required"
    return 0
  fi
  WRC_REPLICAS="$(${KC} get deployment/workflow-recipes -n control-plane -o jsonpath='{.spec.replicas}')"
  WRC_REPLICAS="${WRC_REPLICAS:-1}"
  log "Fencing workflow reconciler at ${WRC_REPLICAS} replica(s) before schema migration"
  WRC_FENCED=true
  ${KC} scale deployment/workflow-recipes -n control-plane --replicas=0 >/dev/null
  ${KC} rollout status deployment/workflow-recipes -n control-plane --timeout=60s >/dev/null
}

restore_workflow_reconciler() {
  if [[ "${WRC_FENCED}" != "true" ]]; then
    return 0
  fi
  set +e
  log "Restoring workflow reconciler to ${WRC_REPLICAS} replica(s)"
  ${KC} scale deployment/workflow-recipes -n control-plane --replicas="${WRC_REPLICAS}" >/dev/null
  ${KC} rollout status deployment/workflow-recipes -n control-plane --timeout=120s >/dev/null
  local restore_rc=$?
  set -e
  if [[ "${restore_rc}" -ne 0 ]]; then
    log "WARNING: workflow reconciler did not become Ready during pre-gate cleanup"
  fi
  WRC_FENCED=false
}

fence_control_api() {
  if ! ${KC} get deployment/control-api -n control-plane >/dev/null 2>&1; then
    log "Control API is not present; no writer fence is required"
    return 0
  fi
  CONTROL_API_REPLICAS="$(${KC} get deployment/control-api -n control-plane -o jsonpath='{.spec.replicas}')"
  CONTROL_API_REPLICAS="${CONTROL_API_REPLICAS:-1}"
  if [[ ! "${CONTROL_API_REPLICAS}" =~ ^[0-9]+$ ]]; then
    log "ERROR: unable to determine control-api replica count; refusing schema-first sync"
    return 1
  fi
  log "Fencing Control API writers at ${CONTROL_API_REPLICAS} replica(s) before schema migration"
  CONTROL_API_FENCED=true
  ${KC} scale deployment/control-api -n control-plane --replicas=0 >/dev/null
  ${KC} rollout status deployment/control-api -n control-plane --timeout=60s >/dev/null
}

restore_control_api() {
  if [[ "${CONTROL_API_FENCED}" != "true" ]]; then
    return 0
  fi
  set +e
  log "Restoring Control API to ${CONTROL_API_REPLICAS} replica(s)"
  ${KC} scale deployment/control-api -n control-plane --replicas="${CONTROL_API_REPLICAS}" >/dev/null
  ${KC} rollout status deployment/control-api -n control-plane --timeout=120s >/dev/null
  local restore_rc=$?
  set -e
  if [[ "${restore_rc}" -ne 0 ]]; then
    log "WARNING: Control API did not become Ready during pre-gate cleanup"
  fi
  CONTROL_API_FENCED=false
}

restore_pre_gate_writers() {
  # Restore Control API first so it can serve the final readiness checks; WRC
  # remains last because it is the consumer that must stay stopped until every
  # migration, writer restart, and legacy-policy gate has completed.
  restore_control_api
  restore_workflow_reconciler
}

trap restore_pre_gate_writers EXIT

fingerprint_dir() {
  local dir="$1"

  if [[ ! -d "${PROJECT_DIR}/${dir}" ]]; then
    echo "missing"
    return
  fi

  local digest
  digest="$(find "${PROJECT_DIR}/${dir}" \
    -type f \
    ! -path '*/node_modules/*' \
    ! -path '*/dist/*' \
    ! -path '*/.next/*' \
    ! -path '*/playwright-report/*' \
    ! -path '*/test-results/*' \
    ! -path '*/coverage/*' \
    -exec shasum {} + 2>/dev/null | sort | shasum | awk '{print $1}')"

  echo "${digest:-empty}"
}

state_file_for() {
  local key="$1"
  local safe_key
  safe_key="$(echo "${key}" | tr '/.' '__')"
  echo "${STATE_DIR}/${safe_key}.sha"
}

has_changed() {
  local key="$1"
  local current="$2"
  local state_file

  state_file="$(state_file_for "${key}")"
  if [[ ! -f "${state_file}" ]]; then
    return 0
  fi

  [[ "$(cat "${state_file}")" != "${current}" ]]
}

persist_state() {
  local key="$1"
  local value="$2"
  printf '%s' "${value}" >"$(state_file_for "${key}")"
}

cluster_marker_matches() {
  local expected_cluster_fingerprint="$1"
  local expected_worktree_id="$2"
  local expected_git_head actual_cluster_fingerprint actual_worktree_id actual_git_head

  expected_git_head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD 2>/dev/null || true)"

  actual_cluster_fingerprint="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.clusterFingerprint}' 2>/dev/null || true)"
  actual_worktree_id="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.worktreeId}' 2>/dev/null || true)"
  actual_git_head="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.gitHead}' 2>/dev/null || true)"

  [[ "${actual_cluster_fingerprint}" == "${expected_cluster_fingerprint}" ]] &&
    [[ "${actual_worktree_id}" == "${expected_worktree_id}" ]] &&
    [[ -n "${expected_git_head}" && "${actual_git_head}" == "${expected_git_head}" ]]
}

persist_cluster_marker() {
  local cluster_fingerprint="$1"
  local infra_fingerprint="$2"
  local git_head updated_at

  git_head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  ${KC} create configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane \
    --from-literal=clusterFingerprint="${cluster_fingerprint}" \
    --from-literal=infraFingerprint="${infra_fingerprint}" \
    --from-literal=worktreeId="${WORKTREE_ID}" \
    --from-literal=gitHead="${git_head}" \
    --from-literal=gate="${GATE_NAME}" \
    --from-literal=updatedAt="${updated_at}" \
    --dry-run=client \
    -o yaml | ${KC} apply -f - >/dev/null
}

run_if_changed() {
  local dir="$1"
  local cmd="$2"
  local fingerprint

  fingerprint="$(fingerprint_dir "${dir}")"
  if has_changed "pkg:${dir}" "${fingerprint}"; then
    log "Running targeted unit tests for ${dir}"
    (
      cd "${PROJECT_DIR}/${dir}"
      eval "${cmd}"
    )
    persist_state "pkg:${dir}" "${fingerprint}"
  else
    log "No package changes detected for ${dir}"
  fi
}

ensure_artifact() {
  local dir="$1"
  local artifact="$2"
  local cmd="$3"

  if [[ -e "${PROJECT_DIR}/${dir}/${artifact}" ]]; then
    return 0
  fi

  log "Building ${dir} because ${artifact} is missing"
  (
    cd "${PROJECT_DIR}/${dir}"
    eval "${cmd}"
  )
}

sync_mcp_host_auth_key() {
  if ! ${KC} get secret rpc-proxy-secrets -n rpc-proxy >/dev/null 2>&1; then
    log "Skipping mcp-host auth key sync (rpc-proxy-secrets not found)"
    return 0
  fi

  if ! ${KC} get configmap mcp-host-config -n mcp-host >/dev/null 2>&1; then
    log "Skipping mcp-host auth key sync (mcp-host-config not found)"
    return 0
  fi

  bash "${PROJECT_DIR}/scripts/minikube/sync-auth-key.sh" --context "${PROFILE}"
}

provision_gfs_serving() {
  if ${KC} get configmap gfs-config -n gfs >/dev/null 2>&1; then
    log "Provisioning gfs serving before ${GATE_NAME}"
    # FAIL LOUD: with the GFS stack deployed, a broken gfs_controller credential
    # means every GFS operation 503s (issue #775). Continuing would burn the
    # whole gate run on a cluster that cannot pass.
    if ! CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"; then
      log "ERROR: gfs DB provisioning FAILED — gfsc cannot authorize any operation. Aborting ${GATE_NAME} pre-gate sync."
      exit 1
    fi
  else
    log "Skipping gfs serving provisioning (gfs-config not found — GFS stack not deployed)"
  fi

  sync_mcp_host_auth_key
}

assert_no_legacy_prompt_bridge_grants() {
  # Target-aware promptBridge authorization is fail-closed for legacy rows.
  # Inventory only policies that require migration review; intentionally
  # disabled/revoking grants are already fenced and must not block an upgrade.
  # This check deliberately does not infer a provider, model, slot, or order;
  # migration remains an explicit operator-reviewed action.
  local legacy_count query
  # A full image sync restarts the database deployment without waiting for the
  # whole namespace.  Wait for the exact Postgres deployment here before
  # kubectl exec; otherwise the deployment resolver can select a completed
  # migration Job during the restart window and produce a false gate failure.
  rollout_if_present control-plane control-postgres
  query="
    SELECT count(*)::int
     FROM plugin_workload_sdk_grants
     WHERE capability_family = 'promptBridge'
       AND policy_state = 'legacy_unreviewed';
  "
  # Keep the command after `kubectl exec --` on the same continued shell
  # command. A bare newline after `--` makes kubectl receive no command and
  # then runs `psql` on the host, producing a misleading local-socket error.
  legacy_count="$(${KC} exec -n control-plane deployment/control-postgres -- \
    psql -U postgres -d profiles -Atqc "${query}")"
  legacy_count="$(printf '%s' "${legacy_count}" | tr -d '[:space:]')"
  if [[ ! "${legacy_count}" =~ ^[0-9]+$ ]]; then
    log "ERROR: unable to inventory legacy promptBridge grants; refusing target-aware rollout"
    return 1
  fi
  if [[ "${legacy_count}" != "0" ]]; then
    log "ERROR: ${legacy_count} legacy promptBridge grant(s) require operator-reviewed target migration before mcp-host rollout"
    return 1
  fi
  log "Legacy promptBridge grant inventory is empty"
}

log "Evaluating sync requirements for ${GATE_NAME}"
preflight_host_lifecycle_probe

cluster_fingerprint="$(
  {
    fingerprint_dir control-api
    fingerprint_dir external-rest-api
    fingerprint_dir rpc-proxy
    fingerprint_dir mcp-host
    fingerprint_dir host-context-controller
    fingerprint_dir packages/workflow-runtime-core
	    fingerprint_dir workflow-recipes
	    fingerprint_dir packages/workflow-sdk
	    fingerprint_dir tests/e2e/fixtures/custom-workflow-coordinator
	    fingerprint_dir channel-reader
    fingerprint_dir workflow-approval-request-reader
    fingerprint_dir control-ui
    fingerprint_dir deploy
    fingerprint_dir charts
    fingerprint_dir scripts/minikube
  } | shasum | awk '{print $1}'
)"

infra_fingerprint="$(
  {
    fingerprint_dir deploy
    fingerprint_dir charts
    fingerprint_dir scripts/minikube
  } | shasum | awk '{print $1}'
)"

cluster_changed=false
infra_changed=false

if [[ "${FORCE_CLUSTER_SYNC}" == "true" ]] || has_changed cluster "${cluster_fingerprint}"; then
  cluster_changed=true
elif ! cluster_marker_matches "${cluster_fingerprint}" "${WORKTREE_ID}"; then
  log "Cluster sync marker is missing or belongs to a different worktree/fingerprint"
  cluster_changed=true
fi

if [[ "${FORCE_RESTART}" == "true" ]] || has_changed infra "${infra_fingerprint}"; then
  infra_changed=true
fi

run_if_changed packages/workflow-runtime-core "npm test && npm run build"
ensure_artifact packages/workflow-runtime-core dist/index.js "npm run build"
run_if_changed control-api "npm test"
run_if_changed external-rest-api "npm test"
run_if_changed rpc-proxy "npm test"
run_if_changed mcp-host "npm test"
run_if_changed host-context-controller "npm test"
run_if_changed workflow-recipes "npm test"
run_if_changed packages/workflow-sdk "npm test"
run_if_changed workflow-approval-request-reader "npm test"
run_if_changed control-ui "npm test"
run_if_changed desktop-app "npm test"

if [[ "${cluster_changed}" == "true" ]]; then
  incremental_plan
  log "Cluster sync plan before ${GATE_NAME}: images=$(incremental_target_summary), full-image-build=${INCREMENTAL_FULL_IMAGE_BUILD}, full-deployment=${INCREMENTAL_FULL_DEPLOYMENT}"

  if [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ||
        "${INCREMENTAL_FULL_DEPLOYMENT}" == "true" ]]; then
    (
      cd "${PROJECT_DIR}"
      make minikube-deploy-crds
    )
    CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/apply-gfs-writer-secret.sh"
    writer_dsn="$(${KC} -n gfs get secret gfs-controller-db -o 'jsonpath={.data.connection-string}')"
    if [[ -n "${writer_dsn}" ]]; then
      if ! ${KC} -n control-plane rollout status deployment/control-api --timeout=5s >/dev/null 2>&1; then
        log "ERROR: existing GFS writer detected but control-api is not Ready; refusing full overlay sync"
        exit 1
      fi
      log "Upgrade path — reconciling GFS credentials before full overlay sync"
      CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"
    else
      log "Fresh bootstrap — reader staging deferred until post-migration convergence; GFSC remains fail-closed"
    fi
  fi

  if incremental_requires_database_reconcile; then
    fence_workflow_reconciler
    fence_control_api
  fi

  incremental_build_images

  if incremental_requires_database_reconcile; then
    rollout_if_present control-plane control-postgres
    CONTEXT="${PROFILE}" ALLOWED_CONTEXTS="${PROFILE}" \
      bash "${PROJECT_DIR}/deploy/scripts/run-control-api-db-migration.sh" \
      --overlay "${PROJECT_DIR}/deploy/overlays/minikube"
    CONTEXT="${PROFILE}" ALLOWED_CONTEXTS="${PROFILE}" \
      bash "${PROJECT_DIR}/deploy/scripts/provision-control-api-runtime-roles.sh"
    # The GFS DSN authentication probe deliberately runs inside control-api so
    # the connection material stays on stdin and never enters argv or the host.
    # Control API was fenced only for the schema migration/writer window; the
    # runtime roles now exist, so restore it before GFS provisioning makes that
    # probe. The workflow reconciler remains fenced until the complete
    # schema/credential/overlay sequence has converged.
    restore_control_api
    # The base manifest no longer declares connection-string (provisioning-owned
    # key), so deploy-all cannot clobber it. Provisioning must still run AFTER
    # control-api migrations (0048 creates the least-privilege gfs_controller
    # role) for fresh profiles and to converge any stale credential before the
    # rest of the gate observes service readiness.
    provision_gfs_serving
  fi

  # Schema/control-plane first: only after migrations, runtime roles, and
  # inventory gates have converged may the new consumer workloads be applied or
  # restarted. The workflow reconciler is fenced above for this window.
  if [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ||
        "${INCREMENTAL_FULL_DEPLOYMENT}" == "true" ]]; then
    (
      cd "${PROJECT_DIR}"
      make minikube-apply-secrets
      make minikube-deploy-all
      if [[ "${FORCE_RESTART}" == "true" || "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ]]; then
        make minikube-restart-all
      fi
    )
  fi

  # The schema-first window is over: all desired manifests/images are now in
  # place, so restore the old replica count only after the old writer was fully
  # stopped and migrations completed. Recreate strategy on the Deployment makes
  # ordinary image/config rollouts obey the same no-overlap contract.
  restore_control_api

  # Release invariant: every path that can restart/serve mcp-host proves that
  # no legacy grant is routable, not only the migration path.
  assert_no_legacy_prompt_bridge_grants
  ensure_evenfire_registry
  incremental_restart_targets

  # nginx.conf is mounted through a subPath.  Kubernetes updates the
  # ConfigMap object but does not refresh that file in an already-running pod,
  # so a full deployment sync must roll the gateway before any SDK probe uses
  # the new route set.
  if [[ "${INCREMENTAL_FULL_DEPLOYMENT}" == "true" ||
        "${FORCE_RESTART}" == "true" ]]; then
    rollout_restart_with_retry control-plane nginx-workflow-approval-gateway
    rollout_if_present control-plane nginx-workflow-approval-gateway
  fi

  assert_workflow_gateway_prompt_bridge_finalization_route

  rollout_if_present control-plane host-context-controller
  rollout_if_present control-plane workflow-recipes
  rollout_if_present control-plane control-ui
  rollout_if_present profiles external-rest-api
  rollout_if_present rpc-proxy rpc-proxy
  rollout_namespace_deployments mcp-host
  rollout_if_present channels clerum-channel-reader
  rollout_if_present channels clerum-workflow-approval-request-reader
  if gate_needs_registry; then
    rollout_if_present registry registry-api
  fi

  incremental_verify_gfs_if_required

  log "Cluster status after sync"
  ${KC} get deploy -A --no-headers 2>/dev/null | grep -v kube-system || true
  ${KC} get sts -A --no-headers 2>/dev/null || true

  if [[ "${SKIP_PORT_FORWARDS}" != "true" ]]; then
    "${SCRIPT_DIR}/pf-all-stack.sh"
  fi

  persist_cluster_marker "${cluster_fingerprint}" "${infra_fingerprint}"
  persist_state cluster "${cluster_fingerprint}"
  persist_state infra "${infra_fingerprint}"
  log "Pre-gate cluster sync complete"
else
  log "No cluster sync required before ${GATE_NAME}"
  assert_no_legacy_prompt_bridge_grants
  ensure_evenfire_registry
  rollout_if_present control-plane nginx-workflow-approval-gateway
  assert_workflow_gateway_prompt_bridge_finalization_route
  ${KC} get deploy -A --no-headers 2>/dev/null | grep -v kube-system || true
fi
