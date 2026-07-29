import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ExternalEgressConvergenceCoordinator,
  type ExternalEgressRetryHandle,
  type ExternalEgressWatchEventType,
} from './externalEgressConvergenceCoordinator'
import type { McpServerCRD } from './types'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function server(
  name: string,
  generation = 1,
  options: { bindings?: boolean; namespace?: string } = {}
): McpServerCRD {
  return {
    name,
    namespace: options.namespace ?? 'mcp-server',
    uid: `${name}-uid`,
    generation,
    spec: {
      contextRef: 'default',
      image: `clerum/${name}:v${generation}`,
      transport: { type: 'streamableHttp', port: 3000 },
      egressBindings:
        options.bindings === false ? undefined : [{ dns: `${name}.example`, port: 443 }],
    },
  }
}

type CoordinatorOverrides = Partial<
  ConstructorParameters<typeof ExternalEgressConvergenceCoordinator>[0]
>

function coordinator(overrides: CoordinatorOverrides = {}) {
  const servers = new Map<string, McpServerCRD>()
  const mutate = vi.fn(async () => undefined)
  const replay = vi.fn(async () => undefined)
  const instance = new ExternalEgressConvergenceCoordinator({
    listServers: () => [...servers.values()],
    getCurrentServer: name => servers.get(name),
    inventoryAuthoritative: () => true,
    sameDesiredRevision: (left, right) =>
      left.uid === right.uid &&
      left.generation === right.generation &&
      JSON.stringify(left.spec) === JSON.stringify(right.spec),
    enqueue: async (_selected, work) => work(),
    mutate,
    replay,
    ...overrides,
  })
  return { instance, mutate, replay, servers }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ExternalEgressConvergenceCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    ['presence', 'DELETED' as const, undefined],
    ['revision', 'MODIFIED' as const, server('redis-tools', 2)],
  ])(
    'lets an existing timer consume the latest %s intent and resets its attempt ladder',
    async (_change, nextType, nextServer) => {
      vi.useFakeTimers()
      const initial = server('redis-tools', 1)
      const state = new Map<string, McpServerCRD>([[initial.name, initial]])
      const replayed: Array<{ type: ExternalEgressWatchEventType; server: McpServerCRD }> = []
      let instance!: ExternalEgressConvergenceCoordinator
      instance = coordinator({
        getCurrentServer: name => state.get(name),
        replay: async (type, selected) => {
          replayed.push({ type, server: selected })
          instance.scheduleRetry(type, selected)
        },
      }).instance

      instance.scheduleRetry('ADDED', initial)
      if (nextServer) state.set(nextServer.name, nextServer)
      else state.delete(initial.name)
      instance.scheduleRetry(nextType, nextServer ?? initial)

      await vi.advanceTimersByTimeAsync(5000)
      expect(replayed).toEqual([
        {
          type: nextType,
          server: expect.objectContaining({
            generation: nextServer?.generation ?? initial.generation,
          }),
        },
      ])

      await vi.advanceTimersByTimeAsync(4999)
      expect(replayed).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(replayed).toHaveLength(2)
      instance.stop()
    }
  )

  it('continues retrying at the capped delay until the replay succeeds', async () => {
    vi.useFakeTimers()
    const selected = server('web-search')
    let instance!: ExternalEgressConvergenceCoordinator
    let attempts = 0
    instance = coordinator({
      getCurrentServer: () => selected,
      replay: async (type, current, retry) => {
        attempts += 1
        if (attempts < 5) {
          instance.scheduleRetry(type, current)
          return
        }
        retry.complete()
      },
    }).instance

    instance.scheduleRetry('ADDED', selected)
    for (const delay of [5000, 15000, 30000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }

    expect(attempts).toBe(5)
    await vi.advanceTimersByTimeAsync(30000)
    expect(attempts).toBe(5)
    instance.stop()
  })

  it('never clears a pending full replay after an egress-only success', async () => {
    vi.useFakeTimers()
    const selected = server('web-search')
    const { instance, replay, servers } = coordinator()
    servers.set(selected.name, selected)

    instance.scheduleRetry('ADDED', selected)
    const retry = await instance.reconcile('MODIFIED', selected)
    expect(retry).toBeDefined()

    await vi.advanceTimersByTimeAsync(5000)
    expect(replay).toHaveBeenCalledOnce()
    instance.stop()
  })

  it('clears a retry only after its complete full-replay handle finishes', async () => {
    vi.useFakeTimers()
    const selected = server('web-search')
    let instance!: ExternalEgressConvergenceCoordinator
    const replays: ExternalEgressRetryHandle[] = []
    instance = coordinator({
      getCurrentServer: () => selected,
      replay: async (type, current, retry) => {
        replays.push(retry)
        const completion = await instance.reconcile(type, current, { retry })
        expect(completion).toBe(retry)
        retry.complete()
      },
    }).instance

    instance.scheduleRetry('ADDED', selected)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(30000)

    expect(replays).toHaveLength(1)
    instance.stop()
  })

  it('prevents a stale retry handle from clearing a newer intent', async () => {
    vi.useFakeTimers()
    const first = server('web-search', 1)
    const second = server('web-search', 2)
    const state = new Map<string, McpServerCRD>([[first.name, first]])
    const handles: ExternalEgressRetryHandle[] = []
    const replayed: McpServerCRD[] = []
    const firstReplayStarted = deferred()
    const releaseFirstReplay = deferred()
    const { instance } = coordinator({
      getCurrentServer: name => state.get(name),
      replay: async (_type, current, retry) => {
        replayed.push(current)
        handles.push(retry)
        if (replayed.length === 1) {
          firstReplayStarted.resolve()
          await releaseFirstReplay.promise
        }
      },
    })

    instance.scheduleRetry('ADDED', first)
    await vi.advanceTimersByTimeAsync(5000)
    await firstReplayStarted.promise
    expect(handles).toHaveLength(1)

    state.set(second.name, second)
    instance.scheduleRetry('MODIFIED', second)
    handles[0].complete()
    releaseFirstReplay.resolve()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(5000)

    expect(replayed).toEqual([
      expect.objectContaining({ generation: 1 }),
      expect.objectContaining({ generation: 2 }),
    ])
    instance.stop()
  })

  it('keeps retry, resync, and startup concurrency lanes independent', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const retryRelease = deferred()
    const activeRetries = deferred()
    let retryCount = 0
    const resyncServer = server('resync-server')
    const startupServer = server('startup-server')
    const canonical = new Map<string, McpServerCRD>([
      [resyncServer.name, resyncServer],
      [startupServer.name, startupServer],
    ])
    const mutations: string[] = []
    const { instance } = coordinator({
      listServers: () => [resyncServer],
      getCurrentServer: name => canonical.get(name),
      mutate: async (_type, selected) => {
        mutations.push(selected.name)
      },
      replay: async () => {
        retryCount += 1
        if (retryCount === 10) activeRetries.resolve()
        await retryRelease.promise
      },
    })

    for (let index = 0; index < 10; index += 1) {
      const selected = server(`retry-${index}`, 1, { bindings: false })
      instance.scheduleRetry('ADDED', selected)
    }
    await vi.advanceTimersByTimeAsync(5000)
    await activeRetries.promise

    const resync = instance.runResync()
    const startup = instance.prepareStartupGates([startupServer])
    await Promise.all([resync, startup.waitFor(startupServer)])

    expect(mutations).toEqual(expect.arrayContaining(['resync-server', 'startup-server']))
    retryRelease.resolve()
    instance.stop()
  })

  it('queues at most one latest-wins retry job per key behind a saturated limiter', async () => {
    vi.useFakeTimers()
    const blockersRelease = deferred()
    const tenBlockersStarted = deferred()
    const finalReplayStarted = deferred()
    const initial = server('churning-server', 1)
    const second = server('churning-server', 2)
    const final = server('churning-server', 3)
    const state = new Map<string, McpServerCRD>([[initial.name, initial]])
    const targetEnqueues: McpServerCRD[] = []
    const targetReplays: McpServerCRD[] = []
    let blockerCount = 0
    const { instance } = coordinator({
      getCurrentServer: name => state.get(name),
      enqueue: async (selected, work) => {
        if (selected.name === initial.name) targetEnqueues.push(selected)
        await work()
      },
      replay: async (_type, selected, retry) => {
        if (selected.name.startsWith('limiter-blocker-')) {
          blockerCount += 1
          if (blockerCount === 10) tenBlockersStarted.resolve()
          await blockersRelease.promise
          return
        }
        targetReplays.push(selected)
        retry.complete()
        finalReplayStarted.resolve()
      },
    })

    for (let index = 0; index < 10; index += 1) {
      instance.scheduleRetry('DELETED', server(`limiter-blocker-${index}`))
    }
    await vi.advanceTimersByTimeAsync(5000)
    await tenBlockersStarted.promise

    instance.scheduleRetry('ADDED', initial)
    await vi.advanceTimersByTimeAsync(5000)
    state.set(second.name, second)
    instance.scheduleRetry('MODIFIED', second)
    await vi.advanceTimersByTimeAsync(5000)
    state.set(final.name, final)
    instance.scheduleRetry('MODIFIED', final)
    await vi.advanceTimersByTimeAsync(5000)

    expect(targetEnqueues).toHaveLength(0)
    blockersRelease.resolve()
    await finalReplayStarted.promise
    await flushMicrotasks()
    await flushMicrotasks()

    expect(targetEnqueues).toHaveLength(1)
    expect(targetReplays).toEqual([expect.objectContaining({ generation: 3 })])
    instance.stop()
  })

  it('re-arms a retry scheduled by an active replay only after that key leaves its slot', async () => {
    vi.useFakeTimers()
    const selected = server('slow-retry')
    const firstReplayStarted = deferred()
    const releaseFirstReplay = deferred()
    let instance!: ExternalEgressConvergenceCoordinator
    let replayCount = 0
    instance = coordinator({
      getCurrentServer: () => selected,
      replay: async (type, current, retry) => {
        replayCount += 1
        if (replayCount === 1) {
          instance.scheduleRetry(type, current)
          firstReplayStarted.resolve()
          await releaseFirstReplay.promise
          return
        }
        retry.complete()
      },
    }).instance

    instance.scheduleRetry('ADDED', selected)
    await vi.advanceTimersByTimeAsync(5000)
    await firstReplayStarted.promise

    await vi.advanceTimersByTimeAsync(15000)
    expect(replayCount).toBe(1)

    releaseFirstReplay.resolve()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(14999)
    expect(replayCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(replayCount).toBe(2)
    instance.stop()
  })

  it('cancels a retry waiter on stop before limiter capacity becomes available', async () => {
    vi.useFakeTimers()
    const blockersRelease = deferred()
    const tenBlockersStarted = deferred()
    const queued = server('queued-before-stop')
    let blockerCount = 0
    const enqueuedTargets: string[] = []
    const { instance } = coordinator({
      enqueue: async (selected, work) => {
        if (selected.name === queued.name) enqueuedTargets.push(selected.name)
        await work()
      },
      replay: async (_type, selected) => {
        if (!selected.name.startsWith('stop-blocker-')) return
        blockerCount += 1
        if (blockerCount === 10) tenBlockersStarted.resolve()
        await blockersRelease.promise
      },
    })

    for (let index = 0; index < 10; index += 1) {
      instance.scheduleRetry('DELETED', server(`stop-blocker-${index}`))
    }
    await vi.advanceTimersByTimeAsync(5000)
    await tenBlockersStarted.promise
    instance.scheduleRetry('DELETED', queued)
    await vi.advanceTimersByTimeAsync(5000)

    instance.stop()
    blockersRelease.resolve()
    await flushMicrotasks()
    await flushMicrotasks()

    expect(enqueuedTargets).toEqual([])
  })

  it('resolves the current canonical server after periodic jitter', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const stale = server('web-search', 1)
    const current = server('web-search', 2)
    const state = new Map<string, McpServerCRD>([[stale.name, stale]])
    const reconciled: McpServerCRD[] = []
    const { instance } = coordinator({
      listServers: () => [stale],
      getCurrentServer: name => state.get(name),
      mutate: async (_type, selected) => {
        reconciled.push(selected)
      },
    })

    const resync = instance.runResync()
    await flushMicrotasks()
    state.set(current.name, current)
    await vi.advanceTimersByTimeAsync(2500)
    await resync

    expect(reconciled).toEqual([expect.objectContaining({ generation: 2 })])
    instance.stop()
  })

  it('returns one global single-flight promise for overlapping resync requests', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const selected = server('web-search')
    const release = deferred()
    const mutationStarted = deferred()
    const { instance, servers } = coordinator({
      mutate: async () => {
        mutationStarted.resolve()
        await release.promise
      },
    })
    servers.set(selected.name, selected)

    const first = instance.runResync()
    const overlapping = instance.runResync()
    expect(overlapping).toBe(first)
    await mutationStarted.promise

    release.resolve()
    await first
    instance.stop()
  })

  it('skips a resync key whose external-egress mutation is already in flight', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const selected = server('web-search')
    const release = deferred()
    const mutationStarted = deferred()
    const mutate = vi.fn(async () => {
      mutationStarted.resolve()
      await release.promise
    })
    const { instance, servers } = coordinator({ mutate })
    servers.set(selected.name, selected)

    const active = instance.reconcile('MODIFIED', selected)
    await mutationStarted.promise
    await instance.runResync()

    expect(mutate).toHaveBeenCalledOnce()
    release.resolve()
    await active
    instance.stop()
  })

  it('resolves canonical state after entering the keyed resync queue', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const stale = server('web-search', 1)
    const current = server('web-search', 2)
    const state = new Map<string, McpServerCRD>([[stale.name, stale]])
    const queueEntered = deferred()
    const releaseQueue = deferred()
    const reconciled: McpServerCRD[] = []
    const { instance } = coordinator({
      listServers: () => [stale],
      getCurrentServer: name => state.get(name),
      enqueue: async (_selected, work) => {
        queueEntered.resolve()
        await releaseQueue.promise
        await work()
      },
      mutate: async (_type, selected) => {
        reconciled.push(selected)
      },
    })

    const resync = instance.runResync()
    await queueEntered.promise
    state.set(current.name, current)
    releaseQueue.resolve()
    await resync

    expect(reconciled).toEqual([expect.objectContaining({ generation: 2 })])
    instance.stop()
  })

  it('keeps a startup gate false when desired revision changes during egress', async () => {
    const selected = server('web-search', 1)
    const current = server('web-search', 2)
    const state = new Map<string, McpServerCRD>([[selected.name, selected]])
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    let selectedLease: (() => boolean) | undefined
    const { instance } = coordinator({
      getCurrentServer: name => state.get(name),
      mutate: async (_type, _server, options) => {
        selectedLease = options.isCurrent
        mutationStarted.resolve()
        await releaseMutation.promise
      },
    })

    const gates = instance.prepareStartupGates([selected])
    await mutationStarted.promise
    expect(selectedLease?.()).toBe(true)
    state.set(current.name, current)
    expect(selectedLease?.()).toBe(false)
    releaseMutation.resolve()

    await expect(gates.waitFor(selected)).resolves.toBe(false)
    instance.stop()
  })

  it('retires a direct mutation lease when desired revision changes in place', async () => {
    const selected = server('web-search', 1)
    const replacement = server('web-search', 2)
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    let selectedLease: (() => boolean) | undefined
    const { instance, servers } = coordinator({
      mutate: async (_type, _server, options) => {
        selectedLease = options.isCurrent
        mutationStarted.resolve()
        await releaseMutation.promise
      },
    })
    servers.set(selected.name, selected)

    const mutation = instance.reconcile('MODIFIED', selected)
    await mutationStarted.promise
    expect(selectedLease?.()).toBe(true)

    servers.set(replacement.name, replacement)
    expect(selectedLease?.()).toBe(false)
    releaseMutation.resolve()
    await mutation
    instance.stop()
  })

  it('does not start a second mutation after stop releases an in-flight wait', async () => {
    const firstMutation = deferred()
    const selected = server('web-search')
    const mutate = vi.fn(async () => firstMutation.promise)
    const { instance, servers } = coordinator({ mutate })
    servers.set(selected.name, selected)

    const first = instance.reconcile('MODIFIED', selected)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    const waiting = instance.reconcile('MODIFIED', selected)
    instance.stop()
    firstMutation.resolve()
    await Promise.all([first, waiting])

    expect(mutate).toHaveBeenCalledOnce()
  })

  it('rechecks per-key in-flight ownership when multiple waiters resume together', async () => {
    const selected = server('web-search')
    const releases = [deferred(), deferred(), deferred()]
    const starts = [deferred(), deferred(), deferred()]
    let active = 0
    let maxActive = 0
    let call = 0
    const mutate = vi.fn(async () => {
      const index = call++
      active += 1
      maxActive = Math.max(maxActive, active)
      starts[index].resolve()
      await releases[index].promise
      active -= 1
    })
    const { instance, servers } = coordinator({ mutate })
    servers.set(selected.name, selected)

    const first = instance.reconcile('MODIFIED', selected)
    await starts[0].promise
    const second = instance.reconcile('MODIFIED', selected)
    const third = instance.reconcile('MODIFIED', selected)

    try {
      releases[0].resolve()
      await starts[1].promise
      await flushMicrotasks()
      expect(maxActive).toBe(1)
    } finally {
      for (const release of releases) release.resolve()
      await Promise.all([first, second, third])
      instance.stop()
    }
  })

  it('rechecks a caller lease after waiting for an in-flight mutation', async () => {
    const firstMutation = deferred()
    const selected = server('web-search')
    let current = true
    const mutate = vi.fn(async () => firstMutation.promise)
    const { instance, servers } = coordinator({ mutate })
    servers.set(selected.name, selected)

    const first = instance.reconcile('MODIFIED', selected)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    const waiting = instance.reconcile('MODIFIED', selected, {
      isCurrent: () => current,
    })
    current = false
    firstMutation.resolve()
    await Promise.all([first, waiting])

    expect(mutate).toHaveBeenCalledOnce()
    instance.stop()
  })

  it('keeps a retry pending while inventory authority is unavailable', async () => {
    vi.useFakeTimers()
    const selected = server('web-search')
    let authoritative = false
    const { instance, replay, servers } = coordinator({
      inventoryAuthoritative: () => authoritative,
    })
    servers.set(selected.name, selected)

    instance.scheduleRetry('ADDED', selected)
    await vi.advanceTimersByTimeAsync(5000)
    expect(replay).not.toHaveBeenCalled()

    authoritative = true
    await vi.advanceTimersByTimeAsync(14_999)
    expect(replay).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(replay).toHaveBeenCalledOnce()
    instance.stop()
  })

  it('skips periodic resync while inventory authority is unavailable', async () => {
    const selected = server('web-search')
    let authoritative = false
    const { instance, mutate, servers } = coordinator({
      inventoryAuthoritative: () => authoritative,
    })
    servers.set(selected.name, selected)

    await instance.runResync()
    expect(mutate).not.toHaveBeenCalled()

    authoritative = true
    await instance.runResync()
    expect(mutate).toHaveBeenCalledOnce()
    instance.stop()
  })

  it('does not resume periodic work from jitter after stop', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const selected = server('web-search')
    const { instance, mutate, servers } = coordinator()
    servers.set(selected.name, selected)

    const resync = instance.runResync()
    await flushMicrotasks()
    instance.stop()
    await vi.advanceTimersByTimeAsync(2500)
    await resync

    expect(mutate).not.toHaveBeenCalled()
  })

  it('does not start an eleventh startup mutation after stop releases the limiter', async () => {
    const release = deferred()
    const tenStarted = deferred()
    let active = 0
    const selected = Array.from({ length: 11 }, (_, index) => server(`startup-${index}`))
    const state = new Map(selected.map(item => [item.name, item]))
    const mutate = vi.fn(async () => {
      active += 1
      if (active === 10) tenStarted.resolve()
      await release.promise
    })
    const { instance } = coordinator({
      getCurrentServer: name => state.get(name),
      mutate,
    })

    const gates = instance.prepareStartupGates(selected)
    await tenStarted.promise
    instance.stop()
    release.resolve()
    await Promise.all(selected.map(item => gates.waitFor(item)))

    expect(mutate).toHaveBeenCalledTimes(10)
  })

  it('passes DELETE authority through to the watcher mutation without evaluating it', async () => {
    const selected = server('web-search')
    const deleteAllowed = vi.fn(async () => false)
    const mutate = vi.fn(async () => undefined)
    const { instance } = coordinator({ mutate })

    await instance.reconcile('DELETED', selected, { deleteAllowed })

    expect(mutate).toHaveBeenCalledWith('DELETED', selected, {
      deleteAllowed,
      isCurrent: expect.any(Function),
    })
    expect(deleteAllowed).not.toHaveBeenCalled()
    instance.stop()
  })

  it('owns periodic resync scheduling and stops it immediately', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const selected = server('web-search')
    const { instance, mutate, servers } = coordinator()
    servers.set(selected.name, selected)

    instance.startPeriodicResync(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mutate).toHaveBeenCalledOnce()

    instance.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(mutate).toHaveBeenCalledOnce()
  })
})
