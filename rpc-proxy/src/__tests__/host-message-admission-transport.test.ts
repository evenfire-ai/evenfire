import { describe, expect, it, vi } from 'vitest'
import {
  ControlApiHostMessageAdmissionError,
  fetchHostConnectionFromControlApi,
} from '../services/controlApiRestService.js'

const USER = '00000000-0000-4000-8000-000000000001'

describe('R44-H1 Control API Host-message admission transport', () => {
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

  it('retains canonical 429 metadata as a typed admission error', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: 'Too Many Requests', retryAfterSeconds: 19 },
        {
          status: 429,
          headers: {
            'Retry-After': '19',
            'X-RateLimit-Limit': '60',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1234567890',
          },
        }
      )
    ) as unknown as typeof fetch
    await expect(
      fetchHostConnectionFromControlApi(USER, 'host-a', 'jwt', {
        messageResolution: true,
        fetchImpl,
      })
    ).rejects.toMatchObject({
      name: 'ControlApiHostMessageAdmissionError',
      status: 429,
      body: { error: 'Too Many Requests', retryAfterSeconds: 19 },
      headers: { 'retry-after': '19', 'x-ratelimit-limit': '60' },
    } satisfies Partial<ControlApiHostMessageAdmissionError>)
  })

  it('retains the typed strict-store 503', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'host_message_admission_unavailable' }, { status: 503 })
    ) as unknown as typeof fetch
    await expect(
      fetchHostConnectionFromControlApi(USER, 'host-a', 'jwt', {
        messageResolution: true,
        fetchImpl,
      })
    ).rejects.toMatchObject({
      status: 503,
      body: { error: 'host_message_admission_unavailable' },
    })
  })
})
