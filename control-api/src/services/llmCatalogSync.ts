/**
 * Catalog sync service (spec 09 §2.2 + §8-F2 + §11.2) — reconciles the public
 * models.dev catalog into `llm_allowed_models` as `source='discovery'` rows so
 * the operator can curate (enable) them from a fresh list.
 *
 * SOURCE-GUARDED reconciliation is the load-bearing invariant (§11.2). The
 * `idx_llm_allowed_models_pm` UNIQUE (provider, model) is NON-partial, so a
 * blind `ON CONFLICT DO UPDATE` would clobber a `source='manual'` row (an Azure
 * deployment name, a hand-added id). Instead we SELECT the provider's rows and
 * branch on `source` BEFORE writing:
 *
 *   - NEW (provider, model) not in DB → INSERT source='discovery', enabled=false,
 *     discovered_at=now, last_seen_at=now, stale=false + ctx/display from catalog.
 *     (`ON CONFLICT DO NOTHING` only guards a concurrent manual insert race — it
 *     is DO NOTHING, never DO UPDATE, so it can never overwrite a manual row.)
 *   - PRESENT with source='discovery' → UPDATE last_seen_at=now, stale=false and
 *     NULL-FILL ctx/display only (COALESCE keeps any operator-edited non-null).
 *     `enabled` is NEVER touched.
 *   - PRESENT with source='manual' → INVISIBLE: skipped entirely, never touched.
 *   - discovery rows absent from this run → UPDATE stale=true. NEVER deleted,
 *     NEVER auto-disabled (R3.7): an enabled model that vanished stays enabled +
 *     served, only flagged stale for an operator decision.
 *
 * The sync deliberately does NOT re-materialize the `clerum-llm-allowed-models`
 * ConfigMap, and never has to: the materializer only reads `enabled` rows and
 * only serializes provider/model/vendor/context_window_tokens/display_name, and
 * this sync never mutates any of those columns for an enabled row — new inserts
 * are `enabled=false`, the stale flag is not serialized, and the discovery
 * NULL-fill CASE-guards the serialized columns to disabled rows only. So an
 * enabled row's serialized projection is invariant across syncs → CM stays
 * byte-stable. A discovered model only reaches runtime once an operator enables
 * it via the normal PUT path (which re-materializes).
 *
 * Each run appends a summary row to `llm_catalog_sync_runs` (the UI's "last
 * synced"). No per-model audit rows — that would flood `llm_allowed_models_audit`
 * (which records operator actions) with 1000+ rows per run.
 */
import { type LlmProviderId, PROVIDER_IDS } from '@clerum/llm-providers'
import { pool } from '../db.js'
import { MAX_CONTEXT_WINDOW_TOKENS } from './llmAllowedModels.js'
import {
  type DiscoveredModel,
  type FetchLike,
  type ModelsDevCatalogResult,
  loadModelsDevCatalog,
  mapCatalogToProviders,
} from './modelsDevClient.js'

type SyncTxClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
  release: () => void
}

/** Minimal connector shape — pg's Pool satisfies it. */
export type SyncConnector = {
  connect: () => Promise<SyncTxClient>
}

/** Summary of one sync run (the endpoint response contract). */
export interface CatalogSyncResult {
  source: 'live' | 'vendored'
  /** When the catalog was acquired (live fetch time, or vendored-fallback time). */
  fetchedAt: string
  /** When the run committed (llm_catalog_sync_runs.ran_at) — matches the status
   *  endpoint's `ranAt`, so the UI's "last synced" label is stable across a
   *  post-sync reload. */
  ranAt: string
  added: number
  updated: number
  staled: number
}

/** The last persisted sync run, for the status endpoint. */
export interface CatalogSyncRun {
  id: string
  /** Server time the run committed (llm_catalog_sync_runs.ran_at). */
  ranAt: string
  source: 'live' | 'vendored'
  added: number
  updated: number
  staled: number
}

// Constant advisory-lock key so only one sync runs at a time (an on-demand admin
// action; concurrent runs would race on INSERT). xact-scoped: auto-released on
// COMMIT/ROLLBACK.
const SYNC_ADVISORY_LOCK_KEY = 'llm-catalog-sync-v1'

/** A row of the provider's existing catalog rows, for the source branch. */
interface ExistingRow {
  id: string
  model: string
  source: string
}

/**
 * Clamp a discovered context window to the same range the operator API enforces
 * (llmAllowedModels.MAX_CONTEXT_WINDOW_TOKENS). A catalog value outside the range
 * is dropped (left NULL) rather than poisoning the compaction denominator.
 */
function usableContext(ctx: number | undefined): number | null {
  if (typeof ctx !== 'number' || !Number.isInteger(ctx) || ctx < 1) return null
  if (ctx > MAX_CONTEXT_WINDOW_TOKENS) return null
  return ctx
}

/**
 * Reconcile one provider's discovered models against its existing rows inside an
 * open transaction. Mutates and returns running counters.
 *
 * `markStale` gates the vanished→stale inference: it is only sound from an
 * AUTHORITATIVE (live) catalog. On a vendored fallback (the live fetch failed)
 * the bundled snapshot is a static, possibly older/smaller offline copy, NOT a
 * statement about what has been deprecated — so a discovery row present in the
 * last live catalog but absent from the snapshot must NOT be flagged stale on a
 * transient network blip (it would nudge the operator to disable a live model).
 * New inserts + last_seen refresh from a vendored run are harmless and still run.
 */
async function reconcileProvider(
  client: SyncTxClient,
  provider: LlmProviderId,
  discovered: DiscoveredModel[],
  markStale: boolean,
  counters: { added: number; updated: number; staled: number }
): Promise<void> {
  const existingRes = await client.query(
    `SELECT id, model, source FROM llm_allowed_models WHERE provider = $1`,
    [provider]
  )
  const existingByModel = new Map<string, ExistingRow>()
  for (const raw of existingRes.rows as Record<string, unknown>[]) {
    existingByModel.set(String(raw.model), {
      id: String(raw.id),
      model: String(raw.model),
      source: String(raw.source),
    })
  }

  const discoveredIds: string[] = []
  for (const model of discovered) {
    discoveredIds.push(model.model_id)
    const existing = existingByModel.get(model.model_id)
    const ctx = usableContext(model.context_window_tokens)
    const display = model.display_name ?? null

    if (!existing) {
      // NEW → insert a disabled discovery row. ON CONFLICT DO NOTHING guards only
      // a concurrent manual insert (never DO UPDATE → never clobbers manual).
      const ins = await client.query(
        `INSERT INTO llm_allowed_models
           (provider, model, enabled, source, discovered_at, last_seen_at, stale,
            context_window_tokens, display_name)
         VALUES ($1, $2, false, 'discovery', NOW(), NOW(), false, $3, $4)
         ON CONFLICT (provider, model) DO NOTHING`,
        [provider, model.model_id, ctx, display]
      )
      counters.added += ins.rowCount ?? 0
      continue
    }

    if (existing.source === 'manual') {
      // INVISIBLE — never touch an operator/seed row (§2.2 / §11.2).
      continue
    }

    // PRESENT & discovery → refresh liveness (last_seen_at/stale — NOT
    // ConfigMap-serialized) for every discovery row, but NULL-FILL the
    // CM-serialized columns (context_window_tokens/display_name) ONLY while the
    // row is still disabled. Once an operator has ENABLED a discovery row it is
    // in the `clerum-llm-allowed-models` ConfigMap; freezing its serialized
    // columns here keeps the CM byte-stable so the sync never needs to
    // re-materialize (its guarantee). COALESCE keeps any operator-edited
    // non-null; `enabled` is never assigned. The freshest metadata for an
    // enabled row lands on the operator's next edit (which re-materializes).
    const upd = await client.query(
      `UPDATE llm_allowed_models
          SET last_seen_at = NOW(),
              stale = false,
              context_window_tokens = CASE
                WHEN enabled THEN context_window_tokens
                ELSE COALESCE(context_window_tokens, $2)
              END,
              display_name = CASE
                WHEN enabled THEN display_name
                ELSE COALESCE(display_name, $3)
              END
        WHERE id = $1 AND source = 'discovery'`,
      [existing.id, ctx, display]
    )
    counters.updated += upd.rowCount ?? 0
  }

  // VANISHED discovery rows → flag stale (never delete, never disable). Only
  // from an authoritative (live) catalog — see the `markStale` doc above. Newly
  // inserted rows are in `discoveredIds`, so they are excluded. `<> ALL('{}')`
  // is true for every row, so an empty (live) catalog for a mapped provider
  // stales all its discovery rows (models genuinely gone) — still never
  // deleted/disabled.
  if (!markStale) return
  const staleRes = await client.query(
    `UPDATE llm_allowed_models
        SET stale = true
      WHERE provider = $1
        AND source = 'discovery'
        AND stale = false
        AND model <> ALL($2::text[])`,
    [provider, discoveredIds]
  )
  counters.staled += staleRes.rowCount ?? 0
}

/**
 * Run one catalog sync: load the models.dev catalog (live, else vendored), map
 * it to our providers, and source-guarded-reconcile into `llm_allowed_models`
 * inside a single transaction, then persist a run summary. Never re-materializes
 * the ConfigMap — it never mutates a serialized column of an enabled row, so the
 * CM stays byte-stable (see the module header).
 */
export async function syncDiscoveredModels(
  opts: {
    loadCatalog?: (o: { fetchImpl?: FetchLike }) => Promise<ModelsDevCatalogResult>
    fetchImpl?: FetchLike
  } = {},
  connector: SyncConnector = pool
): Promise<CatalogSyncResult> {
  const load = opts.loadCatalog ?? loadModelsDevCatalog
  const { source, fetchedAt, catalog } = await load({ fetchImpl: opts.fetchImpl })
  const byProvider = mapCatalogToProviders(catalog)

  const client = await connector.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    // Serialize concurrent syncs (xact-scoped advisory lock).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SYNC_ADVISORY_LOCK_KEY])

    // Only an authoritative (live) catalog may drive the vanished→stale
    // inference; a vendored fallback must not stale live models (see
    // reconcileProvider).
    const markStale = source === 'live'
    const counters = { added: 0, updated: 0, staled: 0 }
    for (const provider of PROVIDER_IDS) {
      await reconcileProvider(client, provider, byProvider[provider] ?? [], markStale, counters)
    }

    // Persist the run summary (the UI's "last synced"). ran_at defaults to NOW();
    // read it back so the result's `ranAt` matches what the status endpoint will
    // later report for this run.
    const runRes = await client.query(
      `INSERT INTO llm_catalog_sync_runs (source, added, updated, staled)
       VALUES ($1, $2, $3, $4)
       RETURNING ran_at`,
      [source, counters.added, counters.updated, counters.staled]
    )
    await client.query('COMMIT')
    inTransaction = false

    const rawRanAt = (runRes.rows[0] as { ran_at?: unknown } | undefined)?.ran_at
    const ranAt = rawRanAt instanceof Date ? rawRanAt.toISOString() : String(rawRanAt)
    // `fetchedAt` is the catalog acquisition time (from the loader) — how fresh
    // the source data is; `ranAt` is the DB commit time of this run.
    return {
      source,
      fetchedAt,
      ranAt,
      added: counters.added,
      updated: counters.updated,
      staled: counters.staled,
    }
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // ignore rollback failure; the original error is what matters
      }
    }
    throw err
  } finally {
    client.release()
  }
}

/** Last persisted sync run (status endpoint), or null if none has run. */
export async function getLastCatalogSyncRun(
  db: { query: SyncTxClient['query'] } = pool
): Promise<CatalogSyncRun | null> {
  const res = await db.query(
    `SELECT id, ran_at, source, added, updated, staled
       FROM llm_catalog_sync_runs
      ORDER BY ran_at DESC
      LIMIT 1`
  )
  const row = res.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  const ranAt = row.ran_at
  return {
    id: String(row.id),
    ranAt: ranAt instanceof Date ? ranAt.toISOString() : String(ranAt),
    source: row.source === 'vendored' ? 'vendored' : 'live',
    added: Number(row.added ?? 0),
    updated: Number(row.updated ?? 0),
    staled: Number(row.staled ?? 0),
  }
}
