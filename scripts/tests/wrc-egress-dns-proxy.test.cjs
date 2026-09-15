'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const dgram = require('node:dgram')
const { Resolver } = require('node:dns/promises')
const net = require('node:net')
const {
  createDnsProxy,
  readConfig,
  question,
  dnsResponse,
  tcpFrame,
} = require('../../tests/e2e/fixtures/wrc-egress-dns-proxy/server.cjs')

const targets = [
  { lane: 'ui', fqdn: 'ui.example.com', ip: '93.184.216.34' },
  { lane: 'worker', fqdn: 'worker.example.com', ip: '93.184.216.35' },
]
function query(fqdn, id = 7, type = 1) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const name = fqdn.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)])
  const tail = Buffer.from([0, 0, 0, 0, 1])
  tail.writeUInt16BE(type, 1)
  return Buffer.concat([header, ...name, tail])
}

async function udpClient(t) {
  const socket = dgram.createSocket('udp4')
  socket.bind(0, '127.0.0.1')
  await once(socket, 'listening')
  t.after(() => new Promise(resolve => socket.close(resolve)))
  return socket
}
async function exchangeUdp(socket, port, message) {
  const response = once(socket, 'message', { signal: AbortSignal.timeout(2000) })
  socket.send(message, port, '127.0.0.1')
  return (await response)[0]
}
async function exchangeTcp(port, message) {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect', { signal: AbortSignal.timeout(2000) })
  try {
    const response = new Promise((resolve, reject) => {
      let pending = Buffer.alloc(0)
      socket.setTimeout(2000, () => reject(new Error('test TCP DNS deadline')))
      socket.once('error', reject)
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk])
        if (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
          resolve(pending.subarray(2, pending.readUInt16BE(0) + 2))
        }
      })
    })
    const framed = tcpFrame(message)
    socket.write(framed.subarray(0, 1))
    socket.write(framed.subarray(1))
    return await response
  } finally {
    socket.destroy()
  }
}

async function fixture(t, configuredTargets = targets) {
  const upstream = await udpClient(t)
  const upstreamPort = upstream.address().port
  const respond = message => dnsResponse(message, question(message), 3, '203.0.113.7', 20)
  upstream.on('message', (message, rinfo) =>
    upstream.send(respond(message), rinfo.port, rinfo.address)
  )
  const tcpUpstream = net.createServer(socket => {
    let pending = Buffer.alloc(0)
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        socket.end(tcpFrame(respond(pending.subarray(2, pending.readUInt16BE(0) + 2))))
      }
    })
  })
  tcpUpstream.listen(upstreamPort, '127.0.0.1')
  await once(tcpUpstream, 'listening')
  t.after(() => new Promise(resolve => tcpUpstream.close(resolve)))
  const proxy = createDnsProxy({
    targets: configuredTargets,
    upstream: '127.0.0.1',
    upstreamPort,
    listenHost: '127.0.0.1',
    dnsPort: 0,
    controlPort: 0,
    ttlSeconds: 10,
  })
  t.after(() => proxy.close())
  const ports = await proxy.start()
  const control = async (path, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${ports.controlPort}${path}`, {
      method,
      signal: AbortSignal.timeout(2000),
      headers: { connection: 'close' },
    })
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : undefined,
    }
  }
  return { proxy, ports, control }
}

test('target configuration is explicit, bounded, unambiguous, and safe for arbitrary names', () => {
  const valid = { targets, upstream: '127.0.0.1' }
  assert.throws(() => readConfig({ TARGET_DNS: 'legacy.example.com', UPSTREAM_DNS: '127.0.0.1' }))
  assert.deepEqual(
    readConfig({ DNS_TARGETS_JSON: JSON.stringify(targets), UPSTREAM_DNS: '127.0.0.1' }),
    { ...valid, ttlSeconds: 300 }
  )
  for (const options of [
    { ...valid, targets: [] },
    { ...valid, targets: [targets[0], targets[0]] },
    { ...valid, targets: [targets[0], { ...targets[1], fqdn: targets[0].fqdn }] },
    { ...valid, targets: [{ ...targets[0], lane: '__proto__' }] },
    { ...valid, targets: [{ ...targets[0], ip: '999.1.2.3' }] },
    { ...valid, targets: [{ ...targets[0], fqdn: 'UPPER.example.com' }] },
    { ...valid, targets: [{ ...targets[0], fqdn: 'not-a-host' }] },
    { ...valid, targets: [{ ...targets[0], unknown: true }] },
    { ...valid, upstream: 'upstream.example.com' },
    { ...valid, ttlSeconds: 0 },
    { ...valid, ttlSeconds: 301 },
    { ...valid, dnsPort: -1 },
    { ...valid, upstreamPort: 0 },
  ])
    assert.throws(() => createDnsProxy(options))
  assert.equal({}.polluted, undefined)
})

test('parses exact DNS questions and rejects malformed or compressed question interpretation', () => {
  const wire = query('UI.example.com', 42)
  assert.deepEqual(question(wire), {
    name: 'ui.example.com',
    type: 1,
    queryClass: 1,
    id: 42,
    end: wire.length,
  })
  for (let length = 0; length < wire.length; length++)
    assert.equal(question(wire.subarray(0, length)), null)
  const compressed = Buffer.from(wire)
  compressed[12] = 0xc0
  assert.equal(question(compressed), null)
  const multiple = Buffer.from(wire)
  multiple.writeUInt16BE(2, 4)
  assert.equal(question(multiple), null)
})

test(
  'UDP and TCP serve each lane independently with real A records and configured TTL',
  { timeout: 5000 },
  async t => {
    const { proxy, ports, control } = await fixture(t)
    const socket = await udpClient(t)
    for (const [index, target] of targets.entries()) {
      const message = query(target.fqdn, index + 20)
      const udp = await exchangeUdp(socket, ports.dnsPort, message)
      assert.deepEqual(udp, dnsResponse(message, question(message), 0, target.ip, 10))
      const tcp = await exchangeTcp(ports.dnsPort, message)
      assert.deepEqual(tcp, udp)
    }
    const state = (await control('/state')).body
    assert.equal(state.fault, null)
    assert.equal(state.counts.ok, 4)
    assert.deepEqual(
      state.lanes.map(lane => lane.received.ok),
      [2, 2]
    )
    assert.deepEqual(
      state.lanes.map(lane => lane.counts.ok),
      [2, 2]
    )
    assert.deepEqual(state.lanes[0].questions.map(value => value.transport).sort(), ['tcp', 'udp'])
    assert.equal(proxy.snapshot().lanes[1].unique.ok, 2)
  }
)

test(
  'duplicate UI retries cannot prove a worker observation; releasing hold emits SERVFAIL',
  { timeout: 5000 },
  async t => {
    const { proxy, ports, control } = await fixture(t)
    const socket = await udpClient(t)
    assert.equal((await control('/mode/ui/hold', 'POST')).status, 200)
    const message = query(targets[0].fqdn, 89)
    socket.send(message, ports.dnsPort, '127.0.0.1')
    socket.send(message, ports.dnsPort, '127.0.0.1')
    const deadline = Date.now() + 1500
    let state
    do {
      state = (await control('/state')).body
    } while (state.held !== 2 && Date.now() < deadline)
    assert.equal(state.held, 2)
    assert.equal(state.lanes[0].counts.hold, 2)
    assert.equal(state.lanes[0].unique.hold, 1)
    assert.equal(state.lanes[0].received.hold, 1)
    assert.equal(state.lanes[1].counts.hold, 0)
    const workerQuery = query(targets[1].fqdn, 90)
    assert.equal((await exchangeUdp(socket, ports.dnsPort, workerQuery)).readUInt16BE(2) & 15, 0)
    const received = once(socket, 'message', { signal: AbortSignal.timeout(2000) })
    await control('/mode/ui/servfail', 'POST')
    assert.deepEqual(
      (await received)[0],
      dnsResponse(message, question(message), 2, targets[0].ip, 10)
    )
    state = proxy.snapshot()
    assert.equal(state.held, 0)
    assert.equal(state.lanes[0].counts.servfail, 2)
    assert.equal(state.lanes[0].unique.servfail, 1)
    assert.equal(state.lanes[0].received.servfail, 0)
    assert.equal(state.lanes[1].counts.servfail, 0)
    assert.equal(state.fault, null)
  }
)

test(
  'global modes preserve per-lane counters and recover without changing targets',
  { timeout: 5000 },
  async t => {
    const { proxy, ports, control } = await fixture(t)
    const socket = await udpClient(t)
    await control('/mode/servfail', 'POST')
    for (const [index, target] of targets.entries()) {
      assert.equal(
        (await exchangeUdp(socket, ports.dnsPort, query(target.fqdn, index + 40))).readUInt16BE(2) &
          15,
        2
      )
    }
    await control('/mode/ok', 'POST')
    for (const [index, target] of targets.entries()) {
      assert.equal(
        (await exchangeUdp(socket, ports.dnsPort, query(target.fqdn, index + 40))).readUInt16BE(2) &
          15,
        0
      )
    }
    const state = proxy.snapshot()
    assert.deepEqual(
      state.lanes.map(value => ({
        fqdn: value.fqdn,
        ok: value.unique.ok,
        failed: value.unique.servfail,
      })),
      targets.map(value => ({ fqdn: value.fqdn, ok: 1, failed: 1 }))
    )
    assert.equal((await control('/mode/__proto__/hold', 'POST')).status, 404)
    assert.equal((await control('/mode/worker/unknown', 'POST')).status, 404)
    assert.equal((await control('/mode/hold')).status, 404)
    assert.throws(() => proxy.setMode('constructor'))
  }
)

for (const releaseMode of ['ok', 'servfail']) {
  test(
    `received DNS requests exclude an expired hold flushed as ${releaseMode}`,
    { timeout: 5000 },
    async t => {
      const { proxy, ports, control } = await fixture(t)
      const resolver = new Resolver({ timeout: 25, tries: 1 })
      resolver.setServers([`127.0.0.1:${ports.dnsPort}`])
      await control('/mode/ui/hold', 'POST')
      await assert.rejects(resolver.resolve4(targets[0].fqdn), { code: 'ETIMEOUT' })
      const before = proxy.snapshot().lanes.find(lane => lane.lane === 'ui')
      assert.equal(before.held, 1, 'the DNS client has finished but its datagram remains queued')
      assert.deepEqual(before.received, { ok: 0, hold: 1, servfail: 0 })
      await control(`/mode/ui/${releaseMode}`, 'POST')
      const released = proxy.snapshot().lanes.find(lane => lane.lane === 'ui')
      assert.equal(
        released.counts[releaseMode],
        1,
        'legacy response counters still include the queued response'
      )
      assert.deepEqual(released.received, before.received, 'flushing does not receive a new query')
      if (releaseMode === 'servfail') {
        await assert.rejects(resolver.resolve4(targets[0].fqdn), { code: 'ESERVFAIL' })
      } else {
        assert.deepEqual(await resolver.resolve4(targets[0].fqdn), [targets[0].ip])
      }
      const after = proxy.snapshot()
      const observed = after.lanes.find(lane => lane.lane === 'ui')
      assert.equal(
        observed.received[releaseMode],
        1,
        'only a request received in the new mode counts'
      )
      assert.equal(observed.received.hold, 1)
      assert.deepEqual(after.lanes.find(lane => lane.lane === 'worker').received, {
        ok: 0,
        hold: 0,
        servfail: 0,
      })
      assert.equal(after.fault, null)
    }
  )
}

test(
  'forwards unrelated UDP/TCP and target AAAA byte-for-byte even while target A is held',
  { timeout: 5000 },
  async t => {
    const { proxy, ports, control } = await fixture(t)
    const socket = await udpClient(t)
    await control('/mode/hold', 'POST')
    for (const message of [query('unrelated.example.com', 77), query(targets[0].fqdn, 78, 28)]) {
      const expected = dnsResponse(message, question(message), 3, '203.0.113.7', 20)
      assert.deepEqual(await exchangeUdp(socket, ports.dnsPort, message), expected)
      assert.deepEqual(await exchangeTcp(ports.dnsPort, message), expected)
    }
    const state = proxy.snapshot()
    assert.equal(state.held, 0)
    assert.equal(state.counts.forwarded, 4)
    assert.equal(state.lanes[0].counts.forwarded, 2)
    assert.equal(
      state.lanes[0].questions.every(value => value.type === 28 && value.mode === 'forwarded'),
      true
    )
    assert.equal(state.lanes[1].questions.length, 0)
    assert.deepEqual(state.lanes[0].received, { ok: 0, hold: 0, servfail: 0 })
  }
)

test(
  'scoped UI/worker outages keep a third canary lane resolvable throughout',
  { timeout: 5000 },
  async t => {
    const canary = { lane: 'canary', fqdn: 'canary.example.com', ip: '93.184.216.36' }
    const { proxy, ports, control } = await fixture(t, [...targets, canary])
    const socket = await udpClient(t)
    for (const mode of ['hold', 'servfail', 'ok']) {
      assert.equal((await control(`/mode/ui/${mode}`, 'POST')).status, 200)
      assert.equal((await control(`/mode/worker/${mode}`, 'POST')).status, 200)
      const wire = query(canary.fqdn, mode === 'hold' ? 111 : mode === 'servfail' ? 112 : 113)
      assert.deepEqual(
        await exchangeUdp(socket, ports.dnsPort, wire),
        dnsResponse(wire, question(wire), 0, canary.ip, 10)
      )
      const state = proxy.snapshot().lanes.find(lane => lane.lane === 'canary')
      assert.equal(state.mode, 'ok')
      assert.equal(state.counts.hold, 0)
      assert.equal(state.counts.servfail, 0)
    }
    assert.equal(proxy.snapshot().lanes.find(lane => lane.lane === 'canary').unique.ok, 3)
    assert.deepEqual(proxy.snapshot().lanes.find(lane => lane.lane === 'canary').received, {
      ok: 3,
      hold: 0,
      servfail: 0,
    })
    assert.equal((await control('/mode/canary/servfail', 'POST')).status, 200)
    assert.equal(
      (await exchangeUdp(socket, ports.dnsPort, query(canary.fqdn, 114))).readUInt16BE(2) & 15,
      2
    )
    assert.equal(proxy.snapshot().fault, null)
  }
)

test(
  'closing with held UDP/TCP queries releases all listeners and does not manufacture success',
  { timeout: 5000 },
  async t => {
    const { proxy, ports, control } = await fixture(t)
    const socket = await udpClient(t)
    await control('/mode/hold', 'POST')
    socket.send(query(targets[0].fqdn), ports.dnsPort, '127.0.0.1')
    const tcp = net.createConnection({ host: '127.0.0.1', port: ports.dnsPort })
    await once(tcp, 'connect')
    tcp.on('error', error => assert.equal(error.code, 'ECONNRESET'))
    const closed = new Promise(resolve => tcp.once('close', resolve))
    tcp.write(tcpFrame(query(targets[1].fqdn)))
    await proxy.close()
    await closed
    assert.equal(proxy.snapshot().held, 0)
    assert.equal(proxy.snapshot().counts.ok, 0)
    await assert.rejects(proxy.start(), /cannot be started twice/)
  }
)

test(
  'held-query overflow is bounded and explicitly invalidates fixture evidence',
  { timeout: 5000 },
  async t => {
    const { proxy, ports, control } = await fixture(t)
    await control('/mode/ui/hold', 'POST')
    const socket = net.createConnection({ host: '127.0.0.1', port: ports.dnsPort })
    socket.on('error', error => assert.equal(error.code, 'ECONNRESET'))
    await once(socket, 'connect')
    t.after(() => socket.destroy())
    socket.write(
      Buffer.concat(Array.from({ length: 513 }, (_, id) => tcpFrame(query(targets[0].fqdn, id))))
    )
    const deadline = Date.now() + 1500
    let state
    do {
      state = (await control('/state')).body
    } while (state.fault === null && Date.now() < deadline)
    assert.equal(state.fault, 'HELD_QUERY_LIMIT')
    assert.equal(state.held, 512)
    assert.equal(state.lanes[0].counts.hold, 513)
    assert.equal(state.lanes[1].counts.hold, 0)
    assert.equal(state.counts.ok, 0)
    await proxy.close()
  }
)
