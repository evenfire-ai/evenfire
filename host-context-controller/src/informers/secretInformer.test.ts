import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { fakeSecretApiserver } from '../__tests__/fakeSecretApiserver'
import { hccLogger } from '../logger'
import { registry } from '../metrics'
import { SecretEvent, SecretInformer, SecretInformerMode, WatchLike } from './secretInformer'

/**
 * Tests for the SecretInformer — watches Secrets in a namespace and relays
 * ADDED / MODIFIED / DELETED events to a consumer. Must reconnect with
 * exponential backoff on disconnect and stop cleanly on demand.
 */

type WatchCallback = (phase: string, apiObj: unknown) => void
type DoneCallback = (err: Error | null) => void

interface WatchCall {
  path: string
  cb: WatchCallback
  done: DoneCallback
  abort: () => void
}

function createWatchStub() {
  const calls: WatchCall[] = []
  const watchFn = vi.fn(
    async (path: string, _qs: Record<string, unknown>, cb: WatchCallback, done: DoneCallback) => {
      const abort = vi.fn()
      const ctrl = { abort } as unknown as AbortController
      calls.push({ path, cb, done, abort })
      return ctrl
    }
  )
  return { watchFn, calls }
}

describe('SecretInformer', () => {
  let watchFn: ReturnType<typeof createWatchStub>['watchFn']
  let calls: WatchCall[]
  let onEvent: ReturnType<typeof vi.fn<(evt: SecretEvent) => void>>
  let informer: SecretInformer

  beforeEach(() => {
    const stub = createWatchStub()
    watchFn = stub.watchFn
    calls = stub.calls

    onEvent = vi.fn<(evt: SecretEvent) => void>()
    const kc = {} as k8s.KubeConfig
    const watchLike: WatchLike = { watch: watchFn }
    informer = new SecretInformer(
      kc,
      'mcp-server',
      onEvent,
      { mode: 'replay' },
      { watch: watchLike }
    )
  })

  afterEach(() => {
    informer.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('start() performs initial list+watch against the correct path', async () => {
    await expect(informer.start()).resolves.toBe(true)

    expect(watchFn).toHaveBeenCalledTimes(1)
    expect(calls[0].path).toBe('/api/v1/namespaces/mcp-server/secrets')
  })

  it('ADDED event triggers the consumer callback', async () => {
    await informer.start()

    calls[0].cb('ADDED', {
      metadata: { name: 'pg-credentials', namespace: 'mcp-server' },
    })

    expect(onEvent).toHaveBeenCalledWith({
      type: 'ADDED',
      name: 'pg-credentials',
      namespace: 'mcp-server',
    })
  })

  it('MODIFIED and DELETED events also propagate', async () => {
    await informer.start()
    calls[0].cb('MODIFIED', { metadata: { name: 's1', namespace: 'mcp-server' } })
    calls[0].cb('DELETED', { metadata: { name: 's2', namespace: 'mcp-server' } })

    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onEvent.mock.calls[0][0].type).toBe('MODIFIED')
    expect(onEvent.mock.calls[1][0].type).toBe('DELETED')
  })

  it('ignores non-standard watch phases (BOOKMARK, ERROR)', async () => {
    await informer.start()
    calls[0].cb('BOOKMARK', { metadata: { name: 'x', namespace: 'mcp-server' } })
    calls[0].cb('ERROR', {})

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('ignores events without metadata.name', async () => {
    await informer.start()
    calls[0].cb('ADDED', {})
    calls[0].cb('ADDED', { metadata: {} })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reconnects at the base delay after a healthy watch closes', async () => {
    vi.useFakeTimers()

    await informer.start()
    expect(watchFn).toHaveBeenCalledTimes(1)

    // Simulate a server-side disconnect of an established stream.
    calls[0].done(new Error('stream ended'))

    await vi.advanceTimersByTimeAsync(999)
    expect(watchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(watchFn).toHaveBeenCalledTimes(2)

    // A second healthy close must not climb — that was the quiet-namespace cap.
    calls[1].done(new Error('stream ended again'))
    await vi.advanceTimersByTimeAsync(999)
    expect(watchFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2)
    expect(watchFn).toHaveBeenCalledTimes(3)
  })

  it('still climbs backoff when watch establishment fails', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    watchFn.mockRejectedValue(new Error('forbidden'))

    await expect(informer.start()).resolves.toBe(false)
    expect(watchFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(watchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(watchFn).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1999)
    expect(watchFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(watchFn).toHaveBeenCalledTimes(3)
    warnSpy.mockRestore()
  })

  it('climbs backoff when Watch.watch calls done(err) then resolves (client 1.4.0)', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    watchFn.mockImplementation(
      async (path: string, _qs: Record<string, unknown>, cb: WatchCallback, done: DoneCallback) => {
        const abort = vi.fn()
        const ctrl = { abort } as unknown as AbortController
        calls.push({ path, cb, done, abort })
        done(new Error('Forbidden'))
        return ctrl
      }
    )

    await expect(informer.start()).resolves.toBe(false)
    expect(watchFn).toHaveBeenCalledTimes(1)
    expect(calls[0].abort).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(999)
    expect(watchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(watchFn).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1999)
    expect(watchFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(watchFn).toHaveBeenCalledTimes(3)
    warnSpy.mockRestore()
  })

  it('resets backoff on successful establish so a quiet namespace reconnects at 1s', async () => {
    vi.useFakeTimers()

    await informer.start()
    expect(watchFn).toHaveBeenCalledTimes(1)

    // No Secret events — the pre-#461 reset was unreachable here.
    calls[0].done(null)
    await vi.advanceTimersByTimeAsync(999)
    expect(watchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(watchFn).toHaveBeenCalledTimes(2)

    calls[1].done(null)
    await vi.advanceTimersByTimeAsync(999)
    expect(watchFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2)
    expect(watchFn).toHaveBeenCalledTimes(3)
  })

  it('resets backoff on successful event after reconnect', async () => {
    vi.useFakeTimers()

    await informer.start()
    calls[0].done(new Error('boom'))

    await vi.advanceTimersByTimeAsync(1001)
    expect(watchFn).toHaveBeenCalledTimes(2)

    // A successful event should reset backoff back to 1s for the next reconnect.
    calls[1].cb('ADDED', { metadata: { name: 's', namespace: 'mcp-server' } })
    calls[1].done(new Error('boom 2'))

    await vi.advanceTimersByTimeAsync(1001)
    expect(watchFn).toHaveBeenCalledTimes(3)
  })

  it('stop() aborts the active watch and prevents reconnects', async () => {
    vi.useFakeTimers()
    await informer.start()

    const firstCall = calls[0]
    informer.stop()

    expect(firstCall.abort).toHaveBeenCalled()

    // Trigger a disconnect after stop — must not reconnect.
    calls[0].done(new Error('post-stop'))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(watchFn).toHaveBeenCalledTimes(1)
  })

  it('swallows errors thrown by consumer callback', async () => {
    await informer.start()
    onEvent.mockImplementation(() => {
      throw new Error('consumer exploded')
    })

    // Must not throw — informer is resilient to consumer bugs.
    expect(() =>
      calls[0].cb('ADDED', { metadata: { name: 's', namespace: 'mcp-server' } })
    ).not.toThrow()
  })

  it('returns degraded startup status when the initial watch cannot be established', async () => {
    vi.useFakeTimers()
    watchFn.mockRejectedValueOnce(new Error('forbidden'))

    await expect(informer.start()).resolves.toBe(false)

    expect(watchFn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1001)
    expect(watchFn).toHaveBeenCalledTimes(2)
  })

  it('B11 replay mode watches without a resourceVersion on every connect and never lists', async () => {
    vi.useFakeTimers()
    const list = vi.fn()
    const replay = new SecretInformer(
      {} as k8s.KubeConfig,
      'channels',
      onEvent,
      // A list handed to a replay-mode informer must stay unused.
      { mode: 'replay', list } as unknown as SecretInformerMode,
      { watch: { watch: watchFn } }
    )
    try {
      await expect(replay.start()).resolves.toBe(true)
      calls[0].done(new Error('Premature close'))
      await vi.advanceTimersByTimeAsync(1000)

      expect(watchFn).toHaveBeenCalledTimes(2)
      expect(watchFn.mock.calls.map(call => call[1])).toEqual([{}, {}])
      expect(list).not.toHaveBeenCalled()
    } finally {
      replay.stop()
    }
  })
})

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = registry.getSingleMetric(name)
  if (!metric) throw new Error(`${name} is not registered`)
  const snapshot = await metric.get()
  return (
    snapshot.values.find(entry =>
      Object.entries(labels).every(([label, value]) => entry.labels[label] === value)
    )?.value ?? 0
  )
}

describe('SecretInformer resume mode (#1338 F2 Layer B)', () => {
  const NS = 'mcp-server'
  let api: ReturnType<typeof fakeSecretApiserver>
  let events: SecretEvent[]
  let informer: SecretInformer
  let errors: ReturnType<typeof vi.spyOn>
  let warnings: ReturnType<typeof vi.spyOn>

  function build(names: string[]) {
    api = fakeSecretApiserver(NS, names)
    events = []
    informer = new SecretInformer(
      {} as k8s.KubeConfig,
      NS,
      evt => events.push(evt),
      { mode: 'resume', list: api.list },
      { watch: { watch: api.watch } }
    )
  }

  /** Start, check the initial list emitted one ADDED per Secret, then clear. */
  async function startQuiet(names: string[]) {
    build(names)
    await expect(informer.start()).resolves.toBe(true)
    expect(events).toEqual([...names].sort().map(name => ({ type: 'ADDED', name, namespace: NS })))
    events.length = 0
  }

  /** End the live stream and let the 1 s reconnect run. */
  async function reconnect() {
    api.disconnect()
    await vi.advanceTimersByTimeAsync(1000)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    errors = vi.spyOn(hccLogger, 'error')
    warnings = vi.spyOn(hccLogger, 'warn')
  })

  afterEach(() => {
    informer.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('B10 the initial list emits one ADDED per Secret, once, then watches from its resourceVersion', async () => {
    const initialBefore = await metricValue('clerum_hcc_secret_informer_lists_total', {
      namespace: NS,
      outcome: 'initial',
    })
    build(['b', 'a', 'c'])

    await expect(informer.start()).resolves.toBe(true)

    expect(events).toEqual([
      { type: 'ADDED', name: 'a', namespace: NS },
      { type: 'ADDED', name: 'b', namespace: NS },
      { type: 'ADDED', name: 'c', namespace: NS },
    ])
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenCalledWith(NS, { limit: 50, continueToken: undefined })
    expect(api.watchFn).toHaveBeenCalledTimes(1)
    expect(api.watchCalls[0].queryParams).toEqual({
      resourceVersion: api.revision(),
      allowWatchBookmarks: true,
    })
    expect(
      await metricValue('clerum_hcc_secret_informer_lists_total', {
        namespace: NS,
        outcome: 'initial',
      })
    ).toBe(initialBefore + 1)
  })

  it('B1 a reconnect after which nothing changed emits nothing and resumes from the last resourceVersion', async () => {
    await startQuiet(['a', 'b', 'c'])
    const listVersion = api.revision()
    const resumesBefore = await metricValue('clerum_hcc_secret_informer_resumes_total', {
      namespace: NS,
    })

    await reconnect()
    await reconnect()
    await reconnect()

    expect(events).toEqual([])
    expect(api.watchFn).toHaveBeenCalledTimes(4)
    for (const call of api.watchCalls.slice(1)) {
      expect(call.queryParams).toEqual({ resourceVersion: listVersion, allowWatchBookmarks: true })
    }
    expect(await metricValue('clerum_hcc_secret_informer_resumes_total', { namespace: NS })).toBe(
      resumesBefore + 3
    )
    expect(api.list).toHaveBeenCalledTimes(1)
  })

  it('B2 a bookmark advances the resume point', async () => {
    await startQuiet(['a'])

    api.bookmark('900')
    await reconnect()

    expect(api.watchCalls[1].queryParams).toEqual({
      resourceVersion: '900',
      allowWatchBookmarks: true,
    })
    expect(events).toEqual([])
  })

  it('B3 a Secret modified while the watch was down arrives as MODIFIED on resume', async () => {
    await startQuiet(['a', 'b', 'c'])

    api.disconnect()
    api.modify('a')
    await vi.advanceTimersByTimeAsync(1000)

    expect(api.watchFn).toHaveBeenCalledTimes(2)
    expect(api.watchCalls[1].queryParams.resourceVersion).toBeDefined()
    expect(events).toEqual([{ type: 'MODIFIED', name: 'a', namespace: NS }])
  })

  it.each([
    ['the watch request answers HTTP 410', 'request'],
    ['the stream reports an ERROR 410', 'stream'],
  ] as const)(
    'B4 when %s, the relist diff reports a gap modification as MODIFIED',
    async (_label, form) => {
      await startQuiet(['a', 'b', 'c'])
      const relistsBefore = await metricValue('clerum_hcc_secret_informer_lists_total', {
        namespace: NS,
        outcome: 'relist',
      })

      if (form === 'request') {
        api.disconnect()
        api.expireNextResume()
        api.modify('a')
        // The resume is answered 410; its reconnect then relists.
        await vi.advanceTimersByTimeAsync(1000)
        await vi.advanceTimersByTimeAsync(1000)
      } else {
        api.expireInStream()
        api.modify('a')
        await vi.advanceTimersByTimeAsync(1000)
      }

      expect(events).toEqual([{ type: 'MODIFIED', name: 'a', namespace: NS }])
      expect(api.list).toHaveBeenCalledTimes(2)
      expect(
        await metricValue('clerum_hcc_secret_informer_lists_total', {
          namespace: NS,
          outcome: 'relist',
        })
      ).toBe(relistsBefore + 1)
      const last = api.watchCalls[api.watchCalls.length - 1]
      expect(last.queryParams).toEqual({
        resourceVersion: api.revision(),
        allowWatchBookmarks: true,
      })
    }
  )

  it('B5 a Secret deleted while the watch was down arrives as DELETED and leaves the cache', async () => {
    await startQuiet(['a', 'b', 'c'])

    api.disconnect()
    api.expireNextResume()
    api.remove('b')
    await vi.advanceTimersByTimeAsync(2000)

    expect(api.list).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ type: 'DELETED', name: 'b', namespace: NS }])
    events.length = 0
    api.create('b')
    expect(events).toEqual([{ type: 'ADDED', name: 'b', namespace: NS }])
  })

  it('B6 a Secret deleted and recreated while the watch was down arrives as MODIFIED', async () => {
    await startQuiet(['a', 'b', 'c'])
    const uidBefore = api.stored('a')!.uid

    api.disconnect()
    api.expireNextResume()
    api.recreate('a')
    await vi.advanceTimersByTimeAsync(2000)

    expect(api.stored('a')!.uid).not.toBe(uidBefore)
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(events).toEqual([{ type: 'MODIFIED', name: 'a', namespace: NS }])
  })

  it('B7 a duplicate ADDED for a cached Secret is suppressed and logged as an invariant violation', async () => {
    await startQuiet(['a'])
    const stored = api.stored('a')!

    api.watchCalls[0].cb('ADDED', {
      metadata: {
        name: 'a',
        namespace: NS,
        uid: stored.uid,
        resourceVersion: stored.resourceVersion,
      },
    })

    expect(events).toEqual([])
    expect(warnings).toHaveBeenCalledWith(
      '[SecretInformer] duplicate ADDED for a cached Secret suppressed',
      expect.objectContaining({ event: 'secret-informer-duplicate-added', namespace: NS })
    )
  })

  it('B8 a failed relist emits nothing, opens no watch, reports itself, and the next complete list resumes', async () => {
    await startQuiet(['a', 'b', 'c'])
    const channels = new SecretInformer(
      {} as k8s.KubeConfig,
      'channels',
      () => undefined,
      { mode: 'replay' },
      { watch: { watch: vi.fn(async () => ({ abort: vi.fn() }) as unknown as AbortController) } }
    )
    const failedBefore = await metricValue('clerum_hcc_secret_informer_lists_total', {
      namespace: NS,
      outcome: 'failed',
    })
    try {
      api.disconnect()
      api.expireNextResume()
      api.failListPage(1, () => Object.assign(new Error('apiserver unavailable'), { code: 503 }))
      await vi.advanceTimersByTimeAsync(1000) // resume answered 410
      await vi.advanceTimersByTimeAsync(1000) // relist fails
      await expect(channels.start()).resolves.toBe(true)

      expect(api.list).toHaveBeenCalledTimes(2)
      expect(events).toEqual([])
      expect(api.watchFn).toHaveBeenCalledTimes(2)
      expect(
        await metricValue('clerum_hcc_secret_informer_lists_total', {
          namespace: NS,
          outcome: 'failed',
        })
      ).toBe(failedBefore + 1)
      expect(errors).toHaveBeenCalledWith(
        '[SecretInformer] Secret list failed; no watch until a complete list succeeds',
        expect.objectContaining({ event: 'secret-informer-list-failed', namespace: NS })
      )
      expect(await metricValue('clerum_hcc_secret_informer_running', { namespace: NS })).toBe(0)
      expect(
        await metricValue('clerum_hcc_secret_informer_running', { namespace: 'channels' })
      ).toBe(1)

      // The backoff schedules the next relist; it succeeds with nothing changed.
      await vi.advanceTimersByTimeAsync(2000)

      expect(api.list).toHaveBeenCalledTimes(3)
      expect(events).toEqual([])
      expect(api.watchFn).toHaveBeenCalledTimes(3)
      expect(api.watchCalls[2].queryParams).toEqual({
        resourceVersion: api.revision(),
        allowWatchBookmarks: true,
      })
      expect(await metricValue('clerum_hcc_secret_informer_running', { namespace: NS })).toBe(1)
    } finally {
      channels.stop()
    }
  })

  it.each([
    ['page 2 rejects', () => Object.assign(new Error('apiserver unavailable'), { code: 503 })],
    ['the continue token expired', () => Object.assign(new Error('Gone'), { code: 410 })],
  ])('B9 a partial list (%s) is never diffed', async (_label, failure) => {
    const names = Array.from({ length: 60 }, (_, index) => `s${String(index).padStart(2, '0')}`)
    await startQuiet(names)
    expect(api.list).toHaveBeenCalledTimes(2)

    api.disconnect()
    api.expireNextResume()
    api.failListPage(2, failure)
    await vi.advanceTimersByTimeAsync(2000)

    expect(api.list).toHaveBeenCalledTimes(4)
    expect(api.list.mock.calls[2][1]).toEqual({ limit: 50, continueToken: undefined })
    expect(api.list.mock.calls[3][1]).toEqual({ limit: 50, continueToken: '2' })
    expect(events).toEqual([])
    expect(api.watchFn).toHaveBeenCalledTimes(2)
  })
})
