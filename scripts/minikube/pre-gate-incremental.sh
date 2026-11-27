#!/usr/bin/env bash

# Incremental image planning for pre-gate-sync.sh. The caller supplies
# PROJECT_DIR, PROFILE, KC, CLUSTER_SYNC_STATE_CONFIGMAP, FORCE_CLUSTER_SYNC,
# IMAGE_SOURCE, IMAGE_TAG, IMAGES_GENERATED_AT, log(), and rollout_if_present().
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
# The cluster sync marker as incremental_read_marker last read it.
INCREMENTAL_MARKER_PRESENT=false
INCREMENTAL_MARKER_GIT_HEAD=""
INCREMENTAL_MARKER_IMAGES_GENERATED_AT=""
INCREMENTAL_MARKER_IMAGE_SOURCE=""
INCREMENTAL_MARKER_IMAGE_TAG=""
INCREMENTAL_MARKER_UNCOMMITTED_PATH_COUNT=""
INCREMENTAL_MARKER_UNCOMMITTED_PATHS=""
# Paths that differed from HEAD when this run planned. pre-gate-sync.sh stamps
# them in the marker with the ones that differ when it stamps.
INCREMENTAL_UNCOMMITTED_PATHS=""

# The image manifest's recorded coordinate is the second record of what the
# cluster was rendered at (incremental_unproven_render).
# shellcheck source=scripts/minikube/image-mode.sh
source "${PROJECT_DIR}/scripts/minikube/image-mode.sh"

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
  # The `+` expansion keeps an empty array valid under `set -u` on bash 3.2.
  for existing in ${INCREMENTAL_TARGETS[@]+"${INCREMENTAL_TARGETS[@]}"}; do
    [[ "${existing}" == "${target}" ]] && return 0
  done
  INCREMENTAL_TARGETS+=("${target}")
}

# One field of the cluster sync marker. Returns 0 with the value, 3 when the
# marker does not exist, and 1 on any other read error, so no caller can read a
# failed read as "no marker".
incremental_marker_field() {
  local field="$1" output
  if output="$(${KC} get configmap "${CLUSTER_SYNC_STATE_CONFIGMAP}" -n control-plane \
    -o "jsonpath={.data.${field}}" 2>&1)"; then
    printf '%s' "${output}"
    return 0
  fi
  if [[ "${output}" == *NotFound* || "${output}" == *"not found"* ]]; then
    return 3
  fi
  log "WARNING: unable to read ${CLUSTER_SYNC_STATE_CONFIGMAP}.${field}: ${output}" >&2
  return 1
}

# Fills the INCREMENTAL_MARKER_* fields. Fails on a read error; a missing marker
# is a successful read with INCREMENTAL_MARKER_PRESENT=false.
incremental_read_marker() {
  local field value rc
  INCREMENTAL_MARKER_PRESENT=false
  INCREMENTAL_MARKER_GIT_HEAD=""
  INCREMENTAL_MARKER_IMAGES_GENERATED_AT=""
  INCREMENTAL_MARKER_IMAGE_SOURCE=""
  INCREMENTAL_MARKER_IMAGE_TAG=""
  INCREMENTAL_MARKER_UNCOMMITTED_PATH_COUNT=""
  INCREMENTAL_MARKER_UNCOMMITTED_PATHS=""
  for field in gitHead imagesGeneratedAt imageSource imageTag \
               uncommittedPathCount uncommittedPaths; do
    rc=0
    value="$(incremental_marker_field "${field}")" || rc=$?
    case "${rc}" in
      0) ;;
      3) return 0 ;;
      *) return 1 ;;
    esac
    case "${field}" in
      gitHead) INCREMENTAL_MARKER_GIT_HEAD="${value}" ;;
      imagesGeneratedAt) INCREMENTAL_MARKER_IMAGES_GENERATED_AT="${value}" ;;
      imageSource) INCREMENTAL_MARKER_IMAGE_SOURCE="${value}" ;;
      imageTag) INCREMENTAL_MARKER_IMAGE_TAG="${value}" ;;
      uncommittedPathCount) INCREMENTAL_MARKER_UNCOMMITTED_PATH_COUNT="${value}" ;;
      uncommittedPaths) INCREMENTAL_MARKER_UNCOMMITTED_PATHS="${value}" ;;
    esac
  done
  INCREMENTAL_MARKER_PRESENT=true
}

# The commit the cluster's images were last synced to, or nothing, from the
# fields incremental_read_marker filled.
#
# The marker is only a usable baseline while the image set it was stamped
# against is still the set the profile can prove. Both a GHCR acquisition and a
# local build can replace image IDs without changing gitHead; trusting that
# head after a newer acquisition would compute an empty delta and gate without
# proving that the running pods use the newly acquired images. A stamp mismatch
# therefore invalidates the baseline in every image mode; the caller chooses
# the established full local build or GHCR recovery path below. So does a
# different image coordinate: a marker stamped at another tag describes shadows
# over another release, not over the one this run resolves.
#
# gitHead names only the commit. The images the stamping sync built also carry
# every path that was uncommitted then, which the marker lists with their count.
# The count is "0" on a clean stamp, so a marker without one (stamped before
# the list existed) or a list that does not match it cannot be a baseline.
incremental_marker_baseline() {
  if [[ "${INCREMENTAL_MARKER_PRESENT}" != "true" || -z "${INCREMENTAL_MARKER_GIT_HEAD}" ]]; then
    return 0
  fi
  if [[ -z "${INCREMENTAL_MARKER_IMAGES_GENERATED_AT}" || -z "${IMAGES_GENERATED_AT:-}" ||
        "${INCREMENTAL_MARKER_IMAGES_GENERATED_AT}" != "${IMAGES_GENERATED_AT}" ]]; then
    return 0
  fi
  if [[ "${INCREMENTAL_MARKER_IMAGE_SOURCE}" != "${IMAGE_SOURCE}" ||
        "${INCREMENTAL_MARKER_IMAGE_TAG}" != "${IMAGE_TAG:-}" ]]; then
    return 0
  fi
  if [[ ! "${INCREMENTAL_MARKER_UNCOMMITTED_PATH_COUNT}" =~ ^[0-9]+$ ||
        "$(incremental_count_lines "${INCREMENTAL_MARKER_UNCOMMITTED_PATHS}")" != \
          "${INCREMENTAL_MARKER_UNCOMMITTED_PATH_COUNT}" ]]; then
    return 0
  fi
  printf '%s' "${INCREMENTAL_MARKER_GIT_HEAD}"
}

# The number of non-empty lines in $1.
incremental_count_lines() {
  local text="$1" line count=0
  while IFS= read -r line; do
    if [[ -n "${line}" ]]; then
      count=$((count + 1))
    fi
  done <<< "${text}"
  printf '%s' "${count}"
}

# Reads the marker and prints its usable baseline, or nothing. A read error
# prints nothing: with no baseline the plan takes the full local build or the
# ghcr re-pull, which assume nothing about what the cluster runs.
incremental_marker_git_head() {
  incremental_read_marker || return 0
  incremental_marker_baseline
}

# Why the cluster's Deployments may not be rendered at ghcr:<IMAGE_TAG>, as
# `<record>=<imageSource>:<imageTag>`, or nothing when every record agrees.
#
# Only a render moves a Deployment to another tag: a re-pull or a shadow build
# leaves every pod on the tag it was deployed with. Two records name a render.
# The last sync stamped its own in the marker. The last image acquisition wrote
# its coordinate to the image manifest: setup renders what it pulls, but a bare
# pull renders nothing, so after an acquisition at another tag either record may
# be the live one. Both must name the coordinate this run resolves.
incremental_unproven_render() {
  local want="ghcr:${IMAGE_TAG}" source tag
  if [[ "${INCREMENTAL_MARKER_PRESENT}" == "true" &&
        "${INCREMENTAL_MARKER_IMAGE_SOURCE}:${INCREMENTAL_MARKER_IMAGE_TAG}" != "${want}" ]]; then
    printf 'marker=%s:%s' "${INCREMENTAL_MARKER_IMAGE_SOURCE}" "${INCREMENTAL_MARKER_IMAGE_TAG}"
    return 0
  fi
  # image_mode_read_manifest has already named the unreadable file on stderr.
  if ! source="$(image_mode_manifest_field "${PROJECT_DIR}" 1)" ||
     ! tag="$(image_mode_manifest_field "${PROJECT_DIR}" 2)"; then
    printf 'manifest=unreadable'
    return 0
  fi
  if [[ "${source}:${tag}" != "${want}" ]]; then
    printf 'manifest=%s:%s' "${source}" "${tag}"
  fi
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
    packages/jwt-key-policy/*)
      # All three images consume this one policy/store package. Package-only
      # changes must rebuild each consumer, including GHCR shadow builds.
      incremental_add_target control-api control-plane control-api
      incremental_add_target external-rest-api profiles external-rest-api
      incremental_add_target rpc-proxy rpc-proxy rpc-proxy
      ;;
    packages/gfs-interaction-policy/*)
      # Control UI imports the GFS naming policy and mcp-host imports the
      # FileReference v1 contract and byte classifier; both Dockerfiles COPY
      # the package, so a change here changes exactly those two image outputs.
      incremental_add_target control-ui control-plane control-ui
      incremental_add_target mcp-host mcp-host chatllm
      ;;
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
    grok-llm-proxy/*) incremental_add_target grok-llm-proxy control-plane grok-llm-proxy ;;
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
  local marker_git_head="" path baseline marker_read=ok unproven
  local previously_uncommitted=""

  # Before any early return: every plan, including a full build, leaves the
  # list pre-gate-sync.sh stamps in the marker.
  if ! INCREMENTAL_UNCOMMITTED_PATHS="$(incremental_uncommitted_paths)"; then
    exit 1
  fi

  if [[ "${FORCE_CLUSTER_SYNC}" == "true" ]]; then
    if [[ "${IMAGE_SOURCE}" == "ghcr" ]]; then
      # A forced sync in ghcr mode means "discard what the cluster holds and
      # start from the release set again", not "build 28 images". The delta is
      # still derived below, from the release images' commit, so the changed
      # images are shadowed back on top of the freshly pulled release images.
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

  # A failed read leaves no baseline and no proven render, so the plan below
  # takes the paths that assume nothing about what the cluster runs.
  if ! incremental_read_marker; then
    marker_read=failed
  fi

  # A ghcr Deployment names its release tag, and only a render changes it. When
  # this run resolves a tag the cluster was not rendered at (a MINIKUBE_IMAGE_TAG
  # override, or a coordinate nothing can prove), re-pulling and shadowing are
  # not enough: the pods would keep the old tag under a marker naming the new.
  if [[ "${IMAGE_SOURCE}" == "ghcr" ]]; then
    if [[ "${marker_read}" != "ok" ]]; then
      unproven="marker=unreadable"
    else
      unproven="$(incremental_unproven_render)"
    fi
    if [[ -n "${unproven}" ]]; then
      INCREMENTAL_REPULL_ALL=true
      INCREMENTAL_FULL_DEPLOYMENT=true
      log "Cluster render at ghcr:${IMAGE_TAG} is unproven (${unproven}); re-pulling and re-deploying the release set"
    fi
  fi

  # A re-pull discards every shadow earlier syncs built. The cluster then runs
  # the release set, so the delta must start from that set's commit, not from
  # the marker's gitHead.
  if [[ "${marker_read}" == "ok" && "${INCREMENTAL_REPULL_ALL}" != "true" ]]; then
    marker_git_head="$(incremental_marker_baseline)"
    # The cluster runs what the marker's sync built, including the paths that
    # were uncommitted then. Each one is part of the delta even when it has
    # since been reverted to its committed content.
    previously_uncommitted="${INCREMENTAL_MARKER_UNCOMMITTED_PATHS}"
  fi
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
      log "No usable marker baseline, and the release images at ${IMAGE_TAG} name no commit this clone has"
      return 0
    fi
    marker_git_head="${baseline}"
    # The re-pull discards everything the marker's sync built.
    previously_uncommitted=""
    INCREMENTAL_REPULL_ALL=true
    log "No usable marker baseline; deriving the shadow set from the release images' commit ${baseline:0:12}"
  fi

  # Each read is checked before the plan iterates. Read as empty, an unreadable
  # delta means "nothing changed": the sync would skip the build, the database
  # reconcile and the GFS verification, then stamp a marker over images it never
  # compared with the tree.
  local committed
  if ! committed="$(git -C "${PROJECT_DIR}" diff --name-only "${marker_git_head}" HEAD)"; then
    log "ERROR: PLAN_INPUT_UNREADABLE: git diff ${marker_git_head:0:12}..HEAD failed; refusing to plan from an empty delta" >&2
    exit 1
  fi
  while IFS= read -r path; do
    [[ -z "${path}" ]] || incremental_classify_path "${path}"
  done < <(printf '%s\n%s\n%s\n' "${committed}" "${INCREMENTAL_UNCOMMITTED_PATHS}" \
             "${previously_uncommitted}" | LC_ALL=C sort -u)
}

# Every path whose working-tree content differs from HEAD: tracked edits, staged
# or not, and untracked files git does not ignore. Logs to stderr because callers
# capture stdout as the list. An unreadable list is not an empty one.
incremental_uncommitted_paths() {
  local tracked untracked
  if ! tracked="$(git -C "${PROJECT_DIR}" diff --name-only HEAD)"; then
    log "ERROR: PLAN_INPUT_UNREADABLE: git diff HEAD failed; the working-tree changes are unknown" >&2
    return 1
  fi
  if ! untracked="$(git -C "${PROJECT_DIR}" ls-files --others --exclude-standard)"; then
    log "ERROR: PLAN_INPUT_UNREADABLE: git ls-files failed; the untracked files are unknown" >&2
    return 1
  fi
  printf '%s\n%s\n' "${tracked}" "${untracked}" | LC_ALL=C sort -u | awk 'length'
}

# The paths the marker must list: those uncommitted when this run planned (its
# builds may hold their content even if they are reverted by now) and those
# uncommitted when it stamps. Fails when the working tree cannot be read.
incremental_uncommitted_paths_to_stamp() {
  local now
  if ! now="$(incremental_uncommitted_paths)"; then
    return 1
  fi
  printf '%s\n%s\n' "${INCREMENTAL_UNCOMMITTED_PATHS}" "${now}" | LC_ALL=C sort -u | awk 'length'
}

incremental_has_target() {
  local selector="$1" target
  for target in ${INCREMENTAL_TARGETS[@]+"${INCREMENTAL_TARGETS[@]}"}; do
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
      # pre-gate-sync already holds the profile lock; the target's lock wrapper
      # must validate that lease instead of acquiring it again (PROFILE_BUSY).
      # minikube-verify-images has no lock wrapper and needs no lease.
      T2_SKIP_LOCK=true T2_LOCK_TOKEN="${T2_LOCK_TOKEN}" make minikube-build-images
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
      # Same inherited lease as the full local build above.
      T2_SKIP_LOCK=true T2_LOCK_TOKEN="${T2_LOCK_TOKEN}" make minikube-pull-images
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
  local restart_rpc_proxy=false restart_hcc=false
  local -a restart_hosts=()
  local restart_hosts_count=0

  for target in ${INCREMENTAL_TARGETS[@]+"${INCREMENTAL_TARGETS[@]}"}; do
    selector="${target%%|*}"
    remainder="${target#*|}"
    namespace="${remainder%%|*}"
    deployment="${remainder#*|}"
    deployment_key="|${namespace}/${deployment}|"

    # These three workloads form one protocol transition. Defer them until
    # after independent service restarts so the RPC Proxy / HCC / Host order is
    # selected by the explicit cohort barrier below.
    case "${namespace}/${deployment}" in
      rpc-proxy/rpc-proxy) restart_rpc_proxy=true; continue ;;
      control-plane/host-context-controller) restart_hcc=true; continue ;;
      mcp-host/*)
        restart_hosts+=("${deployment}")
        restart_hosts_count=$((restart_hosts_count + 1))
        continue
        ;;
    esac

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
      # HCC now preserves kubectl's restartedAt. The canonical shim still
      # judges Ready replicas/pods because leftover ReplicaSets can poison a
      # generation-based wait.
      PATH="${PROJECT_DIR}/scripts/minikube/gfs-rollout-shim:${PATH}" \
        CONTEXT="${PROFILE}" ${KC} rollout status "deployment/${deployment}" \
          -n "${namespace}" --timeout=120s >/dev/null
    else
      rollout_if_present "${namespace}" "${deployment}"
    fi
  done

  if [[ "${restart_rpc_proxy}" == true || "${restart_hcc}" == true ||
        "${restart_hosts_count}" -gt 0 ]]; then
    local -a edge_args=(restart-targets --context "${PROFILE}")
    [[ "${restart_rpc_proxy}" != true ]] || edge_args+=(--restart-proxy)
    [[ "${restart_hcc}" != true ]] || edge_args+=(--restart-hcc)
    local host_target
    for host_target in ${restart_hosts[@]+"${restart_hosts[@]}"}; do
      edge_args+=(--restart-host "${host_target}")
    done
    bash "${PROJECT_DIR}/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
      "${edge_args[@]}"
  fi
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
  for target in ${INCREMENTAL_TARGETS[@]+"${INCREMENTAL_TARGETS[@]}"}; do
    selector="${target%%|*}"
    summary+="${summary:+, }${selector}"
  done
  printf '%s' "${summary:-none}"
}
