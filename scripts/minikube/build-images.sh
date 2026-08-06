#!/usr/bin/env bash
# ======================================================================
# Build & Load Docker Images for Minikube
# ======================================================================
#
# Builds all Clerum services for minikube. Single-node profiles build directly
# inside minikube's Docker daemon with `eval $(minikube docker-env)`. Multi-node
# profiles cannot use docker-env, so they build in the host Docker daemon and
# then use `minikube image load` to place the same image tags on every node.
#
# After building, SHA digests are verified and a manifest JSON is
# generated for post-deploy validation.
#
# NOTE: WRC produces TWO images from separate Dockerfiles:
#   clerum/workflow-recipes:test   <- Dockerfile (WRC server)
#   clerum/workflow-coordinator:test <- Dockerfile.coordinator (workflow pod)
#   clerum/workflow-snippet-runner:test <- Dockerfile (platform snippet runner)
# E2E also builds a custom coordinator fixture image:
#   clerum/workflow-custom-sdk-e2e:test <- tests/e2e/fixtures/custom-workflow-coordinator/Dockerfile
#   clerum/workflow-plugin-sdk-e2e:test <- tests/e2e/fixtures/workflow-plugin-sdk-e2e/Dockerfile
#
# Usage:
#   MINIKUBE_PROFILE=clerum-test ./scripts/minikube/build-images.sh [--skip-public] [--skip-uis] [--verify-only] [--public-only] [--only=<svc>]
#
# Options:
#   --skip-public   Skip pulling/loading public images (postgres, redis, etc.)
#   --skip-uis      Skip Control UI, Profile UI, and Desktop App images.
#   --verify-only   Only verify image SHAs are present in minikube
#   --public-only   Load only the public third-party images (postgres, redis,
#                   nginx, ...) and build nothing. The IMAGE_SOURCE=ghcr path
#                   needs them: no clerum build runs there to pull them in.
#   --only=<svc>    Build only the image(s) whose tag matches the substring <svc>
#                   (e.g. --only=control-api, --only=workflow-recipes). Skips
#                   public-image pulls and manifest regeneration.
#   --include-e2e-fixtures
#                  --verify-only: also demand the two E2E-only fixtures
#                  (workflow-custom-sdk-e2e, workflow-plugin-sdk-e2e) in ghcr
#                  mode. Only `make minikube-setup-e2e` builds them there, so
#                  the default ghcr verify set leaves them out.
#                  MINIKUBE_SEED_PROFILE=e2e implies this.
#   --include-desktop-image
#                  Include clerum/mcp-host-desktop:test in full builds.
#   --include-playwright-mcp-image
#                  Include the heavy playwright MCP image in full builds.
#   --include-airtable-mcp-image
#                  Include clerum/airtable-mcp-server:test in full builds. The
#                  registry distributes this connector, so no default setup
#                  needs it; the SEED_PROFILE=e2e demo McpServer instance does.
#
# Env:
#   MINIKUBE_PRELOAD_BASE_IMAGES=false  Skip preloading Dockerfile base images
#                                      from the host Docker cache into minikube.
#   MINIKUBE_BASE_IMAGE_PULL_RETRIES    Pull attempts for each missing base
#                                      image before failing (default: 3).
#   MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS Delay between failed pull attempts
#                                      (default: 5).
#   MINIKUBE_BUILD_DESKTOP_IMAGE=true  Include the heavy mcp-host-desktop
#                                      image. It is excluded from normal
#                                      runtime gates unless explicitly needed.
#   MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE=true
#                                      Include the optional local Playwright MCP
#                                      image. It is excluded from normal setup
#                                      because minikube does not deploy it by
#                                      default and GKE publishes it as
#                                      playwright-server:<tag>.
#   MINIKUBE_REUSE_PLAYWRIGHT_MCP_IMAGE=false
#                                      Build the optional Playwright MCP image
#                                      locally instead of reusing the published
#                                      Artifact Registry image.
#   MINIKUBE_PLAYWRIGHT_MCP_SOURCE_IMAGE
#                                      Published image to retag locally when
#                                      Playwright MCP is explicitly enabled.
#   MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE=true
#                                      Include the optional local Airtable MCP
#                                      image. MCP servers are distributed via
#                                      the evenfire registry and installed on
#                                      demand -- a registry install writes a
#                                      fully-qualified imageRef the kubelet
#                                      pulls, so nothing on the default path
#                                      needs a locally loaded clerum/* alias.
#                                      Only the SEED_PROFILE=e2e demo instance
#                                      (deploy/overlays/minikube/instances-e2e/
#                                      airtable-server.yaml) still names the
#                                      local ref, and full-setup.sh sets this
#                                      flag for exactly that case.
# ======================================================================

set -euo pipefail

export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
SKIP_PUBLIC=false
VERIFY_ONLY=false
PUBLIC_ONLY=false
ONLY_SVC=""
FAILED_IMAGES=()
MINIKUBE_PRELOAD_BASE_IMAGES="${MINIKUBE_PRELOAD_BASE_IMAGES:-true}"
MINIKUBE_BASE_IMAGE_PULL_RETRIES="${MINIKUBE_BASE_IMAGE_PULL_RETRIES:-3}"
MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS="${MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS:-5}"
MINIKUBE_BUILD_DESKTOP_IMAGE="${MINIKUBE_BUILD_DESKTOP_IMAGE:-false}"
MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE="${MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE:-false}"
MINIKUBE_REUSE_PLAYWRIGHT_MCP_IMAGE="${MINIKUBE_REUSE_PLAYWRIGHT_MCP_IMAGE:-true}"
MINIKUBE_PLAYWRIGHT_MCP_SOURCE_IMAGE="${MINIKUBE_PLAYWRIGHT_MCP_SOURCE_IMAGE:-us-central1-docker.pkg.dev/your-gcp-project/clerum/playwright-server:latest}"
MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE="${MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE:-false}"
SKIP_UIS="${MINIKUBE_SKIP_UIS:-false}"

case "${SKIP_UIS}" in
  true|1|yes) SKIP_UIS=true ;;
  *) SKIP_UIS=false ;;
esac

# Which refs --verify-only checks. The BUILD path is unaffected: this script
# always builds clerum/* locally when asked to build. In ghcr mode the cluster
# runs ghcr.io/evenfire-ai/* refs (deploy/components/ghcr-images), so verifying
# clerum/* would report "all images present" against images no pod references.
#
# This env var is only the FALLBACK for --verify-only. What a cluster actually
# runs is decided by whichever writer last performed a full image acquisition,
# and that is recorded in .image-manifest.json (see recorded_image_source
# below). Trusting the env default here is what made `make minikube-verify-
# images` report "25 of 28 images missing" on a healthy locally built cluster.
IMAGE_SOURCE="${IMAGE_SOURCE:-ghcr}"
case "$IMAGE_SOURCE" in
  ghcr|local) ;;
  *) echo "Unknown IMAGE_SOURCE: '${IMAGE_SOURCE}' (expected: ghcr | local)" >&2; exit 1 ;;
esac
GHCR_NAMESPACE="ghcr.io/evenfire-ai"
GHCR_COMPONENT="${PROJECT_DIR}/deploy/components/ghcr-images/kustomization.yaml"

# Written by this script's manifest writer and by pull-images.sh; read back by
# --verify-only. Declared here, not next to the writer at the bottom, because
# the verify path (which exits before the writer) needs it too.
MANIFEST_FILE="${PROJECT_DIR}/deploy/minikube/.image-manifest.json"

# The mode the cluster's images were actually acquired in. Prints nothing when
# the manifest is absent, unparseable, or records anything other than
# ghcr|local -- callers then fall back to the IMAGE_SOURCE env var.
#
# ONE reader, shared with scripts/minikube/pre-gate-sync.sh through
# scripts/minikube/image-mode.sh. A second copy here would let the verify path
# and the pre-gate disagree about what the cluster is running, which is the
# exact failure this key exists to prevent.
# shellcheck source=scripts/minikube/image-mode.sh
source "${SCRIPT_DIR}/image-mode.sh"

recorded_image_source() {
  image_mode_recorded_source "$PROJECT_DIR"
}

recorded_image_tag() {
  image_mode_manifest_field "$PROJECT_DIR" 2
}

# The two E2E-only fixtures are built by `make minikube-setup-e2e` alone, which
# sets SEED_PROFILE=e2e. Honour that as well as the explicit flag so a verify
# run after an e2e setup checks what that setup actually built.
INCLUDE_E2E_FIXTURES=false
if [ "${MINIKUBE_SEED_PROFILE:-}" = "e2e" ]; then
  INCLUDE_E2E_FIXTURES=true
fi

# The effective ghcr tag: MINIKUBE_IMAGE_TAG if set (a render-time operator
# lever), otherwise the committed pin, which is the single source of truth.
resolve_ghcr_tag() {
  if [ -n "${MINIKUBE_IMAGE_TAG:-}" ]; then
    printf '%s' "$MINIKUBE_IMAGE_TAG"
    return 0
  fi
  [ -f "$GHCR_COMPONENT" ] || { echo "ghcr component not found at ${GHCR_COMPONENT}" >&2; exit 1; }
  local tags
  tags="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$GHCR_COMPONENT" | sort -u)"
  [ -n "$tags" ] || { echo "no newTag: line in ${GHCR_COMPONENT}" >&2; exit 1; }
  [ "$(printf '%s\n' "$tags" | wc -l | tr -d ' ')" = "1" ] \
    || { echo "mixed newTag values in ${GHCR_COMPONENT}: $(printf '%s ' $tags)" >&2; exit 1; }
  printf '%s' "$tags"
}

for arg in "$@"; do
  case "$arg" in
    --skip-public) SKIP_PUBLIC=true ;;
    --skip-uis) SKIP_UIS=true ;;
    --verify-only) VERIFY_ONLY=true ;;
    --public-only) PUBLIC_ONLY=true ;;
    --only=*) ONLY_SVC="${arg#--only=}" ;;
    --include-e2e-fixtures) INCLUDE_E2E_FIXTURES=true ;;
    --include-desktop-image) MINIKUBE_BUILD_DESKTOP_IMAGE=true ;;
    --include-playwright-mcp-image) MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE=true ;;
    --include-airtable-mcp-image) MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE=true ;;
  esac
done

# When --only is set we skip public-image pulls and manifest regen.
if [ -n "$ONLY_SVC" ]; then
  SKIP_PUBLIC=true
  if [[ "$ONLY_SVC" == *"mcp-host-desktop"* ]]; then
    MINIKUBE_BUILD_DESKTOP_IMAGE=true
  fi
  if [[ "$ONLY_SVC" == *"playwright"* ]]; then
    MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE=true
  fi
  # Same self-enabling rule the two opt-in images above already use: naming an
  # image in --only IS the opt-in. Without this, `--only=airtable-mcp-server`
  # would print the "skipping the optional Airtable MCP image" warning and exit
  # 0 having built nothing -- a silent no-op in the one place that asks for it.
  if [[ "$ONLY_SVC" == *"airtable"* ]]; then
    MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE=true
  fi
fi

if [ "$SKIP_UIS" = true ]; then
  MINIKUBE_BUILD_DESKTOP_IMAGE=false
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${CYAN}[BUILD]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*"; }

# Verify minikube is running
if ! minikube -p "$PROFILE" status &>/dev/null; then
  err "Minikube profile '${PROFILE}' is not running. Start with: minikube start -p ${PROFILE}"
  exit 1
fi

minikube_node_count() {
  kubectl --context "$PROFILE" get nodes --no-headers 2>/dev/null | wc -l | tr -d '[:space:]'
}

MINIKUBE_NODE_COUNT="$(minikube_node_count)"
if [[ -z "$MINIKUBE_NODE_COUNT" || "$MINIKUBE_NODE_COUNT" == "0" ]]; then
  err "Unable to list nodes for minikube profile '${PROFILE}'"
  exit 1
fi

MINIKUBE_MULTI_NODE=false
if [ "$MINIKUBE_NODE_COUNT" -gt 1 ]; then
  MINIKUBE_MULTI_NODE=true
  warn "Detected ${MINIKUBE_NODE_COUNT}-node minikube profile; building images on all nodes"
fi

# Docker builds run inside minikube's Docker daemon, while developers often
# already have large base images cached in the host Docker daemon. Preloading
# them avoids repeated BuildKit metadata/blob downloads from Docker Hub during
# pre-gate sync, which can fail on transient Cloudflare/R2 timeouts.
BUILD_BASE_IMAGES=(
  "node:24-alpine"
  "node:24"
  "node:24-slim"
  "nginx:1.30.1-alpine"
)

normalize_minikube_image_tag() {
  local image=$1
  if [[ "$image" != */* ]]; then
    local repository=${image%%:*}
    local tag=${image#*:}
    printf 'docker.io/library/%s:%s' "$repository" "$tag"
    return 0
  fi

  local registry="${image%%/*}"
  if [[ "$registry" != *.* && "$registry" != *:* && "$registry" != "localhost" ]]; then
    printf 'docker.io/%s' "$image"
    return 0
  fi

  printf '%s' "$image"
}

minikube_image_present() {
  local image=$1
  local normalized
  normalized="$(normalize_minikube_image_tag "$image")"
  minikube -p "$PROFILE" image ls 2>/dev/null | grep -Fxq "$normalized"
}

minikube_image_id() {
  local image=$1
  local normalized
  normalized="$(normalize_minikube_image_tag "$image")"
  # shellcheck disable=SC2016
  minikube -p "$PROFILE" image ls --format=json 2>/dev/null \
    | node -e '
const tag = process.argv[1]
let items = []
try { items = JSON.parse(require("fs").readFileSync(0, "utf8")) } catch {}
const hit = items.find((item) => Array.isArray(item.repoTags) && item.repoTags.includes(tag))
process.stdout.write(hit?.id ? `sha256:${hit.id}` : "NOT_FOUND")
' "$normalized"
}

pull_host_image_with_retry() {
  local image=$1
  local attempt=1
  while [ "$attempt" -le "$MINIKUBE_BASE_IMAGE_PULL_RETRIES" ]; do
    if docker pull "$image"; then
      return 0
    fi
    if [ "$attempt" -lt "$MINIKUBE_BASE_IMAGE_PULL_RETRIES" ]; then
      warn "Pull failed for ${image} (attempt ${attempt}/${MINIKUBE_BASE_IMAGE_PULL_RETRIES}); retrying in ${MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS}s"
      sleep "$MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

ensure_base_images_in_minikube() {
  if [ "$MINIKUBE_PRELOAD_BASE_IMAGES" = "false" ]; then
    warn "Skipping base image preload (MINIKUBE_PRELOAD_BASE_IMAGES=false)"
    return 0
  fi

  echo -e "\n${BOLD}=== Ensuring Build Base Images ===${NC}"
  for image in "${BUILD_BASE_IMAGES[@]}"; do
    if minikube_image_present "$image"; then
      ok "${image} already present in minikube"
      continue
    fi

    if ! docker image inspect "$image" >/dev/null 2>&1; then
      log "Pulling base image '${image}' into host Docker cache..."
      pull_host_image_with_retry "$image"
    fi

    log "Loading base image '${image}' into minikube '${PROFILE}'..."
    minikube -p "$PROFILE" image load "$image" >/dev/null
    ok "${image} loaded into minikube"
  done
}

if [ "$VERIFY_ONLY" = false ]; then
  ensure_base_images_in_minikube
fi

# ---- Point Docker CLI at minikube's Docker daemon when safe ----
if [ "$MINIKUBE_MULTI_NODE" = false ]; then
  # This makes `docker build` execute INSIDE minikube — no image transfer needed.
  log "Configuring Docker CLI to use minikube's Docker daemon..."
  eval "$(minikube -p "$PROFILE" docker-env)"
  # Let Docker negotiate API version automatically (minikube v1.38+ requires >=1.44)
  unset DOCKER_API_VERSION 2>/dev/null || true
  ok "Docker CLI now targets minikube '${PROFILE}'"
else
  log "Skipping docker-env; multi-node profiles use host builds plus 'minikube image load'"
fi

# All images built in this session. Every entry here must have a matching
# row in deploy/images.json (via localRef()) -- scripts/tests/test-images-
# manifest.sh enforces it.
ALL_IMAGES=(
  "clerum/host-context-controller:test"
  "clerum/workflow-recipes:test"
  "clerum/workflow-coordinator:test"
  "clerum/workflow-snippet-runner:test"
  "clerum/workflow-custom-sdk-e2e:test"
  "clerum/workflow-plugin-sdk-e2e:test"
  "clerum/mcp-host:test"
  "clerum/mcp-host-slim:test"
  "clerum/mcp-host-full:test"
  "clerum/mcp-proxy:test"
  "clerum/nginx-egress-proxy:test"
  "clerum/gfs-controller:test"
  "clerum/control-api:test"
  "clerum/external-rest-api:test"
  "clerum/rpc-proxy:test"
  "clerum/webhook-proxy:test"
  "clerum/webhook-gateway:test"
  "clerum/channel-reader:test"
  "clerum/workflow-approval-request-reader:test"
  "clerum/stdio-bridge:test"
  "clerum/control-ui:test"
  "clerum/profile-ui:test"
  "clerum/mock-mcp-server:test"
  "clerum/mock-stdio-mcp-server:test"
  "clerum/workspace-files-controller:test"
)

if [ "$MINIKUBE_BUILD_DESKTOP_IMAGE" = "true" ]; then
  ALL_IMAGES+=("clerum/mcp-host-desktop:test")
fi

if [ "$MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE" = "true" ]; then
  ALL_IMAGES+=("clerum/playwright-mcp-server:test")
fi

if [ "$MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE" = "true" ]; then
  ALL_IMAGES+=("clerum/airtable-mcp-server:test")
fi

if [ "$SKIP_UIS" = true ]; then
  FILTERED_IMAGES=()
  for image in "${ALL_IMAGES[@]}"; do
    case "$image" in
      clerum/control-ui:*|clerum/profile-ui:*) continue ;;
      *) FILTERED_IMAGES+=("$image") ;;
    esac
  done
  ALL_IMAGES=("${FILTERED_IMAGES[@]}")
fi

# ---- Verify-only mode ----
# The verify set is NOT ALL_IMAGES. ALL_IMAGES is the BUILD list (its ordering
# and Dockerfile arguments are hand-written per call). What must be verified is
# the ref each pod will actually pull, which splits on `published`, not on the
# mode: a published+deployed image runs from ghcr in ghcr mode, and the
# unpublished ones are built locally and verified under their clerum/* ref.
#
# The two e2e_only fixtures are NOT verified on the default ghcr path: nothing
# builds them there, so demanding them fails a healthy default cluster with a
# remedy that can never supply them (they are published:false, so no pull can
# fetch them). They come back with --include-e2e-fixtures /
# MINIKUBE_SEED_PROFILE=e2e, and in local mode, where a full build builds every
# fixture.
#
# The registry-distributed MCP servers (airtable-mcp-server, web-search-mcp,
# doc-generator-mcp) are absent from this set entirely, because they are
# deployed_to_minikube:false -- minikube setup neither builds nor pulls them,
# so demanding them would fail every cluster. airtable-mcp-server is an opt-in
# local build (MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE) for the SEED_PROFILE=e2e demo
# instance; like mcp-host-desktop and playwright-server before it, an opt-in
# image is not part of the verify contract.
if [ "$VERIFY_ONLY" = true ]; then
  # What the cluster RUNS decides what gets verified. The env var is only a
  # fallback for a cluster nothing has built or pulled into yet.
  VERIFY_SOURCE_ORIGIN="the IMAGE_SOURCE environment variable (no image manifest yet)"
  RECORDED_IMAGE_SOURCE="$(recorded_image_source)"
  if [ -n "$RECORDED_IMAGE_SOURCE" ]; then
    if [ "$RECORDED_IMAGE_SOURCE" != "$IMAGE_SOURCE" ]; then
      log "deploy/minikube/.image-manifest.json records imageSource=${RECORDED_IMAGE_SOURCE};"
      log "verifying that, not the '${IMAGE_SOURCE}' this shell would have used."
    fi
    IMAGE_SOURCE="$RECORDED_IMAGE_SOURCE"
    VERIFY_SOURCE_ORIGIN="deploy/minikube/.image-manifest.json"
  fi

  echo -e "\n${BOLD}=== Verifying Images in Minikube (IMAGE_SOURCE=${IMAGE_SOURCE}) ===${NC}"
  log "mode from ${VERIFY_SOURCE_ORIGIN}"

  GHCR_TAG=""
  if [ "$IMAGE_SOURCE" = ghcr ]; then
    GHCR_TAG="$(resolve_ghcr_tag)"
    if [ "$INCLUDE_E2E_FIXTURES" = false ]; then
      log "excluding the E2E-only fixtures; 'make minikube-setup-e2e' builds them (SEED_PROFILE=e2e to check them)"
    fi
  fi

  VERIFY_IMAGES=()
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    VERIFY_IMAGES+=("$ref")
  done < <(node -e '
    import("'"$PROJECT_DIR"'/scripts/release/images-manifest.mjs").then(m => {
      const refs = m.minikubeVerifyRefs({
        mode: process.argv[1],
        tag: process.argv[2],
        includeE2eFixtures: process.argv[3] === "true",
      })
      for (const ref of refs) process.stdout.write(`${ref}\n`)
    }).catch(err => {
      process.stderr.write(`images-manifest read failed: ${err.message}\n`)
      process.exit(1)
    })' "$IMAGE_SOURCE" "$GHCR_TAG" "$INCLUDE_E2E_FIXTURES")

  # An empty verify set means the manifest read failed or the mode is wrong.
  # "0 of 0 images missing" is not a pass.
  if [ "${#VERIFY_IMAGES[@]}" -eq 0 ]; then
    err "the manifest produced zero images to verify; refusing to report success on an empty set"
    exit 1
  fi

  if [ "$SKIP_UIS" = true ]; then
    FILTERED_VERIFY=()
    for image in "${VERIFY_IMAGES[@]}"; do
      case "$image" in
        */control-ui:*|*/profile-ui:*) continue ;;
        *) FILTERED_VERIFY+=("$image") ;;
      esac
    done
    VERIFY_IMAGES=("${FILTERED_VERIFY[@]}")
  fi

  fail_count=0
  for img in "${VERIFY_IMAGES[@]}"; do
    sha=$(minikube_image_id "$img")
    if [ "$sha" = "NOT_FOUND" ]; then
      err "MISSING: ${img}"
      # NOT ((fail_count++)): post-increment evaluates to the OLD value, so the
      # first miss (0) makes the arithmetic command exit 1 and `set -e` aborts
      # the loop. That reports ONE missing image when several are missing, and
      # sends you round the pull/verify loop once per image.
      fail_count=$((fail_count + 1))
    else
      ok "${img} (${sha:7:12})"
    fi
  done
  echo ""
  if [ "$fail_count" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All ${#VERIFY_IMAGES[@]} images present in minikube.${NC}"
  else
    echo -e "${RED}${BOLD}${fail_count} of ${#VERIFY_IMAGES[@]} images missing!${NC}"
    # The remedy follows the mode this cluster was actually built in. Telling a
    # locally built cluster to pull would replace its clerum/*:test tags with
    # release images -- a fix that breaks exactly what it claims to repair.
    if [ "$IMAGE_SOURCE" = ghcr ]; then
      echo -e "${RED}Run: make minikube-pull-images   (tag ${GHCR_TAG})${NC}"
    else
      echo -e "${RED}Run: make minikube-build-images${NC}"
    fi
    exit 1
  fi
  exit 0
fi

# Pull the public third-party images (postgres, redis, nginx, ...) without
# building anything. The ghcr path needs them: no clerum image build runs
# there, so nothing else pulls them into the daemon.
#
# It has to sit AFTER the `if [ -n "$ONLY_SVC" ]` normalizer near the top,
# which forces SKIP_PUBLIC=true for any --only run; setting ONLY_SVC here
# reaches build_image's filter (a runtime read) without tripping that.
if [ "$PUBLIC_ONLY" = true ]; then
  SKIP_PUBLIC=false
  ONLY_SVC="__none__"
fi

# ---- Build function ----
build_image() {
  local name=$1 dir=$2 tag=$3 dockerfile=${4:-""}
  if [ -n "$ONLY_SVC" ] && [[ "$tag" != *"$ONLY_SVC"* ]] && [[ "$name" != *"$ONLY_SVC"* ]]; then
    return 0
  fi
  if [ ! -d "$dir" ]; then
    warn "Directory '$dir' not found -- skipping ${name}"
    return
  fi
  log "Building ${tag}..."
  local docker_args=(-t "$tag")
  if [ -n "$dockerfile" ]; then
    docker_args+=(-f "$dockerfile")
  fi
  local build_cmd=(docker build "${docker_args[@]}" "$dir")
  if ! "${build_cmd[@]}" 2>&1 | tail -3; then
    err "Failed to build ${tag}"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  local sha
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    log "Loading ${tag} into all minikube nodes..."
    minikube -p "$PROFILE" image load "$tag" >/dev/null
    sha=$(minikube_image_id "$tag")
  else
    sha=$(docker inspect --format='{{.Id}}' "$tag" 2>/dev/null || echo "NOT_FOUND")
  fi
  if [ "$sha" = "NOT_FOUND" ]; then
    err "Image ${tag} not found after build!"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  ok "${tag} (${sha:7:12})"
}

build_control_ui_image() {
  local tag="clerum/control-ui:test"
  if [ -n "$ONLY_SVC" ] && [[ "$tag" != *"$ONLY_SVC"* ]] && [[ "control-ui" != *"$ONLY_SVC"* ]]; then
    return 0
  fi
  log "Building ${tag}..."
  local docker_args=(
    -t "$tag"
    --build-arg NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES=true
  )
  docker_args+=(-f "${PROJECT_DIR}/control-ui/Dockerfile")
  local build_cmd=(docker build "${docker_args[@]}" "${PROJECT_DIR}")
  if ! "${build_cmd[@]}" 2>&1 | tail -3; then
    err "Failed to build ${tag}"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  local sha
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    log "Loading ${tag} into all minikube nodes..."
    minikube -p "$PROFILE" image load "$tag" >/dev/null
    sha=$(minikube_image_id "$tag")
  else
    sha=$(docker inspect --format='{{.Id}}' "$tag" 2>/dev/null || echo "NOT_FOUND")
  fi
  if [ "$sha" = "NOT_FOUND" ]; then
    err "Image ${tag} not found after build!"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  ok "${tag} (${sha:7:12})"
}

reuse_image_as_tag() {
  local name=$1 source=$2 tag=$3
  if [ -n "$ONLY_SVC" ] && [[ "$tag" != *"$ONLY_SVC"* ]] && [[ "$name" != *"$ONLY_SVC"* ]]; then
    return 0
  fi
  log "Reusing ${source} as ${tag}..."
  if ! docker pull "$source" 2>&1 | tail -3; then
    err "Failed to pull ${source}"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  docker tag "$source" "$tag"
  local sha
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    minikube -p "$PROFILE" image load "$tag" >/dev/null
    sha=$(minikube_image_id "$tag")
  else
    sha=$(docker inspect --format='{{.Id}}' "$tag" 2>/dev/null || echo "NOT_FOUND")
  fi
  if [ "$sha" = "NOT_FOUND" ]; then
    err "Image ${tag} not found after retag!"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  ok "${tag} (${sha:7:12})"
}

# ---- Build all services ----

echo -e "\n${BOLD}=== Building Core Services ===${NC}"

build_image "hcc" \
  "${PROJECT_DIR}" \
  "clerum/host-context-controller:test" \
  "${PROJECT_DIR}/host-context-controller/Dockerfile"

build_image "wrc" \
  "${PROJECT_DIR}" \
  "clerum/workflow-recipes:test" \
  "${PROJECT_DIR}/workflow-recipes/Dockerfile"

build_image "workflow-coordinator" \
  "${PROJECT_DIR}" \
  "clerum/workflow-coordinator:test" \
  "${PROJECT_DIR}/workflow-recipes/Dockerfile.coordinator"

build_image "workflow-snippet-runner" \
  "${PROJECT_DIR}" \
  "clerum/workflow-snippet-runner:test" \
  "${PROJECT_DIR}/workflow-recipes/Dockerfile"

build_image "workflow-custom-sdk-e2e" \
  "${PROJECT_DIR}" \
  "clerum/workflow-custom-sdk-e2e:test" \
  "${PROJECT_DIR}/tests/e2e/fixtures/custom-workflow-coordinator/Dockerfile"

# mcp-host builds from the repo root context (PROJECT_DIR): it consumes the
# shared @clerum/llm-providers package via file:../packages/llm-providers, so
# packages/ must be inside the build context (mirrors wrc/control-api above).
build_image "mcp-host" \
  "${PROJECT_DIR}" \
  "clerum/mcp-host:test" \
  "${PROJECT_DIR}/mcp-host/Dockerfile"

build_image "mcp-host-slim" \
  "${PROJECT_DIR}" \
  "clerum/mcp-host-slim:test" \
  "${PROJECT_DIR}/mcp-host/Dockerfile.slim"

build_image "mcp-host-full" \
  "${PROJECT_DIR}" \
  "clerum/mcp-host-full:test" \
  "${PROJECT_DIR}/mcp-host/Dockerfile.full"

if [ "$MINIKUBE_BUILD_DESKTOP_IMAGE" = "true" ]; then
  build_image "mcp-host-desktop" \
    "${PROJECT_DIR}" \
    "clerum/mcp-host-desktop:test" \
    "${PROJECT_DIR}/mcp-host/Dockerfile.desktop"
elif [ "$SKIP_UIS" = true ]; then
  warn "Skipping mcp-host-desktop image (--skip-uis)."
else
  warn "Skipping mcp-host-desktop image (set MINIKUBE_BUILD_DESKTOP_IMAGE=true or --include-desktop-image to build it)"
fi

build_image "mcp-proxy" \
  "${PROJECT_DIR}/mcp-proxy" \
  "clerum/mcp-proxy:test"

build_image "nginx-egress-proxy" \
  "${PROJECT_DIR}/nginx-egress-proxy" \
  "clerum/nginx-egress-proxy:test"

# gfsc (Global File System controller) — self-contained build (own Dockerfile,
# no @clerum/* workspace deps). HCC's gfsReconciler spawns it from this image.
build_image "gfs-controller" \
  "${PROJECT_DIR}/gfs-controller" \
  "clerum/gfs-controller:test"

build_image "control-api" \
  "${PROJECT_DIR}" \
  "clerum/control-api:test" \
  "${PROJECT_DIR}/control-api/Dockerfile"

build_image "external-rest-api" \
  "${PROJECT_DIR}/external-rest-api" \
  "clerum/external-rest-api:test"

build_image "rpc-proxy" \
  "${PROJECT_DIR}/rpc-proxy" \
  "clerum/rpc-proxy:test"

build_image "webhook-proxy" \
  "${PROJECT_DIR}/webhook-proxy" \
  "clerum/webhook-proxy:test"

build_image "webhook-gateway" \
  "${PROJECT_DIR}/webhook-gateway" \
  "clerum/webhook-gateway:test"

build_image "channel-reader" \
  "${PROJECT_DIR}/channel-reader" \
  "clerum/channel-reader:test"

build_image "workflow-approval-request-reader" \
  "${PROJECT_DIR}/workflow-approval-request-reader" \
  "clerum/workflow-approval-request-reader:test"

build_image "stdio-bridge" \
  "${PROJECT_DIR}/stdio-bridge" \
  "clerum/stdio-bridge:test"

build_image "workspace-files-controller" \
  "${PROJECT_DIR}/workspace-files-controller" \
  "clerum/workspace-files-controller:test"

echo -e "\n${BOLD}=== Building UI Services ===${NC}"

if [ "$SKIP_UIS" = true ]; then
  warn "Skipping Control UI, Profile UI, and Desktop App image builds (--skip-uis)."
  log "Desktop App is not built or deployed by minikube image setup."
else
  build_control_ui_image

  build_image "profile-ui" \
    "${PROJECT_DIR}" \
    "clerum/profile-ui:test" \
    "${PROJECT_DIR}/profile-ui/Dockerfile"
fi

# Registry now lives in the sibling evenfire-registry repo. Use
# `make minikube-deploy-evenfire-registry` to build + deploy it. This script
# only builds clerum-monorepo services.

# MCP servers are distributed through the evenfire registry and installed on
# demand: a registry install copies the catalog entry's fully-qualified
# imageRef straight into McpServer.spec.image (control-api/src/routes/admin/
# registry.ts:1088) and the kubelet pulls it. Nothing on that path wants a
# locally loaded clerum/* alias, so minikube setup neither builds nor pulls
# these images -- they are deployed_to_minikube:false in deploy/images.json.
#
# The two that remain here are opt-in only:
#   playwright-mcp-server -- heavy, never deployed by the minikube overlay.
#   airtable-mcp-server   -- named by its LOCAL ref in the SEED_PROFILE=e2e
#                            demo instance (deploy/overlays/minikube/
#                            instances-e2e/airtable-server.yaml), which is
#                            applied with `kubectl apply -f`, outside kustomize,
#                            so the ghcr component never rewrites it. HCC forces
#                            imagePullPolicy=IfNotPresent on minikube, so that
#                            ref must already be in the daemon. full-setup.sh
#                            sets MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE for exactly
#                            that branch and nothing else.
echo -e "\n${BOLD}=== Building MCP Servers ===${NC}"

if [ "$MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE" = "true" ]; then
  build_image "airtable-mcp" \
    "${PROJECT_DIR}/mcp-servers/airtable" \
    "clerum/airtable-mcp-server:test"
else
  warn "Skipping the optional Airtable MCP image. The registry installs this connector on demand; set MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE=true (or --include-airtable-mcp-image) for the SEED_PROFILE=e2e demo instance."
fi

if [ "$MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE" = "true" ]; then
  if [ "$MINIKUBE_REUSE_PLAYWRIGHT_MCP_IMAGE" = "true" ]; then
    reuse_image_as_tag "playwright-mcp" \
      "$MINIKUBE_PLAYWRIGHT_MCP_SOURCE_IMAGE" \
      "clerum/playwright-mcp-server:test"
  else
    build_image "playwright-mcp" \
      "${PROJECT_DIR}/mcp-servers/playwright" \
      "clerum/playwright-mcp-server:test"
  fi
else
  warn "Skipping optional Playwright MCP local image. The default minikube overlay does not deploy clerum/playwright-mcp-server:test; GKE publishes this image as playwright-server:<tag>."
fi

echo -e "\n${BOLD}=== Building Test Fixtures ===${NC}"

build_image "mock-mcp" \
  "${PROJECT_DIR}/tests/e2e/fixtures/mock-mcp-server" \
  "clerum/mock-mcp-server:test"

build_image "mock-stdio-mcp" \
  "${PROJECT_DIR}/tests/e2e/fixtures/mock-stdio-mcp-server" \
  "clerum/mock-stdio-mcp-server:test"

build_image "workflow-plugin-sdk-e2e" \
  "${PROJECT_DIR}/tests/e2e/fixtures/workflow-plugin-sdk-e2e" \
  "clerum/workflow-plugin-sdk-e2e:test"

# Public images — pull directly into minikube's daemon
if [ "$SKIP_PUBLIC" = false ]; then
  echo -e "\n${BOLD}=== Loading Public Images ===${NC}"
  PUBLIC_IMAGES=(
    "postgres:16-alpine"
    "redis:7-alpine"
    "nginx:1.30.1-alpine"
    "minio/minio:latest"
    "axllent/mailpit:latest"
    "mongodb/mongodb-community-server:7.0-ubi8"
    "mongodb/mongodb-mcp-server:latest"
    "curlimages/curl:8.7.1"
    "ghcr.io/aas-ee/open-web-search:latest"
  )
  for img in "${PUBLIC_IMAGES[@]}"; do
    if [ "$MINIKUBE_MULTI_NODE" = true ] && minikube_image_present "$img"; then
      log "Image '$img' already present -- skipping"
    elif [ "$MINIKUBE_MULTI_NODE" = false ] && docker images -q "$img" 2>/dev/null | grep -q .; then
      log "Image '$img' already present -- skipping"
    else
      log "Pulling '$img' into minikube..."
      if [ "$MINIKUBE_MULTI_NODE" = true ]; then
        minikube -p "$PROFILE" image load --pull "$img" >/dev/null
      else
        docker pull "$img" 2>/dev/null
      fi
      ok "$img"
    fi
  done
fi

# ---- Generate build manifest JSON ----
# MANIFEST_FILE is declared at the top of the script; the verify path needs it
# too and exits long before this point.
mkdir -p "$(dirname "$MANIFEST_FILE")"
echo -e "\n${BOLD}=== Generating Image Manifest ===${NC}"

# How this cluster's images were acquired, read back by --verify-only.
# pull-images.sh writes "ghcr"; this script only ever BUILDS, so a full run
# writes "local" regardless of the IMAGE_SOURCE env var, which describes what
# the cluster renders, not what just happened here.
#
# A partial run (--only=<svc>, and --public-only, which sets ONLY_SVC) acquires
# a subset and must not redefine the mode: `make minikube-setup-e2e` builds the
# two E2E fixtures and the opt-in airtable-mcp-server image with --only AFTER
# the ghcr pull. Carry the recorded value forward instead, and fall back to the
# env var only when nothing is recorded yet.
#
# imageTag rides along for exactly the same reason. A pre-gate shadow build is
# an --only run, so dropping the tag here would make the next pre-gate fall back
# to the committed pin and declare a `MINIKUBE_IMAGE_TAG=latest` cluster out of
# sync on every run. A full build has no ghcr coordinate at all, so it clears
# the key rather than leaving a stale one behind.
MANIFEST_IMAGE_SOURCE="local"
MANIFEST_IMAGE_TAG=""
if [ -n "$ONLY_SVC" ]; then
  MANIFEST_IMAGE_SOURCE="$(recorded_image_source)"
  if [ -z "$MANIFEST_IMAGE_SOURCE" ]; then
    MANIFEST_IMAGE_SOURCE="$IMAGE_SOURCE"
  fi
  MANIFEST_IMAGE_TAG="$(recorded_image_tag)"
  if [ -z "$MANIFEST_IMAGE_TAG" ] && [ "$MANIFEST_IMAGE_SOURCE" = ghcr ]; then
    # Charset-checked before it is interpolated into JSON: an unusable value
    # would make the whole manifest unparseable, which every reader here
    # correctly treats as "nothing recorded" -- silently losing the mode too.
    case "${MINIKUBE_IMAGE_TAG:-}" in
      "" | *[!A-Za-z0-9._-]*) MANIFEST_IMAGE_TAG="" ;;
      *) MANIFEST_IMAGE_TAG="${MINIKUBE_IMAGE_TAG}" ;;
    esac
  fi
fi
{
  echo "{"
  echo "  \"generated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"profile\": \"${PROFILE}\","
  echo "  \"imageSource\": \"${MANIFEST_IMAGE_SOURCE}\","
  echo "  \"imageTag\": \"${MANIFEST_IMAGE_TAG}\","
  echo "  \"images\": {"
  count=0
  total=${#ALL_IMAGES[@]}
  for img in "${ALL_IMAGES[@]}"; do
    count=$((count + 1))
    if [ "$MINIKUBE_MULTI_NODE" = true ]; then
      sha=$(minikube_image_id "$img")
    else
      sha=$(docker inspect --format='{{.Id}}' "$img" 2>/dev/null || echo "NOT_BUILT")
    fi
    comma=","
    if [ "$count" -eq "$total" ]; then comma=""; fi
    echo "    \"${img}\": \"${sha}\"${comma}"
  done
  echo "  }"
  echo "}"
} > "$MANIFEST_FILE"
ok "Manifest: deploy/minikube/.image-manifest.json"

# ---- Summary ----
echo -e "\n${BOLD}=== Build Summary ===${NC}"
if [ ${#FAILED_IMAGES[@]} -eq 0 ]; then
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    echo -e "${GREEN}${BOLD}All images built and loaded into multi-node minikube '${PROFILE}'.${NC}"
  else
    echo -e "${GREEN}${BOLD}All images built directly in minikube '${PROFILE}' (no transfer needed).${NC}"
  fi
else
  failed_count=${#FAILED_IMAGES[@]}
  echo -e "${RED}${BOLD}${failed_count} images failed:${NC}"
  for img in "${FAILED_IMAGES[@]}"; do
    echo -e "${RED}  - ${img}${NC}"
  done
  exit 1
fi
