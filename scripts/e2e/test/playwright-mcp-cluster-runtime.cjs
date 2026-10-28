'use strict'

// Run through `kubectl exec -i` in the deployed MCP container. The fixture
// and MCP transport share that pod's loopback interface; no outside URL or
// credential is needed.
const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const { createServer } = require('node:http')

const requiredTools = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_take_screenshot',
  'browser_evaluate',
]

async function runSmoke(sdk, nodeVersion = process.versions.node) {
  assert.equal(nodeVersion, '24.22.1', 'Unexpected Node version')
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
    response.end(
      "<!doctype html><button onclick=\"document.querySelector('output').textContent='check completed'\">Run check</button><output>waiting</output>"
    )
  })
  const screenshotPath = `/tmp/playwright-cluster-${randomBytes(12).toString('hex')}.png`
  let client
  try {
    await new Promise((resolve, reject) => {
      fixture.once('error', reject)
      fixture.listen(0, '127.0.0.1', resolve)
    })
    client = new sdk.Client({ name: 'playwright-cluster-smoke', version: '1.0.0' })
    client.setRequestHandler(sdk.PingRequestSchema, async () => ({}))
    await client.connect(
      new sdk.StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp')),
      { timeout: 15_000 }
    )
    const tools = new Set((await client.listTools()).tools.map(tool => tool.name))
    for (const name of requiredTools) assert.ok(tools.has(name), `Missing ${name}`)

    const text = result =>
      result.content
        .filter(row => row.type === 'text')
        .map(row => row.text)
        .join('\n')
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 15_000,
      })
      assert.notEqual(result.isError, true, `${name} failed`)
      return result
    }
    await call('browser_navigate', { url: `http://127.0.0.1:${fixture.address().port}/` })
    const before = text(await call('browser_snapshot'))
    assert.match(before, /waiting/)
    const button = /button "Run check" \[ref=([^\]]+)\]/.exec(before)
    assert.ok(button, 'Fixture button is missing')
    await call('browser_click', { element: 'Run check button', ref: button[1] })
    assert.match(text(await call('browser_snapshot')), /check completed/)
    const agent = text(await call('browser_evaluate', { function: '() => navigator.userAgent' }))
    const browserVersion = /(?:HeadlessChrome|Chrome)\/[\d.]+/.exec(agent)
    assert.ok(browserVersion, 'Chromium user agent is missing')
    await call('browser_take_screenshot', { filename: screenshotPath })
    const screenshot = fs.readFileSync(screenshotPath)
    assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    return {
      status: 'PASS',
      nodeVersion,
      browserVersion: browserVersion[0],
      navigation: true,
      realClick: true,
      screenshotBytes: screenshot.length,
      screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
    }
  } finally {
    try {
      await client?.close()
    } finally {
      fixture.closeAllConnections()
      if (fixture.listening) await new Promise(resolve => fixture.close(resolve))
      fs.rmSync(screenshotPath, { force: true })
    }
  }
}

module.exports = { runSmoke }

// `node --input-type=commonjs -` has no require.main, unlike file execution.
if (require.main === module || process.argv[1] === '-') {
  const timeout = setTimeout(() => {
    process.stderr.write('PLAYWRIGHT_MCP_CLUSTER_RUNTIME_FAIL stage=deadline\n')
    process.exit(1)
  }, 90_000)
  ;(async () => {
    const sdk = require('/app/node_modules/playwright-core/lib/mcpBundle')
    return runSmoke(sdk)
  })()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('PLAYWRIGHT_MCP_CLUSTER_RUNTIME_FAIL stage=runtime\n')
      process.exitCode = 1
    })
    .finally(() => clearTimeout(timeout))
}
