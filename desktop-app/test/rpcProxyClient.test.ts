import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcProxyClient } from '../src/rpcProxyClient.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRequestJson = vi.fn()

vi.mock('../src/httpClient.js', () => ({
  requestJson: (...args: unknown[]) => mockRequestJson(...args),
  // §4.5-6: the raw-fetch methods wrap their signal with `withTimeout`; the mock
  // passes the (optional) signal through — the stubbed `fetch` ignores it.
  withTimeout: (signal?: AbortSignal) => signal,
  ApiError: class extends Error {
    status: number
    bodyText: string
    constructor(message?: string, status = 0, bodyText = '') {
      super(message)
      this.status = status
      this.bodyText = bodyText
    }
  },
}))

vi.mock('../src/config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://localhost:8094',
    requestTimeoutMs: 5000,
  },
}))

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRequestJson.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RpcProxyClient — health()', () => {
  it('calls GET /health on rpc-proxy base URL', async () => {
    mockRequestJson.mockResolvedValueOnce({ status: 'ok' })

    const client = new RpcProxyClient()
    const result = await client.health()

    expect(mockRequestJson).toHaveBeenCalledWith('GET', 'http://localhost:8094/health')
    expect(result.status).toBe('ok')
  })
})

describe('RpcProxyClient — invokeHostMessage()', () => {
  it('posts to /api/v1/rpc/hosts/:hostRef/messages with message payload', async () => {
    mockRequestJson.mockResolvedValueOnce({ response: 'Done', status: 'completed' })

    const client = new RpcProxyClient()
    const payload = { content: 'Hello agent', messageId: 'm1', channelType: 'telegram' as const }
    await client.invokeHostMessage('rpc-token', 'chatllm', payload)

    const [method, url, opts] = mockRequestJson.mock.calls[0] as [
      string,
      string,
      { token: string; body: unknown },
    ]
    expect(method).toBe('POST')
    expect(url).toContain('chatllm/messages')
    expect(opts.token).toBe('rpc-token')
    expect(opts.body).toEqual(payload)
  })
})

describe('RpcProxyClient — loadSessionMessages()', () => {
  it('throws an exact 404 error for missing sessions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))

    const client = new RpcProxyClient()

    await expect(
      client.loadSessionMessages('rpc-token', 'chatllm', 'agent', 'missing-chat')
    ).rejects.toThrow('Session not found (404)')
  })

  // F5: this is a RUNTIME check that the bridge forwards the recovery fields the
  // renderer reconcile reads (`state`/`activeTaskId`/`pendingApproval`/per-turn
  // `tool_steps`). NOTE: this file is under `test/`, which the project's tsconfig
  // `include` excludes and no `typecheck` script covers, so a TYPE regression would
  // NOT be caught here. The compile-time guard lives in `src/types.ts`
  // (`_RecoveryFields`), enforced by `build:main`.
  it('exposes state/activeTaskId/pendingApproval/tool_steps on the declared type', async () => {
    const body = JSON.stringify({
      agent: 'agent',
      chatId: 'c1',
      state: 'awaiting_approval',
      activeTaskId: 'task-1',
      pendingApproval: { requestId: 'req-1', displayName: 'Run shell' },
      turns: [
        {
          number: 1,
          user_input: 'hi',
          response: 'ok',
          started_at: '2026-06-18T00:00:00Z',
          tool_steps: [{ toolName: 'shell', displayName: 'Run shell', state: 'completed' }],
        },
      ],
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

    const client = new RpcProxyClient()
    const result = await client.loadSessionMessages('rpc-token', 'chatllm', 'agent', 'c1')

    // Type-enforced reads (no `as` cast / re-declaration): these would not compile
    // if the return type omitted the fields.
    const state: 'idle' | 'processing' | 'awaiting_approval' | undefined = result.state
    const activeTaskId: string | undefined = result.activeTaskId
    const approvalName: string | undefined = result.pendingApproval?.displayName
    const firstToolStep = result.turns[0]?.tool_steps?.[0]

    expect(state).toBe('awaiting_approval')
    expect(activeTaskId).toBe('task-1')
    expect(approvalName).toBe('Run shell')
    expect(firstToolStep?.toolName).toBe('shell')
  })
})

describe('RpcProxyClient — getContextBreakdown()', () => {
  it('GETs the context-breakdown endpoint and parses the wire shape', async () => {
    const breakdown = {
      buckets: { messages: 537, systemTools: 306, metaContext: 115, systemPrompt: 17 },
      totalInputTokens: 32_900,
      maxTokens: 100_000,
      fillRatio: 0.329,
      cacheHitRate: 0.82,
      capturedAtTurn: 4,
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ breakdown }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new RpcProxyClient()
    const result = await client.getContextBreakdown('rpc-token', 'chatllm', 'agent', 'c1')

    const calledUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(calledUrl).toBe(
      'http://localhost:8094/api/v1/rpc/hosts/chatllm/sessions/agent/c1/context-breakdown'
    )
    expect(result.breakdown).toEqual(breakdown)
  })

  it('returns { breakdown: null } on the anti-enumeration 404 (no snapshot / not owned)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('session not found', { status: 404 }))
    )

    const client = new RpcProxyClient()
    const result = await client.getContextBreakdown('rpc-token', 'chatllm', 'agent', 'missing')

    expect(result.breakdown).toBeNull()
  })

  it('throws on non-404 error statuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))

    const client = new RpcProxyClient()
    await expect(client.getContextBreakdown('rpc-token', 'chatllm', 'agent', 'c1')).rejects.toThrow(
      'Get context breakdown failed (500)'
    )
  })
})

describe('RpcProxyClient — openTaskProgressStream()', () => {
  it('surfaces `: keepalive` SSE comments as heartbeat events', async () => {
    // A stream that opens, sends a keepalive comment, then a real terminal.
    const body = [
      'event: open\ndata: {"taskId":"t1"}\n\n',
      ': keepalive\n\n',
      'event: done\ndata: {}\n\n',
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const chunk of body) controller.enqueue(enc.encode(chunk))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })))

    const client = new RpcProxyClient()
    const events: string[] = []
    await client.openTaskProgressStream(
      'rpc-token',
      'chatllm',
      't1',
      ({ event }) => events.push(event),
      new AbortController().signal
    )

    // The comment must not be dropped — it arrives as a heartbeat so the
    // renderer's watchdog can reset on it.
    expect(events).toContain('heartbeat')
    expect(events).toEqual(['open', 'heartbeat', 'done'])
  })
})
