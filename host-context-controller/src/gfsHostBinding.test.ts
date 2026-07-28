import { describe, expect, it, vi } from 'vitest'
import {
  GFS_HOST_TOKEN_REQUEST_TIMEOUT_CODE,
  GFS_HOST_TOKEN_REQUEST_TIMEOUT_MS,
  GfsHostTokenMintTimeoutError,
  mintHostGfsToken,
} from './gfsHostBinding'

/**
 * P3-S02 — HCC 1st-party host GFS token mint. Kubernetes namespace/name is the
 * trusted binding: tokens preserve the concrete Host identity and the returned
 * subject must match it exactly.
 */

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function jwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'unverified-signature',
  ].join('.')
}

describe('mintHostGfsToken', () => {
  it.each([
    ['chatllm', 'host:1st:mcp-host/chatllm'],
    ['chatllm-stateless', 'host:1st:mcp-host/chatllm-stateless'],
  ])('mints an independent token for Host %s', async (name, subject) => {
    const token = jwt({ sub: subject, scopes: ['gfs.read', 'gfs.write'] })
    const fetchFn = vi.fn(async () =>
      okResponse({ token, expiresInSeconds: 300, subject })
    ) as unknown as typeof fetch
    const out = await mintHostGfsToken(
      { name, namespace: 'mcp-host' },
      {
        controlApiBaseUrl: 'http://control-api:8090',
        signToken: () => 'hcc-jwt',
        fetchFn,
      }
    )

    expect(out.subject).toBe(subject)
    expect(out.token).toBe(token)
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`http://control-api:8090/api/v1/auth/gfs/${name}/tokens`)
    expect(init.headers.Authorization).toBe('Bearer hcc-jwt')
    expect(JSON.parse(init.body)).toEqual({
      namespace: 'mcp-host',
      scopes: ['gfs.read', 'gfs.write'],
    })
  })

  it.each([
    { token: '', expiresInSeconds: 300, subject: 'host:1st:mcp-host/chatllm' },
    { token: 'tok', subject: 'host:1st:mcp-host/chatllm' },
    { token: 'tok', expiresInSeconds: 300 },
    { token: 'tok', expiresInSeconds: 0, subject: 'host:1st:mcp-host/chatllm' },
  ])('rejects a malformed successful response before returning credentials', async body => {
    const fetchFn = vi.fn(async () => okResponse(body)) as unknown as typeof fetch
    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(/malformed response/)
  })

  it('rejects a subject mismatch', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ token: 'tok', expiresInSeconds: 300, subject: 'host:1st:mcp-host/other' })
    ) as unknown as typeof fetch
    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(/subject mismatch/)
  })

  it('rejects untrusted Kubernetes identity inputs before making a request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    await expect(
      mintHostGfsToken(
        { name: '../chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(/trusted Kubernetes namespace and name/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects the reserved legacy standalone identity before signing or making a request', async () => {
    const signToken = vi.fn(() => 'j')
    const fetchFn = vi.fn() as unknown as typeof fetch

    await expect(
      mintHostGfsToken(
        { name: 'standalone', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken, fetchFn }
      )
    ).rejects.toThrow(/trusted Kubernetes namespace and name/)
    expect(signToken).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails loud on a non-2xx response (never silently degrades)', async () => {
    const fetchFn = vi.fn(
      async () => ({ ok: false, status: 403 }) as Response
    ) as unknown as typeof fetch
    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(/403/)
  })

  it('rejects a fleet-wide subject returned for a concrete Host', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: jwt({
          sub: 'host:1st:mcp-host/standalone',
          scopes: ['gfs.read', 'gfs.write'],
        }),
        expiresInSeconds: 300,
        subject: 'host:1st:mcp-host/standalone',
      })
    ) as unknown as typeof fetch

    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(
      'gfs host token subject mismatch: expected host:1st:mcp-host/chatllm, received host:1st:mcp-host/standalone'
    )
  })

  it.each([
    ['an opaque token', 'not-a-jwt', 'gfs host token is not a JWT'],
    ['a malformed payload', 'header.bm90LWpzb24.signature', 'malformed JWT payload'],
  ])('rejects %s after response metadata validation', async (_case, token, message) => {
    const subject = 'host:1st:mcp-host/chatllm'
    const fetchFn = vi.fn(async () =>
      okResponse({ token, expiresInSeconds: 300, subject })
    ) as unknown as typeof fetch

    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(message)
  })

  it('rejects a JWT whose subject claim does not match the concrete Host', async () => {
    const subject = 'host:1st:mcp-host/chatllm'
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: jwt({
          sub: 'host:1st:mcp-host/other-host',
          scopes: ['gfs.read', 'gfs.write'],
        }),
        expiresInSeconds: 300,
        subject,
      })
    ) as unknown as typeof fetch

    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow(
      'gfs host token claim subject mismatch: expected host:1st:mcp-host/chatllm, received host:1st:mcp-host/other-host'
    )
  })

  it.each([
    ['missing', undefined],
    ['read-only', ['gfs.read']],
    ['duplicated', ['gfs.read', 'gfs.read']],
    ['expanded', ['gfs.read', 'gfs.write', 'gfs.delete']],
  ])('rejects %s JWT scopes', async (_case, scopes) => {
    const subject = 'host:1st:mcp-host/chatllm'
    const fetchFn = vi.fn(async () =>
      okResponse({ token: jwt({ sub: subject, scopes }), expiresInSeconds: 300, subject })
    ) as unknown as typeof fetch

    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).rejects.toThrow('gfs host token claim scopes mismatch: expected ["gfs.read","gfs.write"]')
  })

  it('accepts reordered JWT scopes with the identical ceiling', async () => {
    // The ceiling is a set: a benign ordering change in control-api's scope
    // handling must not brick every Host reconcile fleet-wide.
    const subject = 'host:1st:mcp-host/chatllm'
    const fetchFn = vi.fn(async () =>
      okResponse({
        token: jwt({ sub: subject, scopes: ['gfs.write', 'gfs.read'] }),
        expiresInSeconds: 300,
        subject,
      })
    ) as unknown as typeof fetch

    await expect(
      mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        { controlApiBaseUrl: 'http://x', signToken: () => 'j', fetchFn }
      )
    ).resolves.toMatchObject({ subject })
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
      const request = mintHostGfsToken(
        { name: 'chatllm', namespace: 'mcp-host' },
        {
          controlApiBaseUrl: 'http://control-api:8090',
          signToken: () => 'hcc-jwt',
          fetchFn,
        }
      )
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
