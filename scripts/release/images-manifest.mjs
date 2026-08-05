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
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.images)) {
    throw new Error(`${MANIFEST_PATH} must contain an "images" array`)
  }
  for (const image of parsed.images) {
    if (!image.name) throw new Error(`${MANIFEST_PATH}: an entry has no name`)
    if (typeof image.published !== 'boolean') {
      throw new Error(`${MANIFEST_PATH}: ${image.name} must set published explicitly`)
    }
    if (typeof image.deployed_to_minikube !== 'boolean') {
      throw new Error(`${MANIFEST_PATH}: ${image.name} must set deployed_to_minikube explicitly`)
    }
    if ('pull_in_ghcr_mode' in image) {
      throw new Error(
        `${MANIFEST_PATH}: ${image.name} stores pull_in_ghcr_mode; it is derived ` +
          `from published && deployed_to_minikube and must not be written down`
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
