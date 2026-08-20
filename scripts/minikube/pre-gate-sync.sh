#!/usr/bin/env bash
# Enforces the "sync to minikube before every gate" rule from the platform E2E plan.

set -euo pipefail
set +u
PRE_GATE_SYNC_CONFIG_ONLY="$PRE_GATE_SYNC_CONFIG_ONLY"
set -u
if [ -z "$PRE_GATE_SYNC_CONFIG_ONLY" ]; then PRE_GATE_SYNC_CONFIG_ONLY=false; fi

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

# The pre-gate entrypoint is also a mutating recovery boundary. It must carry
# the same branch/profile identity as the T2 orchestrator, or acquire that
# identity itself when invoked standalone.
T2_PROJECT_DIR="$PROJECT_DIR"
T2_PROFILE="$PROFILE"
T2_CONTEXT="$PROFILE"
T2_GATE_ID="$GATE_NAME"
# shellcheck source=scripts/minikube/t2-common.sh
source "$SCRIPT_DIR/t2-common.sh"
if [ -z "$T2_SKIP_LOCK" ]; then T2_SKIP_LOCK=false; fi
if [ "$PRE_GATE_SYNC_CONFIG_ONLY" != true ]; then
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
fi

log() {
  printf '[pre-gate-sync] %s\n' "$*"
}

# ---- Which images this cluster runs ---------------------------------------
# THIS HAS TO COME FROM THE CLUSTER, NOT FROM THIS SHELL. A cluster set up with
# ghcr release images and pre-gated with IMAGE_SOURCE=local (or the reverse)
# would otherwise look in sync while every running pod referenced images this
# sync never touched, and the gate would pass against code that is not
# deployed. scripts/minikube/image-mode.sh is the one resolver; it reads the
# mode whichever writer last acquired images recorded, and falls back to the
# environment only for a cluster nothing has built or pulled into yet.
# shellcheck source=scripts/minikube/image-mode.sh
source "${SCRIPT_DIR}/image-mode.sh"

if ! IMAGE_SOURCE="$(image_mode_source "${PROJECT_DIR}")"; then
  exit 1
fi
if ! IMAGE_TAG="$(image_mode_tag "${PROJECT_DIR}")"; then
  exit 1
fi
if ! PRE_GATE_RENDER_DIR="$(image_mode_render_dir "${PROJECT_DIR}")"; then
  exit 1
fi
if ! IMAGES_GENERATED_AT="$(image_mode_images_generated_at "${PROJECT_DIR}")"; then
  exit 1
fi
export IMAGE_SOURCE
if [[ "${IMAGE_SOURCE}" == "ghcr" ]]; then
  # Every `make` sub-invocation below (pull-images, verify-images, deploy-all)
  # must resolve the SAME coordinate this run resolved, including an override
  # the committed pin does not carry.
  export MINIKUBE_IMAGE_TAG="${IMAGE_TAG}"
fi

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
  local deployment_probe
  if ! deployment_probe="$(${KC} get deployment/workflow-recipes -n control-plane 2>&1)"; then
    if [[ "${deployment_probe}" == *NotFound* || "${deployment_probe}" == *"not found"* ]]; then
      log "Workflow reconciler is not present; no rollout fence is required"
      return 0
    fi
    log "ERROR: unable to inspect workflow-recipes before schema migration; refusing to continue without its writer fence"
    return 1
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
  local scale_rc=0 rollout_rc=0
  ${KC} scale deployment/workflow-recipes -n control-plane --replicas="${WRC_REPLICAS}" >/dev/null || scale_rc=$?
  if [[ "${scale_rc}" -eq 0 ]]; then
    ${KC} rollout status deployment/workflow-recipes -n control-plane --timeout=120s >/dev/null || rollout_rc=$?
  fi
  set -e
  if [[ "${scale_rc}" -ne 0 || "${rollout_rc}" -ne 0 ]]; then
    log "ERROR: workflow reconciler restore failed (scale=${scale_rc}, rollout=${rollout_rc}); leaving the writer fence armed"
    return 1
  fi
  WRC_FENCED=false
}

fence_control_api() {
  local deployment_probe
  if ! deployment_probe="$(${KC} get deployment/control-api -n control-plane 2>&1)"; then
    if [[ "${deployment_probe}" == *NotFound* || "${deployment_probe}" == *"not found"* ]]; then
      log "Control API is not present; no writer fence is required"
      return 0
    fi
    log "ERROR: unable to inspect control-api before schema migration; refusing to continue without its writer fence"
    return 1
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
  local scale_rc=0 rollout_rc=0
  ${KC} scale deployment/control-api -n control-plane --replicas="${CONTROL_API_REPLICAS}" >/dev/null || scale_rc=$?
  if [[ "${scale_rc}" -eq 0 ]]; then
    ${KC} rollout status deployment/control-api -n control-plane --timeout=120s >/dev/null || rollout_rc=$?
  fi
  set -e
  if [[ "${scale_rc}" -ne 0 || "${rollout_rc}" -ne 0 ]]; then
    log "ERROR: Control API restore failed (scale=${scale_rc}, rollout=${rollout_rc}); leaving the writer fence armed"
    return 1
  fi
  CONTROL_API_FENCED=false
}

restore_pre_gate_writers() {
  local status=0
  # Restore Control API first so it can serve the final readiness checks; WRC
  # remains last because it is the consumer that must stay stopped until every
  # migration, writer restart, and legacy-policy gate has completed.
  restore_control_api || status=1
  restore_workflow_reconciler || status=1
  return "$status"
}

finalize_pre_gate_sync() {
  local status=$? restore_status=0

  # An EXIT trap's return value does not replace the script's exit status. Exit
  # explicitly so a failed writer restore cannot turn a successful sync into a
  # green exact-head attestation. Disable the trap first to avoid recursion.
  trap - EXIT
  if ! restore_pre_gate_writers; then
    restore_status=1
  fi
  if [[ "${status}" -eq 0 && "${restore_status}" -ne 0 ]]; then
    status=1
  fi
  # t2_lock_release returns the status passed to it; pass zero so an existing
  # non-zero script status is preserved rather than misclassified as a lock
  # cleanup failure.
  t2_lock_release 0 || status=1
  exit "${status}"
}

commit_cluster_sync_state() {
  local cluster_fingerprint="$1" infra_fingerprint="$2"

  # The exact-head marker is a certification artifact, not merely progress.
  # Restore every fenced writer before publishing it so a cleanup failure can
  # never leave a marker that claims the cluster is ready at this HEAD.
  restore_pre_gate_writers || return 1
  persist_cluster_marker "${cluster_fingerprint}" "${infra_fingerprint}" || return 1
  persist_state cluster "${cluster_fingerprint}" || return 1
  persist_state infra "${infra_fingerprint}" || return 1
}

if [ "$PRE_GATE_SYNC_CONFIG_ONLY" != true ]; then
  t2_mutation_lock
fi
trap finalize_pre_gate_sync EXIT

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
  local actual_image_source actual_image_tag actual_images_generated_at

  expected_git_head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD 2>/dev/null || true)"

  actual_cluster_fingerprint="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.clusterFingerprint}' 2>/dev/null || true)"
  actual_worktree_id="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.worktreeId}' 2>/dev/null || true)"
  actual_git_head="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.gitHead}' 2>/dev/null || true)"
  # The image coordinate is part of "in sync". gitHead cannot tell a ghcr
  # cluster from a local one, nor v0.6.0 from latest, and the acquisition stamp
  # is what catches a `make minikube-setup` between two pre-gates: that re-pulls
  # every release image and discards any shadow build while leaving this marker
  # untouched, so without it no sync would run and the gate would silently test
  # release code.
  actual_image_source="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.imageSource}' 2>/dev/null || true)"
  actual_image_tag="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.imageTag}' 2>/dev/null || true)"
  actual_images_generated_at="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane -o jsonpath='{.data.imagesGeneratedAt}' 2>/dev/null || true)"

  [[ "${actual_cluster_fingerprint}" == "${expected_cluster_fingerprint}" ]] &&
    [[ "${actual_worktree_id}" == "${expected_worktree_id}" ]] &&
    [[ -n "${expected_git_head}" && "${actual_git_head}" == "${expected_git_head}" ]] &&
    [[ "${actual_image_source}" == "${IMAGE_SOURCE}" ]] &&
    [[ "${actual_image_tag}" == "${IMAGE_TAG}" ]] &&
    [[ "${actual_images_generated_at}" == "${IMAGES_GENERATED_AT}" ]]
}

persist_cluster_marker() {
  local cluster_fingerprint="$1"
  local infra_fingerprint="$2"
  local git_head updated_at images_generated_at

  git_head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Re-read rather than reusing the value from startup: this run may have
  # re-pulled or rebuilt images, which rewrites the manifest.
  if ! images_generated_at="$(image_mode_images_generated_at "${PROJECT_DIR}")"; then
    log "ERROR: cannot read the image manifest to stamp the cluster sync marker"
    return 1
  fi

  ${KC} create configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane \
    --from-literal=clusterFingerprint="${cluster_fingerprint}" \
    --from-literal=infraFingerprint="${infra_fingerprint}" \
    --from-literal=worktreeId="${WORKTREE_ID}" \
    --from-literal=gitHead="${git_head}" \
    --from-literal=imageSource="${IMAGE_SOURCE}" \
    --from-literal=imageTag="${IMAGE_TAG}" \
    --from-literal=imagesGeneratedAt="${images_generated_at}" \
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
  local source_probe target_probe
  if ! source_probe="$(${KC} get secret rpc-proxy-secrets -n rpc-proxy 2>&1)"; then
    if [[ "${source_probe}" == *NotFound* || "${source_probe}" == *"not found"* ]]; then
      log "Skipping mcp-host auth key sync (rpc-proxy-secrets not found)"
      return 0
    fi
    log "ERROR: unable to inspect rpc-proxy/rpc-proxy-secrets before MCP auth sync"
    return 1
  fi

  if ! target_probe="$(${KC} get configmap mcp-host-config -n mcp-host 2>&1)"; then
    if [[ "${target_probe}" == *NotFound* || "${target_probe}" == *"not found"* ]]; then
      log "Skipping mcp-host auth key sync (mcp-host-config not found)"
      return 0
    fi
    log "ERROR: unable to inspect mcp-host/mcp-host-config before MCP auth sync"
    return 1
  fi

  bash "${PROJECT_DIR}/scripts/minikube/sync-auth-key.sh" --context "${PROFILE}" --skip-gfs --require-mcp
}

sync_gfs_auth_key() {
  bash "${PROJECT_DIR}/scripts/minikube/sync-auth-key.sh" --context "${PROFILE}" --require-gfs
}

settle_gfs_reader_rollout() {
  T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
    T2_PROJECT_DIR="$T2_PROJECT_DIR" MINIKUBE_PROFILE="$T2_PROFILE" \
    CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" T2_PROFILE_ROOT="$T2_PROFILE_ROOT" \
    T2_PROFILE_ENV="$T2_PROFILE_ENV" T2_PORTS_ENV="$T2_PORTS_ENV" \
    CONTEXT="$T2_CONTEXT" \
      bash "${PROJECT_DIR}/scripts/minikube/settle-gfs-reader-rollout.sh"
}

reconcile_gfs_credentials() {
  PATH="${PROJECT_DIR}/scripts/minikube/gfs-rollout-shim:${PATH}" \
    GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true \
    T2_SKIP_LOCK=true T2_LOCK_TOKEN="$T2_LOCK_TOKEN" \
    T2_PROJECT_DIR="$T2_PROJECT_DIR" MINIKUBE_PROFILE="$T2_PROFILE" \
    CONTROL_API_REAL_PG_CONTEXT="$T2_CONTEXT" T2_PROFILE_ROOT="$T2_PROFILE_ROOT" \
    T2_PROFILE_ENV="$T2_PROFILE_ENV" T2_PORTS_ENV="$T2_PORTS_ENV" \
    CONTEXT="$T2_CONTEXT" \
      bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"
}

converge_gfs_reader_after_restore() {
  # A reader whose runtime role was NOLOGIN keeps serving 503 from its
  # already-started pod even after the role is restored. Converging it here
  # keeps the repair inside the single orchestrated run instead of a manual
  # `kubectl rollout restart deploy/gfsc-reader` side quest.
  local deployment=gfsc-reader deployment_probe desired ready
  if ! deployment_probe="$(${KC} get deployment "${deployment}" -n gfs 2>&1)"; then
    if [[ "${deployment_probe}" == *NotFound* || "${deployment_probe}" == *"not found"* ]]; then
      return 0
    fi
    log "ERROR: unable to inspect gfs/${deployment} before credential convergence"
    return 1
  fi
  if ! desired="$(${KC} get deployment "${deployment}" -n gfs -o jsonpath='{.spec.replicas}' 2>/dev/null)"; then
    log "ERROR: unable to read desired replicas for gfs/${deployment}"
    return 1
  fi
  if [[ ! "${desired}" =~ ^[0-9]+$ ]]; then
    log "ERROR: desired replicas for gfs/${deployment} is not numeric"
    return 1
  fi
  if [[ "${desired}" == "0" ]]; then
    return 0
  fi
  if ! ready="$(${KC} get deployment "${deployment}" -n gfs -o jsonpath='{.status.readyReplicas}' 2>/dev/null)"; then
    log "ERROR: unable to read Ready replicas for gfs/${deployment}"
    return 1
  fi
  # Kubernetes omits status.readyReplicas while a Deployment has zero Ready
  # pods. An empty successful read is a real 0; an API failure above remains
  # unknown and fails closed.
  ready="${ready:-0}"
  if [[ ! "${ready}" =~ ^[0-9]+$ ]]; then
    log "ERROR: Ready replicas for gfs/${deployment} is not numeric"
    return 1
  fi
  if [[ "${ready}" == "${desired}" ]]; then
    return 0
  fi
  log "Restarting gfs/${deployment} after credential restore (${ready:-0}/${desired} Ready)"
  rollout_restart_with_retry gfs "${deployment}"
  # HCC's gfsReconciler strips the restartedAt annotation, so the restart may
  # not replace pods and a generation-based rollout status loops until
  # timeout. Delete live unready reader pods once so they re-read the
  # restored Secret without waiting out CrashLoopBackOff, then judge
  # readiness directly.
  local pod_rows pod_name pod_ready pod_deleting
  pod_rows="$(${KC} get pods -n gfs -l 'app=gfs-controller,clerum.io/gfsc-role=reader' -o \
    'jsonpath={range .items[*]}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null || true)"
  while IFS='|' read -r pod_name pod_ready pod_deleting; do
    [ -n "$pod_name" ] || continue
    [ -z "$pod_deleting" ] || continue
    [ "$pod_ready" != True ] || continue
    ${KC} delete pod "$pod_name" -n gfs --wait=false >/dev/null 2>&1 || true
  done <<<"$pod_rows"
  CONTEXT="${PROFILE}" \
    bash "${PROJECT_DIR}/scripts/minikube/wait-gfs-reader-ready.sh"
}

provision_gfs_serving() {
  if [[ "${GATE_NAME}" != "minikube-t2" ]]; then
    # Other platform security gates must retain their read/verify contract.
    # GFS credential recovery is a T2 transition because it can patch Secrets,
    # restart GFSC, delete pods, and resume an abandoned rollout claim.
    log "Skipping GFS serving mutation before ${GATE_NAME}; only minikube-t2 owns GFS recovery"
    sync_mcp_host_auth_key
    return 0
  fi
  if ${KC} get configmap gfs-config -n gfs >/dev/null 2>&1; then
    local reader_probe
    if ! reader_probe="$(${KC} get deployment gfsc-reader -n gfs 2>&1)"; then
      if [[ "${reader_probe}" == *NotFound* || "${reader_probe}" == *"not found"* ]]; then
        log "Skipping gfs serving provisioning (gfsc-reader not found — GFS reader is not deployed)"
        sync_mcp_host_auth_key
        return 0
      fi
      log "ERROR: unable to inspect gfs/gfsc-reader before credential recovery"
      return 1
    fi
    log "Provisioning gfs serving before ${GATE_NAME}"
    # FAIL LOUD: with the GFS stack deployed, a broken gfs_controller credential
    # means every GFS operation 503s (issue #775). Continuing would burn the
    # whole gate run on a cluster that cannot pass.
    # GFS_RESTORE_ACTIVE_NOLOGIN=true: a role-reset T1 suite can leave the
    # cluster-global reader role NOLOGIN. On this local branch-owned profile
    # the committed Secret DSN is the source of truth, so the recovery helper
    # may restore the role from it — the same contract the GFS T1 gate already
    # applies on exit. The helper still fails loud when the restored
    # credential cannot authenticate; no password is invented here.
    # GFS_RECOVER_ABANDONED_STATE: a dead prior setup can leave
    # rollout-running; this sync holds the T2 lock, so resume that claim.
    # An interrupted prior setup can leave gfs-config.jwt-public-key empty
    # (the overlay re-applies the base ConfigMap with an empty value); a
    # reader pod cannot start without it and any readiness wait would only
    # time out. Re-sync it first; this is a no-op when the key matches.
    sync_gfs_auth_key
    # Settle a Ready reader first so reconcile does not restart it and
    # race HCC's gfsReconciler during kubectl rollout status. If reconcile
    # still needs a reader rollout, the gfs-rollout-shim PATH prefix makes
    # that wait judge readiness instead of the template generation HCC keeps
    # rewriting.
    if ! settle_gfs_reader_rollout; then
      log "ERROR: unable to settle the branch-owned GFS reader rollout before credential reconciliation"
      exit 1
    fi
    if ! reconcile_gfs_credentials; then
      log "ERROR: gfs DB provisioning FAILED — gfsc cannot authorize any operation. Aborting ${GATE_NAME} pre-gate sync."
      exit 1
    fi
    if ! converge_gfs_reader_after_restore; then
      log "ERROR: gfs reader did not converge after credential restoration"
      return 1
    fi
  else
    log "Skipping gfs serving provisioning (gfs-config not found — GFS stack not deployed)"
    sync_mcp_host_auth_key
  fi
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

# Test seam: everything above resolves configuration and defines functions
# only, with no cluster or network call. `PRE_GATE_SYNC_CONFIG_ONLY=true` stops
# here so scripts/tests/test-minikube-pre-gate-shadow.sh can read the resolved
# image coordinate, and (when it sources this file) exercise the marker
# functions, without a cluster. It must stay immediately before the first
# cluster call.
if [[ "${PRE_GATE_SYNC_CONFIG_ONLY:-false}" == "true" ]]; then
  printf 'imageSource=%s\n' "${IMAGE_SOURCE}"
  printf 'imageTag=%s\n' "${IMAGE_TAG}"
  printf 'renderDir=%s\n' "${PRE_GATE_RENDER_DIR}"
  printf 'imagesGeneratedAt=%s\n' "${IMAGES_GENERATED_AT}"
  # `return` when sourced, `exit` when executed.
  return 0 2>/dev/null || exit 0
fi

log "Evaluating sync requirements for ${GATE_NAME}"
log "Cluster images: ${IMAGE_SOURCE}${IMAGE_TAG:+ (${IMAGE_TAG})}; overlay $(basename "${PRE_GATE_RENDER_DIR}")"
preflight_host_lifecycle_probe

cluster_fingerprint="$(
  {
    fingerprint_dir control-api
    fingerprint_dir external-rest-api
    fingerprint_dir rpc-proxy
    fingerprint_dir mcp-host
    fingerprint_dir host-context-controller
    fingerprint_dir packages/workflow-runtime-core
    fingerprint_dir packages/network-policy-core
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
# @clerum/network-policy-core is a file: dependency of workflow-recipes and
# host-context-controller (issue #299). Run its node:test suite when it changes.
run_if_changed packages/network-policy-core "npm test"
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
    if [[ "${GATE_NAME}" == "minikube-t2" ]]; then
      CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/apply-gfs-writer-secret.sh"
    else
      log "Skipping GFS writer Secret mutation before ${GATE_NAME}; only minikube-t2 owns GFS recovery"
    fi
    writer_dsn="$(${KC} -n gfs get secret gfs-controller-db -o 'jsonpath={.data.connection-string}')"
    if [[ -n "${writer_dsn}" ]]; then
      # Do not reconcile the GFS roles before the migration window. The
      # current control-api image may add a new least-privilege projection
      # (0095 currently adds lifecycle/link columns); provision-gfs-db.sh
      # correctly refuses a role that does not have that projection yet. The
      # post-migration provision_gfs_serving call below is the authoritative
      # reconciliation point after schema and runtime roles have converged.
      log "Upgrade path — deferring GFS credential reconciliation until after schema migration"
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
    # The migration script EXTRACTS THE CONTROL-API IMAGE from the overlay it
    # renders. Hardcoding the local overlay here yielded clerum/control-api:test
    # on a ghcr cluster -- an image that does not exist there, so the migration
    # Job ImagePullBackOffs; and rendering the pinned ghcr overlay on a cluster
    # running an overridden tag would run a release nobody pulled. Follow the
    # coordinate the cluster actually runs, which is also the ref the shadow
    # build above just retagged.
    CONTEXT="${PROFILE}" ALLOWED_CONTEXTS="${PROFILE}" \
      bash "${PROJECT_DIR}/deploy/scripts/run-control-api-db-migration.sh" \
      --overlay "${PRE_GATE_RENDER_DIR}"
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

  if ! incremental_requires_database_reconcile; then
    # No schema work is planned, but a role-reset T1 run may still have left
    # the cluster-global GFS runtime roles NOLOGIN while every image and
    # manifest matched. The T2 transition owns this idempotent convergence;
    # security-gate invocations return through the non-mutating guard above.
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
      gfs_mutation=false
      [[ "${GATE_NAME}" == "minikube-t2" ]] && gfs_mutation=true
      T2_SKIP_LOCK=true T2_LOCK_TOKEN="${T2_LOCK_TOKEN}" MINIKUBE_GFS_MUTATION="${gfs_mutation}" \
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

  commit_cluster_sync_state "${cluster_fingerprint}" "${infra_fingerprint}"
  log "Pre-gate cluster sync complete"
else
  log "No cluster sync required before ${GATE_NAME}"
  # Images and manifests match, yet the GFS runtime credentials can still be
  # broken (a role-reset T1 leaves the reader NOLOGIN without changing any
  # fingerprint). The T2 fast path repairs them in this single orchestrated
  # run; non-T2 gates are fenced out by provision_gfs_serving.
  provision_gfs_serving
  assert_no_legacy_prompt_bridge_grants
  ensure_evenfire_registry
  rollout_if_present control-plane nginx-workflow-approval-gateway
  assert_workflow_gateway_prompt_bridge_finalization_route
  ${KC} get deploy -A --no-headers 2>/dev/null | grep -v kube-system || true
fi
