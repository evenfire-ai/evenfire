import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// We do NOT mock httpClient here — approveToolCall/denyToolCall/listArtifacts/downloadArtifact
// use raw `fetch` directly (not requestJson). We mock global fetch instead.

import { RpcProxyClient } from '../src/rpcProxyClient.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../src/config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://localhost:8094',
    requestTimeoutMs: 5000,
  },
}))

// ── Setup ─────────────────────────────────────────────────────────────────────

let client: RpcProxyClient
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  client = new RpcProxyClient()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── Helper ────────────────────────────────────────────────────────────────────

function okResponse(body?: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(body !== undefined ? JSON.stringify(body) : ''),
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Response
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response
}

// ── approveToolCall ───────────────────────────────────────────────────────────

describe('RpcProxyClient — approveToolCall()', () => {
  it('sends POST to /approvals/approve with { taskId, toolCallId }', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())

    await client.approveToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456')

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]

    expect(url).toBe('http://localhost:8094/api/v1/rpc/hosts/chatllm/approvals/approve')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/json',
        authorization: 'Bearer rpc-token',
      })
    )
    expect(JSON.parse(init.body as string)).toEqual({
      taskId: 'task-123',
      toolCallId: 'tc-456',
    })
  })

  it('forwards a shell card action and omits an invalid one', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())
    await client.approveToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456', false, 'command')
    const [, commandInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(commandInit.body as string)).toEqual({
      taskId: 'task-123',
      toolCallId: 'tc-456',
      shellAction: 'command',
    })

    fetchSpy.mockResolvedValueOnce(okResponse())
    await client.approveToolCall(
      'rpc-token',
      'chatllm',
      'task-123',
      'tc-456',
      false,
      'nope' as 'once'
    )
    const [, invalidInit] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(invalidInit.body as string)).toEqual({
      taskId: 'task-123',
      toolCallId: 'tc-456',
    })
  })

  it('sends alwaysApprove when the desktop asks to allowlist the tool', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())

    await client.approveToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456', true)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      taskId: 'task-123',
      toolCallId: 'tc-456',
      alwaysApprove: true,
    })
  })

  it('surfaces a structured failure code from a success:false body', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse({
        success: false,
        code: 'denial_not_saved',
        error: 'The tool call was cancelled, but the denial could not be saved.',
      })
    )

    const result = await client.denyToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456', 'No')

    expect(result).toEqual({
      success: false,
      code: 'denial_not_saved',
      error: 'The tool call was cancelled, but the denial could not be saved.',
    })
  })

  it('URL-encodes hostRef with special characters', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())

    await client.approveToolCall('tok', 'host ref/v2', 't1', 'tc1')

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(encodeURIComponent('host ref/v2'))
  })

  it('throws on non-OK response with status and body', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(403, 'Missing scope: host:approval:write'))

    await expect(
      client.approveToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456')
    ).rejects.toThrow('Approve failed (403): Missing scope: host:approval:write')
  })

  it('throws on empty error body with status code', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(500, ''))

    await expect(
      client.approveToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456')
    ).rejects.toThrow('Approve failed (500):')
  })
})

// ── denyToolCall ──────────────────────────────────────────────────────────────

describe('RpcProxyClient — setApprovalMode()', () => {
  it('PATCHes the approval-mode route with the mode', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse({
        approvalMode: 'allow_all',
        modeCeiling: 'allow_all',
        channelCap: 'allow_all',
        effectiveApprovalMode: 'auto',
      })
    )

    const result = await client.setApprovalMode(
      'rpc-token',
      'chatllm',
      'chatllm',
      'chat-1',
      'allow_all'
    )

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://localhost:8094/api/v1/rpc/hosts/chatllm/sessions/chatllm/chat-1/approval-mode'
    )
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'allow_all' })
    expect(result).toEqual({
      approvalMode: 'allow_all',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
    })
  })

  it('keeps a 404 in the error message for the Host’s missing-session answer', async () => {
    // mcp-host's body for a missing or foreign session (handleSetApprovalModeRoute).
    fetchSpy.mockResolvedValueOnce(
      errorResponse(404, JSON.stringify({ error: 'session not found' }))
    )
    const failure = client.setApprovalMode('rpc-token', 'chatllm', 'chatllm', 'chat-1', 'auto')
    await expect(failure).rejects.toThrow(/^Set approval mode failed \(404\)$/)
    await expect(failure).rejects.toMatchObject({ status: 404 })
  })

  it.each([
    // rpc-proxy's fallback for a route it does not have (app.ts).
    ['a route rpc-proxy lacks', JSON.stringify({ error: 'Not Found' })],
    // rpc-proxy's answer when the Host is gone (wakeAndHold.ts).
    ['a Host that is gone', JSON.stringify({ error: 'Host not found or not accessible' })],
    ['a body that is not JSON', 'missing'],
  ])('does not report a 404 for %s as a missing session', async (_case, body) => {
    fetchSpy.mockResolvedValueOnce(errorResponse(404, body))
    const failure = client.setApprovalMode('rpc-token', 'chatllm', 'chatllm', 'chat-1', 'auto')
    await expect(failure).rejects.toThrow(
      /^Set approval mode failed \(404, not a session answer\)$/
    )
    await expect(failure).rejects.toMatchObject({ status: 404 })
  })
})

describe('RpcProxyClient — approval mode session fields', () => {
  it('keeps shellCard and the five session-read fields', async () => {
    const shellCard = { channelCommandOffered: false, desktopCommandOffered: false }
    const fields = {
      approvalMode: 'auto',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
      shellClassifierAvailable: false,
    }
    fetchSpy.mockResolvedValueOnce(
      okResponse({
        items: [
          {
            agent: 'agent-a',
            chatId: 'chat-a',
            turnCount: 1,
            lastActivityAt: '2026-11-17T00:00:00.000Z',
            ...fields,
            pendingApproval: {
              requestId: 'req-1',
              displayName: 'Shell',
              shellCard,
            },
          },
        ],
      })
    )

    const listed = await client.listSessions('rpc-token', 'host')
    expect(listed.items[0]).toMatchObject({
      ...fields,
      pendingApproval: {
        requestId: 'req-1',
        displayName: 'Shell',
        shellCard,
      },
    })

    fetchSpy.mockResolvedValueOnce(
      okResponse({
        agent: 'agent-a',
        chatId: 'chat-a',
        ...fields,
        pendingApproval: {
          requestId: 'req-1',
          displayName: 'Shell',
          shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
        },
        turns: [],
      })
    )
    const loaded = await client.loadSessionMessages('rpc-token', 'host', 'agent-a', 'chat-a')
    expect(loaded).toMatchObject({
      ...fields,
      pendingApproval: {
        shellCard: { channelCommandOffered: true, desktopCommandOffered: true },
      },
    })
  })

  it('drops a malformed shell card and an unknown mode without dropping the session', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse({
        items: [
          {
            agent: 'agent-a',
            chatId: 'chat-a',
            turnCount: 1,
            lastActivityAt: '2026-11-17T00:00:00.000Z',
            approvalMode: 'yolo',
            pendingApproval: {
              requestId: 'req-1',
              displayName: 'Shell',
              shellCard: { desktopCommandOffered: 'yes' },
            },
          },
        ],
      })
    )

    const listed = await client.listSessions('rpc-token', 'host')
    expect(listed.items[0]?.pendingApproval).toEqual({
      requestId: 'req-1',
      displayName: 'Shell',
    })
    expect(listed.items[0]).not.toHaveProperty('approvalMode')
  })
})

describe('RpcProxyClient — denyToolCall()', () => {
  it('sends POST to /approvals/deny with { taskId, toolCallId, reason }', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())

    await client.denyToolCall('rpc-token', 'chatllm', 'task-123', 'tc-456', 'Too dangerous')

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]

    expect(url).toBe('http://localhost:8094/api/v1/rpc/hosts/chatllm/approvals/deny')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      taskId: 'task-123',
      toolCallId: 'tc-456',
      reason: 'Too dangerous',
    })
  })

  it('includes authorization header', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())

    await client.denyToolCall('my-token', 'chatllm', 't1', 'tc1', 'no')

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer my-token')
  })

  it('throws on 401 unauthorized response', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(401, 'Token expired'))

    await expect(
      client.denyToolCall('expired-tok', 'chatllm', 't1', 'tc1', 'nope')
    ).rejects.toThrow('Deny failed (401): Token expired')
  })

  it('URL-encodes hostRef', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse())

    await client.denyToolCall('tok', 'my host', 't1', 'tc1', 'reason')

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(encodeURIComponent('my host'))
  })
})

// ── listArtifacts ─────────────────────────────────────────────────────────────

describe('RpcProxyClient — listArtifacts()', () => {
  const sampleArtifacts = {
    artifacts: [
      { name: 'report.pdf', format: 'pdf', sizeBytes: 4096, createdAt: '2026-03-27T10:00:00Z' },
      { name: 'data.xlsx', format: 'xlsx', sizeBytes: 8192, createdAt: '2026-03-27T10:01:00Z' },
    ],
  }

  it('calls GET /artifacts with Bearer token and parses response', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse(sampleArtifacts))

    const result = await client.listArtifacts('rpc-token', 'chatllm')

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]

    expect(url).toBe('http://localhost:8094/api/v1/rpc/hosts/chatllm/artifacts')
    expect(init.method).toBeUndefined() // fetch default = GET
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer rpc-token')

    expect(result.artifacts).toHaveLength(2)
    expect(result.artifacts[0]!.name).toBe('report.pdf')
    expect(result.artifacts[0]!.format).toBe('pdf')
    expect(result.artifacts[0]!.sizeBytes).toBe(4096)
    expect(result.artifacts[1]!.name).toBe('data.xlsx')
  })

  it('parses empty artifacts list', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ artifacts: [] }))

    const result = await client.listArtifacts('tok', 'chatllm')

    expect(result.artifacts).toEqual([])
  })

  it('throws on non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(500, 'Internal error'))

    await expect(client.listArtifacts('tok', 'chatllm')).rejects.toThrow(
      'List artifacts failed (500): Internal error'
    )
  })

  it('URL-encodes hostRef', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse({ artifacts: [] }))

    await client.listArtifacts('tok', 'host/ref')

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(encodeURIComponent('host/ref'))
  })
})

// ── downloadArtifact ──────────────────────────────────────────────────────────

describe('RpcProxyClient — downloadArtifact()', () => {
  it('calls GET /artifacts/:filename/download and returns Buffer', async () => {
    const fakeBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // ZIP magic bytes
    const fakeArrayBuffer = fakeBytes.buffer

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(fakeArrayBuffer),
    } as unknown as Response)

    const result = await client.downloadArtifact('rpc-token', 'chatllm', 'report.pdf')

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]

    expect(url).toBe('http://localhost:8094/api/v1/rpc/hosts/chatllm/artifacts/report.pdf/download')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer rpc-token')

    // Result should be a Buffer wrapping the ArrayBuffer
    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result.length).toBe(4)
    expect(result[0]).toBe(0x50)
  })

  it('URL-encodes both hostRef and filename', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Response)

    await client.downloadArtifact('tok', 'my host', 'file name.pdf')

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(encodeURIComponent('my host'))
    expect(url).toContain(encodeURIComponent('file name.pdf'))
  })

  it('throws on non-OK response', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(404, 'Not found'))

    await expect(client.downloadArtifact('tok', 'chatllm', 'missing.pdf')).rejects.toThrow(
      'Download artifact failed (404): Not found'
    )
  })

  it('returns empty buffer for empty file', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Response)

    const result = await client.downloadArtifact('tok', 'chatllm', 'empty.txt')

    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result.length).toBe(0)
  })
})
