#!/usr/bin/env bash
# ======================================================================
# Pull Published Images into Minikube (IMAGE_SOURCE=ghcr)
# ======================================================================
#
# Pulls every pull_in_ghcr_mode image (deploy/images.json:
# published && deployed_to_minikube) from ghcr.io/evenfire-ai at the pinned
# release tag, in parallel, then aliases each one to its local clerum/* ref.
#
# This is the default path for `make minikube-setup`. Its local-build
# counterpart is scripts/minikube/build-images.sh.
#
# Usage:
#   MINIKUBE_PROFILE=clerum-test ./scripts/minikube/pull-images.sh [--only=<svc>]
#
# Env:
#   MINIKUBE_IMAGE_TAG        Override the committed pin (render-time only,
#                             never committed). Use `latest` to exercise the
#                             pull path before a release tag exists.
#   MINIKUBE_PROFILE          Target profile (default: clerum-test)
#   MINIKUBE_MULTI_NODE       true -> pull on the host + `minikube image load`
#   MINIKUBE_PULL_PARALLELISM Concurrent pulls (default: 6)
#   MINIKUBE_IMAGE_PULL_RETRIES     Attempts per image before it is reported
#                             failed (default: 3). A transient registry blip
#                             (one bad pull 24 images into a run) should not
#                             abort the whole setup. Mirrors the naming and
#                             defaults of build-images.sh's
#                             MINIKUBE_BASE_IMAGE_PULL_RETRIES, applied here to
#                             the ghcr application-image pull instead of
#                             Dockerfile base images.
#   MINIKUBE_IMAGE_PULL_DELAY_SECS  Delay between failed attempts (default: 5).
#
# Two behaviours here are load-bearing; do not "optimize" them away:
#
#   1. It RE-PULLS a tag already present in the daemon. A pre-gate shadow build
#      (scripts/minikube/pre-gate-sync.sh) is deliberately tagged with the exact
#      ghcr ref so IfNotPresent picks it up. Skipping present tags would let
#      that local build survive across setups indefinitely and invisibly, and a
#      gate would keep testing code that was never deployed.
#
#   2. It ALIASES each ghcr ref to clerum/<local_name>:<local_tag>. Six
#      pull_in_ghcr_mode images have no row in the minikube overlay and are
#      never rewritten by the ghcr component -- mcp-host-slim, mcp-host-full,
#      airtable-mcp-server, web-search-mcp, mock-mcp-server,
#      mock-stdio-mcp-server. They are consumed under their LOCAL names by
#      McpServer CRD instances applied outside the overlay
#      (deploy/overlays/minikube/instances-e2e/airtable-server.yaml) and by the
#      E2E scripts under scripts/e2e/. A `docker tag` is a pointer; dropping it
#      breaks those paths in ghcr mode only, which is the worst place to find
#      out.
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
MINIKUBE_MULTI_NODE="${MINIKUBE_MULTI_NODE:-false}"
PULL_PARALLELISM="${MINIKUBE_PULL_PARALLELISM:-6}"
MINIKUBE_IMAGE_PULL_RETRIES="${MINIKUBE_IMAGE_PULL_RETRIES:-3}"
MINIKUBE_IMAGE_PULL_DELAY_SECS="${MINIKUBE_IMAGE_PULL_DELAY_SECS:-5}"
GHCR_NAMESPACE="ghcr.io/evenfire-ai"
COMPONENT="${PROJECT_DIR}/deploy/components/ghcr-images/kustomization.yaml"
ONLY_SVC=""

for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY_SVC="${arg#--only=}" ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[PULL]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*" >&2; }

# ---- Resolve the effective tag -------------------------------------------
# The committed component is the single source of truth. MINIKUBE_IMAGE_TAG is
# an operator lever applied to this run only, never a second writer.
read_pinned_tag() {
  [ -f "$COMPONENT" ] || {
    err "ghcr component not found at ${COMPONENT}"
    exit 1
  }
  local tags
  tags="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$COMPONENT" | sort -u)"
  if [ -z "$tags" ]; then
    err "no newTag: line in ${COMPONENT}; there is no pin to pull"
    exit 1
  fi
  if [ "$(printf '%s\n' "$tags" | wc -l | tr -d ' ')" != "1" ]; then
    err "mixed newTag values in ${COMPONENT}: $(printf '%s ' $tags)"
    exit 1
  fi
  printf '%s' "$tags"
}

if [ -n "${MINIKUBE_IMAGE_TAG:-}" ]; then
  IMAGE_TAG="$MINIKUBE_IMAGE_TAG"
  TAG_ORIGIN="MINIKUBE_IMAGE_TAG override"
else
  IMAGE_TAG="$(read_pinned_tag)"
  TAG_ORIGIN="committed pin in deploy/components/ghcr-images/kustomization.yaml"
fi

# ---- Resolve the pull list ----------------------------------------------
# Emitted as TAB-separated `name<TAB>localRef` by the ONE manifest reader, so
# this script never re-derives published && deployed_to_minikube itself.
PULL_LIST="$(node -e '
  import("'"$PROJECT_DIR"'/scripts/release/images-manifest.mjs").then(m => {
    for (const image of m.pullInGhcrMode()) {
      process.stdout.write(`${image.name}\t${m.localRef(image)}\n`)
    }
  }).catch(err => {
    process.stderr.write(`images-manifest read failed: ${err.message}\n`)
    process.exit(1)
  })')"

if [ -z "$PULL_LIST" ]; then
  err "the manifest produced zero pull_in_ghcr_mode images; refusing to report success on an empty pull"
  exit 1
fi

echo -e "\n${BOLD}=== Pulling Published Images (${IMAGE_TAG}) ===${NC}"
log "tag ${IMAGE_TAG} (${TAG_ORIGIN})"
log "profile ${PROFILE}, parallelism ${PULL_PARALLELISM}"

# ---- Point the Docker CLI at minikube's daemon when safe -----------------
if [ "$MINIKUBE_MULTI_NODE" = false ]; then
  log "Configuring Docker CLI to use minikube's Docker daemon..."
  eval "$(minikube -p "$PROFILE" docker-env)"
  unset DOCKER_API_VERSION 2>/dev/null || true
else
  log "Multi-node profile: pulling on the host, then 'minikube image load' onto every node"
fi

STATUS_DIR="$(mktemp -d)"
cleanup() { rm -rf "$STATUS_DIR"; }
trap cleanup EXIT

# ---- Bounded retry for one pull ------------------------------------------
# A transient registry blip (one bad pull 24 images into a run) should not
# read the same as a tag that genuinely does not exist. Mirrors
# build-images.sh's pull_host_image_with_retry: same attempt-count/delay
# shape and the same defaults, applied here to the ghcr application-image
# pull instead of a Dockerfile base image.
#
# Every attempt is a real `docker pull` -- retrying never turns into "skip if
# present"; see header note 1. out_file is truncated on each attempt, so on
# final failure it holds only the last attempt's diagnostic, not a pile-up of
# every prior one.
pull_with_retry() {
  local ref="$1" out_file="$2"
  local attempt=1
  while [ "$attempt" -le "$MINIKUBE_IMAGE_PULL_RETRIES" ]; do
    if docker pull "$ref" >"$out_file" 2>&1; then
      return 0
    fi
    if [ "$attempt" -lt "$MINIKUBE_IMAGE_PULL_RETRIES" ]; then
      warn "Pull failed for ${ref} (attempt ${attempt}/${MINIKUBE_IMAGE_PULL_RETRIES}); retrying in ${MINIKUBE_IMAGE_PULL_DELAY_SECS}s"
      sleep "$MINIKUBE_IMAGE_PULL_DELAY_SECS"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

# ---- One image ----------------------------------------------------------
pull_one() {
  local name="$1" local_ref="$2" slot="$3"
  local ghcr_ref="${GHCR_NAMESPACE}/${name}:${IMAGE_TAG}"

  # Always pull. Never skip a present tag -- see the header.
  if ! pull_with_retry "$ghcr_ref" "${STATUS_DIR}/${slot}.out"; then
    printf '%s' "$ghcr_ref" > "${STATUS_DIR}/${slot}.failed"
    return 0
  fi

  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    minikube -p "$PROFILE" image load "$ghcr_ref" >/dev/null 2>&1 || {
      printf '%s' "$ghcr_ref" > "${STATUS_DIR}/${slot}.failed"
      return 0
    }
  fi

  # The local alias. See header note 2.
  if ! docker tag "$ghcr_ref" "$local_ref" >>"${STATUS_DIR}/${slot}.out" 2>&1; then
    printf '%s' "$ghcr_ref (alias to ${local_ref})" > "${STATUS_DIR}/${slot}.failed"
    return 0
  fi
  if [ "$MINIKUBE_MULTI_NODE" = true ]; then
    minikube -p "$PROFILE" image load "$local_ref" >/dev/null 2>&1 || true
  fi

  printf '%s\t%s' "$ghcr_ref" "$local_ref" > "${STATUS_DIR}/${slot}.done"
}

# ---- Parallel fan-out ---------------------------------------------------
slot=0
selected=0
while IFS="$(printf '\t')" read -r name local_ref; do
  [ -n "$name" ] || continue
  if [ -n "$ONLY_SVC" ] && [[ "$name" != *"$ONLY_SVC"* ]] && [[ "$local_ref" != *"$ONLY_SVC"* ]]; then
    continue
  fi
  selected=$((selected + 1))
  slot=$((slot + 1))
  # Bounded concurrency without GNU parallel or `wait -n` (bash 3.2 on macOS).
  while [ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PULL_PARALLELISM" ]; do
    sleep 0.2
  done
  pull_one "$name" "$local_ref" "$slot" &
done <<< "$PULL_LIST"
wait

if [ "$selected" -eq 0 ]; then
  err "--only=${ONLY_SVC} matched no pull_in_ghcr_mode image"
  exit 1
fi

# ---- Report -------------------------------------------------------------
FAILED=()
FAILED_SLOTS=()
for f in "${STATUS_DIR}"/*.failed; do
  [ -e "$f" ] || continue
  FAILED+=("$(cat "$f")")
  FAILED_SLOTS+=("$(basename "$f" .failed)")
done

DONE_COUNT=0
for f in "${STATUS_DIR}"/*.done; do
  [ -e "$f" ] || continue
  DONE_COUNT=$((DONE_COUNT + 1))
  ok "$(cut -f1 "$f") -> $(cut -f2 "$f")"
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo ""
  err "${#FAILED[@]} of ${selected} image(s) could not be pulled at tag '${IMAGE_TAG}':"
  idx=0
  for ref in "${FAILED[@]}"; do
    err "  ${ref}"
    # Surface the diagnostic docker already captured instead of discarding it.
    # A transient network error and a missing tag both print just the ref
    # here; the "why" only exists in the captured output. Trimmed to the last
    # few lines -- layer-progress noise can run to hundreds of lines per
    # image, and several images can fail at once.
    out_file="${STATUS_DIR}/${FAILED_SLOTS[$idx]}.out"
    if [ -s "$out_file" ]; then
      while IFS= read -r diag_line; do
        err "      ${diag_line}"
      done < <(tail -n 5 "$out_file")
    fi
    idx=$((idx + 1))
  done
  echo "" >&2
  err "The tag '${IMAGE_TAG}' came from the ${TAG_ORIGIN}."
  if [ "$DONE_COUNT" -gt 0 ]; then
    # Other images pulled fine at this exact tag, so the tag itself is not in
    # question -- this is a per-image failure (registry blip, timeout), not a
    # tag that hasn't been promoted yet.
    err "${DONE_COUNT} other image(s) pulled fine at '${IMAGE_TAG}', so the tag exists;"
    err "the failure(s) above look transient. Retry:"
    err "    make minikube-setup"
  elif [ "$IMAGE_TAG" != "latest" ]; then
    err "If '${IMAGE_TAG}' has not been promoted yet (the release-prep commit reaches main"
    err "BEFORE the tag is cut and the images are promoted), pull a tag that exists:"
    err "    MINIKUBE_IMAGE_TAG=latest make minikube-setup"
  else
    # IMAGE_TAG is already 'latest' and every selected image failed -- do not
    # recommend the tag that just failed (verbatim from a real run).
    err "Every selected image failed at '${IMAGE_TAG}', which is already the widest tag;"
    err "this does not look like an unpromoted tag. Retry, or check registry/network access:"
    err "    make minikube-setup"
  fi
  err "Or build everything locally instead:"
  err "    make minikube-setup-local"
  exit 1
fi

# ---- Image manifest -----------------------------------------------------
# Same shape build-images.sh writes. scripts/minikube/full-setup.sh:608 uses
# this file as a `find -newer` staleness marker, and its absence makes the ghcr
# path look like "images were never built".
#
# `imageSource` is not decoration: `build-images.sh --verify-only` reads it back
# to decide whether to verify ghcr.io/evenfire-ai/* or clerum/* refs. Without a
# recorded mode it falls back to the IMAGE_SOURCE env default (ghcr), which is
# how a locally built cluster came to be reported as "25 of 28 images missing".
# This writer only ever pulls, so the value is always "ghcr".
MANIFEST_FILE="${PROJECT_DIR}/deploy/minikube/.image-manifest.json"
mkdir -p "$(dirname "$MANIFEST_FILE")"
{
  echo "{"
  echo "  \"generated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"profile\": \"${PROFILE}\","
  echo "  \"imageSource\": \"ghcr\","
  echo "  \"imageTag\": \"${IMAGE_TAG}\","
  echo "  \"images\": {"
  first=true
  for f in "${STATUS_DIR}"/*.done; do
    [ -e "$f" ] || continue
    ghcr_ref="$(cut -f1 "$f")"
    local_ref="$(cut -f2 "$f")"
    sha="$(docker inspect --format='{{.Id}}' "$ghcr_ref" 2>/dev/null || echo "NOT_PULLED")"
    for ref in "$ghcr_ref" "$local_ref"; do
      if [ "$first" = true ]; then first=false; else echo ","; fi
      printf '    "%s": "%s"' "$ref" "$sha"
    done
  done
  echo ""
  echo "  }"
  echo "}"
} > "$MANIFEST_FILE"
ok "Manifest: deploy/minikube/.image-manifest.json"

echo ""
echo -e "${GREEN}${BOLD}All ${selected} published image(s) pulled at ${IMAGE_TAG} into minikube '${PROFILE}'.${NC}"
