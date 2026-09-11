// Runs only in the isolated Linux network fixture; no global application mocks.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { after, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { startDnsFixture } from './dns-fixture.mjs'
import { Client } from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StreamableHTTPClientTransport } from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'

const content = '<title>Network fixture</title><p>issue198-real-result</p>'
let trapHits = 0
let slowClosed = 0
let slowActive = 0
let onSlowStarted = () => {}
const sockets = new Set()
const dns = await startDnsFixture()
let lastSni
const tlsServer = https.createServer(
  {
    key: readFileSync('/fixture-tls/fixture-key.pem'),
    cert: readFileSync('/fixture-tls/fixture-cert.pem'),
  },
  (req, res) => {
    lastSni = req.socket.servername
    if (req.url === '/downgrade') {
      res.writeHead(302, { Location: 'http://fixture.test:8080/' })
      res.end()
    } else res.end(content)
  }
)
await new Promise(resolve => tlsServer.listen(8443, '11.198.0.2', resolve))
const upstream = http.createServer((req, res) => {
  if (req.url === '/upgrade') {
    res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'fixture' })
    res.end()
    return
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: 'http://127.0.0.1:8081/trap' })
    res.end()
    return
  }
  if (req.url === '/oversize') {
    res.writeHead(200)
    res.end('x'.repeat(1024 * 1024 + 1))
    return
  }
  if (req.url === '/compressed') {
    res.writeHead(200, { 'Content-Encoding': 'gzip' })
    res.end(gzipSync('x'.repeat(1024 * 1024 + 1)))
    return
  }
  if (req.url === '/slow') {
    res.writeHead(200)
    slowActive++
    res.write('first')
    onSlowStarted()
    // Intentionally active hostile upstream, not a test readiness sleep.
    const interval = setInterval(() => res.write('x'), 50)
    res.on('close', () => {
      clearInterval(interval)
      slowClosed++
      slowActive--
    })
    return
  }
  res.end(content)
})
const ipv6 = http.createServer((_req, res) => res.end(content))
await new Promise(r => ipv6.listen(8080, '2606:4700::198', r))
const trap = http.createServer((_req, res) => {
  trapHits++
  res.end('must-not-be-read')
})
for (const server of [upstream, trap, tlsServer, ipv6])
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
await Promise.all([
  new Promise(r => upstream.listen(8080, '11.198.0.2', r)),
  new Promise(r => trap.listen(8081, '127.0.0.1', r)),
])
const child = spawn(process.execPath, ['/app/dist/index.js'], { stdio: ['ignore', 'pipe', 'pipe'] })
const client = new Client({ name: 'issue198-network', version: '1.0' })
after(async () => {
  await client.close()
  child.kill()
  for (const socket of sockets) socket.destroy()
  upstream.close()
  trap.close()
  ipv6.close()
  tlsServer.close()
  dns.close()
})
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('startup timeout')), 10000)
  child.once('exit', () => {
    clearTimeout(timeout)
    reject(new Error('server exited'))
  })
  child.stdout.on('data', data => {
    if (data.toString().includes('listening on port')) {
      clearTimeout(timeout)
      resolve()
    }
  })
})
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp'))
await client.connect(transport)
const call = url =>
  client.callTool({ name: 'fetch_page', arguments: { url } }, undefined, { timeout: 25000 })
const errorCode = result => {
  assert.equal(result.isError, true)
  return result.content[0].text
}
test('real DNS pins a single answer and rejects mixed public/private records', async () => {
  assert.notEqual((await call('http://rebind.test:8080/')).isError, true)
  assert.equal(dns.queries.get('rebind.test:1'), 1)
  assert.equal(errorCode(await call('http://mixed.test:8080/')), 'destination_blocked')
})
test('TLS validates original host and SNI, and blocks downgrade', async () => {
  assert.notEqual((await call('https://fixture.test:8443/')).isError, true)
  assert.equal(lastSni, 'fixture.test')
  assert.equal(errorCode(await call('https://wrong.test:8443/')), 'upstream_failure')
  assert.equal(errorCode(await call('https://fixture.test:8443/downgrade')), 'destination_blocked')
})
test('the real connector is listed and returns the real fixture content', async () => {
  assert.ok((await client.listTools()).tools.some(t => t.name === 'fetch_page'))
  const result = await call('http://11.198.0.2:8080/')
  assert.notEqual(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0].text), {
    title: 'Network fixture',
    content: 'Network fixture issue198-real-result',
  })
})
test('direct and redirected private requests never touch the trap', async () => {
  assert.equal(errorCode(await call('http://127.0.0.1:8081/trap')), 'destination_blocked')
  assert.equal(errorCode(await call('http://11.198.0.2:8080/redirect')), 'destination_blocked')
  assert.equal(trapHits, 0)
})
test('chunked and compressed bodies cannot bypass the byte limit', async () => {
  for (const path of ['/oversize', '/compressed'])
    assert.equal(errorCode(await call('http://11.198.0.2:8080' + path)), 'response_too_large')
})
test(
  'real deadline covers an active body; subsequent request succeeds',
  { timeout: 22000 },
  async () => {
    const start = performance.now()
    assert.equal(errorCode(await call('http://11.198.0.2:8080/slow')), 'deadline_exceeded')
    assert.ok(performance.now() - start < 19000)
    // Poll an observable cleanup signal, bounded by the test runner deadline.
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll)
        reject(new Error('upstream socket not closed'))
      }, 1000)
      const poll = setInterval(() => {
        if (slowClosed) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })
    assert.notEqual((await call('http://11.198.0.2:8080/')).isError, true)
  }
)

test(
  'an unsupported protocol switch settles without waiting for the deadline',
  { timeout: 4000 },
  async () => {
    const result = await client.callTool(
      { name: 'fetch_page', arguments: { url: 'http://11.198.0.2:8080/upgrade' } },
      undefined,
      { timeout: 2000 }
    )
    assert.equal(errorCode(result), 'upstream_failure')
  }
)

test(
  'HTTP disconnect cancels upstream without an MCP cancellation notification',
  { timeout: 4000 },
  async () => {
    const started = Promise.withResolvers()
    onSlowStarted = () => started.resolve()
    const prior = slowClosed
    const controller = new AbortController()
    const response = await fetch('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': transport.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'disconnect',
        method: 'tools/call',
        params: { name: 'fetch_page', arguments: { url: 'http://11.198.0.2:8080/slow' } },
      }),
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    await started.promise
    controller.abort()
    await new Promise((resolve, reject) => {
      const limit = setTimeout(() => {
        clearInterval(poll)
        reject(new Error('upstream retained after disconnect'))
      }, 1000)
      const poll = setInterval(() => {
        if (slowClosed > prior) {
          clearInterval(poll)
          clearTimeout(limit)
          resolve()
        }
      }, 10)
    })
    onSlowStarted = () => {}
  }
)

test('a public IPv6 literal reaches the real isolated server', async () => {
  assert.notEqual((await call('http://[2606:4700::198]:8080/')).isError, true)
})

test(
  'concurrency spans sessions and cancellation affects only its own request',
  { timeout: 6000 },
  async () => {
    const peer = new Client({ name: 'issue198-peer', version: '1.0' })
    await peer.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')))
    const started = Promise.withResolvers()
    onSlowStarted = () => {
      if (slowActive === 4) started.resolve()
    }
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const pending = controllers.map(controller =>
      client
        .callTool(
          { name: 'fetch_page', arguments: { url: 'http://11.198.0.2:8080/slow' } },
          undefined,
          { signal: controller.signal, timeout: 5000 }
        )
        .catch(error => error)
    )
    try {
      await started.promise
      assert.equal(
        errorCode(
          await peer.callTool({ name: 'fetch_page', arguments: { url: 'http://11.198.0.2:8080/' } })
        ),
        'busy'
      )
      controllers[0].abort()
      await pending[0]
      await new Promise((resolve, reject) => {
        const limit = setTimeout(() => {
          clearInterval(poll)
          reject(new Error('cancelled request retained a slot'))
        }, 1000)
        const poll = setInterval(() => {
          if (slowActive === 3) {
            clearInterval(poll)
            clearTimeout(limit)
            resolve()
          }
        }, 10)
      })
      assert.notEqual(
        (await peer.callTool({ name: 'fetch_page', arguments: { url: 'http://11.198.0.2:8080/' } }))
          .isError,
        true
      )
      assert.equal(slowActive, 3)
    } finally {
      onSlowStarted = () => {}
      for (const controller of controllers) controller.abort()
      await Promise.all(pending)
      await peer.close()
    }
  }
)
