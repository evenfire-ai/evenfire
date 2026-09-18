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
import { type Mock, vi } from 'vitest'
import type { ImageInputCapability } from '@clerum/llm-providers'

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
}

export interface FakeDb {
  connector: { connect: Mock<() => Promise<{ query: FakeQuery; release: () => void }>> }
  /** Live view of the table after a run — assert against this. */
  rows: FakeRow[]
  /** Row lookup by (provider, model), for terse assertions. */
  get: (provider: string, model: string) => FakeRow | undefined
  /**
   * The ConfigMap materializer the sync now requires (#654). Every suite that
   * drives a run needs one; building it here keeps the call sites uniform and
   * makes "was the ConfigMap republished?" a one-line assertion.
   */
  materializer: { materialize: Mock<(db?: unknown) => Promise<void>> }
  /**
   * Every statement the run issued, in order. The row state above is the primary
   * assertion surface; this exists so a test that asserts a row is UNCHANGED can
   * also witness that the run actually reached it.
   */
  calls: Array<{ sql: string; params: unknown[] }>
}

let idSeq = 0

export function makeFakeDb(seed: SeedRow[] = []): FakeDb {
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
  }))

  /** JSONB parameters arrive as canonical JSON text (the services serialize them). */
  const parseJsonb = (value: unknown): ImageInputCapability | null => {
    if (value === null || value === undefined) return null
    return JSON.parse(String(value)) as ImageInputCapability
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

    // NEW row insert — ON CONFLICT (provider, model) DO NOTHING.
    if (/INSERT INTO llm_allowed_models/.test(sql)) {
      const [provider, model, ctx, display, imageInput] = params as [
        string,
        string,
        number | null,
        string | null,
        unknown,
      ]
      if (rows.some(r => r.provider === provider && r.model === model)) return empty
      rows.push({
        id: `ins-${(idSeq += 1)}`,
        provider,
        model,
        enabled: false,
        source: 'discovery',
        stale: false,
        context_window_tokens: ctx ?? null,
        display_name: display ?? null,
        vendor: null,
        image_input: parseJsonb(imageInput),
      })
      return { rows: [], rowCount: 1 }
    }

    // PRESENT discovery row refresh — last_seen + stale=false + NULL-fill guarded
    // to disabled rows (COALESCE), never touching `enabled`.
    if (/UPDATE llm_allowed_models[\s\S]*SET\s+last_seen_at/.test(sql)) {
      const [id, ctx, display, imageInput, capturedAt] = params as [
        string,
        number | null,
        string | null,
        unknown,
        string,
      ]
      const row = rows.find(r => r.id === id && r.source === 'discovery')
      if (!row) return empty
      row.stale = false
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
      const evidence = row.image_input?.evidence
      const replaceable =
        row.image_input === null ||
        (evidence?.source === 'discovery' &&
          Date.parse(String(evidence.checkedAt)) <= Date.parse(capturedAt))
      if (replaceable) row.image_input = parseJsonb(imageInput)
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
      return { rows: [{ ran_at: new Date('2026-08-12T00:00:00Z') }], rowCount: 1 }
    }

    return empty
  })

  const connector = { connect: vi.fn(async () => ({ query, release: vi.fn() })) }
  return {
    connector,
    rows,
    get: (provider, model) => rows.find(r => r.provider === provider && r.model === model),
    materializer: { materialize: vi.fn(async () => {}) },
    calls,
  }
}
