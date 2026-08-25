import { describe, expect, it, vi } from 'vitest'
import {
  createMcpProxyFetch,
  getSharedMcpProxyHostAuthorization,
  MCP_PROXY_HOST_AUTH_CHALLENGE,
} from './proxyAuth'

function fixtureAuth(initial: string, reread: () => Promise<boolean>) {
  let current = initial
  return {
    getAccessToken: () => current,
    rereadAccessToken: reread,
    rotate: (next: string) => {
      current = next
    },
  }
}

describe('mcp-host proxy Host bearer transport', () => {
  it('adds a fresh private Host bearer without replacing the MCP credential', async () => {
    const auth = fixtureAuth('fixture-host-one', async () => false)
    const calls: RequestInit[] = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response('ok', { status: 200 })
    })
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await proxyFetch('http://proxy.test/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-mcp-credential' },
      body: '{"jsonrpc":"2.0"}',
    })
    auth.rotate('fixture-host-two')
    await proxyFetch('http://proxy.test/mcp', {
      method: 'GET',
      headers: { Authorization: 'Bearer fixture-mcp-credential' },
    })

    expect(new Headers(calls[0].headers).get('Proxy-Authorization')).toBe(
      'Bearer fixture-host-one'
    )
    expect(new Headers(calls[1].headers).get('Proxy-Authorization')).toBe(
      'Bearer fixture-host-two'
    )
    expect(new Headers(calls[0].headers).get('Authorization')).toBe(
      'Bearer fixture-mcp-credential'
    )
  })

  it('does not retry a forwarded 401', async () => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('fixture-host', reread)
    const fetchMock = vi.fn(async () => new Response('denied', { status: 401 }))
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    const response = await proxyFetch('http://proxy.test/mcp', { method: 'POST', body: 'request' })

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reread).not.toHaveBeenCalled()
  })

  it('fails closed without replay when no newer access token exists', async () => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('fixture-host', reread)
    const fetchMock = vi.fn(async () =>
      new Response('denied', {
        status: 401,
        headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
      })
    )
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await expect(proxyFetch('http://proxy.test/mcp', { method: 'GET' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reread).toHaveBeenCalledTimes(1)
  })

  it('does not trust an out-of-band bearer change without an adopted reread', async () => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('fixture-host-before-reread', reread)
    auth.rotate('fixture-host-untrusted-change')
    const fetchMock = vi.fn(async () =>
      new Response('denied', {
        status: 401,
        headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
      })
    )
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await expect(proxyFetch('http://proxy.test/mcp', { method: 'GET' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reread).toHaveBeenCalledTimes(1)
  })

  it('does not consume refresh or reissue after a proxy Host challenge', async () => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('fixture-host', reread)
    const fetchMock = vi.fn(async () =>
      new Response('denied', {
        status: 401,
        headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
      })
    )
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await expect(proxyFetch('http://proxy.test/mcp', { method: 'GET' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reread).toHaveBeenCalledTimes(1)
  })

  it('serializes one access-only reread when concurrent requests receive 401', async () => {
    let releaseReread!: () => void
    let signalRereadStarted!: () => void
    const rereadStarted = new Promise<void>(resolve => {
      signalRereadStarted = resolve
    })
    let auth!: ReturnType<typeof fixtureAuth>
    const reread = vi.fn(async () => {
      signalRereadStarted()
      await new Promise<void>(resolve => {
        releaseReread = resolve
      })
      auth.rotate('fixture-host-after-reread')
      return true
    })
    auth = fixtureAuth('fixture-host-before-reread', reread)
    const calls: RequestInit[] = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response('denied', {
        status: calls.length <= 2 ? 401 : 200,
        headers: calls.length <= 2 ? { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE } : {},
      })
    })
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)
    const first = proxyFetch('http://proxy.test/mcp', { method: 'GET' })
    const second = proxyFetch('http://proxy.test/mcp', { method: 'GET' })

    await rereadStarted
    expect(reread).toHaveBeenCalledTimes(1)
    releaseReread()
    await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(new Headers(calls[2].headers).get('Proxy-Authorization')).toBe(
      'Bearer fixture-host-after-reread'
    )
    expect(new Headers(calls[3].headers).get('Proxy-Authorization')).toBe(
      'Bearer fixture-host-after-reread'
    )
  })

  it('shares access-only reread state across wrappers created for one auth object', async () => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('x', reread)
    const response = new Response('denied', {
      status: 401,
      headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
    })
    const fetchMock = vi.fn(async () => response)
    const first = createMcpProxyFetch(auth, fetchMock)
    const second = createMcpProxyFetch(auth, fetchMock)

    await expect(
      Promise.all([
        first('http://proxy.test/a', { method: 'GET' }),
        second('http://proxy.test/b', { method: 'GET' }),
      ])
    ).rejects.toThrow()

    expect(reread).toHaveBeenCalledTimes(1)
  })

  it('shares one Host authorization facade across production manager generations', async () => {
    const runtimeAuth = { accessToken: 'h' }
    const reread = vi.fn(async () => {
      runtimeAuth.accessToken = 'h-after-reread'
      return true
    })
    const first = getSharedMcpProxyHostAuthorization(runtimeAuth, () => ({
      getAccessToken: () => runtimeAuth.accessToken,
      rereadAccessToken: reread,
    }))
    const second = getSharedMcpProxyHostAuthorization(runtimeAuth, () => ({
      getAccessToken: () => runtimeAuth.accessToken,
      rereadAccessToken: reread,
    }))

    expect(second).toBe(first)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('denied', {
          status: 401,
          headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
        })
      )
      .mockResolvedValueOnce(
        new Response('denied', {
          status: 401,
          headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
        })
      )
      .mockResolvedValue(new Response('ok', { status: 200 }))

    await Promise.all([
      createMcpProxyFetch(first, fetchMock)('http://proxy.test/a', { method: 'GET' }),
      createMcpProxyFetch(second, fetchMock)('http://proxy.test/b', { method: 'GET' }),
    ])

    expect(reread).toHaveBeenCalledTimes(1)
  })

  it('retries a 401 once and never loops on a second exact challenge', async () => {
    let auth!: ReturnType<typeof fixtureAuth>
    const reread = vi.fn(async () => {
      auth.rotate('fixture-host-after-reread')
      return true
    })
    auth = fixtureAuth('fixture-host', reread)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('denied', {
          status: 401,
          headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
        })
      )
      .mockResolvedValueOnce(
        new Response('denied-again', {
          status: 401,
          headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
        })
      )
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    const response = await proxyFetch('http://proxy.test/mcp', { method: 'GET' })

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(reread).toHaveBeenCalledTimes(1)
  })

  it.each([
    [400, undefined],
    [401, 'Bearer realm="upstream"'],
    [403, MCP_PROXY_HOST_AUTH_CHALLENGE],
    [503, MCP_PROXY_HOST_AUTH_CHALLENGE],
    [500, MCP_PROXY_HOST_AUTH_CHALLENGE],
  ])('does not reread for non-exact auth status %s', async (status, challenge) => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('fixture-host', reread)
    const headers = challenge ? { 'WWW-Authenticate': challenge } : undefined
    const fetchMock = vi.fn(async () => new Response('denied', { status, headers }))
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    const response = await proxyFetch('http://proxy.test/mcp', { method: 'GET' })

    expect(response.status).toBe(status)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reread).not.toHaveBeenCalled()
  })

  it('does not reread after a transport error', async () => {
    const reread = vi.fn(async () => false)
    const auth = fixtureAuth('fixture-host', reread)
    const fetchMock = vi.fn(async () => {
      throw new Error('transport failed')
    })
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await expect(proxyFetch('http://proxy.test/mcp', { method: 'GET' })).rejects.toThrow(
      'transport failed'
    )
    expect(reread).not.toHaveBeenCalled()
  })

  it('gives each independent HTTP exchange its own single replay budget', async () => {
    let auth!: ReturnType<typeof fixtureAuth>
    let next = 0
    const reread = vi.fn(async () => {
      next += 1
      auth.rotate(`fixture-host-reread-${next}`)
      return true
    })
    auth = fixtureAuth('fixture-host-initial', reread)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('denied', {
          status: 401,
          headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
        })
      )
      .mockResolvedValueOnce(new Response('ok-1', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('denied', {
          status: 401,
          headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
        })
      )
      .mockResolvedValueOnce(new Response('ok-2', { status: 200 }))
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await expect(
      proxyFetch('http://proxy.test/mcp', { method: 'POST', body: 'one' })
    ).resolves.toMatchObject({ status: 200 })
    await expect(proxyFetch('http://proxy.test/mcp', { method: 'GET' })).resolves.toMatchObject({
      status: 200,
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(reread).toHaveBeenCalledTimes(2)
  })

  it('replays a buffered stream body exactly once after the access-only reread', async () => {
    let auth!: ReturnType<typeof fixtureAuth>
    const reread = vi.fn(async () => {
      auth.rotate('fixture-host-after-stream-reread')
      return true
    })
    auth = fixtureAuth('fixture-host-before-stream-reread', reread)
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(await new Response(init?.body).text())
      return bodies.length === 1
        ? new Response('denied', {
            status: 401,
            headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
          })
        : new Response('ok', { status: 200 })
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('mcp-payload'))
        controller.close()
      },
    })
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    await expect(
      proxyFetch('http://proxy.test/mcp', { method: 'POST', body })
    ).resolves.toMatchObject({ status: 200 })

    expect(bodies).toEqual(['mcp-payload', 'mcp-payload'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(reread).toHaveBeenCalledTimes(1)
  })
})
