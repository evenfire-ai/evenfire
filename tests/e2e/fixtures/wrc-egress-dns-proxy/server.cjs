'use strict'

const dgram = require('node:dgram')
const http = require('node:http')
const net = require('node:net')

const target = String(process.env.TARGET_DNS || '').toLowerCase()
const upstream = process.env.UPSTREAM_DNS
const answerIp = String(process.env.ANSWER_IP || '93.184.216.34')
const answerOctets = answerIp.split('.').map(Number)

if (!target || !upstream || answerOctets.length !== 4 || answerOctets.some(Number.isNaN)) {
  throw new Error('TARGET_DNS, UPSTREAM_DNS, and a valid IPv4 ANSWER_IP are required')
}

let mode = 'ok'
const held = []
const counts = { ok: 0, hold: 0, servfail: 0, forwarded: 0 }
const udp = dgram.createSocket('udp4')

function question(message) {
  let offset = 12
  const labels = []
  while (offset < message.length) {
    const length = message[offset++]
    if (length === 0) break
    if (offset + length > message.length) return null
    labels.push(message.subarray(offset, offset + length).toString('ascii'))
    offset += length
  }
  if (offset + 4 > message.length) return null
  return {
    name: labels.join('.').toLowerCase(),
    type: message.readUInt16BE(offset),
    end: offset + 4,
  }
}

function dnsResponse(message, parsed, rcode) {
  const header = Buffer.from(message.subarray(0, 12))
  header.writeUInt16BE(0x8180 | rcode, 2)
  header.writeUInt16BE(rcode === 0 ? 1 : 0, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  const questionBytes = message.subarray(12, parsed.end)
  if (rcode !== 0) return Buffer.concat([header, questionBytes])
  const record = Buffer.from([
    0xc0,
    0x0c,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0x01,
    0x2c,
    0x00,
    0x04,
    ...answerOctets,
  ])
  return Buffer.concat([header, questionBytes, record])
}

function tcpFrame(message) {
  const frame = Buffer.alloc(message.length + 2)
  frame.writeUInt16BE(message.length, 0)
  message.copy(frame, 2)
  return frame
}

function send(entry, selectedMode) {
  const response = dnsResponse(entry.message, entry.parsed, selectedMode === 'ok' ? 0 : 2)
  if (selectedMode === 'ok') counts.ok++
  else counts.servfail++
  if (entry.transport === 'udp') {
    udp.send(response, entry.rinfo.port, entry.rinfo.address)
  } else if (!entry.socket.destroyed) {
    entry.socket.write(tcpFrame(response))
  }
  if (selectedMode === 'ok') {
    console.log(entry.transport === 'udp' ? 'ok DNS A fixture via UDP' : 'ok DNS A fixture via TCP')
  } else {
    console.log(
      entry.transport === 'udp'
        ? 'servfail DNS A fixture via UDP'
        : 'servfail DNS A fixture via TCP'
    )
  }
}

function forwardUdp(message, rinfo) {
  counts.forwarded++
  const relay = dgram.createSocket('udp4')
  const timer = setTimeout(() => relay.close(), 5000)
  relay.once('message', response => {
    clearTimeout(timer)
    udp.send(response, rinfo.port, rinfo.address)
    relay.close()
  })
  relay.once('error', () => {
    clearTimeout(timer)
    relay.close()
  })
  relay.send(message, 53, upstream)
}

function forwardTcp(message, socket) {
  counts.forwarded++
  const relay = net.createConnection({ host: upstream, port: 53 }, () =>
    relay.write(tcpFrame(message))
  )
  let pending = Buffer.alloc(0)
  relay.setTimeout(5000, () => relay.destroy())
  relay.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    if (pending.length < 2) return
    const length = pending.readUInt16BE(0)
    if (pending.length < length + 2) return
    if (!socket.destroyed) socket.write(pending.subarray(0, length + 2))
    relay.destroy()
  })
  relay.once('error', () => relay.destroy())
}

function handle(message, entry) {
  const parsed = question(message)
  if (parsed && parsed.name === target && parsed.type === 1) {
    entry.message = message
    entry.parsed = parsed
    if (mode === 'hold') {
      counts.hold++
      held.push(entry)
      console.log(
        entry.transport === 'udp' ? 'hold DNS A fixture via UDP' : 'hold DNS A fixture via TCP'
      )
    } else {
      send(entry, mode)
    }
    return
  }
  if (entry.transport === 'udp') forwardUdp(message, entry.rinfo)
  else forwardTcp(message, entry.socket)
}

function setMode(nextMode) {
  mode = nextMode
  if (mode !== 'hold') {
    while (held.length > 0) send(held.shift(), mode)
  }
}

let listeners = 0
function listening() {
  listeners++
  if (listeners === 2) console.log('wrc egress DNS proxy ready')
}

udp.on('message', (message, rinfo) => handle(message, { transport: 'udp', rinfo }))
udp.bind(8053, '0.0.0.0', listening)

const tcp = net.createServer(socket => {
  let pending = Buffer.alloc(0)
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      const length = pending.readUInt16BE(0)
      if (pending.length < length + 2) return
      const message = pending.subarray(2, length + 2)
      pending = pending.subarray(length + 2)
      handle(message, { transport: 'tcp', socket })
    }
  })
})
tcp.listen(8053, '0.0.0.0', listening)

http
  .createServer((request, response) => {
    const nextMode = request.url?.match(/^\/mode\/(ok|hold|servfail)$/)?.[1]
    if (request.method === 'POST' && nextMode) {
      setMode(nextMode)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ mode, held: held.length, counts }))
      return
    }
    if (request.method === 'GET' && request.url === '/state') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ mode, held: held.length, counts }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  .listen(8090, '127.0.0.1')
