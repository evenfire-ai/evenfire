import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import type { ImageInputCapability } from '@clerum/llm-providers'
import { initDb } from '../src/db.js'
import { type CatalogSyncResult, syncDiscoveredModels } from '../src/services/llmCatalogSync.js'
import { loadStub, trimSnapshot, withModalities } from './helpers/modelsDevFixtures.js'
import './realPostgres.requirement.ts'

// R1-M2: run `syncDiscoveredModels` against a REAL PostgreSQL. The in-memory
// fake used by services.llmCatalogSync.invariants.test.ts models the statement
// semantics; it cannot prove the parts only Postgres decides:
//   - the `UPDATE ... FROM llm_allowed_models AS prev ... RETURNING
//     (t.image_input IS DISTINCT FROM prev.image_input)` self-join, which must
//     compare the NEW target row with the PRE-UPDATE row, so the returned
//     enabledImageInputChanged count (and the ConfigMap republish) is exact;
//   - the `(checkedAt)::timestamptz <= $capturedAt::timestamptz` monotonic
//     guard, which must compare instants, not strings.
// Skipped without CONTROL_API_REAL_PG_ADMIN_URL, like every sibling suite.

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

const CAPTURED_AT = '2026-08-19T16:16:10.000Z'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOW_FLOOR = { minPlausibleLiveTotal: 1 }

const curated: ImageInputCapability = {
  state: 'supported',
  evidence: {
    source: 'curated',
    reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
    checkedAt: '2026-09-16T00:00:00.000Z',
  },
}
const oldDiscovery: ImageInputCapability = {
  state: 'unknown',
  evidence: {
    source: 'discovery',
    reference: 'https://models.dev/api.json',
    checkedAt: '2026-07-01T00:00:00.000Z',
  },
}
// Captured AFTER this run's catalog. Spelled without milliseconds (CAPTURED_AT
// carries `.000Z`) so the real `::timestamptz` cast parses both spellings.
const newerDiscovery: ImageInputCapability = {
  state: 'supported',
  evidence: {
    source: 'discovery',
    reference: 'https://models.dev/api.json',
    checkedAt: '2026-09-01T00:00:00Z',
    validUntil: '2026-10-01T00:00:00Z',
  },
}

function discovered(state: 'supported' | 'unsupported') {
  return {
    state,
    evidence: {
      source: 'discovery',
      reference: 'https://models.dev/api.json',
      checkedAt: CAPTURED_AT,
      validUntil: new Date(Date.parse(CAPTURED_AT) + TTL_MS).toISOString(),
    },
  }
}

interface SeedRow {
  model: string
  source: 'discovery' | 'manual'
  enabled: boolean
  stale?: boolean
  display_name?: string | null
  context_window_tokens?: number | null
  image_input: ImageInputCapability | null
}

// Same seed as the #654 invariant in services.llmCatalogSync.invariants.test.ts.
const SEED: SeedRow[] = [
  // Enabled + curated: published, must stay byte-identical.
  { model: 'claude-opus-4-5', source: 'discovery', enabled: true, image_input: curated },
  // Disabled + curated: an operator decision discovery must not undo.
  { model: 'claude-sonnet-5', source: 'discovery', enabled: false, image_input: curated },
  // Disabled + older discovery provenance: refreshed.
  {
    model: 'claude-haiku-4-5-20251001',
    source: 'discovery',
    enabled: false,
    image_input: oldDiscovery,
  },
  // ENABLED + older discovery provenance: refreshed → counts as a change.
  { model: 'claude-opus-4-6', source: 'discovery', enabled: true, image_input: oldDiscovery },
  // ENABLED + NEWER discovery provenance: untouched (monotonic guard).
  { model: 'claude-sonnet-4-5', source: 'discovery', enabled: true, image_input: newerDiscovery },
  // MANUAL, enabled, no evidence: gets image_input and NOTHING else → counts
  // as a change. Seeded stale with null metadata so any leak of the discovery
  // branch's other writes is observable.
  {
    model: 'claude-fable-5-1',
    source: 'manual',
    enabled: true,
    stale: true,
    display_name: null,
    context_window_tokens: null,
    image_input: null,
  },
]

const CATALOG = withModalities(
  trimSnapshot({
    anthropic: [
      'claude-opus-4-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'claude-sonnet-4-5',
      'claude-fable-5-1',
      // Absent from the DB → the first run INSERTs it as a disabled row.
      'claude-opus-4-7',
    ],
  }),
  {
    'claude-haiku-4-5-20251001': ['text', 'image'],
    'claude-opus-4-6': ['text'],
    'claude-sonnet-4-5': ['text', 'image'],
    'claude-fable-5-1': ['text', 'image'],
    'claude-opus-4-7': ['text', 'image'],
  }
)

type DbRow = Record<string, unknown> & {
  model: string
  enabled: boolean
  source: string
  image_input: ImageInputCapability | null
}

describeRealPostgres('syncDiscoveredModels on real PostgreSQL (#654 image_input)', () => {
  const database = `control_api_catalog_sync_${randomBytes(6).toString('hex')}`
  let adminPool: Pool
  let dbPool: Pool
  const materializer = { materialize: vi.fn(async () => {}) }
  let manualBefore: DbRow
  let firstRun: CatalogSyncResult

  async function readRows(): Promise<Map<string, DbRow>> {
    const { rows } = await dbPool.query<DbRow>(
      `SELECT * FROM llm_allowed_models WHERE provider = 'claude' ORDER BY model`
    )
    return new Map(rows.map(row => [row.model, row]))
  }

  async function countRuns(): Promise<number> {
    const { rows } = await dbPool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM llm_catalog_sync_runs'
    )
    return Number(rows[0].n)
  }

  function runSync(capturedAt: string, source: 'live' | 'vendored' = 'live') {
    return syncDiscoveredModels(
      {
        materializer,
        loadCatalog: loadStub(CATALOG, source, capturedAt),
        imageEvidenceTtlMs: TTL_MS,
        ...LOW_FLOOR,
      },
      dbPool
    )
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`CREATE DATABASE ${quoteIdent(database)}`)
    dbPool = new Pool({ connectionString: databaseUrl(adminUrl!, database) })
    await initDb({ connect: () => dbPool.connect() })

    // initDb seeds the static allowlist as `source='manual'` rows. Start from
    // an empty table so the seed below is the whole universe the sync sees.
    await dbPool.query('DELETE FROM llm_allowed_models')
    for (const row of SEED) {
      await dbPool.query(
        `INSERT INTO llm_allowed_models
           (provider, model, enabled, source, stale, display_name,
            context_window_tokens, image_input)
         VALUES ('claude', $1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          row.model,
          row.enabled,
          row.source,
          row.stale ?? false,
          row.display_name ?? null,
          row.context_window_tokens ?? null,
          row.image_input === null ? null : JSON.stringify(row.image_input),
        ]
      )
    }
    const seeded = await readRows()
    expect(seeded.size).toBe(SEED.length)
    manualBefore = seeded.get('claude-fable-5-1')!
  })

  afterAll(async () => {
    await dbPool?.end()
    if (!adminPool) return
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [database]
    )
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`)
    await adminPool.end()
  })

  it('counts exactly the enabled rows whose image_input changed and republishes once', async () => {
    firstRun = await runSync(CAPTURED_AT)

    // claude-opus-4-6 (discovery) and claude-fable-5-1 (manual). The other
    // enabled rows are curated or newer, so the self-join must see them as
    // unchanged; the disabled rows that did change must not be counted.
    expect(firstRun.enabledImageInputChanged).toBe(2)
    expect(firstRun.materialized).toBe(true)
    expect(firstRun.added).toBe(1)
    expect(materializer.materialize).toHaveBeenCalledTimes(1)

    const rows = await readRows()
    expect(rows.get('claude-opus-4-6')!.image_input).toEqual(discovered('unsupported'))
    expect(rows.get('claude-haiku-4-5-20251001')!.image_input).toEqual(discovered('supported'))
    const inserted = rows.get('claude-opus-4-7')!
    expect(inserted.enabled).toBe(false)
    expect(inserted.source).toBe('discovery')
    expect(inserted.image_input).toEqual(discovered('supported'))
  })

  it('an immediate re-run reports no change and does not republish', async () => {
    const runsBefore = await countRuns()
    const rerun = await runSync(CAPTURED_AT)

    // Liveness witness: this run really happened and really visited the rows.
    // It persisted its own summary row, and refreshed the discovery rows
    // (`<=` rewrites evidence stamped with the same capture).
    expect(await countRuns()).toBe(runsBefore + 1)
    expect(rerun.ranAt).not.toBe(firstRun.ranAt)
    expect(rerun.updated).toBe(SEED.filter(r => r.source === 'discovery').length + 1)

    expect(rerun.enabledImageInputChanged).toBe(0)
    expect(rerun.materialized).toBe(false)
    expect(materializer.materialize).toHaveBeenCalledTimes(1)
    const rows = await readRows()
    expect(rows.get('claude-opus-4-6')!.image_input).toEqual(discovered('unsupported'))
    expect(rows.get('claude-fable-5-1')!.image_input).toEqual(discovered('supported'))
  })

  it('never regresses stored discovery evidence with a newer checkedAt', async () => {
    const rows = await readRows()
    expect(rows.get('claude-sonnet-4-5')!.image_input).toEqual(newerDiscovery)

    // An OLDER capture (a vendored fallback after the live run) must not
    // overwrite anything this live run stamped either.
    const olderRun = await runSync('2026-08-01T00:00:00Z', 'vendored')
    expect(olderRun.updated).toBeGreaterThan(0)
    expect(olderRun.enabledImageInputChanged).toBe(0)
    expect(materializer.materialize).toHaveBeenCalledTimes(1)
    const after = await readRows()
    expect(after.get('claude-sonnet-4-5')!.image_input).toEqual(newerDiscovery)
    expect(after.get('claude-opus-4-6')!.image_input).toEqual(discovered('unsupported'))
    expect(after.get('claude-fable-5-1')!.image_input).toEqual(discovered('supported'))
  })

  it('writes only image_input on a manual row', async () => {
    const manual = (await readRows()).get('claude-fable-5-1')!
    expect(manual.image_input).toEqual(discovered('supported'))
    expect(manualBefore.image_input).toBeNull()

    // Every other column — including stale, last_seen_at, discovered_at,
    // display_name and context_window_tokens, which the discovery branch
    // would write — is exactly what the seed stored.
    const { image_input: _afterImage, ...afterRest } = manual
    const { image_input: _beforeImage, ...beforeRest } = manualBefore
    expect(afterRest).toEqual(beforeRest)
    expect(afterRest.source).toBe('manual')
    expect(afterRest.stale).toBe(true)
    expect(afterRest.last_seen_at).toBeNull()
  })

  it('leaves curated evidence untouched, enabled or not', async () => {
    const rows = await readRows()
    expect(rows.get('claude-opus-4-5')!.image_input).toEqual(curated)
    expect(rows.get('claude-sonnet-5')!.image_input).toEqual(curated)
    // Witness: the sync did visit both rows (last_seen_at is only set by it).
    expect(rows.get('claude-opus-4-5')!.last_seen_at).toBeInstanceOf(Date)
    expect(rows.get('claude-sonnet-5')!.last_seen_at).toBeInstanceOf(Date)
  })
})
