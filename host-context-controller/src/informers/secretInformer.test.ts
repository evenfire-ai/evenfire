import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { SecretEvent, SecretInformer, WatchLike } from './secretInformer'

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
    informer = new SecretInformer(kc, 'mcp-server', onEvent, { watch: watchLike })
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
})
