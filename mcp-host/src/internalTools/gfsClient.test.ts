import { describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { VISUAL_INPUT_LIMITS, VisualInputBudget } from '../visualInput/policy'
import {
  DEFAULT_GFS_ACCESS_FILE,
  createGfscClient,
  getGfsToolScopes,
  hasGfsRuntimeAccess,
} from './gfsClient'

function encodedClaims(scopes: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ scopes })).toString('base64url')
  return `${header}.${payload}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string, status: number, statusText = ''): Response {
  return new Response(body, { status, statusText })
}

describe('gfs runtime gfsc client', () => {
  it('detects mounted runtime access without exposing dead tools', () => {
    expect(
      hasGfsRuntimeAccess({
        get: () => undefined,
        fileExists: path => path === DEFAULT_GFS_ACCESS_FILE,
      })
    ).toBe(true)
    expect(
      hasGfsRuntimeAccess({
        get: () => undefined,
        fileExists: () => false,
      })
    ).toBe(false)
  })

  it('derives only recognized GFS tool scopes and fails closed', () => {
    expect([
      ...(getGfsToolScopes({ get: () => encodedClaims(['gfs.read', 'gfs.write']) }) ?? []),
    ]).toEqual(['gfs.read', 'gfs.write'])
    expect(getGfsToolScopes({ get: () => encodedClaims(['gfs.read', 'gfs.delete']) })).toBeNull()
    expect(getGfsToolScopes({ get: () => encodedClaims(['gfs.delete']) })).toBeNull()
    expect(getGfsToolScopes({ get: () => encodedClaims([]) })).toBeNull()
    expect(getGfsToolScopes({ get: () => encodedClaims('gfs.read') })).toBeNull()
    expect(getGfsToolScopes({ get: () => 'malformed' })).toBeNull()
  })

  it('calls gfsc accessible with runtime bearer auth', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [] } })
    )
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })
    await client.accessible({ drive: 'main' })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://gfsc.gfs.svc.cluster.local:8087/v1/accessible?drive=main'
    )
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer gfs-access',
    })
  })

  it('routes writes to the gfsc writer service with conditional body', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { version: 3 } })
    )
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })
    await client.write({ drive: 'main', resourceId: 'rid', content: 'new', ifMatch: 2 })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/rid/content?drive=main'
    )
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ content: 'new', ifMatch: 2 }),
    })
  })

  it('uses exact writer routes and bodies for create, rename, and copy', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: {} })
    )
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })
    await client.createFile({
      drive: 'main',
      parentResourceId: 'parent/id',
      name: 'note.txt',
      content: 'hello',
    })
    await client.createFolder({ drive: 'main', parentResourceId: 'parent/id', name: 'docs' })
    await client.rename({
      drive: 'main',
      resourceId: 'source/id',
      newName: 'renamed.txt',
      ifMatch: 4,
    })
    const copy = {
      drive: 'main',
      sourceResourceId: 'source',
      destinationParentId: 'destination',
      newName: 'source-copy',
      ifMatch: 7,
    }
    await client.copy(copy)

    expect(fetchFn.mock.calls.map(call => [call[0], call[1]?.method, call[1]?.body])).toEqual([
      [
        'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/parent%2Fid/children?drive=main',
        'POST',
        JSON.stringify({ name: 'note.txt', kind: 'file', content: 'hello' }),
      ],
      [
        'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/parent%2Fid/children?drive=main',
        'POST',
        JSON.stringify({ name: 'docs', kind: 'directory' }),
      ],
      [
        'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/source%2Fid',
        'PATCH',
        JSON.stringify({ drive: 'main', newName: 'renamed.txt', ifMatch: 4 }),
      ],
      ['http://gfsc-writer.gfs.svc.cluster.local:8087/v1/copy', 'POST', JSON.stringify(copy)],
    ])
  })

  it('fails loud when the mounted runtime token file is empty', async () => {
    const client = createGfscClient({
      get: () => undefined,
      readFile: async () => '  \n',
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
    })

    await expect(client.accessible({ drive: 'main' })).rejects.toThrow(
      /MCP_HOST_GFS_TOKEN_FILE is empty/
    )
  })

  it('surfaces gfsc authorization denials with the response body', async () => {
    const fetchFn = vi.fn(async () => textResponse('not authorized to write this resource', 403))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(
      client.write({ drive: 'main', resourceId: 'rid', content: 'new', ifMatch: 2 })
    ).rejects.toThrow(/gfsc 403: not authorized to write this resource/)
  })

  it('surfaces gfsc read denials with the response body', async () => {
    const fetchFn = vi.fn(async () => textResponse('not authorized to read this resource', 403))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.read({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 403: not authorized to read this resource/
    )
  })

  it('surfaces the fail-closed not_mounted envelope intact on resolve (issue #775)', async () => {
    // Regression guard: the Desktop App and the agent distinguish a permission
    // store outage (503 not_mounted) from an authorization denial (403) by the
    // ERROR BODY this client propagates. Softening or rewrapping it would turn
    // an infrastructure failure into an ambiguous tool error.
    const envelope = JSON.stringify({
      ok: false,
      error: {
        code: 'not_mounted',
        message:
          'permission store unavailable: password authentication failed for user "gfs_controller"',
      },
    })
    const fetchFn = vi.fn(async () => textResponse(envelope, 503))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.resolve({ uri: 'gfs://main/docs/report.md' })).rejects.toThrow(
      `gfsc 503: ${envelope}`
    )
  })

  it('surfaces gfsc transient failures with the status text when the body is empty', async () => {
    const fetchFn = vi.fn(async () => textResponse('', 503, 'Service Unavailable'))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.stat({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 503: Service Unavailable/
    )
  })

  it('surfaces gfsc list transient failures with the status text when the body is empty', async () => {
    const fetchFn = vi.fn(async () => textResponse('', 503, 'Service Unavailable'))
    const client = createGfscClient({
      get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
      fetch: fetchFn,
    })

    await expect(client.list({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 503: Service Unavailable/
    )
  })
})

const FILE_ID = '1234567890abcdef1234567890abcdef'
const FILE_URI = `gfs://main/${FILE_ID}`
const READ_ARGS = { drive: 'main', resourceId: FILE_ID }

function contentHarness(
  bytes: Buffer,
  options: {
    metadata?: Record<string, unknown>
    response?: () => Response
    headers?: Record<string, string>
  } = {}
) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (!_url.includes('/content?'))
      return jsonResponse({
        ok: true,
        data: {
          resourceId: FILE_ID,
          rid: FILE_ID,
          drive: 'main',
          gfsUri: FILE_URI,
          kind: 'file',
          name: 'neutral.png',
          version: 3,
          bytes: bytes.length,
          ...options.metadata,
        },
      })
    return (
      options.response?.() ??
      new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': 'application/octet-stream',
          'x-gfs-uri': FILE_URI,
          'x-gfs-version': '3',
          'content-length': String(bytes.length),
          ...options.headers,
        },
      })
    )
  })
  const client = createGfscClient({
    get: () => undefined,
    // Synthetic runtime identity for the injected HTTP boundary; never a real grant.
    readFile: async () => 'unit-gfs-read-identity',
    fetch: fetchFn,
  })
  const budget = new VisualInputBudget()
  return { client, fetchFn, budget }
}

describe('GFS binary content snapshots', () => {
  it('shares admission across live downloads and releases only the cancelled read', async () => {
    const bytes = Buffer.alloc(100_000, 65)
    const budget = new VisualInputBudget(300_000)
    const controller = new AbortController()
    let entered!: () => void
    const reading = new Promise<void>(resolve => {
      entered = resolve
    })
    let hold = true
    const cancelled = vi.fn()
    const { client, fetchFn } = contentHarness(bytes, {
      response: () =>
        new Response(
          hold
            ? new ReadableStream({
                pull() {
                  entered()
                },
                cancel: cancelled,
              })
            : new Uint8Array(bytes),
          {
            headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' },
          }
        ),
    })
    const first = client.read(READ_ARGS, { budget, signal: controller.signal })
    const rejectedFirst = expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await reading
    const heldBytes = budget.residentBytes
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(budget.residentBytes).toBe(heldBytes)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    controller.abort()
    await rejectedFirst
    expect(cancelled).toHaveBeenCalledOnce()
    expect(budget.residentBytes).toBe(0)
    hold = false
    const next = await client.read(READ_ARGS, { budget })
    expect(next.bytes.equals(bytes)).toBe(true)
    next.reservation.release()
    expect(budget.residentBytes).toBe(0)
  })

  it('reports a truncated stream without exposing its underlying error', async () => {
    const { client, budget } = contentHarness(Buffer.from('abc'), {
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('private stream detail'))
            },
          }),
          { headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' } }
        ),
    })
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'incomplete_response',
      message: 'GFS read failed (incomplete_response)',
    })
    expect(budget.residentBytes).toBe(0)
  })
  it('does not accumulate an invisible lifetime quota when independent reads reuse a client', async () => {
    const bytes = Buffer.alloc(VISUAL_INPUT_LIMITS.fileBytes, 65)
    const { client } = contentHarness(bytes, { metadata: { name: 'text.txt' } })
    for (let operation = 0; operation < 9; operation++) {
      const result = await client.read(READ_ARGS)
      expect(result.bytes.byteLength).toBe(bytes.byteLength)
      result.reservation.release()
    }
  })
  it('preserves complete PNG bytes and verified resource metadata', async () => {
    const canvas = createCanvas(2, 2)
    canvas.getContext('2d').fillRect(0, 0, 2, 2)
    const original = canvas.toBuffer('image/png')
    const { client, fetchFn, budget } = contentHarness(original)
    const result = await client.read(READ_ARGS, { budget })
    expect(result.bytes.equals(original)).toBe(true)
    expect(result.source).toMatchObject({ resourceId: FILE_ID, gfsUri: FILE_URI, version: 3 })
    expect(fetchFn.mock.calls.map(call => call[0])).toEqual([
      `http://gfsc.gfs.svc.cluster.local:8087/v1/resources/${FILE_ID}?drive=main`,
      `http://gfsc.gfs.svc.cluster.local:8087/v1/resources/${FILE_ID}/content?drive=main`,
    ])
    expect(fetchFn.mock.calls[1][1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
    expect(budget.readBytes).toBe(original.length)
    expect(budget.residentBytes).toBeGreaterThan(0)
    result.reservation.release()
    expect(budget.residentBytes).toBe(0)
  })

  it.each(['', 'Hola 🌴\r\n', '{"ok":false,"data":"file content"}'])(
    'preserves textual bytes without treating the file as an API envelope: %s',
    async text => {
      const { client, budget } = contentHarness(Buffer.from(text), {
        metadata: { name: 'data.json' },
      })
      const result = await client.read(READ_ARGS, { budget })
      expect(result.bytes.toString('utf8')).toBe(text)
      result.reservation.release()
      expect(budget.residentBytes).toBe(0)
    }
  )

  it.each([
    { version: -1 },
    { version: 1.5 },
    { bytes: -1 },
    { bytes: '3' },
    { drive: 'other' },
    { gfsUri: 'gfs://other/resource' },
    { rid: 'wrong' },
    { name: null },
  ])('rejects inconsistent metadata before content is requested: %j', async metadata => {
    const { client, fetchFn, budget } = contentHarness(Buffer.from('abc'), { metadata })
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'invalid_response',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.residentBytes).toBe(0)
  })

  it('rejects an oversized snapshot before downloading it', async () => {
    const { client, fetchFn, budget } = contentHarness(Buffer.alloc(0), {
      metadata: { bytes: VISUAL_INPUT_LIMITS.fileBytes + 1 },
    })
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.residentBytes).toBe(0)
  })

  it.each([
    [{ 'x-gfs-version': '4' }, 'version_conflict'],
    [{ 'x-gfs-uri': 'gfs://main/wrong' }, 'version_conflict'],
    [{ 'content-length': '2' }, 'incomplete_response'],
    [{ 'content-length': 'not-a-size' }, 'incomplete_response'],
    [{ 'content-encoding': 'gzip' }, 'invalid_response'],
  ] as const)('rejects contradictory content headers %j', async (headers, code) => {
    const { client, budget } = contentHarness(Buffer.from('abc'), { headers })
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({ code })
    expect(budget.residentBytes).toBe(0)
  })

  it('accepts exact chunked content without Content-Length', async () => {
    const { client, budget } = contentHarness(Buffer.from('abc'), {
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('a'))
              controller.enqueue(Buffer.from('bc'))
              controller.close()
            },
          }),
          { headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' } }
        ),
    })
    const result = await client.read(READ_ARGS, { budget })
    expect(result.bytes.toString()).toBe('abc')
    result.reservation.release()
  })

  it('cancels a chunked overrun before retaining extra bytes', async () => {
    const cancel = vi.fn()
    const { client, budget } = contentHarness(Buffer.from('abc'), {
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('abc'))
              controller.enqueue(Buffer.from('extra'))
            },
            cancel,
          }),
          { headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' } }
        ),
    })
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(cancel).toHaveBeenCalled()
    expect(budget.residentBytes).toBe(0)
    expect(budget.readBytes).toBe(8)
  })

  it('rejects short content and unsolicited partial responses', async () => {
    for (const status of [200, 206]) {
      const { client, budget } = contentHarness(Buffer.from('abc'), {
        response: () =>
          new Response('ab', { status, headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' } }),
      })
      await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
        code: status === 200 ? 'incomplete_response' : 'invalid_response',
      })
      expect(budget.residentBytes).toBe(0)
    }
  })

  it('does not fetch when the caller has already cancelled', async () => {
    const { client, fetchFn, budget } = contentHarness(Buffer.from('abc'))
    await expect(
      client.read(READ_ARGS, { budget, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('cancels an in-progress response stream and returns no partial image', async () => {
    const controller = new AbortController()
    const cancelled = vi.fn()
    let reading!: () => void
    const entered = new Promise<void>(resolve => {
      reading = resolve
    })
    const { client, budget } = contentHarness(Buffer.from('abc'), {
      response: () =>
        new Response(
          new ReadableStream({
            pull() {
              reading()
            },
            cancel: cancelled,
          }),
          { headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' } }
        ),
    })
    const result = client.read(READ_ARGS, { budget, signal: controller.signal })
    const failure = expect(result).rejects.toMatchObject({ code: 'cancelled' })
    await entered
    controller.abort()
    await failure
    expect(cancelled).toHaveBeenCalled()
    expect(budget.residentBytes).toBe(0)
  })

  it('cancels stat when the caller aborts and cleans its timer and listener', async () => {
    vi.useFakeTimers()
    try {
      const budget = new VisualInputBudget()
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      let entered!: () => void
      const reading = new Promise<void>(resolve => {
        entered = resolve
      })
      const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
        entered()
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('private detail')), {
            once: true,
          })
        })
      })
      const client = createGfscClient({
        get: () => undefined,
        readFile: async () => 'unit-gfs-read-identity',
        fetch: fetchFn,
      })
      const failure = expect(
        client.read(READ_ARGS, { budget, signal: controller.signal })
      ).rejects.toMatchObject({ code: 'cancelled' })
      await reading
      controller.abort()
      await failure
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(budget.residentBytes).toBe(0)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the entire metadata request by a deadline', async () => {
    vi.useFakeTimers()
    try {
      const budget = new VisualInputBudget()
      const client = createGfscClient({
        get: () => undefined,
        readFile: async () => 'unit-gfs-read-identity',
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(new Error('private upstream detail')),
              { once: true }
            )
          }),
      })
      const failed = expect(
        client.read(READ_ARGS, { budget, timeoutMs: 10 })
      ).rejects.toMatchObject({ code: 'timeout', message: 'GFS read failed (timeout)' })
      await vi.advanceTimersByTimeAsync(10)
      await failed
      expect(budget.residentBytes).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
