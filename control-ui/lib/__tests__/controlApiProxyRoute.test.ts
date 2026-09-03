import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GET,
  POST,
  __inFlightBodyBytesForTest,
  __resetInFlightBodyBytesForTest,
} from '../../app/control-api/[...path]/route'

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
    expect(init.headers.get('x-forwarded-host')).toBe('localhost:3000')
    expect(init.headers.get('x-forwarded-proto')).toBe('http')
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

  describe('in-flight body bytes are bounded (pre-auth DoS guard)', () => {
    const BUDGET_KEY = 'CONTROL_UI_PROXY_MAX_INFLIGHT_BODY_BYTES'
    const IDLE_KEY = 'CONTROL_UI_PROXY_BODY_READ_IDLE_TIMEOUT_MS'
    const CAP_KEY = 'CONTROL_UI_PROXY_MAX_BODY_BYTES'
    const path = ['api', 'v1', 'admin', 'x']
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const key of [BUDGET_KEY, IDLE_KEY, CAP_KEY]) saved[key] = process.env[key]
      // Module state is shared across tests in this file; a test that throws
      // mid-read would otherwise leak its charge into every later test.
      __resetInFlightBodyBytesForTest()
    })

    afterEach(() => {
      for (const key of [BUDGET_KEY, IDLE_KEY, CAP_KEY]) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key] as string
      }
      __resetInFlightBodyBytesForTest()
    })

    // A request whose body stream stays open until the test releases it, so one
    // reader can be parked mid-read while another request is issued against it.
    // `bytes` is charged at 2x while it is parked (chunk list + pending copy).
    function parkedBodyRequest(bytes = 8, declaredLength?: number) {
      let close!: () => void
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes))
          close = () => controller.close()
        },
      })
      const headers = new Headers()
      if (declaredLength !== undefined) headers.set('content-length', String(declaredLength))
      const req = new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        headers,
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

    it('sheds with 429 once the budget is spent, without reaching upstream', async () => {
      // 16 bytes = exactly the 2x charge of the 8-byte parked chunk, so the
      // parked reader alone consumes the whole budget.
      process.env[BUDGET_KEY] = '16'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const parked = parkedBodyRequest()
      const parkedResponse = POST(parked.req, { params: { path } })
      await settle()

      const shed = await POST(jsonRequest(), { params: { path } })

      expect(shed.status).toBe(429)
      expect(shed.headers.get('retry-after')).toBe('1')
      await expect(shed.json()).resolves.toEqual({ error: 'proxy_busy' })
      expect(fetchMock).not.toHaveBeenCalled()

      parked.release()
      await parkedResponse
    })

    // B1 regression. The charge must span the upstream round trip: `body` stays
    // referenced by fetchInit for its whole duration, which is the SLOW phase.
    // Releasing when the read finishes bounds the rate buffers are created at,
    // not how many are alive.
    it('holds the charge across the upstream fetch, not just the body read', async () => {
      // 16 = the 8-byte chunk's resident charge (8) plus headroom below the
      // 22 bytes the JSON mutation needs, so the shed below can only come from
      // the in-flight request still holding its buffer.
      process.env[BUDGET_KEY] = '16'
      let releaseUpstream!: () => void
      const upstreamGate = new Promise<void>(resolve => {
        releaseUpstream = resolve
      })
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await upstreamGate
        return new Response('{}', { status: 200 })
      })

      // Read the body to completion, then park the request inside fetch().
      const parked = parkedBodyRequest()
      const inFlight = POST(parked.req, { params: { path } })
      await settle()
      parked.release()
      await settle()

      // The read is finished — a reader-count budget would have freed its slot
      // here — but the buffer is still referenced by fetchInit.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(__inFlightBodyBytesForTest()).toBe(8)

      const shed = await POST(jsonRequest(), { params: { path } })
      expect(shed.status).toBe(429)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      releaseUpstream()
      await inFlight
      expect(__inFlightBodyBytesForTest()).toBe(0)
    })

    it('releases the charge once the upstream fetch resolves', async () => {
      process.env[BUDGET_KEY] = '32'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      const parked = parkedBodyRequest()
      const parkedResponse = POST(parked.req, { params: { path } })
      await settle()
      parked.release()
      await parkedResponse

      expect(__inFlightBodyBytesForTest()).toBe(0)
      const admitted = await POST(jsonRequest(), { params: { path } })

      expect(admitted.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // B3/B4 regression. A slot budget priced a 4 KiB mutation like a 16 MiB upload
    // part, so four upload workers shed every unrelated mutation in the product.
    it('lets a small mutation through while a large upload is buffering', async () => {
      process.env[BUDGET_KEY] = String(1024 * 1024)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      // 64 KiB parked upload -> 128 KiB charged, far below the 1 MiB budget.
      const parked = parkedBodyRequest(64 * 1024)
      const parkedResponse = POST(parked.req, { params: { path } })
      await settle()

      const mutation = await POST(jsonRequest(), { params: { path } })

      expect(mutation.status).toBe(200)
      // Exactly one upstream call: the mutation's. The upload is still mid-read,
      // so this also pins that a buffering upload does not reach control-api early.
      expect(fetchMock).toHaveBeenCalledTimes(1)

      parked.release()
      await parkedResponse
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // B2 regression. readBodyCapped took no deadline and the AbortSignal.timeout
    // was constructed AFTER the read, so the buffering phase had none at all: a
    // socket that sent one byte and went quiet held its charge until Node's
    // 300s server.requestTimeout.
    it('aborts a body that stalls mid-read instead of holding the charge', async () => {
      process.env[IDLE_KEY] = '20'
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      // Dribbles one byte, then never closes and never sends again.
      const stalled = parkedBodyRequest(1)
      const res = await POST(stalled.req, { params: { path } })

      expect(res.status).toBe(408)
      await expect(res.json()).resolves.toEqual({ error: 'request_body_timeout' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(__inFlightBodyBytesForTest()).toBe(0)
    })

    it('does not let a dribbling client reserve the length it declared', async () => {
      // Declares 512 KiB but sends 1 byte. Charging the declared length would let
      // a handful of near-silent sockets deny the whole budget.
      process.env[BUDGET_KEY] = String(1024 * 1024)
      process.env[IDLE_KEY] = '20'
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const dribbler = parkedBodyRequest(1, 512 * 1024)
      const pending = POST(dribbler.req, { params: { path } })
      await settle()

      // Only the byte actually sent is charged: 1 x 2, not 512 KiB x 2.
      expect(__inFlightBodyBytesForTest()).toBe(2)
      await pending
    })

    it('never gates GET, so SSE notification streams cannot be shed', async () => {
      process.env[BUDGET_KEY] = '16'
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

    // H3 regression. The default IS the production config — the knob appears in no
    // manifest — so the suite has to pin its value, not just that some limit exists.
    // Asserting only that a lone request is admitted lets 4 -> MAX_SAFE_INTEGER live.
    // The forecast is checked against the budget only AFTER the per-request cap,
    // so these raise the cap to its ceiling to make the budget the binding limit.
    // Nothing is actually buffered: the forecast is read from content-length and
    // the shed happens before the first chunk.
    const declaredLengthRequest = (declaredBytes: number) =>
      new NextRequest('http://localhost:3000/control-api/api/v1/admin/x', {
        method: 'POST',
        headers: { 'content-length': String(declaredBytes) },
        body: new Uint8Array(8),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })

    it('defaults the budget to 192MiB exactly', async () => {
      delete process.env[BUDGET_KEY]
      process.env[CAP_KEY] = String(512 * 1024 * 1024)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      // The forecast is 2x content-length, so 96MiB is the largest declared length
      // that fits a 192MiB budget and 96MiB + 1 is the smallest that does not.
      // Asserting BOTH sides pins the constant: a budget of 1024, or one widened to
      // MAX_SAFE_INTEGER by a broken parse, fails one side or the other.
      expect(
        (await POST(declaredLengthRequest(96 * 1024 * 1024 + 1), { params: { path } })).status
      ).toBe(429)
      expect(fetchMock).not.toHaveBeenCalled()

      expect(
        (await POST(declaredLengthRequest(96 * 1024 * 1024), { params: { path } })).status
      ).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to the default when the env value is absent, NaN, non-positive, or out-of-range', async () => {
      process.env[CAP_KEY] = String(512 * 1024 * 1024)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }))

      // Every one of these must resolve to the 192MiB default, so a forecast just
      // above it is shed. Asserting a bare 200 instead would prove nothing — a
      // budget parsed as NaN admits everything, which is the mutant this kills.
      // 1GiB is above MAX_INFLIGHT_BODY_BYTES_CEILING and must not be honoured.
      for (const value of [undefined, 'abc', '0', '-1', '1.5', String(1024 ** 3)]) {
        if (value === undefined) delete process.env[BUDGET_KEY]
        else process.env[BUDGET_KEY] = value
        const res = await POST(declaredLengthRequest(96 * 1024 * 1024 + 1), { params: { path } })
        expect(res.status).toBe(429)
      }
      expect(fetchMock).not.toHaveBeenCalled()
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

    // The upload branch is the one that actually holds a large charge for a long
    // time, so the shed has to be proven HERE and not only on the JSON branch.
    // `upload-chunk-length` is the declared length on this path, so the forecast
    // must be read from it rather than from content-length.
    it('sheds a part whose declared length cannot fit the remaining budget', async () => {
      const BUDGET_KEY = 'CONTROL_UI_PROXY_MAX_INFLIGHT_BODY_BYTES'
      const savedBudget = process.env[BUDGET_KEY]
      // 2 MiB budget against a declared 4 MiB part (forecast 8 MiB).
      process.env[BUDGET_KEY] = String(2 * 1024 * 1024)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }))
      try {
        const req = new NextRequest(
          'http://localhost:3000/control-api/api/v1/gfs/proxy/v1/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0',
          {
            method: 'PUT',
            headers: { 'Upload-Chunk-Length': String(4 * 1024 * 1024) },
            body: new Uint8Array(8),
            duplex: 'half',
          } as RequestInit & { duplex: 'half' }
        )

        const res = await POST(req, { params: { path } })

        // 429, not 503: 503 is in GFS_UPLOAD_AMBIGUOUS_STATUS and would send the
        // client reconciling a part that never left this process.
        expect(res.status).toBe(429)
        expect(res.headers.get('retry-after')).toBe('1')
        await expect(res.json()).resolves.toEqual({ error: 'proxy_busy' })
        // Shed before a single byte was buffered or forwarded.
        expect(fetchMock).not.toHaveBeenCalled()
        expect(__inFlightBodyBytesForTest()).toBe(0)
      } finally {
        if (savedBudget === undefined) delete process.env[BUDGET_KEY]
        else process.env[BUDGET_KEY] = savedBudget
        __resetInFlightBodyBytesForTest()
      }
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
