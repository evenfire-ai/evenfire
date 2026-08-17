/**
 * Plugin Workload SDK grant-update LISTEN/NOTIFY consumer (issue #375, P3).
 *
 * control-api emits `pg_notify('plugin_workload_sdk_grant_update', …)` inside
 * the transaction that upserts, deletes, or revokes a Plugin Workload SDK grant
 * (delivered on COMMIT). This listener turns that best-effort signal into an
 * immediate `forceReconcile` of the affected recipe, so a validated grant is
 * published in ~1–5s instead of waiting for the ≤30s level-triggered watchdog.
 *
 * CROSS-SERVICE CONTRACT: the channel name and payload shape are shared with
 * `control-api/src/services/pluginWorkloadSdkDb.ts`
 * (`PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL`). Keep them in sync.
 *
 * Semantics are deliberately best-effort: a lost NOTIFY (reconnect gap) degrades
 * to the existing polling backstop, never worse. The LISTEN session runs on its
 * own dedicated `pool.connect()` client (a pooled query would not keep the
 * session sticky for notifications), mirroring `dbRunProcessor.ts`. The payload
 * is untrusted DATA, not a command: an unparseable payload or unknown recipe is
 * warned and discarded, never acted on blindly.
 */
import type { Pool, PoolClient } from 'pg'
import { type Logger, createLogger } from '../observability/logger.js'

/** Shared with control-api's grant-mutation NOTIFY. Keep both sides in sync. */
export const PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL = 'plugin_workload_sdk_grant_update'

/** Validated grant-update notification payload. */
export interface GrantUpdateNotification {
  recipeNamespace: string
  recipeName: string
  /** Absent for a whole-recipe revoke that touched multiple families. */
  capabilityFamily?: string
}

export interface GrantUpdateListenerOptions {
  /** Pool the dedicated LISTEN client is checked out from. */
  pool: Pool
  /**
   * Invoked with a validated notification. The caller decides whether the
   * recipe is known and how to react (the watcher enqueues a forceReconcile).
   */
  onGrantUpdate: (notification: GrantUpdateNotification) => void
  logger?: Logger
  /** Test seam: override how the dedicated LISTEN client is acquired. */
  connect?: () => Promise<PoolClient>
  /** Backoff before a reconnect attempt (ms). Default 1000. */
  reconnectDelayMs?: number
  /** Test seam: override the reconnect backoff wait (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>
}

export interface GrantUpdateListener {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Parse a NOTIFY payload into a `GrantUpdateNotification`, or `null` when it is
 * not a well-formed object with string `recipeNamespace`/`recipeName`. Pure and
 * exported so it can be unit-tested without a live Postgres. Never throws.
 */
export function parseGrantUpdatePayload(payload: string): GrantUpdateNotification | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const recipeNamespace = typeof record.recipeNamespace === 'string' ? record.recipeNamespace : ''
  const recipeName = typeof record.recipeName === 'string' ? record.recipeName : ''
  if (!recipeNamespace || !recipeName) return null
  const capabilityFamily =
    typeof record.capabilityFamily === 'string' ? record.capabilityFamily : undefined
  return {
    recipeNamespace,
    recipeName,
    ...(capabilityFamily ? { capabilityFamily } : {}),
  }
}

export function createGrantUpdateListener(opts: GrantUpdateListenerOptions): GrantUpdateListener {
  const log = opts.logger ?? createLogger('wrc', 'grant-update-listener')
  const connect = opts.connect ?? (() => opts.pool.connect())
  const reconnectDelayMs = opts.reconnectDelayMs ?? 1_000
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  // NOTE (detection-duty, issue #375): the sibling `dbRunProcessor.ts` LISTEN
  // consumer has the same latent patterns this module hardens against —
  // (1) a LISTEN rejection AND an 'error' emission on the same drop can start two
  // reconnect loops, (2) stop() cannot cancel an attach already awaiting
  // connect(), (3) a LISTEN failure without an 'error' event leaks the
  // checked-out client, and (4) a LATE error from a superseded generation drives
  // a reconnect that orphans the live session (duplicate dispatch + monotonic
  // pool leak under a sustained reconnect storm — the #205 blind-spot shape).
  // Fixing dbRunProcessor is out of #375 scope; this listener intentionally
  // improves on it and the guards below (esp. the identity gate on the 'error'
  // handler + the non-overwrite guard before assigning `listenClient`) are the
  // reference for the follow-up.
  let listenClient: PoolClient | null = null
  let stopped = true
  // H1: collapse concurrent reconnect triggers into ONE in-flight reconnect.
  let reconnecting = false

  async function attachListener(): Promise<void> {
    let client: PoolClient | null = null
    try {
      client = await connect()
      // H2: stop() may have run while we awaited connect(); do NOT bring up a
      // LISTEN session after shutdown. Release the client and bail before any
      // handler is registered, so nothing dispatches post-stop.
      if (stopped) {
        client.release()
        return
      }
      const attached = client
      attached.on('notification', msg => {
        if (msg.channel !== PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL || !msg.payload) return
        const notification = parseGrantUpdatePayload(msg.payload)
        if (!notification) {
          // Untrusted payload — warn and discard, never act on it.
          log.warn('discarding unparseable grant-update notification', {
            payload_length: msg.payload.length,
          })
          return
        }
        try {
          opts.onGrantUpdate(notification)
        } catch (err) {
          log.error('grant-update dispatch failed', {
            recipe_namespace: notification.recipeNamespace,
            recipe_name: notification.recipeName,
            err: err instanceof Error ? err.message : String(err),
          })
        }
      })
      attached.on('error', (err: Error) => {
        try {
          attached.release(err)
        } catch {
          /* idempotent */
        }
        // Finding 1 (#205-class): IDENTITY GATE. Only the CURRENT session's error
        // may drive a reconnect. A LATE error from a superseded generation — its
        // successor has already attached and become `listenClient` — must release
        // ONLY itself and return. If it scheduled a reconnect it would spawn a
        // second attach loop whose success overwrites the live session, orphaning
        // it: still checked out from the shared pool with a live LISTEN handler →
        // duplicate NOTIFY dispatch + one leaked connection per occurrence →
        // monotonic pool exhaustion under a reconnect storm (GKE regime).
        if (listenClient !== attached) {
          log.debug('superseded listen session error — released self, no reconnect', {
            err: err.message,
          })
          return
        }
        log.warn('listen session error — will reconnect', { err: err.message })
        listenClient = null
        scheduleReconnect()
      })
      await attached.query(`LISTEN ${PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL}`)
      // H2: re-check after the async LISTEN resolves — stop() may have run
      // during the round-trip.
      if (stopped) {
        try {
          attached.release()
        } catch {
          /* idempotent */
        }
        return
      }
      // Finding 1: never overwrite a live `listenClient` without releasing the
      // prior one. Defense-in-depth alongside the identity gate above — a stray
      // interleaving that reaches here with a different session still checked out
      // must not leak it.
      if (listenClient && listenClient !== attached) {
        try {
          listenClient.release()
        } catch {
          /* idempotent */
        }
      }
      listenClient = attached
      log.info('LISTEN plugin_workload_sdk_grant_update attached')
    } catch (err) {
      log.warn('LISTEN attach failed — will retry', {
        err: err instanceof Error ? err.message : String(err),
      })
      // H3: a LISTEN failure may not emit an 'error' event, so release the
      // checked-out client here (if we got one) before scheduling the retry —
      // otherwise the connection leaks back to the pool checked out forever.
      if (client) {
        try {
          client.release(err instanceof Error ? err : new Error(String(err)))
        } catch {
          /* idempotent */
        }
      }
      scheduleReconnect()
    }
  }

  function scheduleReconnect(): void {
    // H1: the LISTEN-query rejection and the 'error' event both fire on a single
    // connection drop. Without this guard each would spawn its own reconnect
    // loop → a leaked client and duplicated dispatch. Only one may be in flight.
    if (stopped || reconnecting) return
    reconnecting = true
    void reconnectLater()
  }

  async function reconnectLater(): Promise<void> {
    await sleep(reconnectDelayMs)
    // Clear the guard BEFORE re-attaching so a failure inside attachListener can
    // schedule the NEXT reconnect; the sleep window above is what collapses the
    // concurrent triggers from a single drop.
    reconnecting = false
    if (stopped) return
    await attachListener()
  }

  return {
    async start() {
      if (!stopped) return
      stopped = false
      await attachListener()
    },

    async stop() {
      stopped = true
      // issue #375 (R4): clear the in-flight reconnect guard so a later
      // stop()→start() restart is not blocked by a stale flag left set by a
      // reconnect that was still mid-sleep when we stopped (belt-and-suspenders).
      reconnecting = false
      if (listenClient) {
        try {
          await listenClient.query(`UNLISTEN ${PLUGIN_WORKLOAD_SDK_GRANT_UPDATE_CHANNEL}`)
        } catch {
          /* best-effort — the session is being torn down */
        }
        try {
          listenClient.release()
        } catch {
          /* idempotent */
        }
        listenClient = null
      }
    },
  }
}
