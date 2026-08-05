#!/usr/bin/env bash
set -euo pipefail

REGISTRY="ghcr.io/evenfire-ai"
DRY_RUN="${DRY_RUN:-true}"
RELEASE_REF="${RELEASE_REF:?RELEASE_REF is required}"
VERSION="${RELEASE_REF#v}"
# The tag that lands must carry the same "v" the consuming kustomize
# component and the operator recovery docs pin (newTag: v0.6.0,
# MINIKUBE_IMAGE_TAG=v0.6.1) -- promoting to a bare :0.6.0 would produce a tag
# nothing downstream ever pulls.
TAG="v${VERSION}"
TAG_SHA="$(git rev-parse "$RELEASE_REF^{commit}")"

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
  import("./scripts/release/images-manifest.mjs").then(m =>
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
  platforms="$(crane manifest "$REGISTRY/$name@$digest" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const m=JSON.parse(s).manifests||[];
        console.log(m.map(x=>x.platform?.architecture).filter(a=>a&&a!=="unknown").sort().join(","))})')"
  if [ "$platforms" != "amd64,arm64" ]; then
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
