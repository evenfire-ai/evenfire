/**
 * PROACTIVE remote-OAuth token refresh + DCR client-secret lifecycle sweep
 * (mini-spec L). Renews the access token of eligible remote grants BEFORE they
 * expire — its real value is exercising a rotating refresh token that an
 * unattended (background / context-shared) grant would otherwise let lapse in
 * silence — and observes DCR confidential clients whose `client_secret` is at or
 * near expiry.
 *
 * The refresh machinery is NOT reimplemented: each candidate is fed to the
 * existing reactive `getAccessToken` with `refreshBufferMs = Bp` and
 * `requireBackground` set per grantKind (`true` for `user` grants — SEC-5;
 * `false` for `shared` context identity, which is unattended by design), and the
 * returned access token is DISCARDED — only the side effect (persisted renewed
 * token) and the outcome label matter (mini-spec §6.2). The decision layer is
 * the pure `proactiveRefreshPolicy`
 * module; this file is the thin orchestrator: enumerate → claim → refresh →
 * classify, plus the time-based DCR sweep.
 *
 * Best-effort, never worsens a grant: any per-row failure is logged + counted and
 * the sweep continues; a transient refresh failure leaves the row untouched and
 * degrades to the reactive path (mini-spec §4). The cron is gated OFF by default
 * (`OAUTH_PROACTIVE_REFRESH_CRON_ENABLED`).
 */
import { config } from '../config.js'
import type { DbClient } from '../db.js'
import { pool, withTransaction } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import {
  RecipeNotFoundError,
  type RecipeWithOAuthClients,
  SecretNotFoundError,
  type SecretReader,
} from '../oauth/callback.js'
import {
  type ExpiringDynamicClient,
  listExpiringDynamicClients,
} from '../oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../oauth/encryption.js'
import { isSecretNotFound } from '../oauth/integrationNotConfigured.js'
import {
  type ProactiveRefreshOutcome,
  classifyDcrSecretDecision,
  resultToOutcome,
} from '../oauth/proactiveRefreshPolicy.js'
import {
  type OAuthGrantKey,
  claimRemoteGrantForRefresh,
  listRemoteGrantsInProactiveWindow,
} from '../oauth/store.js'
import { REACTIVE_REFRESH_BUFFER_MS, getAccessToken } from '../oauth/tokenHelper.js'
import { rootLogger } from '../observability/logger.js'
import {
  oauthDcrSecretStatusTotal,
  oauthProactiveRefreshDurationSeconds,
  oauthProactiveRefreshGrantsTotal,
  oauthProactiveRefreshRunsTotal,
} from '../observability/metrics.js'
import { type McpServerResource, normalizeMcpServerOwnerDecl } from '../routes/mcpOauth.js'
import { K8sNotFoundError } from './resourceService.js'

const log = rootLogger.child({ service: 'oauth-proactive-refresh' })

/** Buffers + windows for one sweep (all milliseconds). */
export interface ProactiveRefreshSweepOptions {
  /** Bp — proactive buffer. */
  proactiveBufferMs: number
  /** Br — reactive buffer; the sweep never touches grants already inside it. */
  reactiveBufferMs: number
  /** Wc — DCR client-secret warn window. */
  dcrWarnMs: number
}

/**
 * Injectable IO for the sweep, so the orchestration (outcomes, per-server-CR DCR
 * dedup) is unit-testable without a real Postgres or K8s. Production wiring is
 * {@link defaultSweepDeps}.
 */
export interface ProactiveRefreshSweepDeps {
  /** Snapshot reads (candidate enumeration + DCR list) — no lock, no txn. */
  db: DbClient
  /** Runs `work` inside one short transaction (BEGIN…COMMIT/ROLLBACK). */
  runInTransaction: <T>(work: (txDb: DbClient) => Promise<T>) => Promise<T>
  encryptionKey: Buffer
  fetchFn: typeof fetch
}

/** Observable result of one sweep (assert this, not internal call counts — T4). */
export interface ProactiveRefreshSweepSummary {
  candidates: number
  outcomes: Record<ProactiveRefreshOutcome, number>
  /** Deduped server-CR coordinates whose refresh failed `invalid_client` (§5). */
  dcrClientInvalidServers: string[]
  dcrExpiring: number
  dcrExpired: number
}

function emptyOutcomes(): Record<ProactiveRefreshOutcome, number> {
  return { ok: 0, transient: 0, client_invalid: 0, no_grant: 0, skipped: 0, error: 0 }
}

/** Stable per-server-CR coordinate for DCR-policy dedup (mini-spec §5 idempotency). */
function serverCoord(key: OAuthGrantKey): string {
  return `mcpserver|${key.recipeNamespace}|${key.recipeName}`
}

/**
 * Read an mcpserver CR and normalize it to the owner-agnostic oauthClients shape
 * the refresh path consumes — IDENTICAL wiring to the broker route (D4, no
 * drift). Not reused directly because the broker builds it inside its router;
 * both call the same `normalizeMcpServerOwnerDecl`.
 */
function buildOwnerDeclReader(gateway: K8sGateway): {
  read(name: string): Promise<RecipeWithOAuthClients | null>
} {
  return {
    async read(name): Promise<RecipeWithOAuthClients | null> {
      try {
        const server = (await gateway.getResource(
          'mcpservers',
          name,
          config.mcpServersNamespace
        )) as McpServerResource
        return normalizeMcpServerOwnerDecl(server)
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          throw new RecipeNotFoundError(`mcpserver ${config.mcpServersNamespace}/${name} not found`)
        }
        throw err
      }
    },
  }
}

function buildSecretReader(gateway: K8sGateway): SecretReader {
  return {
    async read(name, namespace): Promise<Record<string, string>> {
      try {
        const raw = (await gateway.getSecret(name, namespace)) as { data?: Record<string, string> }
        const decoded: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw.data ?? {})) {
          decoded[k] = Buffer.from(v, 'base64').toString('utf8')
        }
        return decoded
      } catch (err) {
        if (isSecretNotFound(err)) {
          throw new SecretNotFoundError(`secret ${namespace}/${name} not found`)
        }
        throw err
      }
    },
  }
}

/** Production IO wiring: the core pool, the real encryption key, real `fetch`. */
export function defaultSweepDeps(): ProactiveRefreshSweepDeps {
  return {
    db: { query: (text, values) => pool.query(text, values) },
    // `withTransaction` already owns the BEGIN/COMMIT/ROLLBACK/release dance
    // (including the finicky release-on-error handling); the sweep passes the
    // in-transaction client straight through as its `deps.db`, so the refresh
    // UPDATE lands on the SAME connection that holds the `FOR UPDATE` lock.
    runInTransaction: work => withTransaction(txDb => work(txDb)),
    encryptionKey: deriveOAuthEncryptionKey(config.oauthEncryptionKey),
    fetchFn: (input, init) => fetch(input, init),
  }
}

/**
 * One proactive-refresh + DCR sweep. Enumerates remote grants in the proactive
 * window, claims each under `FOR UPDATE SKIP LOCKED` in a short transaction, and
 * refreshes it via the reactive machinery; then sweeps DCR client-secret expiry.
 * Best-effort: a per-row throw is counted as `error` and the sweep continues.
 */
export async function runProactiveRefreshSweep(
  gateway: K8sGateway,
  opts: ProactiveRefreshSweepOptions,
  deps: ProactiveRefreshSweepDeps
): Promise<ProactiveRefreshSweepSummary> {
  const window = {
    proactiveBufferMs: opts.proactiveBufferMs,
    reactiveBufferMs: opts.reactiveBufferMs,
  }
  const ownerDeclReader = buildOwnerDeclReader(gateway)
  const secretReader = buildSecretReader(gateway)

  const summary: ProactiveRefreshSweepSummary = {
    candidates: 0,
    outcomes: emptyOutcomes(),
    dcrClientInvalidServers: [],
    dcrExpiring: 0,
    dcrExpired: 0,
  }
  const clientInvalidServers = new Set<string>()

  const candidates = await listRemoteGrantsInProactiveWindow(deps.db, window)
  summary.candidates = candidates.length

  for (const key of candidates) {
    let outcome: ProactiveRefreshOutcome
    try {
      outcome = await deps.runInTransaction(async txDb => {
        // Re-claim under a row lock. 0 rows ⇒ another replica holds it, or the
        // reactive path already renewed it out of the window since the snapshot.
        const claimed = await claimRemoteGrantForRefresh(txDb, key, window)
        if (!claimed) return 'skipped' as const
        // requireBackground is PER-grantKind, not fixed. SEC-5 governs `user`
        // grants only (unattended reuse needs explicit background consent), so
        // those keep `true` — redundant with the enumeration filter, kept as
        // defense in depth. `shared` grants are context identity, unattended by
        // design and created by `bootstrapSharedOAuthGrant` with `background`
        // defaulting to false; forcing `true` here would make `getOAuthGrant`'s
        // shared branch add `AND background = true`, return `no_grant`, and never
        // refresh the context grant — the mini-spec's headline case. Mirrors the
        // interactive shared broker (`routes/mcpOauth.ts`, requireBackground:false).
        // The access token is discarded; only the persisted refresh + the kind
        // matter. refreshBufferMs = Bp so `getAccessToken` treats an
        // in-proactive-window token as stale and refreshes it.
        // resolveDns/pinnedTransport left undefined ⇒ production resolve +
        // node:https (the remote lane's own IP-pinned path).
        const result = await getAccessToken(
          { ...key, requireBackground: key.grantKind === 'user' },
          {
            db: txDb,
            recipeReader: ownerDeclReader,
            secretReader,
            fetchFn: deps.fetchFn,
            encryptionKey: deps.encryptionKey,
            refreshBufferMs: opts.proactiveBufferMs,
          }
        )
        return resultToOutcome(result)
      })
    } catch (err) {
      // Best-effort: a single row must never abort the sweep. `withTransaction`
      // already rolled back and released the connection.
      outcome = 'error'
      log.error(
        {
          event: 'oauth_proactive_refresh_row_error',
          serverNamespace: key.recipeNamespace,
          serverName: key.recipeName,
          grantKind: key.grantKind,
          oauthClientId: key.oauthClientId,
          err: err instanceof Error ? err.message : String(err),
        },
        'proactive refresh row failed; skipping'
      )
    }

    oauthProactiveRefreshGrantsTotal.inc({ outcome })
    summary.outcomes[outcome] += 1
    if (outcome === 'client_invalid') clientInvalidServers.add(serverCoord(key))
  }

  // §5 idempotency: N grants of one server-CR failing `invalid_client` apply the
  // DCR policy ONCE per coordinate. Avisar/degradar only — never re-register.
  summary.dcrClientInvalidServers = [...clientInvalidServers]
  for (const coord of clientInvalidServers) {
    log.warn(
      { event: 'oauth_dcr_client_invalid_runtime', server: coord },
      'remote refresh failed invalid_client; DCR confidential secret likely expired/rotated — re-registration required (reactive path degrades to connect_required)'
    )
  }

  // §5 time-based DCR sweep — metadata only, never decrypts. Independent of the
  // runtime signal above and best-effort: a read failure logs but does not fail
  // the run (the token refreshes above already committed).
  try {
    await sweepDcrSecretExpiry(deps.db, opts.dcrWarnMs, summary)
  } catch (err) {
    log.error(
      {
        event: 'oauth_dcr_secret_sweep_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'DCR secret-expiry sweep failed'
    )
  }

  return summary
}

async function sweepDcrSecretExpiry(
  db: DbClient,
  dcrWarnMs: number,
  summary: ProactiveRefreshSweepSummary
): Promise<void> {
  const now = Date.now()
  const rows: ExpiringDynamicClient[] = await listExpiringDynamicClients(db, {
    withinMs: dcrWarnMs,
  })
  for (const row of rows) {
    const decision = classifyDcrSecretDecision(
      { clientMode: row.clientMode, clientSecretExpiresAt: row.clientSecretExpiresAt },
      now,
      dcrWarnMs
    )
    if (decision.kind === 'warn') {
      summary.dcrExpiring += 1
      oauthDcrSecretStatusTotal.inc({ state: 'expiring' })
      log.warn(
        {
          event: 'oauth_dcr_secret_expiring',
          serverNamespace: row.serverNamespace,
          serverName: row.serverName,
          clientSecretExpiresAt: row.clientSecretExpiresAt.toISOString(),
        },
        'DCR confidential client_secret is nearing expiry (avisar; no auto re-registration in this unit)'
      )
    } else if (decision.kind === 'expired') {
      summary.dcrExpired += 1
      oauthDcrSecretStatusTotal.inc({ state: 'expired' })
      log.warn(
        {
          event: 'oauth_dcr_secret_expired',
          serverNamespace: row.serverNamespace,
          serverName: row.serverName,
          clientSecretExpiresAt: row.clientSecretExpiresAt.toISOString(),
        },
        'DCR confidential client_secret has expired; refresh will fail invalid_client and degrade to connect_required (re-registration required)'
      )
    }
    // `noop` cannot occur given the enumeration filter, but is harmless if it does.
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

/** Options for the cron loop; buffers/windows plus the tick interval. */
export interface OauthProactiveRefreshCronOptions extends ProactiveRefreshSweepOptions {
  intervalMs: number
}

/**
 * Start the proactive-refresh cron (idempotent; a second call is a no-op while
 * one is running). Each tick runs {@link runProactiveRefreshSweep} and records
 * `oauth_proactive_refresh_runs_total{result}` + the duration histogram. Never
 * holds the process open (`unref`).
 */
export function startOauthProactiveRefreshCron(
  gateway: K8sGateway,
  opts: OauthProactiveRefreshCronOptions,
  deps: ProactiveRefreshSweepDeps = defaultSweepDeps()
): void {
  if (intervalHandle) return
  intervalHandle = setInterval(() => {
    void runOnce(gateway, opts, deps)
  }, opts.intervalMs)
  intervalHandle.unref()
  log.info(
    {
      event: 'oauth_proactive_refresh_cron_started',
      intervalMs: opts.intervalMs,
      proactiveBufferMs: opts.proactiveBufferMs,
      reactiveBufferMs: opts.reactiveBufferMs,
      dcrWarnMs: opts.dcrWarnMs,
    },
    'oauth proactive refresh cron started'
  )
}

async function runOnce(
  gateway: K8sGateway,
  opts: ProactiveRefreshSweepOptions,
  deps: ProactiveRefreshSweepDeps
): Promise<void> {
  const startHr = process.hrtime.bigint()
  try {
    const summary = await runProactiveRefreshSweep(gateway, opts, deps)
    oauthProactiveRefreshRunsTotal.inc({ result: 'ok' })
    log.debug(
      {
        event: 'oauth_proactive_refresh_sweep',
        candidates: summary.candidates,
        outcomes: summary.outcomes,
        dcrExpiring: summary.dcrExpiring,
        dcrExpired: summary.dcrExpired,
        dcrClientInvalidServers: summary.dcrClientInvalidServers.length,
      },
      'oauth proactive refresh sweep complete'
    )
  } catch (err) {
    oauthProactiveRefreshRunsTotal.inc({ result: 'error' })
    log.error(
      {
        event: 'oauth_proactive_refresh_sweep_error',
        err: err instanceof Error ? err.message : String(err),
      },
      'oauth proactive refresh sweep failed'
    )
  } finally {
    const durationSec = Number(process.hrtime.bigint() - startHr) / 1e9
    oauthProactiveRefreshDurationSeconds.observe(durationSec)
  }
}

export function stopOauthProactiveRefreshCron(): void {
  if (!intervalHandle) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

/** Re-exported so `main.ts` passes the reactive buffer as the window's Br. */
export { REACTIVE_REFRESH_BUFFER_MS }
