// Every published image must be anonymously pullable and multi-arch.
//
// This exists because control-ui was private for an unknown length of time and
// nobody noticed: new GHCR packages default to private, so any image added to
// the matrix lands private, and the first person to find out is a stranger
// whose setup dies on one ErrImagePull. The fix at the time was a manual UI
// click with no audit trail.
import process from 'node:process'
import { publishedImages } from '../release/images-manifest.mjs'

const NAMESPACE = 'evenfire-ai'
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

async function token(image) {
  const url = `https://ghcr.io/token?scope=repository:${NAMESPACE}/${image}:pull&service=ghcr.io`
  const res = await fetch(url)
  if (!res.ok) return null
  return (await res.json()).token
}

const failures = []

for (const image of publishedImages()) {
  const t = await token(image.name)
  if (!t) {
    failures.push(`${image.name}: no anonymous pull token (the package is private)`)
    continue
  }
  const res = await fetch(`https://ghcr.io/v2/${NAMESPACE}/${image.name}/manifests/latest`, {
    headers: { Authorization: `Bearer ${t}`, Accept: ACCEPT },
  })
  if (!res.ok) {
    failures.push(`${image.name}: manifests/latest returned HTTP ${res.status}`)
    continue
  }
  const body = await res.json()
  // Every real index carries buildx attestation manifests reported as
  // unknown/unknown. Counting entries instead of filtering them makes an
  // amd64-only image look multi-arch.
  const arches = (body.manifests ?? [])
    .map(m => m.platform?.architecture)
    .filter(a => a && a !== 'unknown')
  if (!arches.includes('amd64') || !arches.includes('arm64')) {
    failures.push(
      `${image.name}: platforms are [${arches.join(', ') || 'none'}], expected amd64 and arm64`
    )
  }
}

if (failures.length > 0) {
  console.error(`::error::${failures.length} published image(s) failed the visibility/arch guard:`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

console.log(
  `all ${publishedImages().length} published images are anonymously pullable and multi-arch`
)
