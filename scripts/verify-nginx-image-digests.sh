#!/usr/bin/env bash
# Verify that every digest-pinned platform NGINX reference really is the NGINX
# release its tag names. scripts/validate-nginx-images.sh checks tags; a digest
# next to a good tag could still point at an older image, so this reads the
# immutable digest from the registry: the image config of the linux/amd64 and
# linux/arm64 manifests under it must both declare NGINX_VERSION equal to the
# tag's x.y.z.
#
# Usage: verify-nginx-image-digests.sh [name:tag@sha256:digest ...]
# With no arguments, the references come from
# validate-nginx-images.sh --list-digest-pins. Needs docker buildx and jq.
#
# Each reference is inspected once, under the name it is written with. When
# NGINX_REGISTRY_MIRROR is set (CI uses mirror.gcr.io), Docker Hub names
# (nginx, docker.io/library/nginx, nginxinc/nginx-unprivileged,
# docker.io/nginxinc/nginx-unprivileged) are inspected on that mirror instead:
# same digest, same bytes. A failed inspect is an error; there is no retry and
# no second registry. A variable registry prefix is not resolved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/nginx-image-policy.sh
source "$SCRIPT_DIR/nginx-image-policy.sh"
REQUIRED_PLATFORMS="linux/amd64 linux/arm64"
MIRROR="${NGINX_REGISTRY_MIRROR:-}"

if [ "$#" -gt 0 ]; then
  refs="$(printf '%s\n' "$@")"
else
  refs="$(bash "$SCRIPT_DIR/validate-nginx-images.sh" --list-digest-pins)"
fi
if [ -z "$refs" ]; then
  echo "ERROR: no digest-pinned NGINX references to verify" >&2
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
  if [ -z "$ref_digest" ]; then
    echo "ERROR: $ref has no digest to verify" >&2
    failed=1
    continue
  fi
  want="${ref_tag%%-*}"
  name="${ref%@*}"
  name="${name%:*}"
  case "$name" in
    nginx | docker.io/library/nginx) hub_repo="library/nginx" ;;
    nginxinc/nginx-unprivileged | docker.io/nginxinc/nginx-unprivileged) hub_repo="nginxinc/nginx-unprivileged" ;;
    *) hub_repo="" ;;
  esac
  target="$name@$ref_digest"
  if [ -n "$MIRROR" ] && [ -n "$hub_repo" ]; then
    target="$MIRROR/$hub_repo@$ref_digest"
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
echo "OK -- $checked digest-pinned NGINX reference(s) match their tag on $REQUIRED_PLATFORMS"
