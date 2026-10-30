'use strict'

// Container-only compatibility test. The fixture stays on loopback and needs
// no credentials, external page, host mount or published container image.
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { createServer } = require('node:http')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')
// Reuse the SDK shipped in this pinned upstream image. Its HTTP client handles
// the server's heartbeat and SSE lifecycle; no extra package is installed.
const {
  Client,
  PingRequestSchema,
  StreamableHTTPClientTransport,
} = require('/app/node_modules/playwright-core/lib/mcpBundle')

const outputDir = '/tmp/playwright-runtime-smoke'

async function portReady(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.setTimeout(500)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (ready) return
    await delay(200)
  }
  throw new Error('Playwright MCP did not become ready')
}

async function main() {
  assert.equal(process.versions.node, '24.22.1')
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const mcpVersion = execFileSync(process.execPath, ['/app/cli.js', '--version'], {
    encoding: 'utf8',
  }).trim()
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(
      "<!doctype html><html><head><title>Runtime smoke</title></head><body><button onclick=\"document.querySelector('output').textContent='check completed'\">Run check</button><output>waiting</output></body></html>"
    )
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const server = spawn(
    process.execPath,
    [
      '/app/cli.js',
      '--headless',
      '--browser',
      'chromium',
      '--no-sandbox',
      '--host',
      '127.0.0.1',
      '--port',
      '8931',
      '--allowed-hosts',
      '*',
      '--output-dir',
      outputDir,
    ],
    {
      cwd: '/app',
      stdio: ['ignore', 'ignore', 'inherit'],
    }
  )
  let spawnError
  server.once('error', error => {
    spawnError = error
  })
  const client = new Client({ name: 'runtime-smoke', version: '1.0.0' })
  let serverPings = 0
  client.setRequestHandler(PingRequestSchema, async () => {
    serverPings += 1
    return {}
  })
  const text = result =>
    result.content
      .filter(row => row.type === 'text')
      .map(row => row.text)
      .join('\n')
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 })
    assert.notEqual(result.isError, true, `${name}: ${text(result)}`)
    return result
  }
  try {
    await portReady(8931)
    if (spawnError) throw spawnError
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp')), {
      timeout: 15_000,
    })
    const tools = new Set((await client.listTools()).tools.map(tool => tool.name))
    for (const name of [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_take_screenshot',
      'browser_evaluate',
    ])
      assert.ok(tools.has(name), `Missing real MCP tool: ${name}`)
    await call('browser_navigate', { url: `http://127.0.0.1:${fixture.address().port}` })
    const before = text(await call('browser_snapshot'))
    assert.match(before, /waiting/)
    const button = /button "Run check" \[ref=([^\]]+)\]/.exec(before)
    assert.ok(button, before)
    // The upstream server closes clients that miss its five-second ping
    // deadline. Exercise the same browser session beyond that deadline.
    await delay(6000)
    assert.ok(serverPings >= 2, `Expected recurring server pings, received ${serverPings}`)
    await call('browser_click', { element: 'Run check button', ref: button[1] })
    assert.match(text(await call('browser_snapshot')), /check completed/)
    const agent = text(await call('browser_evaluate', { function: '() => navigator.userAgent' }))
    const browserVersion = /(?:HeadlessChrome|Chrome)\/[\d.]+/.exec(agent)
    assert.ok(browserVersion, agent)
    // This pinned MCP resolves relative filenames against /app. Use the
    // caller-owned test directory while keeping the application read-only.
    await call('browser_take_screenshot', { filename: `${outputDir}/runtime.png` })
    const screenshot = fs.readFileSync(`${outputDir}/runtime.png`)
    assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    console.log(
      JSON.stringify({
        status: 'PASS',
        nodeVersion: process.versions.node,
        mcpVersion,
        browserVersion: browserVersion[0],
        navigation: true,
        realClick: true,
        serverPings,
        sessionSurvivedHeartbeatDeadline: true,
        screenshotBytes: screenshot.length,
        screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
      })
    )
  } finally {
    await client.close()
    server.kill('SIGTERM')
    fixture.closeAllConnections()
    await new Promise(resolve => fixture.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
