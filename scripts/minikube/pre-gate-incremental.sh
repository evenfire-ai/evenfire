#!/usr/bin/env bash

# Incremental image planning for pre-gate-sync.sh. The caller supplies
# PROJECT_DIR, PROFILE, KC, FORCE_CLUSTER_SYNC, IMAGE_SOURCE, IMAGE_TAG,
# IMAGES_GENERATED_AT, log(), and rollout_if_present().
#
# IN GHCR MODE EVERY POD RUNS A RELEASE IMAGE. Building clerum/<svc>:test here
# would produce an image nothing references: the pod restarts onto the same
# release digest and the gate passes against code that was never deployed. So a
# ghcr pre-gate SHADOW-BUILDS -- it builds locally and then tags that build with
# the exact ghcr ref the Deployment already carries, which IfNotPresent picks up
# with no manifest edit, leaving every other image on its release digest.

INCREMENTAL_TARGETS=()
INCREMENTAL_FULL_IMAGE_BUILD=false
INCREMENTAL_FULL_DEPLOYMENT=false
INCREMENTAL_CRDS_CHANGED=false
# Why a full image build was demanded. In ghcr mode "build everything" is not a
# recovery (it reinstates the 20-minute build and leaves the cluster holding
# clerum/* images the ghcr overlay never references), so the reason decides
# between re-pulling the release set and refusing to gate at all.
INCREMENTAL_FULL_IMAGE_BUILD_REASON=""
INCREMENTAL_UNMAPPED=()
# Discard the current image set and re-pull the release tag before shadowing.
INCREMENTAL_REPULL_ALL=false
INCREMENTAL_SHADOWED=()
INCREMENTAL_DOCKER_ENV_APPLIED=false
INCREMENTAL_DEADLINE_RUNNER="${INCREMENTAL_DEADLINE_RUNNER:-${PROJECT_DIR}/scripts/minikube/run-with-deadline.mjs}"
INCREMENTAL_RUNTIME_TIMEOUT_SECONDS="${INCREMENTAL_RUNTIME_TIMEOUT_SECONDS:-30}"
INCREMENTAL_IMAGE_LOAD_TIMEOUT_SECONDS="${INCREMENTAL_IMAGE_LOAD_TIMEOUT_SECONDS:-1800}"

incremental_validate_deadline() {
  local name="$1" value="$2" maximum="$3"
  if ! [[ "${value}" =~ ^[1-9][0-9]*$ ]] || (( 10#${value} > maximum )); then
    log "ERROR: ${name} must be an integer from 1 to ${maximum}" >&2
    return 1
  fi
}

incremental_validate_deadline INCREMENTAL_RUNTIME_TIMEOUT_SECONDS \
  "${INCREMENTAL_RUNTIME_TIMEOUT_SECONDS}" 300 || exit 1
incremental_validate_deadline INCREMENTAL_IMAGE_LOAD_TIMEOUT_SECONDS \
  "${INCREMENTAL_IMAGE_LOAD_TIMEOUT_SECONDS}" 3600 || exit 1
[[ -f "${INCREMENTAL_DEADLINE_RUNNER}" ]] || {
  log "ERROR: bounded runtime helper is missing: ${INCREMENTAL_DEADLINE_RUNNER}" >&2
  exit 1
}

incremental_run_with_deadline() {
  local label="$1" timeout_seconds="$2"
  shift 2
  node "${INCREMENTAL_DEADLINE_RUNNER}" \
    --timeout-seconds "${timeout_seconds}" \
    --heartbeat-seconds "${MINIKUBE_DOCKER_HEARTBEAT_SECONDS:-20}" \
    --kill-grace-seconds "${MINIKUBE_DOCKER_KILL_GRACE_SECONDS:-5}" \
    --label "${label}" -- "$@"
}

incremental_add_target() {
  local selector="$1" namespace="$2" deployment="$3" target
  target="${selector}|${namespace}|${deployment}"

  local existing
  for existing in "${INCREMENTAL_TARGETS[@]}"; do
    [[ "${existing}" == "${target}" ]] && return 0
  done
  INCREMENTAL_TARGETS+=("${target}")
}

# The commit the cluster's images were last synced to, or nothing.
#
# The marker is only a usable baseline while the image set it was stamped
# against is still the set the profile can prove. Both a GHCR acquisition and a
# local build can replace image IDs without changing gitHead; trusting that
# head after a newer acquisition would compute an empty delta and gate without
# proving that the running pods use the newly acquired images. A stamp mismatch
# therefore invalidates the baseline in every image mode; the caller chooses
# the established full local build or GHCR recovery path below.
incremental_marker_git_head() {
  local git_head marker_generated
  git_head="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane \
    -o jsonpath='{.data.gitHead}' 2>/dev/null || true)"
  if [[ -z "${git_head}" ]]; then
    return 0
  fi
  marker_generated="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane \
    -o jsonpath='{.data.imagesGeneratedAt}' 2>/dev/null || true)"
  if [[ -z "${marker_generated}" || -z "${IMAGES_GENERATED_AT:-}" ||
        "${marker_generated}" != "${IMAGES_GENERATED_AT}" ]]; then
    return 0
  fi
  printf '%s' "${git_head}"
}

# Point the Docker CLI at minikube's daemon, once, so a retag lands where the
# kubelet looks. build-images.sh does this in its own process, which does not
# propagate back to this one.
incremental_use_minikube_docker() {
  local env_script
  if [[ "${INCREMENTAL_DOCKER_ENV_APPLIED}" == "true" ]]; then
    return 0
  fi
  if [[ "${MINIKUBE_MULTI_NODE:-false}" == "true" ]]; then
    # Multi-node cannot use docker-env: images are built/pulled in the host
    # daemon and placed on every node with `minikube image load`.
    INCREMENTAL_DOCKER_ENV_APPLIED=true
    return 0
  fi
  if ! env_script="$(incremental_run_with_deadline incremental-docker-env \
    "${INCREMENTAL_RUNTIME_TIMEOUT_SECONDS}" \
    minikube -p "${PROFILE}" docker-env --shell bash)" || \
     [[ -z "${env_script}" ]] || \
     ! grep -Eq '(^|[[:space:]])export[[:space:]]+DOCKER_HOST=' <<<"${env_script}"; then
    # >&2 because this runs inside a command substitution on the baseline
    # path, where anything on stdout would be captured AS the baseline.
    log "ERROR: DOCKER_ENV_UNRESOLVED: could not point Docker at minikube's daemon; a shadow build would land in the wrong daemon" >&2
    exit 1
  fi
  eval "${env_script}"
  if [[ -z "${DOCKER_HOST:-}" ]]; then
    log "ERROR: DOCKER_ENV_UNRESOLVED: minikube docker-env did not set DOCKER_HOST" >&2
    exit 1
  fi
  unset DOCKER_API_VERSION 2>/dev/null || true
  INCREMENTAL_DOCKER_ENV_APPLIED=true
}

# The commit the RUNNING release images were built from.
#
# build-publish.yml stamps every published image with
# org.opencontainers.image.revision, which is the only baseline that works on
# the `latest` bootstrap tag -- `latest` resolves to no git ref at all. The tag
# is tried as a git ref second, for a clone whose daemon no longer holds the
# image. Nothing else is guessed: without a baseline the changed image set is
# unknowable, and the caller must refuse to gate rather than shadow nothing.
incremental_release_baseline_commit() {
  local probe ref revision rc
  incremental_use_minikube_docker
  for probe in control-api workflow-recipes external-rest-api; do
    ref="ghcr.io/evenfire-ai/${probe}:${IMAGE_TAG}"
    revision="$(incremental_run_with_deadline incremental-image-inspect \
      "${INCREMENTAL_RUNTIME_TIMEOUT_SECONDS}" \
      docker inspect --format='{{index .Config.Labels "org.opencontainers.image.revision"}}' "${ref}")"
    rc=$?
    if [[ "${rc}" -ne 0 ]]; then
      continue
    fi
    revision="$(printf '%s' "${revision}" | tr -d '[:space:]')"
    if [[ "${revision}" =~ ^[0-9a-f]{40}$ ]] &&
       git -C "${PROJECT_DIR}" cat-file -e "${revision}^{commit}" 2>/dev/null; then
      printf '%s' "${revision}"
      return 0
    fi
  done
  revision="$(git -C "${PROJECT_DIR}" rev-parse -q --verify "${IMAGE_TAG}^{commit}" 2>/dev/null || true)"
  if [[ "${revision}" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s' "${revision}"
    return 0
  fi
  return 0
}

incremental_is_nonruntime_path() {
  case "$1" in
    AGENTS.md|README.md|CONTRIBUTING.md|SECURITY.md|LICENSE|docs/*|*.md|.github/*) return 0 ;;
    desktop-app/*|scripts/e2e/*|scripts/tests/*) return 0 ;;
    tests/e2e/fixtures/workflow-plugin-sdk-e2e/*) return 1 ;;
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
    gfs-controller/*)
      incremental_add_target gfs-controller gfs gfsc-writer
      incremental_add_target gfs-controller gfs gfsc-reader
      ;;
    workflow-recipes/*|packages/workflow-runtime-core/*|packages/workflow-sdk/*)
      incremental_add_target workflow control-plane workflow-recipes
      ;;
    workflow-approval-request-reader/*)
      incremental_add_target workflow-approval-request-reader channels clerum-workflow-approval-request-reader
      ;;
    channel-reader/*) incremental_add_target channel-reader channels channel-reader-chatllm ;;
    mcp-proxy/*) incremental_add_target mcp-proxy mcp-server mcp-proxy ;;
    control-ui/*) incremental_add_target control-ui control-plane control-ui ;;
    packages/display-field/*)
      # display-field is consumed ONLY by the control-api and control-ui images
      # (their Dockerfiles COPY it and their field validation runs off it), so a
      # change here changes exactly those two image outputs. Reshadow both
      # instead of falling into the unmapped full-build/abort path below.
      # (llm-providers is deliberately NOT mapped here: it has five consumers,
      # so it stays on the fail-closed full-build default rather than risk a
      # partial, drift-prone target list — see work-tracker/issues.)
      incremental_add_target control-api control-plane control-api
      incremental_add_target control-ui control-plane control-ui
      ;;
    profile-ui/*) incremental_add_target profile-ui profiles profile-ui ;;
    webhook-proxy/*) incremental_add_target webhook-proxy webhook-ingress webhook-proxy ;;
    codex-llm-proxy/*) incremental_add_target codex-llm-proxy control-plane codex-llm-proxy ;;
    tests/e2e/fixtures/workflow-plugin-sdk-e2e/*)
      incremental_add_target workflow-plugin-sdk-e2e sandbox-recipes workflow-plugin-sdk-e2e
      ;;
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
      # build rather than risking a stale image in a successful gate. In ghcr
      # mode there is no image to shadow-build for it at all, so the path is
      # recorded and named in the refusal instead of silently skipped.
      INCREMENTAL_FULL_IMAGE_BUILD=true
      INCREMENTAL_FULL_IMAGE_BUILD_REASON="unmapped"
      INCREMENTAL_UNMAPPED+=("${path}")
      ;;
  esac
}

incremental_plan() {
  local marker_git_head path baseline

  if [[ "${FORCE_CLUSTER_SYNC}" == "true" ]]; then
    if [[ "${IMAGE_SOURCE}" == "ghcr" ]]; then
      # A forced sync in ghcr mode means "discard what the cluster holds and
      # start from the release set again", not "build 28 images". The delta is
      # still derived below, so the changed images are shadowed back on top of
      # the freshly pulled release images.
      INCREMENTAL_REPULL_ALL=true
      INCREMENTAL_FULL_DEPLOYMENT=true
      log "Forced cluster sync in ghcr mode: re-pulling the release set, then shadowing the changed images"
    else
      INCREMENTAL_FULL_IMAGE_BUILD=true
      INCREMENTAL_FULL_IMAGE_BUILD_REASON="forced"
      log "Forced cluster sync requires the established full image build"
      return 0
    fi
  fi

  marker_git_head="$(incremental_marker_git_head)"
  if [[ ! "${marker_git_head}" =~ ^[0-9a-f]{40}$ ]] || \
     ! git -C "${PROJECT_DIR}" cat-file -e "${marker_git_head}^{commit}" 2>/dev/null; then
    if [[ "${IMAGE_SOURCE}" != "ghcr" ]]; then
      INCREMENTAL_FULL_IMAGE_BUILD=true
      INCREMENTAL_FULL_IMAGE_BUILD_REASON="no-marker"
      log "No usable cluster git marker; using the established full image build"
      return 0
    fi
    # A ghcr cluster has a second baseline the local path does not: the commit
    # its release images were built from. Without it the changed set cannot be
    # derived and no amount of building would make the cluster match the tree.
    baseline="$(incremental_release_baseline_commit)"
    # Not `-z`: anything that is not a commit id (including a diagnostic that
    # leaked onto stdout) must take the fail-closed branch, never become a
    # git revision this plan then diffs against.
    if [[ ! "${baseline}" =~ ^[0-9a-f]{40}$ ]]; then
      INCREMENTAL_FULL_IMAGE_BUILD=true
      INCREMENTAL_FULL_IMAGE_BUILD_REASON="no-baseline"
      log "No usable cluster marker, and the release images at ${IMAGE_TAG} name no commit this clone has"
      return 0
    fi
    marker_git_head="${baseline}"
    INCREMENTAL_REPULL_ALL=true
    log "No usable cluster marker; deriving the shadow set from the release images' commit ${baseline:0:12}"
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

# Every image a changed selector maps to, as `name<TAB>localRef<TAB>ghcrRef`,
# with `-` for an image ghcr cannot supply.
#
# A SELECTOR IS NOT AN IMAGE NAME. incremental_classify_path emits selectors
# like `workflow`, and build-images.sh's --only does SUBSTRING matching, so
# --only=workflow builds workflow-recipes, workflow-coordinator,
# workflow-snippet-runner and workflow-approval-request-reader. Resolving a
# selector to one name would shadow one of them and leave the rest on their
# release digests while the report claimed the whole selector was covered, so
# this matches exactly the way --only does.
incremental_shadow_refs() {
  local selector="$1" out rc
  out="$(node -e '
    import("'"${PROJECT_DIR}"'/scripts/release/images-manifest.mjs").then(m => {
      const selector = process.argv[1]
      const tag = process.argv[2]
      const publishable = new Set(m.pullInGhcrMode().map(i => i.name))
      for (const image of m.IMAGES) {
        const localRef = m.localRef(image)
        // The same substring test build-images.sh applies to --only, over both
        // the local ref and the logical name, so the two can never disagree.
        if (!localRef.includes(selector) && !image.name.includes(selector)) continue
        const ghcrRef = publishable.has(image.name)
          ? `ghcr.io/evenfire-ai/${image.name}:${tag}`
          : "-"
        process.stdout.write(`${image.name}\t${localRef}\t${ghcrRef}\n`)
      }
    }).catch(err => {
      process.stderr.write(`images-manifest read failed: ${err.message}\n`)
      process.exit(1)
    })' "${selector}" "${IMAGE_TAG}" 2>&1)"
  rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    printf '%s\n' "${out}" >&2
    return 1
  fi
  printf '%s' "${out}"
}

# Tag the freshly built local image with the exact ghcr ref the Deployment
# already references. That, and only that, is what makes IfNotPresent run the
# local build with no manifest edit.
incremental_shadow_selector() {
  local selector="$1" pairs name local_ref shadow_ref shadowed=0
  if ! pairs="$(incremental_shadow_refs "${selector}")"; then
    log "ERROR: could not resolve the shadow set for selector ${selector}; the gate would test undeployed code"
    exit 1
  fi
  if [[ -z "${pairs}" ]]; then
    # Not "nothing to do": a selector that matches no image at all means
    # incremental_classify_path emitted something build-images.sh cannot build.
    log "ERROR: image selector ${selector} matches no image in deploy/images.json"
    exit 1
  fi
  while IFS="$(printf '\t')" read -r name local_ref shadow_ref; do
    [[ -n "${name}" ]] || continue
    if [[ "${shadow_ref}" == "-" ]]; then
      # published:false images (the two E2E fixtures) run under their clerum/*
      # ref in BOTH modes, so the local build is already the running image and
      # there is nothing to shadow.
      log "  ${local_ref} has no published counterpart; the local build is what runs"
      continue
    fi
    if ! incremental_run_with_deadline incremental-image-tag \
      "${INCREMENTAL_RUNTIME_TIMEOUT_SECONDS}" \
      docker tag "${local_ref}" "${shadow_ref}"; then
      log "ERROR: could not shadow ${shadow_ref} with ${local_ref}; the gate would test undeployed code"
      exit 1
    fi
    if [[ "${MINIKUBE_MULTI_NODE:-false}" == "true" ]]; then
      incremental_run_with_deadline incremental-image-load \
        "${INCREMENTAL_IMAGE_LOAD_TIMEOUT_SECONDS}" \
        minikube -p "${PROFILE}" image load "${shadow_ref}" >/dev/null
    fi
    INCREMENTAL_SHADOWED+=("${shadow_ref} <- ${local_ref}")
    shadowed=$((shadowed + 1))
  done <<< "${pairs}"
  log "  shadowed ${shadowed} image(s) for selector ${selector}"
}

# Nobody can act on a shadow they cannot see. This is the difference between
# "the gate is green" and "the gate is green about these two images".
incremental_shadow_summary() {
  if [[ "${IMAGE_SOURCE}" != "ghcr" ]]; then
    return 0
  fi
  echo ""
  if (( ${#INCREMENTAL_SHADOWED[@]} == 0 )); then
    echo "SHADOWED: none - every image is the release build (${IMAGE_TAG})"
  else
    echo "SHADOWED (local build over release tag ${IMAGE_TAG}):"
    printf '  %s\n' "${INCREMENTAL_SHADOWED[@]}"
    echo "  Everything else is still release ${IMAGE_TAG}."
    echo "  The shadow set is discarded by the next 'make minikube-setup'."
  fi
  echo ""
}

# The one state a ghcr pre-gate cannot repair. Passing here would gate against
# code that is not deployed, and nothing downstream would report it.
incremental_abort_unshadowable() {
  local path
  log "ERROR: this pre-gate cannot make the cluster match your working tree."
  log "  mode: ghcr - every pod runs a RELEASE image (${IMAGE_TAG})"
  case "${INCREMENTAL_FULL_IMAGE_BUILD_REASON}" in
    unmapped)
      log "  reason: these changed path(s) map to no image, so there is nothing to shadow-build:"
      if (( ${#INCREMENTAL_UNMAPPED[@]} > 0 )); then
        for path in "${INCREMENTAL_UNMAPPED[@]}"; do
          log "            ${path}"
        done
      fi
      log "  fix:    map the path in scripts/minikube/pre-gate-incremental.sh, or"
      ;;
    no-baseline)
      log "  reason: no shadow baseline. The cluster marker is unusable and the release"
      log "          images at '${IMAGE_TAG}' name no org.opencontainers.image.revision"
      log "          commit this clone has, so the changed image set is unknowable."
      log "  fix:    fetch the release commit (git fetch --tags origin), or"
      ;;
    *)
      log "  reason: ${INCREMENTAL_FULL_IMAGE_BUILD_REASON:-unknown}"
      log "  fix:"
      ;;
  esac
  log "          make minikube-setup-local     # rebuild the cluster from source, then re-run this gate"
  log "Refusing to continue: the gate would pass against code that is not deployed."
  exit 1
}

incremental_build_images() {
  local target selector built="|"

  if [[ "${IMAGE_SOURCE}" == "ghcr" ]]; then
    incremental_build_images_ghcr
    return 0
  fi

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
    [[ "${built}" == *"|${selector}|"* ]] && continue
    built+="${selector}|"
    log "Building only image selector ${selector}"
    MINIKUBE_PROFILE="${PROFILE}" \
      bash "${PROJECT_DIR}/scripts/minikube/build-images.sh" "--only=${selector}"
  done
}

incremental_build_images_ghcr() {
  local target selector built="|"

  if [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == "true" ]]; then
    incremental_abort_unshadowable
  fi

  if [[ "${INCREMENTAL_REPULL_ALL}" == "true" ]]; then
    # Discard whatever the daemon holds (including shadows from an older tree)
    # and restore the release set, then shadow the changed images on top.
    log "Re-pulling the release image set (${IMAGE_TAG}) before shadowing the changed images"
    (
      cd "${PROJECT_DIR}"
      make minikube-pull-images
      make minikube-verify-images
    )
  fi

  if (( ${#INCREMENTAL_TARGETS[@]} == 0 )); then
    log "No runtime image changes detected"
    incremental_shadow_summary
    return 0
  fi

  incremental_use_minikube_docker
  log "cluster imageSource=ghcr (${IMAGE_TAG}); changed: $(incremental_target_summary)"

  for target in "${INCREMENTAL_TARGETS[@]}"; do
    selector="${target%%|*}"
    [[ "${built}" == *"|${selector}|"* ]] && continue
    built+="${selector}|"
    log "Building only image selector ${selector}"
    MINIKUBE_PROFILE="${PROFILE}" \
      bash "${PROJECT_DIR}/scripts/minikube/build-images.sh" "--only=${selector}"
    incremental_shadow_selector "${selector}"
  done

  incremental_shadow_summary
}

incremental_restart_targets() {
  local target selector remainder namespace deployment deployment_key deployment_probe
  local restarted="|"

  for target in "${INCREMENTAL_TARGETS[@]}"; do
    selector="${target%%|*}"
    remainder="${target#*|}"
    namespace="${remainder%%|*}"
    deployment="${remainder#*|}"
    deployment_key="|${namespace}/${deployment}|"

    [[ "${restarted}" == *"${deployment_key}"* ]] && continue
    restarted+="${namespace}/${deployment}|"
    deployment_probe=""
    if ! deployment_probe="$(${KC} get deployment "${deployment}" -n "${namespace}" 2>&1)"; then
      if [[ "${deployment_probe}" == *NotFound* || "${deployment_probe}" == *"not found"* ]]; then
        log "Skipping absent ${namespace}/${deployment} for image selector ${selector}"
        continue
      fi
      log "ERROR: unable to inspect ${namespace}/${deployment} for image selector ${selector}: ${deployment_probe}"
      return 1
    fi
    ${KC} rollout restart "deployment/${deployment}" -n "${namespace}" >/dev/null
    log "Restarted ${namespace}/${deployment} for image selector ${selector}"
    if [[ "${namespace}/${deployment}" == "gfs/gfsc-reader" ]]; then
      # HCC owns the reader template and strips kubectl's restartedAt
      # annotation. The canonical shim judges Ready replicas/pods instead of
      # waiting forever on a deployment generation HCC can rewrite.
      PATH="${PROJECT_DIR}/scripts/minikube/gfs-rollout-shim:${PATH}" \
        CONTEXT="${PROFILE}" ${KC} rollout status "deployment/${deployment}" \
          -n "${namespace}" --timeout=120s >/dev/null
    else
      rollout_if_present "${namespace}" "${deployment}"
    fi
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
