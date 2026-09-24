import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { VISUAL_INPUT_LIMITS, VisualInputBudget } from '../visualInput/policy'
import type { GfscCallOptions, GfscWriteClient } from './gfs'
import {
  DEFAULT_GFS_ACCESS_FILE,
  type GfsRuntimeEnv,
  type GfsToolScopeInspection,
  GfscHttpError,
  createGfscClient,
  getGfsToolScopes,
  hasGfsRuntimeAccess,
  inspectGfsToolScopes,
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

// Every test client gets a budget far above any Retry-After used here, and a
// random source of 0 so the retry waits exactly the advertised delay.
const clientOptions = { maxRetryWaitMs: 60_000, random: () => 0 }

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

  describe('inspectGfsToolScopes (#666)', () => {
    const enoent = () =>
      Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
        syscall: 'open',
      })
    const fileEnv = (configuredPath: string | undefined, read: (path: string) => string) => ({
      get: (key: string) => (key === 'MCP_HOST_GFS_TOKEN_FILE' ? configuredPath : undefined),
      readFileSync: read,
    })

    it('reports each token state, and getGfsToolScopes keeps its answer for each', () => {
      const cases: [GfsRuntimeEnv, GfsToolScopeInspection, string[] | null][] = [
        [
          { get: () => encodedClaims(['gfs.read', 'gfs.write']) },
          { status: 'ok', scopes: new Set(['gfs.read', 'gfs.write']) },
          ['gfs.read', 'gfs.write'],
        ],
        [{ get: () => encodedClaims([]) }, { status: 'ok', scopes: new Set() }, null],
        [
          { get: () => encodedClaims(['gfs.read', 'gfs.share']) },
          { status: 'scope_outside_allowlist' },
          null,
        ],
        [{ get: () => 'malformed' }, { status: 'token_undecodable' }, null],
        [{ get: () => encodedClaims('gfs.read') }, { status: 'token_undecodable' }, null],
        [
          fileEnv(undefined, () => {
            throw enoent()
          }),
          { status: 'not_configured' },
          null,
        ],
        [
          fileEnv('/mounted/token', () => {
            throw enoent()
          }),
          { status: 'token_unreadable' },
          null,
        ],
        [
          fileEnv(undefined, () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES', syscall: 'open' })
          }),
          { status: 'token_unreadable' },
          null,
        ],
        [fileEnv(undefined, () => ' \n'), { status: 'token_unreadable' }, null],
        [
          fileEnv('/mounted/token', () => `${encodedClaims(['gfs.read'])}\n`),
          { status: 'ok', scopes: new Set(['gfs.read']) },
          ['gfs.read'],
        ],
      ]
      for (const [env, inspection, scopes] of cases) {
        expect(inspectGfsToolScopes(env)).toEqual(inspection)
        const legacy = getGfsToolScopes(env)
        expect(legacy === null ? null : [...legacy]).toEqual(scopes)
      }
    })

    it('reads the configured token file, or the default path when none is configured', () => {
      const read = vi.fn((_path: string) => encodedClaims(['gfs.read']))
      inspectGfsToolScopes(fileEnv('/mounted/token', read))
      inspectGfsToolScopes(fileEnv(undefined, read))
      expect(read.mock.calls.map(call => call[0])).toEqual([
        '/mounted/token',
        DEFAULT_GFS_ACCESS_FILE,
      ])
    })
  })

  it('calls gfsc accessible with runtime bearer auth', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [] } })
    )
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )
    await client.accessible({ drive: 'main' })
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://gfsc.gfs.svc.cluster.local:8087/v1/accessible?drive=main'
    )
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer gfs-access',
    })
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })

  it('routes writes to the gfsc writer service with conditional body', async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { version: 3 } })
    )
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )
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
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )
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
    const client = createGfscClient(
      {
        get: () => undefined,
        readFile: async () => '  \n',
        fetch: vi.fn(async () => jsonResponse({ ok: true })),
      },
      clientOptions
    )

    await expect(client.accessible({ drive: 'main' })).rejects.toThrow(
      /MCP_HOST_GFS_TOKEN_FILE is empty/
    )
  })

  it('surfaces gfsc authorization denials with the response body', async () => {
    const fetchFn = vi.fn(async () => textResponse('not authorized to write this resource', 403))
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )

    await expect(
      client.write({ drive: 'main', resourceId: 'rid', content: 'new', ifMatch: 2 })
    ).rejects.toThrow(/gfsc 403: not authorized to write this resource/)
  })

  it('surfaces gfsc read denials with the response body', async () => {
    const fetchFn = vi.fn(async () => textResponse('not authorized to read this resource', 403))
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )

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
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )

    await expect(client.resolve({ uri: 'gfs://main/docs/report.md' })).rejects.toThrow(
      `gfsc 503: ${envelope}`
    )
  })

  it('surfaces gfsc transient failures with the status text when the body is empty', async () => {
    const fetchFn = vi.fn(async () => textResponse('', 503, 'Service Unavailable'))
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )

    await expect(client.stat({ drive: 'main', resourceId: 'rid' })).rejects.toThrow(
      /gfsc 503: Service Unavailable/
    )
  })

  it('surfaces gfsc list transient failures with the status text when the body is empty', async () => {
    const fetchFn = vi.fn(async () => textResponse('', 503, 'Service Unavailable'))
    const client = createGfscClient(
      {
        get: key => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
        fetch: fetchFn,
      },
      clientOptions
    )

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
  const client = createGfscClient(
    {
      get: () => undefined,
      // Synthetic runtime identity for the injected HTTP boundary; never a real grant.
      readFile: async () => 'unit-gfs-read-identity',
      fetch: fetchFn,
    },
    clientOptions
  )
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
    [{ 'x-gfs-uri': 'gfs://main/wrong' }, 'identity_mismatch'],
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

  it('cancels a chunked overrun without retaining extra bytes or refunding read work', async () => {
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

  it('charges rejected first chunks across retries and stops at the turn read limit', async () => {
    const { client, fetchFn } = contentHarness(Buffer.from('abc'), {
      response: () =>
        new Response(new Uint8Array(Buffer.from('over')), {
          headers: { 'x-gfs-uri': FILE_URI, 'x-gfs-version': '3' },
        }),
    })
    const budget = new VisualInputBudget(200_000, 8)

    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(budget.readBytes).toBe(4)
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(budget.readBytes).toBe(8)
    await expect(client.read(READ_ARGS, { budget })).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(budget.residentBytes).toBe(0)
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
      const client = createGfscClient(
        {
          get: () => undefined,
          readFile: async () => 'unit-gfs-read-identity',
          fetch: fetchFn,
        },
        clientOptions
      )
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
      const client = createGfscClient(
        {
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
        },
        clientOptions
      )
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

// gfsc's agent limiter names its bucket in X-GFS-RateLimit-Scope
// (serve.ts: `limit: write ? "agent_writes" : "agent_reads"`); only those
// scopes are retried.
function rateLimited(retryAfter?: string, scope = 'agent_reads'): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-gfs-ratelimit-scope': scope,
  }
  if (retryAfter !== undefined) headers['retry-after'] = retryAfter
  // gfsc's envelope also carries retryAfterSeconds; the client reads only the
  // header, so the no-header cases below prove the body is never consulted.
  return new Response(
    JSON.stringify({ ok: false, error: { code: 'rate_limited', retryAfterSeconds: 5 } }),
    { status: 429, headers }
  )
}

function tokenEnv(fetchFn: (input: string, init?: RequestInit) => Promise<Response>) {
  return {
    get: (key: string) => (key === 'MCP_HOST_GFS_TOKEN' ? 'gfs-access' : undefined),
    fetch: fetchFn,
  }
}

describe('gfsc client on a 429', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries once after the stated delay and resolves', async () => {
    vi.useFakeTimers()
    const callTimes: number[] = []
    const fetchFn = vi.fn(async () => {
      callTimes.push(Date.now())
      return callTimes.length === 1 ? rateLimited('2') : jsonResponse({ ok: true, version: 4 })
    })
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

    const pending = client.stat({ drive: 'main', resourceId: 'rid' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await expect(pending).resolves.toEqual({ ok: true, version: 4 })
    expect(callTimes[1]! - callTimes[0]!).toBe(2000)
  })

  it('waits exactly the advertised Retry-After, not a constant', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const bytes = Buffer.from('rate-limited read')
    const { client, fetchFn, budget } = contentHarness(bytes)
    fetchFn.mockResolvedValueOnce(rateLimited('7'))

    const pending = client.read(READ_ARGS, { budget })
    await vi.advanceTimersByTimeAsync(0)
    expect(setTimeoutSpy.mock.calls.map(call => call[1])).toContain(7000)
    await vi.advanceTimersByTimeAsync(6999)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const file = await pending
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(file.bytes).toEqual(bytes)
    file.reservation.release()
    expect(budget.residentBytes).toBe(0)
  })

  it('retries a content 429 without discarding the validated metadata snapshot', async () => {
    vi.useFakeTimers()
    const bytes = Buffer.from('content after retry')
    let contentCalls = 0
    const { client, fetchFn, budget } = contentHarness(bytes, {
      response: () =>
        ++contentCalls === 1
          ? rateLimited('2')
          : new Response(new Uint8Array(bytes), {
              headers: {
                'x-gfs-uri': FILE_URI,
                'x-gfs-version': '3',
                'content-length': String(bytes.length),
              },
            }),
    })
    const pending = client.read(READ_ARGS, { budget })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    const file = await pending
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(file.source).toMatchObject({ gfsUri: FILE_URI, version: 3 })
    expect(file.bytes).toEqual(bytes)
    file.reservation.release()
    expect(budget.residentBytes).toBe(0)
  })

  it('rejects a changed content version after retry', async () => {
    vi.useFakeTimers()
    const bytes = Buffer.from('replaced content')
    let contentCalls = 0
    const { client, budget } = contentHarness(bytes, {
      response: () =>
        ++contentCalls === 1
          ? rateLimited('1')
          : new Response(new Uint8Array(bytes), {
              headers: {
                'x-gfs-uri': FILE_URI,
                'x-gfs-version': '4',
                'content-length': String(bytes.length),
              },
            }),
    })
    const pending = client.read(READ_ARGS, { budget })
    const failure = expect(pending).rejects.toMatchObject({ code: 'version_conflict' })
    await vi.advanceTimersByTimeAsync(1000)
    await failure
    expect(contentCalls).toBe(2)
    expect(budget.residentBytes).toBe(0)
  })

  it('bounds a 429 error body before deciding whether its header permits retry', async () => {
    vi.useFakeTimers()
    const bytes = Buffer.from('bounded retry')
    const { client, fetchFn, budget } = contentHarness(bytes)
    fetchFn.mockResolvedValueOnce(
      new Response('x'.repeat(VISUAL_INPUT_LIMITS.errorBytes + 1), {
        status: 429,
        headers: { 'retry-after': '1', 'x-gfs-ratelimit-scope': 'agent_reads' },
      })
    )
    const pending = client.read(READ_ARGS, { budget })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    const file = await pending
    expect(file.bytes).toEqual(bytes)
    expect(fetchFn).toHaveBeenCalledTimes(3)
    file.reservation.release()
    expect(budget.residentBytes).toBe(0)
  })

  it('cancels a read during Retry-After without issuing another request', async () => {
    vi.useFakeTimers()
    const { client, fetchFn, budget } = contentHarness(Buffer.from('never read'))
    fetchFn.mockResolvedValueOnce(rateLimited('20'))
    const controller = new AbortController()
    const pending = client.read(READ_ARGS, { budget, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.residentBytes).toBe(0)
  })

  it('bounds a hanging 429 body by the single read deadline', async () => {
    vi.useFakeTimers()
    const { client, fetchFn, budget } = contentHarness(Buffer.from('never read'))
    fetchFn.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 429,
        headers: { 'retry-after': '1', 'x-gfs-ratelimit-scope': 'agent_reads' },
      })
    )
    const pending = client.read(READ_ARGS, { budget, timeoutMs: 10 })
    const failure = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(10)
    await failure
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.residentBytes).toBe(0)
  })

  it('gives up after one retry and keeps the hint on the thrown error', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => rateLimited('2'))
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

    const rejection = expect(
      client.write({ drive: 'main', resourceId: 'rid', content: 'x', ifMatch: 1 })
    ).rejects.toMatchObject({
      name: 'GfscHttpError',
      status: 429,
      retryAfterSeconds: 2,
      message: expect.stringMatching(/^gfsc 429: .* \(retry after 2s\)$/),
    })
    await vi.advanceTimersByTimeAsync(2000)
    await rejection
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['absent', undefined],
    ['an HTTP-date', 'Wed, 23 Sep 2026 10:00:00 GMT'],
    ['zero', '0'],
    ['fractional', '1.5'],
  ])('throws at once without retrying when Retry-After is %s', async (_label, retryAfter) => {
    vi.useFakeTimers()
    const answers = [rateLimited(retryAfter), rateLimited('1'), jsonResponse({ ok: true })]
    const fetchFn = vi.fn(async () => answers.shift()!)
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

    const error = await client.stat({ drive: 'main', resourceId: 'rid' }).catch(e => e)
    expect(error).toBeInstanceOf(GfscHttpError)
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: undefined })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // Control on the same client: a 429 with a usable hint is retried, so
    // the single call above is the hint check at work, not a missing retry.
    const control = client.stat({ drive: 'main', resourceId: 'rid' })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(control).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('throws at once with the hint when Retry-After exceeds the tool budget', async () => {
    vi.useFakeTimers()
    const answers = [rateLimited('30'), rateLimited('10'), jsonResponse({ ok: true })]
    const fetchFn = vi.fn(async () => answers.shift()!)
    const client = createGfscClient(tokenEnv(fetchFn), { maxRetryWaitMs: 10_000, random: () => 0 })

    const error = await client.stat({ drive: 'main', resourceId: 'rid' }).catch(e => e)
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 30 })
    expect((error as Error).message).toContain('(retry after 30s)')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // Control at the boundary: a delay equal to the budget is still waited out.
    const control = client.stat({ drive: 'main', resourceId: 'rid' })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(control).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('does not retry any other status, even with a Retry-After header', async () => {
    vi.useFakeTimers()
    const answers = [
      new Response('unavailable', { status: 503, headers: { 'retry-after': '2' } }),
      rateLimited('2'),
      jsonResponse({ ok: true }),
    ]
    const fetchFn = vi.fn(async () => answers.shift()!)
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

    const error = await client.stat({ drive: 'main', resourceId: 'rid' }).catch(e => e)
    expect(error).toMatchObject({ status: 503, message: 'gfsc 503: unavailable' })
    expect(error).toMatchObject({ retryAfterSeconds: undefined })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // Control: the same header on a 429 is honoured.
    const control = client.stat({ drive: 'main', resourceId: 'rid' })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(control).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('rejects a construction without a usable retry budget', () => {
    const env = tokenEnv(vi.fn(async () => jsonResponse({})))
    expect(() => createGfscClient(env, { maxRetryWaitMs: Number.NaN })).toThrow(
      /maxRetryWaitMs must be a non-negative number/
    )
    expect(() => createGfscClient(env, { maxRetryWaitMs: -1 })).toThrow(
      /maxRetryWaitMs must be a non-negative number/
    )
    expect(createGfscClient(env, { maxRetryWaitMs: 0 })).toHaveProperty('stat')
  })
})

describe('gfsc client retry: cancellation, deadline, scope and jitter', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('M1: an abort during the Retry-After sleep rejects at once and never sends the retry', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => rateLimited('45', 'agent_writes'))
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)
    const controller = new AbortController()

    const pending = client
      .write(
        { drive: 'main', resourceId: 'rid', content: 'x', ifMatch: 1 },
        { signal: controller.signal }
      )
      .catch(e => e)
    await vi.advanceTimersByTimeAsync(0)
    // Witness: the first attempt was sent and the client is now sleeping.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('AbortError')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('M1: the caller signal reaches both the first request and the retry', async () => {
    vi.useFakeTimers()
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchFn = vi.fn(async (_input: string, init?: RequestInit) => {
      signals.push(init?.signal)
      return signals.length === 1 ? rateLimited('2') : jsonResponse({ ok: true })
    })
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)
    const controller = new AbortController()

    const pending = client.stat({ drive: 'main', resourceId: 'rid' }, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toEqual({ ok: true })
    expect(signals).toEqual([controller.signal, controller.signal])
  })

  it('M1: a Retry-After beyond the remaining deadline fails at once', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => rateLimited('2'))
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

    const error = await client
      .stat({ drive: 'main', resourceId: 'rid' }, { deadlineMs: Date.now() + 1500 })
      .catch(e => e)
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 2 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('M1: the jittered wait is cut at the remaining deadline', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    let calls = 0
    const fetchFn = vi.fn(async () => (++calls === 1 ? rateLimited('2') : jsonResponse({})))
    const client = createGfscClient(tokenEnv(fetchFn), {
      maxRetryWaitMs: 60_000,
      random: () => 0.5,
    })

    const pending = client.stat(
      { drive: 'main', resourceId: 'rid' },
      { deadlineMs: Date.now() + 2100 }
    )
    await vi.advanceTimersByTimeAsync(0)
    // 2000 ms + 200 ms of jitter would pass the deadline, so the wait is 2100 ms.
    expect(setTimeoutSpy.mock.calls.map(call => call[1])).toEqual([2100])
    await vi.advanceTimersByTimeAsync(2100)
    await expect(pending).resolves.toEqual({})
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  // Every method, not only stat: a method that drops `call` would sleep past
  // the step's remaining time and could not be cancelled.
  const EVERY_METHOD: Array<[string, (client: GfscWriteClient, call: GfscCallOptions) => unknown]> =
    [
      ['accessible', (client, call) => client.accessible({ drive: 'main' }, call)],
      ['list', (client, call) => client.list({ drive: 'main', resourceId: 'rid' }, call)],
      ['stat', (client, call) => client.stat({ drive: 'main', resourceId: 'rid' }, call)],
      ['resolve', (client, call) => client.resolve({ uri: 'gfs://main/a.txt' }, call)],
      [
        'write',
        (client, call) =>
          client.write({ drive: 'main', resourceId: 'rid', content: 'x', ifMatch: 1 }, call),
      ],
      [
        'createFile',
        (client, call) =>
          client.createFile(
            { drive: 'main', parentResourceId: 'pid', name: 'a.txt', content: 'x' },
            call
          ),
      ],
      [
        'createFolder',
        (client, call) =>
          client.createFolder({ drive: 'main', parentResourceId: 'pid', name: 'dir' }, call),
      ],
      [
        'rename',
        (client, call) =>
          client.rename({ drive: 'main', resourceId: 'rid', newName: 'b.txt', ifMatch: 1 }, call),
      ],
      [
        'copy',
        (client, call) =>
          client.copy(
            {
              drive: 'main',
              sourceResourceId: 'rid',
              destinationParentId: 'pid',
              ifMatch: 1,
            },
            call
          ),
      ],
    ]

  it.each(EVERY_METHOD)('M1: %s passes the caller signal to fetch', async (_name, invoke) => {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetchFn = vi.fn(async (_input: string, init?: RequestInit) => {
      signals.push(init?.signal)
      return jsonResponse({ ok: true })
    })
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)
    const controller = new AbortController()

    await expect(invoke(client, { signal: controller.signal })).resolves.toEqual({ ok: true })
    expect(signals).toEqual([controller.signal])
  })

  it('M1: read shares one cancel signal across metadata and content', async () => {
    const bytes = Buffer.from('granted file content')
    const { client, fetchFn, budget } = contentHarness(bytes)
    const controller = new AbortController()
    const file = await client.read(READ_ARGS, { budget, signal: controller.signal })
    const signals = fetchFn.mock.calls.map(([, init]) => init?.signal)
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[0]).not.toBe(controller.signal)
    file.reservation.release()
  })

  it('M1: read refuses a retry beyond the caller deadline', async () => {
    const { client, fetchFn, budget } = contentHarness(Buffer.from('body'))
    fetchFn.mockResolvedValueOnce(rateLimited('2'))
    const error = await client
      .read(READ_ARGS, { budget, deadlineMs: Date.now() + 1500 })
      .catch(e => e)
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 2 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.residentBytes).toBe(0)
  })

  it('keeps the typed 429 hint when content retry cannot fit the read deadline', async () => {
    const { client, fetchFn, budget } = contentHarness(Buffer.from('body'), {
      response: () => rateLimited('2'),
    })
    const error = await client
      .read(READ_ARGS, { budget, deadlineMs: Date.now() + 1500 })
      .catch(e => e)
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 2 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(budget.residentBytes).toBe(0)
  })

  it.each(EVERY_METHOD)('M1: %s bounds the retry by the caller deadline', async (_name, invoke) => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => rateLimited('2', 'agent_writes'))
    const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

    // Retry-After 2 s is within maxRetryWaitMs but not within the deadline.
    const error = await Promise.resolve(invoke(client, { deadlineMs: Date.now() + 1500 })).catch(
      e => e
    )
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 2 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('L17: the retry waits Retry-After plus the injected jitter', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    let calls = 0
    const fetchFn = vi.fn(async () => (++calls === 1 ? rateLimited('2') : jsonResponse({})))
    const client = createGfscClient(tokenEnv(fetchFn), {
      maxRetryWaitMs: 60_000,
      random: () => 0.5,
    })

    const pending = client.stat({ drive: 'main', resourceId: 'rid' })
    await vi.advanceTimersByTimeAsync(0)
    // Jitter is random × min(1000, 0.2 × 2000) = 0.5 × 400 = 200 ms.
    expect(setTimeoutSpy.mock.calls.map(call => call[1])).toEqual([2200])
    await vi.advanceTimersByTimeAsync(2199)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await expect(pending).resolves.toEqual({})
  })

  it('L17: the jitter never exceeds one second for long delays', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    let calls = 0
    const fetchFn = vi.fn(async () => (++calls === 1 ? rateLimited('30') : jsonResponse({})))
    const client = createGfscClient(tokenEnv(fetchFn), {
      maxRetryWaitMs: 60_000,
      random: () => 0.999,
    })

    const pending = client.stat({ drive: 'main', resourceId: 'rid' })
    await vi.advanceTimersByTimeAsync(0)
    expect(setTimeoutSpy.mock.calls.map(call => call[1])).toEqual([30_999])
    await vi.advanceTimersByTimeAsync(30_999)
    await expect(pending).resolves.toEqual({})
  })

  it.each(['active_sessions_subject', 'upload_bytes_subject', undefined])(
    'L16/I1: a 429 with scope %s is surfaced at once with its hint',
    async scope => {
      vi.useFakeTimers()
      const headers: Record<string, string> = { 'retry-after': '2' }
      if (scope !== undefined) headers['x-gfs-ratelimit-scope'] = scope
      const answers = [
        new Response('{}', { status: 429, headers }),
        rateLimited('2', 'agent_reads'),
        jsonResponse({ ok: true }),
      ]
      const fetchFn = vi.fn(async () => answers.shift()!)
      const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

      const error = await client.stat({ drive: 'main', resourceId: 'rid' }).catch(e => e)
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 2 })
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)

      // Control on the same client: an agent scope is retried.
      const control = client.stat({ drive: 'main', resourceId: 'rid' })
      await vi.advanceTimersByTimeAsync(2000)
      await expect(control).resolves.toEqual({ ok: true })
      expect(fetchFn).toHaveBeenCalledTimes(3)
    }
  )

  it('L15: Retry-After accepts 1..3600 and drops anything larger', async () => {
    vi.useFakeTimers()
    const values = ['1', '3600', '3601', '99999', '100000000000000000000000']
    const fetchFn = vi.fn(async () => rateLimited(values.shift()!))
    // maxRetryWaitMs 0 means no retry is ever slept, so only the parse is observed.
    const client = createGfscClient(tokenEnv(fetchFn), { maxRetryWaitMs: 0, random: () => 0 })
    const hintFor = async (value: string) => {
      expect(values[0]).toBe(value)
      const error = (await client
        .stat({ drive: 'main', resourceId: 'rid' })
        .catch(e => e)) as GfscHttpError
      expect(error).toBeInstanceOf(GfscHttpError)
      return error.retryAfterSeconds
    }

    expect(await hintFor('1')).toBe(1)
    expect(await hintFor('3600')).toBe(3600)
    expect(await hintFor('3601')).toBeUndefined()
    expect(await hintFor('99999')).toBeUndefined()
    expect(await hintFor('100000000000000000000000')).toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(5)
  })

  it.each([
    [
      'write',
      'PUT',
      'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/rid/content?drive=main',
    ],
    [
      'createFile',
      'POST',
      'http://gfsc-writer.gfs.svc.cluster.local:8087/v1/resources/parent/children?drive=main',
    ],
  ] as const)(
    'M6: the %s retry repeats the same method, URL, body and credential',
    async (method, verb, url) => {
      vi.useFakeTimers()
      const sent: Array<{ url: string; init: RequestInit }> = []
      const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
        sent.push({ url: input, init: init! })
        return sent.length === 1 ? rateLimited('2', 'agent_writes') : jsonResponse({ ok: true })
      })
      const client = createGfscClient(tokenEnv(fetchFn), clientOptions)

      const pending =
        method === 'write'
          ? client.write({ drive: 'main', resourceId: 'rid', content: 'body-1', ifMatch: 7 })
          : client.createFile({
              drive: 'main',
              parentResourceId: 'parent',
              name: 'a.txt',
              content: 'body-1',
            })
      await vi.advanceTimersByTimeAsync(2000)
      await expect(pending).resolves.toEqual({ ok: true })

      expect(sent).toHaveLength(2)
      const [first, retry] = sent.map(({ url: sentUrl, init }) => ({
        url: sentUrl,
        method: init.method,
        body: init.body,
        authorization: (init.headers as Record<string, string>).authorization,
      }))
      expect(first).toEqual({
        url,
        method: verb,
        body: expect.stringContaining('"body-1"'),
        authorization: 'Bearer gfs-access',
      })
      expect(retry).toEqual(first)
    }
  )
})
