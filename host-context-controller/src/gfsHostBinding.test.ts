import { describe, expect, it, vi } from 'vitest'
import {
  GFS_HOST_TOKEN_REQUEST_TIMEOUT_CODE,
  GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS,
  GfsHostTokenMintTimeoutError,
  mintHostGfsToken,
} from './gfsHostBinding'

/**
 * P3-S02 — HCC 1st-party host gfs token mint. Every Host shares the sentinel
 * binding mcp-host/standalone; read-only scope in P3; fail-loud on error.
 */

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

describe('mintHostGfsToken', () => {
  it('POSTs to the sentinel provisioner route with the InternalControl bearer and read scope', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ token: 'tok', expiresInSeconds: 300, subject: 'host:1st:mcp-host/standalone' })
    ) as unknown as typeof fetch
    const out = await mintHostGfsToken({
      controlApiBaseUrl: 'http://control-api:8090',
      signToken: () => 'hcc-jwt',
      fetchFn,
    })

    expect(out.subject).toBe('host:1st:mcp-host/standalone')
    expect(out.token).toBe('tok')
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://control-api:8090/api/v1/auth/gfs/standalone/tokens')
    expect(init.headers.Authorization).toBe('Bearer hcc-jwt')
    expect(JSON.parse(init.body)).toEqual({ namespace: 'mcp-host', scopes: ['gfs.read'] })
  })

  it('fails loud on a non-2xx response (never silently degrades)', async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 403 }) as Response
    ) as unknown as typeof fetch
    await expect(
      mintHostGfsToken({ controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn })
    ).rejects.toThrow(/403/)
  })

  it('aborts a hung request and waits for the transport to reject', async () => {
    vi.useFakeTimers()
    try {
      let requestSignal: AbortSignal | undefined
      let rejectRequest: ((reason?: unknown) => void) | undefined
      const fetchFn = vi.fn((_url: unknown, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          rejectRequest = reject
        })
      }) as unknown as typeof fetch

      let settled = false
      const request = mintHostGfsToken({
        controlApiBaseUrl: 'http://control-api:8090',
        signToken: () => 'hcc-jwt',
        fetchFn,
      })
      const outcome = request.then(
        value => {
          settled = true
          return { value, error: undefined }
        },
        error => {
          settled = true
          return { value: undefined, error }
        }
      )

      expect(requestSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS)
      expect(requestSignal?.aborted).toBe(true)
      await Promise.resolve()
      expect(settled).toBe(false)

      const transportError = new Error('request aborted')
      transportError.name = 'AbortError'
      rejectRequest?.(transportError)

      const result = await outcome
      expect(result.error).toBeInstanceOf(GfsHostTokenMintTimeoutError)
      expect(result.error).toMatchObject({
        code: GFS_HOST_TOKEN_REQUEST_TIMEOUT_CODE,
        timeoutMs: GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS,
        cause: transportError,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
