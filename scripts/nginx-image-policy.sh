# shellcheck shell=bash
# NGINX image policy shared by scripts/validate-nginx-images.sh (tags in the
# tree) and scripts/verify-nginx-image-digests.sh (digests in the registry).
# Source it; it defines data and functions only.
#
# NGINX_RELEASE_FLOORS holds, per release line, the first release that fixes
# CVE-2026-15176, CVE-2026-93479, CVE-2026-95101, CVE-2026-97629 and
# CVE-2026-97205 (and the older CVE-2026-42945). A release on a listed line
# must be at or above that line's floor; a line newer than the last entry is
# accepted; any other line is rejected. Raise a floor here when a new CVE
# requires it.
NGINX_RELEASE_FLOORS=(1.30.6 1.31.7 1.32.0)

BASELINE_TEXT=""
for _floor in "${NGINX_RELEASE_FLOORS[@]}"; do
  BASELINE_TEXT="${BASELINE_TEXT:+$BASELINE_TEXT, }$_floor (${_floor%.*} line)"
done
BASELINE_TEXT="$BASELINE_TEXT or a newer line"
unset _floor

# Prints why an x.y.z[-suffix] tag is not acceptable; prints nothing if it is.
nginx_tag_problem() {
  local tag="$1" major minor patch floor floor_major floor_minor floor_patch
  if ! [[ "$tag" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-[[:alnum:]_.-]+)?$ ]]; then
    echo "tag '$tag' is not a fixed x.y.z release"
    return
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  patch=$((10#${BASH_REMATCH[3]}))
  for floor in "${NGINX_RELEASE_FLOORS[@]}"; do
    IFS=. read -r floor_major floor_minor floor_patch <<<"$floor"
    if [ "$major" -eq "$floor_major" ] && [ "$minor" -eq "$floor_minor" ]; then
      [ "$patch" -ge "$floor_patch" ] && return
      echo "release $major.$minor.$patch is below $BASELINE_TEXT"
      return
    fi
  done
  # Not on a listed line: accepted only when newer than the last listed line.
  if [ "$major" -gt "$floor_major" ] || { [ "$major" -eq "$floor_major" ] && [ "$minor" -gt "$floor_minor" ]; }; then
    return
  fi
  echo "release $major.$minor.$patch is below $BASELINE_TEXT"
}

# Splits [registry/]name[:tag][@digest] into the globals ref_tag, ref_digest
# and ref_at (1 when the reference has an '@', even with nothing after it).
split_ref() {
  local last="${1##*/}" rest
  rest="${last#"${last%%[:@]*}"}"
  ref_tag=""
  ref_digest=""
  ref_at=0
  case "$rest" in
    :*@*) ref_tag="${rest#:}"; ref_tag="${ref_tag%%@*}"; ref_digest="${rest#*@}"; ref_at=1 ;;
    :*) ref_tag="${rest#:}" ;;
    @*) ref_digest="${rest#@}"; ref_at=1 ;;
  esac
}

# Prints why an NGINX reference is not acceptable; prints nothing if it is.
nginx_ref_problem() {
  split_ref "$1"
  if [ "$ref_at" -eq 1 ] && [ -z "$ref_digest" ]; then
    echo "'@' without a digest"
    return
  fi
  if [ -n "$ref_digest" ]; then
    if [ -z "$ref_tag" ]; then
      echo "digest without a version tag (write nginx:<x.y.z>[-suffix]@sha256:...)"
      return
    fi
    if ! [[ "$ref_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "malformed digest '$ref_digest'"
      return
    fi
  fi
  nginx_tag_problem "$ref_tag"
}

# Any image named nginx, nginx/nginx-unprivileged, or the legacy
# nginxinc/nginx-unprivileged, under any registry path, is treated as upstream
# NGINX and held to the floors.
is_nginx_name() {
  case "$1" in
    nginx | */nginx | \
      nginx/nginx-unprivileged | */nginx/nginx-unprivileged | \
      nginxinc/nginx-unprivileged | */nginxinc/nginx-unprivileged) return 0 ;;
  esac
  return 1
}
