import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../observability/logger'
import {
  PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
  createGrantUpdateListener,
  parseGrantUpdatePayload,
} from './grantUpdateListener'

function makeLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withStep: vi.fn(),
  }
  logger.withStep.mockReturnValue(logger)
  return logger as unknown as Logger
}

type NotificationHandler = (msg: { channel: string; payload?: string }) => void

/**
 * Minimal fake of a pg PoolClient scoped to LISTEN: records the channel it
 * LISTENed on and lets the test emit notifications / connection errors into the
 * registered handlers. `query` can be made to reject to simulate a LISTEN that
 * fails without an 'error' emission (H3).
 */
function makeFakeClient(opts: { failQuery?: boolean } = {}) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const queries: string[] = []
  const client = {
    on(event: string, handler: (...args: unknown[]) => void) {
      ;(handlers[event] ??= []).push(handler)
      return client
    },
    query: vi.fn(async (sql: string) => {
      queries.push(sql)
      if (opts.failQuery) throw new Error('LISTEN failed')
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
    // pg PoolClient is an EventEmitter; the listener strips its own handlers
    // before handing a subscribed client back to the pool (issue #375 M5).
    removeAllListeners: vi.fn((event?: string) => {
      if (event) delete handlers[event]
      else for (const key of Object.keys(handlers)) delete handlers[key]
      return client
    }),
  }
  return {
    client,
    queries,
    emitNotification(msg: { channel: string; payload?: string }) {
      for (const handler of handlers.notification ?? []) (handler as NotificationHandler)(msg)
    },
    emitError(err: Error) {
      for (const handler of handlers.error ?? []) handler(err)
    },
  }
}

describe('parseGrantUpdatePayload', () => {
  it('parses a well-formed payload with a capability family', () => {
    expect(
      parseGrantUpdatePayload(
        JSON.stringify({
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'research',
          capabilityFamily: 'promptBridge',
        })
      )
    ).toEqual({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
      capabilityFamily: 'promptBridge',
    })
  })

  it('parses a payload without a capability family (whole-recipe revoke)', () => {
    expect(
      parseGrantUpdatePayload(
        JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' })
      )
    ).toEqual({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' })
  })

  it('returns null for non-JSON, missing fields, or wrong types (data, not command)', () => {
    expect(parseGrantUpdatePayload('not json')).toBeNull()
    expect(parseGrantUpdatePayload(JSON.stringify({ recipeName: 'research' }))).toBeNull()
    expect(
      parseGrantUpdatePayload(JSON.stringify({ recipeNamespace: 'sandbox-recipes' }))
    ).toBeNull()
    expect(
      parseGrantUpdatePayload(JSON.stringify({ recipeNamespace: 1, recipeName: 2 }))
    ).toBeNull()
    expect(parseGrantUpdatePayload(JSON.stringify(['array']))).toBeNull()
  })
})

describe('createGrantUpdateListener', () => {
  it('LISTENs on the grant-update channel on start', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => fake.client as never,
    })

    await listener.start()

    expect(fake.queries.some(sql => /LISTEN\s+plugin_workload_sdk_grant_update/.test(sql))).toBe(
      true
    )
    await listener.stop()
    expect(fake.client.query).toHaveBeenCalledWith(
      expect.stringMatching(/UNLISTEN\s+plugin_workload_sdk_grant_update/)
    )
    expect(fake.client.release).toHaveBeenCalled()
  })

  it('forwards the parsed notification to onGrantUpdate', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => fake.client as never,
    })
    await listener.start()

    fake.emitNotification({
      channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
      payload: JSON.stringify({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'research',
        capabilityFamily: 'promptBridge',
      }),
    })

    expect(onGrantUpdate).toHaveBeenCalledWith({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
      capabilityFamily: 'promptBridge',
    })
    await listener.stop()
  })

  it('warns and does not dispatch on an unparseable payload (payload is data, not a command)', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const logger = makeLogger()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger,
      connect: async () => fake.client as never,
    })
    await listener.start()

    fake.emitNotification({
      channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
      payload: 'garbage-not-json',
    })

    expect(onGrantUpdate).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    await listener.stop()
  })

  it('ignores notifications on other channels', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => fake.client as never,
    })
    await listener.start()

    fake.emitNotification({
      channel: 'some_other_channel',
      payload: JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' }),
    })

    expect(onGrantUpdate).not.toHaveBeenCalled()
    await listener.stop()
  })
})

// ── Finding 1 (#205-class): sustained multi-generation reconnect regime ──
// A LISTEN session behind pgbouncer/cloud LB is closed repeatedly under load
// (GKE produces this; minikube never does). A LATE 'error' from an
// already-superseded client must release ONLY itself and must NOT spawn a
// second attach loop that orphans the current live session (duplicate dispatch
// + one leaked pooled connection per occurrence → monotonic pool exhaustion).
describe('createGrantUpdateListener — sustained reconnect regime (issue #375 Finding 1)', () => {
  interface FakeGenClient {
    released: boolean
    destroyed: boolean
    subscribed: boolean
    handlerCount: (event: string) => number
    on: (event: string, handler: (...args: unknown[]) => void) => FakeGenClient
    query: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    removeAllListeners: (event?: string) => FakeGenClient
    emitError: (err: Error) => void
    emitNotification: (msg: { channel: string; payload?: string }) => void
  }

  /**
   * pg-pool-FAITHFUL fake (issue #375 M5, jozer review): the previous fake
   * modeled a plain-released client as silently non-dispatching and minted a
   * fresh object on every connect() — exactly the two divergences from pg-pool
   * that hid the still-subscribed-client leak. Faithful semantics:
   *   - `release()` (no error) re-idles the SAME object; pg-pool `_release`
   *     re-attaches only its OWN idle listener — user handlers stay attached and
   *     the server-side LISTEN subscription stays live, so the client KEEPS
   *     dispatching after a plain release.
   *   - `connect()` REUSES an idle client before creating a new one.
   *   - `release(err)` DESTROYS the client (removed from the pool; its session
   *     — and therefore its subscription — is gone).
   *   - `LISTEN`/`UNLISTEN` queries toggle the server-side subscription; only a
   *     subscribed, non-destroyed session receives a broadcast NOTIFY.
   */
  function makeFakeClientFactory() {
    const created: FakeGenClient[] = []
    const idle: FakeGenClient[] = []
    let listenHold: Promise<void> | null = null
    let releaseListenHold: (() => void) | null = null
    function makeClient(): FakeGenClient {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      const client: FakeGenClient = {
        released: false,
        destroyed: false,
        subscribed: false,
        handlerCount: (event: string) => (handlers[event] ?? []).length,
        on(event, handler) {
          ;(handlers[event] ??= []).push(handler)
          return client
        },
        query: vi.fn(async (sql: string) => {
          if (/^LISTEN\b/.test(sql)) {
            if (listenHold) await listenHold
            client.subscribed = true
          }
          if (/^UNLISTEN\b/.test(sql)) client.subscribed = false
          return { rows: [], rowCount: 0 }
        }),
        release: vi.fn((err?: Error) => {
          client.released = true
          if (err) {
            client.destroyed = true
            client.subscribed = false
          } else if (!client.destroyed) {
            idle.push(client)
          }
        }),
        removeAllListeners(event?: string) {
          if (event) delete handlers[event]
          else for (const key of Object.keys(handlers)) delete handlers[key]
          return client
        },
        emitError(err: Error) {
          for (const h of [...(handlers.error ?? [])]) h(err)
        },
        emitNotification(msg) {
          // Faithful: dispatch depends ONLY on the session being alive and
          // subscribed — NOT on pool checkout state. A plain-released client
          // keeps dispatching (that is the leak the old fake hid).
          if (client.destroyed || !client.subscribed) return
          for (const h of [...(handlers.notification ?? [])]) h(msg)
        },
      }
      return client
    }
    function connect(): FakeGenClient {
      const reused = idle.shift()
      if (reused) {
        reused.released = false
        return reused
      }
      const client = makeClient()
      created.push(client)
      return client
    }
    return {
      created,
      idle,
      connect,
      /** Live (checked-out, unreleased, undestroyed) sessions right now. */
      liveCount: () => created.filter(c => !c.released && !c.destroyed).length,
      current: () => created[created.length - 1],
      /** Simulate a real pg NOTIFY broadcast to EVERY subscribed session. */
      broadcast(msg: { channel: string; payload?: string }) {
        for (const c of created) c.emitNotification(msg)
      },
      /** Park the next LISTEN round-trip until releaseListen() is called. */
      holdListen() {
        listenHold = new Promise<void>(resolve => {
          releaseListenHold = () => {
            listenHold = null
            resolve()
          }
        })
      },
      releaseListen() {
        releaseListenHold?.()
      },
    }
  }

  /** A resolver-queue sleep seam so backoff can be driven deterministically. */
  function resolverQueueSleep() {
    const resolvers: Array<() => void> = []
    let calls = 0
    const sleep = (_ms: number) =>
      new Promise<void>(resolve => {
        calls += 1
        resolvers.push(resolve)
      })
    return { sleep, resolvers, sleepCalls: () => calls }
  }

  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  }

  const NOTIFY = {
    channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
    payload: JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' }),
  }

  it('T1: holds ≤1 live session and exactly-once dispatch across 25 drop→reattach cycles with late superseded errors', async () => {
    const factory = makeFakeClientFactory()
    const { sleep, resolvers, sleepCalls } = resolverQueueSleep()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => factory.connect() as never,
      sleep,
    })

    // Drain every queued backoff sleep and let the reconnect attaches settle.
    const settle = async () => {
      await flush()
      while (resolvers.length > 0) {
        const resume = resolvers.shift() as () => void
        resume()
        await flush()
      }
    }

    await listener.start()
    expect(factory.liveCount()).toBe(1)

    const K = 25
    for (let i = 0; i < K; i += 1) {
      const dropped = factory.current()
      // 1) the current session drops → schedules a reconnect.
      dropped.emitError(new Error(`drop-${i}`))
      // 2) the reconnect completes → a new session becomes current.
      await settle()
      // 3) a LATE, second 'error' from the now-SUPERSEDED (already-released)
      //    generation — the storm's signature interleaving. It must NOT drive a
      //    second attach loop that orphans the current live session.
      dropped.emitError(new Error(`late-drop-${i}`))
      await settle()

      // The invariant #205 never asserted: at most ONE live session, ever.
      expect(factory.liveCount(), `cycle ${i}: live sessions`).toBeLessThanOrEqual(1)

      // A real pg NOTIFY reaches every live session; with no orphan it dispatches
      // exactly once (an orphaned session would double-dispatch).
      onGrantUpdate.mockClear()
      factory.broadcast(NOTIFY)
      expect(onGrantUpdate, `cycle ${i}: dispatch count`).toHaveBeenCalledTimes(1)
    }

    // No runaway parallel reconnect loops: ~one scheduled sleep per real drop.
    expect(sleepCalls()).toBeLessThanOrEqual(K + 2)

    await listener.stop()
    expect(factory.liveCount(), 'after stop(): no leaked sessions').toBe(0)
  })

  it('T2: one full reconnect cycle recovers notification flow', async () => {
    const factory = makeFakeClientFactory()
    const { sleep, resolvers } = resolverQueueSleep()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => factory.connect() as never,
      sleep,
    })

    await listener.start()
    const clientA = factory.current()
    expect(factory.liveCount()).toBe(1)

    // Drop A → resolve the backoff → a NEW client B attaches.
    clientA.emitError(new Error('drop'))
    await flush()
    expect(resolvers.length).toBe(1)
    ;(resolvers.shift() as () => void)()
    await flush()

    const clientB = factory.current()
    expect(clientB).not.toBe(clientA)
    expect(clientA.released).toBe(true)
    // B issued its own LISTEN and is the sole live session.
    expect(clientB.query).toHaveBeenCalledWith(
      expect.stringMatching(/LISTEN\s+plugin_workload_sdk_grant_update/)
    )
    expect(factory.liveCount()).toBe(1)

    // A NOTIFY on the recovered session dispatches exactly once.
    factory.broadcast(NOTIFY)
    expect(onGrantUpdate).toHaveBeenCalledTimes(1)
    expect(onGrantUpdate).toHaveBeenCalledWith({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'research',
    })

    await listener.stop()
    expect(factory.liveCount()).toBe(0)
  })

  // ── issue #375 M5 (jozer review): a client that ran LISTEN and carries this
  // module's handlers must never be plain-release()d back to the shared pool.
  // pg-pool re-idles the SAME object (no UNLISTEN, user handlers kept), so the
  // session stays subscribed: it dispatches after stop() and double-dispatches
  // after a reuse. These three tests drive the exact leak paths with the
  // pg-pool-faithful fake and go RED without the UNLISTEN/removeAllListeners/
  // generation hardening.
  it('M5a: stop() during the in-flight LISTEN round-trip leaves NO subscribed, dispatching session behind', async () => {
    const factory = makeFakeClientFactory()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => factory.connect() as never,
    })

    factory.holdListen()
    const startPromise = listener.start() // parks inside the LISTEN round-trip
    await flush()
    await listener.stop() // stop() lands while LISTEN is in flight
    factory.releaseListen() // LISTEN resolves AFTER stop
    await startPromise
    await flush()

    // The released client went back to the pool; it must NOT still be a live
    // subscriber that dispatches into a stopped listener.
    factory.broadcast(NOTIFY)
    expect(onGrantUpdate, 'post-stop dispatch from a pool-returned client').not.toHaveBeenCalled()
    expect(factory.liveCount(), 'no session may stay checked out').toBe(0)
    expect(
      factory.created[0].handlerCount('notification'),
      'listener handlers must be stripped before the client re-enters the pool'
    ).toBe(0)
  })

  it('M5b: stop() then start() reusing the pooled client dispatches exactly once (no stacked handler pairs)', async () => {
    const factory = makeFakeClientFactory()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => factory.connect() as never,
    })

    await listener.start()
    await listener.stop()
    await listener.start() // pg-pool hands back the SAME client object

    expect(factory.created, 'pool-faithful fake must reuse the idle client').toHaveLength(1)
    factory.broadcast(NOTIFY)
    // Without stripping handlers on release, each stop→start cycle stacks one
    // handler pair on the same client and one NOTIFY dispatches twice.
    expect(onGrantUpdate).toHaveBeenCalledTimes(1)
    await listener.stop()
    expect(factory.liveCount()).toBe(0)
  })

  it('M5c: a reconnect parked across stop()→start() must not leave the superseded session subscribed (single dispatch)', async () => {
    const factory = makeFakeClientFactory()
    const { sleep, resolvers } = resolverQueueSleep()
    const onGrantUpdate = vi.fn()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => factory.connect() as never,
      sleep,
    })

    await listener.start()
    const clientA = factory.current()
    clientA.emitError(new Error('drop')) // destroys A, parks a reconnect in its backoff sleep
    await flush()
    await listener.stop()
    await listener.start() // session B attaches and becomes current
    await flush()
    const clientB = factory.current()
    expect(clientB.subscribed).toBe(true)

    // The parked reconnect resumes AFTER the restart: session C attaches and the
    // non-overwrite guard releases B. Pre-fix that release was plain — B stayed
    // subscribed with handlers attached → one logical NOTIFY dispatched twice.
    ;(resolvers.shift() as () => void)()
    await flush()

    expect(factory.liveCount(), 'at most one live session').toBeLessThanOrEqual(1)
    onGrantUpdate.mockClear()
    factory.broadcast(NOTIFY)
    expect(onGrantUpdate, 'superseded session must not double-dispatch').toHaveBeenCalledTimes(1)
    await listener.stop()
    expect(factory.liveCount()).toBe(0)
  })
})

describe('createGrantUpdateListener — reconnect / stop resilience (issue #375 H1-H3)', () => {
  /** A sleep seam that never resolves, so we can count reconnect scheduling without real timers. */
  function pendingSleep() {
    const calls: number[] = []
    const sleep = vi.fn((ms: number) => {
      calls.push(ms)
      return new Promise<void>(() => {
        /* never resolves — the reconnect stays parked in its backoff */
      })
    })
    return { sleep, calls }
  }

  it('H1: a connection drop schedules exactly ONE reconnect even when error fires repeatedly', async () => {
    const fake = makeFakeClient()
    const { sleep, calls } = pendingSleep()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate: vi.fn(),
      logger: makeLogger(),
      connect: async () => fake.client as never,
      sleep,
    })
    await listener.start()

    // Both the LISTEN-rejection path and the 'error' event fire on one drop; and
    // 'error' can fire more than once. All must collapse into a single reconnect.
    fake.emitError(new Error('connection reset'))
    fake.emitError(new Error('connection reset again'))

    expect(fake.client.release).toHaveBeenCalled()
    expect(calls).toHaveLength(1) // exactly one reconnect scheduled, no leaked loops
    await listener.stop()
  })

  it('H3: a LISTEN that fails without an error event releases the client and schedules a retry', async () => {
    const fake = makeFakeClient({ failQuery: true })
    const { sleep, calls } = pendingSleep()
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate: vi.fn(),
      logger: makeLogger(),
      connect: async () => fake.client as never,
      sleep,
    })

    await listener.start()

    // LISTEN query rejected → attach catch must release the checked-out client
    // (no leak) and schedule the retry.
    expect(fake.client.release).toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    await listener.stop()
  })

  it('H2: stop() during an in-flight connect() leaves no live listener and dispatches nothing', async () => {
    const fake = makeFakeClient()
    const onGrantUpdate = vi.fn()
    let resolveConnect!: () => void
    const connectGate = new Promise<void>(resolve => {
      resolveConnect = resolve
    })
    const listener = createGrantUpdateListener({
      pool: {} as never,
      onGrantUpdate,
      logger: makeLogger(),
      connect: async () => {
        await connectGate
        return fake.client as never
      },
    })

    const startPromise = listener.start() // parks awaiting connect()
    await listener.stop() // shutdown while the attach is mid-connect
    resolveConnect() // connect resolves AFTER stop
    await startPromise

    // The attach observed `stopped` after connect() resolved: it released the
    // client and registered NO handlers, so a late notification dispatches nothing.
    expect(fake.client.release).toHaveBeenCalled()
    fake.emitNotification({
      channel: PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL,
      payload: JSON.stringify({ recipeNamespace: 'sandbox-recipes', recipeName: 'research' }),
    })
    expect(onGrantUpdate).not.toHaveBeenCalled()
  })
})
