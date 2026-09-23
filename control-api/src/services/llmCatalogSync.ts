/**
 * Catalog sync service (spec 09 §2.2 + §8-F2 + §11.2) — reconciles the public
 * models.dev catalog into `llm_allowed_models` as `source='discovery'` rows so
 * the operator can curate (enable) them from a fresh list.
 *
 * SOURCE-GUARDED reconciliation is the load-bearing invariant (§11.2). The
 * `idx_llm_allowed_models_pm` UNIQUE (provider, model) is NON-partial, so a
 * blind `ON CONFLICT DO UPDATE` would clobber a `source='manual'` row (a seeded
 * allowlist pair, a hand-added id). Instead we SELECT the provider's rows and
 * branch on `source` BEFORE writing:
 *
 *   - NEW (provider, model) not in DB → INSERT source='discovery', enabled=false,
 *     discovered_at=now, last_seen_at=now, stale=false + ctx/display from catalog.
 *     (`ON CONFLICT DO NOTHING` only guards a concurrent manual insert race — it
 *     is DO NOTHING, never DO UPDATE, so it can never overwrite a manual row.)
 *   - PRESENT with source='discovery' → UPDATE last_seen_at=now, stale=false and
 *     NULL-FILL ctx/display only (COALESCE keeps any operator-edited non-null).
 *     `enabled` is NEVER touched.
 *   - PRESENT with source='manual' → INVISIBLE for everything an operator
 *     authored: `enabled`, `source`, `stale`, `last_seen_at`, `discovered_at`,
 *     ctx and display are never written. ONLY `image_input` is filled, under
 *     the same guard as a discovery row (NULL or not-newer discovery evidence),
 *     because the 44 seeded pairs are all `source='manual'` and are exactly the
 *     rows a fresh installation serves (#654).
 *   - discovery rows absent from this run → UPDATE stale=true. NEVER deleted,
 *     NEVER auto-disabled (R3.7): an enabled model that vanished stays enabled +
 *     served, only flagged stale for an operator decision.
 *
 * The sync re-materializes the `clerum-llm-allowed-models` ConfigMap in exactly
 * one case: it changed `image_input` on an ENABLED row (#654). That column is
 * served, so leaving the ConfigMap behind would keep mcp-host refusing images
 * for a model the catalog now says supports them. Every other serialized column
 * of an enabled row is still invariant across syncs — new inserts are
 * `enabled=false`, the stale flag is not serialized, and the NULL-fill CASE
 * guards ctx/display to disabled rows — so a run that changes no enabled row's
 * evidence writes nothing to the ConfigMap. `enabled` itself is never touched:
 * a discovered model only reaches runtime once an operator enables it via the
 * normal PUT path.
 *
 * Known race: an admin write to `image_input` that commits while the sync's
 * UPDATE runs can make that row report no change, because `prev` reads the
 * statement snapshot while the locked target row is re-checked at its newest
 * version. The ConfigMap then catches up on the next change or boot reconcile
 * (#687).
 *
 * Each run appends a summary row to `llm_catalog_sync_runs` (the UI's "last
 * synced"). No per-model audit rows — that would flood `llm_allowed_models_audit`
 * (which records operator actions) with 1000+ rows per run.
 */
import {
  type ImageInputCapability,
  type LlmProviderId,
  PROVIDER_IDS,
  parseImageInputCapability,
} from '@clerum/llm-providers'
import { config } from '../config.js'
import { pool } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { llmAllowlistConfigMapWriteFailuresTotal } from '../observability/metrics.js'
import { MAX_CONTEXT_WINDOW_TOKENS } from './llmAllowedModels.js'
import type { AllowedModelsConfigMapMaterializer } from './llmAllowedModelsConfigMap.js'
import {
  type DiscoveredModel,
  type FetchLike,
  type ImageInputState,
  type ModelsDevCatalogResult,
  loadModelsDevCatalog,
  mapCatalogToProviders,
} from './modelsDevClient.js'

/**
 * Public reference recorded on discovery provenance. FIXED — deliberately not
 * `MODELS_DEV_API_URL`, whose non-prod env override may point at a private stub
 * and must never be persisted as evidence.
 */
export const MODELS_DEV_EVIDENCE_REFERENCE = 'https://models.dev/api.json'

/**
 * Discovery evidence for one catalog entry (#654).
 *
 * `unknown` carries provenance only — this run observed the source, and the
 * entry said nothing usable about its input modalities. A KNOWN state carries
 * `validUntil`, because the shared contract refuses a discovery-sourced claim
 * without an expiry.
 *
 * `capturedAt` is the SOURCE capture time (live fetch time, or the vendored
 * snapshot's baked date) — never "now", so loading an old snapshot cannot make
 * stale data look freshly verified, and `validUntil` is derived from it for the
 * same reason: a vendored run can only claim support for as long as its
 * snapshot is fresh.
 *
 * Throws when the shared contract rejects what we built. Both inputs are ours
 * (an ISO stamp this process produced and a TTL validated at boot), so a
 * rejection is a programming error; storing NULL would hide it.
 */
export function discoveryImageInput(
  state: ImageInputState,
  capturedAt: string,
  ttlMs: number
): ImageInputCapability {
  const base = {
    source: 'discovery' as const,
    reference: MODELS_DEV_EVIDENCE_REFERENCE,
    checkedAt: capturedAt,
  }
  const evidence =
    state === 'unknown'
      ? base
      : { ...base, validUntil: new Date(Date.parse(capturedAt) + ttlMs).toISOString() }
  const parsed = parseImageInputCapability({ state, evidence })
  if (!parsed) {
    throw new Error(
      `discoveryImageInput: shared contract rejected discovery evidence (state=${state}, capturedAt=${capturedAt}, ttlMs=${ttlMs})`
    )
  }
  return parsed
}

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
  /** Enabled rows whose `image_input` this run actually changed (#654). */
  enabledImageInputChanged: number
  /** True when that count forced a ConfigMap re-materialization. */
  materialized: boolean
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

const log = rootLogger.child({ service: 'llm_catalog_sync' })

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
/**
 * Read one UPDATE's RETURNING row. An ENABLED row whose `image_input` actually
 * changed is the only thing this sync can do that makes the served ConfigMap
 * wrong — hence the exact `IS DISTINCT FROM` flag rather than `rowCount`, so an
 * idempotent re-run publishes nothing.
 */
function countEnabledEvidenceChange(
  rows: unknown[],
  counters: { enabledImageInputChanged: number }
): void {
  const row = rows[0] as { enabled?: unknown; image_input_changed?: unknown } | undefined
  if (row?.enabled === true && row.image_input_changed === true) {
    counters.enabledImageInputChanged += 1
  }
}

async function reconcileProvider(
  client: SyncTxClient,
  provider: LlmProviderId,
  discovered: DiscoveredModel[],
  markStale: boolean,
  providerMinLive: number,
  imageEvidence: { capturedAt: string; ttlMs: number },
  counters: {
    added: number
    updated: number
    staled: number
    enabledImageInputChanged: number
  }
): Promise<void> {
  const existingRes = await client.query(
    `SELECT id, model, source FROM llm_allowed_models WHERE provider = $1`,
    [provider]
  )
  const existingByModel = new Map<string, ExistingRow>()
  let existingDiscoveryCount = 0
  for (const raw of existingRes.rows as Record<string, unknown>[]) {
    const source = String(raw.source)
    if (source === 'discovery') existingDiscoveryCount += 1
    existingByModel.set(String(raw.model), {
      id: String(raw.id),
      model: String(raw.model),
      source,
    })
  }

  const discoveredIds: string[] = []
  for (const model of discovered) {
    discoveredIds.push(model.model_id)
    const existing = existingByModel.get(model.model_id)
    const ctx = usableContext(model.context_window_tokens)
    const display = model.display_name ?? null
    // Per ROW, not per run: the payload now carries this model's own state.
    const imageInputJson = JSON.stringify(
      discoveryImageInput(model.image_input_state, imageEvidence.capturedAt, imageEvidence.ttlMs)
    )

    if (!existing) {
      // NEW → insert a disabled discovery row. ON CONFLICT DO NOTHING guards only
      // a concurrent manual insert (never DO UPDATE → never clobbers manual).
      const ins = await client.query(
        `INSERT INTO llm_allowed_models
           (provider, model, enabled, source, discovered_at, last_seen_at, stale,
            context_window_tokens, display_name, image_input)
         VALUES ($1, $2, false, 'discovery', NOW(), NOW(), false, $3, $4, $5::jsonb)
         ON CONFLICT (provider, model) DO NOTHING`,
        [provider, model.model_id, ctx, display, imageInputJson]
      )
      counters.added += ins.rowCount ?? 0
      continue
    }

    if (existing.source === 'manual') {
      // A manual row stays invisible for everything an operator authored:
      // `enabled`, `source`, `stale`, `last_seen_at`, `discovered_at`,
      // `context_window_tokens`, `display_name` are all absent from the
      // statement below. The §11.2 invariant exists to protect those.
      //
      // `image_input` is not among them (#654). 44 pairs are seeded as
      // `source='manual'`, 29 of which models.dev lists; skipping them entirely
      // would leave exactly the rows a fresh installation SERVES with no
      // evidence at all, while rows an operator discovered later got some. The
      // guard is the same as the discovery branch — NULL, or discovery-sourced
      // evidence not newer than this capture — so an operator's `curated`
      // verdict is still untouchable here.
      const man = await client.query(
        `UPDATE llm_allowed_models AS t
            SET image_input = CASE
                  WHEN t.image_input IS NULL THEN $2::jsonb
                  WHEN t.image_input->'evidence'->>'source' = 'discovery'
                   AND (t.image_input->'evidence'->>'checkedAt')::timestamptz <= $3::timestamptz
                    THEN $2::jsonb
                  ELSE t.image_input
                END
           FROM llm_allowed_models AS prev
          WHERE t.id = $1 AND prev.id = t.id AND t.source = 'manual'
      RETURNING t.enabled, (t.image_input IS DISTINCT FROM prev.image_input) AS image_input_changed`,
        [existing.id, imageInputJson, imageEvidence.capturedAt]
      )
      countEnabledEvidenceChange(man.rows, counters)
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
    //
    // `image_input` deliberately does NOT follow the enabled-row freeze (#654).
    // It is not operator-authored (operator-authored evidence is `curated`, and
    // that is never overwritten here); and because the evidence now expires, a
    // frozen enabled row would be stamped once while disabled, never refreshed,
    // and would expire exactly one TTL later with no way back short of manual
    // curation — the feature would fail on its own schedule.
    //
    // Instead the write is guarded by MONOTONICITY: discovery evidence is only
    // replaced by a capture at least as recent as the one already recorded,
    // compared as `timestamptz` (the parser accepts both `…Z` and `….000Z`
    // spellings, so a lexical comparison would be wrong). A vendored run can
    // therefore never regress evidence a later live run stamped. `<=` rather
    // than `<` so a re-run against the same capture rewrites; the RETURNING
    // flag keeps the materialization count exact.
    const upd = await client.query(
      `UPDATE llm_allowed_models AS t
          SET last_seen_at = NOW(),
              stale = false,
              context_window_tokens = CASE
                WHEN t.enabled THEN t.context_window_tokens
                ELSE COALESCE(t.context_window_tokens, $2)
              END,
              display_name = CASE
                WHEN t.enabled THEN t.display_name
                ELSE COALESCE(t.display_name, $3)
              END,
              image_input = CASE
                WHEN t.image_input IS NULL THEN $4::jsonb
                WHEN t.image_input->'evidence'->>'source' = 'discovery'
                 AND (t.image_input->'evidence'->>'checkedAt')::timestamptz <= $5::timestamptz
                  THEN $4::jsonb
                ELSE t.image_input
              END
         FROM llm_allowed_models AS prev
        WHERE t.id = $1 AND prev.id = t.id AND t.source = 'discovery'
    RETURNING t.enabled, (t.image_input IS DISTINCT FROM prev.image_input) AS image_input_changed`,
      [existing.id, ctx, display, imageInputJson, imageEvidence.capturedAt]
    )
    counters.updated += upd.rowCount ?? 0
    countEnabledEvidenceChange(upd.rows, counters)
  }

  // VANISHED discovery rows → flag stale (never delete, never disable). Only
  // from an authoritative (live) catalog — see the `markStale` doc above. Newly
  // inserted rows are in `discoveredIds`, so they are excluded.
  if (!markStale) return

  // §4.5 sanity guard, LAYER 2 — per-provider zero/low-live floor. A provider
  // that comes back with FEWER than the floor of live models but still has
  // discovery rows in DB is treated as SUSPICIOUS (an external-catalog glitch,
  // not a genuine mass-deprecation), and its rows are left untouched. This
  // DELIBERATELY replaces the old catastrophic behavior where `model <> ALL('{}')`
  // stale-marked EVERY discovery row of a provider whose live list came back
  // empty. `providerMinLive` (default 0) makes the zero-live case the mandatory
  // floor; a higher value also guards implausibly-low counts. The surgical case
  // (a provider otherwise complete with one model gone) stays ABOVE the floor and
  // is still stale-marked — an accepted, recoverable gap.
  const providerFloor = Math.max(1, providerMinLive)
  if (discovered.length < providerFloor && existingDiscoveryCount > 0) {
    log.warn(
      {
        event: 'llm_catalog_sync_provider_floor_skip',
        provider,
        liveCount: discovered.length,
        providerMinLive,
        existingDiscoveryCount,
      },
      `skipping stale-marking for provider "${provider}": only ${discovered.length} live model(s) returned but ${existingDiscoveryCount} discovery row(s) exist (suspected flappy catalog)`
    )
    return
  }

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
 * inside a single transaction, then persist a run summary. Re-materializes the
 * ConfigMap after COMMIT only when it changed `image_input` on an enabled row
 * (see the module header).
 */
export async function syncDiscoveredModels(
  opts: {
    loadCatalog?: (o: { fetchImpl?: FetchLike }) => Promise<ModelsDevCatalogResult>
    fetchImpl?: FetchLike
    /** §4.5 layer-3 absolute floor (default from config). */
    minPlausibleLiveTotal?: number
    /** §4.5 layer-2 per-provider floor (default from config). */
    providerMinLive?: number
    /**
     * REQUIRED, with no no-op default: this sync can change what runtime is
     * served, and a run that changes served capability with no way to publish it
     * would be a silent failure. Every production caller has a gateway.
     */
    materializer: AllowedModelsConfigMapMaterializer
    /** Image-evidence validity window (default from config). */
    imageEvidenceTtlMs?: number
  },
  connector: SyncConnector = pool
): Promise<CatalogSyncResult> {
  const load = opts.loadCatalog ?? loadModelsDevCatalog
  const minPlausibleLiveTotal = opts.minPlausibleLiveTotal ?? config.modelsDevMinPlausibleLiveTotal
  const providerMinLive = opts.providerMinLive ?? config.llmCatalogSyncProviderMinLive
  const imageEvidenceTtlMs = opts.imageEvidenceTtlMs ?? config.llmCatalogImageEvidenceTtlMs
  const { source, fetchedAt, capturedAt, catalog } = await load({ fetchImpl: opts.fetchImpl })
  const byProvider = mapCatalogToProviders(catalog)
  // Stamped with the SOURCE capture time (see discoveryImageInput); the payload
  // itself is built per row, because each model carries its own state now.
  const imageEvidence = { capturedAt, ttlMs: imageEvidenceTtlMs }

  // §4.5 sanity guard, LAYER 3 — absolute global plausibility floor. Compared
  // BEFORE touching any row, against a config constant, with NO baseline / no
  // persisted history / no per-provider math. If a LIVE run's TOTAL mapped model
  // count is implausibly small, we suppress the vanished→stale inference for the
  // WHOLE run — a flappy/truncated external catalog must not mass-stale the
  // allowlist. "Abort" here means skip only the stale UPDATEs: the inert
  // `INSERT enabled=false` rows for genuinely-new models still proceed (they
  // never reach runtime until an operator enables them). Cold start (empty DB)
  // is unaffected: the stale UPDATE's universe (source='discovery' AND
  // stale=false) is empty, so it marks 0 rows with or without this guard.
  const totalLive = PROVIDER_IDS.reduce((n, p) => n + (byProvider[p]?.length ?? 0), 0)
  const sourceIsLive = source === 'live'
  const globallyImplausible = sourceIsLive && totalLive < minPlausibleLiveTotal
  if (globallyImplausible) {
    log.warn(
      {
        event: 'llm_catalog_sync_implausible_live_total',
        totalLive,
        minPlausibleLiveTotal,
      },
      `LIVE catalog returned only ${totalLive} total model(s) (< floor ${minPlausibleLiveTotal}); suppressing ALL stale-marking this run (inserts still proceed)`
    )
  }

  const client = await connector.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    // Serialize concurrent syncs (xact-scoped advisory lock).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SYNC_ADVISORY_LOCK_KEY])

    // Layer 1 (source==='live') AND layer 3 (global plausibility) both gate the
    // vanished→stale inference for the whole run; layer 2 (per-provider floor)
    // is applied inside reconcileProvider. A vendored fallback must not stale
    // live models (see reconcileProvider).
    const markStale = sourceIsLive && !globallyImplausible
    const counters = { added: 0, updated: 0, staled: 0, enabledImageInputChanged: 0 }
    for (const provider of PROVIDER_IDS) {
      await reconcileProvider(
        client,
        provider,
        byProvider[provider] ?? [],
        markStale,
        providerMinLive,
        imageEvidence,
        counters
      )
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

    // After COMMIT, never inside it: the rows are durable either way, and a
    // ConfigMap write held inside the transaction would keep the advisory lock
    // for the length of an API call to the cluster. On failure the run is
    // reported as failed (the caller surfaces it) and the boot reconcile
    // converges on restart — the write is never retried silently.
    let materialized = false
    if (counters.enabledImageInputChanged > 0) {
      try {
        await opts.materializer.materialize()
        materialized = true
      } catch (err) {
        llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'sync' })
        log.error(
          {
            event: 'llm_catalog_sync_configmap_write_failed',
            enabledImageInputChanged: counters.enabledImageInputChanged,
            err: err instanceof Error ? err.message : String(err),
          },
          'llm allowed-models ConfigMap write failed after catalog sync commit'
        )
        throw err
      }
    }

    // `fetchedAt` is the catalog acquisition time (from the loader) — how fresh
    // the source data is; `ranAt` is the DB commit time of this run.
    return {
      source,
      fetchedAt,
      ranAt,
      added: counters.added,
      updated: counters.updated,
      staled: counters.staled,
      enabledImageInputChanged: counters.enabledImageInputChanged,
      materialized,
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
