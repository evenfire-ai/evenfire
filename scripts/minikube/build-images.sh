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
#                   public-image pulls and preserves the recorded manifest
#                   acquisition mode/tag while refreshing image IDs.
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
#                                      image before failing (default: 3,
#                                      maximum: 10).
#   MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS Delay between failed pull attempts
#                                      (default: 5, range: 0-300).
#   MINIKUBE_{STATUS,DOCKER_ENV,KUBECTL}_TIMEOUT_SECONDS
#                                      Finite deadlines for Minikube status,
#                                      docker-env, and node inventory probes
#                                      (default: 30, maximum: 300).
#   MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS
#                                      kubectl request timeout nested inside
#                                      its process deadline (default: 20,
#                                      maximum: 300).
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
#   MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY
#                                      private (default) requires the explicit
#                                      MINIKUBE_DOCKER_AUTH_CONFIG for that
#                                      source pull; public uses the isolated
#                                      unauthenticated Docker config.
#   MINIKUBE_DOCKER_AUTH_CONFIG         Explicit Docker config directory for a
#                                      private-registry pull. Ambient Docker
#                                      auth is never inherited or copied.
#   MINIKUBE_DOCKER_{INFO,PULL,BUILD}_TIMEOUT_SECONDS
#                                      Finite operation deadlines (defaults:
#                                      30, 600, and 1800 seconds).
#   MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS
#                                      Deadline for each read-only Minikube
#                                      image inventory (default: 30 seconds).
#   MINIKUBE_DOCKER_BUILDX_PLUGIN       Explicit path to an already-installed
#                                      buildx plugin. No plugin is downloaded.
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

PROFILE="${MINIKUBE_PROFILE:-${T2_PROFILE:-clerum-test}}"
CONTEXT="${T2_CONTEXT:-${CONTROL_API_REAL_PG_CONTEXT:-${PROFILE}}}"
SKIP_PUBLIC=false
VERIFY_ONLY=false
PUBLIC_ONLY=false
ONLY_SVC=""
ONLY_REQUESTED=false
FAILED_IMAGES=()
MINIKUBE_PRELOAD_BASE_IMAGES="${MINIKUBE_PRELOAD_BASE_IMAGES:-true}"
MINIKUBE_BASE_IMAGE_PULL_RETRIES="${MINIKUBE_BASE_IMAGE_PULL_RETRIES:-3}"
MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS="${MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS:-5}"
MINIKUBE_STATUS_TIMEOUT_SECONDS="${MINIKUBE_STATUS_TIMEOUT_SECONDS:-30}"
MINIKUBE_DOCKER_ENV_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_ENV_TIMEOUT_SECONDS:-30}"
MINIKUBE_KUBECTL_TIMEOUT_SECONDS="${MINIKUBE_KUBECTL_TIMEOUT_SECONDS:-30}"
MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS="${MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS:-20}"
MINIKUBE_BUILD_DESKTOP_IMAGE="${MINIKUBE_BUILD_DESKTOP_IMAGE:-false}"
MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE="${MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE:-false}"
MINIKUBE_REUSE_PLAYWRIGHT_MCP_IMAGE="${MINIKUBE_REUSE_PLAYWRIGHT_MCP_IMAGE:-true}"
MINIKUBE_PLAYWRIGHT_MCP_SOURCE_IMAGE="${MINIKUBE_PLAYWRIGHT_MCP_SOURCE_IMAGE:-us-central1-docker.pkg.dev/your-gcp-project/clerum/playwright-server:latest}"
MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY="${MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY:-private}"
MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE="${MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE:-false}"
MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS="${MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS:-30}"
SKIP_UIS="${MINIKUBE_SKIP_UIS:-false}"

case "$MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY" in
  public|private) ;;
  *)
    echo "Unknown MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY: '${MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY}' (expected: public | private)" >&2
    exit 1
    ;;
esac

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
# The committed pin is NOT read here. resolve_ghcr_tag below delegates to
# image-mode.sh, which owns that read along with the recorded-tag precedence.

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
# shellcheck source=scripts/minikube/docker-cli-env.sh
source "${SCRIPT_DIR}/docker-cli-env.sh"

cleanup_docker_cli_env() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  docker_cli_env_cleanup || cleanup_status=$?
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}
trap cleanup_docker_cli_env EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

# The effective ghcr tag: the explicit MINIKUBE_IMAGE_TAG override, else the tag
# the last acquisition RECORDED for this cluster, else the committed pin.
#
# The recorded tag is not optional here. It is the imageSource bug above with a
# different field: `MINIKUBE_IMAGE_TAG=latest make minikube-setup` is the
# documented bootstrap while no release tag exists on ghcr, and the NEXT shell
# has no such variable. Resolving the committed pin there reported
# "23 of 23 images missing!" against a cluster holding every :latest ref, and
# told the operator to pull a tag that is not published at all.
#
# image_mode_tag applies exactly that precedence and is the resolver
# pre-gate-sync.sh already uses; a second copy of the precedence in this file is
# what let the two disagree, so this delegates instead of reimplementing it.
resolve_ghcr_tag() {
  image_mode_tag "$PROJECT_DIR"
}

for arg in "$@"; do
  case "$arg" in
    --skip-public) SKIP_PUBLIC=true ;;
    --skip-uis) SKIP_UIS=true ;;
    --verify-only) VERIFY_ONLY=true ;;
    --public-only) PUBLIC_ONLY=true ;;
    --only=*)
      if [[ "$ONLY_REQUESTED" == true ]]; then
        printf 'Duplicate --only selector: %s\n' "$arg" >&2
        exit 2
      fi
      ONLY_REQUESTED=true
      ONLY_SVC="${arg#--only=}"
      ;;
    --include-e2e-fixtures) INCLUDE_E2E_FIXTURES=true ;;
    --include-desktop-image) MINIKUBE_BUILD_DESKTOP_IMAGE=true ;;
    --include-playwright-mcp-image) MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE=true ;;
    --include-airtable-mcp-image) MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE=true ;;
    *)
      printf 'Unknown build-images argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$ONLY_REQUESTED" == true && -z "$ONLY_SVC" ]]; then
  printf '%s\n' 'Invalid --only selector: the selector must not be empty' >&2
  exit 2
fi

# When --only is set we skip public-image pulls and preserve manifest mode/tag.
if [[ "$ONLY_REQUESTED" == true ]]; then
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

# All images built in this session. Every entry here must have a matching
# row in deploy/images.json (via localRef()) -- scripts/tests/test-images-
# manifest.sh enforces it. This declaration intentionally precedes every
# runtime call so an invalid --only selector cannot acquire a lease or touch a
# daemon before it is rejected.
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
  "clerum/codex-llm-proxy:test"
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

KNOWN_BUILD_NAMES=(
  hcc
  wrc
  workflow-coordinator
  workflow-snippet-runner
  workflow-custom-sdk-e2e
  workflow-plugin-sdk-e2e
  mcp-host
  mcp-host-slim
  mcp-host-full
  mcp-proxy
  nginx-egress-proxy
  gfs-controller
  control-api
  external-rest-api
  rpc-proxy
  webhook-proxy
  codex-llm-proxy
  webhook-gateway
  channel-reader
  workflow-approval-request-reader
  stdio-bridge
  mock-mcp
  mock-stdio-mcp
  workspace-files-controller
)

if [ "$MINIKUBE_BUILD_DESKTOP_IMAGE" = "true" ]; then
  ALL_IMAGES+=("clerum/mcp-host-desktop:test")
  KNOWN_BUILD_NAMES+=(mcp-host-desktop)
fi

if [ "$MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE" = "true" ]; then
  ALL_IMAGES+=("clerum/playwright-mcp-server:test")
  KNOWN_BUILD_NAMES+=(playwright-mcp)
fi

if [ "$MINIKUBE_BUILD_AIRTABLE_MCP_IMAGE" = "true" ]; then
  ALL_IMAGES+=("clerum/airtable-mcp-server:test")
  KNOWN_BUILD_NAMES+=(airtable-mcp)
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
else
  KNOWN_BUILD_NAMES+=(control-ui profile-ui)
fi

if [[ "$ONLY_REQUESTED" == true ]]; then
  SELECTOR_MATCHED=false
  for candidate in "${ALL_IMAGES[@]}" "${KNOWN_BUILD_NAMES[@]}"; do
    if [[ "$candidate" == *"$ONLY_SVC"* ]]; then
      SELECTOR_MATCHED=true
      break
    fi
  done
  if [[ "$SELECTOR_MATCHED" != true ]]; then
    printf 'Unknown --only selector: %s\n' "$ONLY_SVC" >&2
    exit 2
  fi
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

validate_nonnegative_integer() {
  local name="$1" value="$2" maximum="$3"
  if ! [[ "$value" =~ ^[0-9]+$ ]] \
    || [[ "${#value}" -gt "${#maximum}" ]] \
    || (( 10#$value > maximum )); then
    printf 'DOCKER_DEADLINE_INVALID: %s must be an integer from 0 to %s\n' \
      "$name" "$maximum" >&2
    return 2
  fi
}

validate_build_configuration() {
  if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    printf 'PROFILE_LOCK_REQUIRED: invalid Minikube profile: %s\n' "$PROFILE" >&2
    return 2
  fi
  if [[ ! "$CONTEXT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    printf 'PROFILE_LOCK_REQUIRED: invalid Kubernetes context: %s\n' "$CONTEXT" >&2
    return 2
  fi
  if [[ "$PROFILE" != "$CONTEXT" ]]; then
    printf '%s\n' 'PROFILE_LOCK_REQUIRED: Minikube profile and Kubernetes context must match' >&2
    return 1
  fi

  docker_cli_env_validate_deadlines || return $?
  docker_cli_env_validate_seconds MINIKUBE_STATUS_TIMEOUT_SECONDS \
    "$MINIKUBE_STATUS_TIMEOUT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_ENV_TIMEOUT_SECONDS \
    "$MINIKUBE_DOCKER_ENV_TIMEOUT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_KUBECTL_TIMEOUT_SECONDS \
    "$MINIKUBE_KUBECTL_TIMEOUT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS \
    "$MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS \
    "$MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_BASE_IMAGE_PULL_RETRIES \
    "$MINIKUBE_BASE_IMAGE_PULL_RETRIES" 10 || return $?
  validate_nonnegative_integer MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS \
    "$MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS" 300 || return $?
}

require_inherited_mutation_lease() {
  if [[ "$VERIFY_ONLY" == true ]]; then
    return 0
  fi
  if [[ -z "${T2_PROJECT_DIR:-}" || -z "${T2_PROFILE:-}" || -z "${T2_CONTEXT:-}" \
    || "$T2_PROJECT_DIR" != "$PROJECT_DIR" || "$T2_PROFILE" != "$PROFILE" \
    || "$T2_CONTEXT" != "$CONTEXT" || "$PROFILE" != "$CONTEXT" ]]; then
    printf '%s\n' 'PROFILE_LOCK_REQUIRED: build-images requires the inherited mutation lease for its exact worktree, profile, and context' >&2
    return 1
  fi

  T2_GATE_ID=build-images \
    MINIKUBE_PROFILE="$PROFILE" CONTROL_API_REAL_PG_CONTEXT="$CONTEXT" \
    bash "${SCRIPT_DIR}/require-t2-mutation-lock.sh"
}

run_with_deadline() {
  local label="$1" timeout_seconds="$2"
  shift 2
  node "$DOCKER_CLI_DEADLINE_RUNNER" \
    --timeout-seconds "$timeout_seconds" \
    --heartbeat-seconds "$MINIKUBE_DOCKER_HEARTBEAT_SECONDS" \
    --kill-grace-seconds "$MINIKUBE_DOCKER_KILL_GRACE_SECONDS" \
    --label "$label" -- "$@"
}

validate_build_configuration
require_inherited_mutation_lease

if ! command -v node >/dev/null 2>&1 || [[ ! -f "$DOCKER_CLI_DEADLINE_RUNNER" ]]; then
  err "The existing deadline runner and Node.js are required"
  exit 1
fi

# Verify minikube is running. Preserve timeout (124), signal, and ordinary
# child exit statuses so callers can distinguish a dead process from a stopped
# profile.
minikube_status=0
run_with_deadline minikube-status "$MINIKUBE_STATUS_TIMEOUT_SECONDS" \
  minikube -p "$PROFILE" status >/dev/null || minikube_status=$?
if [[ "$minikube_status" -ne 0 ]]; then
  err "Minikube profile '${PROFILE}' is not running. Start with: minikube start -p ${PROFILE}"
  exit "$minikube_status"
fi

minikube_node_count() {
  local nodes status=0
  nodes="$(run_with_deadline minikube-get-nodes "$MINIKUBE_KUBECTL_TIMEOUT_SECONDS" \
    kubectl --context="$CONTEXT" get nodes \
      --request-timeout="${MINIKUBE_KUBECTL_REQUEST_TIMEOUT_SECONDS}s" \
      --no-headers)" || status=$?
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  awk 'NF { count += 1 } END { print count + 0 }' <<<"$nodes"
}

node_count_status=0
MINIKUBE_NODE_COUNT="$(minikube_node_count)" || node_count_status=$?
if [[ "$node_count_status" -ne 0 ]]; then
  err "Unable to list nodes for minikube profile '${PROFILE}'"
  exit "$node_count_status"
fi
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

MINIKUBE_IMAGE_INVENTORY_JSON=""
MINIKUBE_IMAGE_INVENTORY_CACHED=false
# Return code 1 is reserved for a successful inventory proving that a requested
# image is absent. Remap only a real inventory failure that happens to return 1;
# preserve every other deadline/process status so callers retain diagnostics and
# cannot turn an infrastructure failure into a pull/load cache miss.
MINIKUBE_IMAGE_INVENTORY_ERROR_STATUS=2

minikube_image_inventory() {
  local inventory_status=0
  run_with_deadline minikube-image-inventory \
    "$MINIKUBE_IMAGE_INVENTORY_TIMEOUT_SECONDS" \
    minikube -p "$PROFILE" image ls --format=json || inventory_status=$?
  if [[ "$inventory_status" -ne 0 ]]; then
    err "Minikube image inventory failed or exceeded its deadline" >&2
    if [[ "$inventory_status" -eq 1 ]]; then
      return "$MINIKUBE_IMAGE_INVENTORY_ERROR_STATUS"
    fi
    return "$inventory_status"
  fi
}

cache_minikube_image_inventory() {
  local inventory_status=0
  MINIKUBE_IMAGE_INVENTORY_JSON="$(minikube_image_inventory)" || inventory_status=$?
  if [[ "$inventory_status" -ne 0 ]]; then
    return "$inventory_status"
  fi
  MINIKUBE_IMAGE_INVENTORY_CACHED=true
}

minikube_image_id() {
  local image=$1
  local normalized inventory inventory_status=0
  normalized="$(normalize_minikube_image_tag "$image")"
  if [[ "$MINIKUBE_IMAGE_INVENTORY_CACHED" == true ]]; then
    inventory="$MINIKUBE_IMAGE_INVENTORY_JSON"
  else
    inventory="$(minikube_image_inventory)" || inventory_status=$?
    if [[ "$inventory_status" -ne 0 ]]; then
      return "$inventory_status"
    fi
  fi
  # shellcheck disable=SC2016
  printf '%s' "$inventory" | node -e '
const tag = process.argv[1]
const raw = require("fs").readFileSync(0, "utf8").trim()
let items = []
if (raw) {
  try {
    items = JSON.parse(raw)
  } catch {
    process.stderr.write("MINIKUBE_IMAGE_INVENTORY_INVALID: inventory is not valid JSON\n")
    process.exit(2)
  }
  if (!Array.isArray(items)) {
    process.stderr.write("MINIKUBE_IMAGE_INVENTORY_INVALID: inventory is not an array\n")
    process.exit(2)
  }
}
const hit = items.find((item) => Array.isArray(item.repoTags) && item.repoTags.includes(tag))
process.stdout.write(hit?.id ? `sha256:${hit.id}` : "NOT_FOUND")
' "$normalized"
}

minikube_image_present() {
  local image=$1 image_id inventory_status=0
  image_id="$(minikube_image_id "$image")" || inventory_status=$?
  if [[ "$inventory_status" -ne 0 ]]; then
    return "$inventory_status"
  fi
  [[ "$image_id" != "NOT_FOUND" ]]
}

pull_host_image_with_retry() {
  local image=$1
  local attempt=1
  local pull_status=1
  while [ "$attempt" -le "$MINIKUBE_BASE_IMAGE_PULL_RETRIES" ]; do
    pull_status=0
    docker_cli_run_public pull-base-image "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" \
      docker pull "$image" || pull_status=$?
    if [ "$pull_status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -lt "$MINIKUBE_BASE_IMAGE_PULL_RETRIES" ]; then
      warn "Pull failed for ${image} (attempt ${attempt}/${MINIKUBE_BASE_IMAGE_PULL_RETRIES}); retrying in ${MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS}s"
      sleep "$MINIKUBE_BASE_IMAGE_PULL_DELAY_SECS"
    fi
    attempt=$((attempt + 1))
  done
  return "$pull_status"
}

require_docker_info() {
  local label="$1" status=0
  docker_cli_run_public "$label" "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
    docker info >/dev/null || status=$?
  if [ "$status" -ne 0 ]; then
    err "Docker daemon check failed (${label})"
    return "$status"
  fi
}

docker_local_image_query() {
  local image="$1"
  docker_cli_run_public docker-images-query "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
    docker images -q "$image"
}

docker_local_image_id() {
  local image="$1"
  docker_cli_run_public docker-image-id "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
    docker inspect --format='{{.Id}}' "$image"
}

docker_local_image_tag() {
  local source="$1" tag="$2"
  docker_cli_run_public docker-image-tag "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
    docker tag "$source" "$tag"
}

minikube_load_local_image() {
  local image="$1"
  # A local image transfer can be as large as the preceding build, so it uses
  # the build budget rather than the short metadata budget.
  docker_cli_run_public minikube-image-load "$MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS" \
    minikube -p "$PROFILE" image load "$image" >/dev/null
}

load_and_resolve_image_id() {
  local image="$1"
  if [[ "$MINIKUBE_MULTI_NODE" == true ]]; then
    minikube_load_local_image "$image" || return $?
    minikube_image_id "$image"
  else
    docker_local_image_id "$image"
  fi
}

ensure_base_images_in_minikube() {
  local presence_status query_status image_ids
  if [ "$MINIKUBE_PRELOAD_BASE_IMAGES" = "false" ]; then
    warn "Skipping base image preload (MINIKUBE_PRELOAD_BASE_IMAGES=false)"
    return 0
  fi

  echo -e "\n${BOLD}=== Ensuring Build Base Images ===${NC}"
  for image in "${BUILD_BASE_IMAGES[@]}"; do
    presence_status=0
    minikube_image_present "$image" || presence_status=$?
    if [[ "$presence_status" -eq 0 ]]; then
      ok "${image} already present in minikube"
      continue
    fi
    if [[ "$presence_status" -ne 1 ]]; then
      err "Could not inspect '${image}' in minikube"
      return "$presence_status"
    fi

    query_status=0
    image_ids="$(docker_local_image_query "$image")" || query_status=$?
    if [[ "$query_status" -ne 0 ]]; then
      err "Could not inventory '${image}' in the host Docker cache"
      return "$query_status"
    fi
    if [[ -z "$image_ids" ]]; then
      log "Pulling base image '${image}' into host Docker cache..."
      pull_host_image_with_retry "$image" || return $?
    fi

    log "Loading base image '${image}' into minikube '${PROFILE}'..."
    minikube_load_local_image "$image" || return $?
    ok "${image} loaded into minikube"
  done
}

if [ "$VERIFY_ONLY" = false ]; then
  docker_cli_env_prepare
  require_docker_info docker-info-host
  ensure_base_images_in_minikube

  # ---- Point Docker CLI at minikube's Docker daemon when safe ----
  if [ "$MINIKUBE_MULTI_NODE" = false ]; then
    # This makes `docker build` execute INSIDE minikube — no image transfer needed.
    log "Configuring Docker CLI to use minikube's Docker daemon..."
    docker_env_status=0
    docker_env_output="$(run_with_deadline minikube-docker-env \
      "$MINIKUBE_DOCKER_ENV_TIMEOUT_SECONDS" \
      minikube -p "$PROFILE" docker-env --shell bash)" || docker_env_status=$?
    if [[ "$docker_env_status" -ne 0 ]]; then
      err "Could not resolve Docker environment for minikube '${PROFILE}'"
      exit "$docker_env_status"
    fi
    if [[ -z "$docker_env_output" ]]; then
      err "Minikube '${PROFILE}' returned an empty Docker environment"
      exit 1
    fi
    eval "$docker_env_output"
    # Let Docker negotiate API version automatically (minikube v1.38+ requires >=1.44)
    unset DOCKER_API_VERSION 2>/dev/null || true
    require_docker_info docker-info-minikube
    ok "Docker CLI now targets minikube '${PROFILE}'"
  else
    log "Skipping docker-env; multi-node profiles use host builds plus 'minikube image load'"
  fi
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
# The registry-distributed MCP servers (airtable-mcp-server, web-search-mcp)
# are absent from this set entirely, because they are
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
    if ! GHCR_TAG="$(resolve_ghcr_tag)"; then
      err "could not resolve the ghcr tag this cluster runs"
      exit 1
    fi
    # A tagless ref (ghcr.io/evenfire-ai/control-api:) matches nothing in the
    # daemon, so an empty resolution would report every image missing rather
    # than reporting that the resolution failed.
    if [ -z "$GHCR_TAG" ]; then
      err "resolved an empty ghcr tag; refusing to verify tagless image refs"
      exit 1
    fi
    # Same shape as VERIFY_SOURCE_ORIGIN above: the operator has to be able to
    # tell a recorded coordinate from the committed pin when the answer surprises
    # them.
    VERIFY_TAG_ORIGIN="deploy/components/ghcr-images (the committed pin)"
    if [ -n "${MINIKUBE_IMAGE_TAG:-}" ]; then
      VERIFY_TAG_ORIGIN="the MINIKUBE_IMAGE_TAG environment variable"
    elif [ -n "$(recorded_image_tag)" ]; then
      VERIFY_TAG_ORIGIN="deploy/minikube/.image-manifest.json"
    fi
    log "tag ${GHCR_TAG} from ${VERIFY_TAG_ORIGIN}"
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

  # Verification is read-only and deliberately does not initialise Docker or
  # buildx. One bounded Minikube inventory is enough for every tag and avoids
  # multiplying a daemon/runtime hang by the size of VERIFY_IMAGES.
  cache_minikube_image_inventory

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

# Section banner for the build phases below.
#
# On the default IMAGE_SOURCE=ghcr path, full-setup.sh calls this script as
# `--public-only`, which forces ONLY_SVC to a sentinel that matches no image:
# every build_image call below returns without building. Printing
# "=== Building Core Services ===" there tells a developer watching the setup
# that 28 images are being built when none are, which is the exact confusion
# the pull-by-default work exists to remove. Suppress the banners on the path
# that builds nothing.
build_section() {
  if [ "$PUBLIC_ONLY" = true ]; then
    return 0
  fi
  echo -e "\n${BOLD}=== $1 ===${NC}"
}

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
  local build_status=0
  docker_cli_run_public "build-${name}" "$MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS" \
    "${build_cmd[@]}" || build_status=$?
  if [ "$build_status" -ne 0 ]; then
    err "Failed to build ${tag}"
    FAILED_IMAGES+=("$tag")
    return "$build_status"
  fi
  local sha sha_status=0
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    log "Loading ${tag} into all minikube nodes..."
  fi
  sha="$(load_and_resolve_image_id "$tag")" || sha_status=$?
  if [[ "$sha_status" -ne 0 ]]; then
    err "Could not verify ${tag} after build"
    FAILED_IMAGES+=("$tag")
    return "$sha_status"
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
  local build_status=0
  docker_cli_run_public build-control-ui "$MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS" \
    "${build_cmd[@]}" || build_status=$?
  if [ "$build_status" -ne 0 ]; then
    err "Failed to build ${tag}"
    FAILED_IMAGES+=("$tag")
    return "$build_status"
  fi
  local sha sha_status=0
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    log "Loading ${tag} into all minikube nodes..."
  fi
  sha="$(load_and_resolve_image_id "$tag")" || sha_status=$?
  if [[ "$sha_status" -ne 0 ]]; then
    err "Could not verify ${tag} after build"
    FAILED_IMAGES+=("$tag")
    return "$sha_status"
  fi
  if [ "$sha" = "NOT_FOUND" ]; then
    err "Image ${tag} not found after build!"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  ok "${tag} (${sha:7:12})"
}

reuse_image_as_tag() {
  local name=$1 source=$2 tag=$3 visibility=${4:-private}
  if [ -n "$ONLY_SVC" ] && [[ "$tag" != *"$ONLY_SVC"* ]] && [[ "$name" != *"$ONLY_SVC"* ]]; then
    return 0
  fi
  log "Reusing ${source} as ${tag}..."
  local pull_status=0
  if [ "$visibility" = private ]; then
    docker_cli_run_private pull-reusable-image "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" \
      docker pull "$source" || pull_status=$?
  else
    docker_cli_run_public pull-reusable-image "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" \
      docker pull "$source" || pull_status=$?
  fi
  if [ "$pull_status" -ne 0 ]; then
    err "Failed to pull ${source}"
    FAILED_IMAGES+=("$tag")
    return "$pull_status"
  fi
  local tag_status=0 sha sha_status=0
  docker_local_image_tag "$source" "$tag" || tag_status=$?
  if [[ "$tag_status" -ne 0 ]]; then
    err "Failed to tag ${source} as ${tag}"
    FAILED_IMAGES+=("$tag")
    return "$tag_status"
  fi
  sha="$(load_and_resolve_image_id "$tag")" || sha_status=$?
  if [[ "$sha_status" -ne 0 ]]; then
    err "Could not verify ${tag} after retag"
    FAILED_IMAGES+=("$tag")
    return "$sha_status"
  fi
  if [ "$sha" = "NOT_FOUND" ]; then
    err "Image ${tag} not found after retag!"
    FAILED_IMAGES+=("$tag")
    return 1
  fi
  ok "${tag} (${sha:7:12})"
}

# ---- Build all services ----

build_section "Building Core Services"

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

build_image "codex-llm-proxy" \
  "${PROJECT_DIR}" \
  "clerum/codex-llm-proxy:test" \
  "${PROJECT_DIR}/codex-llm-proxy/Dockerfile"

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

build_section "Building UI Services"

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
build_section "Building MCP Servers"

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
      "clerum/playwright-mcp-server:test" \
      "$MINIKUBE_PLAYWRIGHT_MCP_SOURCE_VISIBILITY"
  else
    build_image "playwright-mcp" \
      "${PROJECT_DIR}/mcp-servers/playwright" \
      "clerum/playwright-mcp-server:test"
  fi
else
  warn "Skipping optional Playwright MCP local image. The default minikube overlay does not deploy clerum/playwright-mcp-server:test; GKE publishes this image as playwright-server:<tag>."
fi

build_section "Building Test Fixtures"

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
    public_presence_status=1
    public_image_ids=""
    if [[ "$MINIKUBE_MULTI_NODE" == true ]]; then
      public_presence_status=0
      minikube_image_present "$img" || public_presence_status=$?
    else
      public_presence_status=0
      public_image_ids="$(docker_local_image_query "$img")" || public_presence_status=$?
    fi
    if { [[ "$MINIKUBE_MULTI_NODE" == true ]] && [[ "$public_presence_status" -gt 1 ]]; } \
      || { [[ "$MINIKUBE_MULTI_NODE" == false ]] && [[ "$public_presence_status" -ne 0 ]]; }; then
      err "Could not inventory public image '${img}'"
      exit "$public_presence_status"
    fi

    if [ "$MINIKUBE_MULTI_NODE" = true ] && [[ "$public_presence_status" -eq 0 ]]; then
      log "Image '$img' already present -- skipping"
    elif [ "$MINIKUBE_MULTI_NODE" = false ] && [[ -n "$public_image_ids" ]]; then
      log "Image '$img' already present -- skipping"
    else
      log "Pulling '$img' into minikube..."
      if [ "$MINIKUBE_MULTI_NODE" = true ]; then
        docker_cli_run_public pull-public-image "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" \
          minikube -p "$PROFILE" image load --pull "$img" >/dev/null
      else
        docker_cli_run_public pull-public-image "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" \
          docker pull "$img"
      fi
      ok "$img"
    fi
  done
fi

# ---- Generate build manifest JSON ----
# MANIFEST_FILE is declared at the top of the script; the verify path needs it
# too and exits long before this point.

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

# Resolve every manifest value before opening MANIFEST_FILE. A daemon query is
# authoritative only when it exits zero: empty output then means the image is
# absent, while every nonzero status is an inventory failure. In particular,
# Docker's generic exit 1 must never trigger a pull or be rewritten as
# NOT_BUILT. Staging the values also preserves any prior good manifest when an
# inventory or inspect command fails partway through the list.
MANIFEST_SHAS=()
if [[ "$MINIKUBE_MULTI_NODE" == true ]]; then
  cache_minikube_image_inventory
fi
for img in "${ALL_IMAGES[@]}"; do
  sha=""
  if [[ "$MINIKUBE_MULTI_NODE" == true ]]; then
    manifest_inventory_status=0
    sha="$(minikube_image_id "$img")" || manifest_inventory_status=$?
    if [[ "$manifest_inventory_status" -ne 0 ]]; then
      err "Could not inventory ${img} while generating the image manifest" >&2
      exit "$manifest_inventory_status"
    fi
  else
    manifest_inventory_status=0
    manifest_image_ids="$(docker_local_image_query "$img")" || manifest_inventory_status=$?
    if [[ "$manifest_inventory_status" -ne 0 ]]; then
      err "Could not inventory ${img} while generating the image manifest" >&2
      exit "$manifest_inventory_status"
    fi
    if [[ -z "$manifest_image_ids" ]]; then
      sha="NOT_BUILT"
    else
      manifest_inspect_status=0
      sha="$(docker_local_image_id "$img")" || manifest_inspect_status=$?
      if [[ "$manifest_inspect_status" -ne 0 ]]; then
        err "Could not inspect ${img} while generating the image manifest" >&2
        exit "$manifest_inspect_status"
      fi
    fi
  fi
  MANIFEST_SHAS+=("$sha")
done

mkdir -p "$(dirname "$MANIFEST_FILE")"
echo -e "\n${BOLD}=== Generating Image Manifest ===${NC}"
{
  echo "{"
  echo "  \"generated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"profile\": \"${PROFILE}\","
  echo "  \"imageSource\": \"${MANIFEST_IMAGE_SOURCE}\","
  echo "  \"imageTag\": \"${MANIFEST_IMAGE_TAG}\","
  echo "  \"images\": {"
  count=0
  total=${#ALL_IMAGES[@]}
  for image_index in "${!ALL_IMAGES[@]}"; do
    img="${ALL_IMAGES[$image_index]}"
    sha="${MANIFEST_SHAS[$image_index]}"
    count=$((count + 1))
    comma=","
    if [ "$count" -eq "$total" ]; then comma=""; fi
    echo "    \"${img}\": \"${sha}\"${comma}"
  done
  echo "  }"
  echo "}"
} > "$MANIFEST_FILE"
ok "Manifest: deploy/minikube/.image-manifest.json"

# ---- Summary ----
# Same reason as build_section: on the --public-only (IMAGE_SOURCE=ghcr) path
# nothing was built, so "All images built" is a false report of the run.
if [ "$PUBLIC_ONLY" = true ]; then
  echo -e "\n${BOLD}=== Public Image Summary ===${NC}"
else
  echo -e "\n${BOLD}=== Build Summary ===${NC}"
fi
if [ ${#FAILED_IMAGES[@]} -eq 0 ]; then
  if [ "$PUBLIC_ONLY" = true ]; then
    echo -e "${GREEN}${BOLD}Public third-party images loaded into minikube '${PROFILE}'. No images were built.${NC}"
  elif [ "$MINIKUBE_MULTI_NODE" = true ]; then
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
