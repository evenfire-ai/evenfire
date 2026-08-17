/**
 * issue #299 Phase 2 — provider-netblocks fetch pipeline (the shared tick).
 *
 * HARD CONSTRAINTS (plan §control-api safety) enforced here, all injectable for
 * tests:
 *   §1 off the hot path      — runs only from the background cron, never a handler.
 *   §2 single writer         — Postgres advisory lock; skip-with-log when held.
 *   §3 bounded               — the injected `http` enforces the timeout + size cap.
 *   §4 failure-isolated      — every fetch/parse/write error is caught; the tick
 *                              RESOLVES (never throws) so it can never crash
 *                              control-api or fail a request.
 *   §5 startup-independent    — the seed CM covers cold start; this is best-effort.
 *   §6 no ConfigMap churn     — content-hash short-circuit: unchanged ⇒ zero writes.
 *   §7 rate-limit safe        — conditional GETs via the plugin's ETag/If-None-Match.
 *   §8 kill switch            — the cron is gated by config; this tick is inert then.
 *
 * Provider names never appear here — the concrete fetchers carry them.
 */
import type { Pool, PoolClient } from 'pg'
import {
  parseProviderNetblocks,
  partitionCidrsByFamily,
  validateProviderRanges,
} from '@clerum/network-policy-core'
import { providerBounds } from '@clerum/network-policy-core/providerRegistry'
import type { FetchHttp, ProviderFetcher } from './fetcherTypes.js'
import {
  CONTENT_HASH_ANNOTATION,
  type ProviderNetblocksCmStore,
  contentHashOf,
} from './providerNetblocksConfigMap.js'

const LOCK_KEY_SQL = `hashtext('provider-netblocks-fetcher-v1')`
/** etcd is 1MB; keep headroom independent of the HTTP response cap (G5). */
const MAX_CM_BYTES = 900_000

export type TickResult =
  | 'skipped_lock'
  | 'written'
  | 'unchanged'
  | 'nothing_staged'
  | 'cm-size-budget'
  | 'error'

export interface TickMetrics {
  tick(result: 'ok' | 'skipped_lock' | 'error' | 'all_failed'): void
  fetchOutcome(source: string, result: 'not_modified'): void
  fetchFailure(source: string, reason: string): void
  lastSuccess(source: string, epochMs: number): void
  cidrs(source: string, category: string, count: number): void
}

export interface TickDeps {
  fetchers: ProviderFetcher[]
  cmStore: ProviderNetblocksCmStore
  pool: Pool
  http: FetchHttp
  now: number
  metrics: TickMetrics
  // R1-M2: injectable log seams so this background service routes through the
  // pino rootLogger (level control + structured output) instead of raw console.
  // Both default to console for standalone/test callers.
  log?: (msg: string) => void
  logError?: (msg: string) => void
}

interface SourceMeta {
  fetchedAt: string
  etag: string | null
  syncToken: string | null
  sourceUrl: string
  contentHash?: string
  categories: Record<string, { ipv4: number; ipv6: number }>
}

function countsForSource(
  categories: Record<string, string[]>,
  source: string
): Record<string, number> {
  // Object.create(null): a catalog category literally named "__proto__" (the CM
  // key regex permits it) must not become a silent no-op setter on a plain {} and
  // disarm the downstream shrink guard (NaN compare). Consistent with the null-proto
  // defenses in parseProviderNetblocks and lookupFqdnProvider (issue #299 review).
  const out: Record<string, number> = Object.create(null)
  for (const [key, list] of Object.entries(categories)) {
    // key is `<source>.<category>` (provider-blind: parseProviderNetblocks strips family)
    if (key.startsWith(`${source}.`)) out[key.slice(source.length + 1)] = list.length
  }
  return out
}

/**
 * One fetch cycle. Resolves with a TickResult and NEVER throws (§4). Callers wire
 * this behind the jittered cron; nothing here runs inside a request handler (§1).
 */
export async function runProviderNetblocksTick(deps: TickDeps): Promise<TickResult> {
  const { fetchers, cmStore, pool, http, now, metrics } = deps
  const log = deps.log ?? console.log
  const logError = deps.logError ?? console.error

  let lockClient: PoolClient | undefined
  let acquired = false
  try {
    // Inside the try so a DB-down `connect()` rejection is contained (§4) — the
    // tick returns 'error' with the metric, never throwing into the caller.
    lockClient = await pool.connect()
    const res = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS acquired`
    )
    acquired = res.rows[0]?.acquired === true
    if (!acquired) {
      log('[provider-netblocks] tick skipped — advisory lock held by another instance')
      metrics.tick('skipped_lock')
      return 'skipped_lock'
    }

    const current = await cmStore.read() // null on 404 (fresh cluster before the seed)
    const currentData = current?.data ?? {}
    const parsed = parseProviderNetblocks(currentData)
    const prevMeta = (parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}) as {
      sources?: Record<string, { etag?: string; syncToken?: string }>
    }

    const staged: Record<string, string> = {}
    const stagedSources: string[] = []
    const newSourcesMeta: Record<string, SourceMeta> = {}
    // M1 (freshness gauge): sources whose fetch outcome THIS tick was healthy —
    // `ok`-and-accepted or a 304 not-modified. Per-source `last_success` bumps
    // come from exactly this set on every healthy exit ('written', 'unchanged',
    // 'nothing_staged'), so a steady-state pipeline never looks stale. Failed
    // and rejected sources never enter it — their gauge stays put and the
    // staleness alert remains truthful.
    const healthySources = new Set<string>()

    for (const fetcher of fetchers) {
      const lkgMeta = prevMeta.sources?.[fetcher.source]
      const lkg = {
        etag: lkgMeta?.etag,
        syncToken: lkgMeta?.syncToken,
        categoryCounts: countsForSource(parsed.categories, fetcher.source),
      }

      let result
      try {
        result = await fetcher.fetch({ http, log }, lkg)
      } catch (err) {
        result = {
          kind: 'error' as const,
          reason: err instanceof Error ? err.message : String(err),
        }
      }

      if (result.kind === 'unchanged') {
        metrics.fetchOutcome(fetcher.source, 'not_modified')
        healthySources.add(fetcher.source) // M1: a 304 is a per-source success
        continue // §6: zero CM writes
      }
      if (result.kind === 'error') {
        metrics.fetchFailure(fetcher.source, 'fetch')
        logError(`[provider-netblocks] ${fetcher.source} fetch failed: ${result.reason}`)
        continue // fail-static: keep LKG (§4)
      }

      // result.kind === 'ok' — validate + bound + guard, all in the shared pipeline.
      const sourceStaged: Record<string, string> = {}
      const catMeta: Record<string, { ipv4: number; ipv6: number }> = {}
      let rejectReason: string | null = null

      for (const [category, list] of Object.entries(result.categories)) {
        const { ipv4, ipv6, invalid } = partitionCidrsByFamily(list)
        if (invalid.length > 0) {
          rejectReason = 'invalid-cidr-shape'
          break
        }
        // A category that resolved to zero IPv4 (empty, or all-IPv6) is a distinct
        // failure mode from a validation error — surface it as such (fail-static).
        if (ipv4.length === 0) {
          rejectReason = 'empty-category'
          break
        }
        const validation = validateProviderRanges(ipv4, providerBounds(fetcher.source))
        if (validation.kind === 'invalid') {
          logError(
            `[provider-netblocks] ${fetcher.source}.${category} invalid: ${validation.reasons.join('; ')}`
          )
          rejectReason = 'validation'
          break
        }
        const prevCount = lkg.categoryCounts[category]
        if (prevCount !== undefined && validation.ranges.length < 0.5 * prevCount) {
          // Operator override: setting the `clerum.io/netblocks-accept-shrink`
          // annotation to the CURRENT content-hash acknowledges a large shrink
          // relative to the known-good state (readable by the operator). Consumed
          // on the next write (the hash then changes, re-arming the guard).
          const ack = current?.annotations?.['clerum.io/netblocks-accept-shrink']
          const currentHash = current?.annotations?.[CONTENT_HASH_ANNOTATION]
          if (!ack || ack !== currentHash) {
            rejectReason = 'shrink-exceeds-50pct'
            break
          }
        }
        sourceStaged[`${fetcher.source}.${category}.ipv4`] = validation.ranges.join('\n')
        if (ipv6.length > 0)
          sourceStaged[`${fetcher.source}.${category}.ipv6`] = [...ipv6].sort().join('\n')
        catMeta[category] = { ipv4: validation.ranges.length, ipv6: ipv6.length }
      }

      // syncToken monotonicity guard (inert when a source omits syncToken, as the
      // M1 provider does; it activates only for a source that returns a syncToken).
      if (
        !rejectReason &&
        result.meta.syncToken &&
        lkg.syncToken &&
        result.meta.syncToken < lkg.syncToken
      ) {
        rejectReason = 'sync-token-regression'
      }

      if (rejectReason) {
        metrics.fetchFailure(fetcher.source, rejectReason)
        logError(`[provider-netblocks] ${fetcher.source} rejected: ${rejectReason} (LKG retained)`)
        continue // fail-static
      }

      Object.assign(staged, sourceStaged)
      stagedSources.push(fetcher.source)
      healthySources.add(fetcher.source)
      newSourcesMeta[fetcher.source] = {
        fetchedAt: new Date(now).toISOString(),
        etag: result.meta.etag ?? null,
        syncToken: result.meta.syncToken ?? null,
        sourceUrl: result.meta.sourceUrl,
        categories: catMeta,
      }
      for (const [cat, counts] of Object.entries(catMeta))
        metrics.cidrs(fetcher.source, cat, counts.ipv4)
    }

    if (stagedSources.length === 0) {
      // M1: nothing_staged is a MIXED bucket — an all-304 tick (healthy steady
      // state) and an all-failed tick both land here. Bump exactly the 304
      // sources; failed/rejected ones stay un-bumped.
      for (const src of healthySources) metrics.lastSuccess(src, now)
      // R1-L1: a 100%-failed tick (no source succeeded) must NOT report result=ok
      // — that misleads any dashboard keying on ticks_total{result=ok}. Distinguish
      // it with an `all_failed` label. Only genuine no-op ticks (>=1 healthy source,
      // all 304) stay `ok`. The `fetchers.length > 0` guard keeps a zero-fetcher
      // config from reporting all_failed.
      const allFailed = fetchers.length > 0 && healthySources.size === 0
      metrics.tick(allFailed ? 'all_failed' : 'ok')
      return 'nothing_staged'
    }

    // Merge: keep other sources' data keys, replace this run's staged sources.
    // Object.create(null): a CM data key literally named "__proto__" (the CM key
    // regex permits it) must not be silently dropped by a plain-{} setter — mirror
    // the null-proto defense in countsForSource (adversarial-audit hardening).
    const newData: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(currentData)) {
      if (key === '_meta') continue
      const src = key.split('.')[0]
      if (!stagedSources.includes(src)) newData[key] = value
    }
    Object.assign(newData, staged)

    const contentHash = contentHashOf(newData)

    // §6 no-op-on-unchanged: identical ranges ⇒ zero CM writes (not even a
    // `_meta.fetchedAt` touch), so unchanged pools cause no downstream reconciles.
    if (current?.annotations?.[CONTENT_HASH_ANNOTATION] === contentHash) {
      // M1: identical content is a per-source SUCCESS — the fetch worked and
      // validated; only the write is skipped. Bump the freshness gauge or the
      // staleness alert fires on a perfectly healthy pipeline.
      for (const src of healthySources) metrics.lastSuccess(src, now)
      metrics.tick('ok')
      return 'unchanged'
    }

    // Rebuild _meta preserving untouched sources' meta, updating staged ones.
    const mergedSourcesMeta: Record<string, unknown> = { ...(prevMeta.sources ?? {}) }
    for (const [src, m] of Object.entries(newSourcesMeta))
      mergedSourcesMeta[src] = { ...m, contentHash }
    newData['_meta'] = JSON.stringify({ sources: mergedSourcesMeta, contentHash })

    // §G5 size budget, independent of the HTTP response cap.
    if (Buffer.byteLength(JSON.stringify(newData), 'utf8') > MAX_CM_BYTES) {
      metrics.fetchFailure('*', 'cm-size-budget')
      // Record the tick like every other exit — a chronically-oversized catalog
      // must not flatline clerum_provider_netblocks_ticks_total (indistinguishable
      // from a dead cron); this is a failed write, so it counts as an error tick.
      metrics.tick('error')
      logError(
        '[provider-netblocks] rejected write: ConfigMap exceeds the size budget (LKG retained)'
      )
      return 'cm-size-budget'
    }

    await cmStore.write(newData, contentHash)
    // M1: healthySources ⊇ stagedSources — a 304 source on a mixed tick is
    // equally fresh and gets bumped alongside the written ones.
    for (const src of healthySources) metrics.lastSuccess(src, now)
    metrics.tick('ok')
    log(`[provider-netblocks] wrote catalog (sources: ${stagedSources.join(', ')})`)
    return 'written'
  } catch (err) {
    // §4: an unexpected throw is contained here — the tick never propagates.
    metrics.fetchFailure('*', 'unexpected')
    metrics.tick('error')
    logError(
      `[provider-netblocks] tick failed (contained): ${err instanceof Error ? err.message : String(err)}`
    )
    return 'error'
  } finally {
    if (lockClient) {
      let unlockError: Error | undefined
      if (acquired) {
        try {
          await lockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`)
        } catch (err) {
          unlockError = err instanceof Error ? err : new Error(String(err))
          logError(
            `[provider-netblocks] advisory unlock failed — destroying the pooled session so the session-scoped lock cannot wedge future ticks: ${unlockError.message}`
          )
        }
      }
      // pg-pool only destroys a connection on release(err) with a truthy arg. A
      // live session whose unlock failed still HOLDS the session-scoped advisory
      // lock; returning it to the pool healthy would make every subsequent tick
      // in all replicas report 'skipped_lock'. Destroy it instead (§2).
      if (unlockError) lockClient.release(unlockError)
      else lockClient.release()
    }
  }
}
