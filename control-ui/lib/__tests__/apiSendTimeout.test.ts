import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GFS_UPLOAD_TIMEOUT_MS, apiSend } from '../api'

// apiSend arms an AbortController via window.setTimeout(fn, timeoutMs) inside
// fetchWithTimeout. GFS uploads send the file base64-encoded (~+33% size), so they
// pass a generous per-call timeoutMs to avoid the browser aborting the request
// mid-body on prod (Cloudflare tunnel), which surfaced as "Request timed out".

function jsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ ok: true }),
    text: async () => JSON.stringify({ ok: true }),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('apiSend request timeout', () => {
  it('defaults to the 30s request timeout when no override is given', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    await apiSend('POST', '/api/v1/example', { a: 1 })

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000)
  })

  it('honours a per-call timeoutMs override (used by GFS uploads)', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')

    await apiSend(
      'POST',
      '/api/v1/gfs/proxy/v1/resources/r1/children',
      { name: 'deck.pdf', kind: 'file', contentBase64: 'AAAA' },
      {},
      {},
      { timeoutMs: GFS_UPLOAD_TIMEOUT_MS }
    )

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), GFS_UPLOAD_TIMEOUT_MS)
  })

  it('exposes a GFS upload ceiling well above the 30s default', () => {
    expect(GFS_UPLOAD_TIMEOUT_MS).toBe(300000)
    expect(GFS_UPLOAD_TIMEOUT_MS).toBeGreaterThan(30000)
  })
})
