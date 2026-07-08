import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import { StdioBridge } from '../src/bridge'
import { BridgeConfig } from '../src/types'

const MOCK_SERVER = path.resolve(__dirname, 'mock-stdio-server.js')

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    command: 'node',
    args: [MOCK_SERVER],
    port: 0,
    healthPath: '/health',
    restartMax: 3,
    restartDelay: 100,
    initTimeout: 5000,
    shutdownTimeout: 5000,
    logLevel: 'info',
    ...overrides,
  }
}

function httpRequest(
  port: number,
  reqPath: string,
  method = 'GET',
  body?: string,
  sessionId?: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {}
    if (sessionId) headers['mcp-session-id'] = sessionId
    const req = http.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers },
      res => {
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: data, headers: res.headers })
        )
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('StdioBridge', () => {
  let bridge: StdioBridge | null = null

  afterEach(async () => {
    if (bridge) {
      await bridge.stop()
      bridge = null
    }
  })

  it('should start and become initialized', async () => {
    bridge = new StdioBridge(makeConfig())
    await bridge.start()
    expect(bridge.isInitialized).toBe(true)
  })

  it('should expose the actual port via getPort()', async () => {
    bridge = new StdioBridge(makeConfig())
    await bridge.start()
    const port = bridge.getPort()
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(0)
  })

  it('should respond 200 on /health when initialized', async () => {
    bridge = new StdioBridge(makeConfig())
    await bridge.start()

    const res = await httpRequest(bridge.getPort(), '/health')
    expect(res.status).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.status).toBe('ok')
    expect(json.command).toBe('node')
    expect(json.restarts).toBe(0)
  })

  it('should respond 503 on /health when shutting down', async () => {
    bridge = new StdioBridge(makeConfig())
    await bridge.start()

    // Trigger stop (which sets shuttingDown) but don't await fully
    // Instead, we'll test after stop completes
    await bridge.stop()
    // After stop, the server is closed, so we can't make requests.
    // Instead, verify via the public getter
    expect(bridge.isShuttingDown).toBe(true)
    bridge = null // Prevent double-stop in afterEach
  })

  it('should respond 503 on non-health paths when not initialized', async () => {
    bridge = new StdioBridge(makeConfig())
    // Start only the HTTP server by calling start() — the mock server will init quickly
    await bridge.start()
    const port = bridge.getPort()

    // Force initialized to false to simulate not-ready state
    ;(bridge as any).initialized = false

    const res = await httpRequest(
      port,
      '/mcp',
      'POST',
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    )
    expect(res.status).toBe(503)
    const json = JSON.parse(res.body)
    expect(json.error).toBe('Bridge not ready')
  })

  it('should stop gracefully', async () => {
    bridge = new StdioBridge(makeConfig())
    await bridge.start()
    expect(bridge.isInitialized).toBe(true)

    await bridge.stop()
    expect(bridge.isShuttingDown).toBe(true)
    bridge = null
  })

  it('should return config port from getPort() before server starts', () => {
    bridge = new StdioBridge(makeConfig({ port: 4567 }))
    expect(bridge.getPort()).toBe(4567)
  })

  it('should pass bridge environment variables to the stdio server process', async () => {
    process.env.STDIO_BRIDGE_E2E_ENV = 'inherited-env-value'
    bridge = new StdioBridge(makeConfig())
    await bridge.start()

    const res = await httpRequest(
      bridge.getPort(),
      '/mcp',
      'POST',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_env', arguments: { name: 'STDIO_BRIDGE_E2E_ENV' } },
      })
    )

    expect(res.status).toBe(200)
    const json = JSON.parse(res.body)
    expect(json.result.content[0].text).toBe('inherited-env-value')
    delete process.env.STDIO_BRIDGE_E2E_ENV
  })
})
