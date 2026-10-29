import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { runSmoke } = require('./playwright-mcp-cluster-runtime.cjs')

function fakeSdk({ missing, failing, unchanged, invalidPng } = {}) {
  const calls = []
  let screenshotPath
  let closed = false
  let clicked = false
  class Client {
    setRequestHandler() {}
    async connect(transport) {
      assert.equal(transport.url.href, 'http://127.0.0.1:8931/mcp')
    }
    async listTools() {
      return {
        tools: [
          'browser_navigate',
          'browser_snapshot',
          'browser_click',
          'browser_take_screenshot',
          'browser_evaluate',
        ]
          .filter(name => name !== missing)
          .map(name => ({ name })),
      }
    }
    async callTool({ name, arguments: args }) {
      calls.push(name)
      if (name === failing) return { isError: true, content: [] }
      if (name === 'browser_navigate') {
        const url = new URL(args.url)
        assert.equal(url.hostname, '127.0.0.1')
        const page = await fetch(url)
        assert.match(await page.text(), /Run check/)
      }
      if (name === 'browser_click') clicked = !unchanged
      if (name === 'browser_take_screenshot') {
        screenshotPath = args.filename
        writeFileSync(
          screenshotPath,
          invalidPng ? Buffer.from('invalid') : Buffer.from('89504e470d0a1a0a00', 'hex')
        )
      }
      const value =
        name === 'browser_snapshot'
          ? clicked
            ? 'check completed'
            : 'waiting\nbutton "Run check" [ref=e1]'
          : name === 'browser_evaluate'
            ? 'HeadlessChrome/146.0.0.0'
            : ''
      return { content: [{ type: 'text', text: value }] }
    }
    async close() {
      closed = true
    }
  }
  class Transport {
    constructor(url) {
      this.url = url
    }
  }
  return {
    sdk: { Client, StreamableHTTPClientTransport: Transport, PingRequestSchema: {} },
    calls,
    get screenshotPath() {
      return screenshotPath
    },
    get closed() {
      return closed
    },
  }
}

test('checks navigation, click and PNG in order and removes its temporary screenshot', async () => {
  const fake = fakeSdk()
  const result = await runSmoke(fake.sdk, '24.22.1')
  assert.equal(result.status, 'PASS')
  assert.equal(result.realClick, true)
  assert.equal(result.browserVersion, 'HeadlessChrome/146.0.0.0')
  assert.match(result.screenshotSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(fake.calls, [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_evaluate',
    'browser_take_screenshot',
  ])
  assert.equal(fake.closed, true)
  assert.equal(existsSync(fake.screenshotPath), false)
})

test('rejects the wrong Node version or a missing tool', async () => {
  const fake = fakeSdk({ missing: 'browser_click' })
  await assert.rejects(runSmoke(fake.sdk, '22.0.0'), /Unexpected Node version/)
  await assert.rejects(runSmoke(fake.sdk, '24.22.1'), /Missing browser_click/)
  assert.deepEqual(fake.calls, [])
  assert.equal(fake.closed, true)
})

test('fails when a tool errors or the click does not change the snapshot', async () => {
  const failing = fakeSdk({ failing: 'browser_navigate' })
  await assert.rejects(runSmoke(failing.sdk, '24.22.1'), /browser_navigate failed/)
  assert.equal(failing.closed, true)
  const unchanged = fakeSdk({ unchanged: true })
  await assert.rejects(runSmoke(unchanged.sdk, '24.22.1'))
  assert.equal(unchanged.calls.includes('browser_take_screenshot'), false)
  assert.equal(unchanged.closed, true)
})

test('rejects an invalid PNG and still removes the screenshot', async () => {
  const fake = fakeSdk({ invalidPng: true })
  await assert.rejects(runSmoke(fake.sdk, '24.22.1'))
  assert.equal(fake.closed, true)
  assert.equal(existsSync(fake.screenshotPath), false)
})
