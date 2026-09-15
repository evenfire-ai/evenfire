// Provenance proof for the optional Codex approved-tools fixture images.
//
// The fixture lane uses locally built Control API, proxy, MCP and coordinator
// images. The acquisition target builds each base and fixture with --only,
// preserving source revisions and exact derived-base IDs across partial builds.
//
// A ref that merely EXISTS is not proof that the delegation test exercised the
// code under review, and a fixture built from a stale base embeds that stale
// base. So this module certifies nothing until:
//
//   * the manifest names the exact profile that is about to be mutated;
//   * the profile currently resolves every expected ref to the recorded digest;
//   * every expected ref records the reviewed commit as its OWN source
//     revision (the manifest's gitHead is informational and certifies nothing);
//   * each fixture's recorded base and the base's current digest agree.
//
// It is a pure validator. It never spawns a command, reads a file, or writes
// one: the caller observes the profile with the same inventory read
// build-images.sh already uses, reads the manifest, and hands both in before
// the first cluster mutation. Failure throws an Error whose message starts with
// a stable code (IMAGE_PROOF_*) and names the acquisition command.
//
// The same repository is spelled two ways in practice: `minikube image ls`
// reports the canonical `docker.io/clerum/...` repository, while the manifest
// and deploy/images.json name the local refs as `clerum/...`. Both are one
// image, so comparisons run on the canonical form -- and two spellings of one
// image carrying different digests are a conflict, never two images.
import { IMAGES, localRef } from '../release/images-manifest.mjs'

export const ACQUIRE_COMMAND = 'make minikube-build-codex-approved-tools-fixtures'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const HEAD_PATTERN = /^[0-9a-f]{40}$/
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function localImageRef(name) {
  const entry = IMAGES.find(image => image.name === name)
  if (!entry)
    throw new Error(
      `IMAGE_PROOF_MANIFEST_INVALID: deploy/images.json has no image named ${name}, so the fixture set cannot be resolved`
    )
  return localRef(entry)
}

// Every fixture and its base must belong to the reviewed commit.
export const FIXTURE_IMAGES = Object.freeze([
  localImageRef('codex-approved-tools-mcp-e2e'),
  localImageRef('codex-approved-tools-proxy-e2e'),
  localImageRef('codex-approved-tools-workflow-e2e'),
  localImageRef('codex-approved-tools-control-api-e2e'),
])

export const BASE_IMAGES = Object.freeze([
  localImageRef('codex-llm-proxy'),
  localImageRef('workflow-custom-sdk-e2e'),
  localImageRef('control-api'),
])

export const EXPECTED_IMAGES = Object.freeze([...FIXTURE_IMAGES, ...BASE_IMAGES])

// Fixtures whose Dockerfile builds FROM another image this profile holds. The
// manifest records that base and the digest it resolved to; a fixture built
// from an older base still names the same base TAG, so the tag proves nothing
// on its own.
export const DERIVED_FIXTURES = Object.freeze([
  { ref: localImageRef('codex-approved-tools-proxy-e2e'), base: localImageRef('codex-llm-proxy') },
  {
    ref: localImageRef('codex-approved-tools-workflow-e2e'),
    base: localImageRef('workflow-custom-sdk-e2e'),
  },
  { ref: localImageRef('codex-approved-tools-control-api-e2e'), base: localImageRef('control-api') },
])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.toLowerCase()
  return DIGEST_PATTERN.test(normalized) ? normalized : ''
}

// Docker's own normalization: a first path component that is not a registry
// host is a Docker Hub namespace, and a ref with no path component at all is a
// library image. Anything this cannot normalize stays its own value, so it
// simply fails a later comparison instead of silently matching something else.
function canonicalImageRef(ref) {
  if (typeof ref !== 'string' || !ref || /\s/.test(ref)) return ''
  const separator = ref.indexOf('/')
  if (separator === -1) return `docker.io/library/${ref}`
  const registry = ref.slice(0, separator)
  const looksLikeRegistry =
    registry.includes('.') || registry.includes(':') || registry === 'localhost'
  return looksLikeRegistry ? ref : `docker.io/${ref}`
}

function normalizeObservations(images) {
  if (!Array.isArray(images))
    throw new Error(
      'IMAGE_PROOF_MANIFEST_INVALID: images must be the observed [{ ref, id }] inventory of the profile being mutated'
    )
  const observed = new Map()
  for (const entry of images) {
    if (!isRecord(entry) || typeof entry.ref !== 'string' || !entry.ref)
      throw new Error('IMAGE_PROOF_MANIFEST_INVALID: every observed image needs a ref and an id')
    const canonical = canonicalImageRef(entry.ref)
    if (!canonical)
      throw new Error(`IMAGE_PROOF_IMAGE_MISMATCH: '${entry.ref}' is not a usable image reference`)
    const digest = normalizeDigest(entry.id)
    if (!digest)
      throw new Error(
        `IMAGE_PROOF_IMAGE_MISMATCH: the observed id for ${entry.ref} is not a sha256 digest`
      )
    const previous = observed.get(canonical)
    if (previous && previous.id !== digest)
      throw new Error(
        `IMAGE_PROOF_IMAGE_MISMATCH: ${previous.ref} and ${entry.ref} are the same image with different ids (${previous.id}, ${digest})`
      )
    if (!previous) observed.set(canonical, { ref: entry.ref, id: digest })
  }
  return observed
}

// The manifest's own images map, keyed by canonical ref. Two spellings of one
// image may both be recorded; they must agree, or the manifest contradicts
// itself and no record from it can be trusted.
function indexRecordedImages(images) {
  const index = new Map()
  for (const [ref, value] of Object.entries(images)) {
    const canonical = canonicalImageRef(ref)
    const digest = normalizeDigest(value)
    if (!canonical || !digest) continue
    const existing = index.get(canonical)
    if (existing && existing.id !== digest)
      throw new Error(
        `IMAGE_PROOF_MANIFEST_INVALID: the manifest records ${existing.ref} and ${ref} with different digests, but they are the same image`
      )
    if (!existing) index.set(canonical, { ref, id: digest })
  }
  return index
}

function indexRecordedRevisions(revisions) {
  const index = new Map()
  for (const [ref, value] of Object.entries(revisions)) {
    const canonical = canonicalImageRef(ref)
    if (!canonical || typeof value !== 'string') continue
    const existing = index.get(canonical)
    if (existing && existing !== value)
      throw new Error(
        `IMAGE_PROOF_MANIFEST_INVALID: the manifest records ${ref} twice with different source revisions (${existing}, ${value})`
      )
    if (!existing) index.set(canonical, value)
  }
  return index
}

// Certify the fixture images this profile holds against the commit under
// review. Returns the record the caller stores with the fixture run state:
// { profile, sourceHead, images, sourceRevisions, derivedFrom }.
export function buildApprovedToolsImageProof({ profile, sourceHead, manifest, images } = {}) {
  if (typeof profile !== 'string' || !PROFILE_PATTERN.test(profile))
    throw new Error(
      `IMAGE_PROOF_PROFILE_MISMATCH: '${profile ?? ''}' is not a usable Minikube profile`
    )
  if (typeof sourceHead !== 'string' || !HEAD_PATTERN.test(sourceHead))
    throw new Error(
      `IMAGE_PROOF_HEAD_MISMATCH: '${sourceHead ?? ''}' is not the 40-character commit under review`
    )
  if (!isRecord(manifest))
    throw new Error(
      `IMAGE_PROOF_MANIFEST_INVALID: deploy/minikube/.image-manifest.json is absent or unreadable; acquire the fixtures with: ${ACQUIRE_COMMAND}`
    )
  if (manifest.profile !== profile)
    throw new Error(
      `IMAGE_PROOF_PROFILE_MISMATCH: the manifest records profile '${manifest.profile ?? ''}', this run mutates '${profile}'; re-acquire the fixtures with: ${ACQUIRE_COMMAND}`
    )
  if (!isRecord(manifest.images))
    throw new Error(
      `IMAGE_PROOF_MANIFEST_INVALID: the manifest has no images map; acquire the fixtures with: ${ACQUIRE_COMMAND}`
    )
  const revisions = isRecord(manifest.sourceRevisions) ? manifest.sourceRevisions : {}
  const derived = isRecord(manifest.derivedFrom) ? manifest.derivedFrom : {}
  const recorded = indexRecordedImages(manifest.images)
  const recordedRevisions = indexRecordedRevisions(revisions)
  const observed = normalizeObservations(images)

  const proofImages = {}
  const proofRevisions = {}
  for (const ref of EXPECTED_IMAGES) {
    const record = recorded.get(canonicalImageRef(ref))
    if (!record)
      throw new Error(
        `IMAGE_PROOF_IMAGE_MISSING: the manifest records no image digest for ${ref}; acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    const observedEntry = observed.get(canonicalImageRef(ref))
    if (!observedEntry)
      throw new Error(
        `IMAGE_PROOF_IMAGE_MISSING: profile '${profile}' holds no image tagged ${ref}; acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    if (observedEntry.id !== record.id)
      throw new Error(
        `IMAGE_PROOF_IMAGE_MISMATCH: profile '${profile}' resolves ${observedEntry.ref} to ${observedEntry.id}, the manifest recorded ${record.ref} as ${record.id}; re-acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    const revision = recordedRevisions.get(canonicalImageRef(ref))
    if (typeof revision !== 'string' || !HEAD_PATTERN.test(revision))
      throw new Error(
        `IMAGE_PROOF_HEAD_MISSING: the manifest records no source revision for ${ref}; re-acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    if (revision !== sourceHead)
      throw new Error(
        `IMAGE_PROOF_HEAD_MISMATCH: ${ref} was built at ${revision}, the commit under review is ${sourceHead}; re-acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    proofImages[ref] = record.id
    proofRevisions[ref] = revision
  }

  const proofDerived = {}
  for (const { ref, base } of DERIVED_FIXTURES) {
    const binding = derived[ref]
    if (
      !isRecord(binding) ||
      canonicalImageRef(binding.ref) !== canonicalImageRef(base) ||
      !normalizeDigest(binding.id)
    )
      throw new Error(
        `IMAGE_PROOF_BASE_BINDING_MISSING: the manifest does not record ${ref} as built from ${base}; re-acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    const bindingId = normalizeDigest(binding.id)
    if (bindingId !== proofImages[base])
      throw new Error(
        `IMAGE_PROOF_BASE_MISMATCH: ${ref} was built from ${base} at ${bindingId}, profile '${profile}' now holds ${proofImages[base]}; re-acquire the fixtures with: ${ACQUIRE_COMMAND}`
      )
    proofDerived[ref] = { ref: base, id: bindingId }
  }

  return {
    profile,
    sourceHead,
    images: proofImages,
    sourceRevisions: proofRevisions,
    derivedFrom: proofDerived,
  }
}
