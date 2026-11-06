import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { LlmProviderId } from '@clerum/llm-providers'
import {
  LEGACY_SEEDED_ALLOWED_MODELS,
  LEGACY_SEEDED_MODEL_PRICES,
} from '../src/data/llmCatalogLegacySeeds.js'
import { initDb, withTransaction } from '../src/db.js'
import { createAllowedModel, updateAllowedModel } from '../src/services/llmAllowedModels.js'
import { LlmAllowedModelsConfigMapWriter } from '../src/services/llmAllowedModelsConfigMap.js'
import { syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import { listLlmPrices, updateLlmPrice } from '../src/services/llmPrices.js'
import { type RawModelsDevCatalog, mapCatalogToProviders } from '../src/services/modelsDevClient.js'
import { FakeConfigMapApi } from './helpers/fakeAllowlistCluster.js'
import { CATALOG_CAPTURE_0135, applyLegacyCatalogSeeds } from './helpers/llmCatalogLegacySeeds.js'
import { loadStub } from './helpers/modelsDevFixtures.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'
import './realPostgres.requirement.ts'

// Retiring the seeded catalog (0135), on real PostgreSQL: the migration runs
// through initDb's own runner against a database in the state of an
// installation that applied the old seeds, and the sync then runs on the result.
// Every sync here reads the capture 0135's pair list was derived from, so the
// assertions do not move when the regenerable live fixture does.
const CATALOG = CATALOG_CAPTURE_0135.catalog

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip

const MIGRATION = '0135_llm_retire_seeded_catalog'

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

const key = (provider: string, model: string) => `${provider}/${model}`
// Derived from the catalog, not read from the migration, so a wrong list in
// the migration shows up here as a wrong reclassification.
const CATALOG_IDS = mapCatalogToProviders(CATALOG)
const LISTED = new Set(
  LEGACY_SEEDED_ALLOWED_MODELS.filter(s =>
    (CATALOG_IDS[s.provider as LlmProviderId] ?? []).some(m => m.model_id === s.model)
  ).map(s => key(s.provider, s.model))
)
const UNLISTED_SEEDS = LEGACY_SEEDED_ALLOWED_MODELS.filter(
  s => !LISTED.has(key(s.provider, s.model))
)
const SEED_KEYS = new Set(LEGACY_SEEDED_ALLOWED_MODELS.map(s => key(s.provider, s.model)))

function catalogEntry(provider: string, model: string) {
  const entry = (CATALOG_IDS[provider as LlmProviderId] ?? []).find(m => m.model_id === model)
  expect(entry, `${provider}/${model} in the capture`).toBeDefined()
  return entry!
}

// An operator's own manual row the old seeds never had: a Bedrock inference
// profile. A `WHERE source='manual'` reclassification would take it.
const OPERATOR_PAIR = { provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6-v1:0' } as const
const OPERATOR_KEY = `${OPERATOR_PAIR.provider}/${OPERATOR_PAIR.model}`
// Listed seeds an operator edited before the upgrade.
const DISABLED_SEED = { provider: 'openai', model: 'gpt-5.4' } as const
const RENAMED_DISPLAY_SEED = { provider: 'claude', model: 'claude-opus-4-7' } as const
// A listed seed left enabled with no display name: the sync must not fill it.
const ENABLED_UNNAMED_SEED = { provider: 'claude', model: 'claude-sonnet-4-5' } as const
// A listed seed that a later live catalog no longer carries.
const VANISHING_SEED = { provider: 'claude', model: 'claude-opus-4-6' } as const
// The unlisted seed whose catalog id never matches (models.dev has no such id).
const UNLISTED_SEED = { provider: 'openai', model: 'gpt-5.1-codex' } as const
// A placeholder price an admin edited (one of the four values).
const EDITED_PRICE = { provider: 'claude', model: 'claude-sonnet-4-6' } as const
// A placeholder price whose four values match but whose currency an admin changed.
const RECURRENCIED_PRICE = { provider: 'openai', model: 'gpt-4o' } as const

type AllowedRow = {
  provider: string
  model: string
  vendor: string | null
  display_name: string | null
  context_window_tokens: number | null
  enabled: boolean
  source: string
  stale: boolean
  last_seen_at: Date | null
  image_input: unknown
}

function withoutModel(catalog: RawModelsDevCatalog, providerKey: string, id: string) {
  const copy = structuredClone(catalog)
  expect(copy[providerKey].models[id], `${providerKey}/${id} in the live fixture`).toBeDefined()
  delete copy[providerKey].models[id]
  return copy
}

describeRealPostgres('0135 retires the seeded LLM catalog (real PostgreSQL)', () => {
  let adminPool: Pool
  const pools: Pool[] = []
  const databases: string[] = []

  async function freshDatabase(prefix: string): Promise<Pool> {
    const database = `${prefix}_${randomBytes(6).toString('hex')}`
    await adminPool.query(`CREATE DATABASE "${database}"`)
    databases.push(database)
    const pool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    pools.push(pool)
    await initDb({ connect: () => pool.connect() })
    return pool
  }

  async function reapply(pool: Pool): Promise<void> {
    await pool.query('DELETE FROM schema_migrations WHERE version = $1', [MIGRATION])
    await initDb({ connect: () => pool.connect() })
  }

  async function allowed(pool: Pool): Promise<Map<string, AllowedRow>> {
    const { rows } = await pool.query<AllowedRow>(
      `SELECT provider, model, vendor, display_name, context_window_tokens, enabled, source,
              stale, last_seen_at, image_input
         FROM llm_allowed_models ORDER BY provider, model`
    )
    return new Map(rows.map(r => [key(r.provider, r.model), r]))
  }

  function sync(pool: Pool, catalog: RawModelsDevCatalog) {
    return syncDiscoveredModels(
      {
        materializer: new LlmAllowedModelsConfigMapWriter(
          new FakeConfigMapApi(),
          'mcp-host',
          3,
          pool
        ),
        loadCatalog: loadStub(catalog, 'live', CATALOG_CAPTURE_0135.capturedAt),
      },
      pool
    )
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
  })

  afterAll(async () => {
    try {
      for (const pool of pools) await endPoolAndWaitForClients(pool).catch(() => {})
      for (const database of databases) {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        )
        await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
      }
    } finally {
      await adminPool?.end()
    }
  })

  it('fresh install: initDb leaves no seeded allowlist rows and no placeholder prices', async () => {
    const pool = await freshDatabase('control_api_retire_seed_fresh')
    const { rows: applied } = await pool.query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [MIGRATION]
    )
    expect(applied).toHaveLength(1)
    expect((await allowed(pool)).size).toBe(0)
    expect(await listLlmPrices(pool)).toEqual([])
  })

  describe('existing install (seeds applied before the upgrade)', () => {
    let pool: Pool
    let before: Map<string, AllowedRow>
    let afterMigration: Map<string, AllowedRow>
    let pricesAfterMigration: Awaited<ReturnType<typeof listLlmPrices>>

    beforeAll(async () => {
      pool = await freshDatabase('control_api_retire_seed_existing')
      // Back to the state of an installation at 0134 that applied the seeds.
      await pool.query('DELETE FROM schema_migrations WHERE version = $1', [MIGRATION])
      await applyLegacyCatalogSeeds(pool)

      // Operator activity before the upgrade, through the real services.
      await createAllowedModel(
        { ...OPERATOR_PAIR, display_name: 'Sonnet 4.6 (us profile)', enabled: true },
        'test-admin',
        pool
      )
      const seeded = await pool.query<{ id: string; provider: string; model: string }>(
        'SELECT id, provider, model FROM llm_allowed_models'
      )
      const idOf = (p: { provider: string; model: string }) =>
        seeded.rows.find(r => r.provider === p.provider && r.model === p.model)!.id
      await withTransaction(
        tx => updateAllowedModel(idOf(DISABLED_SEED), { enabled: false }, 'test-admin', tx),
        pool
      )
      await withTransaction(
        tx =>
          updateAllowedModel(
            idOf(RENAMED_DISPLAY_SEED),
            { display_name: 'Opus (house name)', context_window_tokens: 123_456 },
            'test-admin',
            tx
          ),
        pool
      )
      const prices = await listLlmPrices(pool)
      const priceId = (p: { provider: string; model: string }) =>
        prices.find(r => r.provider === p.provider && r.model === p.model)!.id
      await updateLlmPrice(priceId(EDITED_PRICE), { output_token_price: 16 }, pool)
      await updateLlmPrice(priceId(RECURRENCIED_PRICE), { currency: 'EUR' }, pool)

      // An installation that ran a sync before upgrading: the sync gave the
      // manual seed rows the catalog lists their image_input evidence (the only
      // column it writes on a manual row) and inserted the rest of the catalog
      // as discovery rows. This is the sync of this release rather than of the
      // previous one; on a manual row both write only image_input, and the
      // discovery rows it adds are not the subject of 0135.
      await sync(pool, CATALOG)

      before = new Map(
        [...(await allowed(pool))].filter(([k]) => SEED_KEYS.has(k) || k === OPERATOR_KEY)
      )
      expect(before.size).toBe(LEGACY_SEEDED_ALLOWED_MODELS.length + 1)
      expect([...before.values()].every(r => r.source === 'manual')).toBe(true)
      const evidenced = [...LISTED].filter(k => before.get(k)!.image_input !== null)
      expect(evidenced).toHaveLength(LISTED.size)

      await initDb({ connect: () => pool.connect() })
      afterMigration = await allowed(pool)
      pricesAfterMigration = await listLlmPrices(pool)
    })

    it('reclassifies exactly the listed seeds to discovery and writes nothing else on them', () => {
      for (const [k, prior] of before) {
        const row = afterMigration.get(k)!
        expect(row.source, k).toBe(LISTED.has(k) ? 'discovery' : 'manual')
        // Includes image_input: the evidence the earlier sync wrote is kept.
        expect({ ...row, source: prior.source }, k).toEqual(prior)
      }
      expect(
        [...before.keys()].filter(k => afterMigration.get(k)!.source === 'discovery')
      ).toHaveLength(LISTED.size)
      // The operator's edits on listed seeds survive.
      expect(afterMigration.get(key(DISABLED_SEED.provider, DISABLED_SEED.model))!.enabled).toBe(
        false
      )
      const renamed = afterMigration.get(
        key(RENAMED_DISPLAY_SEED.provider, RENAMED_DISPLAY_SEED.model)
      )!
      expect(renamed.display_name).toBe('Opus (house name)')
      expect(renamed.context_window_tokens).toBe(123_456)
    })

    it('leaves an operator-added manual pair and the unlisted seeds manual', () => {
      expect(afterMigration.get(key(OPERATOR_PAIR.provider, OPERATOR_PAIR.model))!.source).toBe(
        'manual'
      )
      expect(UNLISTED_SEEDS.length).toBeGreaterThan(0)
      for (const s of UNLISTED_SEEDS) {
        expect(afterMigration.get(key(s.provider, s.model))!.source).toBe('manual')
      }
    })

    it('deletes the placeholder prices still identical to 0044 and keeps the edited ones', () => {
      const placeholderKeys = new Set(LEGACY_SEEDED_MODEL_PRICES.map(p => key(p.provider, p.model)))
      const left = new Map(
        pricesAfterMigration
          .filter(p => placeholderKeys.has(key(p.provider, p.model)))
          .map(p => [key(p.provider, p.model), p])
      )
      expect([...left.keys()].sort()).toEqual(
        [
          key(EDITED_PRICE.provider, EDITED_PRICE.model),
          key(RECURRENCIED_PRICE.provider, RECURRENCIED_PRICE.model),
        ].sort()
      )
      expect(left.get(key(EDITED_PRICE.provider, EDITED_PRICE.model))!.output_token_price).toBe(16)
      expect(left.get(key(RECURRENCIED_PRICE.provider, RECURRENCIED_PRICE.model))!.currency).toBe(
        'EUR'
      )
      expect(LEGACY_SEEDED_MODEL_PRICES.length - left.size).toBe(6)
    })

    it('is idempotent: running it again changes nothing', async () => {
      await reapply(pool)
      expect(await allowed(pool)).toEqual(afterMigration)
      expect(await listLlmPrices(pool)).toEqual(pricesAfterMigration)
    })

    it('T-C11 · after a live run the sync manages the listed seeds and leaves the manual ones alone', async () => {
      await sync(pool, CATALOG)
      const rows = await allowed(pool)

      for (const k of LISTED) {
        const row = rows.get(k)!
        expect(row.source, k).toBe('discovery')
        expect(row.stale, k).toBe(false)
        expect(row.last_seen_at, k).not.toBeNull()
        expect(row.enabled, k).toBe(afterMigration.get(k)!.enabled)
      }
      const renamed = rows.get(key(RENAMED_DISPLAY_SEED.provider, RENAMED_DISPLAY_SEED.model))!
      expect(renamed.display_name).toBe('Opus (house name)')
      expect(renamed.context_window_tokens).toBe(123_456)
      // The sync never touches display name or context window of an enabled
      // row, and on a disabled one only fills what is NULL.
      const unnamed = rows.get(key(ENABLED_UNNAMED_SEED.provider, ENABLED_UNNAMED_SEED.model))!
      expect(
        afterMigration.get(key(ENABLED_UNNAMED_SEED.provider, ENABLED_UNNAMED_SEED.model))!.enabled
      ).toBe(true)
      expect(unnamed.display_name).toBeNull()
      expect(unnamed.context_window_tokens).toBeNull()
      const disabled = rows.get(key(DISABLED_SEED.provider, DISABLED_SEED.model))!
      const disabledBefore = afterMigration.get(key(DISABLED_SEED.provider, DISABLED_SEED.model))!
      expect(disabledBefore.display_name).toBeNull()
      expect(disabledBefore.context_window_tokens).toBeNull()
      const disabledEntry = catalogEntry(DISABLED_SEED.provider, DISABLED_SEED.model)
      expect(disabled.enabled).toBe(false)
      expect(disabled.display_name).toBe(disabledEntry.display_name)
      expect(disabled.context_window_tokens).toBe(disabledEntry.context_window_tokens)
      expect(disabled.display_name).not.toBeNull()

      // Seeds models.dev does not list, and the operator's pair: still manual,
      // never stale, never seen.
      for (const k of [
        ...UNLISTED_SEEDS.map(s => key(s.provider, s.model)),
        key(OPERATOR_PAIR.provider, OPERATOR_PAIR.model),
      ]) {
        const row = rows.get(k)!
        expect(row.source, k).toBe('manual')
        expect(row.stale, k).toBe(false)
        expect(row.last_seen_at, k).toBeNull()
        expect(row.enabled, k).toBe(afterMigration.get(k)!.enabled)
      }
      expect(UNLISTED_SEEDS.map(s => key(s.provider, s.model))).toContain(
        key(UNLISTED_SEED.provider, UNLISTED_SEED.model)
      )

      // T-H9 · the existing row gets no price from the sync: the deleted
      // placeholder stays unpriced until an admin prices it.
      const priced = new Set((await listLlmPrices(pool)).map(p => key(p.provider, p.model)))
      const deletedOnExistingRows = LEGACY_SEEDED_MODEL_PRICES.map(p =>
        key(p.provider, p.model)
      ).filter(
        k =>
          afterMigration.has(k) && !pricesAfterMigration.some(p => key(p.provider, p.model) === k)
      )
      expect(deletedOnExistingRows.length).toBeGreaterThan(0)
      for (const k of deletedOnExistingRows) expect(priced.has(k), k).toBe(false)
    })

    it('T-C11 · a listed seed absent from a later live catalog is marked stale and stays enabled', async () => {
      const k = key(VANISHING_SEED.provider, VANISHING_SEED.model)
      expect(afterMigration.get(k)!.enabled).toBe(true)
      await sync(pool, withoutModel(CATALOG, 'anthropic', VANISHING_SEED.model))
      const rows = await allowed(pool)
      expect(rows.get(k)!.stale).toBe(true)
      expect(rows.get(k)!.enabled).toBe(true)
      for (const s of UNLISTED_SEEDS) expect(rows.get(key(s.provider, s.model))!.stale).toBe(false)
    })
  })

  describe('placeholder prices: only the ones nobody touched are deleted', () => {
    const pk = (p: { provider: string; model: string }) => key(p.provider, p.model)
    const seedPrice = (provider: string, model: string) => {
      const seed = LEGACY_SEEDED_MODEL_PRICES.find(
        p => p.provider === provider && p.model === model
      )
      expect(seed, `${provider}/${model} is a 0044 placeholder`).toBeDefined()
      return seed!
    }
    // An edit made outside the API (psql) changes the value without bumping
    // `updated_at`; only the value comparison can keep these.
    const SQL_EDITS = [
      { provider: 'openai', model: 'gpt-4o-mini', column: 'input_token_price', value: '0.2' },
      { provider: 'claude', model: 'claude-sonnet-4-6', column: 'output_token_price', value: '16' },
      {
        provider: 'claude',
        model: 'claude-3-5-sonnet',
        column: 'cache_read_token_price',
        value: '0.31',
      },
      {
        provider: 'claude',
        model: 'claude-3-5-haiku',
        column: 'cache_write_token_price',
        value: '1.5',
      },
      { provider: 'openai', model: 'gpt-4o', column: 'currency', value: 'EUR' },
    ] as const
    // Re-saved through the admin service with the same values: only
    // `updated_at` tells it apart from the seed.
    const RESAVED = { provider: 'zai', model: 'glm-5.1' } as const
    // Disabled outside the API, so `updated_at` does not move: only `enabled`
    // tells it apart. A disable through the API also bumps `updated_at`.
    const DISABLED = { provider: 'bailian', model: 'qwen3-coder-plus' } as const
    const UNTOUCHED = { provider: 'openai', model: 'gpt-5.4-mini' } as const

    let pool: Pool
    let after: Map<string, Awaited<ReturnType<typeof listLlmPrices>>[number]>

    beforeAll(async () => {
      pool = await freshDatabase('control_api_retire_seed_prices')
      await pool.query('DELETE FROM schema_migrations WHERE version = $1', [MIGRATION])
      await applyLegacyCatalogSeeds(pool)
      for (const e of SQL_EDITS) {
        seedPrice(e.provider, e.model)
        await pool.query(
          `UPDATE llm_model_prices SET ${e.column} = $3 WHERE provider = $1 AND model = $2`,
          [e.provider, e.model, e.value]
        )
      }
      const prices = await listLlmPrices(pool)
      const idOf = (p: { provider: string; model: string }) =>
        prices.find(r => r.provider === p.provider && r.model === p.model)!.id
      const resavedSeed = seedPrice(RESAVED.provider, RESAVED.model)
      await updateLlmPrice(
        idOf(RESAVED),
        {
          input_token_price: Number(resavedSeed.input_token_price),
          output_token_price: Number(resavedSeed.output_token_price),
          cache_read_token_price: Number(resavedSeed.cache_read_token_price),
          cache_write_token_price: Number(resavedSeed.cache_write_token_price),
          currency: 'USD',
        },
        pool
      )
      seedPrice(DISABLED.provider, DISABLED.model)
      await pool.query(
        'UPDATE llm_model_prices SET enabled = false WHERE provider = $1 AND model = $2',
        [DISABLED.provider, DISABLED.model]
      )
      seedPrice(UNTOUCHED.provider, UNTOUCHED.model)

      await initDb({ connect: () => pool.connect() })
      after = new Map((await listLlmPrices(pool)).map(p => [pk(p), p]))
    })

    it.each(SQL_EDITS.map(e => [e.column, e] as const))(
      'keeps a placeholder whose %s was edited',
      (_column, e) => {
        const row = after.get(pk(e))
        expect(row, pk(e)).toBeDefined()
        expect(String(row![e.column]), pk(e)).toBe(
          e.column === 'currency' ? e.value : String(Number(e.value))
        )
      }
    )

    it('keeps a placeholder an admin re-saved with the same values', () => {
      expect(after.has(pk(RESAVED))).toBe(true)
    })

    it('keeps a placeholder an admin disabled, and a later sync does not price the pair', async () => {
      expect(after.get(pk(DISABLED))?.enabled).toBe(false)
      await syncDiscoveredModels(
        {
          materializer: new LlmAllowedModelsConfigMapWriter(
            new FakeConfigMapApi(),
            'mcp-host',
            3,
            pool
          ),
          loadCatalog: loadStub(CATALOG, 'live', CATALOG_CAPTURE_0135.capturedAt),
        },
        pool
      )
      const rows = (await listLlmPrices(pool)).filter(p => pk(p) === pk(DISABLED))
      expect(rows).toHaveLength(1)
      expect(rows[0].enabled).toBe(false)
    })

    it('deletes the placeholder nobody touched, and only that one', () => {
      expect(after.has(pk(UNTOUCHED))).toBe(false)
      const placeholderKeys = LEGACY_SEEDED_MODEL_PRICES.map(pk)
      expect(placeholderKeys.filter(k => !after.has(k))).toEqual([pk(UNTOUCHED)])
    })
  })

  it('fresh install: a live run populates the catalog and auto-enables per policy', async () => {
    const pool = await freshDatabase('control_api_retire_seed_fresh_sync')
    await sync(pool, CATALOG)
    const rows = [...(await allowed(pool)).values()]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.source === 'discovery')).toBe(true)
    const enabledProviders = new Set(rows.filter(r => r.enabled).map(r => r.provider))
    // Direct providers default ON; aggregators and clouds default OFF.
    expect(enabledProviders.has('claude')).toBe(true)
    expect(enabledProviders.has('openai')).toBe(true)
    expect(enabledProviders.has('openrouter')).toBe(false)
    expect(enabledProviders.has('bedrock')).toBe(false)
    expect((await listLlmPrices(pool)).length).toBeGreaterThan(0)
  })
})
