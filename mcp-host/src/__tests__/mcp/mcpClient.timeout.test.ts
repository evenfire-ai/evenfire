import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpClient } from '../../mcp/client'

const sdkState = vi.hoisted(() => ({
  closeCalls: [] as unknown[][],
  connectCalls: [] as unknown[][],
  connectQueue: [] as Array<() => unknown>,
  callToolCalls: [] as unknown[][],
  callToolQueue: [] as Array<() => unknown>,
  listToolsCalls: [] as unknown[][],
  listToolsQueue: [] as Array<() => unknown>,
  requestCalls: [] as unknown[][],
  requestQueue: [] as Array<() => unknown>,
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect(...args: unknown[]) {
      sdkState.connectCalls.push(args)
      const next = sdkState.connectQueue.shift()
      if (next) return next()
    }

    async close(...args: unknown[]) {
      sdkState.closeCalls.push(args)
    }

    async listTools(...args: unknown[]) {
      sdkState.listToolsCalls.push(args)
      const next = sdkState.listToolsQueue.shift()
      if (next) return next()
      return { tools: [] }
    }

    async request(...args: unknown[]) {
      sdkState.requestCalls.push(args)
      const next = sdkState.requestQueue.shift()
      if (next) return next()
      return { tools: [] }
    }

    async callTool(...args: unknown[]) {
      sdkState.callToolCalls.push(args)
      const next = sdkState.callToolQueue.shift()
      if (next) return next()
      return { content: [{ type: 'text', text: 'ok' }] }
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

function client(): McpClient {
  return new McpClient({
    name: 'svc',
    contextRef: 'ctx',
    transport: { type: 'streamableHttp', url: 'http://svc/mcp' },
    enabled: true,
    status: { deployed: true, ready: true },
  })
}

describe('McpClient SDK request timeouts', () => {
  beforeEach(() => {
    sdkState.closeCalls.length = 0
    sdkState.connectCalls.length = 0
    sdkState.connectQueue.length = 0
    sdkState.callToolCalls.length = 0
    sdkState.callToolQueue.length = 0
    sdkState.listToolsCalls.length = 0
    sdkState.listToolsQueue.length = 0
    sdkState.requestCalls.length = 0
    sdkState.requestQueue.length = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('passes explicit timeout options to SDK callTool', async () => {
    const c = client()
    await c.connect()

    await c.callTool('read', { id: 1 })

    expect(sdkState.callToolCalls[0]).toEqual([
      { name: 'read', arguments: { id: 1 } },
      undefined,
      expect.objectContaining({ timeout: 3_600_000 }),
    ])
  })

  it('preserves timeout options across reconnect retry', async () => {
    vi.useFakeTimers()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'ok-after-reconnect' }] })
    )
    const c = client()
    await c.connect()

    const pending = c.callTool('read', { id: 1 }, { timeoutMs: 30_000 })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok-after-reconnect' }] })
    expect(sdkState.callToolCalls).toHaveLength(2)
    expect(sdkState.callToolCalls[0][2]).toEqual(expect.objectContaining({ timeout: 30_000 }))
    expect(sdkState.callToolCalls[1][2]).toEqual(expect.objectContaining({ timeout: 29_000 }))
    expect(sdkState.listToolsCalls[1][1]).toEqual(expect.objectContaining({ timeout: 29_000 }))
  })

  it('does not start reconnect retry after the caller budget is exhausted', async () => {
    vi.useFakeTimers()
    sdkState.callToolQueue.push(() => {
      throw Object.assign(new Error('session not found'), { code: -32003 })
    })
    const c = client()
    await c.connect()

    const pending = c.callTool('read', { id: 1 }, { timeoutMs: 500 })
    const assertion = expect(pending).rejects.toThrow('step-timeout')
    await vi.advanceTimersByTimeAsync(500)

    await assertion
    expect(sdkState.callToolCalls).toHaveLength(1)
    expect(sdkState.listToolsCalls).toHaveLength(1)
  })

  it('fails closed for invalid timeout env before SDK tool discovery', async () => {
    vi.stubEnv('CLERUM_MCP_TOOL_TIMEOUT_MS', '0')
    const c = client()

    await expect(c.connect()).rejects.toThrow(
      'CLERUM_MCP_TOOL_TIMEOUT_MS must be a positive safe integer'
    )
    expect(sdkState.listToolsCalls).toHaveLength(0)
    expect(sdkState.callToolCalls).toHaveLength(0)
  })

  it('allows a lower caller budget to override env max/per-call contradiction', async () => {
    vi.stubEnv('CLERUM_MCP_TOOL_TIMEOUT_MS', '3600000')
    vi.stubEnv('CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS', '60000')
    const c = client()
    await c.connect({ timeoutMs: 30_000 })

    await c.callTool('read', {}, { timeoutMs: 30_000 })

    const requestOptions = sdkState.callToolCalls[0][2] as {
      timeout: number
      maxTotalTimeout: number
    }
    expect(requestOptions.timeout).toBeLessThanOrEqual(30_000)
    expect(requestOptions.timeout).toBeGreaterThan(29_000)
    expect(requestOptions.maxTotalTimeout).toBe(requestOptions.timeout)
  })

  it('uses a raw validated SDK request for status probes without calling listTools', async () => {
    const controller = new AbortController()
    const c = client()

    await c.connect({ timeoutMs: 5_000, signal: controller.signal })
    await c.probeTools({ timeoutMs: 3_000, signal: controller.signal })

    expect(sdkState.listToolsCalls[0]).toEqual([
      undefined,
      expect.objectContaining({
        timeout: 5_000,
        maxTotalTimeout: 5_000,
        signal: controller.signal,
      }),
    ])
    expect(sdkState.requestCalls[0]).toEqual([
      { method: 'tools/list', params: undefined },
      expect.anything(),
      expect.objectContaining({
        timeout: 3_000,
        maxTotalTimeout: 3_000,
        signal: controller.signal,
      }),
    ])
    expect(sdkState.listToolsCalls).toHaveLength(1)
  })

  it('fails connect when SDK tool discovery fails', async () => {
    sdkState.listToolsQueue.push(() => {
      throw new Error('tools/list timeout')
    })
    const c = client()

    await expect(c.connect({ timeoutMs: 5_000 })).rejects.toThrow('tools/list timeout')

    expect(c.isConnected).toBe(false)
    expect(sdkState.listToolsCalls[0][1]).toEqual(
      expect.objectContaining({ timeout: 5_000, maxTotalTimeout: 5_000 })
    )
    expect(sdkState.closeCalls).toHaveLength(1)
  })

  it('abandons SDK connect when the caller budget expires during handshake', async () => {
    vi.useFakeTimers()
    sdkState.connectQueue.push(() => new Promise(() => undefined))
    const c = client()

    const pending = c.connect({ timeoutMs: 500 })
    const assertion = expect(pending).rejects.toThrow('step-timeout')
    await vi.advanceTimersByTimeAsync(500)

    await assertion
    expect(c.isConnected).toBe(false)
    expect(sdkState.connectCalls).toHaveLength(1)
    expect(sdkState.listToolsCalls).toHaveLength(0)
    expect(sdkState.closeCalls).toHaveLength(1)
  })

  it('abandons SDK connect when the caller signal aborts during handshake', async () => {
    sdkState.connectQueue.push(() => new Promise(() => undefined))
    const controller = new AbortController()
    const c = client()

    const pending = c.connect({ timeoutMs: 30_000, signal: controller.signal })
    controller.abort('step-timeout')

    await expect(pending).rejects.toThrow('step-timeout')
    expect(c.isConnected).toBe(false)
    expect(sdkState.connectCalls).toHaveLength(1)
    expect(sdkState.listToolsCalls).toHaveLength(0)
    expect(sdkState.closeCalls).toHaveLength(1)
  })
})
