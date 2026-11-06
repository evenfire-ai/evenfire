/**
 * Serialized publication of the allowlist ConfigMap, against a REAL PostgreSQL:
 * only Postgres can prove the advisory lock, the read on the lock connection
 * and what happens to a publisher whose session dies while it waits on the
 * apiserver. The apiserver is a fake with real create/replace/resourceVersion
 * semantics; its hooks park one publisher at a chosen point.
 *
 * Every final assertion is the observable invariant: the CM holds exactly what
 * the table projects now, computed by the real producers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { ImageInputCapability } from '@clerum/llm-providers'
import { initDb } from '../src/db.js'
import { listEnabledGroupedByProvider } from '../src/services/llmAllowedModels.js'
import {
  CONTENT_HASH_ANNOTATION,
  LlmAllowedModelsConfigMapWriter,
  buildConfigMapData,
} from '../src/services/llmAllowedModelsConfigMap.js'
import { AllowlistPublishRetry } from '../src/services/llmAllowlistPublishRetry.js'
import {
  CatalogPublishAfterCommitError,
  type SyncConnector,
  syncDiscoveredModels,
} from '../src/services/llmCatalogSync.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import { loadStub, trimSnapshot, withModalities } from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const CAPTURED_AT = '2026-08-19T16:16:10.000Z'
const oldDiscovery: ImageInputCapability = {
  state: 'unknown',
  evidence: {
    source: 'discovery',
    reference: 'https://models.dev/api.json',
    checkedAt: '2026-07-01T00:00:00.000Z',
  },
}
const CATALOG = withModalities(trimSnapshot({ anthropic: ['claude-opus-4-6'] }), {
  'claude-opus-4-6': ['text', 'image'],
})
const TEXT_ONLY_CATALOG = withModalities(trimSnapshot({ anthropic: ['claude-opus-4-6'] }), {
  'claude-opus-4-6': ['text'],
})

type Phase = 'read' | 'create' | 'replace'

describeRealPostgres('allowlist ConfigMap publication on real PostgreSQL', () => {
  const database = `control_api_allowlist_pub_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let dbPool: Pool
  let cluster: FakeConfigMapApi

  const writer = (maxAttempts = 3) =>
    new LlmAllowedModelsConfigMapWriter(cluster, 'mcp-host', maxAttempts, dbPool)

  async function expected() {
    return buildConfigMapData(await listEnabledGroupedByProvider(dbPool))
  }

  async function expectConfigMapMatchesDb(): Promise<void> {
    const want = await expected()
    expect(cluster.data).toEqual(want.data)
    expect(cluster.annotations?.[CONTENT_HASH_ANNOTATION]).toBe(want.contentHash)
  }

  async function setEnabled(model: string, enabled: boolean): Promise<void> {
    await dbPool.query(`UPDATE llm_allowed_models SET enabled = $2 WHERE model = $1`, [
      model,
      enabled,
    ])
  }

  /** Backend currently holding the publish lock, if any. */
  async function publishLockHolder(): Promise<number | null> {
    const { rows } = await adminPool.query<{ pid: number }>(
      `SELECT l.pid
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND a.datname = $1`,
      [database]
    )
    return rows[0]?.pid ?? null
  }

  async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise(r => setTimeout(r, 20))
    }
  }

  async function publishLockWaiters(): Promise<number> {
    const { rows } = await adminPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1`,
      [database]
    )
    return Number(rows[0].n)
  }

  /**
   * Kill the session of the publisher that holds the lock: the same effect as
   * the idle-in-transaction timeout firing while it waits on the apiserver.
   * Returns false when no session holds it.
   */
  async function killLockHolder(): Promise<boolean> {
    const pid = await publishLockHolder()
    if (pid === null) return false
    await adminPool.query('SELECT pg_terminate_backend($1)', [pid])
    await waitFor(async () => (await publishLockHolder()) !== pid, 'lock holder to die')
    return true
  }

  /** Park the NEXT call of `phase` until the returned gate is opened. */
  function parkNext(phase: Phase): { reached: Promise<void>; release: () => void } {
    const reached = deferred()
    const gate = deferred()
    let armed = true
    const previous = cluster.hooks.before
    cluster.hooks.before = async (p, body) => {
      if (armed && p === phase) {
        armed = false
        cluster.hooks.before = previous
        reached.resolve()
        await gate.promise
        return
      }
      await previous?.(p, body)
    }
    return { reached: reached.promise, release: gate.resolve }
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    // A terminated idle client in the pool must not crash the run.
    dbPool.on('error', () => undefined)
    await initDb({ connect: () => dbPool.connect() })
  })

  beforeEach(async () => {
    cluster = new FakeConfigMapApi()
    await dbPool.query('DELETE FROM llm_allowed_models')
    await dbPool.query(
      `INSERT INTO llm_allowed_models (provider, model, enabled, source, image_input)
       VALUES ('claude', 'claude-opus-4-6', true, 'discovery', $1::jsonb),
              ('claude', 'claude-opus-4-5', false, 'discovery', NULL),
              ('zai', 'glm-4.7', true, 'manual', NULL)`,
      [JSON.stringify(oldDiscovery)]
    )
    await writer().materialize()
    await expectConfigMapMatchesDb()
  })

  afterAll(async () => {
    try {
      await endPoolAndWaitForClients(dbPool)
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('T-H3: a publication that read before the sync committed cannot leave the CM without the sync', async () => {
    // A (e.g. a boot reconcile on another replica) reads and is parked before writing.
    const parkA = parkNext('replace')
    const a = writer().materialize()
    await parkA.reached

    const retry = new AllowlistPublishRetry()
    const sync = syncDiscoveredModels(
      {
        materializer: writer(),
        publishRetry: retry,
        loadCatalog: loadStub(CATALOG, 'live', CAPTURED_AT),
        minPlausibleLiveTotal: 1,
      },
      dbPool
    )
    let syncSettled = false
    void sync.finally(() => {
      syncSettled = true
    })
    // The sync has committed and its publication is either queued behind A or done.
    await waitFor(
      async () => syncSettled || (await publishLockWaiters()) > 0,
      'the sync to commit and reach its publication'
    )
    const { rows } = await dbPool.query<{ image_input: ImageInputCapability }>(
      `SELECT image_input FROM llm_allowed_models WHERE model = 'claude-opus-4-6'`
    )
    expect(rows[0].image_input.state).toBe('supported')

    parkA.release()
    await a
    const result = await sync
    retry.stop()

    expect(result.enabledImageInputChanged).toBe(1)
    await expectConfigMapMatchesDb()
    const served = JSON.parse(cluster.data!.claude) as Array<{
      model: string
      imageInput?: ImageInputCapability
    }>
    expect(served.find(e => e.model === 'claude-opus-4-6')?.imageInput?.state).toBe('supported')
  })

  it('a retry that publishes while a sync is still uncommitted does not settle that sync', async () => {
    const retry = new AllowlistPublishRetry({ baseDelayMs: 400, maxDelayMs: 400 })
    const syncWith = (catalog: typeof CATALOG, connector: SyncConnector = dbPool) =>
      syncDiscoveredModels(
        {
          materializer: writer(),
          publishRetry: retry,
          loadCatalog: loadStub(catalog, 'live', CAPTURED_AT),
          minPlausibleLiveTotal: 1,
        },
        connector
      )
    try {
      // An earlier run committed and failed to publish: a retry is owed.
      cluster.failNextWrites(3)
      await expect(syncWith(TEXT_ONLY_CATALOG)).rejects.toBeInstanceOf(
        CatalogPublishAfterCommitError
      )
      expect(retry.isPending()).toBe(true)
      const writesBefore = cluster.writes

      // Run A changes what is served and is held right before its COMMIT.
      const atCommit = deferred()
      const releaseCommit = deferred()
      const parkedAtCommit: SyncConnector = {
        connect: async () => {
          const client = await dbPool.connect()
          return {
            query: async (sql: string, params?: unknown[]) => {
              if (sql === 'COMMIT') {
                atCommit.resolve()
                await releaseCommit.promise
              }
              return client.query(sql, params)
            },
            release: () => client.release(),
          }
        },
      }
      const runA = syncWith(CATALOG, parkedAtCommit).catch(err => err)
      await atCommit.promise
      // Setup witness: the retry had not fired yet when A reached its COMMIT.
      expect(cluster.writes).toBe(writesBefore)

      // The retry fires, reads Postgres without A's rows, and succeeds.
      await waitFor(async () => !retry.isPending(), 'the owed retry to publish')
      expect(cluster.writes).toBe(writesBefore + 1)

      // A commits and its own publication fails.
      cluster.failNextWrites(3)
      releaseCommit.resolve()
      expect(await runA).toBeInstanceOf(CatalogPublishAfterCommitError)

      // A's commit is still owed, so the next retry publishes it.
      const want = await expected()
      await waitFor(
        async () => cluster.annotations?.[CONTENT_HASH_ANNOTATION] === want.contentHash,
        'the CM to hold run A'
      ).catch(() => undefined)
      await expectConfigMapMatchesDb()
      const served = JSON.parse(cluster.data!.claude) as Array<{
        model: string
        imageInput?: ImageInputCapability
      }>
      expect(served.find(e => e.model === 'claude-opus-4-6')?.imageInput?.state).toBe('supported')
    } finally {
      retry.stop()
    }
  })

  it('T-H3: two concurrent publications serialize on the lock', async () => {
    const parkA = parkNext('read')
    const a = writer().materialize()
    await parkA.reached
    const b = writer().materialize()
    await waitFor(async () => (await publishLockWaiters()) > 0, 'B to queue on the lock')
    expect(cluster.reads).toBe(1)
    parkA.release()
    await Promise.all([a, b])
    expect(cluster.conflicts).toBe(0)
    await expectConfigMapMatchesDb()
  })

  it('T-H16: A loses the lock during its GET; B publishes D1; A writes nothing', async () => {
    const parkA = parkNext('read')
    const a = writer().materialize()
    await parkA.reached
    const killed = await killLockHolder()

    await setEnabled('claude-opus-4-5', true) // D1
    await writer().materialize() // B
    const afterB = cluster.writes
    await expectConfigMapMatchesDb()

    parkA.release()
    const outcome = await a.then(
      () => 'resolved',
      () => 'rejected'
    )

    expect(outcome).toBe('rejected')
    expect(cluster.writes).toBe(afterB)
    await expectConfigMapMatchesDb()
    // Setup witness: the lock holder really died (the session-loss scenario).
    expect(killed).toBe(true)
  })

  it('T-H16: A loses the lock between attempts; B publishes D1; A does not retry with old data', async () => {
    // A read D0 and its first write fails while its session is killed.
    const parkA = parkNext('replace')
    const a = writer().materialize()
    await parkA.reached
    const killed = await killLockHolder()
    cluster.failNextWrites(1)

    await setEnabled('claude-opus-4-5', true) // D1
    parkA.release()
    const b = writer().materialize()
    const outcome = await a.then(
      () => 'resolved',
      () => 'rejected'
    )
    await b

    expect(outcome).toBe('rejected')
    await expectConfigMapMatchesDb()
    const served = JSON.parse(cluster.data!.claude) as Array<{ model: string }>
    expect(served.map(e => e.model)).toContain('claude-opus-4-5')
    expect(killed).toBe(true)
  })

  it('concurrent publishes all succeed without a single CAS conflict (no 503s)', async () => {
    // Every GET answers only after all of them were issued, so publishers that
    // were NOT serialized would all hold the same resourceVersion and all but
    // one replace would fail its CAS on the single attempt they are given.
    cluster.hooks.after = async phase => {
      if (phase === 'read') await new Promise(r => setTimeout(r, 50))
    }
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => writer(1).materialize())
    )
    cluster.hooks.after = undefined
    expect(results.filter(r => r.status === 'rejected')).toEqual([])
    expect(cluster.conflicts).toBe(0)
    await expectConfigMapMatchesDb()
  })

  it('a hung apiserver cannot pin pool connections: publishes fail in bound and release them', async () => {
    const small = new Pool({ connectionString: databaseUrl(adminUrl!, database), max: 2 })
    small.on('error', () => undefined)
    try {
      cluster.hooks.before = () => new Promise<void>(() => undefined)
      const hung = (): LlmAllowedModelsConfigMapWriter =>
        new LlmAllowedModelsConfigMapWriter(cluster, 'mcp-host', 1, small, 100)
      const publishes = Promise.allSettled(Array.from({ length: 4 }, () => hung().materialize()))
      const deadline = new Promise<'hung'>(r => setTimeout(() => r('hung'), 3_000))
      const settled = await Promise.race([publishes, deadline])
      expect(settled).not.toBe('hung')
      const results = settled as PromiseSettledResult<void>[]
      expect(results.every(r => r.status === 'rejected')).toBe(true)
      expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/timed out/)

      // The pool is whole again: every connection back, and a plain query runs.
      expect(small.idleCount).toBe(small.totalCount)
      const ping = await Promise.race([
        small.query('SELECT 1 AS ok'),
        new Promise<'starved'>(r => setTimeout(() => r('starved'), 1_000)),
      ])
      expect(ping).not.toBe('starved')
    } finally {
      cluster.hooks.before = undefined
      await endPoolAndWaitForClients(small)
    }
  })

  it('T-H23: an admin publish that lost the lock with a replace in flight cannot undo a later disable', async () => {
    // Admin enable commits; its publication A reads it and is parked mid-replace.
    await setEnabled('claude-opus-4-5', true)
    const parkA = parkNext('replace')
    const a = writer().materialize()
    await parkA.reached
    const rvBefore = cluster.resourceVersion
    const killed = await killLockHolder()

    // Admin disable commits; its publication B always writes, so the CM's
    // resourceVersion moves even though B's data equals what the CM holds.
    await setEnabled('claude-opus-4-5', false)
    await writer().materialize()
    expect(cluster.resourceVersion).not.toBe(rvBefore)

    parkA.release()
    await a.catch(() => undefined)

    await expectConfigMapMatchesDb()
    const served = JSON.parse(cluster.data!.claude) as Array<{ model: string }>
    expect(served.map(e => e.model)).not.toContain('claude-opus-4-5')
    expect(killed).toBe(true)
  })
})
