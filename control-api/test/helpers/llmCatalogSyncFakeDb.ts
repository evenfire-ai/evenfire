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
import { vi } from 'vitest'

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
}

export interface FakeDb {
  connector: { connect: () => Promise<{ query: ReturnType<typeof vi.fn>; release: () => void }> }
  /** Live view of the table after a run — assert against this. */
  rows: FakeRow[]
  /** Row lookup by (provider, model), for terse assertions. */
  get: (provider: string, model: string) => FakeRow | undefined
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
  }))

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
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

    // Materializer read (enabled rows only, stale IGNORED).
    if (
      /SELECT provider, model, vendor, display_name, context_window_tokens\s+FROM llm_allowed_models\s+WHERE enabled/.test(
        sql
      )
    ) {
      const out = rows
        .filter(r => r.enabled)
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
        .map(r => ({
          provider: r.provider,
          model: r.model,
          vendor: r.vendor,
          display_name: r.display_name,
          context_window_tokens: r.context_window_tokens,
        }))
      return { rows: out, rowCount: out.length }
    }

    // NEW row insert — ON CONFLICT (provider, model) DO NOTHING.
    if (/INSERT INTO llm_allowed_models/.test(sql)) {
      const [provider, model, ctx, display] = params as [
        string,
        string,
        number | null,
        string | null,
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
      })
      return { rows: [], rowCount: 1 }
    }

    // PRESENT discovery row refresh — last_seen + stale=false + NULL-fill guarded
    // to disabled rows (COALESCE), never touching `enabled`.
    if (/UPDATE llm_allowed_models[\s\S]*SET\s+last_seen_at/.test(sql)) {
      const [id, ctx, display] = params as [string, number | null, string | null]
      const row = rows.find(r => r.id === id && r.source === 'discovery')
      if (!row) return empty
      row.stale = false
      if (!row.enabled) {
        row.context_window_tokens = row.context_window_tokens ?? ctx ?? null
        row.display_name = row.display_name ?? display ?? null
      }
      return { rows: [], rowCount: 1 }
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
  }
}
