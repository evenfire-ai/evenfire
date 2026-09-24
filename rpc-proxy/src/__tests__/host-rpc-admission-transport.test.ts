import { describe, expect, it, vi } from 'vitest'
import {
  ControlApiHostRpcAdmissionError,
  requestHostRpcAdmission,
} from '../services/controlApiRestService.js'

describe('Spec 65 Control API Host-RPC admission transport', () => {
  it('sends only verified identity selectors to the dedicated internal POST', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 })
    ) as unknown as typeof fetch
    await requestHostRpcAdmission('subject-a', 'host-a', 'rpc-token', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(String(url)).toMatch(
      /\/rpc\/access\/users\/subject-a\/mcp-hosts\/host-a\/host-rpc-admission$/
    )
    expect(init).toMatchObject({ method: 'POST' })
    expect(init?.body).toBeUndefined()
  })

  it('preserves canonical 429 body and every rate-limit header', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: 'Too Many Requests', retryAfterSeconds: 17 },
        {
          status: 429,
          headers: {
            'Retry-After': '17',
            'X-RateLimit-Limit': '300',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1900000000',
          },
        }
      )
    ) as unknown as typeof fetch
    await expect(
      requestHostRpcAdmission('subject-a', 'host-a', 'rpc-token', { fetchImpl })
    ).rejects.toMatchObject({
      name: 'ControlApiHostRpcAdmissionError',
      status: 429,
      body: { error: 'Too Many Requests', retryAfterSeconds: 17 },
      headers: {
        'Retry-After': '17',
        'X-RateLimit-Limit': '300',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '1900000000',
      },
    } satisfies Partial<ControlApiHostRpcAdmissionError>)
  })

  it('fails closed with the approved typed 503 for store failure or malformed response', async () => {
    const unavailable = vi.fn(async () =>
      Response.json({ error: 'host_rpc_admission_unavailable' }, { status: 503 })
    ) as unknown as typeof fetch
    await expect(
      requestHostRpcAdmission('subject-a', 'host-a', 'rpc-token', { fetchImpl: unavailable })
    ).rejects.toMatchObject({
      status: 503,
      body: { error: 'host_rpc_admission_unavailable' },
    })

    const malformed = vi.fn(async () =>
      Response.json({ error: 'Too Many Requests', retryAfterSeconds: 0 }, { status: 429 })
    ) as unknown as typeof fetch
    await expect(
      requestHostRpcAdmission('subject-a', 'host-a', 'rpc-token', { fetchImpl: malformed })
    ).rejects.toMatchObject({
      status: 503,
      body: { error: 'host_rpc_admission_unavailable' },
    })
  })
})
