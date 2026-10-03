// Hermetic source/protocol tests. Synthetic public metadata is never evidence
// of a running profile, OAuth, physical deployment or visible Desktop flow.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { snapshotDeployment, deploymentMutationPatch, verifyQaModelProjection, vendorFrames } from '../e2e/coordinate-subscription-image-journeys.mjs'
import { subscriptionImageSeedInputs, prepareSubscriptionImageBindings } from './lib/control-api-authorize-memory-seeder.ts'
import { createSubscriptionImageVendor, SUBSCRIPTION_VENDOR_URLS } from '../e2e/fixtures/subscription-image-provider.mjs'
import { validateRemainingFixture } from '../../desktop-app/test/e2e-playwright/subscriptionRemainingJourneysContract.ts'
import { validatePrepareScratch } from '../e2e/prepare-subscription-image-admission.mjs'

const runId = 'subscription-image-123456789abc'
const planned = subscriptionImageSeedInputs(runId)
const digest = 'a'.repeat(64), uid = '12345678-1234-4234-8234-123456789abc'
const resource = () => ({ metadata: { uid, resourceVersion: '4' }, spec: { replicas: 1,
  template: { spec: { containers: [{ name: 'unit-proxy', image: `sha256:${digest}`,
    env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'UNRELATED', value: 'unit-scope' }] }] } } } })
function applyPatch(value, operations) {
  const result = structuredClone(value)
  for (const op of operations) {
    const segments = op.path.slice(1).split('/'), key = segments.pop()
    const parent = segments.reduce((current, name) => current[name], result)
    if (op.op === 'test') assert.deepEqual(parent[key], op.value)
    else if (op.op === 'remove') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key]
    else if (key === '-') parent.push(op.value)
    else parent[key] = structuredClone(op.value)
  }
  return result
}

test('activation and restoration preserve unrelated fields and compare actual UID/RV/image/controlled values', () => {
  const before = resource(), original = snapshotDeployment(before, 'unit-proxy', ['NODE_ENV', 'NODE_OPTIONS', 'QA_RUN'])
  assert.deepEqual(original.env, { NODE_ENV: 'production' })
  const applied = { image: `sha256:${'b'.repeat(64)}`, env: { NODE_ENV: 'test', NODE_OPTIONS: '--import=/app/unit.mjs', QA_RUN: runId } }
  const active = applyPatch(before, deploymentMutationPatch(before, original, applied))
  active.metadata.resourceVersion = '8'; active.spec.template.spec.containers[0].env[1].value = 'concurrent-unrelated'
  const restored = applyPatch(active, deploymentMutationPatch(active, original, applied, true))
  assert.equal(restored.spec.template.spec.containers[0].image, before.spec.template.spec.containers[0].image)
  assert.deepEqual(restored.spec.template.spec.containers[0].env,
    [{ name: 'NODE_ENV', value: 'production' }, { name: 'UNRELATED', value: 'concurrent-unrelated' }])
  for (const change of [value => { value.metadata.uid = 'recreated' },
    value => { value.spec.template.spec.containers[0].image = 'different' },
    value => { value.spec.template.spec.containers[0].env.find(item => item.name === 'QA_RUN').value = 'other-run' }]) {
    const mutated = structuredClone(active); change(mutated)
    assert.throws(() => deploymentMutationPatch(mutated, original, applied, true), /OWNER_CHANGED|RESTORE_CONFLICT/)
  }
})
test('unknown, duplicated, valueFrom or previously activated controlled fields refuse before patch', () => {
  for (const env of [[{ name: 'NODE_OPTIONS', value: '--inspect=0.0.0.0:9229' }],
    [{ name: 'NODE_ENV', value: 'test' }, { name: 'NODE_ENV', value: 'test' }],
    [{ name: 'NODE_ENV', valueFrom: { configMapKeyRef: { name: 'unit', key: 'value' } } }],
    [{ name: 'QA_RUN', value: 'other-run' }]]) {
    const value = resource(); value.spec.template.spec.containers[0].env = env
    assert.throws(() => snapshotDeployment(value, 'unit-proxy', ['NODE_ENV', 'NODE_OPTIONS', 'QA_RUN']))
  }
})

test('preparer admits only a fresh private scratch and never chmods a shared/nonempty directory', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-scratch-unit-')))
  try {
    fs.chmodSync(directory, 0o700); validatePrepareScratch(directory)
    fs.chmodSync(directory, 0o755)
    assert.throws(() => validatePrepareScratch(directory), /SCRATCH_NOT_FRESH/)
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755)
    fs.chmodSync(directory, 0o700); fs.writeFileSync(path.join(directory, 'owned-unit-data'), 'unit')
    assert.throws(() => validatePrepareScratch(directory), /SCRATCH_NOT_FRESH/)
    assert.equal(fs.readFileSync(path.join(directory, 'owned-unit-data'), 'utf8'), 'unit')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('QA writer uses the private authenticated API for models/Hosts and keeps random grant material out of results', async () => {
  const calls = [], models = new Map(), hosts = new Map(), state = []
  const options = { runId: 'pr806-memory-123456789abc', hostNamespace: 'qa-hosts' }
  const prepared = { operatorDesktopUserId: uid, operatorEmail: 'unit@example.invalid', operatorLink: { status: 'active' }, context: { uid } }
  const session = { request: async request => {
    calls.push({ method: request.method, path: request.path })
    if (request.path.endsWith('contexts/context1')) return { status: 200, json: { metadata: { uid }, spec: { mcpServers: [] } } }
    if (request.path.endsWith('llm-models') && request.method === 'POST') {
      const row = { ...request.body, id: String(models.size + 1) }; models.set(row.id, row); return { status: 201, json: row }
    }
    if (request.path.includes('llm-models/')) return { status: 200, json: models.get(request.path.split('/').at(-1)) }
    if (request.method === 'POST' && request.path.endsWith('hosts')) {
      const row = { metadata: { ...request.body.metadata, uid, namespace: options.hostNamespace }, spec: request.body.spec }
      hosts.set(row.metadata.name, row); return { status: 201, json: row }
    }
    return { status: 200, json: hosts.get(request.path.split('/').at(-1)) }
  } }
  let credentialWrites = 0, materialized = 0
  const rows = new Map()
  const insert = async (_tx, _key, credential, key) => {
    assert(typeof credential.refreshToken === 'string' && typeof credential.accessToken === 'string')
    assert(credential.accessTokenExpiresAt.getTime() - Date.now() >= 60 * 60 * 1000)
    credentialWrites++
    const value = { id: uid, credentialRevision: 1, catalogRevision: 0 }; rows.set(key, value); return value
  }
  const publish = async (_tx, input) => ({ ...rows.get(input.connectionKey), catalogRevision: 1 })
  const prod = { config: {}, encryption: { deriveOAuthEncryptionKey: () => Buffer.alloc(32) },
    db: { withTransaction: work => work({ query: async () => ({ rows: [] }) }) },
    gateway: { llmAllowedModelsConfigMap: () => ({ materialize: async () => { materialized++ } }) },
    connection: { insertInitialGrokSubscriptionConnection: insert, recordGrokCatalogOutcome: publish },
    codexConnection: { insertInitialCodexSubscriptionConnection: insert, recordCodexCatalogOutcome: publish } }
  const result = await prepareSubscriptionImageBindings({ prod, session, options, prepared, runId, state })
  assert.equal(credentialWrites, 2); assert.equal(materialized, 2); assert.equal(result.bindings.length, 2)
  assert.equal(calls.filter(value => value.method === 'POST' && value.path.endsWith('llm-models')).length, 6)
  assert.equal(calls.filter(value => value.method === 'POST' && value.path.endsWith('hosts')).length, 2)
  for (const binding of result.bindings) {
    assert.equal(binding.fallback.provider, binding.provider)
    assert.notEqual(binding.fallback.modelId, binding.modelId)
    assert.equal(binding.hostNamespace, options.hostNamespace)
    assert.equal(binding.hostUid, uid)
  }
  assert(!/refreshToken|accessToken|operatorPassword|cookie/.test(JSON.stringify(result)))
  assert(!/refreshToken|accessToken|operatorPassword|cookie/.test(JSON.stringify(state)))
  let wrote = false
  await assert.rejects(prepareSubscriptionImageBindings({ prod, session: { request: async () => {
    wrote = true; return { status: 200, json: { metadata: { uid: 'foreign' }, spec: { mcpServers: [] } } }
  } }, options, prepared, runId, state: [] }), /CONTEXT_CHANGED/)
  assert.equal(wrote, true); assert.equal(credentialWrites, 2)
})

function modelProjection(binding) {
  const models = [binding.modelId, binding.unsupportedModelId, binding.fallback.modelId]
  return { metadata: { annotations: {
    'clerum.io/codex-enabled': 'true', 'clerum.io/grok-enabled': 'true', 'clerum.io/content-hash': digest,
    'clerum.io/codex-connections': JSON.stringify({ [binding.connectionKey]: { status: 'connected',
      catalogRevision: 1, connectionRevision: 1, models } }),
    'clerum.io/grok-connections': JSON.stringify({ [binding.connectionKey]: { status: 'connected',
      catalogRevision: 1, connectionRevision: 1, models } }),
  } }, data: { [binding.provider]: JSON.stringify(models.map((model, index) => ({ model,
    imageInput: { state: index === 1 ? 'unsupported' : 'supported', evidence: {
      source: 'curated', reference: `evidence:${runId}`, checkedAt: new Date(Date.now() - 1000).toISOString() } } }))) } }
}
test('both actual catalogue projections must independently prove primary, unsupported and same-grant alternate', () => {
  for (const input of planned) {
    const binding = { ...input, credentialRevision: 1, catalogRevision: 1 }
    const good = modelProjection(binding)
    assert.equal(verifyQaModelProjection(good, binding), true)
    for (const mutate of [value => { value.data[binding.provider] = '[]' },
      value => { value.metadata.annotations[`clerum.io/${binding.provider.startsWith('grok') ? 'grok' : 'codex'}-enabled`] = 'false' },
      value => { const rows = JSON.parse(value.data[binding.provider]); rows[2].imageInput = { state: 'unknown' }; value.data[binding.provider] = JSON.stringify(rows) }]) {
      const bad = structuredClone(good); mutate(bad)
      assert.throws(() => verifyQaModelProjection(bad, binding), /ELIGIBILITY_UNPROVED/)
    }
    assert.throws(() => verifyQaModelProjection(good, { ...binding,
      fallback: { ...binding.fallback, provider: binding.provider.startsWith('grok') ? 'codex-subscription' : 'grok-subscription' } }), /FALLBACK_GRANT_INVALID/)
  }
})

const vendorSource = () => ({ podUid: uid, imageId: `sha256:${digest}`, fixtureImportSha256: digest,
  profile: 'qa-unit', gitHead: 'a'.repeat(40) })
test('live producer emits login once, empty ledgers and actual subsequent attempt, then stops; historical mutation rejects', async () => {
  const bindings = planned.map(({ provider, modelId, unsupportedModelId }) => ({ provider, modelId, unsupportedModelId }))
  const vendors = bindings.map(binding => createSubscriptionImageVendor({ runId, bindings, acceptedProvider: binding.provider }))
  const sources = Object.fromEntries(bindings.map(binding => [binding.provider, vendorSource()]))
  const states = bindings.map((binding, index) => ({ provider: binding.provider, witness: sources[binding.provider], index }))
  const admission = { runId, bindings, vendorSources: sources }, controller = new AbortController()
  const generator = vendorFrames({ admission, states, loginFrame: { kind: 'unit-login-metadata' }, signal: controller.signal,
    observe: state => ({ ledger: vendors[state.index].snapshot() }) })
  assert.equal(JSON.parse((await generator.next()).value).kind, 'unit-login-metadata')
  for (let index = 0; index < 2; index++) assert.deepEqual(JSON.parse((await generator.next()).value).ledger.attempts, [])
  await vendors[0].respond(SUBSCRIPTION_VENDOR_URLS[bindings[0].provider].responses, { method: 'POST',
    body: JSON.stringify({ model: bindings[0].modelId, input: [{ role: 'user', content: [{ type: 'input_text',
      text: `Receipt: ${uid}` }] }] }) })
  const changed = JSON.parse((await generator.next()).value)
  assert.equal(changed.ledger.attempts.length, 1)
  // Advance one prefix before corrupting it: a vacuous initial-ledger check
  // would miss this change and falsely accept mutable historical evidence.
  let observation = structuredClone(changed.ledger)
  const history = vendorFrames({ admission, states: [states[0]], loginFrame: {}, signal: controller.signal,
    observe: () => ({ ledger: observation }) })
  await history.next(); await history.next()
  observation.attempts[0].requestSha256 = 'c'.repeat(64)
  await assert.rejects(history.next(), /HISTORY_CHANGED/)
  controller.abort(); await generator.return()
})

test('admission fixture accepts eligible same-provider alternate and rejects impossible cross-broker fallback', () => {
  const bindings = planned.map(value => ({ ...value })), runRoot = '/run/evenfire-e2e/unit'
  const run = { runId, profile: 'qa-unit', context: 'qa-unit', bindings, runRoot }
  const receipt = { kind: 'evenfire-subscription-remaining-journey-fixture-v1', runId, suite: 'admission-recovery',
    profile: run.profile, context: run.context, sourceManifestSha256: digest, preparedAt: new Date().toISOString(),
    fixtures: Object.fromEntries(bindings.map(binding => [binding.provider, { hostRef: binding.hostRef, podUid: uid,
      imageId: `sha256:${digest}`, controlApiPodUid: uid, controlApiImageId: `sha256:${digest}`, maxInFlight: 1,
      readDeadlineMs: 10000, pressure: { receiptFile: '/runner-admission/main-admission.json' }, fallback: binding.fallback }])) }
  const input = { suite: 'admission-recovery', fixtureReceiptPath: `${runRoot}/remaining.json` }
  assert.equal(validateRemainingFixture(receipt, input, run, digest), receipt)
  const bad = structuredClone(receipt)
  bad.fixtures[bindings[0].provider].fallback = { provider: bindings[1].provider, modelId: bindings[1].modelId }
  assert.throws(() => validateRemainingFixture(bad, input, run, digest), /eligible physical fallback/)
})

test('public source separates private input, actual frame stream, vendor-only derived closure and CAS restore', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const source = fs.readFileSync(path.join(root, 'scripts/e2e/coordinate-subscription-image-journeys.mjs'), 'utf8')
  const dockerfile = fs.readFileSync(path.join(root, 'scripts/e2e/fixtures/subscription-image-proxy.Dockerfile'), 'utf8')
  assert(source.includes('seed(memoryOptions, privateMaterial, async session'))
  assert(source.includes('session.revokeImages()') && source.includes('restoreDeployments(memoryOptions.context, states)'))
  assert(!source.includes('/environ') && !source.includes('page.evaluate') && !source.includes('storageState'))
  assert(dockerfile.includes('/app/mcp-host/node_modules/@napi-rs/') && !dockerfile.includes('npm ') && !dockerfile.includes('COPY dist'))
})

test('actual derived builder refuses ambiguous shell exports, nonlocal endpoints and changed base IDs before build', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-derived-builder-unit-')))
  try {
    const bin = path.join(temporary, 'bin'), scripts = path.join(temporary, 'scripts')
    fs.mkdirSync(bin); fs.mkdirSync(path.join(scripts, 'e2e'), { recursive: true })
    fs.mkdirSync(path.join(scripts, 'minikube'))
    for (const rel of ['scripts/e2e/build-subscription-image-proxy.sh', 'scripts/minikube/docker-cli-env.sh',
      'scripts/minikube/run-with-deadline.mjs']) fs.copyFileSync(path.join(root, rel), path.join(temporary, rel))
    const trace = path.join(temporary, 'operations')
    fs.writeFileSync(path.join(scripts, 'minikube/require-t2-mutation-lock.sh'), 'exit 0\n')
    const interpreter = `#!${process.execPath}\n`
    fs.writeFileSync(path.join(bin, 'docker'), interpreter + `
import fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(process.env.QA_TRACE,JSON.stringify(args)+'\\n');
if(args[0]==='context')process.stdout.write('unix:///private/tmp/qa-builder-unit.sock');
else if(args[0]==='image'&&args[1]==='inspect'){
 const ref=args.at(-1);process.stdout.write(ref.includes('host')?process.env.QA_HOST_ID:ref.includes('-base')||ref==='clerum/grok-llm-proxy:test'?process.env.QA_PROXY_ID:process.env.QA_DERIVED_ID);
}
`)
    fs.writeFileSync(path.join(bin, 'minikube'), interpreter + `
process.stdout.write(process.env.QA_DOCKER_EXPORTS);
`)
    fs.chmodSync(path.join(bin, 'docker'), 0o755); fs.chmodSync(path.join(bin, 'minikube'), 0o755)
    const expected = `sha256:${'b'.repeat(64)}`, host = `sha256:${'c'.repeat(64)}`, derived = `sha256:${'d'.repeat(64)}`
    const env = { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      DOCKER_HOST: 'unix:///private/tmp/qa-builder-unit.sock', MINIKUBE_PROFILE: 'qa-unit', CONTROL_API_REAL_PG_CONTEXT: 'qa-unit',
      QA_TRACE: trace, QA_PROXY_ID: expected, QA_HOST_ID: host, QA_DERIVED_ID: derived,
      QA_DOCKER_EXPORTS: 'export DOCKER_HOST="unix:///private/tmp/qa-builder-unit.sock"\nexport MINIKUBE_ACTIVE_DOCKERD="qa-unit"\n' }
    const args = [path.join(scripts, 'e2e/build-subscription-image-proxy.sh'), 'qa-unit', temporary,
      'clerum/grok-llm-proxy:test', expected, host, 'clerum/grok-llm-proxy-image-qa:123456789abc', 'a'.repeat(40)]
    const successful = spawnSync('bash', args, { env, encoding: 'utf8', timeout: 30000 })
    assert.equal(successful.status, 0, successful.stderr)
    assert.deepEqual(JSON.parse(successful.stdout), { imageId: derived, baseImageId: expected, hostImageId: host, gitHead: 'a'.repeat(40) })
    assert(fs.readFileSync(trace, 'utf8').includes('"build"'))
    for (const patch of [
      { QA_DOCKER_EXPORTS: 'export DOCKER_HOST="tcp://192.0.2.1:2376"\nexport MINIKUBE_ACTIVE_DOCKERD="qa-unit"\n' },
      { QA_DOCKER_EXPORTS: 'export DOCKER_HOST="unix:///private/tmp/qa-builder-unit.sock"\nexport PATH="/bad"\n' },
      { QA_DOCKER_EXPORTS: '' }, { QA_PROXY_ID: `sha256:${'e'.repeat(64)}` },
    ]) {
      fs.writeFileSync(trace, '')
      const refused = spawnSync('bash', args, { env: { ...env, ...patch }, encoding: 'utf8', timeout: 30000 })
      assert.notEqual(refused.status, 0)
      assert(!fs.readFileSync(trace, 'utf8').includes('"build"'))
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})
