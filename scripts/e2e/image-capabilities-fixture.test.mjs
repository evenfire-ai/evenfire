import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baseImage,
  fixtureImage,
  modelInputs,
  proveImages,
  requireOwnedResource,
  runAnnotation,
} from './image-capabilities-fixture.mjs'

const head = 'a'.repeat(40)
const profile = 'clerum-image-fixture-12345678'
const ids = { [baseImage]: `sha256:${'b'.repeat(64)}`, [fixtureImage]: `sha256:${'c'.repeat(64)}` }
function manifest() {
  return {
    profile,
    images: { ...ids },
    sourceRevisions: { [baseImage]: head, [fixtureImage]: head },
    derivedFrom: { [fixtureImage]: { ref: baseImage, id: ids[baseImage] } },
  }
}

test('requires both exact source revisions and the live derived-base identity', () => {
  assert.deepEqual(proveImages(manifest(), ids, head, profile), { head, profile, images: ids })
  for (const mutate of [
    value => {
      value.profile = 'foreign-profile'
    },
    value => {
      value.sourceRevisions[baseImage] = 'd'.repeat(40)
    },
    value => {
      value.sourceRevisions[fixtureImage] = 'd'.repeat(40)
    },
    value => {
      value.derivedFrom[fixtureImage].id = `sha256:${'d'.repeat(64)}`
    },
    value => {
      value.images[`docker.io/${fixtureImage}`] = `sha256:${'d'.repeat(64)}`
    },
  ]) {
    const changed = manifest()
    mutate(changed)
    assert.throws(() => proveImages(changed, ids, head, profile))
  }
  assert.throws(() =>
    proveImages(manifest(), { ...ids, [fixtureImage]: `sha256:${'d'.repeat(64)}` }, head, profile)
  )
})

test('fixture catalog declares supported, unsupported and run-scoped unknown without provider-wide inference', () => {
  const rows = modelInputs('image-capabilities-123456abcdef')
  assert.deepEqual(
    rows.map(row => [row.model, row.image_input.state]),
    [
      ['glm-5.3-flash', 'supported'],
      ['glm-5.3', 'unsupported'],
      ['image-fixture-unknown-123456abcdef', 'unknown'],
    ]
  )
  assert.ok(
    rows.every(
      row =>
        row.provider === 'zai' &&
        row.image_input.evidence.reference === 'evidence:image-capabilities-123456abcdef'
    )
  )
  assert.throws(() => modelInputs('../foreign'))
})

test('restoration refuses recreated or foreign-owned Kubernetes resources', () => {
  const resource = { metadata: { uid: 'original', annotations: { [runAnnotation]: 'our-run' } } }
  requireOwnedResource(resource, 'original', 'our-run')
  assert.throws(() => requireOwnedResource(resource, 'replaced', 'our-run'))
  assert.throws(() => requireOwnedResource(resource, 'original', 'another-run'))
  assert.throws(() =>
    requireOwnedResource({ metadata: { uid: 'original' } }, 'original', 'our-run')
  )
})
