/**
 * http_request transport bounds (finding 3, shared `requestPinned`): the tool
 * MUST pass an absolute-deadline `signal` and a `maxBytes` ceiling, so a
 * trickling/flooding server can't hang or OOM the tool. Guards against the
 * wiring being silently dropped (the finding's original root cause).
 */
import { describe, expect, it, vi } from 'vitest'
import { HttpRequestTool } from '../httpRequest'

const requestPinnedSpy = vi.fn((_opts: unknown) => Promise.resolve({ statusCode: 200, body: 'ok' }))

vi.mock('../../net/ssrf', () => ({
  requestPinned: (opts: unknown) => requestPinnedSpy(opts),
  resolvePinnedPublicIp: vi.fn(async () => '93.184.216.34'), // public IP → guard passes
  isPrivateIp: () => false,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}))

describe('http_request transport bounds (finding 3)', () => {
  it('passes an absolute-deadline signal + byte cap to requestPinned', async () => {
    const tool = new HttpRequestTool(['example.com'])
    const res = await tool.execute({ url: 'https://example.com/' })

    expect(res.is_error).toBe(false)
    expect(requestPinnedSpy).toHaveBeenCalledTimes(1)
    const opts = requestPinnedSpy.mock.calls[0][0] as {
      signal?: unknown
      maxBytes?: number
      timeoutMs?: number
    }
    expect(opts.signal).toBeInstanceOf(AbortSignal) // absolute deadline (not socket-idle)
    expect(typeof opts.maxBytes).toBe('number')
    expect(opts.maxBytes as number).toBeGreaterThan(50000) // above the display-truncation threshold
    expect(opts.timeoutMs).toBe(30000)
  })
})
