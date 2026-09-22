/**
 * Subscription catalog reconciliation cron.
 *
 * A subscription grant's catalog (`codex_catalog_models`, `grok_catalog_models`)
 * is written during the OAuth handshake and never again on its own. A model the
 * vendor publishes afterwards therefore stays invisible to that connection —
 * while the API-key provider of the SAME vendor picks it up from the discovery
 * sync — until an operator asks for it. This cron closes that gap by re-running
 * the very same `runCodexCatalogSync` / `runGrokCatalogSync` the connect flow
 * and the manual `POST .../catalog/sync` endpoint drive. No HTTP hop, no new
 * auth, no second write path.
 *
 * Hazard handling follows `llmCatalogSyncCron.ts`, which is the reference
 * implementation for every one of them:
 *
 * - Cross-replica dedup through a SESSION-scoped
 *   `pg_try_advisory_lock(hashtext('subscription-catalog-sync-cron-v1'))` on a
 *   dedicated client. A session lock is NOT released by COMMIT nor by returning
 *   the connection to the pool, so the `finally` unlocks explicitly and, when
 *   the unlock itself fails, DESTROYS the connection (`release(err)`) — the only
 *   remaining way to end the session and free the lock. A leaked lock would
 *   wedge every future tick.
 * - First tick after random jitter, then `setInterval`; both handles `unref()`'d,
 *   start is not awaited by boot, and errors are logged but never thrown.
 * - The reconciliation closure is injected by `main.ts`, because publishing the
 *   allowlist ConfigMap needs the K8s gateway and this module owns none.
 *
 * Cost discipline: every tick issues one upstream catalog call PER CONNECTION,
 * and a Grok refresh inside the 5-minute skew ROTATES the refresh token. A short
 * interval is an abuse risk, not a freshness win — hence the conservative
 * default and the floor enforced in `config.ts`.
 */
import { config } from '../config.js'
import { pool } from '../db.js'
import { deriveOAuthEncryptionKey } from '../oauth/encryption.js'
import { rootLogger } from '../observability/logger.js'
import { createCodexCatalogTransportFromEnv } from './codexSubscriptionCatalog.js'
import { listLiveCodexSubscriptionConnections } from './codexSubscriptionConnection.js'
import { runCodexCatalogSync } from './codexSubscriptionOAuth.js'
import {
  buildCodexBrowserRedirectUri,
  resolveCodexControlUiBaseUrl,
} from './codexSubscriptionRedirectUri.js'
import { createGrokCatalogTransportFromEnv } from './grokSubscriptionCatalog.js'
import {
  assertGrokConnectionKey,
  listLiveGrokSubscriptionConnections,
} from './grokSubscriptionConnection.js'
import { runGrokCatalogSync } from './grokSubscriptionOAuth.js'
import type { AllowedModelsConfigMapMaterializer } from './llmAllowedModelsConfigMap.js'
import {
  publishAllowedModelsConfigMapAfterGrantChange,
  syncOutcomeChangedTheRow,
} from './llmAllowedModelsConfigMap.js'

const log = rootLogger.child({ service: 'subscription_catalog_sync_cron' })

// Session-scoped advisory lock key, distinct from every other cron's. The `-v1`
// suffix leaves room to re-key if the tick's semantics ever change.
const CRON_LOCK_KEY_SQL = "hashtext('subscription-catalog-sync-cron-v1')"

export type SubscriptionBroker = 'codex-subscription' | 'grok-subscription'

/**
 * What `runCodexCatalogSync` / `runGrokCatalogSync` return, reduced to the
 * fields this module decides on.
 *
 * `catalogStatus` describes the CATALOG, so it cannot answer "did the connection
 * row change?" on its own: a rejected Grok refresh token writes
 * `status = 'reauth_required'` and only then throws, leaving the catalog at
 * `never_synced` on a row that did change. `persisted` is the services' explicit
 * answer for that case, and `syncOutcomeChangedTheRow` is the single place that
 * reads both.
 */
export type SubscriptionCatalogSyncOutcome =
  | { ok: true; catalogStatus: 'ready' }
  | { ok: false; catalogStatus: string; reason?: string; persisted?: boolean }

export type SubscriptionConnectionRow = { connectionKey: string; status: string }

/** One broker's side of a tick. Production builds it from config + db + transport. */
export interface SubscriptionBrokerPort {
  broker: SubscriptionBroker
  /** The deployment gate (`config.*SubscriptionEnabled`). Off = the broker is dark. */
  enabled: boolean
  listConnections(): Promise<SubscriptionConnectionRow[]>
  syncCatalog(connectionKey: string): Promise<SubscriptionCatalogSyncOutcome>
}

export interface SubscriptionCatalogReconcileDeps {
  brokers: SubscriptionBrokerPort[]
  /** Undefined = no ConfigMap writer, so the publish is a local no-op (unit tests). */
  materializer: AllowedModelsConfigMapMaterializer | undefined
}

export interface SubscriptionCatalogReconcileResult {
  /** Connections whose catalog is now `ready`. */
  synced: number
  /** Connections that RECORDED a non-ready outcome (`auth-rejected`, `unavailable`). */
  degraded: number
  /** Raced or lock-held; nothing recorded, resolves on the next tick. */
  raced: number
  failed: number
  /** Gate off, not addressable, or `status !== 'connected'`. */
  skipped: number
  published: 'published' | 'skipped'
}

/**
 * Transient, not failures. `stale_revision` means a concurrent manual sync won
 * the `credential_revision AND catalog_revision` fence — its write landed, ours
 * did not, and the catalog is fresh either way. `refresh_in_flight` means the
 * per-connection 30s refresh lock was held. Both clear by themselves.
 */
const RACED_REASONS = new Set(['stale_revision', 'refresh_in_flight'])

/**
 * Migration 0113_grok_subscription_terminal_connection_key archives superseded
 * tombstones as `<key>~revoked~<id>`, outside the key grammar. `listLive*`
 * filters `revoked_at IS NULL`, but an archived row can still surface here; a
 * sync call on it would only raise `invalid_connection_key`. The admin router
 * applies the same filter for the same reason.
 */
export function filterAddressableGrokConnections<T extends SubscriptionConnectionRow>(
  rows: T[]
): T[] {
  return rows.filter(row => {
    try {
      assertGrokConnectionKey(row.connectionKey)
      return true
    } catch {
      return false
    }
  })
}

/**
 * Reconcile every live, connected grant of every enabled broker, then publish
 * the runtime allowlist ONCE.
 *
 * A per-connection failure is isolated: one rejected grant must not cost the
 * others their sync. The publish, in contrast, is not isolated — a catalog that
 * changed in Postgres but not in the ConfigMap is a divergence the runtime hosts
 * would serve until the next mutation, so the rejection propagates and the tick
 * reports `errored`. It runs on every tick regardless of what the loop recorded,
 * which is what makes the next tick repair a publish that threw; see the comment
 * at the publish itself.
 */
export async function reconcileSubscriptionCatalogs(
  deps: SubscriptionCatalogReconcileDeps
): Promise<SubscriptionCatalogReconcileResult> {
  let synced = 0
  let degraded = 0
  let raced = 0
  let failed = 0
  let skipped = 0

  for (const port of deps.brokers) {
    if (!port.enabled) {
      log.debug(
        { event: 'subscription_catalog_sync_broker_disabled', broker: port.broker },
        `${port.broker} is disabled for this deployment; skipping`
      )
      continue
    }
    // Outside the per-connection `try` below, so without this guard a single
    // broker's listing failure would abandon the OTHER broker's connections
    // too — the tick would throw out of the loop entirely. One failed listing
    // is one failure, not a lost tick.
    let rows: SubscriptionConnectionRow[]
    try {
      rows = await port.listConnections()
    } catch (err) {
      failed += 1
      log.warn(
        {
          event: 'subscription_catalog_sync_listing_failed',
          broker: port.broker,
          err: err instanceof Error ? err.message : String(err),
        },
        `${port.broker} connection listing failed; continuing with the remaining brokers`
      )
      continue
    }
    for (const row of rows) {
      // Every narrower rule is wrong: `disconnected` makes the catalog sync
      // throw `not_connected`, `connecting` throws `no_grant` inside the
      // ensure-fresh path, and `reauth_required` needs a human this cron
      // cannot summon.
      if (row.status !== 'connected') {
        skipped += 1
        continue
      }
      try {
        const outcome = await port.syncCatalog(row.connectionKey)
        if (outcome.ok) {
          synced += 1
        } else if (syncOutcomeChangedTheRow(outcome)) {
          degraded += 1
          log.info(
            {
              event: 'subscription_catalog_sync_degraded',
              broker: port.broker,
              connectionKey: row.connectionKey,
              catalogStatus: outcome.catalogStatus,
              // Present when the catalog stayed at `never_synced` and the
              // CONNECTION row is what changed — the reason is then the only
              // field that says what the row now carries.
              reason: outcome.reason,
            },
            `${port.broker} catalog recorded a non-ready outcome`
          )
        } else if (outcome.reason && RACED_REASONS.has(outcome.reason)) {
          raced += 1
        } else {
          failed += 1
          log.warn(
            {
              event: 'subscription_catalog_sync_failed',
              broker: port.broker,
              connectionKey: row.connectionKey,
              reason: outcome.reason,
            },
            `${port.broker} catalog sync recorded nothing`
          )
        }
      } catch (err) {
        failed += 1
        log.warn(
          {
            event: 'subscription_catalog_sync_threw',
            broker: port.broker,
            connectionKey: row.connectionKey,
            err: err instanceof Error ? err.message : String(err),
          },
          `${port.broker} catalog sync threw; continuing with the remaining connections`
        )
      }
    }
  }

  // Publish on EVERY tick that ran, not only on one that wrote a row.
  //
  // `materialize()` rebuilds the ConfigMap from Postgres — the allowlist plus
  // both brokers' live connections and their readiness — so the write is
  // idempotent and publishing unconditionally costs one API call per interval.
  // That is what lets a publish that threw converge on the next tick with no
  // state carried across ticks or replicas: the advisory lock is taken per
  // tick, so a flag set by the replica that failed would be invisible to
  // whichever replica wins the next one.
  //
  // A "publish only when something was recorded" gate cannot do that job. The
  // rows a failed tick changed are `reauth_required` by the next tick, the
  // loop above skips them by status, nothing is recorded, and the stale
  // ConfigMap — where mcp-host and HCC still see a usable grant — survives
  // until an unrelated mutation or a control-api restart happens to republish.
  //
  // `llmAllowedModelsBootReconcile.ts` already writes unconditionally at boot
  // for the same anti-drift reason; this makes the cron agree with it.
  const published = await publishAllowedModelsConfigMapAfterGrantChange(deps.materializer)

  return { synced, degraded, raced, failed, skipped, published }
}

function cronDbClient() {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) }
}

/**
 * Production wiring for both brokers, built at TICK time rather than at module
 * load or boot.
 *
 * The laziness is load-bearing for Codex: `normalizeControlUiOrigin` throws on a
 * malformed, non-http or path-bearing `CONTROL_API_CONTROL_UI_BASE_URL`, and a
 * throw at boot would take control-api down instead of failing one tick.
 *
 * The redirect URI is built inside `syncCatalog`, not here. Building it while
 * WIRING the ports would throw before the Grok port exists, so a Codex-only
 * misconfiguration would cost Grok its entire reconciliation — the failure this
 * function is meant to contain. Inside `syncCatalog` the throw is caught by the
 * per-connection `try` in `reconcileSubscriptionCatalogs` and counted as one
 * failed Codex connection, which is what it is.
 *
 * `runCodexCatalogSync` reaches the refresh path only — `exchangeRefreshToken`
 * sends no `redirect_uri` — but a real value is built anyway rather than a
 * placeholder that would be wrong the day the path changes.
 */
export function createSubscriptionBrokerPorts(): SubscriptionBrokerPort[] {
  const db = cronDbClient()
  const encryptionKey = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

  const codexTransport = createCodexCatalogTransportFromEnv()
  const codex: SubscriptionBrokerPort = {
    broker: 'codex-subscription',
    enabled: config.codexSubscriptionEnabled,
    listConnections: () => listLiveCodexSubscriptionConnections(db),
    syncCatalog: connectionKey =>
      runCodexCatalogSync(
        {
          db,
          encryptionKey,
          fetchFn: fetch,
          clientId: config.codexOAuthClientId,
          redirectUri: buildCodexBrowserRedirectUri(
            resolveCodexControlUiBaseUrl(config.controlUiBaseUrl, undefined)
          ),
          enabled: config.codexSubscriptionEnabled,
          connectionKey,
        },
        connectionKey,
        codexTransport
      ),
  }

  const grokTransport = createGrokCatalogTransportFromEnv()
  const grok: SubscriptionBrokerPort = {
    broker: 'grok-subscription',
    enabled: config.grokSubscriptionEnabled,
    listConnections: async () =>
      filterAddressableGrokConnections(await listLiveGrokSubscriptionConnections(db)),
    syncCatalog: connectionKey =>
      runGrokCatalogSync(
        {
          db,
          encryptionKey,
          fetchFn: fetch,
          clientId: config.grokOAuthClientId,
          enabled: config.grokSubscriptionEnabled,
          connectionKey,
        },
        connectionKey,
        grokTransport
      ),
  }

  return [codex, grok]
}

/**
 * The closure `main.ts` hands to the cron. It owns no gateway, so the caller
 * passes the materializer the admin routes already use.
 */
export function reconcileSubscriptionCatalogsFromEnv(
  materializer: AllowedModelsConfigMapMaterializer | undefined
): Promise<SubscriptionCatalogReconcileResult> {
  return reconcileSubscriptionCatalogs({ brokers: createSubscriptionBrokerPorts(), materializer })
}

/**
 * Minimal client shape for the advisory-lock session. pg's PoolClient satisfies
 * it. `release` takes pg's optional destroy argument: a truthy value (an Error)
 * DESTROYS the connection instead of returning it to the pool.
 */
type LockClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
  release: (destroy?: Error | boolean) => void
}

export interface SubscriptionCatalogSyncCronDeps {
  connector?: { connect: () => Promise<LockClient> }
  /** Injected by `main.ts` so the reconciliation can reach the gateway's materializer. */
  sync: () => Promise<SubscriptionCatalogReconcileResult>
}

export interface SubscriptionCatalogSyncTickResult {
  skippedLock: boolean
  ran: boolean
  errored: boolean
}

/**
 * One tick: acquire the session advisory lock, reconcile, release. Never throws
 * — a failure is logged and reported in the result. The lock is released in
 * `finally` whether the tick ran, skipped, or failed.
 */
export async function runSubscriptionCatalogSyncTick(
  deps: SubscriptionCatalogSyncCronDeps
): Promise<SubscriptionCatalogSyncTickResult> {
  const connector = deps.connector ?? pool
  let lockClient: LockClient | undefined
  let locked = false
  try {
    lockClient = await connector.connect()
    const lockRes = await lockClient.query(
      `SELECT pg_try_advisory_lock(${CRON_LOCK_KEY_SQL}) AS acquired`
    )
    locked = (lockRes.rows[0] as { acquired?: boolean } | undefined)?.acquired === true
    if (!locked) {
      log.debug(
        { event: 'subscription_catalog_sync_cron_skipped_lock' },
        'subscription catalog sync tick skipped: advisory lock held by another replica'
      )
      return { skippedLock: true, ran: false, errored: false }
    }

    const result = await deps.sync()
    log.info(
      {
        event: 'subscription_catalog_sync_cron_tick',
        synced: result.synced,
        degraded: result.degraded,
        raced: result.raced,
        failed: result.failed,
        skipped: result.skipped,
        published: result.published,
      },
      `subscription catalog sync tick complete (synced=${result.synced}, degraded=${result.degraded}, raced=${result.raced}, failed=${result.failed}, skipped=${result.skipped}, ${result.published})`
    )
    return { skippedLock: false, ran: true, errored: false }
  } catch (err) {
    log.error(
      {
        event: 'subscription_catalog_sync_cron_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'subscription catalog sync tick failed'
    )
    return { skippedLock: false, ran: false, errored: true }
  } finally {
    if (lockClient) {
      let destroyed = false
      if (locked) {
        try {
          await lockClient.query(`SELECT pg_advisory_unlock(${CRON_LOCK_KEY_SQL})`)
        } catch (unlockErr) {
          // The session lock is freed only by an explicit unlock or by CLOSING
          // the session. The unlock failed, so destroy the connection: a plain
          // release() would hand a live session still holding the lock back to
          // the pool and wedge every future tick.
          const asError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr))
          log.warn(
            { event: 'subscription_catalog_sync_cron_unlock_failed', err: asError.message },
            'pg_advisory_unlock failed; destroying the connection to release the session lock'
          )
          lockClient.release(asError)
          destroyed = true
        }
      }
      if (!destroyed) lockClient.release()
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null
let firstRunHandle: ReturnType<typeof setTimeout> | null = null

/**
 * Upper bound of the random delay before the first tick. Keeps the replicas of
 * one rollout from contending for the advisory lock at the same instant; the
 * lock already makes a collision a harmless no-op.
 */
export const SUBSCRIPTION_CATALOG_SYNC_FIRST_RUN_JITTER_MS = 5_000

export function startSubscriptionCatalogSyncCron(
  deps: SubscriptionCatalogSyncCronDeps,
  intervalMs: number
): void {
  if (intervalHandle || firstRunHandle) return

  const run = (): void => {
    // runSubscriptionCatalogSyncTick never rejects; the catch is defensive so an
    // unexpected throw can never kill the timer.
    void runSubscriptionCatalogSyncTick(deps).catch(err => {
      log.error(
        {
          event: 'subscription_catalog_sync_cron_unhandled',
          err: err instanceof Error ? err.message : String(err),
        },
        'unhandled error in subscription catalog sync cron'
      )
    })
  }

  const firstDelay = Math.floor(Math.random() * SUBSCRIPTION_CATALOG_SYNC_FIRST_RUN_JITTER_MS)
  firstRunHandle = setTimeout(() => {
    firstRunHandle = null
    run()
    intervalHandle = setInterval(run, intervalMs)
    intervalHandle.unref()
  }, firstDelay)
  firstRunHandle.unref()
  log.info(
    { event: 'subscription_catalog_sync_cron_started', intervalMs, firstRunInMs: firstDelay },
    'subscription catalog sync cron started'
  )
}

export function stopSubscriptionCatalogSyncCron(): void {
  if (firstRunHandle) {
    clearTimeout(firstRunHandle)
    firstRunHandle = null
  }
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
