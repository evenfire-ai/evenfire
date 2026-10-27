import { describe, expect, it, vi } from 'vitest'
import { fetchHostConnectionFromControlApi } from '../services/controlApiRestService.js'

const USER = '00000000-0000-4000-8000-000000000001'

describe('Control API Host-message resolution transport', () => {
  it('uses the dedicated POST for ordinary and direct-run-bound sends', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        userId: USER,
        hostRef: 'host-a',
        url: 'http://host-a.mcp-host.svc.cluster.local:8080',
        bindingStatus: 'recorded',
      })
    ) as unknown as typeof fetch

    await fetchHostConnectionFromControlApi(USER, 'host-a', 'jwt', {
      messageResolution: true,
      fetchImpl,
    })
    await fetchHostConnectionFromControlApi(USER, 'host-a', 'jwt', {
      messageResolution: true,
      directRunBinding: {
        runId: '00000000-0000-4000-8000-000000000123',
        sessionId: 'session-a',
        origin: 'direct_chat',
      },
      fetchImpl,
    })
    const calls = vi.mocked(fetchImpl).mock.calls
    expect(calls).toHaveLength(2)
    expect(String(calls[0][0])).toMatch(/\/mcp-hosts\/host-a\/message-resolution$/)
    expect(calls[0][1]).toMatchObject({ method: 'POST', body: '{}' })
    expect(calls[1][1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({ sessionId: 'session-a' })
  })

  it.each([429, 503])('treats a %s resolution response as a failed lookup', async status => {
    const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
    await expect(
      fetchHostConnectionFromControlApi(USER, 'host-a', crypto.randomUUID(), {
        messageResolution: true,
        fetchImpl,
      })
    ).rejects.toThrow(`Control API MCP host lookup failed (${status})`)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
