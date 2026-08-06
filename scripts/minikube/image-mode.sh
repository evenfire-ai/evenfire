#!/usr/bin/env bash
# ======================================================================
# Which images this cluster runs, and therefore which overlay renders it
# ======================================================================
#
# ONE resolver, sourced as a library and callable as a CLI. Every consumer that
# has to answer "is this cluster running ghcr release images or locally built
# clerum/* ones, and at which tag" asks here.
#
# THE ANSWER IS NOT THE IMAGE_SOURCE ENVIRONMENT VARIABLE. That describes what
# the caller's shell would have done; what a cluster actually runs is decided by
# whichever writer last acquired images, and both writers record it in
# deploy/minikube/.image-manifest.json (scripts/minikube/pull-images.sh writes
# "ghcr", scripts/minikube/build-images.sh writes "local"). Trusting the env
# default instead is what made `make minikube-verify-images` report "25 of 28
# images missing" on a healthy locally built cluster; the same mistake in
# scripts/minikube/pre-gate-sync.sh makes a gate pass against code that was
# never deployed, which is strictly worse because nothing reports it.
#
# The env var remains the fallback for a cluster nothing has built or pulled
# into yet, and a value that is neither ghcr nor local is always an error --
# guessing a mode silently picks a cluster shape.
#
# Usage (library):
#   source scripts/minikube/image-mode.sh
#   mode="$(image_mode_source "$PROJECT_DIR")"      || exit 1
#   tag="$(image_mode_tag "$PROJECT_DIR")"          || exit 1   # empty in local mode
#   dir="$(image_mode_render_dir "$PROJECT_DIR")"   || exit 1
#
# Usage (CLI, for Makefile recipes):
#   scripts/minikube/image-mode.sh --render-dir | --image-source | --image-tag
#                                  | --images-generated-at
#
# This file deliberately sets no shell options: it is sourced into scripts that
# run under `set -euo pipefail` and must not change their contract.
# ======================================================================

IMAGE_MODE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_MODE_PROJECT_DIR="$(cd "${IMAGE_MODE_SCRIPT_DIR}/../.." && pwd)"

# Prints `imageSource<TAB>imageTag<TAB>generated`, with any field the manifest
# does not carry (or carries in an unusable shape) left empty.
#
# A missing manifest is a legitimate "nothing recorded yet" and prints nothing.
# A node that cannot run is NOT: that is a broken toolchain, and reporting it as
# "nothing recorded" would silently hand the caller the env-var default.
image_mode_read_manifest() {
  local project_dir="${1:-$IMAGE_MODE_PROJECT_DIR}"
  local manifest out rc
  manifest="${project_dir}/deploy/minikube/.image-manifest.json"
  if [ ! -f "$manifest" ]; then
    return 0
  fi
  out="$(node -e '
    const fs = require("node:fs")
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    } catch {
      // A truncated or pre-dating manifest records nothing; the caller falls
      // back to the environment rather than aborting a healthy cluster.
      process.stdout.write("\t\t")
      process.exit(0)
    }
    const mode = parsed.imageSource === "ghcr" || parsed.imageSource === "local" ? parsed.imageSource : ""
    const tag =
      typeof parsed.imageTag === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.imageTag)
        ? parsed.imageTag
        : ""
    const generated =
      typeof parsed.generated === "string" && /^[A-Za-z0-9:._-]*$/.test(parsed.generated)
        ? parsed.generated
        : ""
    process.stdout.write(`${mode}\t${tag}\t${generated}`)
  ' "$manifest" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'image-mode: could not read %s: %s\n' "$manifest" "$out" >&2
    return 1
  fi
  printf '%s' "$out"
}

image_mode_manifest_field() {
  local project_dir="$1" field="$2" fields
  if ! fields="$(image_mode_read_manifest "$project_dir")"; then
    return 1
  fi
  printf '%s' "$fields" | cut -f"$field"
}

# ghcr|local from the manifest, else the environment. Prints nothing and fails
# when IMAGE_SOURCE names a mode that does not exist -- validated even when the
# manifest wins, because a typo in the environment is always a mistake worth
# surfacing rather than a value to ignore.
image_mode_source() {
  local project_dir="${1:-$IMAGE_MODE_PROJECT_DIR}" recorded env_mode
  env_mode="${IMAGE_SOURCE:-ghcr}"
  case "$env_mode" in
    ghcr | local) ;;
    *)
      printf "image-mode: unknown IMAGE_SOURCE '%s' (expected: ghcr | local)\n" "$env_mode" >&2
      return 1
      ;;
  esac
  if ! recorded="$(image_mode_manifest_field "$project_dir" 1)"; then
    return 1
  fi
  if [ -n "$recorded" ]; then
    printf '%s' "$recorded"
    return 0
  fi
  printf '%s' "$env_mode"
}

# The committed release pointer. The component is the single source of truth;
# MINIKUBE_IMAGE_TAG is a render-time lever applied to one run, never a second
# writer of the coordinate.
image_mode_pinned_tag() {
  local project_dir="${1:-$IMAGE_MODE_PROJECT_DIR}" component tags
  component="${project_dir}/deploy/components/ghcr-images/kustomization.yaml"
  if [ ! -f "$component" ]; then
    printf 'image-mode: ghcr component not found at %s\n' "$component" >&2
    return 1
  fi
  tags="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$component" | sort -u)"
  if [ -z "$tags" ]; then
    printf 'image-mode: no newTag: line in %s\n' "$component" >&2
    return 1
  fi
  if [ "$(printf '%s\n' "$tags" | wc -l | tr -d ' ')" != "1" ]; then
    printf 'image-mode: mixed newTag values in %s: %s\n' "$component" "$(printf '%s ' $tags)" >&2
    return 1
  fi
  printf '%s' "$tags"
}

# The ghcr tag this cluster runs: the explicit override, else what the last
# acquisition recorded, else the committed pin. Empty in local mode, where there
# is no ghcr coordinate at all.
image_mode_tag() {
  local project_dir="${1:-$IMAGE_MODE_PROJECT_DIR}" mode recorded tag
  if ! mode="$(image_mode_source "$project_dir")"; then
    return 1
  fi
  if [ "$mode" != ghcr ]; then
    return 0
  fi
  if [ -n "${MINIKUBE_IMAGE_TAG:-}" ]; then
    tag="$MINIKUBE_IMAGE_TAG"
  else
    if ! recorded="$(image_mode_manifest_field "$project_dir" 2)"; then
      return 1
    fi
    if [ -n "$recorded" ]; then
      tag="$recorded"
    elif ! tag="$(image_mode_pinned_tag "$project_dir")"; then
      return 1
    fi
  fi
  # The tag is interpolated into image refs and into a sed replacement, so its
  # charset is checked once, here, rather than at each of those sites.
  case "$tag" in
    *[!A-Za-z0-9._-]* | "")
      printf "image-mode: '%s' is not a usable image tag\n" "$tag" >&2
      return 1
      ;;
  esac
  printf '%s' "$tag"
}

# When the last image acquisition happened. A `make minikube-setup` between two
# pre-gates replaces every image and discards any shadow build, so a marker
# stamped before it describes a cluster that no longer exists.
image_mode_images_generated_at() {
  image_mode_manifest_field "${1:-$IMAGE_MODE_PROJECT_DIR}" 3
}

# A copy of deploy/ whose component carries an overridden tag.
#
# A stdout filter cannot do this: the overlay is rendered from a DIRECTORY by
# `kubectl kustomize` and by deploy/scripts/run-control-api-db-migration.sh,
# which takes --overlay and extracts the control-api image from the render.
# Rewriting the committed component in place would make an operator lever a
# second writer of the release coordinate. So the tree moves, exactly as
# scripts/minikube/full-setup.sh does it, and the path is derived from the
# project dir and the tag so repeated runs reuse one location instead of
# leaking a new mktemp -d every time.
image_mode_override_render_dir() {
  local project_dir="$1" tag="$2" key root component rewritten patch
  key="$(printf '%s' "$project_dir" | shasum | awk '{print $1}')"
  root="${TMPDIR:-/tmp}/clerum-image-tag-override/${key}-${tag}"
  rm -rf "$root"
  mkdir -p "$root"
  if ! cp -R "${project_dir}/deploy" "${root}/deploy"; then
    printf 'image-mode: could not copy %s/deploy for the tag override\n' "$project_dir" >&2
    return 1
  fi
  component="${root}/deploy/components/ghcr-images/kustomization.yaml"
  if [ ! -f "$component" ]; then
    printf 'image-mode: ghcr component missing from the deploy copy at %s\n' "$component" >&2
    return 1
  fi
  # overlays/minikube-ghcr renders `resources: ../minikube`, which patches with
  # patches/k8s-api-ip.yaml -- a GENERATED, gitignored file (the overlay commits
  # only the .template). Copying a tree that has never had one produces a render
  # dir that fails inside kustomize with
  #   evalsymlink failure on '<temp dir>/.../patches/k8s-api-ip.yaml'
  # which names a path in a temp directory and tells the operator nothing about
  # what to do. Fail here instead, naming the file in THEIR tree and the command
  # that writes it.
  patch="${root}/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
  if [ ! -f "$patch" ]; then
    printf 'image-mode: %s/deploy/overlays/minikube/patches/k8s-api-ip.yaml has not been generated, so the MINIKUBE_IMAGE_TAG=%s render copy would not render.\n' \
      "$project_dir" "$tag" >&2
    printf 'image-mode: generate it with: CONTEXT=<minikube-profile> deploy/scripts/minikube-detect-k8s-api-ip.sh (make minikube-setup and make minikube-deploy-all both do this)\n' >&2
    return 1
  fi
  # -i.bak plus rm keeps this portable across BSD and GNU sed; `sed -i ''` is a
  # BSD-only spelling GNU sed rejects.
  sed -i.bak "s|^\([[:space:]]*newTag:[[:space:]]*\).*$|\1${tag}|" "$component"
  rm -f "${component}.bak"
  rewritten="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$component" | sort -u)"
  if [ "$rewritten" != "$tag" ]; then
    printf "image-mode: tag override did not apply cleanly: copy carries '%s', expected '%s'\n" \
      "$rewritten" "$tag" >&2
    return 1
  fi
  printf '%s' "${root}/deploy/overlays/minikube-ghcr"
}

# The overlay directory that renders THIS cluster. Callers that render the
# wrong one apply manifests referencing images the cluster has never held:
# the local overlay on a ghcr cluster names clerum/*:test tags nothing built
# there, and the pinned ghcr overlay on an overridden cluster names a release
# nobody pulled.
image_mode_render_dir() {
  local project_dir="${1:-$IMAGE_MODE_PROJECT_DIR}" mode tag pinned
  if ! mode="$(image_mode_source "$project_dir")"; then
    return 1
  fi
  if [ "$mode" = local ]; then
    printf '%s' "${project_dir}/deploy/overlays/minikube"
    return 0
  fi
  if ! tag="$(image_mode_tag "$project_dir")"; then
    return 1
  fi
  if ! pinned="$(image_mode_pinned_tag "$project_dir")"; then
    return 1
  fi
  if [ "$tag" = "$pinned" ]; then
    printf '%s' "${project_dir}/deploy/overlays/minikube-ghcr"
    return 0
  fi
  image_mode_override_render_dir "$project_dir" "$tag"
}

# Back-compat name for build-images.sh, whose --verify-only path has always
# spelled it this way.
image_mode_recorded_source() {
  image_mode_manifest_field "${1:-$IMAGE_MODE_PROJECT_DIR}" 1
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  image_mode_cli() {
    case "${1:-}" in
      --image-source) image_mode_source ;;
      --image-tag) image_mode_tag ;;
      --render-dir) image_mode_render_dir ;;
      --images-generated-at) image_mode_images_generated_at ;;
      *)
        printf 'usage: image-mode.sh --image-source|--image-tag|--render-dir|--images-generated-at\n' >&2
        return 2
        ;;
    esac
  }
  IMAGE_MODE_CLI_OUT="$(image_mode_cli "$@")"
  IMAGE_MODE_CLI_RC=$?
  if [ "$IMAGE_MODE_CLI_RC" -eq 0 ]; then
    printf '%s\n' "$IMAGE_MODE_CLI_OUT"
  fi
  exit "$IMAGE_MODE_CLI_RC"
fi
