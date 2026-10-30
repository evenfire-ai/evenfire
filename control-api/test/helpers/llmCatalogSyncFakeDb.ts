/**
 * A faithful in-memory model of the `llm_allowed_models` table for the subset of
 * SQL that `syncDiscoveredModels` (and the ConfigMap materializer's
 * `listEnabledGroupedByProvider`) actually issue. Unlike a SQL-shape spy, it
 * APPLIES the mutations so tests can assert the OBSERVABLE ROW STATE (T4) after a
 * run — which rows ended up `stale`, which stayed `enabled` — rather than probing
 * intermediate SQL strings.
 *
 * The default `npm test` gate has no real Postgres (the *.realPostgres.* suites
 * are `describe.skip` unless CONTROL_API_REAL_PG_ADMIN_URL is set), so this
 * models the exact statement semantics the sync depends on. It intentionally
 * implements ONLY those statements; anything else returns an empty result.
 */
import { type Mock, type MockInstance, vi } from 'vitest'
import type { ImageInputCapability } from '@clerum/llm-providers'
import { listEnabledGroupedByProvider } from '../../src/services/llmAllowedModels.js'
import {
  LlmAllowedModelsConfigMapWriter,
  buildConfigMapData,
} from '../../src/services/llmAllowedModelsConfigMap.js'
import { FakeConfigMapApi, poolFromQuery } from './fakeAllowlistCluster.js'

/** The statement spy's exact signature, so `connector` satisfies SyncConnector. */
type FakeQuery = Mock<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
>

export interface FakeRow {
  id: string
  provider: string
  model: string
  enabled: boolean
  source: string
  stale: boolean
  context_window_tokens: number | null
  display_name: string | null
  vendor: string | null
  image_input: ImageInputCapability | null
  catalog_status: string | null
}

/** A `llm_model_prices` row, the columns the sync writes. */
export interface FakePriceRow {
  provider: string
  model: string
  input_token_price: number
  output_token_price: number
  cache_read_token_price: number
  cache_write_token_price: number
  enabled: boolean
}

export interface SeedRow {
  provider: string
  model: string
  enabled?: boolean
  source?: string
  stale?: boolean
  context_window_tokens?: number | null
  display_name?: string | null
  vendor?: string | null
  image_input?: ImageInputCapability | null
  catalog_status?: string | null
}

export interface FakeDbSeed {
  /** `llm_catalog_dismissed` pairs, as `provider/model`. */
  dismissed?: string[]
  prices?: FakePriceRow[]
}

export interface FakeDb {
  connector: { connect: Mock<() => Promise<{ query: FakeQuery; release: () => void }>> }
  /** Live view of the table after a run — assert against this. */
  rows: FakeRow[]
  /** `llm_catalog_dismissed`, as `provider/model`. */
  dismissed: Set<string>
  /** `llm_model_prices` after a run. */
  prices: FakePriceRow[]
  /** The `provider_counts` JSON of every recorded run, in order. */
  runs: Array<{ source: string; provider_counts: unknown }>
  /** Row lookup by (provider, model), for terse assertions. */
  get: (provider: string, model: string) => FakeRow | undefined
  /**
   * The ConfigMap materializer the sync requires: the REAL writer, reading this
   * fake table through its own pool and writing to `cluster`. Its two entry
   * points are spied so "did the run publish?" stays a one-line assertion, while
   * what was published is read from `cluster`.
   */
  materializer: LlmAllowedModelsConfigMapWriter & {
    materialize: MockInstance<LlmAllowedModelsConfigMapWriter['materialize']>
    materializeIfChanged: MockInstance<LlmAllowedModelsConfigMapWriter['materializeIfChanged']>
  }
  /** The fake apiserver the materializer publishes to. */
  cluster: FakeConfigMapApi
  /** `build(DB)`: what the CM must hold for the current table, from the real producers. */
  expectedConfigMap: () => Promise<ReturnType<typeof buildConfigMapData>>
  /**
   * Every statement the run issued, in order. The row state above is the primary
   * assertion surface; this exists so a test that asserts a row is UNCHANGED can
   * also witness that the run actually reached it.
   */
  calls: Array<{ sql: string; params: unknown[] }>
}

let idSeq = 0

export function makeFakeDb(seed: SeedRow[] = [], extra: FakeDbSeed = {}): FakeDb {
  const dismissed = new Set(extra.dismissed ?? [])
  const prices: FakePriceRow[] = (extra.prices ?? []).map(p => ({ ...p }))
  const runs: FakeDb['runs'] = []
  const rows: FakeRow[] = seed.map(s => ({
    id: `seed-${(idSeq += 1)}`,
    provider: s.provider,
    model: s.model,
    enabled: s.enabled ?? false,
    source: s.source ?? 'discovery',
    stale: s.stale ?? false,
    context_window_tokens: s.context_window_tokens ?? null,
    display_name: s.display_name ?? null,
    vendor: s.vendor ?? null,
    image_input: s.image_input ?? null,
    catalog_status: s.catalog_status ?? null,
  }))

  /** JSONB parameters arrive as canonical JSON text (the services serialize them). */
  const parseJsonb = (value: unknown): ImageInputCapability | null => {
    if (value === null || value === undefined) return null
    return JSON.parse(String(value)) as ImageInputCapability
  }

  /**
   * The `image_input` CASE, shared by the discovery and manual statements
   * because the service uses the SAME guard in both: a NULL column takes the
   * new provenance, discovery evidence not newer than this capture is
   * refreshed, and anything else (operator-`curated`, or a newer capture) is
   * preserved. Modelling it once means a test cannot pass because the two
   * branches drifted here in a way the production SQL did not.
   */
  const replaceableEvidence = (row: FakeRow, capturedAt: string): boolean => {
    if (row.image_input === null) return true
    const evidence = row.image_input.evidence
    return (
      evidence?.source === 'discovery' &&
      Date.parse(String(evidence.checkedAt)) <= Date.parse(capturedAt)
    )
  }

  const calls: Array<{ sql: string; params: unknown[] }> = []

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    const empty = { rows: [] as unknown[], rowCount: 0 as number | null }

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [], rowCount: null }
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 }

    // Per-provider existing-rows SELECT (source branch).
    if (/SELECT id, model, source FROM llm_allowed_models WHERE provider/.test(sql)) {
      const provider = String(params[0])
      const out = rows
        .filter(r => r.provider === provider)
        .map(r => ({ id: r.id, model: r.model, source: r.source }))
      return { rows: out, rowCount: out.length }
    }

    // Materializer read (enabled rows). Static stale+enabled still
    // materializes; Codex stale targets stay visible in DB but are not executable.
    if (
      /SELECT provider, model, vendor, display_name, context_window_tokens, image_input\s+FROM llm_allowed_models\s+WHERE enabled/.test(
        sql
      )
    ) {
      const out = rows
        .filter(r => r.enabled && !(r.provider === 'codex-subscription' && r.stale))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
        .map(r => ({
          provider: r.provider,
          model: r.model,
          vendor: r.vendor,
          display_name: r.display_name,
          context_window_tokens: r.context_window_tokens,
          image_input: r.image_input,
        }))
      return { rows: out, rowCount: out.length }
    }

    // NEW row insert — ON CONFLICT (provider, model) DO NOTHING. `enabled` is
    // the decision parameter AND "no tombstone", evaluated by the statement
    // itself; RETURNING yields a row only when the insert happened.
    if (/INSERT INTO llm_allowed_models/.test(sql)) {
      const [provider, model, ctx, display, imageInput, enable, status] = params as [
        string,
        string,
        number | null,
        string | null,
        unknown,
        boolean,
        string | null,
      ]
      if (rows.some(r => r.provider === provider && r.model === model)) return empty
      const isDismissed = dismissed.has(`${provider}/${model}`)
      const enabled = enable === true && !isDismissed
      rows.push({
        id: `ins-${(idSeq += 1)}`,
        provider,
        model,
        enabled,
        source: 'discovery',
        stale: false,
        context_window_tokens: ctx ?? null,
        display_name: display ?? null,
        vendor: null,
        image_input: parseJsonb(imageInput),
        catalog_status: status ?? null,
      })
      return { rows: [{ enabled, dismissed: isDismissed }], rowCount: 1 }
    }

    // Catalog price for a pair the run just inserted: only when no price row
    // exists for the pair, enabled or not.
    if (/INSERT INTO llm_model_prices/.test(sql)) {
      const [provider, model, input, output, cacheRead, cacheWrite] = params as [
        string,
        string,
        number,
        number,
        number,
        number,
      ]
      if (prices.some(p => p.provider === provider && p.model === model)) return empty
      prices.push({
        provider,
        model,
        input_token_price: input,
        output_token_price: output,
        cache_read_token_price: cacheRead,
        cache_write_token_price: cacheWrite,
        enabled: true,
      })
      return { rows: [], rowCount: 1 }
    }

    // PRESENT manual row — `image_input` ONLY, through the same guard (#654).
    // Everything an operator authored is absent from the statement, so this
    // branch deliberately writes nothing else: if the service ever widened it,
    // the suites asserting a manual row's other columns would still pass here,
    // which is why the SQL-shape test asserts the statement's text too.
    if (/UPDATE llm_allowed_models[\s\S]*t\.source = 'manual'/.test(sql)) {
      const [id, imageInput, capturedAt, provider, model] = params as [
        string,
        unknown,
        string,
        string,
        string,
      ]
      const row = rows.find(
        r => r.id === id && r.source === 'manual' && r.provider === provider && r.model === model
      )
      if (!row) return empty
      const before = JSON.stringify(row.image_input)
      if (replaceableEvidence(row, capturedAt)) row.image_input = parseJsonb(imageInput)
      return {
        rows: [
          { enabled: row.enabled, image_input_changed: before !== JSON.stringify(row.image_input) },
        ],
        rowCount: 1,
      }
    }

    // PRESENT discovery row refresh — last_seen + stale=false + NULL-fill guarded
    // to disabled rows (COALESCE), never touching `enabled`.
    if (/UPDATE llm_allowed_models[\s\S]*SET\s+last_seen_at/.test(sql)) {
      const [id, ctx, display, imageInput, capturedAt, live, status, provider, model] = params as [
        string,
        number | null,
        string | null,
        unknown,
        string,
        boolean,
        string | null,
        string,
        string,
      ]
      const row = rows.find(
        r => r.id === id && r.source === 'discovery' && r.provider === provider && r.model === model
      )
      if (!row) return empty
      row.stale = false
      if (live === true) row.catalog_status = status ?? null
      if (!row.enabled) {
        row.context_window_tokens = row.context_window_tokens ?? ctx ?? null
        row.display_name = row.display_name ?? display ?? null
      }
      // `image_input` deliberately does NOT follow the enabled-row freeze the two
      // columns above obey: it is written on enabled rows too, guarded by
      // MONOTONICITY instead. Mirrors the SQL CASE — NULL gets the provenance,
      // discovery evidence not newer than this capture is refreshed, and anything
      // else (operator-curated, or a newer capture) is preserved.
      const before = JSON.stringify(row.image_input)
      if (replaceableEvidence(row, capturedAt)) row.image_input = parseJsonb(imageInput)
      return {
        rows: [
          { enabled: row.enabled, image_input_changed: before !== JSON.stringify(row.image_input) },
        ],
        rowCount: 1,
      }
    }

    // VANISHED → stale=true (never delete, never disable).
    if (/UPDATE llm_allowed_models[\s\S]*SET\s+stale = true/.test(sql)) {
      const provider = String(params[0])
      const present = new Set((params[1] as string[]) ?? [])
      let n = 0
      for (const r of rows) {
        if (
          r.provider === provider &&
          r.source === 'discovery' &&
          r.stale === false &&
          !present.has(r.model)
        ) {
          r.stale = true
          n += 1
        }
      }
      return { rows: [], rowCount: n }
    }

    // Run summary.
    if (/INSERT INTO llm_catalog_sync_runs/.test(sql)) {
      runs.push({
        source: String(params[0]),
        provider_counts: params[4] === undefined ? null : JSON.parse(String(params[4])),
      })
      return { rows: [{ ran_at: new Date('2026-08-12T00:00:00Z') }], rowCount: 1 }
    }

    return empty
  })

  const connector = { connect: vi.fn(async () => ({ query, release: vi.fn() })) }
  const cluster = new FakeConfigMapApi()
  const writer = new LlmAllowedModelsConfigMapWriter(cluster, 'mcp-host', 3, poolFromQuery(query))
  vi.spyOn(writer, 'materialize')
  vi.spyOn(writer, 'materializeIfChanged')
  return {
    connector,
    rows,
    dismissed,
    prices,
    runs,
    get: (provider, model) => rows.find(r => r.provider === provider && r.model === model),
    materializer: writer as FakeDb['materializer'],
    cluster,
    expectedConfigMap: async () =>
      buildConfigMapData(await listEnabledGroupedByProvider({ query })),
    calls,
  }
}
