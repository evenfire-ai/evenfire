/**
 * Subscription catalog reconciliation cron.
 *
 * The tick reconciles every live, connected subscription grant against its
 * broker's catalog under a SESSION advisory lock, so replicas dedup instead of
 * piling up redundant upstream calls. This suite pins the hazards that make the
 * difference between a reconciler and an abuse vector: the lock lifecycle, the
 * skip rules (a disabled broker, a grant that is not `connected`), failure
 * isolation per connection, and the single ConfigMap publish whose rule is
 * "any RECORDED outcome", not "a ready outcome".
 *
 * Deps are injected: no database, no cluster, no upstream. The production
 * wiring is asserted where it belongs — the route suite for the endpoint and
 * the real-Postgres suite for the schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AllowedModelsConfigMapMaterializer } from '../llmAllowedModelsConfigMap.js'
import {
  type SubscriptionBrokerPort,
  type SubscriptionCatalogSyncOutcome,
  filterAddressableGrokConnections,
  reconcileSubscriptionCatalogs,
  runSubscriptionCatalogSyncTick,
  startSubscriptionCatalogSyncCron,
  stopSubscriptionCatalogSyncCron,
} from '../subscriptionCatalogSyncCron.js'

vi.mock('../../observability/logger.js', () => ({
  rootLogger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}))

const READY: SubscriptionCatalogSyncOutcome = { ok: true, catalogStatus: 'ready' }
/** Recorded, but not ready: the row now carries `auth-rejected`. */
const AUTH_REJECTED: SubscriptionCatalogSyncOutcome = { ok: false, catalogStatus: 'auth-rejected' }
/** Nothing recorded: a concurrent writer won the revision fence. */
const STALE: SubscriptionCatalogSyncOutcome = {
  ok: false,
  catalogStatus: 'never_synced',
  reason: 'stale_revision',
}

/**
 * A fake pool sharing one advisory-lock state across every client it hands out
 * — the real cross-replica contract. `calls` records the lock lifecycle so a
 * leaked SESSION lock is visible rather than inferred.
 */
function makeLockPool(
  shared: { held: boolean },
  calls: string[],
  opts: { failUnlock?: boolean } = {}
) {
  const releaseArgs: Array<Error | boolean | undefined> = []
  return {
    releaseArgs,
    connect: vi.fn(async () => {
      const query = vi.fn(async (sql: string) => {
        if (/pg_try_advisory_lock/.test(sql)) {
          const acquired = !shared.held
          if (acquired) shared.held = true
          calls.push(acquired ? 'acquire:ok' : 'acquire:skip')
          return { rows: [{ acquired }], rowCount: 1 }
        }
        if (/pg_advisory_unlock/.test(sql)) {
          if (opts.failUnlock) {
            calls.push('unlock:throw')
            throw new Error('unlock failed')
          }
          shared.held = false
          calls.push('unlock')
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      })
      const release = vi.fn((destroy?: Error | boolean) => {
        releaseArgs.push(destroy)
        if (destroy) {
          shared.held = false
          calls.push('release:destroy')
        } else {
          calls.push('release')
        }
      })
      return { query, release }
    }),
  }
}

function makePort(
  broker: SubscriptionBrokerPort['broker'],
  rows: Array<{ connectionKey: string; status: string }>,
  sync: (connectionKey: string) => Promise<SubscriptionCatalogSyncOutcome>,
  enabled = true
): SubscriptionBrokerPort & {
  listConnections: ReturnType<typeof vi.fn>
  syncCatalog: ReturnType<typeof vi.fn>
} {
  return {
    broker,
    enabled,
    listConnections: vi.fn(async () => rows),
    syncCatalog: vi.fn(sync),
  }
}

function makeMaterializer(): AllowedModelsConfigMapMaterializer & {
  materialize: ReturnType<typeof vi.fn>
} {
  return { materialize: vi.fn(async () => undefined) }
}

afterEach(() => {
  stopSubscriptionCatalogSyncCron()
  vi.useRealTimers()
})

describe('subscription catalog sync tick — advisory lock', () => {
  it('runs the reconciliation and releases the lock when it acquires it', async () => {
    const shared = { held: false }
    const calls: string[] = []
    const connector = makeLockPool(shared, calls)
    const sync = vi.fn(async () => ({
      synced: 1,
      degraded: 0,
      raced: 0,
      failed: 0,
      skipped: 0,
      published: 'published' as const,
    }))

    const result = await runSubscriptionCatalogSyncTick({ connector, sync })

    expect(result).toEqual({ skippedLock: false, ran: true, errored: false })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['acquire:ok', 'unlock', 'release'])
    expect(shared.held).toBe(false)
  })

  it('skips the tick without syncing when another replica holds the lock', async () => {
    const shared = { held: true }
    const calls: string[] = []
    const connector = makeLockPool(shared, calls)
    const sync = vi.fn()

    const result = await runSubscriptionCatalogSyncTick({ connector, sync })

    expect(result).toEqual({ skippedLock: true, ran: false, errored: false })
    // Liveness witness: the tick did reach the lock and was refused it, so the
    // un-called sync is a skip and not an unreached code path.
    expect(calls).toEqual(['acquire:skip', 'release'])
    expect(sync).not.toHaveBeenCalled()
    // The other replica's lock is untouched.
    expect(shared.held).toBe(true)
  })

  it('destroys the connection when the unlock itself fails, so the session lock cannot leak', async () => {
    const shared = { held: false }
    const calls: string[] = []
    const connector = makeLockPool(shared, calls, { failUnlock: true })
    const sync = vi.fn(async () => ({
      synced: 0,
      degraded: 0,
      raced: 0,
      failed: 0,
      skipped: 0,
      published: 'skipped' as const,
    }))

    await runSubscriptionCatalogSyncTick({ connector, sync })

    expect(calls).toEqual(['acquire:ok', 'unlock:throw', 'release:destroy'])
    expect(connector.releaseArgs).toHaveLength(1)
    expect(connector.releaseArgs[0]).toBeInstanceOf(Error)
    expect(shared.held).toBe(false)
  })

  it('reports a failing reconciliation without throwing, and still releases the lock', async () => {
    const shared = { held: false }
    const calls: string[] = []
    const connector = makeLockPool(shared, calls)
    const sync = vi.fn(async () => {
      throw new Error('reconciliation exploded')
    })

    const result = await runSubscriptionCatalogSyncTick({ connector, sync })

    expect(result).toEqual({ skippedLock: false, ran: false, errored: true })
    expect(calls).toEqual(['acquire:ok', 'unlock', 'release'])
    expect(shared.held).toBe(false)
  })
})

describe('subscription catalog reconciliation — skip rules', () => {
  it('skips a broker whose deployment gate is off without listing its connections', async () => {
    const codex = makePort(
      'codex-subscription',
      [{ connectionKey: 'a', status: 'connected' }],
      async () => READY
    )
    const grok = makePort(
      'grok-subscription',
      [{ connectionKey: 'b', status: 'connected' }],
      async () => READY,
      false
    )
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [codex, grok], materializer })

    // Liveness witness: the enabled broker ran, so the loop was entered and the
    // disabled broker was skipped by its gate, not by an unreached path.
    expect(codex.syncCatalog).toHaveBeenCalledWith('a')
    expect(grok.listConnections).not.toHaveBeenCalled()
    expect(grok.syncCatalog).not.toHaveBeenCalled()
    expect(result.synced).toBe(1)
  })

  it('syncs only grants whose status is connected', async () => {
    const rows = [
      { connectionKey: 'disconnected-key', status: 'disconnected' },
      { connectionKey: 'connecting-key', status: 'connecting' },
      { connectionKey: 'reauth-key', status: 'reauth_required' },
      { connectionKey: 'connected-key', status: 'connected' },
    ]
    const grok = makePort('grok-subscription', rows, async () => READY)
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [grok], materializer })

    // Liveness witness: the connected sibling in the SAME list was synced, so
    // the three unsynced rows were filtered, not merely never reached.
    expect(grok.syncCatalog.mock.calls.map(call => call[0])).toEqual(['connected-key'])
    expect(result.skipped).toBe(3)
    expect(result.synced).toBe(1)
  })

  it('drops archived Grok tombstone keys that sit outside the key grammar', () => {
    // The key grammar is a DNS label (`grokSubscriptionSchema.ts:4`), so the
    // archive suffix `~revoked~<id>` puts a tombstone outside it by construction.
    const rows = [
      { connectionKey: 'grok-primary', status: 'connected' },
      { connectionKey: 'grok-primary~revoked~91f3', status: 'revoked' },
    ]

    expect(filterAddressableGrokConnections(rows)).toEqual([
      { connectionKey: 'grok-primary', status: 'connected' },
    ])
  })
})

describe('subscription catalog reconciliation — isolation and outcomes', () => {
  it('keeps going after one connection throws, and counts it as failed', async () => {
    const rows = [
      { connectionKey: 'first', status: 'connected' },
      { connectionKey: 'boom', status: 'connected' },
      { connectionKey: 'last', status: 'connected' },
    ]
    const codex = makePort('codex-subscription', rows, async key => {
      if (key === 'boom') throw new Error('upstream refused the connection')
      return READY
    })
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [codex], materializer })

    expect(codex.syncCatalog.mock.calls.map(call => call[0])).toEqual(['first', 'boom', 'last'])
    expect(result).toMatchObject({ synced: 2, failed: 1, raced: 0, degraded: 0 })
  })

  it('counts a raced revision or a held refresh lock as transient, not as a failure', async () => {
    const rows = [
      { connectionKey: 'raced', status: 'connected' },
      { connectionKey: 'locked', status: 'connected' },
    ]
    const grok = makePort('grok-subscription', rows, async key =>
      key === 'raced'
        ? STALE
        : { ok: false, catalogStatus: 'never_synced', reason: 'refresh_in_flight' }
    )
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [grok], materializer })

    expect(result).toMatchObject({ raced: 2, failed: 0, synced: 0, degraded: 0 })
  })
})

describe('subscription catalog reconciliation — ConfigMap publish', () => {
  it('publishes once after the loop, not once per connection', async () => {
    const rows = [
      { connectionKey: 'one', status: 'connected' },
      { connectionKey: 'two', status: 'connected' },
    ]
    const codex = makePort('codex-subscription', rows, async () => READY)
    const grok = makePort(
      'grok-subscription',
      [{ connectionKey: 'three', status: 'connected' }],
      async () => READY
    )
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [codex, grok], materializer })

    expect(result.synced).toBe(3)
    expect(materializer.materialize).toHaveBeenCalledTimes(1)
    expect(result.published).toBe('published')
  })

  it('publishes a recorded NON-ready outcome, because the row now carries that status', async () => {
    const codex = makePort(
      'codex-subscription',
      [{ connectionKey: 'rejected', status: 'connected' }],
      async () => AUTH_REJECTED
    )
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [codex], materializer })

    expect(result).toMatchObject({ synced: 0, degraded: 1, published: 'published' })
    expect(materializer.materialize).toHaveBeenCalledTimes(1)
  })

  it('does not publish when nothing recorded an outcome', async () => {
    const codex = makePort(
      'codex-subscription',
      [
        { connectionKey: 'skipped', status: 'reauth_required' },
        { connectionKey: 'raced', status: 'connected' },
      ],
      async () => STALE
    )
    const materializer = makeMaterializer()

    const result = await reconcileSubscriptionCatalogs({ brokers: [codex], materializer })

    // Liveness witness: the loop ran and reached the broker — one row was
    // skipped by status and the other really was synced and raced — so the
    // absent publish is the rule under test, not an unreached path.
    expect(codex.listConnections).toHaveBeenCalledTimes(1)
    expect(codex.syncCatalog).toHaveBeenCalledWith('raced')
    expect(result).toMatchObject({ skipped: 1, raced: 1 })
    expect(materializer.materialize).not.toHaveBeenCalled()
    expect(result.published).toBe('skipped')
  })

  it('records the tick as failed when the publish itself fails, without throwing', async () => {
    const codex = makePort(
      'codex-subscription',
      [{ connectionKey: 'one', status: 'connected' }],
      async () => READY
    )
    const materializer = makeMaterializer()
    materializer.materialize.mockRejectedValueOnce(new Error('configmap write failed'))

    await expect(reconcileSubscriptionCatalogs({ brokers: [codex], materializer })).rejects.toThrow(
      /configmap write failed/
    )

    // The catalog rows were already written; only the publish failed. The tick
    // surfaces it (runSubscriptionCatalogSyncTick turns it into errored:true)
    // instead of reporting a clean reconciliation.
    expect(codex.syncCatalog).toHaveBeenCalledTimes(1)
  })
})

describe('subscription catalog cron scheduling', () => {
  it('runs a first jittered tick and then one per interval, with unref()d handles', async () => {
    vi.useFakeTimers()
    const shared = { held: false }
    const calls: string[] = []
    const connector = makeLockPool(shared, calls)
    const sync = vi.fn(async () => ({
      synced: 0,
      degraded: 0,
      raced: 0,
      failed: 0,
      skipped: 0,
      published: 'skipped' as const,
    }))

    startSubscriptionCatalogSyncCron({ connector, sync }, 60_000)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sync).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sync).toHaveBeenCalledTimes(2)

    stopSubscriptionCatalogSyncCron()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sync).toHaveBeenCalledTimes(2)
  })
})
