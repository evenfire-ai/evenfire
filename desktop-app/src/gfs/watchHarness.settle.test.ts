import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { AppServiceWatchHarness } from '../../testSupport/gfsWatch/appServiceHarness.js'
import {
  TEAM_1,
  USER_A,
  key,
  signV1SessionToken,
} from '../../testSupport/gfsWatch/sessionTokens.js'
import { WatchHarness } from '../../testSupport/gfsWatch/watchHarness.js'

// `settle()` of both watch harnesses waits for I/O still on the wire. Each case
// slows one step of the watch transport with a stub of the global `fetch` (the
// harnesses call it at request time), so a `settle()` that only compares state
// signatures returns before the slow step lands and the case fails.

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => false),
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const DELAY_MS = 150
const WATCH_PATH = '/api/v1/me/gfs/watch'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const realFetch = globalThis.fetch

type Slow = 'firstGet' | 'firstGetResponse' | 'getChunksAfterFirst' | 'firstPut' | 'getNeverSent'

/** Stubs the global `fetch`, slowing one step of the watch transport; counts what it slowed. */
function slowWatch(slow: Slow) {
  const stub = { gets: 0, puts: 0, delayed: 0, delayedChunks: 0 }
  const isWatch = (input: string | URL | Request) =>
    new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      .pathname === WATCH_PATH
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!isWatch(input)) return realFetch(input, init)
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      stub.gets += 1
      if (slow === 'getNeverSent') {
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      if (slow === 'firstGet' && stub.gets === 1) {
        stub.delayed += 1
        await sleep(DELAY_MS)
      }
      const res = await realFetch(input, init)
      if (slow === 'firstGetResponse' && stub.gets === 1) {
        stub.delayed += 1
        await sleep(DELAY_MS)
      }
      if (slow === 'getChunksAfterFirst' && res.body) {
        const reader = res.body.getReader()
        let chunks = 0
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              const r = await reader.read()
              if (r.done) {
                controller.close()
                return
              }
              chunks += 1
              if (chunks > 1) {
                stub.delayedChunks += 1
                await sleep(DELAY_MS)
              }
              controller.enqueue(r.value)
            },
            cancel: reason => reader.cancel(reason),
          },
          { highWaterMark: 0 }
        )
        return new Response(body, { status: res.status, headers: res.headers })
      }
      return res
    }
    if (method === 'PUT') {
      stub.puts += 1
      if (slow === 'firstPut' && stub.puts === 1) {
        stub.delayed += 1
        await sleep(DELAY_MS)
      }
    }
    return realFetch(input, init)
  })
  return stub
}

let watch: WatchHarness | undefined
let app: AppServiceWatchHarness | undefined

afterEach(async () => {
  try {
    await watch?.stop()
    await app?.stop()
  } finally {
    watch = undefined
    app = undefined
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

describe('watch harness settle() waits for I/O in flight', () => {
  it('a: a GET that leaves the client late is answered before login() returns', async () => {
    const stub = slowWatch('firstGet')
    watch = await new WatchHarness().start()
    await watch.login()
    expect(stub.delayed).toBe(1)
    expect(watch.server.gets).toHaveLength(1)
    expect(watch.linkKind()).toBe('Ready')
  })

  it('b: a GET response that reaches the client late is read before login() returns', async () => {
    const stub = slowWatch('firstGetResponse')
    watch = await new WatchHarness().start()
    await watch.login()
    expect(stub.delayed).toBe(1)
    expect(watch.linkKind()).toBe('Ready')
  })

  it('c: stream bytes the client reads late are delivered before settle() returns', async () => {
    const stub = slowWatch('getChunksAfterFirst')
    watch = await new WatchHarness().start()
    await watch.login()
    await watch.subscribe([key('file', 1)])
    watch.server.frame({ type: 'roots_changed' })
    await watch.settle()
    expect(stub.delayedChunks).toBeGreaterThanOrEqual(1)
    expect(watch.owner(1).ofType('accessChangedRoots')).toHaveLength(1)
  })

  it('d: a saved session restored at startup opens the watch over a late GET', async () => {
    const stub = slowWatch('firstGet')
    app = await new AppServiceWatchHarness().start()
    const saved = signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId: TEAM_1 })
    app.service.tokenStore.getSessionToken!.mockResolvedValue(saved)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await app.service.getSessionState()
    await app.settle()
    expect(stub.delayed).toBe(1)
    expect(app.server.gets.map(g => g.token)).toEqual([saved])
    expect(app.linkKind()).toBe('Ready')
  })

  it('e: a PUT that leaves the client late is applied before subscribe() returns', async () => {
    const stub = slowWatch('firstPut')
    app = await new AppServiceWatchHarness().start()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const token = signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId: TEAM_1 })
    const state = await app.login(token)
    const keys = [key('file', 1), key('dir', 2)]
    await app.subscribe(keys, state.me?.id ?? null)
    expect(stub.delayed).toBe(1)
    expect(app.server.puts).toHaveLength(1)
    expect(app.server.current()?.keys).toEqual(new Set(keys))
  })

  it('f: settle() throws, naming the request, when a GET never reaches the server', async () => {
    const stub = slowWatch('getNeverSent')
    watch = await new WatchHarness().start()
    watch.client.onSessionToken(watch.token())
    await expect(watch.settle(100)).rejects.toThrow(
      /not quiet after 100 ms.*GET \/api\/v1\/me\/gfs\/watch \(not received/
    )
    expect(stub.gets).toBe(1)
    expect(watch.server.gets).toEqual([])
    // stop() disposes the client, whose abort of the GET leaves nothing on the wire.
    const stopped = watch
    watch = undefined
    await stopped.stop()
  })

  it('g: the AppService harness settle timeout names the session token only by its digest', async () => {
    const stub = slowWatch('getNeverSent')
    app = await new AppServiceWatchHarness().start()
    const saved = signV1SessionToken({ userId: USER_A, authGeneration: 1, teamId: TEAM_1 })
    app.service.tokenStore.getSessionToken!.mockResolvedValue(saved)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await app.service.getSessionState()
    const error = await app.settle(100).then(
      () => null,
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toMatch(/not quiet after 100 ms.*last signature: \[/)
    expect(stub.gets).toBe(1)
    expect(app.service.sessionToken).toBe(saved)
    expect(message).not.toContain(saved)
    expect(message).toContain(createHash('sha256').update(saved).digest('hex').slice(0, 16))
    const stopped = app
    app = undefined
    await stopped.stop()
  })
})
