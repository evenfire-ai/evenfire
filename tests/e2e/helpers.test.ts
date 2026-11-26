import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MCP_HOST_URL,
  RPC_PROXY_URL,
  fetchJson,
  getHostActivity,
  getStatus,
  readTaskProgressStream,
  sendMessage,
  waitForAgentState,
  waitForIdle,
  waitForTasksProcessed,
} from './helpers.js'

const HOST_REF = process.env.E2E_HOST_REF ?? 'chatllm'
const RPC_HOST_BASE = `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(HOST_REF)}`

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

function recordedCall(fetchMock: ReturnType<typeof vi.fn>, index = 0): [string, Headers] {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit | undefined]
  return [url, new Headers(init?.headers)]
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mcp-host E2E helper integrity', () => {
  it('preserves explicit message and edge-request correlation on async admission', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, status: 'pending', taskId: 'task-correlation' })
      )
    vi.stubGlobal('fetch', fetchMock)

    await sendMessage('correlated payload', {
      async: true,
      messageId: 'message-correlation',
      requestId: 'request-correlation',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/v1\/runtime\/messages\?async=true$/)
    expect(JSON.parse(String(init.body))).toMatchObject({
      content: 'correlated payload',
      messageId: 'message-correlation',
    })
    expect(new Headers(init.headers).get('x-clerum-edge-request-id')).toBe('request-correlation')
  })

  it('does not treat pre-existing idle as completion without a counter advance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ agent: { state: 'idle', tasksProcessed: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ agent: { state: 'idle', tasksProcessed: 8 } }))
    vi.stubGlobal('fetch', fetchMock)

    const status = await waitForTasksProcessed('rpc-token', 8, 1_000, 0)

    expect(status.agent.tasksProcessed).toBe(8)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (let index = 0; index < 2; index++) {
      const [url, headers] = recordedCall(fetchMock, index)
      expect(url).toBe(`${RPC_HOST_BASE}/status`)
      expect(headers.get('authorization')).toBe('Bearer rpc-token')
    }
  })
})

describe('mcp-host E2E helpers never speak to the Host as rpc-proxy', () => {
  it.each(['status', 'activity', 'sessions'])(
    'fetchJson on the Host %s URL sends the channel caller, not rpc-proxy',
    async route => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'refused' }))
      vi.stubGlobal('fetch', fetchMock)
      const hostUrl = `${MCP_HOST_URL}/v1/runtime/${route}`

      await fetchJson(hostUrl)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, headers] = recordedCall(fetchMock)
      expect(url).toBe(hostUrl)
      expect(headers.get('x-clerum-edge-caller')).toBe('channel-reader')
      expect(headers.get('x-clerum-edge-caller')).not.toBe('rpc-proxy')
      expect(headers.has('x-clerum-edge-user-id')).toBe(false)
      expect(headers.has('x-clerum-edge-team-id')).toBe(false)
    }
  )

  it('getStatus reads the Host status through rpc-proxy with the bearer token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ agent: { state: 'idle' }, queue: { pending: 0 } }))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getStatus('rpc-token')

    expect(status.agent.state).toBe('idle')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, headers] = recordedCall(fetchMock)
    expect(url).toBe(`${RPC_HOST_BASE}/status`)
    expect(headers.get('authorization')).toBe('Bearer rpc-token')
    expect(headers.has('x-clerum-edge-caller')).toBe(false)
  })

  it('waitForIdle and waitForAgentState poll the rpc-proxy status route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ agent: { state: 'idle' } }))
      .mockResolvedValueOnce(jsonResponse({ agent: { state: 'waiting_approval' } }))
    vi.stubGlobal('fetch', fetchMock)

    await waitForIdle('idle-token', 1_000)
    await waitForAgentState('state-token', 'waiting_approval', 1_000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [idleUrl, idleHeaders] = recordedCall(fetchMock, 0)
    const [stateUrl, stateHeaders] = recordedCall(fetchMock, 1)
    expect(idleUrl).toBe(`${RPC_HOST_BASE}/status`)
    expect(idleHeaders.get('authorization')).toBe('Bearer idle-token')
    expect(stateUrl).toBe(`${RPC_HOST_BASE}/status`)
    expect(stateHeaders.get('authorization')).toBe('Bearer state-token')
  })

  it('getHostActivity reads the activity snapshot through rpc-proxy with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await getHostActivity('rpc-token', { limit: 50, sinceEventId: 'evt-1' })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, headers] = recordedCall(fetchMock)
    expect(url).toBe(`${RPC_HOST_BASE}/activity?limit=50&sinceEventId=evt-1`)
    expect(headers.get('authorization')).toBe('Bearer rpc-token')
    expect(headers.has('x-clerum-edge-caller')).toBe(false)
  })
})

describe('readTaskProgressStream', () => {
  const edge = {
    caller: 'channel-reader' as const,
    channelType: 'telegram',
    channelId: 'group-1',
    sender: 'user-1',
  }

  it('hands every suspended event to the caller in order and resolves on terminal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        sseEvent('waiting', { taskId: 'task-1' }),
        sseEvent('open', { taskId: 'task-1' }),
        ': keepalive\n\n',
        sseEvent('suspended', { taskId: 'task-1', requestId: 'req-1' }),
        // One event split across two chunks.
        'event: suspended\ndata: {"taskId":"task-1",',
        '"requestId":"req-2"}\n\n',
        sseEvent('terminal', { taskId: 'task-1', status: 'completed', reason: 'done' }),
      ])
    )
    vi.stubGlobal('fetch', fetchMock)
    const requestIds: string[] = []

    const terminal = await readTaskProgressStream('task-1', edge, event => {
      if (event.type === 'suspended') requestIds.push(event.data.requestId)
    })

    expect(terminal).toMatchObject({ status: 'completed' })
    expect(requestIds).toEqual(['req-1', 'req-2'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, headers] = recordedCall(fetchMock)
    expect(url).toBe(`${MCP_HOST_URL}/v1/runtime/tasks/task-1/progress/stream`)
    expect(headers.get('x-clerum-edge-caller')).toBe('channel-reader')
    expect(headers.get('x-clerum-edge-channel-type')).toBe('telegram')
    expect(headers.get('x-clerum-edge-channel-id')).toBe('group-1')
    expect(headers.get('x-clerum-edge-sender')).toBe('user-1')
  })

  it('throws when the stream ends before its terminal event', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse([sseEvent('open', { taskId: 'task-2' })]))
    )

    await expect(
      readTaskProgressStream('task-2', edge, event => {
        seen.push(event.type)
      })
    ).rejects.toThrow('ended before its terminal event')
    expect(seen).toEqual(['open'])
  })

  it('throws on the Host error event without handing it to the caller', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            sseEvent('waiting', { taskId: 'task-3' }),
            sseEvent('error', { message: 'task_not_found_or_expired' }),
          ])
        )
    )

    await expect(
      readTaskProgressStream('task-3', edge, event => {
        seen.push(event.type)
      })
    ).rejects.toThrow('task_not_found_or_expired')
    expect(seen).toEqual(['waiting'])
  })
})
