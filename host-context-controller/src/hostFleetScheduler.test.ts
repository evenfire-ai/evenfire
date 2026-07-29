import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type HostFleetReconcileRequest,
  type HostFleetRequestResult,
  HostFleetScheduler,
} from './hostFleetScheduler'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('HostFleetScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges newer work into one trailing pass with full coverage and latest inputs', async () => {
    const activePass = deferred()
    const requests: HostFleetReconcileRequest[] = []
    const results: HostFleetRequestResult[] = []
    const scheduler = new HostFleetScheduler({
      perform: async request => {
        requests.push({ ...request })
        if (requests.length === 1) await activePass.promise
      },
      recordRequest: result => results.push(result),
    })

    const firstGeneration = scheduler.beginLifecycleTransition()
    scheduler.bumpInputRevision()
    const active = scheduler.request('active lifecycle', firstGeneration, 'lifecycle')
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    scheduler.bumpInputRevision()
    const pendingFull = scheduler.request('pending full', firstGeneration, 'full')
    const latestGeneration = scheduler.beginLifecycleTransition()
    scheduler.bumpInputRevision()
    const latestLifecycle = scheduler.request('latest lifecycle', latestGeneration, 'lifecycle')

    activePass.resolve()
    await Promise.all([active, pendingFull, latestLifecycle])

    expect(requests).toEqual([
      {
        reason: 'active lifecycle',
        mode: 'lifecycle',
        ccLifecycleGeneration: firstGeneration,
        inputRevision: 1,
      },
      {
        reason: 'latest lifecycle',
        mode: 'full',
        ccLifecycleGeneration: latestGeneration,
        inputRevision: 3,
      },
    ])
    expect(results).toEqual(['started', 'coalesced', 'coalesced', 'trailing'])
  })

  it('reuses active work only when its mode, revision, and lifecycle generation cover the request', async () => {
    const activePass = deferred()
    const requests: HostFleetReconcileRequest[] = []
    const scheduler = new HostFleetScheduler({
      perform: async request => {
        requests.push({ ...request })
        if (requests.length === 1) await activePass.promise
      },
      recordRequest: vi.fn(),
    })
    const generation = scheduler.beginLifecycleTransition()
    scheduler.bumpInputRevision()

    const active = scheduler.request('full', generation, 'full')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const covered = scheduler.request('covered lifecycle', generation, 'lifecycle')

    activePass.resolve()
    await Promise.all([active, covered])

    expect(requests).toHaveLength(1)
  })

  it('rejects stale or already-applied lifecycle work without suppressing a current full pass', async () => {
    const perform = vi.fn<(request: HostFleetReconcileRequest) => Promise<void>>(
      async () => undefined
    )
    const scheduler = new HostFleetScheduler({
      perform,
      recordRequest: vi.fn(),
    })
    const firstGeneration = scheduler.beginLifecycleTransition()
    scheduler.markLifecycleApplied(firstGeneration)

    await scheduler.request('already applied', firstGeneration, 'lifecycle')
    await scheduler.request('current full', firstGeneration, 'full')
    scheduler.beginLifecycleTransition()
    await scheduler.request('stale full', firstGeneration, 'full')

    expect(perform).toHaveBeenCalledOnce()
    expect(perform).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'current full', mode: 'full' })
    )
  })

  it('does not let a rejected pass poison later work', async () => {
    const failure = new Error('transient failure')
    const perform = vi
      .fn<(request: HostFleetReconcileRequest) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)
    const scheduler = new HostFleetScheduler({
      perform,
      recordRequest: vi.fn(),
    })

    await expect(scheduler.request('fails')).rejects.toThrow(failure)
    await expect(scheduler.request('recovers')).resolves.toBeUndefined()

    expect(perform).toHaveBeenCalledTimes(2)
  })

  it('releases active and queued waiters on stop without starting queued work', async () => {
    const activePass = deferred()
    const requests: HostFleetReconcileRequest[] = []
    const scheduler = new HostFleetScheduler({
      perform: async request => {
        requests.push({ ...request })
        await activePass.promise
      },
      recordRequest: vi.fn(),
    })

    const active = scheduler.request('active')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    scheduler.bumpInputRevision()
    const queued = scheduler.request('queued')

    scheduler.stop()
    await Promise.all([active, queued, scheduler.request('after stop')])
    activePass.resolve()
    await Promise.resolve()

    expect(requests).toHaveLength(1)
  })

  it('tracks lifecycle state and cancels obsolete retries', async () => {
    vi.useFakeTimers()
    const perform = vi.fn<(request: HostFleetReconcileRequest) => Promise<void>>(
      async () => undefined
    )
    const scheduler = new HostFleetScheduler({
      perform,
      recordRequest: vi.fn(),
    })
    const firstGeneration = scheduler.beginLifecycleTransition()

    expect(scheduler.currentLifecycleGeneration).toBe(firstGeneration)
    expect(scheduler.appliedLifecycleGeneration).toBe(-1)

    scheduler.scheduleLifecycleRetry({
      reason: 'failed lifecycle',
      mode: 'lifecycle',
      ccLifecycleGeneration: firstGeneration,
      inputRevision: 0,
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(perform).not.toHaveBeenCalled()

    const secondGeneration = scheduler.beginLifecycleTransition()
    await vi.advanceTimersByTimeAsync(1)
    expect(perform).not.toHaveBeenCalled()

    scheduler.scheduleLifecycleRetry({
      reason: 'current lifecycle',
      mode: 'lifecycle',
      ccLifecycleGeneration: secondGeneration,
      inputRevision: 0,
    })
    scheduler.markLifecycleApplied(secondGeneration)
    await vi.advanceTimersByTimeAsync(5000)

    expect(scheduler.appliedLifecycleGeneration).toBe(secondGeneration)
    expect(perform).not.toHaveBeenCalled()
  })

  it('retries an unapplied current lifecycle generation with bounded backoff', async () => {
    vi.useFakeTimers()
    const requests: HostFleetReconcileRequest[] = []
    const scheduler = new HostFleetScheduler({
      perform: async request => {
        requests.push({ ...request })
      },
      recordRequest: vi.fn(),
    })
    const generation = scheduler.beginLifecycleTransition()
    const failedRequest: HostFleetReconcileRequest = {
      reason: 'failed lifecycle',
      mode: 'lifecycle',
      ccLifecycleGeneration: generation,
      inputRevision: 0,
    }

    scheduler.scheduleLifecycleRetry(failedRequest)
    await vi.advanceTimersByTimeAsync(5000)
    scheduler.scheduleLifecycleRetry(failedRequest)
    await vi.advanceTimersByTimeAsync(14999)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(requests).toEqual([
      expect.objectContaining({
        reason: 'CommunicationChannel lifecycle convergence retry',
        mode: 'lifecycle',
        ccLifecycleGeneration: generation,
      }),
      expect.objectContaining({
        reason: 'CommunicationChannel lifecycle convergence retry',
        mode: 'lifecycle',
        ccLifecycleGeneration: generation,
      }),
    ])
  })
})
