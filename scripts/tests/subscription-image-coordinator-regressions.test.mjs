// Hermetic causal tests for the private coordinator. Synthetic API/IPC state
// here is not physical profile, authentication, deployment or E2E evidence.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { prepareVendorEvidenceDirectory } from '../e2e/fixtures/subscription-image-provider.mjs'
import { closePressureResources, withImageQaSession, qaRestorationTargets } from '../e2e/coordinate-subscription-image-journeys.mjs'
import { openAdmissionPressure, pressureCommandDeadlineMs, verifyPressureMetadata } from '../e2e/fixtures/subscription-image-admission-pressure.mjs'
import { openAuthorizeAdmissionPressure } from './measure-control-api-authorize-memory.mjs'
import { prepareSubscriptionImageBindings, revokeSubscriptionImageBindings, resumeMemoryFixtures } from './lib/control-api-authorize-memory-seeder.ts'

const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const policy = { maxInFlight: 1, readDeadlineMs: 10000, workDeadlineMs: 30000, closeGraceMs: 250 }
const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr806-coordinator-regression-')))

test('runtime evidence directory survives an empty tmp mount and refuses a symlink or broad existing mode', () => {
  const root = temporary()
  try {
    const directory = path.join(root, 'evenfire-vendor'), file = path.join(directory, 'run.json')
    assert(!fs.existsSync(directory)); assert.equal(prepareVendorEvidenceDirectory(file), directory)
    assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700)
    assert.equal(fs.lstatSync(directory).uid, process.getuid())
    fs.chmodSync(directory, 0o755)
    assert.throws(() => prepareVendorEvidenceDirectory(file), /private owned directory/)
    assert.equal(fs.lstatSync(directory).mode & 0o777, 0o755)
    const link = path.join(root, 'linked'); fs.symlinkSync(directory, link)
    assert.throws(() => prepareVendorEvidenceDirectory(path.join(link, 'run.json')), /private owned directory/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

function pressureChannel({ releaseFails = false, stopFails = false } = {}) {
  let held = false, resolveResult, stops = 0
  return { get held() { return held }, get stops() { return stops },
    async call(input) {
      if (input.kind === 'hello') return { pressureOnly: true, owner: { inFlight: 0 }, serverPid: 4, policy }
      if (input.kind === 'owners') return { pid: 4, instanceCount: 1, inFlight: held ? 1 : 0,
        serverReads: { pid: 4, reads: held ? [{ requestId: 'pr806-memory-123456789abc-pressure-1', receivedBodyBytes: 1, complete: false }] : [] } }
      if (input.kind === 'counts') return { total: 0, tickets: 0, reservationRows: 0 }
      if (input.kind === 'close') {
        if (releaseFails) throw new Error('UNIT_RELEASE_FAILED')
        held = false; resolveResult({ transportClosed: true })
      }
      return {}
    },
    async open(input) { held = true; return { requestId: input.requestId, result: new Promise(resolve => { resolveResult = resolve }) } },
    async stop() { stops++; held = false; resolveResult?.({ transportClosed: true });
      if (stopFails) throw new Error('UNIT_STOP_FAILED'); return { code: 0 } },
  }
}
const openPressure = channel => openAuthorizeAdmissionPressure(channel, { runId: 'pr806-memory-123456789abc',
  candidate: { concurrency: 1 }, bindings: [{ hostRef: 'unit-host' }] })

test('relay rejection still releases held native requests and stops Channel before aggregate failure', async () => {
  const channel = pressureChannel(), pressure = await openPressure(channel)
  await pressure.hold(); assert.equal(channel.held, true)
  const relayError = new Error('UNIT_RELAY_FAILED')
  await assert.rejects(closePressureResources({ close: async () => { throw relayError } }, pressure), error =>
    error instanceof AggregateError && error.errors.includes(relayError))
  assert.equal(channel.held, false); assert.equal(channel.stops, 1)
  assert.equal(channel.timeoutMs, 40250); assert.deepEqual(pressure.policy, policy)
})
test('native release rejection cannot bypass Channel.stop and preserves both cleanup errors', async () => {
  const channel = pressureChannel({ releaseFails: true, stopFails: true }), pressure = await openPressure(channel)
  await pressure.hold()
  await assert.rejects(pressure.close(), error => error instanceof AggregateError &&
    error.errors.map(value => value.message).join(',') === 'UNIT_RELEASE_FAILED,UNIT_STOP_FAILED')
  assert.equal(channel.held, false); assert.equal(channel.stops, 1)
})

test('policy-derived command window covers actual release bounds without an arbitrary caller override', () => {
  assert.equal(pressureCommandDeadlineMs(policy), 40250)
  const maximum = { readDeadlineMs: 60000, workDeadlineMs: 120000, closeGraceMs: 10000 }
  assert.equal(pressureCommandDeadlineMs(maximum), 140000)
  for (const patch of [{ readDeadlineMs: undefined }, { workDeadlineMs: 120001 }, { closeGraceMs: 10000 }])
    assert.throws(() => pressureCommandDeadlineMs({ ...policy, ...patch }), /POLICY_INVALID/)
})

test('real private IPC client remains pending beyond old30s and accepts a policy-bounded release reply', async t => {
  // macOS TMPDIR is longer than AF_UNIX's pathname bound; use the canonical
  // short OS tmp root for this unit-only socket, as the Linux relay also does.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'p806-')))
  const socketPath = path.join(root, 'pressure.sock'), receiptFile = path.join(root, 'pressure.json')
  const metadata = { kind: 'evenfire-subscription-image-pressure-metadata-v1', profile: 'qa-unit', context: 'qa-unit',
    worktreeId: 'a'.repeat(40), sourceManifestSha256: 'b'.repeat(64), podUid: uid(1), imageId: `sha256:${'c'.repeat(64)}`,
    pressureRunId: 'subscription-image-pressure-123456789abc', hostRefs: ['qa-a', 'qa-b'], ...policy,
    commandDeadlineMs: pressureCommandDeadlineMs(policy), socketPath }
  fs.writeFileSync(receiptFile, JSON.stringify(metadata), { mode: 0o600 })
  const sockets = new Set(), observation = { ok: true, pressureRunId: metadata.pressureRunId, maxInFlight: 1,
    owners: { baseline: 0, held: 0, drained: 0 }, counts: { sameRunAttempts: 0, sameRunTickets: 0, reservations: 0 },
    pids: [4], inspector: { pid: 4, startTime: 'unit-process' } }
  let releaseSocket, releaseSeen
  const seen = new Promise(resolve => { releaseSeen = resolve })
  const server = net.createServer(socket => {
    sockets.add(socket); let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        if (frame.command === 'release') { releaseSocket = socket; releaseSeen() }
        else socket.write(JSON.stringify(observation) + '\n')
      }
    })
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(socketPath); await once(server, 'listening')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let client
  try {
    client = await openAdmissionPressure({ receiptFile })
    let settled = false
    const response = client.release().then(value => { settled = true; return value })
    await seen; t.mock.timers.tick(30001); await Promise.resolve()
    assert.equal(settled, false)
    releaseSocket.write(JSON.stringify(observation) + '\n')
    assert.equal((await response).owners.drained, 0)
    assert.throws(() => verifyPressureMetadata({ ...metadata, commandDeadlineMs: 30000 }), /METADATA_INVALID/)
  } finally {
    if (client) await client.close()
    t.mock.timers.reset(); for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true })
  }
})

function qaWorld({ residualFallback = false } = {}) {
  const options = { runId: 'pr806-memory-123456789abc', hostNamespace: 'qa-hosts' }
  const operator = { id: uid(1), desktopUserId: uid(2), username: `${options.runId}-operator`, email: 'unit@example.invalid' }
  const memory = { fixtureCredentialState: 'opaque-qa-not-real-G8', operatorId: operator.id,
    operatorDesktopUserId: operator.desktopUserId, operatorUsername: operator.username, operatorEmail: operator.email,
    operatorLink: { status: 'active' }, context: { uid: uid(3) }, gfs: { parentRid: 'a'.repeat(32), parentResourceId: uid(4) }, bindings: [] }
  const hosts = new Map(), grants = new Map(), budgets = new Map(), models = new Map()
  for (const [index, hostRef] of ['pr806-memory-grok-host', 'pr806-memory-grok-host-2'].entries()) {
    const connectionKey = `${options.runId}-grok-${index + 1}`, budgetName = `${options.runId}-${hostRef}-budget`
    memory.bindings.push({ hostRef, hostUid: uid(10 + index), connectionKey, connectionId: uid(20 + index), budgetId: uid(30 + index), budgetName })
    hosts.set(hostRef, { metadata: { uid: uid(10 + index), namespace: options.hostNamespace,
      labels: { 'evenfire.io/qa-memory-run': options.runId } }, spec: { contextRef: 'context1',
        model: { provider: 'grok-subscription', name: 'grok-4.6', connectionRef: connectionKey } } })
    grants.set(connectionKey, { id: uid(20 + index), status: 'connected', catalogStatus: 'ready', credentialRevision: 1,
      catalogRevision: 1, accountFingerprint: `qa-memory-${options.runId}-${index + 1}` })
    budgets.set(uid(30 + index), { name: budgetName, enabled: true, scope: { host_ref: [hostRef], provider: ['grok-subscription'], model: ['grok-4.6'] },
      unit: 'tokens', currency: null, enforcement: 'block', limit_amount: 100, max_task_amount: 200, min_start_amount: 1, period: 'daily', timezone: 'UTC' })
  }
  const session = { request: async request => {
    if (request.path.endsWith('contexts/context1')) return { status: 200, json: { metadata: { uid: uid(3) }, spec: { mcpServers: [] } } }
    if (request.path.includes('/budgets/')) return { status: 200, json: budgets.get(request.path.split('/').at(-1)) }
    if (request.path.startsWith('/api/v1/gfs/')) return { status: 200, json: { data: { resourceId: uid(4), kind: 'directory', name: options.runId } } }
    if (request.path.endsWith('llm-models') && request.method === 'POST') {
      const row = { ...request.body, id: String(models.size + 1) }; models.set(row.id, row); return { status: 201, json: row }
    }
    if (request.path.includes('/llm-models/')) return { status: 200, json: models.get(request.path.split('/').at(-1)) }
    if (request.method === 'POST' && request.path.endsWith('/hosts')) {
      const row = { metadata: { ...request.body.metadata, uid: uid(100 + hosts.size), namespace: options.hostNamespace, resourceVersion: '1' }, spec: request.body.spec }
      hosts.set(row.metadata.name, row); return { status: 201, json: row }
    }
    const name = request.path.split('/').at(-1), row = hosts.get(name)
    if (request.method === 'PUT') {
      const updated = { ...row, spec: structuredClone(request.body.spec) }
      if (residualFallback) updated.spec.llmPolicy.fallbacks = structuredClone(row.spec.llmPolicy.fallbacks)
      hosts.set(name, updated); return { status: 200, json: updated }
    }
    return { status: 200, json: row }
  } }
  const insert = async (_tx, _key, credential, key) => {
    const row = { id: uid(200 + grants.size), status: 'connected', catalogStatus: 'ready', credentialRevision: 1,
      catalogRevision: 0, accountFingerprint: credential.accountFingerprint }; grants.set(key, row); return row
  }
  const publish = async (_tx, input) => ({ ...grants.get(input.connectionKey), catalogRevision: 1 })
  const revoke = async (_tx, key) => { const row = grants.get(key); row.status = 'revoked'; return row }
  const prod = { config: {}, encryption: { deriveOAuthEncryptionKey: () => Buffer.alloc(32) },
    db: { pool: {}, withTransaction: work => work({ query: async (sql, values) => ({ rows:
      sql.includes('FOR UPDATE') ? [{ id: grants.get(values[0]).id, credential_revision: 1, account_fingerprint: grants.get(values[0]).accountFingerprint }] : [] }) }) },
    gateway: { llmAllowedModelsConfigMap: () => ({ materialize: async () => {} }) },
    connection: { insertInitialGrokSubscriptionConnection: insert, recordGrokCatalogOutcome: publish,
      revokeGrokSubscriptionConnection: revoke, getSafeGrokSubscriptionConnection: async (_pool, key) => grants.get(key) },
    codexConnection: { insertInitialCodexSubscriptionConnection: insert, recordCodexCatalogOutcome: publish, revokeCodexSubscriptionConnection: revoke } }
  return { options, operator, memory, session, prod, hosts, grants }
}

test('detach refuses an API success retaining a QA fallback before it can claim verified revocation', async () => {
  const world = qaWorld({ residualFallback: true }), state = []
  await prepareSubscriptionImageBindings({ ...world, prepared: world.memory, runId: 'subscription-image-111111111111', state })
  await assert.rejects(revokeSubscriptionImageBindings({ ...world, state }), /HOST_DETACH_FAILED/)
  assert.equal(world.grants.get(state[0].connectionKey).status, 'connected')
})
test('prepareA -> revokeA -> resume retained memory -> prepareB uses fresh image identities; resumeA fails', async () => {
  const world = qaWorld(), stateA = []
  const qaA = await prepareSubscriptionImageBindings({ ...world, prepared: world.memory, runId: 'subscription-image-111111111111', state: stateA })
  assert.equal((await revokeSubscriptionImageBindings({ ...world, state: stateA })).verified, true)
  for (const binding of qaA.bindings) {
    assert.equal(world.grants.get(binding.connectionKey).status, 'revoked')
    assert.deepEqual(world.hosts.get(binding.hostRef).spec.llmPolicy.fallbacks, [])
    assert.equal(world.hosts.get(binding.hostRef).spec.model.connectionRef, 'unassigned')
  }
  const resumed = await resumeMemoryFixtures({ ...world, expected: world.memory })
  const qaB = await prepareSubscriptionImageBindings({ ...world, prepared: resumed, runId: 'subscription-image-222222222222', state: [] })
  assert(qaB.bindings.every(binding => world.grants.get(binding.connectionKey).status === 'connected'))
  assert(qaB.bindings.every(binding => !qaA.bindings.some(before => before.connectionKey === binding.connectionKey || before.hostRef === binding.hostRef)))
  await assert.rejects(resumeMemoryFixtures({ ...world, expected: { ...world.memory, bindings: qaA.bindings } }), /BINDING_FOREIGN/)
})

test('revocation barrier retains vendor fixtures on residual fallback while allowing independent CAPI restoration', async () => {
  const world = qaWorld({ residualFallback: true }), state = [], timeline = []
  const status = { state: 'not-created', bindings: [] }
  const session = { prepareImages: runId => prepareSubscriptionImageBindings({ ...world, prepared: world.memory, runId, state }),
    revokeImages: async () => { timeline.push('revoke-attempt'); return revokeSubscriptionImageBindings({ ...world, state }) } }
  await assert.rejects(withImageQaSession(session, 'subscription-image-333333333333', status,
    async () => { timeline.push('fixture-run'); return 0 }), /HOST_DETACH_FAILED/)
  const deployments = [{ name: 'grok-llm-proxy', provider: 'grok-subscription', changed: true },
    { name: 'codex-llm-proxy', provider: 'codex-subscription', changed: true }, { name: 'control-api', changed: true }]
  const plan = qaRestorationTargets(status.state, deployments)
  for (const target of plan.restore) timeline.push(`restore:${target.name}`)
  assert.deepEqual(timeline, ['fixture-run', 'revoke-attempt', 'restore:control-api'])
  assert.equal(status.state, 'created'); assert.equal(status.bindings.length, 2)
  assert.equal(plan.retain.length, 2)
  assert(plan.retain.every(target => target.provider))
  assert.equal(world.grants.get(state[0].connectionKey).status, 'connected')
  assert.equal(qaRestorationTargets('created-or-unknown', deployments).retain.length, 2)
})
test('revocation barrier proves owned detach/revoke before any canonical vendor restore', async () => {
  const world = qaWorld(), state = [], timeline = [], status = { state: 'not-created', bindings: [] }
  const session = { prepareImages: runId => prepareSubscriptionImageBindings({ ...world, prepared: world.memory, runId, state }),
    revokeImages: async () => { const result = await revokeSubscriptionImageBindings({ ...world, state });
      timeline.push('revoke-verified'); return result } }
  assert.equal(await withImageQaSession(session, 'subscription-image-444444444444', status,
    async () => { timeline.push('fixture-run'); return 0 }), 0)
  const plan = qaRestorationTargets(status.state, [{ name: 'grok-llm-proxy', provider: 'grok-subscription', changed: true },
    { name: 'control-api', changed: true }])
  for (const target of plan.restore) timeline.push(`restore:${target.name}`)
  assert.deepEqual(timeline, ['fixture-run', 'revoke-verified', 'restore:grok-llm-proxy', 'restore:control-api'])
  assert.equal(status.state, 'revoked'); assert.deepEqual(plan.retain, [])
})
