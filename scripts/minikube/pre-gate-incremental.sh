#!/usr/bin/env bash

# Incremental image planning for pre-gate-sync.sh. The caller supplies
# PROJECT_DIR, PROFILE, KC, FORCE_CLUSTER_SYNC, log(), and rollout_if_present().

INCREMENTAL_TARGETS=()
INCREMENTAL_FULL_IMAGE_BUILD=false
INCREMENTAL_FULL_DEPLOYMENT=false
INCREMENTAL_CRDS_CHANGED=false

incremental_add_target() {
  local selector="$1" namespace="$2" deployment="$3" target
  target="${selector}|${namespace}|${deployment}"

  local existing
  for existing in "${INCREMENTAL_TARGETS[@]}"; do
    [[ "${existing}" == "${target}" ]] && return 0
  done
  INCREMENTAL_TARGETS+=("${target}")
}

incremental_marker_git_head() {
  ${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane \
    -o jsonpath='{.data.gitHead}' 2>/dev/null || true
}

incremental_is_nonruntime_path() {
  case "$1" in
    AGENTS.md|README.md|CONTRIBUTING.md|SECURITY.md|LICENSE|docs/*|*.md|.github/*) return 0 ;;
    desktop-app/*|scripts/e2e/*|scripts/tests/*) return 0 ;;
    */test/*|*/__tests__/*|*.test.*|*.spec.*|tests/*) return 0 ;;
    *) return 1 ;;
  esac
}

incremental_classify_path() {
  local path="$1"
  incremental_is_nonruntime_path "${path}" && return 0

  case "${path}" in
    control-api/*) incremental_add_target control-api control-plane control-api ;;
    external-rest-api/*) incremental_add_target external-rest-api profiles external-rest-api ;;
    rpc-proxy/*) incremental_add_target rpc-proxy rpc-proxy rpc-proxy ;;
    mcp-host/*) incremental_add_target mcp-host mcp-host chatllm ;;
    host-context-controller/*) incremental_add_target host-context-controller control-plane host-context-controller ;;
    gfs-controller/*) incremental_add_target gfs-controller control-plane host-context-controller ;;
    workflow-recipes/*|packages/workflow-runtime-core/*|packages/workflow-sdk/*)
      incremental_add_target workflow control-plane workflow-recipes
      ;;
    workflow-approval-request-reader/*)
      incremental_add_target workflow-approval-request-reader channels clerum-workflow-approval-request-reader
      ;;
    channel-reader/*) incremental_add_target channel-reader channels channel-reader-chatllm ;;
    mcp-proxy/*) incremental_add_target mcp-proxy mcp-server mcp-proxy ;;
    control-ui/*) incremental_add_target control-ui control-plane control-ui ;;
    profile-ui/*) incremental_add_target profile-ui profiles profile-ui ;;
    webhook-proxy/*) incremental_add_target webhook-proxy webhook-ingress webhook-proxy ;;
    deploy/*)
      INCREMENTAL_FULL_DEPLOYMENT=true
      ;;
    charts/*)
      INCREMENTAL_FULL_DEPLOYMENT=true
      INCREMENTAL_CRDS_CHANGED=true
      ;;
    scripts/minikube/pre-gate-sync.sh|scripts/minikube/pre-gate-runtime.sh|scripts/minikube/pre-gate-incremental.sh|scripts/minikube/pf-all-stack.sh)
      # Orchestration changes do not alter an image or a manifest.
      ;;
    scripts/minikube/*)
      INCREMENTAL_FULL_DEPLOYMENT=true
      ;;
    *)
      # An unmapped runtime path must fail closed into the established full
      # build rather than risking a stale image in a successful gate.
      INCREMENTAL_FULL_IMAGE_BUILD=true
      ;;
  esac
}

incremental_plan() {
  local marker_git_head path

  if [[ "${FORCE_CLUSTER_SYNC}" == "true" ]]; then
    INCREMENTAL_FULL_IMAGE_BUILD=true
    log "Forced cluster sync requires the established full image build"
    return 0
  fi

  marker_git_head="$(incremental_marker_git_head)"
  if [[ ! "${marker_git_head}" =~ ^[0-9a-f]{40}$ ]] || \
     ! git -C "${PROJECT_DIR}" cat-file -e "${marker_git_head}^{commit}" 2>/dev/null; then
    INCREMENTAL_FULL_IMAGE_BUILD=true
    log "No usable cluster git marker; using the established full image build"
    return 0
  fi

  while IFS= read -r path; do
    [[ -z "${path}" ]] || incremental_classify_path "${path}"
  done < <(
    {
      git -C "${PROJECT_DIR}" diff --name-only "${marker_git_head}" HEAD
      git -C "${PROJECT_DIR}" diff --name-only HEAD
      git -C "${PROJECT_DIR}" ls-files --others --exclude-standard
    } | LC_ALL=C sort -u
  )
}

incremental_has_target() {
  local selector="$1" target
  for target in "${INCREMENTAL_TARGETS[@]}"; do
    [[ "${target%%|*}" == "${selector}" ]] && return 0
  done
  return 1
}

incremental_build_images() {
  local target selector

  if [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ]]; then
    log "Building all images because the change cannot be safely targeted"
    (
      cd "${PROJECT_DIR}"
      make minikube-build-images
      make minikube-verify-images
    )
    return 0
  fi

  if (( ${#INCREMENTAL_TARGETS[@]} == 0 )); then
    log "No runtime image changes detected"
    return 0
  fi

  for target in "${INCREMENTAL_TARGETS[@]}"; do
    selector="${target%%|*}"
    log "Building only image selector ${selector}"
    MINIKUBE_PROFILE="${PROFILE}" \
      bash "${PROJECT_DIR}/scripts/minikube/build-images.sh" "--only=${selector}"
  done
}

incremental_restart_targets() {
  local target selector remainder namespace deployment deployment_key
  local restarted="|"

  for target in "${INCREMENTAL_TARGETS[@]}"; do
    selector="${target%%|*}"
    remainder="${target#*|}"
    namespace="${remainder%%|*}"
    deployment="${remainder#*|}"
    deployment_key="|${namespace}/${deployment}|"

    [[ "${restarted}" == *"${deployment_key}"* ]] && continue
    restarted+="${namespace}/${deployment}|"
    if ! ${KC} get deployment "${deployment}" -n "${namespace}" >/dev/null 2>&1; then
      log "Skipping absent ${namespace}/${deployment} for image selector ${selector}"
      continue
    fi
    ${KC} rollout restart "deployment/${deployment}" -n "${namespace}" >/dev/null
    log "Restarted ${namespace}/${deployment} for image selector ${selector}"
    rollout_if_present "${namespace}" "${deployment}"
  done
}

incremental_requires_database_reconcile() {
  [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ||
     "${INCREMENTAL_FULL_DEPLOYMENT}" == "true" ]] ||
    incremental_has_target control-api
}

incremental_requires_gfs_verify() {
  [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ||
     "${INCREMENTAL_FULL_DEPLOYMENT}" == "true" ]] ||
    incremental_has_target control-api ||
    incremental_has_target host-context-controller ||
    incremental_has_target gfs-controller
}

incremental_verify_gfs_if_required() {
  if ! incremental_requires_gfs_verify; then
    log "Skipping gfs permission-store verification; this sync plan does not affect it"
    return 0
  fi

  if ${KC} get configmap gfs-config -n gfs >/dev/null 2>&1 &&
     ${KC} -n gfs get deployment -l clerum.io/managed-by=host-context-controller -o name 2>/dev/null | grep -q .; then
    log "Verifying gfs permission-store wiring"
    CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/scripts/minikube/verify-gfs.sh"
  else
    log "SKIPPING gfs permission-store verification; required resources are absent"
  fi
}

incremental_target_summary() {
  local target selector summary=""
  for target in "${INCREMENTAL_TARGETS[@]}"; do
    selector="${target%%|*}"
    summary+="${summary:+, }${selector}"
  done
  printf '%s' "${summary:-none}"
}
