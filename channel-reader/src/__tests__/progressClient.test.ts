import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProgressStream } from '../progressClient'

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

function makeSseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('createProgressStream', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('exports createProgressStream function', () => {
    expect(typeof createProgressStream).toBe('function')
  })

  it('fires onTerminal and closes the stream on a `terminal` event', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeSseResponse([
          `event: terminal\ndata: ${JSON.stringify({ taskId: 't1', status: 'completed', reason: 'natural' })}\n\n`,
        ])
      ) as unknown as typeof fetch

    const onProgress = vi.fn()
    const onSuspended = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()

    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 't1',
      onProgress,
      onSuspended,
      onTerminal,
      onError,
    })

    await waitForCondition(() => onTerminal.mock.calls.length > 0)

    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', status: 'completed' })
    )
    expect(onSuspended).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('opens the progress stream with channel-reader edge context', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSseResponse([
          `event: terminal\ndata: ${JSON.stringify({ taskId: 't-auth', status: 'completed' })}\n\n`,
        ])
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const onTerminal = vi.fn()
    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 't-auth',
      source: { channelType: 'telegram', channelId: '424242', sender: '123456' },
      onProgress: vi.fn(),
      onSuspended: vi.fn(),
      onTerminal,
      onError: vi.fn(),
    })

    await waitForCondition(() => onTerminal.mock.calls.length > 0)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({
      accept: 'text/event-stream',
      'x-clerum-edge-caller': 'channel-reader',
      'x-clerum-edge-host-ref': 'test-host',
      'x-clerum-edge-channel-type': 'telegram',
      'x-clerum-edge-channel-id': '424242',
      'x-clerum-edge-sender': '123456',
    })
  })

  it('does not retry with a runtime token when mcp-host rejects the edge request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onTerminal = vi.fn()
    const onError = vi.fn()
    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 't-retry',
      onProgress: vi.fn(),
      onSuspended: vi.fn(),
      onTerminal,
      onError,
    })

    await waitForCondition(() => onError.mock.calls.length > 0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onTerminal).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Progress stream failed: HTTP 401')
  })

  it('fires onSuspended WITHOUT closing the stream on a `suspended` event', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        `event: suspended\ndata: ${JSON.stringify({
          taskId: 't2',
          requestId: 'r2',
          toolName: 'mcp-x__do',
          displayName: 'Do thing',
          reason: 'approval_required',
        })}\n\n`,
        `event: tool_start\ndata: ${JSON.stringify({
          toolCallId: 'c1',
          toolName: 'mcp-x__do',
          displayName: 'Do thing',
          intentSummary: 'Doing thing',
          iteration: 1,
          stepIndex: 0,
          totalSteps: 1,
        })}\n\n`,
      ])
    ) as unknown as typeof fetch

    const onProgress = vi.fn()
    const onSuspended = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()

    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 't2',
      onProgress,
      onSuspended,
      onTerminal,
      onError,
      debounceMs: 0,
    })

    // After suspended, the stream must keep reading and deliver the
    // subsequent tool_start as a progress update.
    await waitForCondition(
      () => onSuspended.mock.calls.length > 0 && onProgress.mock.calls.length > 0
    )

    expect(onSuspended).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't2', requestId: 'r2', toolName: 'mcp-x__do' })
    )
    expect(onProgress).toHaveBeenCalled()
    expect(onTerminal).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('delivers both suspended events when a task multi-suspends', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        `event: suspended\ndata: ${JSON.stringify({
          taskId: 't3',
          requestId: 'r3a',
          toolName: 'mcp-x__do',
          displayName: 'Do thing',
          reason: 'approval_required',
        })}\n\n`,
        `event: tool_start\ndata: ${JSON.stringify({
          toolCallId: 'c1',
          toolName: 'mcp-x__do',
          displayName: 'Do thing',
          intentSummary: 'Doing thing',
          iteration: 1,
          stepIndex: 0,
          totalSteps: 1,
        })}\n\n`,
        `event: suspended\ndata: ${JSON.stringify({
          taskId: 't3',
          requestId: 'r3b',
          toolName: 'mcp-x__do2',
          displayName: 'Do thing 2',
          reason: 'approval_required',
        })}\n\n`,
      ])
    ) as unknown as typeof fetch

    const onProgress = vi.fn()
    const onSuspended = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()

    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 't3',
      onProgress,
      onSuspended,
      onTerminal,
      onError,
      debounceMs: 0,
    })

    await waitForCondition(() => onSuspended.mock.calls.length >= 2)

    const requestIds = onSuspended.mock.calls.map(c => c[0].requestId)
    expect(requestIds).toEqual(['r3a', 'r3b'])
  })

  it('fires onError when the stream errors', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof fetch

    const onProgress = vi.fn()
    const onSuspended = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()

    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 'terr',
      onProgress,
      onSuspended,
      onTerminal,
      onError,
    })

    await waitForCondition(() => onError.mock.calls.length > 0)

    expect(onError).toHaveBeenCalled()
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('fires onError when mcp-host emits an SSE error event', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        makeSseResponse([
          `event: error\ndata: ${JSON.stringify({ message: 'task_not_found_or_expired' })}\n\n`,
        ])
      ) as unknown as typeof fetch

    const onProgress = vi.fn()
    const onSuspended = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()

    createProgressStream({
      mcpHostUrl: 'http://mcp-host.test',
      taskId: 'terr-sse',
      onProgress,
      onSuspended,
      onTerminal,
      onError,
    })

    await waitForCondition(() => onError.mock.calls.length > 0)

    expect(onError).toHaveBeenCalledWith('task_not_found_or_expired')
    expect(onTerminal).not.toHaveBeenCalled()
  })
})
