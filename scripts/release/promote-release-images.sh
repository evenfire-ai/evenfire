#!/usr/bin/env bash
set -euo pipefail

# Anchored to this script's own location, not the caller's cwd. The
# workflow always invokes this from the repo root, but node's dynamic
# import() below resolves a relative specifier against the current
# directory, not the script file -- run this from any other directory and
# "./scripts/release/images-manifest.mjs" silently resolves to the wrong
# (or a nonexistent) path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REGISTRY="ghcr.io/evenfire-ai"
DRY_RUN="${DRY_RUN:-true}"
RELEASE_REF="${RELEASE_REF:?RELEASE_REF is required}"
VERSION="${RELEASE_REF#v}"
# The tag that lands must carry a "v" prefix -- the consuming workstream pins
# a v-prefixed image tag downstream, so promoting to a bare :0.6.0 would
# produce a tag nothing ever pulls.
TAG="v${VERSION}"
TAG_SHA="${TAG_SHA:-$(git rev-parse --verify --end-of-options "$RELEASE_REF^{commit}")}"

if [[ ! "$TAG_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || ! git cat-file -e "${TAG_SHA}^{commit}"; then
  echo "::error::TAG_SHA must identify an available full commit SHA" >&2
  exit 1
fi

# :stable moves only for a strict release. A v0.6.0-rc dry run must not
# re-point the tag the documentation tells people to use.
MOVE_STABLE=false
[[ "$RELEASE_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && MOVE_STABLE=true

# Captured into a variable, not read via `mapfile -t IMAGES < <(...)`.
# Process substitution hides the reader's exit status from `set -e`: a
# broken deploy/images.json (images-manifest.mjs's load() throws at import
# time) printed a Node stack trace to stderr but still let `mapfile` succeed
# on whatever partial/empty output had been flushed, so this job used to
# report success -- and promote nothing -- after failing to even read its
# own image list. Command substitution assignment IS visible to `set -e`.
if ! IMAGES_TSV="$(node -e '
  import("'"$SCRIPT_DIR"'/images-manifest.mjs").then(m =>
    m.publishedImages().forEach(i => console.log(`${i.name}\t${(i.source_paths||[]).join(",")}`)))')"; then
  echo "::error::could not load the published image list (deploy/images.json via images-manifest.mjs); see the Node error above" >&2
  exit 1
fi

# An empty list is also a silent-success trap, even when the node command
# above exits 0 (e.g. every image's `published` flag flipped false). A
# release that would ship zero images must fail loudly, not report done.
if [ -z "$IMAGES_TSV" ]; then
  echo "::error::the published image list is empty; refusing to report success for a release that would ship nothing" >&2
  exit 1
fi

mapfile -t IMAGES <<< "$IMAGES_TSV"

failed=0
for row in "${IMAGES[@]}"; do
  name="${row%%$'\t'*}"; paths="${row#*$'\t'}"
  if ! digest="$(node scripts/release/resolve-release-images.mjs \
        --image "$name" --source-paths "$paths" --tag-sha "$TAG_SHA")"; then
    failed=1; continue
  fi

  # Verify the INDEX we are about to promote is multi-arch. Existence alone
  # would let a single-platform copy through, which is the exact gap this
  # workstream exists to close.
  #
  # Guarded the same way as the resolver call above: a bare assignment here
  # let a transient `crane manifest` failure or a node parse error abort the
  # WHOLE loop under `set -euo pipefail`, instead of marking just this one
  # image failed and continuing -- the opposite of the pattern one line up,
  # and it makes a partial-promotion state MORE likely, not less.
  if ! platforms="$(crane manifest "$REGISTRY/$name@$digest" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
            const m=JSON.parse(s).manifests||[];
            console.log(m.map(x=>x.platform?.architecture).filter(a=>a&&a!=="unknown").sort().join(","))})')"; then
    echo "::error::$name: could not verify the multi-arch manifest at $digest (crane manifest or the platform parse failed)"
    failed=1; continue
  fi
  # Subset match, not exact equality against "amd64,arm64": check-image-
  # visibility.mjs's guard already treats a third platform as still
  # multi-arch (it checks .includes for each of amd64/arm64), and an index
  # with a third platform passing that guard but failing this one is exactly
  # the kind of drift these two guards must not have between them.
  has_amd64=false; has_arm64=false
  case ",$platforms," in *,amd64,*) has_amd64=true ;; esac
  case ",$platforms," in *,arm64,*) has_arm64=true ;; esac
  if [ "$has_amd64" != true ] || [ "$has_arm64" != true ]; then
    echo "::error::$name@$digest is [$platforms], expected amd64,arm64"
    failed=1; continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "would promote $name@$digest -> :$TAG ($platforms)"
    continue
  fi

  crane copy "$REGISTRY/$name@$digest" "$REGISTRY/$name:$TAG"
  [ "$MOVE_STABLE" = "true" ] && crane copy "$REGISTRY/$name@$digest" "$REGISTRY/$name:stable"
  echo "promoted $name@$digest -> :$TAG"
done

exit $failed
