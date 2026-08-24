import { describe, expect, it, vi } from 'vitest'
import { createMcpProxyFetch, MCP_PROXY_HOST_AUTH_CHALLENGE } from './proxyAuth'

function fixtureAuth(initial: string, refresh: () => Promise<void>) {
  let current = initial
  return {
    getAccessToken: () => current,
    refreshOnUnauthorized: refresh,
    rotate: (next: string) => {
      current = next
    },
  }
}

describe('mcp-host proxy Host bearer transport', () => {
  it('adds a fresh private Host bearer without replacing the MCP credential', async () => {
    const auth = fixtureAuth('fixture-host-one', async () => undefined)
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
    const refresh = vi.fn(async () => undefined)
    const auth = fixtureAuth('fixture-host', refresh)
    const fetchMock = vi.fn(async () => new Response('denied', { status: 401 }))
    const proxyFetch = createMcpProxyFetch(auth, fetchMock)

    const response = await proxyFetch('http://proxy.test/mcp', { method: 'POST', body: 'request' })

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('serializes one refresh when concurrent requests receive 401', async () => {
    let releaseRefresh!: () => void
    let signalRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      signalRefreshStarted = resolve
    })
    let auth!: ReturnType<typeof fixtureAuth>
    const refresh = vi.fn(async () => {
      signalRefreshStarted()
      await new Promise<void>(resolve => {
        releaseRefresh = resolve
      })
      auth.rotate('fixture-host-after-refresh')
    })
    auth = fixtureAuth('fixture-host-before-refresh', refresh)
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

    await refreshStarted
    expect(refresh).toHaveBeenCalledTimes(1)
    releaseRefresh()
    await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(new Headers(calls[2].headers).get('Proxy-Authorization')).toBe(
      'Bearer fixture-host-after-refresh'
    )
    expect(new Headers(calls[3].headers).get('Proxy-Authorization')).toBe(
      'Bearer fixture-host-after-refresh'
    )
  })

  it('shares refresh state across wrappers created for one auth object', async () => {
    const refresh = vi.fn(async () => undefined)
    const auth = fixtureAuth('x', refresh)
    const response = new Response('denied', {
      status: 401,
      headers: { 'WWW-Authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE },
    })
    const fetchMock = vi.fn(async () => response)
    const first = createMcpProxyFetch(auth, fetchMock)
    const second = createMcpProxyFetch(auth, fetchMock)

    await Promise.all([
      first('http://proxy.test/a', { method: 'GET' }),
      second('http://proxy.test/b', { method: 'GET' }),
    ])

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('retries a 401 once and never loops on a persistent rejection', async () => {
    const auth = fixtureAuth('fixture-host', vi.fn(async () => undefined))
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
    expect(auth.refreshOnUnauthorized).toHaveBeenCalledTimes(1)
  })
})
