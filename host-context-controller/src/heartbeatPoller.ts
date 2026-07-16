/**
 * Heartbeat poller — HCC's consumption side of the stateless lifecycle.
 *
 * mcp-host pods authenticate their D8 heartbeats ONLY toward control-api's
 * /mcp-host facade (via the nginx-workflow-approval-gateway); control-api is
 * the single verifier of plane JWTs and persists each beat. HCC never
 * verifies Host JWTs — every `CONTEXT_MAPPER_HEARTBEAT_POLL_MS` this poller
 * GETs `GET ${CONTROL_API_BASE_URL}/api/v1/auth/mcp-host/heartbeats?since=…`
 * with its InternalControl JWT (HS256, iss=hcc) and feeds the rows, oldest
 * first, into the EXISTING StatelessLifecycleTracker.
 *
 * Drain answer flow: the tracker DECIDES; the emitter learns the verdict
 * from control-api, which answers `{drain}` from
 * `Host.status.lifecycle.state`. A `drain: true` decision is therefore made
 * durable here via the reconciler's idempotent draining status write
 * (`markHostDraining`). Cancel-drain is executed INSIDE the tracker: a
 * drain:false verdict backed by activity or pending-wake evidence reverts
 * the CR (`draining` → `active`) through the reconciler seam, so this
 * poller simply skips drain:false verdicts; the wake fast-path remains the
 * only reviver of a `suspended` Host. A drained report keeps the unchanged
 * suspend flow inside the tracker.
 *
 * Cursor: `since` is the timestamp captured at the START of the last fully
 * successful poll (initial lookback 5 min), so it only advances when a poll
 * succeeds end to end. Overlapping rows are harmless — the tracker already
 * handles repeated heartbeats — while a failed poll never skips rows.
 *
 * Failure posture: a poll failure logs loudly (rate-limited) and the poller
 * keeps running — it must never crash HCC. NOTE: while polls fail the
 * tracker sees no fresh heartbeats, so its decisions pause on stale data
 * and no new drain decision is made until the feed recovers. Each FULLY
 * successful poll is reported to the tracker (noteSuccessfulPoll): an
 * already-armed drain-grace timer that expires during a feed outage RE-ARMS
 * instead of force-suspending a silent-looking emitter — silence only counts
 * against the emitter when the feed provably flowed across the window.
 */
import {
  HeartbeatLifecycleTracker,
  HeartbeatPayload,
  parseHeartbeatPayload,
} from './statelessLifecycleTracker'
import { HostCRD } from './types'

/** Cursor lookback for the very first poll after startup. */
export const INITIAL_HEARTBEAT_LOOKBACK_MS = 5 * 60_000
/** Poll failures are re-logged at most once per this window. */
const ERROR_LOG_SUPPRESSION_MS = 60_000

/** Structural fetch so tests inject a fake without DOM lib types. */
export type HeartbeatPollerFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface HeartbeatPollerOptions {
  /** CONTEXT_MAPPER_HEARTBEAT_POLL_MS (validated at config load). */
  pollIntervalMs: number
  /** Cluster-internal control-api base URL (CONTROL_API_BASE_URL). */
  controlApiBaseUrl: string
  tracker: HeartbeatLifecycleTracker
  /** Host CRD lookup from the informer cache (McpServerWatcher.getHost). */
  getHost: (hostRef: string) => HostCRD | undefined
  /** Durable, idempotent draining status write
   *  (HostReconciler.markHostDrainingFromHeartbeat). The second argument is
   *  the AP-1 generation epoch the tracker captured when it DECIDED the
   *  drain (HeartbeatVerdict.entryWakeHandledGeneration): the write's commit
   *  no-ops when the fresh handled generation advanced past it, so an aged
   *  verdict queued behind a handled wake never re-fences the woken pod. */
  markHostDraining: (host: HostCRD, entryWakeHandledGeneration: number) => Promise<void>
  /** InternalControl JWT signer (iss=hcc) — re-signed per poll (60s TTL). */
  signInternalControlJwt: () => string
  fetchImpl?: HeartbeatPollerFetch
  now?: () => number
}

type PolledHeartbeatRow = {
  payload: HeartbeatPayload
  receivedAtMs: number
}

export class HeartbeatPoller {
  private readonly pollIntervalMs: number
  private readonly endpointUrl: string
  private readonly tracker: HeartbeatLifecycleTracker
  private readonly getHost: (hostRef: string) => HostCRD | undefined
  private readonly markHostDraining: (
    host: HostCRD,
    entryWakeHandledGeneration: number
  ) => Promise<void>
  private readonly signInternalControlJwt: () => string
  private readonly fetchImpl: HeartbeatPollerFetch
  private readonly now: () => number

  private sinceMs = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private stopped = false
  private lastErrorLogTs = Number.NEGATIVE_INFINITY

  constructor(options: HeartbeatPollerOptions) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
      throw new Error(
        `[HeartbeatPoller] pollIntervalMs must be a positive integer, got '${options.pollIntervalMs}'`
      )
    }
    if (!options.controlApiBaseUrl.trim()) {
      throw new Error(
        '[HeartbeatPoller] controlApiBaseUrl must be non-empty (CONTROL_API_BASE_URL)'
      )
    }
    this.pollIntervalMs = options.pollIntervalMs
    this.endpointUrl = `${options.controlApiBaseUrl.replace(/\/$/, '')}/api/v1/auth/mcp-host/heartbeats`
    this.tracker = options.tracker
    this.getHost = options.getHost
    this.markHostDraining = options.markHostDraining
    this.signInternalControlJwt = options.signInternalControlJwt
    this.fetchImpl = options.fetchImpl ?? (fetch as HeartbeatPollerFetch)
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.sinceMs = Math.max(0, this.now() - INITIAL_HEARTBEAT_LOOKBACK_MS)
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick()
    }, this.pollIntervalMs)
  }

  private logErrorRateLimited(err: unknown): void {
    const now = this.now()
    if (now - this.lastErrorLogTs < ERROR_LOG_SUPPRESSION_MS) return
    this.lastErrorLogTs = now
    console.error(
      `[HeartbeatPoller] poll of ${this.endpointUrl} failed (since=${this.sinceMs}) — ` +
        'lifecycle decisions pause on stale data until the feed recovers; the poller keeps running',
      err
    )
  }

  /**
   * Strict row validation: the feed comes from control-api (trusted plane),
   * but a malformed row means a broken contract — fail the WHOLE poll loudly
   * (cursor not advanced, retried next cycle) rather than silently applying
   * a partial batch.
   */
  private parseRows(body: unknown): PolledHeartbeatRow[] {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('heartbeat feed response must be a JSON object')
    }
    const heartbeats = (body as { heartbeats?: unknown }).heartbeats
    if (!Array.isArray(heartbeats)) {
      throw new Error('heartbeat feed response is missing the heartbeats array')
    }
    return heartbeats.map((raw, index) => {
      // The feed row is the emitter payload (schemaVersion is implicit in the
      // persisted snapshot) plus receivedAtMs; parseHeartbeatPayload
      // tolerates the extra field and enforces every required one.
      const parsed = parseHeartbeatPayload(
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? { schemaVersion: 1, ...(raw as Record<string, unknown>) }
          : raw
      )
      if (!parsed.ok) {
        throw new Error(`heartbeat feed row ${index} is malformed: ${parsed.error}`)
      }
      const receivedAtMs = (raw as Record<string, unknown>).receivedAtMs
      if (typeof receivedAtMs !== 'number' || !Number.isFinite(receivedAtMs) || receivedAtMs < 0) {
        throw new Error(
          `heartbeat feed row ${index} is malformed: receivedAtMs must be a non-negative number`
        )
      }
      return { payload: parsed.payload, receivedAtMs }
    })
  }

  private async tick(): Promise<void> {
    this.timer = null
    const pollStartedMs = this.now()
    try {
      const response = await this.fetchImpl(`${this.endpointUrl}?since=${this.sinceMs}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.signInternalControlJwt()}` },
      })
      if (!response.ok) {
        throw new Error(`heartbeat poll returned HTTP ${response.status}`)
      }
      const rows = this.parseRows(await response.json())
      // Oldest first — podUid ordering inside the tracker depends on arrival
      // order (a newer podUid retires the previous one).
      rows.sort((a, b) => a.receivedAtMs - b.receivedAtMs)
      for (const row of rows) {
        const verdict = await this.tracker.handleHeartbeat(row.payload)
        if (!verdict.drain) continue
        // Persist the drain decision durably — control-api answers the
        // emitter's next beat with {drain:true} from Host.status. This
        // replaces the HTTP response the tracker used to answer directly.
        const host = this.getHost(row.payload.hostRef)
        if (!host) {
          console.warn(
            `[HeartbeatPoller] drain decided for unknown Host "${row.payload.hostRef}" — draining status write skipped`
          )
          continue
        }
        try {
          await this.markHostDraining(host, verdict.entryWakeHandledGeneration)
        } catch (err) {
          // Loud, not fatal: the emitter keeps beating, the tracker keeps
          // deciding drain, and the fresh Host read + status write retry on
          // the next polled beat.
          console.error(
            `[HeartbeatPoller] draining status write failed for "${row.payload.hostRef}":`,
            err
          )
        }
      }
      // AP-3 feed-health report: this poll succeeded end to end, so the
      // tracker may attribute per-host silence to the emitter (not the feed)
      // for grace windows this poll postdates.
      this.tracker.noteSuccessfulPoll?.(this.pollIntervalMs)
      // Advance ONLY on full success. Rows ingested between the cursor and
      // this poll's start may be returned again next time — duplicates are
      // harmless, skipped rows are not.
      this.sinceMs = pollStartedMs
    } catch (err) {
      this.logErrorRateLimited(err)
    }
    this.schedule()
  }
}
