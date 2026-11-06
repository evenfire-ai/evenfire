import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { CatalogSyncResult, SyncConnector } from '../src/services/llmCatalogSync.js'
import {
  PROVIDER_KEY_MAP,
  type RawModelsDevCatalog,
  mapCatalogToProviders,
} from '../src/services/modelsDevClient.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import type { FakeDb } from './helpers/llmCatalogSyncFakeDb.js'
import {
  LIVE_MODELS_DEV_CAPTURED_AT,
  LIVE_MODELS_DEV_CATALOG,
  loadStub,
  trimLiveCatalog,
} from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Two sessions with a forced interleaving, on real Postgres and on the strict
// fake, through the same production functions: the case passes only when both
// report the same thing — whether a session was left waiting, what each
// statement returned, and the rows left behind. This is what checks the fake's
// waits (key and row locks, the re-read after a wait, advisory locks) against
// Postgres; the sequential differential suite checks only table semantics.
// Skipped without CONTROL_API_REAL_PG_ADMIN_URL.

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

type QueryResult = { rows: unknown[]; rowCount: number | null }
type Client = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  release: (err?: Error | boolean) => void
}
type Hook = {
  when: (sql: string, params: unknown[]) => boolean
  before?: () => Promise<void>
  after?: () => Promise<void>
}

const CLAUDE = trimLiveCatalog({
  anthropic: Object.keys(LIVE_MODELS_DEV_CATALOG.anthropic.models).length,
})
const CLAUDE_IDS = mapCatalogToProviders(CLAUDE).claude.map(m => m.model_id)

function without(catalog: RawModelsDevCatalog, modelIds: string[]): RawModelsDevCatalog {
  const key = PROVIDER_KEY_MAP.claude
  const models = Object.fromEntries(
    Object.entries(catalog[key].models).filter(([rawId]) => {
      const [m] = mapCatalogToProviders(trimLiveCatalog({ [key]: [rawId] })).claude
      return !modelIds.includes(m.model_id)
    })
  )
  return { [key]: { ...catalog[key], models } }
}

const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim()

interface Side {
  name: 'postgres' | 'fake'
  pool: Pool
  /** Resolves 'pending' if `p` has not settled once the other session had time to run. */
  stillPending: (p: Promise<unknown>) => Promise<'pending' | 'settled'>
  state: () => Promise<unknown>
}

describeRealPostgres('strict catalog fake DB vs real PostgreSQL (two sessions)', () => {
  const database = `control_api_fake_conc_${randomBytes(6).toString('hex')}`
  // describe.skip still runs this factory, so it must not build a URL without the env.
  const connectionString = adminUrl ? databaseUrl(adminUrl, database) : ''
  const previousPgEnv = process.env.CONTROL_API_PG_CONNECTION_STRING

  let adminPool: Pool
  let corePool: Pool
  let limiterPool: Pool
  let mod: {
    syncDiscoveredModels: typeof import('../src/services/llmCatalogSync.js').syncDiscoveredModels
    createAllowedModel: typeof import('../src/services/llmAllowedModels.js').createAllowedModel
    updateAllowedModel: typeof import('../src/services/llmAllowedModels.js').updateAllowedModel
    deleteAllowedModel: typeof import('../src/services/llmAllowedModels.js').deleteAllowedModel
    createLlmPrice: typeof import('../src/services/llmPrices.js').createLlmPrice
    setProviderAutoEnable: typeof import('../src/services/llmProviderCatalogSettings.js').setProviderAutoEnable
    runLlmCatalogSyncTick: typeof import('../src/services/llmCatalogSyncCron.js').runLlmCatalogSyncTick
    withTransaction: typeof import('../src/db.js').withTransaction
    Writer: typeof import('../src/services/llmAllowedModelsConfigMap.js').LlmAllowedModelsConfigMapWriter
    makeFakeDb: typeof import('./helpers/llmCatalogSyncFakeDb.js').makeFakeDb
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`)
    process.env.CONTROL_API_PG_CONNECTION_STRING = connectionString
    const dbMod = await import('../src/db.js')
    corePool = dbMod.pool as unknown as Pool
    corePool.on('error', () => {})
    limiterPool = dbMod.rateLimitPool as unknown as Pool
    limiterPool.on('error', () => {})
    const migratePool = new Pool({ connectionString })
    await dbMod.initDb({ connect: () => migratePool.connect() })
    await endPoolAndWaitForClients(migratePool)
    const allowlist = await import('../src/services/llmAllowedModels.js')
    mod = {
      syncDiscoveredModels: (await import('../src/services/llmCatalogSync.js'))
        .syncDiscoveredModels,
      createAllowedModel: allowlist.createAllowedModel,
      updateAllowedModel: allowlist.updateAllowedModel,
      deleteAllowedModel: allowlist.deleteAllowedModel,
      createLlmPrice: (await import('../src/services/llmPrices.js')).createLlmPrice,
      setProviderAutoEnable: (await import('../src/services/llmProviderCatalogSettings.js'))
        .setProviderAutoEnable,
      runLlmCatalogSyncTick: (await import('../src/services/llmCatalogSyncCron.js'))
        .runLlmCatalogSyncTick,
      withTransaction: dbMod.withTransaction,
      Writer: (await import('../src/services/llmAllowedModelsConfigMap.js'))
        .LlmAllowedModelsConfigMapWriter,
      // Imported only now: the helper loads db.js, whose pool must see the URL above.
      makeFakeDb: (await import('./helpers/llmCatalogSyncFakeDb.js')).makeFakeDb,
    }
  }, 60_000)

  afterAll(async () => {
    try {
      if (previousPgEnv === undefined) delete process.env.CONTROL_API_PG_CONNECTION_STRING
      else process.env.CONTROL_API_PG_CONNECTION_STRING = previousPgEnv
      await endPoolAndWaitForClients(corePool).catch(() => {})
      await endPoolAndWaitForClients(limiterPool).catch(() => {})
      if (adminPool) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  type Row = Record<string, unknown>
  const normalize = (models: Row[], dismissed: string[], prices: Row[]) => ({
    models: models
      .map(r => ({
        pair: `${r.provider}/${r.model}`,
        enabled: r.enabled,
        source: r.source,
        stale: r.stale,
        image_input: r.image_input === null ? null : 'set',
      }))
      .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0)),
    dismissed: [...dismissed].sort(),
    prices: prices.map(p => `${p.provider}/${p.model}:${p.enabled}`).sort(),
  })

  const fakeRows = new WeakMap<Side, () => Row[]>()

  async function postgresSide(): Promise<Side> {
    await corePool.query(`
      DELETE FROM llm_allowed_models;
      DELETE FROM llm_catalog_dismissed;
      DELETE FROM llm_model_prices;
      DELETE FROM llm_provider_catalog_settings;
      DELETE FROM llm_catalog_sync_runs;
    `)
    return {
      name: 'postgres',
      pool: corePool,
      // Postgres blocks a waiter until the holder ends; 300 ms is far longer
      // than any of these statements takes unblocked.
      stillPending: async p => {
        let settled = false
        void p.then(
          () => (settled = true),
          () => (settled = true)
        )
        await new Promise(resolve => setTimeout(resolve, 300))
        return settled ? 'settled' : 'pending'
      },
      state: async () => {
        const q = (sql: string) => corePool.query(sql).then(r => r.rows as Row[])
        return normalize(
          await q('SELECT * FROM llm_allowed_models'),
          (await q('SELECT provider, model FROM llm_catalog_dismissed')).map(
            r => `${r.provider}/${r.model}`
          ),
          await q('SELECT * FROM llm_model_prices')
        )
      },
    }
  }

  function fakeSide(): Side {
    const db: FakeDb = mod.makeFakeDb()
    const side: Side = {
      name: 'fake',
      pool: db.pool('session'),
      // The fake does no I/O: anything that can run has run after a few turns
      // of the event loop.
      stillPending: async p => {
        let settled = false
        void p.then(
          () => (settled = true),
          () => (settled = true)
        )
        for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve))
        return settled ? 'settled' : 'pending'
      },
      state: async () =>
        normalize(db.rows as unknown as Row[], [...db.dismissed], db.prices as unknown as Row[]),
    }
    fakeRows.set(side, () => db.rows as unknown as Row[])
    return side
  }

  /** The side's pool, with hooks around the statements they match. */
  function hooked(side: Side, hooks: Hook[]): SyncConnector {
    return {
      connect: async () => {
        const client = (await side.pool.connect()) as unknown as Client
        return {
          query: async (sql: string, params: unknown[] = []) => {
            const hook = hooks.find(h => h.when(compact(sql), params))
            await hook?.before?.()
            const result = await client.query(sql, params)
            await hook?.after?.()
            return result
          },
          release: () => client.release(),
        }
      },
    }
  }

  function sync(side: Side, catalog: RawModelsDevCatalog, connector?: SyncConnector) {
    return mod.syncDiscoveredModels(
      {
        materializer: new mod.Writer(new FakeConfigMapApi() as never, 'mcp-host', 3, side.pool),
        loadCatalog: loadStub(catalog, 'live', LIVE_MODELS_DEV_CAPTURED_AT),
        minPlausibleLiveTotal: 1,
        autoEnableMaxPerProviderPerRun: 1_000,
        autoEnableMaxPerRun: 1_000,
      },
      connector ?? (side.pool as unknown as SyncConnector)
    )
  }

  async function openTx(side: Side) {
    const client = (await side.pool.connect()) as unknown as Client
    await client.query('BEGIN')
    return {
      db: client as never,
      end: async (how: 'COMMIT' | 'ROLLBACK') => {
        await client.query(how)
        client.release()
      },
    }
  }

  async function idOf(side: Side, provider: string, model: string): Promise<string> {
    const row = (await sideRows(side)).find(r => r.provider === provider && r.model === model)
    if (!row) throw new Error(`${side.name}: no row ${provider}/${model}`)
    return String(row.id)
  }

  async function sideRows(side: Side): Promise<Row[]> {
    if (side.name === 'postgres') {
      return (await corePool.query('SELECT * FROM llm_allowed_models')).rows as Row[]
    }
    return fakeRows.get(side)!()
  }

  /**
   * Runs `scenario` on Postgres and on the fake. Postgres must produce
   * `expected` (what each session observed), so a hook that stops matching its
   * statement cannot pass by leaving both sides equally unobserved; the fake
   * must then match Postgres, rows included.
   */
  async function bothSides(
    scenario: (side: Side) => Promise<Record<string, unknown>>,
    expected: Record<string, unknown>
  ): Promise<void> {
    const pg = await postgresSide()
    const pgOut = await scenario(pg)
    expect(pgOut, 'what each Postgres session observed').toEqual(expected)
    const pgState = await pg.state()
    const fk = fakeSide()
    const fkOut = await scenario(fk)
    const fkState = await fk.state()
    expect({ ...fkOut, state: fkState }).toEqual({ ...pgOut, state: pgState })
  }

  const settledOutcome = async (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (err: { name?: string }) => `rejected:${err?.name ?? 'error'}`
    )

  const P = CLAUDE_IDS[0]
  const isInsertOf = (model: string) => (sql: string, params: unknown[]) =>
    sql.startsWith('INSERT INTO llm_allowed_models (provider, model, enabled, source') &&
    params[1] === model
  const isPriceInsertOf = (model: string) => (sql: string, params: unknown[]) =>
    sql.startsWith('INSERT INTO llm_model_prices') &&
    sql.includes('NOT EXISTS') &&
    params[1] === model

  it('sync INSERT waits for an in-flight rename into the pair, then leaves it to the rename', async () => {
    await bothSides(
      async side => {
        await mod.createAllowedModel(
          { provider: 'claude', model: 'operator-q', enabled: true } as never,
          'admin',
          side.pool
        )
        const a = await openTx(side)
        await mod.updateAllowedModel(
          await idOf(side, 'claude', 'operator-q'),
          { model: P } as never,
          'admin',
          a.db
        )
        const run = sync(side, CLAUDE)
        const waited = await side.stillPending(run)
        await a.end('COMMIT')
        const result = (await run) as CatalogSyncResult
        return { waited, added: result.added }
      },
      { waited: 'pending', added: CLAUDE_IDS.length - 1 }
    )
  }, 30_000)

  it('sync INSERT waits for an in-flight rename that rolls back, then inserts', async () => {
    await bothSides(
      async side => {
        await mod.createAllowedModel(
          { provider: 'claude', model: 'operator-q', enabled: true } as never,
          'admin',
          side.pool
        )
        const a = await openTx(side)
        await mod.updateAllowedModel(
          await idOf(side, 'claude', 'operator-q'),
          { model: P } as never,
          'admin',
          a.db
        )
        const run = sync(side, CLAUDE)
        const waited = await side.stillPending(run)
        await a.end('ROLLBACK')
        const result = (await run) as CatalogSyncResult
        return { waited, added: result.added }
      },
      { waited: 'pending', added: CLAUDE_IDS.length }
    )
  }, 30_000)

  it('sync INSERT waits for an in-flight create; after the conflict it holds nothing on the pair', async () => {
    await bothSides(
      async side => {
        const a = await openTx(side)
        await mod.createAllowedModel(
          { provider: 'claude', model: P, enabled: false } as never,
          'admin',
          a.db
        )
        let deleteDuringSync: string | undefined
        let deletion: Promise<unknown> | undefined
        const connector = hooked(side, [
          {
            when: isInsertOf(P),
            after: async () => {
              deletion = (async () =>
                mod.withTransaction(
                  async tx => mod.deleteAllowedModel(await idOf(side, 'claude', P), 'admin', tx),
                  side.pool
                ))()
              deleteDuringSync = await side.stillPending(deletion)
            },
          },
        ])
        const run = sync(side, CLAUDE, connector)
        const waited = await side.stillPending(run)
        await a.end('COMMIT')
        const result = (await run) as CatalogSyncResult
        await deletion
        return { waited, added: result.added, deleteDuringSync }
      },
      { waited: 'pending', added: CLAUDE_IDS.length - 1, deleteDuringSync: 'settled' }
    )
  }, 30_000)

  it('the catalog price waits for an in-flight operator price; after the conflict it holds nothing', async () => {
    const price = {
      provider: 'claude',
      model: P,
      input_token_price: 1,
      output_token_price: 2,
      cache_read_token_price: 0,
      cache_write_token_price: 0,
      currency: 'USD',
      enabled: true,
    }
    await bothSides(
      async side => {
        const a = await openTx(side)
        await mod.createLlmPrice(price as never, a.db)
        let secondPrice: string | undefined
        const connector = hooked(side, [
          {
            when: isPriceInsertOf(P),
            after: async () => {
              const attempt = settledOutcome(mod.createLlmPrice(price as never, side.pool))
              secondPrice =
                (await side.stillPending(attempt)) === 'pending' ? 'pending' : await attempt
            },
          },
        ])
        const run = sync(side, CLAUDE, connector)
        const waited = await side.stillPending(run)
        await a.end('COMMIT')
        await run
        return { waited, secondPrice }
      },
      { waited: 'pending', secondPrice: 'rejected:LlmPriceConflictError' }
    )
  }, 30_000)

  it('stale marking waits for an in-flight admin update of the row, then marks it', async () => {
    await bothSides(
      async side => {
        await sync(side, CLAUDE)
        const a = await openTx(side)
        await mod.updateAllowedModel(
          await idOf(side, 'claude', P),
          { enabled: false } as never,
          'admin',
          a.db
        )
        const run = sync(side, without(CLAUDE, [P]))
        const waited = await side.stillPending(run)
        await a.end('COMMIT')
        const result = (await run) as CatalogSyncResult
        return { waited, staled: result.staled }
      },
      { waited: 'pending', staled: 1 }
    )
  }, 30_000)

  it('stale marking re-reads the row after the wait: a row moved to another provider is skipped', async () => {
    await bothSides(
      async side => {
        await sync(side, CLAUDE)
        const a = await openTx(side)
        await mod.updateAllowedModel(
          await idOf(side, 'claude', P),
          { provider: 'groq' } as never,
          'admin',
          a.db
        )
        const run = sync(side, without(CLAUDE, [P]))
        const waited = await side.stillPending(run)
        await a.end('COMMIT')
        const result = (await run) as CatalogSyncResult
        return { waited, staled: result.staled }
      },
      { waited: 'pending', staled: 0 }
    )
  }, 30_000)

  it('the refresh UPDATE re-reads a row renamed meanwhile, skips it and keeps it locked', async () => {
    await bothSides(
      async side => {
        await sync(side, CLAUDE)
        const id = await idOf(side, 'claude', P)
        const a = await openTx(side)
        await mod.updateAllowedModel(id, { model: `${P}-renamed` } as never, 'admin', a.db)
        let enableDuringSync: string | undefined
        let enabling: Promise<unknown> | undefined
        const connector = hooked(side, [
          {
            when: (sql, params) => sql.includes('SET last_seen_at = NOW()') && params[0] === id,
            after: async () => {
              enabling = mod.withTransaction(
                tx => mod.updateAllowedModel(id, { enabled: false } as never, 'admin', tx),
                side.pool
              )
              enableDuringSync = await side.stillPending(enabling)
            },
          },
        ])
        const run = sync(side, CLAUDE, connector)
        const waited = await side.stillPending(run)
        await a.end('COMMIT')
        const result = (await run) as CatalogSyncResult
        await enabling
        return { waited, updated: result.updated, enableDuringSync }
      },
      { waited: 'pending', updated: CLAUDE_IDS.length - 1, enableDuringSync: 'pending' }
    )
  }, 30_000)

  it('a policy toggle waits for a running sync and the run keeps the policy it read', async () => {
    await bothSides(
      async side => {
        let toggle: Promise<unknown> | undefined
        let toggleDuringSync: string | undefined
        const connector = hooked(side, [
          {
            when: (sql, params) =>
              sql === 'SELECT pg_advisory_xact_lock(hashtext($1))' &&
              params[0] === 'llm-catalog-sync-v1',
            after: async () => {
              toggle = mod.setProviderAutoEnable('claude', false, 'admin', side.pool)
              toggleDuringSync = await side.stillPending(toggle)
            },
          },
        ])
        const result = (await sync(side, CLAUDE, connector)) as CatalogSyncResult
        await toggle
        return { toggleDuringSync, autoEnabled: result.providerCounts?.claude?.autoEnabled }
      },
      { toggleDuringSync: 'pending', autoEnabled: CLAUDE_IDS.length }
    )
  }, 30_000)

  it('a cron tick skips while another session holds the cron lock, and runs once it is free', async () => {
    const TRY = "SELECT pg_try_advisory_lock(hashtext('llm-catalog-sync-cron-v1')) AS acquired"
    const UNLOCK = "SELECT pg_advisory_unlock(hashtext('llm-catalog-sync-cron-v1'))"
    await bothSides(
      async side => {
        const holder = (await side.pool.connect()) as unknown as Client
        await holder.query(TRY)
        const deps = { connector: side.pool as never, sync: () => sync(side, CLAUDE) }
        const first = await mod.runLlmCatalogSyncTick(deps)
        await holder.query(UNLOCK)
        holder.release()
        const second = await mod.runLlmCatalogSyncTick(deps)
        return {
          first: { skippedLock: first.skippedLock, ran: first.ran },
          second: { skippedLock: second.skippedLock, ran: second.ran },
        }
      },
      { first: { skippedLock: true, ran: false }, second: { skippedLock: false, ran: true } }
    )
  }, 30_000)
})
