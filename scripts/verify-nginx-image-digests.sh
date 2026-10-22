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
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_PLATFORMS="linux/amd64 linux/arm64"

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
  name_tag="${ref%@*}"
  digest="${ref#*@}"
  tag="${name_tag##*:}"
  if [ "$name_tag" = "$ref" ] || ! [[ "$tag" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-[[:alnum:]_.-]+)?$ ]]; then
    echo "ERROR: $ref is not name:<x.y.z>[-suffix]@sha256:<digest>" >&2
    failed=1
    continue
  fi
  want="${BASH_REMATCH[1]}"
  if ! image_json="$(docker buildx imagetools inspect "${name_tag%:*}@$digest" --format '{{json .Image}}')"; then
    echo "ERROR: could not inspect $ref" >&2
    failed=1
    continue
  fi
  # A multi-platform index gives a map keyed by platform; a single-platform
  # manifest gives one config object.
  versions="$(jq -r '
    (if has("config") then {"single": .} else . end)
    | to_entries[]
    | "\(.key) \([.value.config.Env[]? | select(startswith("NGINX_VERSION=")) | ltrimstr("NGINX_VERSION=")] | first // "<none>")"
  ' <<<"$image_json")"
  for platform in $REQUIRED_PLATFORMS; do
    got="$(awk -v p="$platform" '$1 == p { print $2 }' <<<"$versions")"
    if [ -z "$got" ]; then
      echo "ERROR: $ref has no $platform manifest" >&2
      failed=1
    elif [ "$got" != "$want" ]; then
      echo "ERROR: $ref $platform declares NGINX_VERSION=$got, tag says $want" >&2
      failed=1
    else
      echo "ok: $ref $platform NGINX_VERSION=$got"
    fi
  done
  checked=$((checked + 1))
done <<<"$refs"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "OK -- $checked digest-pinned NGINX reference(s) match their tag on $REQUIRED_PLATFORMS"
