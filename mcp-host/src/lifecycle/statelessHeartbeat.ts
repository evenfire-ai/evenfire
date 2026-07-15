/**
 * Stage 3 (stateless-agents) — push heartbeat emitter + reversible DRAINING
 * fence.
 *
 * Active ONLY when `CLERUM_STATELESS_LIFECYCLE=true`. Every interval the
 * emitter POSTs a D8 activity snapshot to control-api's /mcp-host facade via
 * the workflow-approval gateway
 * (`POST ${MCP_HOST_GATEWAY_URL}/api/v1/mcp-host/hosts/heartbeat`) and obeys
 * the `{ drain: boolean }` verdict in the response. control-api answers the
 * verdict from `Host.status.lifecycle.state` (HCC decides it via its poller);
 * identity comes from the runtime token CLAIMS, never from the URL path:
 *
 *   - `drain: true` while active   → enter DRAINING: the runtime message
 *     intake route rejects new messages with 503 `{ code: 'host_draining' }`;
 *     the in-flight turn keeps running to completion.
 *   - `drain: false` while draining/drained → CANCEL the drain: the fence
 *     lifts immediately (no restart) and the emitter reports 'active' again.
 *
 * While draining, the cadence accelerates to `max(interval/4, 1s)` so a
 * drain-cancel from HCC lands fast. Two extra behaviors cut the warm
 * wake-recovery to ~1-2s when a user resumes a session against a fenced host:
 *
 *   - Edge-triggered immediate beat: the FIRST fenced intake of an episode
 *     (`noteFencedIntake()` flipping pendingIntake false->true) reschedules
 *     the armed timer to fire (near-)immediately, so `pendingIntake: true`
 *     reaches control-api now instead of after the accelerated interval.
 *     Subsequent fenced 503s of the same burst do NOT re-trigger it, and a
 *     beat already in flight is never doubled (no armed timer exists while a
 *     tick runs; the in-flight tick re-arms on completion).
 *   - Pending-intake cadence floor: while `pendingIntake` is set (fence still
 *     up) the inter-beat delay floors at
 *     `MIN_ACCELERATED_HEARTBEAT_INTERVAL_MS` (1s) instead of `interval/4`,
 *     so if the immediate beat raced ahead of the wake landing, the retry
 *     comes in 1s. Bounded: `pendingIntake` clears when the drain-cancel
 *     verdict lifts the fence (`applyDrainVerdict`).
 *
 * Once the in-flight turn finishes AND the
 * store's final checkpoint (persist-queue drain) completes, subsequent
 * heartbeats report `state: 'drained'` — HCC's cue that the pod can be
 * suspended without losing a turn.
 *
 * Failure posture: the heartbeat must NEVER crash the host. A 404 from an
 * older gateway (rollout skew: mcp-host image updated before the gateway /
 * control-api) is tolerated by design — warn once, keep trying at the normal
 * cadence. Any
 * other failure is logged loudly (rate-limited) and the interval keeps
 * running.
 */

export type HostLifecycleState = 'active' | 'draining' | 'drained'

/** D8 activity conditions — each maps 1:1 onto a payload field. */
export interface HeartbeatConditions {
  /** Any session with a non-null active_task_id OR a turn currently executing. */
  activeTask: boolean
  /** Any session in AwaitingApproval. */
  awaitingApproval: boolean
  /** Either in-RAM result store (task / cron) is non-empty. */
  pendingResults: boolean
  /**
   * Cron×stateless: the CronScheduler holds >=1 ENABLED schedule. A
   * suspended pod cannot fire cron, so an active schedule and suspension are
   * fundamentally incompatible — this pins activeWork exactly like the
   * sibling conditions; HCC surfaces it as `SuspendBlocked: activeCronSchedules`.
   */
  activeCronSchedules: boolean
}

export interface StatelessHeartbeatPayload {
  schemaVersion: 1
  hostRef: string
  podUid: string
  activeWork: boolean
  conditions: HeartbeatConditions
  /** Epoch ms of the last inbound runtime message / turn activity. */
  lastActivityTs: number
  state: HostLifecycleState
  /**
   * H2 self-heal signal (additive — schemaVersion stays 1; older ingest
   * tolerates the extra field). True when a new runtime message arrived while
   * the intake fence was up (draining/drained) and was 503'd back to rpc-proxy
   * for hold+redrive. It lets control-api/HCC cancel the drain deterministically
   * instead of relying only on the idle re-evaluation: a drained host that
   * forgets to receive `drain: false` would otherwise 503 new work forever.
   * Reset to false the moment the fence lifts (drain-cancel).
   */
  pendingIntake: boolean
}

/**
 * View of the lifecycle state consulted by the `POST /v1/runtime/messages`
 * route (see `RPCServer.setLifecycleGate`). Kept minimal on purpose: the
 * server only needs "is intake fenced?" and a hook to record intake activity.
 */
export interface RuntimeLifecycleGate {
  /** True while DRAINING or DRAINED — the intake route must 503. */
  isIntakeFenced(): boolean
  /** Called by the intake route when a runtime message is accepted. */
  noteIntakeActivity(): void
  /**
   * H2 — called by the intake route when a runtime message is REJECTED because
   * the fence is up. Records that new work is waiting so the next heartbeat
   * surfaces `pendingIntake: true`, giving HCC/control-api a deterministic
   * cue to cancel the drain instead of stranding the host in a 503 loop.
   */
  noteFencedIntake(): void
}

/**
 * Structural fetch so tests inject a fake without dragging in DOM lib types.
 * The global `fetch` satisfies it.
 */
export type HeartbeatFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
  }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface HeartbeatLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string, err?: unknown): void
}

export interface StatelessHeartbeatOptions {
  /** `CLERUM_STATELESS_LIFECYCLE` — when false the emitter is a no-op. */
  enabled: boolean
  /** Host name (CLERUM_HOST_NAME → config.hostName). */
  hostRef: string
  /** Pod UID from the Kubernetes downward API (CLERUM_POD_UID). HCC must
   *  inject it via `fieldRef: metadata.uid` on stateless Hosts. */
  podUid: string
  /** Workflow-approval gateway base URL (config.mcpHostGatewayUrl —
   *  MCP_HOST_GATEWAY_URL, the nginx :8092 gateway fronting control-api's
   *  /mcp-host facade). */
  gatewayBaseUrl: string
  /** Normal cadence (CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS). */
  intervalMs: number
  /** Re-read the CURRENT runtime access token per request from the shared
   *  refreshing McpHostRuntimeAuth holder (updated in place by the runtime-auth
   *  refresh path) — NOT a static env var, which would freeze at boot and 401
   *  once the ~300s access token expires. MUST throw when the token is
   *  unavailable — the tick catches it and logs loudly without killing the
   *  interval. */
  getAccessToken: () => string
  /**
   * M3 — refresh-on-401 seam. Invoked at most ONCE per tick when the heartbeat
   * POST comes back 401/403, then the POST is retried once with the refreshed
   * token before the tick gives up and logs loudly. Mirrors UsageReporter /
   * BudgetClient (`refreshWithRecovery(auth)`), making the heartbeat able to
   * self-heal an expired access token instead of depending solely on the
   * proactive refresh timer. Injected so unit tests stay hermetic (fake
   * refresh). Optional: when omitted, a 401/403 throws loud with no retry.
   */
  refreshOnUnauthorized?: () => Promise<void>
  /** D8 condition snapshot, computed fresh per tick. */
  getConditions: () => HeartbeatConditions
  /** Final durable flush before reporting 'drained' — the conversation
   *  store's persist-queue drain (waits for every pending async write). */
  flushFinalCheckpoint: () => Promise<void>
  fetchImpl?: HeartbeatFetch
  logger?: HeartbeatLogger
  now?: () => number
}

/** Default cadence when CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS is unset. */
export const DEFAULT_STATELESS_HEARTBEAT_INTERVAL_MS = 30_000
/** Floor for the accelerated (draining) cadence. */
export const MIN_ACCELERATED_HEARTBEAT_INTERVAL_MS = 1_000
/** Non-404 failures are re-logged at most once per this window. */
const ERROR_LOG_SUPPRESSION_MS = 60_000

const consoleLogger: HeartbeatLogger = {
  info: message => console.log(message),
  warn: message => console.warn(message),
  error: (message, err) => console.error(message, err),
}

export class StatelessHeartbeat implements RuntimeLifecycleGate {
  private readonly enabled: boolean
  private readonly hostRef: string
  private readonly podUid: string
  private readonly endpointUrl: string
  private readonly intervalMs: number
  private readonly getAccessToken: () => string
  private readonly refreshOnUnauthorized?: () => Promise<void>
  private readonly getConditions: () => HeartbeatConditions
  private readonly flushFinalCheckpoint: () => Promise<void>
  private readonly fetchImpl: HeartbeatFetch
  private readonly logger: HeartbeatLogger
  private readonly now: () => number

  private state: HostLifecycleState = 'active'
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private stopped = false
  private finalFlushDone = false
  private pendingIntake = false
  private warned404 = false
  private lastErrorLogTs = Number.NEGATIVE_INFINITY
  private lastActivityTs: number

  constructor(options: StatelessHeartbeatOptions) {
    this.enabled = options.enabled
    if (this.enabled) {
      // Fail loud on misconfiguration: a heartbeat that silently posts an
      // empty hostRef/podUid would poison HCC's suspend decisions.
      if (!options.hostRef.trim()) {
        throw new Error('[StatelessHeartbeat] hostRef must be non-empty (CLERUM_HOST_NAME)')
      }
      if (!options.podUid.trim()) {
        throw new Error(
          '[StatelessHeartbeat] podUid must be non-empty — HCC must inject CLERUM_POD_UID ' +
            'via the downward API (fieldRef: metadata.uid) on stateless Hosts'
        )
      }
      if (!options.gatewayBaseUrl.trim()) {
        throw new Error(
          '[StatelessHeartbeat] gatewayBaseUrl must be non-empty (MCP_HOST_GATEWAY_URL)'
        )
      }
      if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
        throw new Error(
          `[StatelessHeartbeat] intervalMs must be a positive integer, got '${options.intervalMs}'`
        )
      }
    }
    this.hostRef = options.hostRef
    this.podUid = options.podUid
    // hostRef travels in the PAYLOAD only: control-api binds identity from
    // the runtime token claims (hostRefs[0]) — never from the URL path.
    this.endpointUrl = `${options.gatewayBaseUrl.replace(/\/$/, '')}/api/v1/mcp-host/hosts/heartbeat`
    this.intervalMs = options.intervalMs
    this.getAccessToken = options.getAccessToken
    this.refreshOnUnauthorized = options.refreshOnUnauthorized
    this.getConditions = options.getConditions
    this.flushFinalCheckpoint = options.flushFinalCheckpoint
    this.fetchImpl = options.fetchImpl ?? (fetch as HeartbeatFetch)
    this.logger = options.logger ?? consoleLogger
    this.now = options.now ?? Date.now
    this.lastActivityTs = this.now()
  }

  /** Begin emitting. No-op when the stateless lifecycle flag is off. */
  start(): void {
    if (!this.enabled || this.started) return
    this.started = true
    this.schedule(this.currentDelayMs())
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  getState(): HostLifecycleState {
    return this.state
  }

  // ─── RuntimeLifecycleGate ───────────────────────────────────────────

  isIntakeFenced(): boolean {
    return this.enabled && this.state !== 'active'
  }

  noteIntakeActivity(): void {
    this.lastActivityTs = this.now()
    // The Host CR can already be draining while this process has not yet
    // received that verdict. Push the accepted intake to HCC immediately so the
    // stale drain can be cancelled before grace expiry scales the pod down.
    this.requestImmediateBeat()
  }

  noteFencedIntake(): void {
    // A new message hit the intake fence (503 host_draining). Record it so the
    // NEXT heartbeat carries pendingIntake=true. Also refresh lastActivityTs:
    // the arrival IS activity, even though the message was redriven by
    // rpc-proxy rather than processed here. Reset happens when the fence lifts
    // (applyDrainVerdict) — it must not self-clear, so the signal survives
    // across ticks until HCC actually cancels the drain.
    const firstFencedIntake = !this.pendingIntake
    this.pendingIntake = true
    this.lastActivityTs = this.now()
    // Edge-triggered wake recovery: only the false->true transition requests
    // an out-of-cycle beat — a burst of fenced 503s while already pending must
    // not spam extra beats (the 1s pendingIntake cadence floor covers retries).
    if (firstFencedIntake) {
      this.requestImmediateBeat()
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private currentDelayMs(): number {
    if (this.state === 'active') return this.intervalMs
    // A fenced intake is waiting: floor the cadence at 1s so the drain-cancel
    // fired by rpc-proxy's auto-wake is learned within ~1s even if the
    // immediate beat raced ahead of the wake landing. Bounded: pendingIntake
    // clears in applyDrainVerdict when the fence lifts.
    if (this.pendingIntake) return MIN_ACCELERATED_HEARTBEAT_INTERVAL_MS
    // Accelerated cadence while draining/drained so a drain-cancel lands fast.
    return Math.max(Math.floor(this.intervalMs / 4), MIN_ACCELERATED_HEARTBEAT_INTERVAL_MS)
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
  }

  /**
   * Reschedule the armed timer to fire (near-)immediately so a beat runs now
   * instead of after the remaining delay. No-op when the emitter never
   * started, is stopped, or no timer is armed — `timer === null` while a
   * tick is executing (tick() nulls it on entry), so a POST already in
   * flight is never doubled: that tick re-arms via currentDelayMs() on
   * completion, which floors at 1s while pendingIntake is set. Single timer
   * chain — this reuses schedule(), it never creates a parallel one.
   */
  private requestImmediateBeat(): void {
    if (!this.started || this.stopped || this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
    this.schedule(0)
  }

  private buildPayload(): StatelessHeartbeatPayload {
    const conditions = this.getConditions()
    return {
      schemaVersion: 1,
      hostRef: this.hostRef,
      podUid: this.podUid,
      // H2: a message that hit the DRAINING fence is pending work — fold it
      // into activeWork so the EXISTING tracker gate (drain = !activeWork && ...)
      // cancels the drain deterministically through the activeWork field
      // control-api already persists and HCC already reads (no cross-service
      // contract change). pendingIntake is also surfaced for observability.
      activeWork:
        conditions.activeTask ||
        conditions.awaitingApproval ||
        conditions.pendingResults ||
        conditions.activeCronSchedules ||
        this.pendingIntake,
      conditions,
      lastActivityTs: this.lastActivityTs,
      state: this.state,
      pendingIntake: this.pendingIntake,
    }
  }

  private applyDrainVerdict(drain: boolean): void {
    if (drain && this.state === 'active') {
      this.state = 'draining'
      this.logger.info(
        `[StatelessHeartbeat] HCC requested drain — runtime intake fenced (host=${this.hostRef})`
      )
    } else if (!drain && this.state !== 'active') {
      // Reversible fence: drain-cancel resumes intake immediately, no restart.
      this.state = 'active'
      this.finalFlushDone = false
      // The fence is down; any queued self-heal signal has served its purpose.
      this.pendingIntake = false
      this.logger.info(
        `[StatelessHeartbeat] HCC cancelled drain — runtime intake resumed (host=${this.hostRef})`
      )
    }
  }

  private logErrorRateLimited(err: unknown): void {
    const now = this.now()
    if (now - this.lastErrorLogTs < ERROR_LOG_SUPPRESSION_MS) return
    this.lastErrorLogTs = now
    this.logger.error(
      `[StatelessHeartbeat] heartbeat POST to ${this.endpointUrl} failed (state=${this.state}) — ` +
        'the emitter keeps running',
      err
    )
  }

  private async postHeartbeat(): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }> {
    return this.fetchImpl(this.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.getAccessToken()}`,
      },
      body: JSON.stringify(this.buildPayload()),
    })
  }

  private async tick(): Promise<void> {
    this.timer = null
    let nextDelayMs: number
    try {
      // Drained transition: once the in-flight turn has finished, run the
      // final durable flush exactly once per drain episode, THEN start
      // reporting 'drained'. A drain-cancel resets `finalFlushDone`. The flush
      // is the persist-queue drain (awaits every pending WAL-committed write
      // under synchronous=FULL) — NOT a wal_checkpoint(FULL) pragma; the WAL
      // checkpoint stays PASSIVE and is not the durability mechanism here.
      if (this.state === 'draining' && !this.finalFlushDone && !this.getConditions().activeTask) {
        await this.flushFinalCheckpoint()
        if (this.state === 'draining') {
          // Check-then-act closed: the pre-flush gate read the conditions
          // BEFORE the await, and internally-generated work (a cron dispatch,
          // an approval resolution) can start DURING the flush. Re-read the
          // SAME conditions at the commit point and ABORT the drained
          // transition if any is active — stay draining (finalFlushDone stays
          // false) so the next beat re-evaluates from scratch. Reporting
          // 'drained' here would cue HCC to suspend and kill the mid-flight run.
          const post = this.getConditions()
          const abortedBy = post.activeTask
            ? 'activeTask'
            : post.awaitingApproval
              ? 'awaitingApproval'
              : post.pendingResults
                ? 'pendingResults'
                : post.activeCronSchedules
                  ? 'activeCronSchedules'
                  : null
          if (abortedBy !== null) {
            this.logger.warn(
              `[StatelessHeartbeat] drained transition aborted — condition '${abortedBy}' became ` +
                `active during the final checkpoint flush; staying draining (host=${this.hostRef})`
            )
          } else {
            this.finalFlushDone = true
            this.state = 'drained'
            this.logger.info(
              `[StatelessHeartbeat] final checkpoint flushed — reporting drained (host=${this.hostRef})`
            )
          }
        }
      }

      let response = await this.postHeartbeat()

      // M3 self-heal: on 401/403 refresh the runtime token ONCE and retry the
      // POST once. This is the heartbeat's only path back from an expired token
      // without waiting on the proactive refresh timer. A second 401/403 (or a
      // refresh that throws) falls through to the generic throw below — no loop.
      if ((response.status === 401 || response.status === 403) && this.refreshOnUnauthorized) {
        this.logger.warn(
          `[StatelessHeartbeat] heartbeat POST returned HTTP ${response.status}; ` +
            `refreshing the runtime token and retrying once (host=${this.hostRef})`
        )
        await this.refreshOnUnauthorized()
        response = await this.postHeartbeat()
      }

      if (response.status === 404) {
        // Rollout skew tolerance BY DESIGN: an older gateway/control-api does
        // not serve the heartbeat endpoint yet. Warn once, keep trying at the
        // NORMAL cadence (nobody is answering, so accelerating while
        // draining buys nothing).
        if (!this.warned404) {
          this.warned404 = true
          this.logger.warn(
            `[StatelessHeartbeat] ${this.endpointUrl} returned 404 — the workflow-approval ` +
              'gateway predates the heartbeat endpoint (rollout skew). Continuing at the normal cadence.'
          )
        }
        nextDelayMs = this.intervalMs
      } else if (!response.ok) {
        throw new Error(`heartbeat POST returned HTTP ${response.status}`)
      } else {
        const body = (await response.json()) as { drain?: unknown } | null
        if (!body || typeof body.drain !== 'boolean') {
          throw new Error('heartbeat response is missing the boolean `drain` field')
        }
        this.applyDrainVerdict(body.drain)
        nextDelayMs = this.currentDelayMs()
      }
    } catch (err) {
      // The heartbeat must never crash the host: log loudly (rate-limited)
      // and keep the interval running.
      this.logErrorRateLimited(err)
      nextDelayMs = this.currentDelayMs()
    }
    this.schedule(nextDelayMs)
  }
}
