import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from '../../app/control-api/[...path]/route'

describe('control-ui control-api proxy route', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards auth, query string, and JSON body to control-api', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-upstream': 'control-api' },
      })
    )

    const req = new NextRequest(
      'http://localhost:3000/control-api/api/v1/admin/registry/install?dryRun=1',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Trace': 'abc123',
        },
        body: JSON.stringify({ serverName: 'example' }),
      }
    )

    const res = await POST(req, { params: { path: ['api', 'v1', 'admin', 'registry', 'install'] } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }]

    expect(url).toBe('http://127.0.0.1:8090/api/v1/admin/registry/install?dryRun=1')
    expect(init.method).toBe('POST')
    expect(init.headers.get('authorization')).toBe('Bearer test-token')
    expect(init.headers.get('x-trace')).toBe('abc123')
    expect(init.headers.has('host')).toBe(false)
    expect(init.headers.has('content-length')).toBe(false)
    expect(init.signal).toBeDefined()
    expect(Buffer.from(init.body as ArrayBuffer).toString('utf8')).toBe(
      JSON.stringify({ serverName: 'example' })
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('x-upstream')).toBe('control-api')
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('forwards GET requests without a body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))

    const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/contexts', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    })

    const res = await GET(req as unknown as NextRequest, {
      params: { path: ['api', 'v1', 'admin', 'contexts'] },
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }]

    expect(url).toBe('http://127.0.0.1:8090/api/v1/admin/contexts')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ items: [] })
  })

  it('forwards the HttpOnly admin session cookie for GFS tree requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))

    const req = new NextRequest('http://localhost:3000/control-api/api/v1/gfs/tree?drive=main', {
      method: 'GET',
      headers: {
        Cookie: 'control_ui_admin_session=test-session',
      },
    })

    const res = await GET(req as unknown as NextRequest, {
      params: { path: ['api', 'v1', 'gfs', 'tree'] },
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }]

    expect(url).toBe('http://127.0.0.1:8090/api/v1/gfs/tree?drive=main')
    expect(init.method).toBe('GET')
    expect(init.headers.get('cookie')).toBe('control_ui_admin_session=test-session')
    expect(res.status).toBe(200)
  })

  it('returns JSON 502 when upstream fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:8090')
    )

    const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/contexts', {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    })

    const res = await GET(req as unknown as NextRequest, {
      params: { path: ['api', 'v1', 'admin', 'contexts'] },
    })

    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toEqual({
      error: 'control-api proxy request failed: connect ECONNREFUSED 127.0.0.1:8090',
    })
  })

  describe('proxy timeout is runtime-configurable via CONTROL_API_PROXY_TIMEOUT_MS', () => {
    const ENV_KEY = 'CONTROL_API_PROXY_TIMEOUT_MS'
    let savedEnv: string | undefined

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY]
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    })

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = savedEnv
    })

    it('arms the abort timeout with the env value for body-bearing methods', async () => {
      process.env[ENV_KEY] = '300000'
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

      const req = new NextRequest(
        'http://localhost:3000/control-api/api/v1/gfs/proxy/v1/resources/r1/children',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'deck.pdf', kind: 'file', contentBase64: 'AAAA' }),
        }
      )

      await POST(req, {
        params: { path: ['api', 'v1', 'gfs', 'proxy', 'v1', 'resources', 'r1', 'children'] },
      })

      expect(timeoutSpy).toHaveBeenCalledWith(300000)
    })

    it('falls back to 30000ms when the env value is absent, NaN, non-positive, non-integer, or out-of-range', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

      // Includes non-integer and out-of-range values: AbortSignal.timeout throws
      // ERR_OUT_OF_RANGE for those, which would 500 every body-bearing request if they
      // reached it, so they MUST fall back to the default instead.
      for (const bad of [undefined, 'not-a-number', '0', '-5', '300000.5', '5000000000', '1e12']) {
        timeoutSpy.mockClear()
        if (bad === undefined) delete process.env[ENV_KEY]
        else process.env[ENV_KEY] = bad

        const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ a: 1 }),
        })

        await POST(req, { params: { path: ['api', 'v1', 'admin', 'x'] } })

        expect(timeoutSpy).toHaveBeenCalledWith(30000)
      }
    })

    it('does not arm the proxy timeout for GET, so SSE streams are never cut', async () => {
      process.env[ENV_KEY] = '300000'
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

      const req = new NextRequest(
        'http://localhost:3000/control-api/api/v1/admin/notifications/stream',
        { method: 'GET', headers: { Authorization: 'Bearer t' } }
      )

      await GET(req, {
        params: { path: ['api', 'v1', 'admin', 'notifications', 'stream'] },
      })

      expect(timeoutSpy).not.toHaveBeenCalled()
    })
  })
})
