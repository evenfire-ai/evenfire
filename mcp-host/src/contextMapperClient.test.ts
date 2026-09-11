import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ContextMapperAuthentication,
  ContextMapperClient,
  ContextMapperCredentialRevisionError,
  ContextMapperRequestError,
  isContextMapperAuthorityRevocation,
  isContextMapperInventoryAuthorityRevocation,
} from './contextMapperClient'

function authentication(overrides: Partial<ContextMapperAuthentication> = {}) {
  let accessToken = 'access-v1'
  const auth: ContextMapperAuthentication & { setAccessToken(token: string): void } = {
    getAccessToken: () => accessToken,
    refreshOnUnauthorized: vi.fn(async () => {
      accessToken = 'access-v2'
    }),
    onCallerAuthorizationFailure: vi.fn(),
    setAccessToken: token => {
      accessToken = token
    },
    ...overrides,
  }
  return auth
}

function authorizedServer(overrides: Record<string, unknown> = {}) {
  return {
    name: 'secured-server',
    description: 'Scoped server',
    transport: { type: 'streamableHttp', url: 'http://secured-server.test/mcp' },
    enabled: true,
    status: { deployed: true, ready: true },
    authRequired: true,
    credentialRevision: 'revision-1',
    ...overrides,
  }
}

function inventory(servers: unknown[] = [authorizedServer()]) {
  return {
    servers,
    timestamp: '2026-08-16T10:00:00.000Z',
  }
}

describe('ContextMapperClient Host-scoped v2 inventory', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps readiness anonymous', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.healthCheck()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://context-mapper.test/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('uses the live Host bearer and v2 self route without a caller Context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(inventory()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new ContextMapperClient('http://context-mapper.test/', {
      authentication: authentication(),
    })

    await expect(client.listServersForHost()).resolves.toEqual([authorizedServer()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://context-mapper.test/api/v2/hosts/self/mcpservers')
    expect(url).not.toContain('/api/v1/')
    expect(url).not.toContain('/context/')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-v1')
  })

  it('preserves an optional bounded transport port from the v2 inventory', async () => {
    const server = authorizedServer({
      transport: {
        type: 'streamableHttp',
        url: 'http://secured-server.test/mcp',
        port: 3443,
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(inventory([server])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.listServersForHost()).resolves.toEqual([server])
  })

  it.each([0, -1, 1.5, 65_536, '3443', null])(
    'rejects malformed v2 transport port %j',
    async port => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify(
              inventory([
                authorizedServer({
                  transport: { type: 'streamableHttp', port },
                }),
              ])
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )
      const client = new ContextMapperClient('http://context-mapper.test', {
        authentication: authentication(),
      })

      await expect(client.listServersForHost()).rejects.toThrow(
        'HCC inventory response contains an invalid transport port'
      )
    }
  )

  it('refreshes once on 401 and retries with the current shared access token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(inventory()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = authentication()
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: auth,
    })

    await expect(client.pollServers()).resolves.toEqual(inventory())

    expect(auth.refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-v1'
    )
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-v2'
    )
  })

  it('revokes caller authority after a persistent 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
    )
    const auth = authentication()
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: auth,
    })

    await expect(client.pollServers()).rejects.toMatchObject({
      status: 401,
      authorizationFailure: true,
    })
    expect(auth.refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(auth.onCallerAuthorizationFailure).toHaveBeenCalledWith(401)
  })

  it('revokes immediately on 403 without trying token refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    const auth = authentication()
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: auth,
    })

    await expect(client.pollServers()).rejects.toBeInstanceOf(ContextMapperRequestError)
    expect(auth.refreshOnUnauthorized).not.toHaveBeenCalled()
    expect(auth.onCallerAuthorizationFailure).toHaveBeenCalledWith(403)
  })

  it('fails closed before transport when no Host bearer is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new ContextMapperClient('http://context-mapper.test')

    await expect(client.pollServers()).rejects.toMatchObject({
      status: 401,
      authorizationFailure: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('revokes locally before transport when the live Host bearer is unavailable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const auth = authentication({ getAccessToken: () => '' })
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: auth,
    })

    await expect(client.getAuthToken('secured-server', 'revision-1')).rejects.toMatchObject({
      status: 401,
      kind: 'credential',
      authorizationFailure: true,
    })
    expect(auth.onCallerAuthorizationFailure).toHaveBeenCalledWith(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves an unavailable controller as a typed non-authoritative failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.pollServers()).rejects.toMatchObject({
      status: 503,
      kind: 'inventory',
      authorizationFailure: false,
    })
  })

  it('classifies an opaque inventory 404 as complete Host authority revocation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    const error = await client.pollServers().catch(cause => cause)

    expect(error).toMatchObject({ status: 404, kind: 'inventory' })
    expect(isContextMapperInventoryAuthorityRevocation(error)).toBe(true)
    expect(isContextMapperAuthorityRevocation(error)).toBe(false)
  })

  it('rejects forbidden Context or Secret metadata in a successful inventory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            inventory([
              authorizedServer({
                contextRef: 'foreign-context',
                auth: { type: 'bearer', secretRef: 'foreign-secret' },
              }),
            ])
          ),
          { status: 200 }
        )
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.pollServers()).rejects.toThrow(
      'HCC inventory response contains forbidden authority metadata'
    )
  })

  it('preserves a valid authKind from the v2 inventory (mini-spec 10 §3.3)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(inventory([authorizedServer({ authKind: 'oauth-user' })])), {
          status: 200,
        })
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    const result = await client.pollServers()
    expect(result.servers[0].authKind).toBe('oauth-user')
  })

  it('rejects an authKind value outside the enum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(inventory([authorizedServer({ authKind: 'oauth-admin' })])), {
          status: 200,
        })
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.pollServers()).rejects.toThrow(
      'HCC inventory response contains an invalid authKind'
    )
  })

  it('still rejects forbidden metadata even when a valid authKind is present (guard intact, I1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify(
              inventory([
                authorizedServer({ authKind: 'oauth-context', contextRef: 'foreign-context' }),
              ])
            ),
            { status: 200 }
          )
        )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.pollServers()).rejects.toThrow(
      'HCC inventory response contains forbidden authority metadata'
    )
  })

  it('accepts an authenticated HTTP 200 empty inventory as authoritative', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(inventory([])), { status: 200 }))
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.pollServers()).resolves.toEqual(inventory([]))
  })

  it('bounds a silent authenticated HCC request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        })
      })
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      requestTimeoutMs: 10,
      authentication: authentication(),
    })

    await expect(client.pollServers()).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

describe('ContextMapperClient scoped credential retrieval', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('posts only the server selector and validates the inventory revision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'upstream-token', credentialRevision: 'revision-1' }), {
        status: 200,
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.getAuthToken('secured-server', 'revision-1')).resolves.toBe(
      'upstream-token'
    )

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://context-mapper.test/api/v2/hosts/self/mcpservers/credential')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ serverName: 'secured-server' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-v1')
  })

  it('rejects a credential read whose post-read authority revision changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: 'discard-me', credentialRevision: 'revision-2' }), {
          status: 200,
        })
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    const result = client.getAuthToken('secured-server', 'revision-1')
    const error = await result.catch(value => value)
    expect(error).toBeInstanceOf(ContextMapperCredentialRevisionError)
    expect(isContextMapperAuthorityRevocation(error)).toBe(true)
  })

  it('rejects a credential read without an inventory authority revision before transport', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    const error = await client.getAuthToken('secured-server').catch(cause => cause)

    expect(error).toBeInstanceOf(ContextMapperCredentialRevisionError)
    expect(isContextMapperAuthorityRevocation(error)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retains token:null as the explicit allowed no-auth response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: null, credentialRevision: 'revision-1' }), {
          status: 200,
        })
      )
    )
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    await expect(client.getAuthToken('open-server', 'revision-1')).resolves.toBeUndefined()
  })

  it('classifies an opaque credential 404 as target authority revocation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: authentication(),
    })

    const error = await client.getAuthToken('foreign-server', 'revision-1').catch(value => value)
    expect(error).toMatchObject({ status: 404, kind: 'credential' })
    expect(isContextMapperAuthorityRevocation(error)).toBe(true)
    expect(String(error)).not.toContain('foreign-server')
  })
})
