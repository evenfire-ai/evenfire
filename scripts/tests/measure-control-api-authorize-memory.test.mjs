import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import fs from 'node:fs'
import { buildAuthorizeFixture, buildRejectedFixture, buildGfsFixture, MIB } from './lib/control-api-authorize-memory-fixtures.mjs'
import { InspectorClient, parseCgroup } from './lib/control-api-authorize-memory-inspector.mjs'

const require = createRequire(import.meta.url)
const grok = require('../../packages/grok-provider-attempt-contract/index.cjs')
const binding = { policyRevision: 1, policyHash: 'a'.repeat(64) }

test('physical visual/wide/worst fixtures reach35MiB under actual authorizer8MiB share and structure bounds', () => {
  for (const shape of ['visual-35mib', 'wide-strings', 'worst-structure']) {
    const fixture = buildAuthorizeFixture({ shape, binding, invocationId: `unit-${shape}` })
    assert(fixture.bytes.length >= 35 * MIB - 8192)
    assert(fixture.bytes.length <= 35 * MIB)
    assert(fixture.metadata.nonImageAuthorizeBytes <= 8 * MIB)
    assert.equal(fixture.metadata.decodedImageBytes, 20 * MIB)
    assert.match(fixture.metadata.sha256, /^[a-f0-9]{64}$/)
    assert.equal(grok.parseGrokCompletionRequest(fixture.request).ok, true)
    if (shape === 'worst-structure') {
      assert.equal(fixture.metadata.structure.containers, grok.LIMITS.maxRequestContainers)
      assert.equal(fixture.metadata.structure.members, grok.LIMITS.maxRequestMembers)
      assert.equal(fixture.metadata.structure.elements, grok.LIMITS.maxRequestElements)
    }
  }
})
test('rejected fixtures violate the intended physical bound rather than an invented model or malformed container', () => {
  const valid = buildAuthorizeFixture({ shape: 'visual-35mib', binding, invocationId: 'unit-rejection' })
  assert.equal(buildRejectedFixture(valid, 'codex-cap').metadata.expectedStatus, 413)
  const elements = buildRejectedFixture(valid, 'elements')
  assert.throws(() => grok.scanJsonStructure(elements.bytes, grok.BODY_STRUCTURE_LIMITS))
})
test('legacy GFS is actual16MiB contentBase64 below GFSC24MiB and reports decoded/serialized digests', () => {
  const fixture = buildGfsFixture({ name: 'unit-owned.bin', sequence: 37 })
  const parsed = JSON.parse(fixture.bytes.toString())
  assert.equal(Buffer.from(parsed.contentBase64, 'base64').length, 16 * MIB)
  assert(fixture.bytes.length < 24 * MIB)
  assert.equal(fixture.metadata.decodedBytes, 16 * MIB)
  assert.notEqual(fixture.metadata.sha256, fixture.metadata.serializedSha256)
})
test('cgroup requires actual768Mi/current/peak/events and never invents zeros for unavailable fields', () => {
  const raw = { limit: String(768 * MIB), current: '100', peak: '200', events: 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0' }
  assert.equal(parseCgroup(raw).peak, 200)
  for (const patch of [{ limit: 'max' }, { peak: undefined }, { events: 'low 0' }, { current: '300' }]) assert.throws(() => parseCgroup({ ...raw, ...patch }))
})
class UnitSocket extends EventTarget {
  constructor() { super(); this.commands = []; this.heap = 100 }
  send(raw) {
    const request = JSON.parse(raw); this.commands.push(request.method)
    let result = {}
    if (request.method === 'Runtime.evaluate') result = { result: { value: JSON.stringify({ pid: 4, nodeVersion: '24.18.0', at: this.commands.length, memory: { rss: 200, heapUsed: this.heap, heapTotal: 120, external: 20, arrayBuffers: 10 } }) } }
    if (request.method === 'HeapProfiler.collectGarbage') this.heap = 70
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) })))
  }
  close() { this.dispatchEvent(new Event('close')) }
}
test('forced-GC receipt requires native collectGarbage acknowledgement between actual process snapshots', async () => {
  const socket = new UnitSocket(), inspector = new InspectorClient(socket)
  const result = await inspector.forceGc()
  assert.equal(result.kind, 'native-HeapProfiler.collectGarbage')
  assert.equal(result.after.memory.heapUsed, 70)
  assert.deepEqual(socket.commands, ['Runtime.evaluate', 'HeapProfiler.enable', 'HeapProfiler.collectGarbage', 'Runtime.evaluate'])
  inspector.close()
})
test('missing nativeGC/metrics and incomplete coverage are failures, never post-quiescence substituted as forcedGC', async () => {
  const socket = new UnitSocket(), inspector = new InspectorClient(socket)
  await assert.rejects(() => inspector.coverage(), /coverage unavailable/)
  socket.send = raw => { const request = JSON.parse(raw); queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, error: { code: -1 } }) }))) }
  await assert.rejects(() => inspector.forceGc(), /rejected/)
  inspector.close()
})
test('companion is valid native Node24 TypeScript source; it contains no role elevation or delete of audit rows', () => {
  const source = fs.readFileSync(new URL('./lib/control-api-authorize-memory-companion.ts', import.meta.url), 'utf8')
  const compiled = stripTypeScriptTypes(source)
  assert(compiled.includes('issueMcpHostAccessJwt'))
  assert(compiled.includes('finalizeGrokProviderAttempt'))
  assert(!/DELETE FROM llm_provider_attempt|ALTER ROLE|DROP TABLE/.test(compiled))
})
