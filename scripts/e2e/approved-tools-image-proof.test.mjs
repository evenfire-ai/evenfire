// Pure validation coverage for scripts/e2e/approved-tools-image-proof.mjs.
//
// Every input here is in-memory metadata: manifests, observed image records,
// and reviewed commit ids built from synthetic strings. Nothing in this file
// runs a command, touches the filesystem, or reaches a cluster, and every
// digest is generated, not copied.
//
// Real-builder coverage lives in scripts/tests/test-minikube-docker-cli-env.sh:
// sequential partial builds, derived-image bindings, stale/missing images,
// profile mismatch, malformed prior JSON, and preservation of a good manifest
// when late inventory queries fail. Neither suite certifies a live deployment.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { publishedImages, pullInGhcrMode, minikubeVerifyRefs } from '../release/images-manifest.mjs'
import {
  BASE_IMAGES,
  DERIVED_FIXTURES,
  EXPECTED_IMAGES,
  FIXTURE_IMAGES,
  buildApprovedToolsImageProof,
} from './approved-tools-image-proof.mjs'

const PROFILE = 'clerum-image-proof-a1b2c3d4'
const OTHER_PROFILE = 'clerum-image-proof-deadbeef'
const HEAD = 'a'.repeat(40)
const OTHER_HEAD = 'b'.repeat(40)
const PROXY_BASE = BASE_IMAGES[0]
const WORKFLOW_BASE = BASE_IMAGES[1]
const PROXY_FIXTURE = DERIVED_FIXTURES[0].ref
const WORKFLOW_FIXTURE = DERIVED_FIXTURES[1].ref

const digest = seed => `sha256:${createHash('sha256').update(seed).digest('hex')}`

// The registry-qualified spelling a container runtime reports for these refs.
const canonical = ref => `docker.io/${ref}`

function recordedImages() {
  return Object.fromEntries(EXPECTED_IMAGES.map((ref, index) => [ref, digest(`${ref}#${index}`)]))
}

function manifestFor(images) {
  return {
    generated: '2026-09-15T00:00:00Z',
    profile: PROFILE,
    imageSource: 'local',
    imageTag: '',
    gitHead: HEAD,
    images: { ...images },
    sourceRevisions: Object.fromEntries(EXPECTED_IMAGES.map(ref => [ref, HEAD])),
    derivedFrom: Object.fromEntries(
      DERIVED_FIXTURES.map(({ ref, base }) => [ref, { ref: base, id: images[base] }])
    ),
  }
}

function observedEntries(images, spell = ref => ref) {
  return Object.entries(images).map(([ref, id]) => ({ ref: spell(ref), id }))
}

function certify({ profile = PROFILE, sourceHead = HEAD, manifest, images }) {
  return buildApprovedToolsImageProof({ profile, sourceHead, manifest, images })
}

test('certifies every fixture and base ref at the reviewed commit', () => {
  const images = recordedImages()
  const proof = certify({ manifest: manifestFor(images), images: observedEntries(images) })
  assert.deepEqual(Object.keys(proof.images).sort(), [...EXPECTED_IMAGES].sort())
  assert.equal(proof.profile, PROFILE)
  assert.equal(proof.sourceHead, HEAD)
  for (const ref of EXPECTED_IMAGES) {
    assert.equal(proof.images[ref], images[ref])
    assert.equal(proof.sourceRevisions[ref], HEAD)
  }
  for (const { ref, base } of DERIVED_FIXTURES)
    assert.deepEqual(proof.derivedFrom[ref], { ref: base, id: images[base] })
})

test('matches a registry-qualified inventory against the manifest spellings and keeps them', () => {
  const images = recordedImages()
  const proof = certify({
    manifest: manifestFor(images),
    images: observedEntries(images, canonical),
  })
  for (const ref of EXPECTED_IMAGES) assert.equal(proof.images[ref], images[ref])
  assert.deepEqual(Object.keys(proof.images).sort(), [...EXPECTED_IMAGES].sort())
})

test('matches a registry-qualified manifest against unqualified inventory spellings', () => {
  const images = recordedImages()
  const manifest = manifestFor(images)
  manifest.images = Object.fromEntries(
    Object.entries(images).map(([ref, id]) => [canonical(ref), id])
  )
  manifest.sourceRevisions = Object.fromEntries(EXPECTED_IMAGES.map(ref => [canonical(ref), HEAD]))
  const proof = certify({ manifest, images: observedEntries(images) })
  for (const ref of EXPECTED_IMAGES) assert.equal(proof.images[ref], images[ref])
})

test('accepts both spellings of one image only while they record the same digest', () => {
  const images = recordedImages()
  const manifest = manifestFor(images)
  manifest.images[canonical(PROXY_BASE)] = images[PROXY_BASE]
  manifest.sourceRevisions[canonical(PROXY_BASE)] = HEAD
  const proof = certify({ manifest, images: observedEntries(images) })
  assert.equal(proof.images[PROXY_BASE], images[PROXY_BASE])
})

test('refuses an inventory that spells one image twice with different digests', () => {
  const images = recordedImages()
  const conflicting = [
    ...observedEntries(images, canonical),
    { ref: PROXY_FIXTURE, id: digest('a-different-image') },
  ]
  assert.throws(
    () => certify({ manifest: manifestFor(images), images: conflicting }),
    /IMAGE_PROOF_IMAGE_MISMATCH/
  )
})

test('refuses a manifest that contradicts itself across two spellings', () => {
  const images = recordedImages()
  const manifest = manifestFor(images)
  manifest.images[canonical(PROXY_FIXTURE)] = digest('a-different-image')
  assert.throws(
    () => certify({ manifest, images: observedEntries(images) }),
    /IMAGE_PROOF_MANIFEST_INVALID/
  )
})

test('refuses a manifest that records one image twice with different source revisions', () => {
  const images = recordedImages()
  const manifest = manifestFor(images)
  manifest.sourceRevisions[canonical(WORKFLOW_BASE)] = OTHER_HEAD
  assert.throws(
    () => certify({ manifest, images: observedEntries(images) }),
    /IMAGE_PROOF_MANIFEST_INVALID/
  )
})

test('the manifest gitHead certifies nothing on its own', () => {
  const images = recordedImages()
  const manifest = { ...manifestFor(images), gitHead: OTHER_HEAD }
  const proof = certify({ manifest, images: observedEntries(images) })
  assert.equal(proof.sourceHead, HEAD)
  assert.equal(manifest.gitHead, OTHER_HEAD)
})

test('refuses a missing or unusable manifest', () => {
  const images = recordedImages()
  for (const manifest of [undefined, null, 'not-an-object', [], {}]) {
    assert.throws(
      () => certify({ manifest, images: observedEntries(images) }),
      /IMAGE_PROOF_(MANIFEST_INVALID|PROFILE_MISMATCH)/
    )
  }
})

test('refuses a manifest acquired for another profile', () => {
  const images = recordedImages()
  const manifest = { ...manifestFor(images), profile: OTHER_PROFILE }
  assert.throws(
    () => certify({ manifest, images: observedEntries(images) }),
    /IMAGE_PROOF_PROFILE_MISMATCH/
  )
})

test('refuses an unusable reviewed head', () => {
  const images = recordedImages()
  for (const sourceHead of ['', 'HEAD', 'A'.repeat(40), 'c'.repeat(39), HEAD.slice(1)]) {
    assert.throws(
      () => certify({ sourceHead, manifest: manifestFor(images), images: observedEntries(images) }),
      /IMAGE_PROOF_HEAD_MISMATCH/
    )
  }
  // Omitting the reviewed commit entirely takes the same refusal path.
  assert.throws(
    () =>
      buildApprovedToolsImageProof({
        profile: PROFILE,
        manifest: manifestFor(images),
        images: observedEntries(images),
      }),
    /IMAGE_PROOF_HEAD_MISMATCH/
  )
})

test('refuses a ref the manifest does not record or the profile does not hold', () => {
  const images = recordedImages()
  const withoutBase = manifestFor(images)
  delete withoutBase.images[PROXY_BASE]
  assert.throws(
    () => certify({ manifest: withoutBase, images: observedEntries(images) }),
    /IMAGE_PROOF_IMAGE_MISSING/
  )

  const absentFixture = observedEntries(images).filter(entry => entry.ref !== WORKFLOW_FIXTURE)
  assert.throws(
    () => certify({ manifest: manifestFor(images), images: absentFixture }),
    /IMAGE_PROOF_IMAGE_MISSING/
  )
})

test('refuses an observation that disagrees with the manifest or is unusable', () => {
  const images = recordedImages()
  const replaced = observedEntries(images).map(entry =>
    entry.ref === WORKFLOW_BASE ? { ref: entry.ref, id: digest('replaced') } : entry
  )
  assert.throws(
    () => certify({ manifest: manifestFor(images), images: replaced }),
    /IMAGE_PROOF_IMAGE_MISMATCH/
  )
  assert.throws(
    () => certify({ manifest: manifestFor(images), images: { ref: PROXY_BASE } }),
    /IMAGE_PROOF_MANIFEST_INVALID/
  )
  assert.throws(
    () =>
      certify({
        manifest: manifestFor(images),
        images: [{ ref: PROXY_BASE, id: 'sha256:not-a-digest' }],
      }),
    /IMAGE_PROOF_IMAGE_MISMATCH/
  )
  assert.throws(
    () => certify({ manifest: manifestFor(images), images: [{ ref: '', id: images[PROXY_BASE] }] }),
    /IMAGE_PROOF_MANIFEST_INVALID/
  )
})

test('refuses a ref with no recorded source revision', () => {
  const images = recordedImages()
  const manifest = manifestFor(images)
  delete manifest.sourceRevisions[FIXTURE_IMAGES[0]]
  assert.throws(
    () => certify({ manifest, images: observedEntries(images) }),
    /IMAGE_PROOF_HEAD_MISSING/
  )
})

test('refuses a fixture or a base that was built at a different commit', () => {
  const images = recordedImages()
  for (const stale of EXPECTED_IMAGES) {
    const manifest = manifestFor(images)
    manifest.sourceRevisions[stale] = OTHER_HEAD
    assert.throws(
      () => certify({ manifest, images: observedEntries(images, canonical) }),
      /IMAGE_PROOF_HEAD_MISMATCH/,
      stale
    )
  }
})

test('refuses a fixture whose recorded base is absent, different or no longer current', () => {
  const images = recordedImages()

  const unbound = manifestFor(images)
  delete unbound.derivedFrom[PROXY_FIXTURE]
  assert.throws(
    () => certify({ manifest: unbound, images: observedEntries(images) }),
    /IMAGE_PROOF_BASE_BINDING_MISSING/
  )

  const wrongBase = manifestFor(images)
  wrongBase.derivedFrom[WORKFLOW_FIXTURE] = { ref: PROXY_BASE, id: images[PROXY_BASE] }
  assert.throws(
    () => certify({ manifest: wrongBase, images: observedEntries(images) }),
    /IMAGE_PROOF_BASE_BINDING_MISSING/
  )

  const staleBase = manifestFor(images)
  staleBase.derivedFrom[PROXY_FIXTURE] = { ref: PROXY_BASE, id: digest('the-base-before') }
  assert.throws(
    () => certify({ manifest: staleBase, images: observedEntries(images) }),
    /IMAGE_PROOF_BASE_MISMATCH/
  )
})

// The OAuth image is an optional derived fixture, but mandatory for this lane.
test('requires the Control API OAuth fixture and its current exact base', () => {
  const ref = 'clerum/codex-approved-tools-control-api-e2e:test'
  const base = 'clerum/control-api:test'
  assert.ok(FIXTURE_IMAGES.includes(ref))
  assert.ok(BASE_IMAGES.includes(base))
  assert.ok(DERIVED_FIXTURES.some(entry => entry.ref === ref && entry.base === base))
  const images = recordedImages()
  for (const missing of [ref, base]) {
    assert.throws(
      () => certify({ manifest: manifestFor(images), images: observedEntries(images).filter(entry => entry.ref !== missing) }),
      /IMAGE_PROOF_IMAGE_MISSING/
    )
  }
  const manifest = manifestFor(images)
  manifest.derivedFrom[ref].id = digest('previous-control-api-base')
  assert.throws(
    () => certify({ manifest, images: observedEntries(images) }),
    /IMAGE_PROOF_BASE_MISMATCH/
  )
})

test('keeps the OAuth fixture out of publication, pulls and default runtime verification', () => {
  const name = 'codex-approved-tools-control-api-e2e'
  const ref = `clerum/${name}:test`
  assert.ok(!publishedImages().some(image => image.name === name))
  assert.ok(!pullInGhcrMode().some(image => image.name === name))
  assert.ok(!minikubeVerifyRefs({ mode: 'local' }).includes(ref))
  assert.ok(!minikubeVerifyRefs({ mode: 'ghcr', tag: HEAD, includeE2eFixtures: true }).includes(ref))
})
