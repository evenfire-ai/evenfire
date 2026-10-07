// Hermetic controls for the actual CAS/wrapper functions. No cluster, vendor,
// credentials or physical measurement is used or claimed by these tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { CATALOG_CRON_KEYS, snapshotDeployment, deploymentMutationPatch, openControlApiCatalogIsolation,
  withControlApiFixtureRuntime, catalogRestorationSafe, seedPrivateMaterial,
  withImageQaSession } from '../e2e/coordinate-subscription-image-journeys.mjs'
import { revokeMemoryFixtures } from './lib/control-api-authorize-memory-seeder.ts'

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const image = `sha256:${'a'.repeat(64)}`
function patchObject(object, operations) {
  for (const operation of operations) {
    const names = operation.path.slice(1).split('/'), key = names.pop(), target = names.reduce((current, name) => current[name], object)
    if (operation.op === 'test') assert.deepEqual(target[key], operation.value)
    else if (operation.op === 'remove') Array.isArray(target) ? target.splice(Number(key), 1) : delete target[key]
    else if (key === '-') target.push(operation.value)
    else target[key] = structuredClone(operation.value)
  }
}
function fixture({ seedFailure = false, imageRevokeFailure = false } = {}) {
  const resource = { metadata: { uid: id(1), resourceVersion: '1' }, spec: { replicas: 1,
    template: { spec: { containers: [{ name: 'control-api', image, env: [...CATALOG_CRON_KEYS.map(name => ({ name, value: 'true' })),
      { name: 'UNRELATED', value: 'keep' }] }] } } } }
  const events = [], recovery = []
  const liveBindings = [0, 1].map(index => ({ hostRef: `unit-memory-${index}`, hostUid: id(10 + index),
    connectionId: id(20 + index), connectionKey: `unit-memory-grant-${index}` }))
  let prepared = false, memoryRevoked = false
  const effective = () => Object.fromEntries(resource.spec.template.spec.containers[0].env.map(entry => [entry.name, entry.value]))
  const context = { assert: (value, code) => assert(value, code), validImageId: value => value === image,
    imageId: value => value, ROOT: '/unit-source', NAMESPACE: 'control-plane', CATALOG_CRON_KEYS, snapshotDeployment, deploymentMutationPatch,
    getDeployment: () => structuredClone(resource), readyPod: () => ({ metadata: { name: 'unit-api' }, status: { containerStatuses: [{ name: 'control-api', imageID: image }] } }),
    until: async check => check(), json: () => ({ llm: effective()[CATALOG_CRON_KEYS[0]] === 'true', subscription: effective()[CATALOG_CRON_KEYS[1]] === 'true' }),
    patchDeployment: (_context, _name, patch) => { patchObject(resource, patch); events.push('cron-patch'); resource.metadata.resourceVersion = String(Number(resource.metadata.resourceVersion) + 1) },
    command: () => '', catalogRestorationSafe, seedPrivateMaterial,
    restoreDeployments: async (_context, states) => {
      for (const state of states) patchObject(resource, deploymentMutationPatch(resource, state.original, state.applied, true))
      events.push('restore-original-crons')
    },
    seed: async (value, _private, work) => {
      assert(CATALOG_CRON_KEYS.every(name => effective()[name] === 'false')); events.push('seed-sees-false')
      if (seedFailure) throw new Error('UNIT_SEED_FAILED')
      if (value.prepareFixtures) { assert.equal(prepared, false, 'fixed Hosts cannot be reseeded'); prepared = true }
      if (work) {
        const session = { fixtures: { bindings: structuredClone(liveBindings) },
          prepareImages: async () => { assert.equal(memoryRevoked, false); events.push('proxy-images-created');
            return { bindings: [{ provider: 'grok-subscription', hostRef: 'unit-image-grok' },
              { provider: 'codex-subscription', hostRef: 'unit-image-codex' }] } },
          revokeImages: async () => { events.push('proxy-images-revoke');
            if (imageRevokeFailure) return { verified: false }
            return { verified: true, grantsRevoked: 2, hostsDetached: 2 } },
          revokeMemory: async () => { assert.equal(memoryRevoked, false); memoryRevoked = true;
            events.push('memory-revoked-verified'); return { verified: true } } }
        await work(session)
      }
      return memoryRevoked
        ? { kind: 'control-api-authorize-qa-finalization.v1', fixtureFinalization: { verified: true, state: 'revoked', grantsRevoked: 2, hostsDetached: 2 } }
        : { fixtures: { bindings: structuredClone(liveBindings) }, producer: { code: 0, signal: null } }
    },
    coordinate: async (_args, value, _private, scope) => {
      assert.equal(value.prepareFixtures, false); assert.equal(memoryRevoked, false)
      assert(CATALOG_CRON_KEYS.every(name => effective()[name] === 'false'))
      scope.grantStatus.state = 'revoked'; events.push('journey-images-revoked')
      return { producerExit: 0, restoration: { verified: true } }
    },
    releaseOptionsForQa: options => ({ ...options, prepareFixtures: false }),
    writeCatalogRecovery: (...args) => { recovery.push(args); events.push('retain-crons-false') },
    Error, Promise, Object, structuredClone, path: { dirname: () => '/unit-report', join: (...parts) => parts.join('/') },
  }
  const sandbox = vm.createContext(context)
  context.openControlApiCatalogIsolation = vm.runInContext(`(${openControlApiCatalogIsolation.toString()})`, sandbox)
  context.withImageQaSession = vm.runInContext(`(${withImageQaSession.toString()})`, sandbox)
  const wrapper = vm.runInContext(`(${withControlApiFixtureRuntime.toString()})`, sandbox)
  const options = { profile: 'qa-unit', context: 'qa-unit', runId: 'pr806-memory-123456789abc', prepare: 'restart', prepareFixtures: true,
    report: '/unit-report/seed.json', publicArguments: {} }
  // Public, test-only input; it is not an actual operator credential.
  const material = { operatorPassword: 'unit-only-control-material' }
  return { wrapper, options, material, events, recovery, resource, effective, liveBindings }
}

test('actual wrapper applies real cron keys false before seed and restores true only after final memory revocation', async () => {
  const world = fixture()
  await world.wrapper(world.options, world.material, async runtime => {
    assert.deepEqual(runtime.initialSnapshot.env, Object.fromEntries(CATALOG_CRON_KEYS.map(name => [name, 'true'])))
    await runtime.run(world.options)
  })
  assert.deepEqual(world.events, ['cron-patch', 'seed-sees-false', 'seed-sees-false', 'memory-revoked-verified', 'restore-original-crons'])
  assert(CATALOG_CRON_KEYS.every(name => world.effective()[name] === 'true'))
  assert.equal(world.effective().UNRELATED, 'keep')
})
test('partial seed failure keeps actual crons false and records recovery; a zero-QA work failure restores originals', async () => {
  const partial = fixture({ seedFailure: true })
  await assert.rejects(partial.wrapper(partial.options, partial.material, runtime => runtime.run(partial.options)), /UNIT_SEED_FAILED/)
  assert(CATALOG_CRON_KEYS.every(name => partial.effective()[name] === 'false'))
  assert(!partial.events.includes('restore-original-crons')); assert.equal(partial.recovery.length, 1)
  const zero = fixture()
  await assert.rejects(zero.wrapper(zero.options, zero.material, async () => { throw new Error('UNIT_BEFORE_QA') }), /UNIT_BEFORE_QA/)
  assert(CATALOG_CRON_KEYS.every(name => zero.effective()[name] === 'true'))
  for (const state of ['created', 'created-or-unknown']) {
    assert.equal(catalogRestorationSafe(state, []), false)
    assert.equal(catalogRestorationSafe('revoked', [{ state }]), false)
  }
})

test('registered proxy work resumes the same live memory UID run after four image revokes and revokes memory once outside', async () => {
  const world = fixture()
  await world.wrapper(world.options, world.material, async runtime => {
    await runtime.run(world.options)
    const resumed = { ...world.options, prepareFixtures: false, fixtureBinding: { uid: world.liveBindings[0].hostUid },
      report: '/unit-report/proxy-session.json', publicArguments: { 'fixtures-receipt': world.options.report } }
    await assert.rejects(runtime.proxyMemory('subscription-image-123456789abc', resumed, async () => {}), /LIVE_PROXY_FIXTURE/)
    for (let n = 0; n < 4; n++) await runtime.journey([], resumed)
    const reseed = { ...resumed, prepareFixtures: true }
    await assert.rejects(runtime.proxyMemory('subscription-image-123456789abc', reseed, async () => {}), /LIVE_PROXY_FIXTURE/)
    await assert.rejects(runtime.proxyMemory('subscription-image-123456789abc', { ...resumed, runId: 'pr806-memory-aaaaaaaaaaaa' }, async () => {}), /SCOPE_CHANGED/)
    await runtime.proxyMemory('subscription-image-123456789abc', resumed, async ({ session, qaState }) => {
      assert.deepEqual(session.fixtures.bindings, world.liveBindings)
      assert.equal(qaState().state, 'created')
      const view = qaState(); view.state = 'revoked'; view.bindings.length = 0
      assert.equal(qaState().state, 'created'); assert.equal(qaState().bindings.length, 2)
      assert(!world.events.includes('memory-revoked-verified'))
      world.events.push('proxy-work-with-live-memory')
    })
    assert(!world.events.includes('memory-revoked-verified'))
  })
  assert.equal(world.events.filter(event => event === 'memory-revoked-verified').length, 1)
  assert(world.events.indexOf('proxy-work-with-live-memory') < world.events.indexOf('proxy-images-revoke'))
  assert(world.events.indexOf('proxy-images-revoke') < world.events.indexOf('memory-revoked-verified'))
  assert(world.events.indexOf('memory-revoked-verified') < world.events.indexOf('restore-original-crons'))
})
test('registered proxy revoke unknown retains actual cronfalse despite independent final memory revoke', async () => {
  const world = fixture({ imageRevokeFailure: true })
  await assert.rejects(world.wrapper(world.options, world.material, async runtime => {
    await runtime.run(world.options)
    const resumed = { ...world.options, prepareFixtures: false, fixtureBinding: { uid: world.liveBindings[0].hostUid },
      publicArguments: { 'fixtures-receipt': world.options.report } }
    for (let n = 0; n < 4; n++) await runtime.journey([], resumed)
    await runtime.proxyMemory('subscription-image-123456789abc', resumed, async () => world.events.push('proxy-work'))
  }), /QA_GRANT_RESTORATION_FAILED/)
  assert.equal(world.events.filter(event => event === 'memory-revoked-verified').length, 1)
  assert(!world.events.includes('restore-original-crons')); assert.equal(world.recovery.length, 1)
  assert(CATALOG_CRON_KEYS.every(name => world.effective()[name] === 'false'))
})

test('real first-tick scheduler would call direct sync after restart; disabled actual config gate prevents scheduling', async () => {
  const full = fs.readFileSync(new URL('../../control-api/src/services/subscriptionCatalogSyncCron.ts', import.meta.url), 'utf8')
  const start = full.indexOf('let intervalHandle:'), source = stripTypeScriptTypes(full.slice(start)).replace(/^export /gm, '')
  let callback, calls = 0
  const context = vm.createContext({ Math: { random: () => 0, floor: Math.floor }, log: { info() {}, error() {} },
    runSubscriptionCatalogSyncTick: async deps => { await deps.sync() },
    setTimeout: fn => { callback = fn; return { unref() {} } }, setInterval: () => ({ unref() {} }), clearTimeout() {}, clearInterval() {} })
  const startCron = vm.runInContext(source + '\nstartSubscriptionCatalogSyncCron', context)
  const gate = value => { if (value === 'true') startCron({ sync: async () => { calls++ } }, 21600000) }
  gate('false'); assert.equal(callback, undefined); assert.equal(calls, 0)
  gate('true'); callback(); await Promise.resolve(); assert.equal(calls, 1)
})

test('final memory action detaches/revokes only two exact owned grants and preserves audit/GFS data', async () => {
  const runId = 'pr806-memory-123456789abc', events = [], rows = new Map()
  const prepared = { bindings: [0, 1].map(index => ({ hostRef: ['pr806-memory-grok-host', 'pr806-memory-grok-host-2'][index],
    hostUid: id(10 + index), connectionKey: `${runId}-grok-${index + 1}`, connectionId: id(20 + index) })) }
  const session = { request: async request => {
    const binding = prepared.bindings.find(value => request.path.endsWith(value.hostRef))
    if (request.method === 'GET') return { status: 200, json: { metadata: { uid: binding.hostUid, resourceVersion: '1',
      labels: { 'evenfire.io/qa-memory-run': runId } }, spec: { model: { provider: 'grok-subscription', name: 'grok-4.6', connectionRef: binding.connectionKey } } } }
    events.push('host-detached'); return { status: 200, json: { metadata: { uid: binding.hostUid }, spec: request.body.spec } }
  } }
  const prod = { db: { withTransaction: fn => fn({ query: async (sql, values) => {
    assert(!/DELETE|UPDATE .*audit/i.test(sql)); const index = prepared.bindings.findIndex(value => value.connectionKey === values[0])
    return { rows: [{ id: id(20 + index), credential_revision: 1, account_fingerprint: `qa-memory-${runId}-${index + 1}` }] }
  } }) }, connection: { revokeGrokSubscriptionConnection: async (_tx, key) => {
    events.push('grant-revoked'); const binding = prepared.bindings.find(value => value.connectionKey === key); rows.set(key, 'revoked'); return { id: binding.connectionId, status: 'revoked' }
  } }, gateway: { llmAllowedModelsConfigMap: () => ({ materialize: async () => events.push('projection-published') }) } }
  const result = await revokeMemoryFixtures({ prod, session, options: { runId }, prepared })
  assert.equal(result.state, 'revoked'); assert.equal(result.grantsRevoked, 2); assert.equal(result.retainedAuditAndQaData, true)
  assert.deepEqual(events, ['host-detached', 'grant-revoked', 'host-detached', 'grant-revoked', 'projection-published'])
  assert.equal(rows.size, 2)
})
