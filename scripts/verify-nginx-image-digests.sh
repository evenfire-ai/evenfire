#!/usr/bin/env bash
# Verify that platform NGINX images contain the release their tag names. The
# image configs of the linux/amd64 and linux/arm64 manifests must both declare
# NGINX_VERSION equal to the tag's x.y.z.
#
# Usage: verify-nginx-image-digests.sh [name:tag@sha256:digest ...]
#        verify-nginx-image-digests.sh --tags name:tag [name:tag ...]
# With no arguments, the references come from
# validate-nginx-images.sh --list-digest-pins. Needs docker buildx and jq.
#
# --tags checks the supplied references directly in their registries. For
# digest checks, NGINX_REGISTRY_MIRROR can redirect official Docker Hub names
# to a mirror with the same digest. A variable registry prefix is not resolved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/nginx-image-policy.sh
source "$SCRIPT_DIR/nginx-image-policy.sh"
REQUIRED_PLATFORMS="linux/amd64 linux/arm64"
MIRROR="${NGINX_REGISTRY_MIRROR:-}"

verification="digest-pinned"
if [ "${1:-}" = "--tags" ]; then
  shift
  verification="tagged"
  refs="$(printf '%s\n' "$@")"
elif [ "$#" -gt 0 ]; then
  refs="$(printf '%s\n' "$@")"
else
  refs="$(bash "$SCRIPT_DIR/validate-nginx-images.sh" --list-digest-pins)"
fi
if [ -z "$refs" ]; then
  echo "ERROR: no $verification NGINX references to verify" >&2
  exit 1
fi

failed=0
checked=0
while IFS= read -r ref; do
  problem="$(nginx_ref_problem "$ref")"
  split_ref "$ref"
  if [ -n "$problem" ]; then
    echo "ERROR: $ref: $problem" >&2
    failed=1
    continue
  fi
  want="${ref_tag%%-*}"
  target="$ref"
  if [ "$verification" = "digest-pinned" ]; then
    if [ -z "$ref_digest" ]; then
      echo "ERROR: $ref has no digest to verify" >&2
      failed=1
      continue
    fi
    name="${ref%@*}"
    name="${name%:*}"
    case "$name" in
      nginx | docker.io/library/nginx) hub_repo="library/nginx" ;;
      nginx/nginx-unprivileged | docker.io/nginx/nginx-unprivileged) hub_repo="nginx/nginx-unprivileged" ;;
      nginxinc/nginx-unprivileged | docker.io/nginxinc/nginx-unprivileged) hub_repo="nginxinc/nginx-unprivileged" ;;
      *) hub_repo="" ;;
    esac
    target="$name@$ref_digest"
    if [ -n "$MIRROR" ] && [ -n "$hub_repo" ]; then
      target="$MIRROR/$hub_repo@$ref_digest"
    fi
  fi
  if ! image_json="$(docker buildx imagetools inspect "$target" --format '{{json .Image}}')"; then
    echo "ERROR: could not inspect $target (for $ref)" >&2
    failed=1
    continue
  fi
  for platform in $REQUIRED_PLATFORMS; do
    # A multi-platform index gives a map keyed by platform; a single-platform
    # manifest gives one config object, which has no platform key. The value
    # stays JSON-encoded (null when the platform is absent), so it is compared
    # whole and a newline or space in it cannot pass for another platform.
    got="$(jq -c --arg p "$platform" '
      (if has("config") then {"single": .} else . end)
      | if has($p) then [.[$p].config.Env[]? | select(startswith("NGINX_VERSION=")) | ltrimstr("NGINX_VERSION=")] | first // "<none>" else null end
    ' <<<"$image_json")"
    shown="${got#\"}"
    shown="${shown%\"}"
    if [ "$got" = null ]; then
      echo "ERROR: $target has no $platform manifest (for $ref)" >&2
      failed=1
    elif [ "$got" != "\"$want\"" ]; then
      echo "ERROR: $target $platform declares NGINX_VERSION=$shown, tag says $want (for $ref)" >&2
      failed=1
    else
      echo "ok: $target $platform NGINX_VERSION=$want (for $ref)"
    fi
  done
  checked=$((checked + 1))
done <<<"$refs"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "OK -- $checked $verification NGINX reference(s) match their tag on $REQUIRED_PLATFORMS"
