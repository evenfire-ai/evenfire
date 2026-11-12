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
TAG_SHA="$(git rev-parse "$RELEASE_REF^{commit}")"

# A dry run takes any ref git accepts, and some of them (origin/main, main~1,
# <sha>^) do not make a valid image tag: crane cannot even parse
# ghcr.io/...:vorigin/main. Such a dry run skips everything that reads :$TAG,
# which cannot exist anyway. A real run promotes to :$TAG, so it must be one.
TAG_IS_VALID=true
if ! [[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  if [ "$DRY_RUN" != "true" ]; then
    echo "::error::$RELEASE_REF does not make a valid image tag (:$TAG); refusing to promote" >&2
    exit 1
  fi
  TAG_IS_VALID=false
  echo ":$TAG is not a valid image tag, so this dry run skips the existing-version-tag check and the release's own tag candidate"
fi

# :stable only moves forward. stable_decision sets MOVE_STABLE, and STABLE_WHY
# to the reason when it stays. A strict release moves it only when no other
# strict release tag is higher and the highest other one is an ancestor of the
# release commit, so neither a patch for an older line (or a rerun of one) nor
# a higher version tagged at an older commit moves :stable backwards. A
# v0.6.0-rc must not re-point the tag the documentation tells people to use
# either. `git merge-base --is-ancestor` answers with exit 0 or 1; anything
# else is an error, not a "no".
stable_decision() {
  MOVE_STABLE=false; STABLE_WHY=''
  [[ "$RELEASE_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 0
  local decision
  if ! decision="$(TAG="$TAG" TAG_SHA="$TAG_SHA" node --input-type=module -e '
    import { compareVersions } from "'"$SCRIPT_DIR"'/release-coordinates.mjs"
    import { execFileSync, spawnSync } from "node:child_process"
    const { TAG, TAG_SHA } = process.env
    const highest = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
      .split("\n").filter(t => /^v\d+\.\d+\.\d+$/.test(t) && t !== TAG)
      .reduce((a, b) => (a === null || compareVersions(b.slice(1), a.slice(1)) > 0 ? b : a), null)
    if (highest === null) {
      console.log("true")
    } else if (compareVersions(TAG.slice(1), highest.slice(1)) < 0) {
      console.log(`false\t${TAG} is below ${highest}, the highest release tag`)
    } else {
      const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", highest, TAG_SHA],
        { stdio: ["ignore", "ignore", "inherit"] })
      if (ancestor.status === 0) console.log("true")
      else if (ancestor.status === 1)
        console.log(`false\t${highest}, the highest other release tag, is not an ancestor of the release commit ${TAG_SHA}`)
      else process.exit(1)
    }')"; then
    echo "::error::could not compare $RELEASE_REF against the existing release tags" >&2
    exit 1
  fi
  MOVE_STABLE="${decision%%$'\t'*}"
  if [ "$MOVE_STABLE" != true ]; then STABLE_WHY="${decision#*$'\t'}"; fi
}
stable_decision

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

# Pass one: resolve and verify every image, and promote nothing. A release is
# all images or none, so a single refused image must leave the registry exactly
# as it was.
failed=0
PROMOTE_NAMES=(); PROMOTE_DIGESTS=(); PROMOTE_VIAS=()
# The release's own tag is the resolver's first candidate, so a re-run after a
# copy pass that failed midway converges on what it already published.
RELEASE_TAG_ARGS=()
if [ "$TAG_IS_VALID" = true ]; then RELEASE_TAG_ARGS=(--release-tag "$TAG"); fi
for row in "${IMAGES[@]}"; do
  name="${row%%$'\t'*}"; paths="${row#*$'\t'}"
  if ! resolved="$(node "$SCRIPT_DIR/resolve-release-images.mjs" \
        --image "$name" --source-paths "$paths" --tag-sha "$TAG_SHA" \
        ${RELEASE_TAG_ARGS[@]+"${RELEASE_TAG_ARGS[@]}"})"; then
    failed=$((failed + 1)); continue
  fi
  # The resolver prints "<digest>\t<candidate tag>". Anything else -- a
  # second tab or line, no candidate, a digest that is not sha256 hex -- fails
  # the image instead of being spliced into crane refs.
  digest="${resolved%%$'\t'*}"; via="${resolved#*$'\t'}"
  if [[ "$resolved" != *$'\t'* || -z "$via" || "$via" == *[$'\t\n']* ]] \
      || ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::$name: the resolver printed '$resolved'; expected <sha256 digest><TAB><candidate tag>"
    failed=$((failed + 1)); continue
  fi

  # Verify the INDEX we are about to promote is multi-arch. Existence alone
  # would let a single-platform copy through, which is the exact gap this
  # workstream exists to close.
  #
  # Guarded the same way as the resolver call above: a bare assignment here
  # let a transient `crane manifest` failure or a node parse error abort the
  # WHOLE loop under `set -euo pipefail`, instead of marking just this one
  # image failed and continuing.
  if ! platforms="$(crane manifest "$REGISTRY/$name@$digest" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
            const m=JSON.parse(s).manifests||[];
            console.log(m.map(x=>x.platform?.architecture).filter(a=>a&&a!=="unknown").sort().join(","))})')"; then
    echo "::error::$name: could not verify the multi-arch manifest at $digest (crane manifest or the platform parse failed)"
    failed=$((failed + 1)); continue
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
    failed=$((failed + 1)); continue
  fi

  # A published version tag is immutable. Not found passes (first promotion),
  # the same digest passes (a rerun), anything else fails the image.
  if [ "$TAG_IS_VALID" = true ]; then
    if existing="$(crane digest "$REGISTRY/$name:$TAG" 2>&1)"; then
      if [ "$existing" != "$digest" ]; then
        echo "::error::$name:$TAG already points at $existing; refusing to move a published version tag to $digest"
        failed=$((failed + 1)); continue
      fi
    elif [[ "$existing" != *MANIFEST_UNKNOWN* ]]; then
      echo "::error::$name:$TAG: could not check the existing version tag: $existing"
      failed=$((failed + 1)); continue
    fi
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "would promote $name@$digest via $via -> :$TAG ($platforms)"
  fi
  PROMOTE_NAMES+=("$name"); PROMOTE_DIGESTS+=("$digest"); PROMOTE_VIAS+=("$via")
done

if [ "$DRY_RUN" = "true" ]; then
  if [ -n "$STABLE_WHY" ]; then echo ":stable stays where it is: $STABLE_WHY"; fi
  # 0 or 1, not the count: an exit status wraps at 256.
  exit $(( failed > 0 ))
fi

if [ "$failed" -ne 0 ]; then
  echo "::error::$failed image(s) failed; promoted nothing"
  exit 1
fi

# Pass two: every version tag first, then every :stable, so :stable never
# moves unless all the version tags landed. A failed copy stops the run
# (set -e); a re-run converges on the version tags already written.
for i in "${!PROMOTE_NAMES[@]}"; do
  crane copy "$REGISTRY/${PROMOTE_NAMES[$i]}@${PROMOTE_DIGESTS[$i]}" "$REGISTRY/${PROMOTE_NAMES[$i]}:$TAG"
  echo "promoted ${PROMOTE_NAMES[$i]}@${PROMOTE_DIGESTS[$i]} via ${PROMOTE_VIAS[$i]} -> :$TAG"
done

# Another release may have pushed a higher tag since this checkout was made, so
# fetch the tags and decide again right before :stable moves. --force lets
# origin's tags replace local ones: actions/checkout re-fetches an annotated
# release tag as a lightweight ref (+<commit>:refs/tags/<tag>), and a plain
# fetch refuses to replace it, which would stop every annotated release here.
# A failed fetch stops here, with every version tag written: a re-run
# converges on them and moves :stable then.
if [[ "$RELEASE_REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  if git remote get-url origin >/dev/null 2>&1 && ! git fetch --quiet --tags --force origin; then
    echo "::error::could not fetch the release tags from origin, so :stable was not moved; every :$TAG is written, so re-run this release to move :stable"
    exit 1
  fi
  stable_decision
fi
if [ "$MOVE_STABLE" = "true" ]; then
  for i in "${!PROMOTE_NAMES[@]}"; do
    crane copy "$REGISTRY/${PROMOTE_NAMES[$i]}@${PROMOTE_DIGESTS[$i]}" "$REGISTRY/${PROMOTE_NAMES[$i]}:stable"
    echo "promoted ${PROMOTE_NAMES[$i]}@${PROMOTE_DIGESTS[$i]} via ${PROMOTE_VIAS[$i]} -> :stable"
  done
elif [ -n "$STABLE_WHY" ]; then
  echo ":stable stays where it is: $STABLE_WHY"
fi
