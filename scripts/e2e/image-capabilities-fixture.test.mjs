import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  baseImage,
  fixtureImage,
  installSignalRestore,
  modelInputs,
  proveImages,
  requireOwnedResource,
  runAnnotation,
  sanitizeFixtureReport,
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

function signalTarget() {
  const target = new EventEmitter()
  target.exits = []
  target.exit = code => target.exits.push(code)
  return target
}

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
]) {
  test(`a ${signal} runs restoration once and exits ${code}`, async () => {
    const target = signalTarget()
    const messages = []
    let calls = 0
    installSignalRestore(
      target,
      async () => {
        calls += 1
      },
      text => messages.push(text)
    )
    target.emit(signal, signal)
    target.emit(signal, signal)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.deepEqual(target.exits, [code])
    assert.match(messages.join(''), new RegExp(`interrupted by ${signal}`))
  })
}

test('a failed restoration exits 1 and reports the message', async () => {
  const target = signalTarget()
  const messages = []
  installSignalRestore(
    target,
    async () => {
      throw new Error('deployment/chatllm rollback timed out')
    },
    text => messages.push(text)
  )
  target.emit('SIGTERM', 'SIGTERM')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(target.exits, [1])
  assert.match(messages.join(''), /restoration failed: deployment\/chatllm rollback timed out/)
})

test('uninstalling removes both signal handlers', () => {
  const target = signalTarget()
  const uninstall = installSignalRestore(
    target,
    async () => {},
    () => {}
  )
  assert.equal(target.listenerCount('SIGINT'), 1)
  assert.equal(target.listenerCount('SIGTERM'), 1)
  uninstall()
  assert.equal(target.listenerCount('SIGINT'), 0)
  assert.equal(target.listenerCount('SIGTERM'), 0)
})

test('the playwright log redacts the admin password, the session cookie and bearer-shaped tokens', () => {
  const password = 'fixture-admin-password-4c1e'
  const cookie = 'sid=9f3a7c2e1b'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJl'
  const output = [
    `login with ${password}`,
    `session ${cookie} established`,
    `token ${jwt} issued`,
    'Authorization: Bearer opaque-bearer-value',
    '3 passed (41.2s)',
  ].join('\n')
  const report = sanitizeFixtureReport(output, [password, cookie])
  assert.ok(!report.includes(password))
  assert.ok(!report.includes(cookie))
  assert.ok(!report.includes(jwt))
  assert.ok(!report.includes('opaque-bearer-value'))
  assert.match(report, /3 passed \(41\.2s\)/)
})
