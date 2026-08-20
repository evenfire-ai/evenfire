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

  it('preserves encoded slashes in scoped Marketplace entry names', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ name: '@evenfire-dev/airtable' })))

    const req = new NextRequest(
      'http://localhost:3000/control-api/api/v1/admin/registry/entries/%40evenfire-dev%2Fairtable/versions/1.0.0',
      { method: 'GET' }
    )

    await GET(req, {
      params: {
        path: [
          'api',
          'v1',
          'admin',
          'registry',
          'entries',
          '@evenfire-dev/airtable',
          'versions',
          '1.0.0',
        ],
      },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8090/api/v1/admin/registry/entries/%40evenfire-dev%2Fairtable/versions/1.0.0',
      expect.any(Object)
    )
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

  describe('request body is capped via CONTROL_UI_PROXY_MAX_BODY_BYTES (pre-auth DoS guard)', () => {
    const ENV_KEY = 'CONTROL_UI_PROXY_MAX_BODY_BYTES'
    let savedEnv: string | undefined

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY]
    })

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = savedEnv
    })

    it('rejects with 413 on a declared content-length above the cap, without calling upstream', async () => {
      process.env[ENV_KEY] = '1024'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2048' },
        body: 'x'.repeat(2048),
      })

      const res = await POST(req, { params: { path: ['api', 'v1', 'admin', 'x'] } })

      expect(res.status).toBe(413)
      await expect(res.json()).resolves.toEqual({ error: 'payload_too_large' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects with 413 when a streamed body without content-length exceeds the cap', async () => {
      process.env[ENV_KEY] = '16'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10))
          controller.enqueue(new Uint8Array(10)) // 20 bytes total > 16-byte cap
          controller.close()
        },
      })
      const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })

      const res = await POST(req, { params: { path: ['api', 'v1', 'admin', 'x'] } })

      expect(res.status).toBe(413)
      await expect(res.json()).resolves.toEqual({ error: 'payload_too_large' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('forwards a body that is within the cap', async () => {
      process.env[ENV_KEY] = String(1024 * 1024)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const payload = JSON.stringify({ name: 'deck.pdf', kind: 'file', contentBase64: 'AAAA' })
      const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })

      const res = await POST(req, { params: { path: ['api', 'v1', 'admin', 'x'] } })
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]

      expect(res.status).toBe(200)
      expect(Buffer.from(init.body as ArrayBuffer).toString('utf8')).toBe(payload)
    })
  })

  describe('concurrent body reads are bounded (pre-auth DoS guard)', () => {
    const ENV_KEY = 'CONTROL_UI_PROXY_MAX_CONCURRENT_BODY_READS'
    const path = ['api', 'v1', 'admin', 'x']
    let savedEnv: string | undefined

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY]
    })

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = savedEnv
    })

    // A request whose body stream stays open until the test releases it, so one
    // reader can be parked mid-read while another request is issued against it.
    function parkedBodyRequest() {
      let close!: () => void
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8))
          close = () => controller.close()
        },
      })
      const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      return { req, release: () => close() }
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 0))

    const jsonRequest = () =>
      new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      })

    it('sheds with 503 while every slot is held, without reaching upstream', async () => {
      process.env[ENV_KEY] = '1'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const parked = parkedBodyRequest()
      const parkedResponse = POST(parked.req, { params: { path } })
      await settle()

      const shed = await POST(jsonRequest(), { params: { path } })

      expect(shed.status).toBe(503)
      expect(shed.headers.get('retry-after')).toBe('1')
      await expect(shed.json()).resolves.toEqual({ error: 'proxy_busy' })
      expect(fetchMock).not.toHaveBeenCalled()

      parked.release()
      await parkedResponse
    })

    it('releases the slot once the body is read, so the next request is admitted', async () => {
      process.env[ENV_KEY] = '1'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const parked = parkedBodyRequest()
      const parkedResponse = POST(parked.req, { params: { path } })
      await settle()
      parked.release()
      await parkedResponse

      const admitted = await POST(jsonRequest(), { params: { path } })

      expect(admitted.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('never gates GET, so SSE notification streams cannot be shed', async () => {
      process.env[ENV_KEY] = '1'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const parked = parkedBodyRequest()
      const parkedResponse = POST(parked.req, { params: { path } })
      await settle()

      const stream = await GET(
        new NextRequest('http://localhost:3000/control-api/api/v1/notifications/stream'),
        { params: { path: ['api', 'v1', 'notifications', 'stream'] } }
      )

      expect(stream.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      parked.release()
      await parkedResponse
    })

    it('falls back to the default when the env value is absent, NaN, non-positive, or out-of-range', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      for (const value of [undefined, 'abc', '0', '-1', '1.5', '99999']) {
        if (value === undefined) delete process.env[ENV_KEY]
        else process.env[ENV_KEY] = value
        const res = await POST(jsonRequest(), { params: { path } })
        expect(res.status).toBe(200)
      }
      expect(fetchMock).toHaveBeenCalledTimes(6)
    })
  })

  describe('raw GFS part bodies are counted before forwarding', () => {
    const path = [
      'api',
      'v1',
      'gfs',
      'proxy',
      'v1',
      'uploads',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'parts',
      '0',
    ]

    it('rejects a streamed part that exceeds the declared length', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }))
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(3))
          controller.enqueue(new Uint8Array(2))
          controller.close()
        },
      })
      const req = new NextRequest(
        'http://localhost:3000/control-api/api/v1/gfs/proxy/v1/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0',
        {
          method: 'PUT',
          headers: { 'Upload-Chunk-Length': '4' },
          body: stream,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }
      )

      const res = await POST(req, { params: { path } })

      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'upload_length_mismatch' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects a streamed part above the hard 16 MiB cap even when the header lies', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }))
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024))
          controller.enqueue(new Uint8Array(1))
          controller.close()
        },
      })
      const req = new NextRequest(
        'http://localhost:3000/control-api/api/v1/gfs/proxy/v1/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0',
        {
          method: 'PUT',
          headers: { 'Upload-Chunk-Length': String(16 * 1024 * 1024) },
          body: stream,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }
      )

      const res = await POST(req, { params: { path } })

      expect(res.status).toBe(413)
      await expect(res.json()).resolves.toEqual({ error: 'payload_too_large' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('forwards the exact counted bytes as a bounded ArrayBuffer', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }))
      const payload = new Uint8Array([1, 2, 3, 4])
      const req = new NextRequest(
        'http://localhost:3000/control-api/api/v1/gfs/proxy/v1/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0',
        {
          method: 'PUT',
          headers: { 'Upload-Chunk-Length': String(payload.byteLength) },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(payload)
              controller.close()
            },
          }),
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }
      )

      const res = await POST(req, { params: { path } })
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]

      expect(res.status).toBe(204)
      expect(Buffer.from(init.body as ArrayBuffer)).toEqual(Buffer.from(payload))
    })
  })

  describe('header handling', () => {
    afterEach(() => vi.restoreAllMocks())

    it('strips the Expect header before forwarding upstream (RC4)', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const req = new NextRequest('http://localhost:3000/control-api/api/v1/gfs/proxy/x', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Expect: '100-continue',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({ a: 1 }),
      })

      await POST(req, { params: { path: ['api', 'v1', 'gfs', 'proxy', 'x'] } })
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Headers }]

      // undici's fetch throws NotSupportedError if `expect` reaches it — the proxy
      // must never forward it (RC4). Authorization still passes through.
      expect(init.headers.has('expect')).toBe(false)
      expect(init.headers.get('authorization')).toBe('Bearer t')
    })

    it('preserves each Set-Cookie separately and forwards Content-Length on responses', async () => {
      const upstream = new Response('body-bytes', {
        status: 200,
        headers: { 'content-length': '10', 'content-type': 'application/octet-stream' },
      })
      upstream.headers.append('set-cookie', 'a=1; Path=/')
      upstream.headers.append('set-cookie', 'b=2; Path=/; Expires=Wed, 21 Oct 2099 00:00:00 GMT')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream)

      const req = new NextRequest('http://localhost:3000/control-api/api/v1/gfs/tree', {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      })

      const res = await GET(req, { params: { path: ['api', 'v1', 'gfs', 'tree'] } })

      // forEach would collapse these into one unsplittable value (the Expires comma);
      // getSetCookie() keeps them separate.
      expect(res.headers.getSetCookie()).toEqual([
        'a=1; Path=/',
        'b=2; Path=/; Expires=Wed, 21 Oct 2099 00:00:00 GMT',
      ])
      // content-length must survive on the response direction (browser download progress).
      expect(res.headers.get('content-length')).toBe('10')
    })
  })
})
