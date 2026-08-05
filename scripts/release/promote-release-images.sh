#!/usr/bin/env bash
set -euo pipefail

REGISTRY="ghcr.io/evenfire-ai"
DRY_RUN="${DRY_RUN:-true}"
RELEASE_REF="${RELEASE_REF:?RELEASE_REF is required}"
VERSION="${RELEASE_REF#v}"
TAG_SHA="$(git rev-parse "$RELEASE_REF^{commit}")"

# :stable moves only for a strict release. A v0.6.0-rc dry run must not
# re-point the tag the documentation tells people to use.
MOVE_STABLE=false
[[ "$RELEASE_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && MOVE_STABLE=true

mapfile -t IMAGES < <(node -e '
  import("./scripts/release/images-manifest.mjs").then(m =>
    m.publishedImages().forEach(i => console.log(`${i.name}\t${(i.source_paths||[]).join(",")}`)))')

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
    echo "would promote $name@$digest -> :$VERSION ($platforms)"
    continue
  fi

  crane copy "$REGISTRY/$name@$digest" "$REGISTRY/$name:$VERSION"
  [ "$MOVE_STABLE" = "true" ] && crane copy "$REGISTRY/$name@$digest" "$REGISTRY/$name:stable"
  echo "promoted $name@$digest -> :$VERSION"
done

exit $failed
