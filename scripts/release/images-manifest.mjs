// The one image list. Three lists previously disagreed about what exists:
// build-publish.yml's matrix, ALL_IMAGES in build-images.sh, and the minikube
// overlay's images: block. They are overlapping SUBSETS, so this file carries
// per-image flags rather than pretending one list serves all three consumers.
//
// JSON rather than YAML deliberately: scripts here use node: builtins only (the
// shell-syntax CI job has no npm ci), and GitHub Actions can consume JSON
// directly via fromJSON() for the build matrix. A YAML parser would be a
// dependency on both sides.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MANIFEST_PATH = 'deploy/images.json'

function load() {
  const raw = fs.readFileSync(path.join(ROOT, MANIFEST_PATH), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // Match every other failure in this function: a `deploy/images.json:`
    // prefix so a broken manifest names itself instead of surfacing a bare
    // SyntaxError with no file attached.
    throw new Error(`${MANIFEST_PATH}: invalid JSON -- ${error.message}`)
  }
  if (!Array.isArray(parsed.images)) {
    throw new Error(`${MANIFEST_PATH} must contain an "images" array`)
  }
  for (const image of parsed.images) {
    if (!image.name) throw new Error(`${MANIFEST_PATH}: an entry has no name`)
    // check-image-visibility.mjs interpolates image.name straight into GHCR
    // URLs, and promote-release-images.sh interpolates it into shell `crane`
    // refs -- both trusted consumers of a trusted in-repo file, but validating
    // the shape here once defends every consumer instead of relying on each
    // one to notice a malformed name on its own.
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(image.name)) {
      throw new Error(`${MANIFEST_PATH}: ${image.name} is not a valid image name`)
    }
    if (typeof image.published !== 'boolean') {
      throw new Error(`${MANIFEST_PATH}: ${image.name} must set published explicitly`)
    }
    if (typeof image.deployed_to_minikube !== 'boolean') {
      throw new Error(`${MANIFEST_PATH}: ${image.name} must set deployed_to_minikube explicitly`)
    }
    // e2e_only marks a fixture that ONLY `make minikube-setup-e2e` acquires.
    // Optional, so absent means false, but a present value must be a real
    // boolean: `"e2e_only": "false"` is truthy and would silently drop the
    // image from the default verify set.
    if ('e2e_only' in image && typeof image.e2e_only !== 'boolean') {
      throw new Error(`${MANIFEST_PATH}: ${image.name} sets a non-boolean e2e_only`)
    }
    // A published image is pulled on the default path, so it is never an
    // E2E-only fixture. The pair would make minikubeVerifyRefs() drop a ref
    // the cluster actually runs.
    if (image.published && image.e2e_only) {
      throw new Error(
        `${MANIFEST_PATH}: ${image.name} is published AND e2e_only -- a published image is ` +
          `acquired on the default path and must stay in the verify set`
      )
    }
    if ('pull_in_ghcr_mode' in image) {
      throw new Error(
        `${MANIFEST_PATH}: ${image.name} stores pull_in_ghcr_mode; it is derived ` +
          `from published && deployed_to_minikube and must not be written down`
      )
    }
    // An empty source_paths silently disabled resolve-release-images.mjs's
    // drift check: `(i.source_paths||[]).join(',')` produces '' for a missing
    // array, and the resolver's `if (sourcePaths)` then treats '' as "no
    // check requested" instead of "nothing to check", so the release gate
    // exits 0 without ever diffing. Reject it here, at the source, rather
    // than relying on every consumer to notice the gap on its own.
    if (
      image.published &&
      (!Array.isArray(image.source_paths) || image.source_paths.length === 0)
    ) {
      throw new Error(
        `${MANIFEST_PATH}: ${image.name} is published but has no source_paths -- the release gate ` +
          `would silently skip its drift check`
      )
    }
  }
  return parsed.images
}

export const IMAGES = load()

export function publishedImages() {
  return IMAGES.filter(i => i.published)
}

// The images a ghcr-mode minikube pulls. Deriving this rather than storing it
// is what stops the puller reaching for an unpublished fixture.
export function pullInGhcrMode() {
  return IMAGES.filter(i => i.published && i.deployed_to_minikube)
}

// The tag build-images.sh uses locally. Some images differ from their published
// name (playwright-server is built locally as clerum/playwright-mcp-server) and
// some use :v1 rather than :test.
export function localRef(image) {
  return `clerum/${image.local_name ?? image.name}:${image.local_tag ?? 'test'}`
}

export const GHCR_NAMESPACE = 'ghcr.io/evenfire-ai'

// The refs `build-images.sh --verify-only` must find in the cluster.
//
// This is NOT the build list (ALL_IMAGES in build-images.sh): that list is
// hand-ordered with per-image Dockerfile arguments. It is the set of refs the
// pods actually pull, which is why it splits on `published` -- a
// published+deployed image runs from ghcr in ghcr mode, an unpublished one is
// built locally and runs under its clerum/* ref in BOTH modes.
//
// `mode` must describe how the cluster's images were ACQUIRED, not what
// IMAGE_SOURCE happens to default to in the caller's shell. Verifying ghcr
// refs on a locally built cluster reports every image missing; verifying
// clerum/* on a ghcr cluster reports "all present" against images no pod
// references. Both are worse than no check.
export function minikubeVerifyRefs({ mode, tag, includeE2eFixtures = false } = {}) {
  if (mode !== 'ghcr' && mode !== 'local') {
    throw new Error(`minikubeVerifyRefs: mode must be 'ghcr' or 'local', got '${mode}'`)
  }
  if (mode === 'ghcr' && !tag) {
    throw new Error('minikubeVerifyRefs: ghcr mode needs a tag to build a ref from')
  }
  const fromGhcr = new Set(pullInGhcrMode().map(i => i.name))
  const refs = []
  for (const image of IMAGES) {
    if (!image.deployed_to_minikube) continue
    // The E2E-only fixtures are published:false, so ghcr cannot supply them,
    // and the default ghcr setup path does not build them either -- only
    // `make minikube-setup-e2e` does. Demanding them there fails a healthy
    // cluster with a remedy that can never work. The local path is different:
    // a full build_images run builds every fixture, so they stay in the set.
    if (image.e2e_only && mode === 'ghcr' && !includeE2eFixtures) continue
    if (mode === 'ghcr' && fromGhcr.has(image.name)) {
      refs.push(`${GHCR_NAMESPACE}/${image.name}:${tag}`)
    } else {
      refs.push(localRef(image))
    }
  }
  return refs
}
