import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpClient } from '../../mcp/client'

const sdkState = vi.hoisted(() => ({
  closeCalls: [] as unknown[][],
  closeQueue: [] as Array<() => unknown>,
  connectCalls: [] as unknown[][],
  connectQueue: [] as Array<() => unknown>,
  callToolCalls: [] as unknown[][],
  callToolQueue: [] as Array<() => unknown>,
  listToolsCalls: [] as unknown[][],
  listToolsQueue: [] as Array<() => unknown>,
  requestCalls: [] as unknown[][],
  requestQueue: [] as Array<() => unknown>,
  transportCloseCalls: [] as unknown[][],
  transportCloseQueue: [] as Array<() => unknown>,
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
      const next = sdkState.closeQueue.shift()
      if (next) return next()
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
    async close(...args: unknown[]) {
      sdkState.transportCloseCalls.push([this, ...args])
      const next = sdkState.transportCloseQueue.shift()
      if (next) return next()
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    async close(...args: unknown[]) {
      sdkState.transportCloseCalls.push([this, ...args])
      const next = sdkState.transportCloseQueue.shift()
      if (next) return next()
    }
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

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function retirePermanently(client: McpClient): Promise<void> {
  const cleanup = client.retire()
  return cleanup()
}

describe('McpClient SDK request timeouts', () => {
  beforeEach(() => {
    sdkState.closeCalls.length = 0
    sdkState.closeQueue.length = 0
    sdkState.connectCalls.length = 0
    sdkState.connectQueue.length = 0
    sdkState.callToolCalls.length = 0
    sdkState.callToolQueue.length = 0
    sdkState.listToolsCalls.length = 0
    sdkState.listToolsQueue.length = 0
    sdkState.requestCalls.length = 0
    sdkState.requestQueue.length = 0
    sdkState.transportCloseCalls.length = 0
    sdkState.transportCloseQueue.length = 0
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

  it('preserves the caller budget for retry while shared recovery uses its lifecycle budget', async () => {
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
    expect(sdkState.listToolsCalls[1][1]).toEqual(expect.objectContaining({ timeout: 3_600_000 }))
  })

  it('lets a slower peer adopt the completed recovery of their shared session', async () => {
    vi.useFakeTimers()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'first-after-reconnect' }] }),
      () => ({ content: [{ type: 'text', text: 'second-after-reconnect' }] })
    )
    const c = client()
    await c.connect()

    const first = c.callTool('read', { id: 1 }, { timeoutMs: 30_000 })
    await vi.advanceTimersByTimeAsync(500)
    const second = c.callTool('read', { id: 2 }, { timeoutMs: 30_000 })
    const settled = Promise.allSettled([first, second])
    await vi.advanceTimersByTimeAsync(500)

    // The first call has already completed the one shared reconnect while the
    // slower peer is still inside its independently budgeted retry delay.
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(500)

    await expect(settled).resolves.toEqual([
      {
        status: 'fulfilled',
        value: { content: [{ type: 'text', text: 'first-after-reconnect' }] },
      },
      {
        status: 'fulfilled',
        value: { content: [{ type: 'text', text: 'second-after-reconnect' }] },
      },
    ])
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(4)
  })

  it('retries a session error that arrives after a peer has recovered their source', async () => {
    vi.useFakeTimers()
    const lateSessionError = deferred<unknown>()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => lateSessionError.promise,
      () => ({ content: [{ type: 'text', text: 'first-after-reconnect' }] }),
      () => ({ content: [{ type: 'text', text: 'late-after-reconnect' }] })
    )
    const c = client()
    await c.connect()

    const settled = Promise.allSettled([
      c.callTool('read', { id: 1 }, { timeoutMs: 30_000 }),
      c.callTool('read', { id: 2 }, { timeoutMs: 30_000 }),
    ])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(3)

    lateSessionError.reject(Object.assign(new Error('session not found'), { code: -32003 }))
    await vi.advanceTimersByTimeAsync(1000)

    await expect(settled).resolves.toEqual([
      {
        status: 'fulfilled',
        value: { content: [{ type: 'text', text: 'first-after-reconnect' }] },
      },
      {
        status: 'fulfilled',
        value: { content: [{ type: 'text', text: 'late-after-reconnect' }] },
      },
    ])
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(4)
  })

  it('fails all shared recovery waiters closed when the client is retired', async () => {
    vi.useFakeTimers()
    const reconnectHandshake = deferred()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'must-not-run' }] }),
      () => ({ content: [{ type: 'text', text: 'must-not-run' }] })
    )
    const c = client()
    await c.connect()
    sdkState.connectQueue.push(() => reconnectHandshake.promise)

    const settled = Promise.allSettled([
      c.callTool('write', { id: 1 }, { timeoutMs: 30_000 }),
      c.callTool('write', { id: 2 }, { timeoutMs: 30_000 }),
    ])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sdkState.connectCalls).toHaveLength(2)

    const closing = retirePermanently(c)
    reconnectHandshake.resolve()
    await closing
    await vi.advanceTimersByTimeAsync(0)

    await expect(settled).resolves.toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringMatching(/closed|superseded/) }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringMatching(/closed|superseded/) }),
      },
    ])
    expect(sdkState.callToolCalls).toHaveLength(2)
    expect(c.isConnected).toBe(false)
  })

  it('keeps shared recovery alive when its first caller exhausts a shorter budget', async () => {
    vi.useFakeTimers()
    const reconnectHandshake = deferred()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'long-budget-peer-recovered' }] })
    )
    const c = client()
    await c.connect()
    sdkState.connectQueue.push(() => reconnectHandshake.promise)

    const shortBudget = c.callTool('read', { id: 1 }, { timeoutMs: 1_500 })
    const shortAssertion = expect(shortBudget).rejects.toThrow('step-timeout')
    const longBudget = c.callTool('read', { id: 2 }, { timeoutMs: 30_000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sdkState.connectCalls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(500)
    await shortAssertion
    expect(sdkState.callToolCalls).toHaveLength(2)

    reconnectHandshake.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await expect(longBudget).resolves.toEqual({
      content: [{ type: 'text', text: 'long-budget-peer-recovered' }],
    })
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(3)
  })

  it('lets an aborted peer leave shared recovery without cancelling it for another caller', async () => {
    vi.useFakeTimers()
    const reconnectHandshake = deferred()
    const peerController = new AbortController()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'leader-recovered' }] })
    )
    const c = client()
    await c.connect()
    sdkState.connectQueue.push(() => reconnectHandshake.promise)

    const leader = c.callTool('read', { id: 1 }, { timeoutMs: 30_000 })
    const peer = c.callTool('read', { id: 2 }, { timeoutMs: 30_000, signal: peerController.signal })
    const peerAssertion = expect(peer).rejects.toThrow('peer-aborted')
    await vi.advanceTimersByTimeAsync(1000)
    expect(sdkState.connectCalls).toHaveLength(2)

    peerController.abort('peer-aborted')
    await peerAssertion
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(2)

    reconnectHandshake.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await expect(leader).resolves.toEqual({
      content: [{ type: 'text', text: 'leader-recovered' }],
    })
    expect(sdkState.connectCalls).toHaveLength(2)
    expect(sdkState.callToolCalls).toHaveLength(3)
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

  it('does not start reconnect after the caller aborts during the retry delay', async () => {
    vi.useFakeTimers()
    sdkState.callToolQueue.push(() => {
      throw Object.assign(new Error('session not found'), { code: -32003 })
    })
    const controller = new AbortController()
    const c = client()
    await c.connect()

    const pending = c.callTool(
      'write',
      { value: 'side-effect' },
      { timeoutMs: 30_000, signal: controller.signal }
    )
    const assertion = expect(pending).rejects.toThrow('caller-aborted')
    await vi.advanceTimersByTimeAsync(500)
    controller.abort('caller-aborted')
    await vi.advanceTimersByTimeAsync(500)

    await assertion
    expect(sdkState.connectCalls).toHaveLength(1)
    expect(sdkState.transportCloseCalls).toHaveLength(0)
    expect(sdkState.callToolCalls).toHaveLength(1)
    expect(c.isConnected).toBe(true)
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
    expect(sdkState.transportCloseCalls).toHaveLength(1)
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
    expect(sdkState.transportCloseCalls).toHaveLength(1)
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
    expect(sdkState.transportCloseCalls).toHaveLength(1)
  })

  it('detaches immediately and closes the owned transport when SDK protocol close hangs', async () => {
    const releaseClose = deferred()
    sdkState.transportCloseQueue.push(() => releaseClose.promise)
    const c = client()
    await c.connect()

    const disconnecting = c.disconnect()
    await Promise.resolve()

    expect(c.isConnected).toBe(false)
    expect(c.availableTools).toEqual([])
    expect(sdkState.closeCalls).toHaveLength(0)
    expect(sdkState.transportCloseCalls).toHaveLength(1)

    releaseClose.resolve()
    await expect(disconnecting).resolves.toBeUndefined()
  })

  it('does not reconnect or replay a tool after permanent close during the retry delay', async () => {
    vi.useFakeTimers()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'must-not-run' }] })
    )
    const c = client()
    await c.connect()

    const pending = c.callTool('write', { value: 'side-effect' }, { timeoutMs: 30_000 })
    const assertion = expect(pending).rejects.toThrow(/closed/)
    await vi.advanceTimersByTimeAsync(0)
    await retirePermanently(c)
    await vi.advanceTimersByTimeAsync(1000)

    await assertion
    expect(sdkState.connectCalls).toHaveLength(1)
    expect(sdkState.callToolCalls).toHaveLength(1)
    expect(c.isConnected).toBe(false)
  })

  it('discards a successful tool result that arrives after permanent close', async () => {
    let resolveCall!: (value: unknown) => void
    const callResult = new Promise<unknown>(resolve => {
      resolveCall = resolve
    })
    sdkState.callToolQueue.push(() => callResult)
    const c = client()
    await c.connect()

    const pending = c.callTool('write', { value: 'side-effect' })
    const assertion = expect(pending).rejects.toThrow(/closed/)
    await vi.waitFor(() => expect(sdkState.callToolCalls).toHaveLength(1))
    await retirePermanently(c)
    resolveCall({ content: [{ type: 'text', text: 'late-success' }] })

    await assertion
    expect(sdkState.connectCalls).toHaveLength(1)
    expect(sdkState.callToolCalls).toHaveLength(1)
    expect(c.isConnected).toBe(false)
  })

  it('starts transport close synchronously when permanently retired', async () => {
    const c = client()
    await c.connect()

    const cleanup = c.retire()

    expect(c.isConnected).toBe(false)
    expect(sdkState.transportCloseCalls).toHaveLength(1)
    await cleanup()
    expect(sdkState.transportCloseCalls).toHaveLength(1)
  })

  it('discards a retry result that arrives after permanent close', async () => {
    vi.useFakeTimers()
    const retryResult = deferred<unknown>()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => retryResult.promise
    )
    const c = client()
    await c.connect()

    const pending = c.callTool('write', { value: 'side-effect' }, { timeoutMs: 30_000 })
    const assertion = expect(pending).rejects.toThrow(/closed/)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(sdkState.callToolCalls).toHaveLength(2))

    await retirePermanently(c)
    retryResult.resolve({ content: [{ type: 'text', text: 'late-retry-success' }] })

    await assertion
    expect(sdkState.callToolCalls).toHaveLength(2)
    expect(c.isConnected).toBe(false)
  })

  it('invalidates a reconnect handshake when permanent close arrives in flight', async () => {
    vi.useFakeTimers()
    const reconnectHandshake = deferred()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => ({ content: [{ type: 'text', text: 'must-not-run' }] })
    )
    const c = client()
    await c.connect()
    sdkState.connectQueue.push(() => reconnectHandshake.promise)

    const pending = c.callTool('write', { value: 'side-effect' }, { timeoutMs: 30_000 })
    const assertion = expect(pending).rejects.toThrow(/closed|superseded/)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sdkState.connectCalls).toHaveLength(2)

    const closing = retirePermanently(c)
    reconnectHandshake.resolve()
    await closing
    await vi.advanceTimersByTimeAsync(0)

    await assertion
    expect(sdkState.callToolCalls).toHaveLength(1)
    expect(c.isConnected).toBe(false)
    expect(sdkState.transportCloseCalls).toHaveLength(2)
    expect(new Set(sdkState.transportCloseCalls.map(([transport]) => transport)).size).toBe(2)
  })

  it('rejects all recovery waiters promptly when retired while reconnect never settles', async () => {
    vi.useFakeTimers()
    const reconnectHandshake = deferred()
    sdkState.callToolQueue.push(
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      },
      () => {
        throw Object.assign(new Error('session not found'), { code: -32003 })
      }
    )
    const c = client()
    await c.connect()
    sdkState.connectQueue.push(() => reconnectHandshake.promise)

    const settled = Promise.allSettled([
      c.callTool('write', { id: 1 }, { timeoutMs: 30_000 }),
      c.callTool('write', { id: 2 }, { timeoutMs: 30_000 }),
    ])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sdkState.connectCalls).toHaveLength(2)

    await retirePermanently(c)
    await vi.advanceTimersByTimeAsync(0)

    await expect(settled).resolves.toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringMatching(/closed/) }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringMatching(/closed/) }),
      },
    ])
    expect(sdkState.callToolCalls).toHaveLength(2)
    expect(c.isConnected).toBe(false)
  })

  it('does not publish tools discovered after permanent close', async () => {
    const discovery = deferred<{
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    }>()
    sdkState.listToolsQueue.push(() => discovery.promise)
    const c = client()

    const pending = c.connect()
    await vi.waitFor(() => expect(sdkState.listToolsCalls).toHaveLength(1))
    const closing = retirePermanently(c)
    discovery.resolve({
      tools: [{ name: 'stale-tool', description: 'stale', inputSchema: {} }],
    })

    await closing
    await expect(pending).rejects.toThrow(/closed/)
    expect(c.availableTools).toEqual([])
    expect(c.isConnected).toBe(false)
    expect(sdkState.transportCloseCalls).toHaveLength(1)
  })

  it('does not let an old tools/list failure erase a reconnected tool cache', async () => {
    const c = client()
    await c.connect()

    const staleDiscovery = deferred<{
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    }>()
    sdkState.listToolsQueue.push(
      () => staleDiscovery.promise,
      () => ({
        tools: [{ name: 'fresh-tool', description: 'fresh', inputSchema: {} }],
      })
    )
    const staleRefresh = c.listTools()
    await vi.waitFor(() => expect(sdkState.listToolsCalls).toHaveLength(2))

    await c.reconnect()
    expect(c.availableTools.map(tool => tool.name)).toEqual(['fresh-tool'])

    staleDiscovery.reject(new Error('old tools/list failed'))
    await expect(staleRefresh).rejects.toThrow(/superseded/)
    expect(c.availableTools.map(tool => tool.name)).toEqual(['fresh-tool'])
    expect(c.isConnected).toBe(true)
  })

  it('does not report a successful probe from a permanently closed connection', async () => {
    const c = client()
    await c.connect()
    const staleProbe = deferred<{
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
    }>()
    // probeTools() issues a validated raw `request(tools/list)` (not listTools),
    // so drive the in-flight probe through the request queue.
    sdkState.requestQueue.push(() => staleProbe.promise)

    const probing = c.probeTools()
    await vi.waitFor(() => expect(sdkState.requestCalls).toHaveLength(1))
    const closing = retirePermanently(c)
    staleProbe.resolve({
      tools: [{ name: 'stale-tool', description: 'stale', inputSchema: {} }],
    })

    await closing
    await expect(probing).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/closed/) }),
      stale: true,
    })
  })
})
