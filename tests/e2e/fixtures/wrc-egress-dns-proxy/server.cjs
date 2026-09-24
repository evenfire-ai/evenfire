'use strict'

const dgram = require('node:dgram')
const http = require('node:http')
const net = require('node:net')

const MAX_HELD = 512
const MAX_OBSERVATIONS = 16
const MAX_QUERY_IDENTITIES = 1024
const MAX_RELAYS = 128
const MODES = new Set(['ok', 'hold', 'servfail'])

function validHostname(value) {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    value.includes('.') &&
    value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
}

function readConfig(env) {
  let targets
  try {
    targets = JSON.parse(env.DNS_TARGETS_JSON)
  } catch {
    throw new Error('DNS_TARGETS_JSON must contain the explicit UI/worker/canary target array')
  }
  return {
    targets,
    upstream: env.UPSTREAM_DNS,
    ttlSeconds: env.DNS_TTL_SECONDS === undefined ? 300 : Number(env.DNS_TTL_SECONDS),
  }
}

function question(message) {
  if (message.length < 12 || message.readUInt16BE(4) !== 1 || message.readUInt16BE(2) & 0x8000)
    return null
  let offset = 12
  const labels = []
  while (offset < message.length) {
    const length = message[offset++]
    if (length === 0) break
    // Compressed questions are forwarded unchanged, not partially interpreted.
    if (length > 63 || offset + length > message.length) return null
    labels.push(message.subarray(offset, offset + length).toString('ascii'))
    offset += length
  }
  if (offset + 4 > message.length) return null
  return {
    name: labels.join('.').toLowerCase(),
    type: message.readUInt16BE(offset),
    queryClass: message.readUInt16BE(offset + 2),
    end: offset + 4,
    id: message.readUInt16BE(0),
  }
}

function dnsResponse(message, parsed, rcode, answerIp, ttlSeconds) {
  const header = Buffer.from(message.subarray(0, 12))
  header.writeUInt16BE(0x8180 | rcode, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(rcode === 0 ? 1 : 0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  const questionBytes = message.subarray(12, parsed.end)
  if (rcode !== 0) return Buffer.concat([header, questionBytes])
  const record = Buffer.from([
    0xc0,
    0x0c,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    4,
    ...answerIp.split('.').map(Number),
  ])
  record.writeUInt32BE(ttlSeconds, 6)
  return Buffer.concat([header, questionBytes, record])
}

function tcpFrame(message) {
  const frame = Buffer.alloc(message.length + 2)
  frame.writeUInt16BE(message.length, 0)
  message.copy(frame, 2)
  return frame
}

const emptyCounts = () => ({ ok: 0, hold: 0, servfail: 0, forwarded: 0 })
// Explicit writes keep DNS-derived names/types away from object-property writes.
function increment(counts, mode) {
  if (mode === 'ok') counts.ok++
  else if (mode === 'hold') counts.hold++
  else if (mode === 'servfail') counts.servfail++
  else if (mode === 'forwarded') counts.forwarded++
  else throw new Error('Invalid observation mode')
}

/** A real UDP/TCP DNS fixture; ephemeral loopback ports are used only by tests. */
function createDnsProxy({
  targets,
  upstream,
  ttlSeconds = 300,
  upstreamPort = 53,
  listenHost = '0.0.0.0',
  dnsPort = 8053,
  controlPort = 8090,
}) {
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > 3 ||
    !net.isIPv4(upstream) ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 300 ||
    ![upstreamPort, dnsPort, controlPort].every(
      port => Number.isInteger(port) && port >= 0 && port <= 65535
    ) ||
    upstreamPort === 0
  ) {
    throw new Error(
      'Explicit targets, IPv4 upstream, valid ports, and DNS TTL from 1 to 300 are required'
    )
  }
  const lanes = new Map()
  const byName = new Map()
  for (const target of targets) {
    if (
      !target ||
      !['ui', 'worker', 'canary'].includes(target.lane) ||
      !validHostname(target.fqdn) ||
      typeof target.ip !== 'string' ||
      !net.isIPv4(target.ip) ||
      lanes.has(target.lane) ||
      byName.has(target.fqdn) ||
      Object.keys(target).some(key => !['lane', 'fqdn', 'ip'].includes(key))
    ) {
      throw new Error(
        'DNS targets require distinct UI/worker/canary lanes, distinct lowercase FQDNs, and IPv4 answers'
      )
    }
    const state = {
      lane: target.lane,
      fqdn: target.fqdn,
      ip: target.ip,
      mode: 'ok',
      revision: 0,
      counts: emptyCounts(),
      unique: emptyCounts(),
      received: { ok: 0, hold: 0, servfail: 0 },
      receivedIdentities: new Map(),
      held: [],
      observations: new Map(),
    }
    lanes.set(target.lane, state)
    byName.set(target.fqdn, state)
  }

  const counts = emptyCounts()
  const udp = dgram.createSocket('udp4')
  const connections = new Set()
  const relays = new Set()
  let fault = null
  let started = false
  let closing = false

  const queryIdentity = (state, entry) =>
    `${state.revision}:${entry.client}:${entry.parsed.id}:${entry.parsed.name}:${entry.parsed.queryClass}`

  // Receipt evidence concerns new IN/A requests in the current mode. Sending
  // an old held response (possibly after its client timed out) never enters
  // this path. The keys have only three modes and two server-owned transports;
  // each bucket has the same identity bound as the existing observation sets.
  function receive(state, entry) {
    const key = `${state.mode}:${entry.transport}`
    let identities = state.receivedIdentities.get(key)
    if (!identities) {
      identities = new Set()
      state.receivedIdentities.set(key, identities)
    }
    const identity = queryIdentity(state, entry)
    if (identities.has(identity)) return
    if (identities.size >= MAX_QUERY_IDENTITIES) {
      fault = 'RECEIVED_QUERY_IDENTITY_LIMIT'
      return
    }
    identities.add(identity)
    increment(state.received, state.mode)
  }

  function observe(state, entry, mode) {
    increment(counts, mode)
    if (!state) return
    increment(state.counts, mode)
    const key = `${entry.parsed.type}:${entry.transport}:${mode}`
    let observation = state.observations.get(key)
    if (!observation) {
      if (state.observations.size >= MAX_OBSERVATIONS) {
        fault = 'OBSERVATION_LIMIT'
        return
      }
      observation = {
        type: entry.parsed.type,
        transport: entry.transport,
        mode,
        count: 0,
        seen: new Set(),
      }
      state.observations.set(key, observation)
    }
    observation.count++
    const identity = queryIdentity(state, entry)
    if (!observation.seen.has(identity)) {
      if (observation.seen.size >= MAX_QUERY_IDENTITIES) {
        fault = 'QUERY_IDENTITY_LIMIT'
        return
      }
      observation.seen.add(identity)
      increment(state.unique, mode)
    }
  }

  function send(entry, selectedMode) {
    if (entry.transport === 'tcp' && entry.socket.destroyed) return
    const state = entry.state
    const response = dnsResponse(
      entry.message,
      entry.parsed,
      selectedMode === 'ok' ? 0 : 2,
      state.ip,
      ttlSeconds
    )
    observe(state, entry, selectedMode)
    if (entry.transport === 'udp') {
      udp.send(response, entry.rinfo.port, entry.rinfo.address, error => {
        if (error) fault = 'DNS_SEND_FAILED'
      })
    } else if (!entry.socket.destroyed) {
      entry.socket.write(tcpFrame(response))
    }
  }

  function forwardUdp(message, rinfo) {
    if (relays.size >= MAX_RELAYS) {
      fault = 'RELAY_LIMIT'
      return
    }
    const relay = dgram.createSocket('udp4')
    let done = false
    const close = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      relays.delete(close)
      relay.close()
    }
    const timer = setTimeout(close, 5000)
    relays.add(close)
    relay.once('message', response => {
      udp.send(response, rinfo.port, rinfo.address, error => {
        if (error) fault = 'DNS_FORWARD_SEND_FAILED'
      })
      close()
    })
    relay.once('error', close)
    relay.send(message, upstreamPort, upstream, error => {
      if (error) close()
    })
  }

  function forwardTcp(message, socket) {
    if (relays.size >= MAX_RELAYS) {
      fault = 'RELAY_LIMIT'
      return
    }
    const relay = net.createConnection({ host: upstream, port: upstreamPort }, () =>
      relay.write(tcpFrame(message))
    )
    const close = () => {
      relays.delete(close)
      relay.destroy()
    }
    relays.add(close)
    let pending = Buffer.alloc(0)
    relay.setTimeout(5000, close)
    relay.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length > 65537) {
        close()
        return
      }
      if (pending.length < 2) return
      const length = pending.readUInt16BE(0)
      if (pending.length < length + 2) return
      if (!socket.destroyed) socket.write(pending.subarray(0, length + 2))
      close()
    })
    relay.once('error', close)
    relay.once('close', () => relays.delete(close))
  }

  function handle(message, entry) {
    if (closing) return
    const parsed = question(message)
    const state = parsed && byName.get(parsed.name)
    entry.parsed = parsed
    if (state && parsed.type === 1 && parsed.queryClass === 1) {
      if (message.length > 4096) {
        fault = 'TARGET_QUERY_SIZE_LIMIT'
        return
      }
      entry.message = message
      entry.state = state
      receive(state, entry)
      if (state.mode === 'hold') {
        observe(state, entry, 'hold')
        if (state.held.length >= MAX_HELD) {
          fault = 'HELD_QUERY_LIMIT'
          return
        }
        state.held.push(entry)
      } else send(entry, state.mode)
      return
    }
    observe(state, entry, 'forwarded')
    if (entry.transport === 'udp') forwardUdp(message, entry.rinfo)
    else forwardTcp(message, entry.socket)
  }

  function setMode(nextMode, lane) {
    if (!MODES.has(nextMode) || (lane !== undefined && !lanes.has(lane)))
      throw new Error('Invalid DNS mode or lane')
    for (const state of lane === undefined ? lanes.values() : [lanes.get(lane)]) {
      if (state.mode !== nextMode) state.revision++
      state.mode = nextMode
      if (nextMode !== 'hold') {
        const held = state.held.splice(0)
        for (const entry of held) send(entry, nextMode)
      }
    }
  }

  function snapshot() {
    const states = [...lanes.values()]
    return {
      mode: states.every(state => state.mode === states[0].mode) ? states[0].mode : 'mixed',
      held: states.reduce((sum, state) => sum + state.held.length, 0),
      counts: { ...counts },
      fault,
      lanes: states.map(state => ({
        lane: state.lane,
        fqdn: state.fqdn,
        mode: state.mode,
        held: state.held.length,
        counts: { ...state.counts },
        unique: { ...state.unique },
        received: { ...state.received },
        questions: [...state.observations.values()].map(value => ({
          type: value.type,
          transport: value.transport,
          mode: value.mode,
          count: value.count,
          unique: value.seen.size,
        })),
      })),
    }
  }

  udp.on('message', (message, rinfo) =>
    handle(message, { transport: 'udp', rinfo, client: `${rinfo.address}:${rinfo.port}` })
  )
  udp.on('error', () => {
    fault = 'DNS_SOCKET_FAILED'
  })
  const tcp = net.createServer(socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    socket.once('error', () => socket.destroy())
    socket.setTimeout(30000, () => socket.destroy())
    let pending = Buffer.alloc(0)
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length > 65537) {
        socket.destroy()
        return
      }
      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0)
        if (pending.length < length + 2) return
        const message = pending.subarray(2, length + 2)
        pending = pending.subarray(length + 2)
        handle(message, {
          transport: 'tcp',
          socket,
          client: `${socket.remoteAddress}:${socket.remotePort}`,
        })
      }
    })
  })
  tcp.maxConnections = 64
  const control = http.createServer((request, response) => {
    const globalMode = request.url?.match(/^\/mode\/(ok|hold|servfail)$/)?.[1]
    const laneMode = request.url?.match(/^\/mode\/(ui|worker|canary)\/(ok|hold|servfail)$/)
    if (request.method === 'POST' && (globalMode || laneMode)) {
      const lane = laneMode?.[1]
      if (lane !== undefined && !lanes.has(lane)) {
        response.writeHead(404).end()
        return
      }
      setMode(globalMode ?? laneMode[2], lane)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(snapshot()))
      return
    }
    if (request.method === 'GET' && request.url === '/state') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(snapshot()))
      return
    }
    response.writeHead(404).end()
  })
  control.requestTimeout = 5000
  control.headersTimeout = 5000

  const listen = (server, action) =>
    new Promise((resolve, reject) => {
      const failed = error => {
        server.removeListener('listening', ready)
        reject(error)
      }
      const ready = () => {
        server.removeListener('error', failed)
        resolve()
      }
      server.once('error', failed)
      server.once('listening', ready)
      action()
    })
  async function close() {
    if (closing) return
    closing = true
    for (const state of lanes.values()) state.held.length = 0
    for (const relayClose of [...relays]) relayClose()
    for (const socket of connections) socket.destroy()
    control.closeAllConnections()
    await Promise.all(
      [tcp, control].map(server => new Promise(resolve => server.close(() => resolve())))
    )
    await new Promise(resolve => {
      try {
        udp.close(resolve)
      } catch {
        resolve()
      }
    })
  }
  async function start() {
    if (started || closing) throw new Error('DNS fixture cannot be started twice')
    started = true
    try {
      await listen(udp, () => udp.bind(dnsPort, listenHost))
      await listen(tcp, () => tcp.listen(udp.address().port, listenHost))
      await listen(control, () => control.listen(controlPort, '127.0.0.1'))
      return { dnsPort: udp.address().port, controlPort: control.address().port }
    } catch (error) {
      await close()
      throw error
    }
  }
  return { start, close, snapshot, setMode }
}

module.exports = { createDnsProxy, readConfig, question, dnsResponse, tcpFrame }
if (require.main === module) {
  let proxy
  try {
    proxy = createDnsProxy(readConfig(process.env))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
  if (proxy) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        void proxy.close().then(() => {
          process.exitCode = signal === 'SIGINT' ? 130 : 143
        })
      })
    }
    proxy
      .start()
      .then(() => process.stdout.write('wrc egress DNS proxy ready\n'))
      .catch(() => {
        process.stderr.write('DNS fixture listeners could not start\n')
        process.exitCode = 1
      })
  }
}
