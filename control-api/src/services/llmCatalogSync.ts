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
 *   - NEW (provider, model) not in DB → INSERT source='discovery',
 *     discovered_at=now, last_seen_at=now, stale=false + ctx/display/status from
 *     the catalog. (`ON CONFLICT DO NOTHING` only guards a concurrent manual
 *     insert race — it is DO NOTHING, never DO UPDATE, so it can never overwrite
 *     a manual row.) See "Enabled on insert" below for the value of `enabled`.
 *   - PRESENT with source='discovery' → UPDATE last_seen_at=now, stale=false,
 *     NULL-FILL ctx/display only (COALESCE keeps any operator-edited non-null)
 *     and, on a live run, refresh `catalog_status`. `enabled` is NEVER touched.
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
 * Enabled on insert. A new row starts enabled only when ALL of these hold: the
 * run is live and plausible, the provider's policy (read once, after the sync
 * lock) is on, the model passes the eligibility rules (`autoEnableRejection`),
 * and no operator removed the pair before (a row in `llm_catalog_dismissed`).
 * The tombstone is read INSIDE the INSERT statement, never from an earlier
 * read: a DELETE that commits after this run started must still be seen. A
 * tombstoned pair is still inserted, only disabled. Rows that already exist
 * never change `enabled` — whatever an operator decided stands, and so does a
 * model inserted disabled that models.dev later fixes.
 *
 * A run that cannot decide (vendored, or a live catalog that fails the
 * plausibility floor) does NOT insert models of providers whose policy is on.
 * Inserting them disabled would be final, because the next live run sees an
 * existing row and never enables it. Providers whose policy is off insert
 * disabled rows.
 *
 * Each run enables at most a fixed number of new models per provider and in
 * total (`autoEnableMaxPerProviderPerRun` / `autoEnableMaxPerRun`): every one
 * lands in the allowlist ConfigMap, and a catalog that suddenly lists thousands
 * of eligible ids must not push it past its size limit in one run. Candidates
 * are taken newest release first; those over the cap are NOT inserted, for the
 * same reason as above, and a later run picks them up. Only rows actually
 * inserted enabled count, so a tombstoned candidate (inserted disabled) costs
 * nothing. The cap governs nothing else: stale-marking and the per-provider
 * floor still see the whole catalog.
 *
 * A row this run inserted also gets its catalog price, in the same transaction,
 * unless the pair already has ANY price row (enabled or not): an operator's
 * price, even one switched off, is never second-guessed. Existing prices are
 * never written.
 *
 * Publication is decided by STATE, not by what the run changed (see
 * `syncDiscoveredModels`): after COMMIT the writer compares the ConfigMap hash
 * with what Postgres projects and writes only on a difference.
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
import type { AllowedModelsConfigMapPublisher } from './llmAllowedModelsConfigMap.js'
import { type AllowlistPublishRetry, llmAllowlistPublishRetry } from './llmAllowlistPublishRetry.js'
import { acquireCatalogSyncLock } from './llmCatalogSyncLock.js'
import {
  type CatalogPolicyProviderId,
  readEffectiveAutoEnablePolicy,
} from './llmProviderCatalogSettings.js'
import {
  type AutoEnableRejection,
  type DiscoveredModel,
  type FetchLike,
  type ImageInputState,
  type ModelsDevCatalogResult,
  autoEnableRejection,
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
  /** True when this run wrote the ConfigMap (false: it already matched Postgres). */
  materialized: boolean
  /**
   * Per-provider breakdown of the run, keyed by provider id; only providers
   * where something was counted appear. Optional for consumers: added after the
   * fields above.
   */
  providerCounts?: CatalogSyncProviderCounts
}

/** What one run did with one provider's NEW models. */
export interface CatalogSyncProviderCount {
  /** Rows this run inserted. */
  inserted: number
  /** Of those, rows inserted enabled. */
  autoEnabled: number
  /** New models not inserted: policy on, run could not decide. */
  skippedUndecidable: number
  /**
   * New models not inserted because this run already enabled as many as the
   * per-provider or the per-run cap allows; a later run decides them.
   */
  deferredByCap: number
  /**
   * Inserted rows that failed an eligibility rule, by the first rule failed.
   * Counted only where the run could have enabled them (live and plausible,
   * policy on): elsewhere eligibility decides nothing.
   */
  ineligible: Record<AutoEnableRejection, number>
  /** Inserted rows whose pair an operator had removed before (inserted disabled). */
  dismissed: number
  /** Price rows inserted for rows this run inserted. */
  pricesLoaded: number
}

export type CatalogSyncProviderCounts = Partial<Record<LlmProviderId, CatalogSyncProviderCount>>

/** The last persisted sync run, for the status endpoint. */
export interface CatalogSyncRun {
  id: string
  /** Server time the run committed (llm_catalog_sync_runs.ran_at). */
  ranAt: string
  source: 'live' | 'vendored'
  added: number
  updated: number
  staled: number
  /** Absent for runs recorded before the breakdown existed. */
  providerCounts?: CatalogSyncProviderCounts
}

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

function emptyProviderCount(): CatalogSyncProviderCount {
  return {
    inserted: 0,
    autoEnabled: 0,
    skippedUndecidable: 0,
    deferredByCap: 0,
    ineligible: { no_text_output: 0, no_tool_call: 0, status: 0, not_runnable: 0 },
    dismissed: 0,
    pricesLoaded: 0,
  }
}

function isEmptyProviderCount(c: CatalogSyncProviderCount): boolean {
  return (
    c.inserted === 0 &&
    c.skippedUndecidable === 0 &&
    c.deferredByCap === 0 &&
    c.pricesLoaded === 0 &&
    Object.values(c.ineligible).every(n => n === 0)
  )
}

/** What the run may do with NEW models. */
interface InsertDecisionContext {
  policy: Record<CatalogPolicyProviderId, boolean>
  /** Live and plausible: the catalog is trustworthy enough to enable from. */
  canDecide: boolean
  /** Whether this run refreshes `catalog_status` on existing discovery rows. */
  live: boolean
  maxPerProvider: number
  maxPerRun: number
}

interface RunCounters {
  added: number
  updated: number
  staled: number
  enabledImageInputChanged: number
  /** Rows inserted enabled so far in this run, across providers (the per-run cap). */
  autoEnabled: number
  byProvider: CatalogSyncProviderCounts
}

/**
 * The order in which a provider's candidates take the cap: newest release
 * first, undated last, then by id. Compared by UTF-16 code units, never
 * `localeCompare`: which models a run enables must not depend on the replica's
 * locale. Release dates are bounded text, not validated dates, so `YYYY-MM`
 * sorts after the `YYYY-MM-DD` days of its month and a future or nonsense date
 * that passes the shape goes first; both are accepted.
 */
function compareCapOrder(a: DiscoveredModel, b: DiscoveredModel): number {
  const ra = a.release_date
  const rb = b.release_date
  if (ra !== rb) {
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra > rb ? -1 : 1
  }
  if (a.model_id === b.model_id) return 0
  return a.model_id < b.model_id ? -1 : 1
}

async function insertCatalogPrice(
  client: SyncTxClient,
  provider: LlmProviderId,
  model: DiscoveredModel
): Promise<boolean> {
  const cost = model.cost
  if (!cost) return false
  // The active-price index is partial (WHERE enabled), so the conflict target
  // must repeat that predicate or Postgres cannot infer it. NOT EXISTS covers
  // what the index cannot: a disabled price row the operator kept.
  const res = await client.query(
    `INSERT INTO llm_model_prices
       (provider, model, input_token_price, output_token_price,
        cache_read_token_price, cache_write_token_price)
     SELECT $1::text, $2::text, $3::numeric, $4::numeric, $5::numeric, $6::numeric
      WHERE NOT EXISTS (
        SELECT 1 FROM llm_model_prices p WHERE p.provider = $1::text AND p.model = $2::text
      )
     ON CONFLICT (provider, model) WHERE enabled DO NOTHING`,
    [provider, model.model_id, cost.input, cost.output, cost.cache_read, cost.cache_write]
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * What one INSERT of a new discovered row did, as Postgres reports it. `enable`
 * is only the run's decision: the tombstone check inside the statement can
 * still turn it off, and a concurrent insert can take the pair first.
 */
type InsertOutcome = 'not_inserted' | 'inserted_disabled' | 'inserted_enabled'

/** INSERT one new discovered row and, if it went in, its catalog price. */
async function insertDiscoveredModel(
  client: SyncTxClient,
  provider: LlmProviderId,
  model: DiscoveredModel,
  imageInputJson: string,
  enable: boolean,
  counters: RunCounters,
  providerCount: CatalogSyncProviderCount
): Promise<InsertOutcome> {
  // ON CONFLICT DO NOTHING guards only a concurrent manual insert (never DO
  // UPDATE → never clobbers manual), and then RETURNING yields no row, so
  // nothing below runs for a pair this run did not create.
  const ins = await client.query(
    `INSERT INTO llm_allowed_models
       (provider, model, enabled, source, discovered_at, last_seen_at, stale,
        context_window_tokens, display_name, image_input, catalog_status)
     VALUES ($1, $2,
             $6::boolean AND NOT EXISTS (
               SELECT 1 FROM llm_catalog_dismissed d
                WHERE d.provider = $1 AND d.model = $2
             ),
             'discovery', NOW(), NOW(), false, $3, $4, $5::jsonb, $7)
     ON CONFLICT (provider, model) DO NOTHING
     RETURNING enabled,
               EXISTS (
                 SELECT 1 FROM llm_catalog_dismissed d
                  WHERE d.provider = $1 AND d.model = $2
               ) AS dismissed`,
    [
      provider,
      model.model_id,
      usableContext(model.context_window_tokens),
      model.display_name ?? null,
      imageInputJson,
      enable,
      model.catalog_status,
    ]
  )
  counters.added += ins.rowCount ?? 0
  const inserted = ins.rows[0] as { enabled?: unknown; dismissed?: unknown } | undefined
  if (!inserted) return 'not_inserted'
  providerCount.inserted += 1
  const enabled = inserted.enabled === true
  if (enabled) providerCount.autoEnabled += 1
  if (inserted.dismissed === true) providerCount.dismissed += 1
  if (await insertCatalogPrice(client, provider, model)) providerCount.pricesLoaded += 1
  return enabled ? 'inserted_enabled' : 'inserted_disabled'
}

async function reconcileProvider(
  client: SyncTxClient,
  provider: LlmProviderId,
  discovered: DiscoveredModel[],
  markStale: boolean,
  providerMinLive: number,
  imageEvidence: { capturedAt: string; ttlMs: number },
  decision: InsertDecisionContext,
  counters: RunCounters
): Promise<void> {
  const providerCount = emptyProviderCount()
  await reconcileProviderRows(
    client,
    provider,
    discovered,
    markStale,
    providerMinLive,
    imageEvidence,
    decision,
    counters,
    providerCount
  )
  if (!isEmptyProviderCount(providerCount)) counters.byProvider[provider] = providerCount
}

async function reconcileProviderRows(
  client: SyncTxClient,
  provider: LlmProviderId,
  discovered: DiscoveredModel[],
  markStale: boolean,
  providerMinLive: number,
  imageEvidence: { capturedAt: string; ttlMs: number },
  decision: InsertDecisionContext,
  counters: RunCounters,
  providerCount: CatalogSyncProviderCount
): Promise<void> {
  const policyOn = decision.policy[provider as CatalogPolicyProviderId] === true

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
  // Models this run would insert enabled. They go through the cap after the
  // loop, in cap order; everything else keeps the catalog order.
  const candidates: Array<{ model: DiscoveredModel; imageInputJson: string }> = []
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
      if (policyOn && !decision.canDecide) {
        providerCount.skippedUndecidable += 1
        continue
      }
      const rejection = autoEnableRejection(model)
      if (policyOn && decision.canDecide && rejection === null) {
        candidates.push({ model, imageInputJson })
        continue
      }
      const outcome = await insertDiscoveredModel(
        client,
        provider,
        model,
        imageInputJson,
        false,
        counters,
        providerCount
      )
      if (outcome !== 'not_inserted' && policyOn && decision.canDecide && rejection !== null) {
        providerCount.ineligible[rejection] += 1
      }
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
            AND t.provider = $4 AND t.model = $5
      RETURNING t.enabled, (t.image_input IS DISTINCT FROM prev.image_input) AS image_input_changed`,
        [existing.id, imageInputJson, imageEvidence.capturedAt, provider, model.model_id]
      )
      countEnabledEvidenceChange(man.rows, counters)
      continue
    }

    // PRESENT & discovery → refresh liveness (last_seen_at/stale — NOT
    // ConfigMap-serialized) for every discovery row, but NULL-FILL the
    // CM-serialized columns (context_window_tokens/display_name) ONLY while the
    // row is still disabled. Once a discovery row is enabled (by an operator, or
    // by this sync on insert) it is in the `clerum-llm-allowed-models`
    // ConfigMap; freezing its serialized columns here keeps what is served
    // stable across runs. COALESCE keeps any operator-edited non-null;
    // `enabled` is never assigned. The freshest metadata for an enabled row
    // lands on the operator's next edit (which re-materializes).
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
    //
    // `catalog_status` is refreshed only from a live catalog: the vendored
    // snapshot carries no status, and reading its absence as "no longer
    // deprecated" would silence the attention item.
    //
    // Both UPDATEs here match the id AND the pair read by the SELECT above: an
    // operator rename committed in between leaves the id pointing at another
    // model, which must not inherit this entry's evidence or status.
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
              END,
              catalog_status = CASE WHEN $6::boolean THEN $7::text ELSE t.catalog_status END
         FROM llm_allowed_models AS prev
        WHERE t.id = $1 AND prev.id = t.id AND t.source = 'discovery'
          AND t.provider = $8 AND t.model = $9
    RETURNING t.enabled, (t.image_input IS DISTINCT FROM prev.image_input) AS image_input_changed`,
      [
        existing.id,
        ctx,
        display,
        imageInputJson,
        imageEvidence.capturedAt,
        decision.live,
        model.catalog_status,
        provider,
        model.model_id,
      ]
    )
    counters.updated += upd.rowCount ?? 0
    countEnabledEvidenceChange(upd.rows, counters)
  }

  candidates.sort((a, b) => compareCapOrder(a.model, b.model))
  for (const { model, imageInputJson } of candidates) {
    if (
      providerCount.autoEnabled >= decision.maxPerProvider ||
      counters.autoEnabled >= decision.maxPerRun
    ) {
      providerCount.deferredByCap += 1
      continue
    }
    // Only a row Postgres reports enabled takes the cap: a tombstoned pair is
    // inserted disabled and never reaches the ConfigMap.
    const outcome = await insertDiscoveredModel(
      client,
      provider,
      model,
      imageInputJson,
      true,
      counters,
      providerCount
    )
    if (outcome === 'inserted_enabled') counters.autoEnabled += 1
  }
  if (providerCount.deferredByCap > 0) {
    log.warn(
      {
        event: 'llm_catalog_sync_auto_enable_deferred',
        provider,
        deferredByCap: providerCount.deferredByCap,
        autoEnabled: providerCount.autoEnabled,
        maxPerProvider: decision.maxPerProvider,
        maxPerRun: decision.maxPerRun,
      },
      'auto-enable cap reached: the remaining new models of this provider are not inserted and will be enabled by the next runs; switching the provider to OFF now would insert them disabled for good'
    )
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
 * inside a single transaction, then persist a run summary. After COMMIT the
 * ConfigMap is published only if its content differs from what Postgres now
 * projects (see the module header).
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
    materializer: AllowedModelsConfigMapPublisher
    /** Where a failed post-commit publish is retried (default: the process-wide one). */
    publishRetry?: AllowlistPublishRetry
    /** Image-evidence validity window (default from config). */
    imageEvidenceTtlMs?: number
    /** Most models one run may insert enabled for one provider (default from config). */
    autoEnableMaxPerProviderPerRun?: number
    /** Most models one run may insert enabled across providers (default from config). */
    autoEnableMaxPerRun?: number
  },
  connector: SyncConnector = pool
): Promise<CatalogSyncResult> {
  const load = opts.loadCatalog ?? loadModelsDevCatalog
  const minPlausibleLiveTotal = opts.minPlausibleLiveTotal ?? config.modelsDevMinPlausibleLiveTotal
  const providerMinLive = opts.providerMinLive ?? config.llmCatalogSyncProviderMinLive
  const imageEvidenceTtlMs = opts.imageEvidenceTtlMs ?? config.llmCatalogImageEvidenceTtlMs
  const maxPerProvider =
    opts.autoEnableMaxPerProviderPerRun ?? config.llmCatalogAutoEnableMaxPerProviderPerRun
  const maxPerRun = opts.autoEnableMaxPerRun ?? config.llmCatalogAutoEnableMaxPerRun
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
  // allowlist. "Abort" here means skip the stale UPDATEs, and also mark the run
  // unable to decide auto-enable: new models of providers whose policy is on are
  // not inserted at all; every other new model is inserted disabled (see the
  // module header). The stale part does not affect a cold start (empty DB): the
  // stale UPDATE's universe (source='discovery' AND stale=false) is empty, so it
  // marks 0 rows with or without this guard.
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
      `LIVE catalog returned only ${totalLive} total model(s) (< floor ${minPlausibleLiveTotal}); suppressing ALL stale-marking this run (inserts of providers without auto-enable still proceed)`
    )
  }

  const committed = await reconcileCatalogInTransaction(connector, {
    byProvider,
    markStale: sourceIsLive && !globallyImplausible,
    providerMinLive,
    imageEvidence,
    source,
    canDecide: sourceIsLive && !globallyImplausible,
    maxPerProvider,
    maxPerRun,
  })
  const { counters } = committed

  log.info(
    {
      event: 'llm_catalog_sync_run',
      source,
      globallyImplausible,
      added: counters.added,
      updated: counters.updated,
      staled: counters.staled,
      providerCounts: counters.byProvider,
    },
    'llm catalog sync committed'
  )

  // Published after COMMIT and after the run's client went back to the pool:
  // the publish waits on its own lock and holds its own connection, and holding
  // the sync's idle client meanwhile would only shrink the pool.
  //
  // Published by STATE, unconditionally: the writer compares the CM's content
  // hash with what Postgres projects now and writes only on a difference. A
  // decision based on what this run changed would leave the CM wrong forever
  // after a failed publish or a publish from another writer that read before
  // this commit, because the next run changes nothing and would never publish.
  // `enabledImageInputChanged` stays as an observability counter only.
  const publishRetry = opts.publishRetry ?? llmAllowlistPublishRetry
  const ticket = publishRetry.begin()
  let materialized: boolean
  try {
    materialized = (await opts.materializer.materializeIfChanged()) === 'written'
    publishRetry.succeeded(ticket)
  } catch (err) {
    llmAllowlistConfigMapWriteFailuresTotal.inc({ phase: 'sync' })
    log.error(
      {
        event: 'llm_catalog_sync_configmap_write_failed',
        enabledImageInputChanged: counters.enabledImageInputChanged,
        err: err instanceof Error ? err.message : String(err),
      },
      'llm allowed-models ConfigMap write failed after catalog sync commit; publish retry scheduled'
    )
    publishRetry.failed(ticket, opts.materializer)
    // The rows are committed either way; the caller still sees the run as
    // failed (the on-demand route answers 500) while the retry converges.
    throw err
  }

  // `fetchedAt` is the catalog acquisition time (from the loader) — how fresh
  // the source data is; `ranAt` is the DB commit time of this run.
  return {
    source,
    fetchedAt,
    ranAt: committed.ranAt,
    added: counters.added,
    updated: counters.updated,
    staled: counters.staled,
    enabledImageInputChanged: counters.enabledImageInputChanged,
    materialized,
    providerCounts: counters.byProvider,
  }
}

async function reconcileCatalogInTransaction(
  connector: SyncConnector,
  run: {
    byProvider: ReturnType<typeof mapCatalogToProviders>
    markStale: boolean
    providerMinLive: number
    imageEvidence: { capturedAt: string; ttlMs: number }
    source: 'live' | 'vendored'
    canDecide: boolean
    maxPerProvider: number
    maxPerRun: number
  }
): Promise<{ ranAt: string; counters: RunCounters }> {
  const client = await connector.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    // Serialize concurrent syncs and policy toggles (xact-scoped advisory lock).
    await acquireCatalogSyncLock(client)

    // Layer 1 (source==='live') AND layer 3 (global plausibility) both gate the
    // vanished→stale inference for the whole run (`markStale`); layer 2
    // (per-provider floor) is applied inside reconcileProvider. A vendored
    // fallback must not stale live models (see reconcileProvider).
    // Read under the lock: the policy toggle takes the same lock, so this run
    // sees a toggle entirely or not at all.
    const decision: InsertDecisionContext = {
      policy: await readEffectiveAutoEnablePolicy(client),
      canDecide: run.canDecide,
      live: run.source === 'live',
      maxPerProvider: run.maxPerProvider,
      maxPerRun: run.maxPerRun,
    }
    const counters: RunCounters = {
      added: 0,
      updated: 0,
      staled: 0,
      enabledImageInputChanged: 0,
      autoEnabled: 0,
      byProvider: {},
    }
    for (const provider of PROVIDER_IDS) {
      await reconcileProvider(
        client,
        provider,
        run.byProvider[provider] ?? [],
        run.markStale,
        run.providerMinLive,
        run.imageEvidence,
        decision,
        counters
      )
    }

    // Persist the run summary (the UI's "last synced"). ran_at defaults to NOW();
    // read it back so the result's `ranAt` matches what the status endpoint will
    // later report for this run.
    const runRes = await client.query(
      `INSERT INTO llm_catalog_sync_runs (source, added, updated, staled, provider_counts)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING ran_at`,
      [
        run.source,
        counters.added,
        counters.updated,
        counters.staled,
        JSON.stringify(counters.byProvider),
      ]
    )
    await client.query('COMMIT')
    inTransaction = false

    const rawRanAt = (runRes.rows[0] as { ran_at?: unknown } | undefined)?.ran_at
    const ranAt = rawRanAt instanceof Date ? rawRanAt.toISOString() : String(rawRanAt)
    return { ranAt, counters }
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
    `SELECT id, ran_at, source, added, updated, staled, provider_counts
       FROM llm_catalog_sync_runs
      ORDER BY ran_at DESC
      LIMIT 1`
  )
  const row = res.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  const ranAt = row.ran_at
  const run: CatalogSyncRun = {
    id: String(row.id),
    ranAt: ranAt instanceof Date ? ranAt.toISOString() : String(ranAt),
    source: row.source === 'vendored' ? 'vendored' : 'live',
    added: Number(row.added ?? 0),
    updated: Number(row.updated ?? 0),
    staled: Number(row.staled ?? 0),
  }
  const providerCounts = row.provider_counts
  if (providerCounts && typeof providerCounts === 'object' && !Array.isArray(providerCounts)) {
    run.providerCounts = withDeferredByCap(providerCounts as StoredProviderCounts)
  }
  return run
}

/** A stored breakdown: runs recorded before the per-run cap carry no `deferredByCap`. */
type StoredProviderCounts = Partial<
  Record<
    LlmProviderId,
    Omit<CatalogSyncProviderCount, 'deferredByCap'> & { deferredByCap?: number }
  >
>

function withDeferredByCap(stored: StoredProviderCounts): CatalogSyncProviderCounts {
  const out: CatalogSyncProviderCounts = {}
  for (const [provider, count] of Object.entries(stored)) {
    if (!count || typeof count !== 'object') continue
    out[provider as LlmProviderId] = { ...count, deferredByCap: count.deferredByCap ?? 0 }
  }
  return out
}
