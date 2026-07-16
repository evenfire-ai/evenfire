/**
 * Stage 3 (stateless-agents) — heartbeat lifecycle tracker + D8 idle gate.
 *
 * Consumes authenticated heartbeats from stateless mcp-host pods
 * (`POST /api/v1/hosts/:hostRef/heartbeat`) and DECIDES the drain verdict;
 * EXECUTION (status writes, replicas derivation) stays in HostReconciler
 * behind the `StatelessLifecycleReconcilerPort` seam.
 *
 * Decision rules:
 *   - Idle (D8): `drain = statelessEnabled && !activeWork &&
 *     (now - payload.lastActivityTs >= T_idle)` with
 *     `T_idle = max(idleMinutes, idleFloorMinutes)`. The decision derives
 *     from the PAYLOAD's lastActivityTs, so it survives HCC restarts — a
 *     fresh tracker answers correctly on the very first heartbeat.
 *   - Max-uptime ceiling: a pod older than `maxUptimeHours` (from the pod's
 *     creationTimestamp, resolved once per podUid through the reconciler)
 *     drains regardless of activity.
 *   - Pending wake wins: when the Host's wake-requested generation exceeds
 *     status.lifecycle.wakeHandledGeneration the answer is ALWAYS
 *     `drain: false` (cancel-drain) and no suspension is executed.
 *   - Tracker-side cancel-drain: a `drain: false` verdict backed by host
 *     evidence — activity (activeWork / recent lastActivityTs) or a pending
 *     wake — while the CR still says `draining` REVERTS
 *     status.lifecycle.state to `active` through the reconciler seam, so
 *     control-api stops answering {drain:true} and the emitter's fence
 *     lifts even if the rpc-proxy wake call never lands. The wake fast-path
 *     remains the only reviver of a `suspended` Host.
 *   - `state: 'drained'` asks the reconciler to suspend
 *     (status.lifecycle.state='suspended', reason 'idle') and reconcile —
 *     UNLESS the report's own lastActivityTs is fresher than T_idle (a turn
 *     was accepted and served after the drain verdict but before the emitter
 *     fenced, so the idle decision is stale): the drained report is
 *     SUPERSEDED — the drain is cancelled (CR reverts to `active`, the
 *     emitter un-fences) and the verdict is drain:false. Max-uptime drains
 *     are exempt: an over-age pod suspends regardless of activity.
 *   - Drain-grace expiry is ACK-AWARE: after a `drain: true` verdict the
 *     grace only force-suspends when the emitter ACKED the drain (its last
 *     beat reported 'draining'/'drained' but the drained report never
 *     landed) or went silent (no beat since arming). If beats kept flowing
 *     with state 'active' — the emitter provably never heard the verdict —
 *     the grace RE-ARMS instead of killing in-flight work. Silence is only
 *     attributed to the EMITTER when the heartbeat FEED provably flowed
 *     across the window (AP-3): the poller reports each fully-successful
 *     poll via noteSuccessfulPoll, and an expiry that observes no such poll
 *     strictly after arming (and recent enough) re-arms instead — a
 *     control-api/poller outage must never make a live emitter look silent.
 *
 * podUid ordering: heartbeats are keyed by (hostRef, podUid). A heartbeat
 * from a podUid that was RETIRED (seen before the current pod) is discarded
 * and logged once — a stale pod that outlives its replacement must never
 * steer the lifecycle. A never-seen podUid while a current pod exists is
 * NOT automatically a newer pod: after an HCC restart a straggler beat of
 * the OLD pod can replay after the new pod's first beat, so adoption is
 * tie-broken on the pods' immutable creationTimestamps (a strictly-older
 * newcomer is itself retired; an unresolvable order keeps the current pod).
 */
import { LIFECYCLE_REASON_SUSPENDED_IDLE, SUSPEND_BLOCKED_REASON_PREFIX } from './constants'
import { EffectiveHostLifecycle, SuspendFromHeartbeatOutcome } from './statelessLifecycle.types'
import { HostCRD } from './types'

export type HeartbeatState = 'active' | 'draining' | 'drained'

/** D8 activity conditions — mirrors mcp-host's heartbeat emitter payload. */
export interface HeartbeatConditions {
  activeTask: boolean
  awaitingApproval: boolean
  pendingResults: boolean
  /**
   * Cron×stateless: the emitter's CronScheduler holds >=1 ENABLED schedule.
   * Additive (schemaVersion stays 1) — absent on older emitters parses as
   * false. Surfaces as `SuspendBlocked: activeCronSchedules`.
   */
  activeCronSchedules: boolean
}

export interface HeartbeatPayload {
  schemaVersion: 1
  hostRef: string
  podUid: string
  activeWork: boolean
  conditions: HeartbeatConditions
  /** Epoch ms of the last inbound runtime message / turn activity. */
  lastActivityTs: number
  state: HeartbeatState
}

export type HeartbeatPayloadParseResult =
  | { ok: true; payload: HeartbeatPayload }
  | { ok: false; error: string }

const HEARTBEAT_STATES: ReadonlySet<string> = new Set(['active', 'draining', 'drained'])

/**
 * Strict shape validation for the heartbeat body. Runs BEFORE any auth
 * crypto so malformed requests are rejected at 400 without paying for a
 * signature verification. Unknown extra fields are tolerated (forward
 * compatibility); every REQUIRED field is type-checked exactly.
 */
export function parseHeartbeatPayload(raw: unknown): HeartbeatPayloadParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = raw as Record<string, unknown>
  if (body.schemaVersion !== 1) {
    return { ok: false, error: 'schemaVersion must be 1' }
  }
  if (typeof body.hostRef !== 'string' || !body.hostRef.trim()) {
    return { ok: false, error: 'hostRef must be a non-empty string' }
  }
  if (typeof body.podUid !== 'string' || !body.podUid.trim()) {
    return { ok: false, error: 'podUid must be a non-empty string' }
  }
  if (typeof body.activeWork !== 'boolean') {
    return { ok: false, error: 'activeWork must be a boolean' }
  }
  const conditions = body.conditions
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) {
    return { ok: false, error: 'conditions must be an object' }
  }
  const cond = conditions as Record<string, unknown>
  for (const key of ['activeTask', 'awaitingApproval', 'pendingResults'] as const) {
    if (typeof cond[key] !== 'boolean') {
      return { ok: false, error: `conditions.${key} must be a boolean` }
    }
  }
  // Cron×stateless (additive, schemaVersion stays 1): older emitters omit the
  // field — absent parses as false so their payloads keep validating.
  // Present-but-wrong-type is still rejected loudly.
  if ('activeCronSchedules' in cond && typeof cond.activeCronSchedules !== 'boolean') {
    return { ok: false, error: 'conditions.activeCronSchedules must be a boolean when present' }
  }
  if (
    typeof body.lastActivityTs !== 'number' ||
    !Number.isFinite(body.lastActivityTs) ||
    body.lastActivityTs < 0
  ) {
    return { ok: false, error: 'lastActivityTs must be a non-negative finite number (epoch ms)' }
  }
  if (typeof body.state !== 'string' || !HEARTBEAT_STATES.has(body.state)) {
    return { ok: false, error: "state must be one of 'active' | 'draining' | 'drained'" }
  }
  return {
    ok: true,
    payload: {
      schemaVersion: 1,
      hostRef: body.hostRef,
      podUid: body.podUid,
      activeWork: body.activeWork,
      conditions: {
        activeTask: cond.activeTask as boolean,
        awaitingApproval: cond.awaitingApproval as boolean,
        pendingResults: cond.pendingResults as boolean,
        activeCronSchedules: cond.activeCronSchedules === true,
      },
      lastActivityTs: body.lastActivityTs,
      state: body.state as HeartbeatState,
    },
  }
}

export type HeartbeatVerdict =
  | { drain: false }
  | {
      drain: true
      /**
       * AP-1 generation epoch: the `wakeHandledGeneration` observed on the
       * tracker's Host snapshot when this drain verdict was DECIDED. The
       * poller threads it into the durable draining write
       * (markHostDrainingFromHeartbeat), whose commit no-ops when the fresh
       * generation has advanced past it — an aged drain:true verdict must
       * never re-fence a pod whose wake was handled after the decision.
       */
      entryWakeHandledGeneration: number
    }

/**
 * Minimal view the HTTP server needs. `ContextMapperServer` depends on this
 * interface, not on the concrete tracker.
 */
export interface HeartbeatLifecycleTracker {
  handleHeartbeat(payload: HeartbeatPayload): Promise<HeartbeatVerdict>
  /**
   * Feed-health seam (AP-3): the heartbeat poller reports every FULLY
   * successful poll cycle (rows fetched, parsed and applied end to end).
   * The ack-aware drain-grace expiry consults it to distinguish emitter
   * silence (no beat while the feed flowed) from feed silence (poller /
   * control-api outage — nothing could have been observed): only the former
   * may force-suspend. Optional so minimal fakes stay valid.
   */
  noteSuccessfulPoll?(pollIntervalMs: number): void
  stop(): void
}

/**
 * Execution seam into HostReconciler: the tracker DECIDES, the reconciler
 * EXECUTES (status subresource writes + full reconcile → replicas
 * derivation). HostReconciler implements this structurally.
 */
export interface StatelessLifecycleReconcilerPort {
  getEffectiveLifecycle(host: HostCRD): EffectiveHostLifecycle
  getWakeRequestedGeneration(host: HostCRD): number
  /**
   * Fresh (non-cache) read of the Host CR from the API server. The tracker
   * uses it to resolve a cached-pending wake verdict against server-side
   * truth (see the wakePending resolution in handleHeartbeat): the informer
   * cache can miss the wake fast-path's status flip, and a stale pending
   * verdict blocks every drain until the periodic resync.
   */
  readFreshHost(host: HostCRD): Promise<HostCRD>
  /**
   * Suspend after a drained report or drain-grace expiry.
   * `entryWakeHandledGeneration` is the `wakeHandledGeneration` observed on
   * the tracker's Host snapshot when the suspend was DECIDED (AP-1 epoch):
   * the executor no-ops the commit when the fresh generation has advanced
   * past it — a wake/cancel-drain was handled after the decision, so the
   * drained evidence is aged. The returned outcome tells the caller whether
   * the commit landed ('suspended'), was an idempotent retry over an
   * already-suspended CR ('already_suspended'), or was refused as stale
   * ('skipped_stale') — in the stale case the tracker answers drain:false
   * so the pod un-fences instead of staying fenced behind aged evidence.
   */
  suspendHostFromHeartbeat(
    host: HostCRD,
    reason: string,
    entryWakeHandledGeneration: number
  ): Promise<SuspendFromHeartbeatOutcome>
  markHostActiveFromHeartbeat(host: HostCRD): Promise<void>
  publishSuspendBlockedReason(host: HostCRD, reason: string): Promise<void>
  findPodCreationTimestamp(host: HostCRD, podUid: string): Promise<Date | null>
}

export interface StatelessLifecycleTrackerOptions {
  /** CONTEXT_MAPPER_STATELESS_IDLE_MINUTES (default 30). */
  idleMinutes: number
  /** CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES (default 15). */
  idleFloorMinutes: number
  /** CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS (default 60000). */
  drainGraceMs: number
  /** CONTEXT_MAPPER_STATELESS_MAX_UPTIME_HOURS (default 72). */
  maxUptimeHours: number
  reconciler: StatelessLifecycleReconcilerPort
  /** Host CRD lookup from the informer cache (McpServerWatcher.getHost). */
  getHost: (hostRef: string) => HostCRD | undefined
  /** Injectable clock for tests (epoch ms). */
  now?: () => number
}

/** Cap on remembered retired podUids per host (FIFO on Set insertion order). */
const MAX_RETIRED_POD_UIDS_PER_HOST = 16

export class StatelessLifecycleTracker implements HeartbeatLifecycleTracker {
  private readonly idleMs: number
  private readonly drainGraceMs: number
  private readonly maxUptimeMs: number
  private readonly reconciler: StatelessLifecycleReconcilerPort
  private readonly getHost: (hostRef: string) => HostCRD | undefined
  private readonly now: () => number

  /** Current (most recently accepted) podUid per host. */
  private readonly currentPodByHost = new Map<string, string>()
  /** Retired podUids per host — heartbeats from these are discarded. */
  private readonly retiredPodUids = new Map<string, Set<string>>()
  /** `${hostRef}/${podUid}` keys whose stale-discard has been logged once. */
  private readonly stalePodLogged = new Set<string>()
  /** Pod creationTimestamp cache (immutable per podUid), key `${hostRef}/${podUid}`. */
  private readonly podCreationTsByUid = new Map<string, number>()
  /** Armed drain-grace timers per host. */
  private readonly drainGrace = new Map<
    string,
    { podUid: string; timer: ReturnType<typeof setTimeout>; armedAtMs: number }
  >()
  /**
   * Last accepted (non-retired) beat per host: emitter-reported state + time,
   * plus the activity signals the ack-aware drain-grace expiry consults.
   * `activeWork`/`lastActivityTs` are recorded (C2) so onDrainGraceExpired can
   * re-arm over LIVE PENDING WORK even when the emitter is still fenced in
   * state:'draining' -- a genuine pending intake keeps activeWork:true while
   * state stays 'draining', which the state==='active' re-arm test alone would
   * miss and suspend over.
   */
  private readonly lastBeatByHost = new Map<
    string,
    {
      podUid: string
      state: HeartbeatState
      atMs: number
      activeWork: boolean
      lastActivityTs: number
    }
  >()
  /** Last handled wake generation observed by this tracker process per host. */
  private readonly lastWakeHandledGenerationByHost = new Map<string, number>()
  /**
   * Wake startup grace per host. A newly handled wake starts a short active
   * window so the first heartbeat from the replacement pod cannot drain only
   * because its persisted lastActivityTs predates the wake.
   */
  private readonly wakeStartupGraceUntilByHost = new Map<string, number>()
  /**
   * Last FULLY successful heartbeat poll reported by the poller (AP-3 feed
   * evidence). Undefined until the first report — the silent-emitter expiry
   * branch treats an unreported feed as NOT demonstrably healthy and re-arms.
   */
  private lastSuccessfulPoll: { atMs: number; intervalMs: number } | undefined

  constructor(options: StatelessLifecycleTrackerOptions) {
    if (!Number.isFinite(options.idleMinutes) || options.idleMinutes <= 0) {
      throw new Error(
        `[StatelessLifecycleTracker] idleMinutes must be a positive number, got '${options.idleMinutes}'`
      )
    }
    if (!Number.isFinite(options.idleFloorMinutes) || options.idleFloorMinutes <= 0) {
      throw new Error(
        `[StatelessLifecycleTracker] idleFloorMinutes must be a positive number, got '${options.idleFloorMinutes}'`
      )
    }
    if (!Number.isFinite(options.drainGraceMs) || options.drainGraceMs <= 0) {
      throw new Error(
        `[StatelessLifecycleTracker] drainGraceMs must be a positive number, got '${options.drainGraceMs}'`
      )
    }
    if (!Number.isFinite(options.maxUptimeHours) || options.maxUptimeHours <= 0) {
      throw new Error(
        `[StatelessLifecycleTracker] maxUptimeHours must be a positive number, got '${options.maxUptimeHours}'`
      )
    }
    // Effective T_idle = max(idle, floor): the floor is a platform guardrail
    // against an operator configuring an aggressively short idle window.
    this.idleMs = Math.max(options.idleMinutes, options.idleFloorMinutes) * 60_000
    this.drainGraceMs = options.drainGraceMs
    this.maxUptimeMs = options.maxUptimeHours * 3_600_000
    this.reconciler = options.reconciler
    this.getHost = options.getHost
    this.now = options.now ?? (() => Date.now())
  }

  /** Clear every armed drain-grace timer (server shutdown). */
  stop(): void {
    for (const entry of this.drainGrace.values()) {
      clearTimeout(entry.timer)
    }
    this.drainGrace.clear()
    this.lastBeatByHost.clear()
    this.lastWakeHandledGenerationByHost.clear()
    this.wakeStartupGraceUntilByHost.clear()
  }

  /**
   * Feed-health seam (see HeartbeatLifecycleTracker.noteSuccessfulPoll):
   * called by the poller after every fully-successful poll cycle. The
   * ack-aware grace expiry only attributes silence to the emitter when a
   * successful poll landed strictly after the grace was armed AND recently
   * enough (within pollIntervalMs × 2 of the expiry moment).
   */
  noteSuccessfulPoll(pollIntervalMs: number): void {
    this.lastSuccessfulPoll = { atMs: this.now(), intervalMs: pollIntervalMs }
  }

  async handleHeartbeat(payload: HeartbeatPayload): Promise<HeartbeatVerdict> {
    const hostRef = payload.hostRef

    // ── podUid ordering ──
    if (this.retiredPodUids.get(hostRef)?.has(payload.podUid)) {
      const logKey = `${hostRef}/${payload.podUid}`
      if (!this.stalePodLogged.has(logKey)) {
        this.stalePodLogged.add(logKey)
        console.warn(
          `[StatelessLifecycleTracker] Discarding heartbeat from stale pod "${payload.podUid}" of host "${hostRef}" (current pod is "${this.currentPodByHost.get(hostRef)}")`
        )
      }
      return { drain: false }
    }
    const currentPodUid = this.currentPodByHost.get(hostRef)
    if (currentPodUid !== undefined && currentPodUid !== payload.podUid) {
      // Never-seen podUid while a current pod exists. 'Never seen' alone is
      // NOT proof of a newer pod: after an HCC restart a straggler beat of
      // the OLD pod can replay AFTER the new pod's first beat — adopting it
      // would retire the LIVE pod and wedge the lifecycle (every live beat
      // discarded until the straggler dies). Tie-break on the pods'
      // immutable creationTimestamps before adopting.
      const ordering = await this.resolvePodOrdering(hostRef, currentPodUid, payload.podUid)
      if (ordering === 'newcomer-stale') {
        // The newcomer is strictly older than the current pod: an
        // out-of-order replay of a pod that was already replaced. Retire the
        // newcomer itself — the current (live) pod keeps steering.
        this.retirePod(hostRef, payload.podUid)
        console.warn(
          `[StatelessLifecycleTracker] Heartbeat from never-seen pod "${payload.podUid}" of host "${hostRef}" is OLDER than the current pod "${currentPodUid}" (out-of-order replay) — retiring the newcomer, keeping the current pod`
        )
        return { drain: false }
      }
      if (ordering === 'unresolved') {
        // Conservative: keep the current pod, retire NOBODY. The next beat
        // (either pod's) retries the ordering with fresh evidence.
        console.warn(
          `[StatelessLifecycleTracker] Could not order never-seen pod "${payload.podUid}" against current pod "${currentPodUid}" of host "${hostRef}" — keeping the current pod, retiring nobody (retried next beat)`
        )
        return { drain: false }
      }
      // 'adopt-newcomer': a genuinely newer pod (first heartbeat after a
      // wake/roll). Retire the previous pod and drop its grace timer +
      // cached age.
      this.retirePod(hostRef, currentPodUid)
      this.clearDrainGrace(hostRef)
      this.lastBeatByHost.delete(hostRef)
      console.log(
        `[StatelessLifecycleTracker] Host "${hostRef}" pod changed: "${currentPodUid}" → "${payload.podUid}"`
      )
    }
    this.currentPodByHost.set(hostRef, payload.podUid)
    // Liveness/ack bookkeeping for the ack-aware drain-grace expiry. Placed
    // AFTER the retired-pod discard + podUid ordering so a stale pod's beat
    // can never masquerade as the current pod's ack or liveness.
    this.lastBeatByHost.set(hostRef, {
      podUid: payload.podUid,
      state: payload.state,
      atMs: this.now(),
      // C2: record the activity signal so the ack-aware grace expiry can
      // re-arm over a fenced-but-pending intake (state:'draining' +
      // activeWork:true), which the state==='active' test alone would not
      // catch. lastActivityTs is kept for future TTL/liveness use.
      activeWork: payload.activeWork,
      lastActivityTs: payload.lastActivityTs,
    })

    // ── host + assessed statelessness (D8 condition 5 lives in assessLifecycle) ──
    const host = this.getHost(hostRef)
    if (!host) {
      console.warn(
        `[StatelessLifecycleTracker] Heartbeat for unknown Host "${hostRef}" — answering drain:false`
      )
      return { drain: false }
    }
    const effective = this.reconciler.getEffectiveLifecycle(host)
    if (!effective.stateless) {
      // Rejected/disabled stateless lifecycle: never drain. The reconciler's
      // StatelessEnableRejected condition already names the reason.
      this.clearDrainGrace(hostRef)
      return { drain: false }
    }
    this.noteWakeHandledGeneration(hostRef, host)

    let wakePending =
      this.reconciler.getWakeRequestedGeneration(host) >
      (host.status?.lifecycle?.wakeHandledGeneration ?? 0)
    if (wakePending) {
      // The informer-cached Host can be STALE right here: the wake
      // fast-path's status flip (wakeHandledGeneration = requested) races
      // the watch stream, and a missed MODIFIED event leaves the cache
      // pending until the periodic Host resync (default 5 min). A pending
      // verdict blocks EVERY drain ("cancel-drain wins"), so a stale cached
      // read starves suspension for the whole staleness window -- measured
      // live 2026-07-05: supra-threshold idle gaps never suspended within
      // 360s after a cold wake. Resolve a cached-pending verdict against a
      // FRESH read -- the same discipline the status writers already follow
      // (suspendHostFromHeartbeatCore / markHostActiveFromHeartbeatCore).
      // A fresh-read failure keeps the conservative pending verdict for
      // THIS beat and retries on the next polled heartbeat (same precedent
      // as isMaxUptimeExceeded leaving the ceiling unapplied on a failed
      // lookup): never drain over a possibly-pending wake.
      try {
        const fresh = await this.reconciler.readFreshHost(host)
        const freshPending =
          this.reconciler.getWakeRequestedGeneration(fresh) >
          (fresh.status?.lifecycle?.wakeHandledGeneration ?? 0)
        if (!freshPending) {
          console.log(
            `[StatelessLifecycleTracker] Cached wakePending for "${hostRef}" was stale -- fresh read shows the wake generation handled; drain gate proceeds`
          )
          wakePending = false
        }
      } catch (err) {
        console.error(
          `[StatelessLifecycleTracker] Fresh wakePending resolution failed for "${hostRef}" -- keeping the conservative pending verdict for this beat:`,
          err
        )
      }
    }

    // ── drained report → suspend ──
    if (payload.state === 'drained') {
      const now = this.now()
      const uptimeExceeded = await this.isMaxUptimeExceeded(host, payload.podUid, now)
      const wakeStartupGraceActive = this.isWakeStartupGraceActive(hostRef, now)
      // Stage 6 (W2): machine-parseable suspend-phase timestamp.
      console.log(`[StatelessSuspend] host=${hostRef} phase=drained_reported ts=${this.now()}`)
      this.clearDrainGrace(hostRef)
      // AP-1 epoch: capture the handled wake generation from THIS handler's
      // entry snapshot. It rides to the suspend writer, whose commit-point
      // guard no-ops when the fresh generation has advanced past it — a
      // wake/cancel-drain handled between this drained report and the commit
      // means the report is aged evidence (the pod was un-fenced and may
      // have served turns after it flushed).
      const entryWakeHandledGeneration = host.status?.lifecycle?.wakeHandledGeneration ?? 0
      // Fresh-activity supersede: re-check idle eligibility against the
      // report's OWN payload (same rule as the main gate) before honoring
      // the drained state. A turn accepted and served after the drain
      // verdict — but before the emitter fenced — refreshed lastActivityTs,
      // so the drain decision was made on evidence that turn invalidated.
      // The drained report itself refreshes nothing: payload.lastActivityTs
      // is the emitter's own account of the last served intake, the same
      // trust level as `activeWork`. Max-uptime drains are exempt — an
      // uptime-exceeded drain must still suspend regardless of activity.
      if (now - payload.lastActivityTs < this.idleMs || wakeStartupGraceActive) {
        if (!uptimeExceeded) {
          console.log(
            `[StatelessSuspend] host=${hostRef} phase=drained_report_superseded reason=fresh_activity ts=${this.now()}`
          )
          // Revert the CR to active so control-api answers drain:false and
          // the emitter un-fences and resumes.
          await this.cancelDrainOnEvidence(hostRef, host)
          const reason = SUSPEND_BLOCKED_REASON_PREFIX + blockingCondition(payload)
          try {
            await this.reconciler.publishSuspendBlockedReason(host, reason)
          } catch (err) {
            console.error(
              `[StatelessLifecycleTracker] Failed to publish suspend-blocked reason for "${hostRef}":`,
              err
            )
          }
          return { drain: false }
        }
      }
      if (wakePending) {
        // Cancel-drain wins even over a drained report: the emitter lifts
        // the fence on drain:false and the wake fast-path keeps replicas=1.
        return { drain: false }
      }
      try {
        const outcome = await this.reconciler.suspendHostFromHeartbeat(
          host,
          LIFECYCLE_REASON_SUSPENDED_IDLE,
          entryWakeHandledGeneration
        )
        if (outcome === 'skipped_stale') {
          // The commit refused the drained evidence as aged/overturned (a
          // wake was handled past the entry epoch, a wake is pending, or the
          // drain was cancelled underneath). Answer drain:false so the pod
          // UN-FENCES and resumes — answering drain:true here would re-fence
          // a just-woken pod on evidence the commit itself rejected, with
          // requested==handled leaving nothing to revive it.
          console.log(
            `[StatelessSuspend] host=${hostRef} phase=drained_suspend_skipped_stale ts=${this.now()}`
          )
          return { drain: false }
        }
      } catch (err) {
        // Loud, not fatal: the emitter keeps reporting 'drained' at the
        // accelerated cadence, so the suspension retries on the next beat.
        console.error(
          `[StatelessLifecycleTracker] Suspend after drained report failed for "${hostRef}":`,
          err
        )
      }
      return { drain: true, entryWakeHandledGeneration }
    }

    // ── D8 idle gate + max-uptime ceiling ──
    const now = this.now()
    const uptimeExceeded = await this.isMaxUptimeExceeded(host, payload.podUid, now)
    const wakeStartupGraceActive = this.isWakeStartupGraceActive(hostRef, now)
    const idleEligible =
      !payload.activeWork && !wakeStartupGraceActive && now - payload.lastActivityTs >= this.idleMs

    if (!idleEligible && !uptimeExceeded) {
      this.clearDrainGrace(hostRef)
      // Real activity evidence cancels an in-flight drain: revert the CR so
      // control-api stops answering {drain:true} and the emitter's fence
      // lifts without requiring the rpc-proxy wake round-trip.
      await this.cancelDrainOnEvidence(hostRef, host)
      const reason = SUSPEND_BLOCKED_REASON_PREFIX + blockingCondition(payload)
      try {
        await this.reconciler.publishSuspendBlockedReason(host, reason)
      } catch (err) {
        console.error(
          `[StatelessLifecycleTracker] Failed to publish suspend-blocked reason for "${hostRef}":`,
          err
        )
      }
      return { drain: false }
    }

    if (wakePending) {
      // Cancel-drain wins: never answer drain:true over a pending wake.
      this.clearDrainGrace(hostRef)
      // A pending wake cancels the drain even before the wake fast-path
      // lands: revert the CR so the fence lifts on the next answered beat.
      await this.cancelDrainOnEvidence(hostRef, host)
      return { drain: false }
    }

    // AP-1 epoch for the durable draining write: the handled wake generation
    // on THIS handler's entry snapshot. The poller threads it into
    // markHostDrainingFromHeartbeat, whose commit no-ops when the fresh
    // generation advanced past it — an aged drain verdict must never
    // re-fence a pod whose wake was handled after this decision.
    const entryWakeHandledGeneration = host.status?.lifecycle?.wakeHandledGeneration ?? 0
    this.armDrainGrace(hostRef, payload.podUid)
    // Stage 6 (W2): machine-parseable suspend-phase timestamp — the moment
    // HCC first answers drain:true to this pod's heartbeat.
    console.log(`[StatelessSuspend] host=${hostRef} phase=drain_answered ts=${this.now()}`)
    return { drain: true, entryWakeHandledGeneration }
  }

  /**
   * Tracker-side cancel-drain (wedged-fence fix): a drain:false verdict
   * backed by HOST evidence (activity or a pending wake) while the CR still
   * says `draining` reverts status.lifecycle.state to `active` through the
   * reconciler seam. Never touches `active` (no-op) or `suspended` (reviving
   * a suspended Host is exclusively the wake fast-path's job). Loud, not
   * fatal on failure — the emitter keeps beating while fenced, so the
   * revert retries on the next polled heartbeat.
   */
  private async cancelDrainOnEvidence(hostRef: string, host: HostCRD): Promise<void> {
    if ((host.status?.lifecycle?.state ?? 'active') !== 'draining') {
      return
    }
    try {
      await this.reconciler.markHostActiveFromHeartbeat(host)
    } catch (err) {
      console.error(`[StatelessLifecycleTracker] Cancel-drain revert failed for "${hostRef}":`, err)
    }
  }

  private retirePod(hostRef: string, podUid: string): void {
    let retired = this.retiredPodUids.get(hostRef)
    if (!retired) {
      retired = new Set()
      this.retiredPodUids.set(hostRef, retired)
    }
    retired.add(podUid)
    if (retired.size > MAX_RETIRED_POD_UIDS_PER_HOST) {
      const oldest = retired.values().next()
      if (!oldest.done) {
        retired.delete(oldest.value)
        this.stalePodLogged.delete(`${hostRef}/${oldest.value}`)
      }
    }
    this.podCreationTsByUid.delete(`${hostRef}/${podUid}`)
  }

  /**
   * FIX 5 (AP-2, pod identity): order a never-seen podUid against the
   * current pod by immutable creationTimestamp before adoption.
   *   - 'adopt-newcomer': the newcomer's creation is newer-or-equal (K8s
   *     creationTimestamp has 1-second granularity, so a genuine same-second
   *     roll must not wedge behind a strict > test), or the current pod no
   *     longer exists in the pod list.
   *   - 'newcomer-stale': the newcomer is strictly older — an out-of-order
   *     replay; the caller retires the newcomer.
   *   - 'unresolved': host unknown, a lookup failed, or the newcomer is not
   *     visible in the pod list while the current pod still exists — keep
   *     the current pod, retire nobody (retried on the next beat).
   */
  private async resolvePodOrdering(
    hostRef: string,
    currentPodUid: string,
    newcomerPodUid: string
  ): Promise<'adopt-newcomer' | 'newcomer-stale' | 'unresolved'> {
    const host = this.getHost(hostRef)
    if (!host) {
      return 'unresolved'
    }
    let newcomerCreated: Date | null
    let currentCreated: Date | null
    try {
      newcomerCreated = await this.reconciler.findPodCreationTimestamp(host, newcomerPodUid)
      currentCreated = await this.reconciler.findPodCreationTimestamp(host, currentPodUid)
    } catch (err) {
      console.error(
        `[StatelessLifecycleTracker] Pod ordering lookup failed for host "${hostRef}" (current "${currentPodUid}", newcomer "${newcomerPodUid}") — keeping the current pod:`,
        err
      )
      return 'unresolved'
    }
    if (currentCreated === null) {
      // The current pod no longer exists — the newcomer is the live pod.
      return 'adopt-newcomer'
    }
    if (newcomerCreated === null) {
      // Never adopt a pod we cannot even see over a still-existing current
      // pod.
      return 'unresolved'
    }
    const newcomerMs = newcomerCreated.getTime()
    // Cache the newcomer's immutable creation time for the max-uptime
    // ceiling (same key shape as isMaxUptimeExceeded).
    this.podCreationTsByUid.set(`${host.name}/${newcomerPodUid}`, newcomerMs)
    return newcomerMs >= currentCreated.getTime() ? 'adopt-newcomer' : 'newcomer-stale'
  }

  /**
   * Max-uptime ceiling from the pod's creationTimestamp. The timestamp is
   * immutable, so it is resolved ONCE per (hostRef, podUid) via the
   * reconciler's pod list and cached. A failed or empty lookup logs loudly
   * and leaves the ceiling UNAPPLIED for this beat (retried next beat) —
   * an API blip must not force-drain an active host.
   */
  private async isMaxUptimeExceeded(host: HostCRD, podUid: string, now: number): Promise<boolean> {
    const cacheKey = `${host.name}/${podUid}`
    let createdMs = this.podCreationTsByUid.get(cacheKey)
    if (createdMs === undefined) {
      let created: Date | null
      try {
        created = await this.reconciler.findPodCreationTimestamp(host, podUid)
      } catch (err) {
        console.error(
          `[StatelessLifecycleTracker] Pod age lookup failed for host "${host.name}" pod "${podUid}" — max-uptime ceiling not applied this beat:`,
          err
        )
        return false
      }
      if (created === null) {
        console.warn(
          `[StatelessLifecycleTracker] Pod "${podUid}" of host "${host.name}" not found in the pod list — max-uptime ceiling not applied this beat`
        )
        return false
      }
      createdMs = created.getTime()
      this.podCreationTsByUid.set(cacheKey, createdMs)
    }
    return now - createdMs >= this.maxUptimeMs
  }

  /**
   * Arm the drain-grace timer on the FIRST drain:true answer for this pod.
   * If the pod never reports 'drained' within the grace window, the tracker
   * suspends anyway (the emitter may be wedged; the reconciler's
   * drained-pre-scale wake guard remains the last line of defense).
   */
  private armDrainGrace(hostRef: string, podUid: string): void {
    const existing = this.drainGrace.get(hostRef)
    if (existing) {
      if (existing.podUid === podUid) {
        return // grace runs from the first drain answer — do not extend
      }
      clearTimeout(existing.timer)
    }
    const timer = setTimeout(() => {
      void this.onDrainGraceExpired(hostRef, podUid)
    }, this.drainGraceMs)
    ;(timer as { unref?: () => void }).unref?.()
    this.drainGrace.set(hostRef, { podUid, timer, armedAtMs: this.now() })
  }

  private clearDrainGrace(hostRef: string): void {
    const entry = this.drainGrace.get(hostRef)
    if (entry) {
      clearTimeout(entry.timer)
      this.drainGrace.delete(hostRef)
    }
  }

  private noteWakeHandledGeneration(hostRef: string, host: HostCRD): void {
    const handled = host.status?.lifecycle?.wakeHandledGeneration ?? 0
    const prior = this.lastWakeHandledGenerationByHost.get(hostRef)
    this.lastWakeHandledGenerationByHost.set(hostRef, handled)
    if (prior === undefined || handled <= prior) {
      return
    }
    const graceUntil = this.now() + this.idleMs
    this.wakeStartupGraceUntilByHost.set(hostRef, graceUntil)
    console.log(
      `[StatelessLifecycleTracker] Host "${hostRef}" wake generation advanced ${prior} -> ${handled}; suppressing idle drain until ${new Date(graceUntil).toISOString()}`
    )
  }

  private isWakeStartupGraceActive(hostRef: string, now: number): boolean {
    const graceUntil = this.wakeStartupGraceUntilByHost.get(hostRef)
    if (graceUntil === undefined) {
      return false
    }
    if (now < graceUntil) {
      return true
    }
    this.wakeStartupGraceUntilByHost.delete(hostRef)
    return false
  }

  private async onDrainGraceExpired(hostRef: string, podUid: string): Promise<void> {
    const entry = this.drainGrace.get(hostRef)
    if (!entry || entry.podUid !== podUid) {
      return
    }
    this.drainGrace.delete(hostRef)
    if (this.currentPodByHost.get(hostRef) !== podUid) {
      return // pod rolled while the grace was pending
    }
    const host = this.getHost(hostRef)
    if (!host) {
      console.warn(
        `[StatelessLifecycleTracker] Drain grace expired for unknown Host "${hostRef}" — skipping suspension`
      )
      return
    }
    if (!this.reconciler.getEffectiveLifecycle(host).stateless) {
      return
    }
    // KZ-R1: the informer-cached Host can be STALE here exactly as it is on the
    // heartbeat path -- the wake fast-path's status flip
    // (wakeHandledGeneration set to requested) races the watch stream, and a
    // missed MODIFIED event leaves the cache pending until the periodic resync.
    // The heartbeat path (handleHeartbeat) was already hardened to resolve a
    // cached-pending verdict against a FRESH read; the grace-expiry path was
    // left cache-only, so a stale cached NOT-pending read could suspend a host
    // whose wake already landed. Apply the same discipline: read the cached
    // verdict, and if it is pending trust it, but if it is NOT pending confirm
    // against a fresh read before suspending. Fail-conservative: on a fresh-read
    // error, skip the suspend this cycle and let the next beat/grace decide --
    // never suspend over a possibly-pending wake (mirrors handleHeartbeat).
    // AP-1 epoch (see suspendHostFromHeartbeat): the handled wake generation
    // from this expiry's entry snapshot — the suspend commit no-ops when a
    // wake was handled after this point.
    const entryWakeHandledGeneration = host.status?.lifecycle?.wakeHandledGeneration ?? 0
    let wakePending = this.reconciler.getWakeRequestedGeneration(host) > entryWakeHandledGeneration
    if (!wakePending) {
      try {
        const fresh = await this.reconciler.readFreshHost(host)
        wakePending =
          this.reconciler.getWakeRequestedGeneration(fresh) >
          (fresh.status?.lifecycle?.wakeHandledGeneration ?? 0)
        if (wakePending) {
          console.log(
            `[StatelessLifecycleTracker] Cached not-pending for "${hostRef}" was stale -- fresh read shows a wake pending; grace-expiry suspension cancelled`
          )
        }
      } catch (err) {
        console.error(
          `[StatelessLifecycleTracker] Fresh wakePending resolution failed for "${hostRef}" at grace expiry -- skipping suspension for this cycle:`,
          err
        )
        return
      }
    }
    if (wakePending) {
      console.log(
        `[StatelessLifecycleTracker] Drain grace expired for "${hostRef}" but a wake is pending — suspension cancelled`
      )
      return
    }
    // FIX 3 (AP-2, pod identity): re-validate decision ownership AFTER the
    // awaits above. The entry checks (grace entry, currentPodByHost) ran
    // synchronously BEFORE the fresh read; a pod replacement or a re-arm/
    // clear landing DURING the await would otherwise let this expiry
    // force-suspend over the live replacement pod (whose lastBeat bookkeeping
    // was reset, making it look "silent"). If the current pod changed, or a
    // NEW grace was armed for this host since this expiry deleted its own
    // entry, this callback's evidence is aged — the new pod's beats / the
    // new arming own the decision now.
    if (this.currentPodByHost.get(hostRef) !== podUid || this.drainGrace.has(hostRef)) {
      console.warn(
        `[StatelessLifecycleTracker] Drain-grace expiry for "${hostRef}" aborted after the fresh read — pod identity or grace arming changed underneath (expiry pod "${podUid}", current pod "${this.currentPodByHost.get(hostRef)}")`
      )
      return
    }
    // ── ack-aware expiry ──
    // Distinguish "emitter acked the drain but the drained report never
    // landed" (legitimate force-suspend) from two re-arm cases (suspending
    // would kill live work; the emitter's beat cadence is NOT controllable by
    // HCC and may exceed the configured grace):
    //   (a) the emitter never even heard the drain while its beats keep
    //       flowing (last beat still reports state==='active'); or
    //   (b) C2: a genuine PENDING intake is fenced — the emitter reports
    //       state:'draining' (it DID ack) but the beat still carries
    //       activeWork:true. The `state==='active'` test alone misses this and
    //       would suspend over live pending work. A fresh activeWork:true from
    //       the same pod after arming is therefore an EQUAL re-arm trigger.
    //
    // pendingIntake note (C2-devops, KNOWN RESIDUAL — do NOT implement here):
    // activeWork:true is the emitter's projection of a fenced pending intake.
    // If the rpc-proxy->control-api wake for that intake NEVER lands, the
    // emitter keeps beating draining+activeWork:true forever, so this re-arm
    // loops indefinitely and the host never suspends OR un-drains. The durable
    // fix is a bounded TTL on the pending-intake wake (or a tracker-side wake
    // re-attempt) — Phase 2, out of scope here. Documented so it is
    // discoverable at the site that consults the pending-intake signal.
    const last = this.lastBeatByHost.get(hostRef)
    const beatIsFreshForThisPod =
      last !== undefined && last.podUid === podUid && last.atMs >= entry.armedAtMs
    const emitterStillActive = beatIsFreshForThisPod && last.state === 'active'
    const pendingWorkFenced = beatIsFreshForThisPod && last.activeWork === true
    if (emitterStillActive || pendingWorkFenced) {
      // Re-arm a fresh full grace window instead of suspending. No cap on
      // re-arms is needed BY DESIGN for case (a): each subsequent beat is
      // answered from the CR (`draining` → drain:true), so a live emitter
      // converges to acking within one beat interval; if instead its beats
      // carry activity evidence the tracker cancels the drain — either way
      // re-arming cannot loop forever with a live, idle emitter. Case (b)
      // (activeWork:true) carries the C2-devops residual noted above.
      const reason = emitterStillActive ? 'drain_not_acked' : 'pending_work'
      console.log(
        `[StatelessSuspend] host=${hostRef} phase=grace_rearmed reason=${reason} ts=${this.now()}`
      )
      this.armDrainGrace(hostRef, podUid)
      return
    }
    // FIX 4 (AP-3): 'no beat since arming' is read from lastBeatByHost,
    // which only successful polls feed — a control-api/poller outage
    // spanning the grace makes a LIVE active emitter look silent. Silence is
    // evidence against the EMITTER only when the feed was demonstrably
    // healthy across the window: at least one fully-successful poll landed
    // strictly after this grace was armed AND recently enough (within
    // poll-interval × 2 of now). Otherwise the silence is unattributable —
    // re-arm and let the recovered feed decide on real beats.
    const emitterSilent = !beatIsFreshForThisPod
    if (emitterSilent) {
      const poll = this.lastSuccessfulPoll
      const feedHealthy =
        poll !== undefined &&
        poll.atMs > entry.armedAtMs &&
        this.now() - poll.atMs <= poll.intervalMs * 2
      if (!feedHealthy) {
        console.log(
          `[StatelessSuspend] host=${hostRef} phase=grace_rearmed reason=feed_outage ts=${this.now()}`
        )
        this.armDrainGrace(hostRef, podUid)
        return
      }
    }
    // Suspend cases: emitter silent with a provably-healthy feed (pod dead
    // or wedged; nothing live to kill), or the last beat reported
    // 'draining'/'drained' (acked, but the drained report never landed).
    console.warn(
      `[StatelessLifecycleTracker] Drain grace (${this.drainGraceMs}ms) expired for "${hostRef}" without a drained report — suspending`
    )
    try {
      await this.reconciler.suspendHostFromHeartbeat(
        host,
        LIFECYCLE_REASON_SUSPENDED_IDLE,
        entryWakeHandledGeneration
      )
    } catch (err) {
      console.error(
        `[StatelessLifecycleTracker] Grace-expiry suspension failed for "${hostRef}":`,
        err
      )
    }
  }
}

/** Name the D8 condition blocking suspension (priority-ordered). */
function blockingCondition(payload: HeartbeatPayload): string {
  if (payload.conditions.awaitingApproval) return 'awaitingApproval'
  if (payload.conditions.activeTask) return 'activeTask'
  if (payload.conditions.pendingResults) return 'pendingResults'
  if (payload.conditions.activeCronSchedules) return 'activeCronSchedules'
  if (payload.activeWork) return 'activeWork'
  return 'recentActivity'
}
