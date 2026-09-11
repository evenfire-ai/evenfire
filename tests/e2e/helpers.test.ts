import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendMessage, waitForTasksProcessed } from './helpers.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
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

    const status = await waitForTasksProcessed(8, 1_000, 0)

    expect(status.agent.tasksProcessed).toBe(8)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
