import type { Response as ExpressResponse } from 'express'
import { config } from '../config.js'
import type { ResolvedServerConnection, RpcAccessClaims } from '../types.js'
import { type HostWakeApiResponse, requestHostWakeFromControlApi } from './controlApiRestService.js'
import { forwardHostHealth } from './mcpHostRestService.js'

/**
 * Stateless wake-and-hold (Stage 5, Issue #791 §11).
 *
 * When a request targets a stateless Host whose pod is suspended (network
 * failure) or draining (upstream 503 {code:'host_draining'}), rpc-proxy calls
 * the control-api wake endpoint and — for a 202 — parks the request while the
 * pod comes up, instead of surfacing the generic 502.
 *
 * Coordination is keyed by PRINCIPAL + Host (§11.1), not by Host alone. Only a
 * same-principal wake-capable authorization (unexpired, carrying
 * `host:wake:write` AND the target hostRef) may occupy or replace the wake
 * slot. A non-wake token can ride an existing wake but can never trigger one
 * nor displace the wake authorization, and different principals never share a
 * group — so a non-wake or foreign token can no longer displace the only
 * wake-capable authorization and drive an unauthorized 403 that collapses
 * every waiter on the Host.
 *
 * Fleet note: rpc-proxy runs with replicas:2, so the in-memory dedup map here
 * is per-instance best effort. The fleet-level authority for wake dedup and
 * rate limiting is control-api (Postgres-backed generation + token bucket).
 */

const TOKEN_EXP_SAFETY_MARGIN_MS = 2_000
const ENTRY_TTL_MARGIN_MS = 5_000
/**
 * Capacity of the coordination map, counted in COORDINATIONS, not hosts. The
 * map is keyed by `wakeCoordinationKey(claims, hostRef)` = principal × Host, so
 * N distinct principals waking ONE Host consume N slots: a fleet of H hosts
 * with P concurrently-holding principals per host consumes up to H×P slots
 * (review F2). Named for what it bounds — a "hosts" name would understate the
 * real limit by a factor of P. Oldest-first eviction settles the victim
 * retryable (503 host_waking), so overflow degrades politely.
 */
const MAX_TRACKED_WAKE_COORDINATIONS = 1_000
const WAKE_SCOPE = 'host:wake:write' as const
/** Short upstream retry schedule after a wake reports the host is up. */
const PROCEED_RETRY_DELAYS_MS = [0, 250, 1_000]

export type WakeHoldOutcome =
  /** Host is (or just became) reachable — re-issue the upstream request now. */
  | { kind: 'proceed'; lastKnownState: string }
  /** Host is not stateless / wake plane failed / not wake-capable — keep today's error behavior. */
  | { kind: 'legacy'; reason: string }
  /** Host CR is gone — 404 to the caller. */
  | { kind: 'not-found' }
  /** Still waking (or hold aborted) — structured retryable to the caller. */
  | { kind: 'waking'; retryAfterMs: number; reason: string; lastKnownState: string }

type Waiter = {
  id: number
  resolve: (outcome: WakeHoldOutcome) => void
  timer: NodeJS.Timeout
  /** Per-waiter one-shot latch: the deadline timer and a group settle can race. */
  settled: boolean
}

/**
 * The single same-principal wake-capable authorization used to drive the wake
 * plane. Only replaced by a later-expiry same-principal wake-capable token;
 * never by a non-wake token.
 */
type WakeAuthorization = {
  token: string
  tokenExpMs: number
}

type HostWakeEntry = {
  /** Principal+Host coordination key (never logged — see §11.1). */
  key: string
  /** Sanitized logical Host reference — the only identity allowed in logs. */
  hostRef: string
  createdAt: number
  /** Last state reported by the wake endpoint — surfaced as diagnostics. */
  lastKnownState: string
  waiters: Map<number, Waiter>
  /** Same-principal wake-capable authorization used for the wake plane. */
  wakeAuthorization: WakeAuthorization
  /** Current resolved Host connection used by the readiness probe. */
  connection: ResolvedServerConnection
  pollTimer: NodeJS.Timeout | null
  retriggerTimer: NodeJS.Timeout | null
  ttlTimer: NodeJS.Timeout | null
  settled: boolean
}

export type WakeCoordinatorDeps = {
  requestWake: (hostRef: string, rpcAccessToken: string) => Promise<HostWakeApiResponse>
  probeReady: (host: ResolvedServerConnection) => Promise<boolean>
  maxHoldMs: number
  pollMs: number
  retriggerMs: number
  /**
   * Capacity in (principal, host) coordination entries — NOT in distinct hosts.
   * See MAX_TRACKED_WAKE_COORDINATIONS.
   */
  maxTrackedCoordinations: number
  now?: () => number
}

export type WakeHoldParams = {
  hostRef: string
  host: ResolvedServerConnection
  /** Parsed claims of the caller — used for principal keying + wake capability. */
  claims: RpcAccessClaims
  /** Raw bearer forwarded to the wake plane when this caller is wake-capable. */
  rpcAccessToken: string
}

/**
 * Stable in-memory coordination key from existing claims + hostRef (§11.1):
 * `{ typ, sub, accessScope, teamId ?? '', hostRef }`. Excludes jti/exp/role/
 * scopes (they rotate per token and would fragment one principal), and never
 * contains bearer material.
 */
export function wakeCoordinationKey(claims: RpcAccessClaims, hostRef: string): string {
  // Delimiter-safe encoding (adversarial review F4): sub/teamId are
  // server-assigned UUIDs today, but principal isolation must not silently
  // depend on ID format — JSON framing makes boundary-shifting collisions
  // impossible regardless of future identifier shapes.
  return JSON.stringify([claims.typ, claims.sub, claims.accessScope, claims.teamId ?? '', hostRef])
}

/**
 * "Wake-capable" (§11.2) = unexpired claims that contain `host:wake:write` AND
 * the target hostRef in `hostRefs`. Expiry uses the same safety margin as the
 * hold budget so a token that cannot survive the wake call is not treated as
 * usable for it.
 */
function isWakeCapable(claims: RpcAccessClaims, hostRef: string, now: number): boolean {
  const tokenExpMs = claims.exp * 1000
  if (tokenExpMs - TOKEN_EXP_SAFETY_MARGIN_MS <= now) return false
  if (!claims.scopes.includes(WAKE_SCOPE)) return false
  if (!claims.hostRefs.includes(hostRef)) return false
  return true
}

export class WakeAndHoldCoordinator {
  private readonly entries = new Map<string, HostWakeEntry>()
  private waiterSeq = 0
  /** Set once by drain(); permanently fences new holds during shutdown. */
  private draining = false

  constructor(private readonly deps: WakeCoordinatorDeps) {}

  /**
   * Live (principal, host) coordination entries — NOT a count of distinct
   * hosts. Exposed for tests and observability.
   */
  trackedCoordinationCount(): number {
    return this.entries.size
  }

  async hold(params: WakeHoldParams): Promise<WakeHoldOutcome> {
    if (this.draining) {
      // Shutdown fence (review F1): drain() already settled the map; a hold
      // arriving from an in-flight request after SIGTERM must not park past
      // server.close(). The client retries against a live replica.
      return {
        kind: 'waking',
        retryAfterMs: this.deps.pollMs,
        reason: 'shutting-down',
        lastKnownState: 'unknown',
      }
    }
    const now = this.now()
    const tokenExpMs = params.claims.exp * 1000
    const tokenBudgetMs = tokenExpMs - TOKEN_EXP_SAFETY_MARGIN_MS - now
    if (tokenBudgetMs <= 0) {
      // Never park a request that could only be forwarded with an expired
      // token. The client re-issues with a fresh token and retries.
      return {
        kind: 'waking',
        retryAfterMs: this.deps.pollMs,
        reason: 'token-expiring',
        lastKnownState: 'unknown',
      }
    }
    const holdBudgetMs = Math.min(this.deps.maxHoldMs, tokenBudgetMs)
    const deadlineReason =
      holdBudgetMs < this.deps.maxHoldMs ? 'token-expiring' : 'max-hold-exceeded'

    const key = wakeCoordinationKey(params.claims, params.hostRef)
    const wakeCapable = isWakeCapable(params.claims, params.hostRef, now)

    let entry = this.entries.get(key)
    if (!entry) {
      if (!wakeCapable) {
        // No wake-capable authorization exists for this principal+Host, so
        // calling the wake plane would only earn a deterministic 403. Return
        // today's pre-wake availability result instead (§11.2, §13.4). No
        // fallback grant is minted.
        return { kind: 'legacy', reason: 'no-wake-authorization' }
      }
      entry = this.createEntry(key, params, tokenExpMs)
    } else if (wakeCapable) {
      if (tokenExpMs > entry.wakeAuthorization.tokenExpMs) {
        // Same principal, wake-capable, later valid expiry → replace the wake
        // authorization and the connection the probe uses.
        entry.wakeAuthorization = { token: params.rpcAccessToken, tokenExpMs }
        entry.connection = params.host
      }
      // Same principal, wake-capable, earlier/equal expiry → retain current.
    } else if (entry.wakeAuthorization.tokenExpMs - TOKEN_EXP_SAFETY_MARGIN_MS <= now) {
      // Not wake-capable and the group's wake authorization has itself expired:
      // there is no valid authorization to ride, so no wake is possible.
      return { kind: 'legacy', reason: 'wake-authorization-expired' }
    }
    // Otherwise (not wake-capable, valid wake authorization present) the caller
    // rides the existing wake as a waiter only — never replacing the auth.

    const activeEntry = entry
    return await new Promise<WakeHoldOutcome>(resolve => {
      const id = ++this.waiterSeq
      const waiter: Waiter = {
        id,
        resolve,
        timer: null as unknown as NodeJS.Timeout,
        settled: false,
      }
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        activeEntry.waiters.delete(id)
        resolve({
          kind: 'waking',
          retryAfterMs: this.deps.pollMs,
          reason: deadlineReason,
          lastKnownState: activeEntry.lastKnownState,
        })
        this.releaseIfEmpty(activeEntry)
      }, holdBudgetMs)
      activeEntry.waiters.set(id, waiter)
    })
  }

  /**
   * Deterministically settles every parked waiter AND permanently fences new
   * holds (terminal `waking`/`shutting-down`) — used by the service's graceful
   * shutdown path so no held request hangs across `server.close()`.
   */
  drain(reason = 'shutdown-drain'): void {
    this.draining = true
    for (const entry of [...this.entries.values()]) {
      this.settle(entry, {
        kind: 'waking',
        retryAfterMs: this.deps.pollMs,
        reason,
        lastKnownState: entry.lastKnownState,
      })
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private createEntry(key: string, params: WakeHoldParams, tokenExpMs: number): HostWakeEntry {
    this.enforceCapacity()
    const entry: HostWakeEntry = {
      key,
      hostRef: params.hostRef,
      createdAt: this.now(),
      lastKnownState: 'unknown',
      waiters: new Map(),
      wakeAuthorization: { token: params.rpcAccessToken, tokenExpMs },
      connection: params.host,
      pollTimer: null,
      retriggerTimer: null,
      ttlTimer: null,
      settled: false,
    }
    this.entries.set(key, entry)
    // Safety net: even if a waiter bookkeeping bug ever left the entry behind,
    // it self-destructs loudly instead of leaking timers forever.
    entry.ttlTimer = setTimeout(() => {
      console.warn(
        `[RPC_PROXY] wake-hold entry TTL exceeded (principal-scoped entry) host=${entry.hostRef} waiters=${entry.waiters.size} — evicting`
      )
      this.settle(entry, {
        kind: 'waking',
        retryAfterMs: this.deps.pollMs,
        reason: 'entry-ttl-exceeded',
        lastKnownState: entry.lastKnownState,
      })
    }, this.deps.maxHoldMs + ENTRY_TTL_MARGIN_MS)
    void this.issueWake(entry, { initial: true })
    return entry
  }

  private enforceCapacity(): void {
    if (this.entries.size < this.deps.maxTrackedCoordinations) return
    let oldest: HostWakeEntry | null = null
    for (const candidate of this.entries.values()) {
      if (!oldest || candidate.createdAt < oldest.createdAt) oldest = candidate
    }
    if (!oldest) return
    console.warn(
      `[RPC_PROXY] wake-hold capacity exceeded (max=${this.deps.maxTrackedCoordinations} principal-scoped entries) — evicting oldest entry host=${oldest.hostRef} waiters=${oldest.waiters.size}`
    )
    this.settle(oldest, {
      kind: 'waking',
      retryAfterMs: this.deps.pollMs,
      reason: 'capacity-evicted',
      lastKnownState: oldest.lastKnownState,
    })
  }

  private async issueWake(entry: HostWakeEntry, options: { initial: boolean }): Promise<void> {
    let response: HostWakeApiResponse
    try {
      response = await this.deps.requestWake(entry.hostRef, entry.wakeAuthorization.token)
    } catch (error) {
      console.warn(
        `[RPC_PROXY] wake call failed host=${entry.hostRef} initial=${options.initial} error=${
          error instanceof Error ? error.message : String(error)
        }`
      )
      if (options.initial) {
        // No wake was recorded anywhere — surface today's error path rather
        // than holding a request nothing is going to release.
        this.settle(entry, { kind: 'legacy', reason: 'wake-endpoint-unreachable' })
      }
      // Retrigger failures keep holding: the next retrigger tick tries again,
      // bounded by the per-waiter deadlines and the entry TTL.
      return
    }
    if (entry.settled) {
      console.debug(
        `[RPC_PROXY] late wake-hold artifact ignored (already resolved) host=${entry.hostRef} artifact=wake-response kind=${response.kind}`
      )
      return
    }
    switch (response.kind) {
      case 'active':
        entry.lastKnownState = 'active'
        this.settle(entry, { kind: 'proceed', lastKnownState: 'active' })
        return
      case 'wake-requested':
        entry.lastKnownState = 'wake-requested'
        if (options.initial) this.startHoldLoops(entry)
        return
      case 'not-stateless':
        // Kill-switch (possibly flipped mid-hold): behave exactly like today.
        this.settle(entry, { kind: 'legacy', reason: 'not-stateless' })
        return
      case 'unknown':
        this.settle(entry, { kind: 'not-found' })
        return
      case 'rate-limited':
        if (options.initial) {
          this.settle(entry, {
            kind: 'waking',
            retryAfterMs: Math.ceil(response.retryAfterSeconds * 1000),
            reason: 'wake-rate-limited',
            lastKnownState: entry.lastKnownState,
          })
        }
        // A rate-limited retrigger usually means the wake intent is already
        // recorded fleet-wide, but the bucket may also have been consumed by
        // concurrent callers (prewarm bursts, other holds). Either way the
        // next retrigger tick retries, so keep holding for readiness.
        return
      case 'auth':
        // The wake plane rejected the wake-capable authorization. Distinguish
        // initial from retrigger deliberately (§11.2): an INITIAL rejection is
        // terminal for this principal group, but a mid-hold RETRIGGER rejection
        // (token rotated/revoked after the wake was already recorded) must NOT
        // collapse the still-valid waiters — keep holding, bounded by the
        // per-waiter deadlines and the entry TTL. Because coordination is
        // principal-scoped, this only ever affects this principal's group.
        console.warn(
          `[RPC_PROXY] wake call rejected host=${entry.hostRef} status=${response.status} initial=${options.initial}`
        )
        if (options.initial) {
          this.settle(entry, { kind: 'legacy', reason: `wake-auth-${response.status}` })
        }
        return
    }
  }

  private startHoldLoops(entry: HostWakeEntry): void {
    const schedulePoll = () => {
      entry.pollTimer = setTimeout(async () => {
        let ready = false
        try {
          ready = await this.deps.probeReady(entry.connection)
        } catch (error) {
          // A failed probe is "not ready yet" — the hold stays bounded by the
          // per-waiter deadlines, so a broken probe source cannot hang callers.
          console.warn(
            `[RPC_PROXY] wake-hold readiness probe failed host=${entry.hostRef} error=${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
        if (entry.settled) {
          console.debug(
            `[RPC_PROXY] late wake-hold artifact ignored (already resolved) host=${entry.hostRef} artifact=readiness-probe`
          )
          return
        }
        if (ready) {
          this.settle(entry, { kind: 'proceed', lastKnownState: entry.lastKnownState })
          return
        }
        schedulePoll()
      }, this.deps.pollMs)
    }
    const scheduleRetrigger = () => {
      entry.retriggerTimer = setTimeout(async () => {
        // Hygiene: a retrigger whose wake authorization has already expired is
        // doomed — control-api would reject it — so skip the call rather than
        // spend it. We deliberately KEEP HOLDING: the readiness poll runs on its
        // own timer and the entry still has TTL left, so a host that wakes via
        // any other path still resolves this waiter. Rescheduling matters
        // because a later waiter can adopt this entry and upgrade
        // `wakeAuthorization` to a longer-lived token, after which retriggers
        // resume. Same predicate as the adopt path above.
        if (entry.wakeAuthorization.tokenExpMs - TOKEN_EXP_SAFETY_MARGIN_MS <= this.now()) {
          console.debug(
            `[RPC_PROXY] wake retrigger skipped (wake authorization expired) host=${entry.hostRef}`
          )
          if (!entry.settled) scheduleRetrigger()
          return
        }
        await this.issueWake(entry, { initial: false })
        if (entry.settled) {
          console.debug(
            `[RPC_PROXY] late wake-hold artifact ignored (already resolved) host=${entry.hostRef} artifact=retrigger`
          )
          return
        }
        scheduleRetrigger()
      }, this.deps.retriggerMs)
    }
    schedulePoll()
    scheduleRetrigger()
  }

  private clearEntryTimers(entry: HostWakeEntry): void {
    if (entry.pollTimer) clearTimeout(entry.pollTimer)
    if (entry.retriggerTimer) clearTimeout(entry.retriggerTimer)
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer)
    entry.pollTimer = null
    entry.retriggerTimer = null
    entry.ttlTimer = null
  }

  private settle(entry: HostWakeEntry, outcome: WakeHoldOutcome): void {
    if (entry.settled) {
      console.debug(
        `[RPC_PROXY] late wake-hold artifact ignored (already resolved) host=${entry.hostRef} artifact=settle outcome=${outcome.kind}`
      )
      return
    }
    entry.settled = true
    this.clearEntryTimers(entry)
    this.entries.delete(entry.key)
    for (const waiter of entry.waiters.values()) {
      if (waiter.settled) continue
      waiter.settled = true
      clearTimeout(waiter.timer)
      waiter.resolve(outcome)
    }
    entry.waiters.clear()
  }

  private releaseIfEmpty(entry: HostWakeEntry): void {
    if (entry.settled || entry.waiters.size > 0) return
    entry.settled = true
    this.clearEntryTimers(entry)
    this.entries.delete(entry.key)
  }
}

/**
 * True for an upstream 503 carrying mcp-host's DRAINING fence
 * ({code:'host_draining'}). Matched structurally (name + status) instead of
 * `instanceof` so mocked UpstreamHostError classes in sibling tests behave
 * identically to the real one.
 */
export function isHostDrainingError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'UpstreamHostError') return false
  const upstream = error as Error & { status?: unknown; bodySnippet?: unknown }
  return upstream.status === 503 && String(upstream.bodySnippet || '').includes('host_draining')
}

/** Fetch uses AbortError for controller aborts and TimeoutError for
 * AbortSignal.timeout(). Both represent the same sanitized 504 boundary. */
export function isUpstreamTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * True for a network-level fetch failure against the upstream host (no HTTP
 * response at all — suspended pod, no endpoints). Excludes AbortError (today's
 * 504 path) and UpstreamHostError (the host answered).
 */
export function isHostDownNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (isUpstreamTimeoutError(error) || error.name === 'UpstreamHostError') return false
  const cause = (error as Error & { cause?: { code?: unknown } }).cause
  const details = `${error.message} ${String(cause?.code || '')}`.toLowerCase()
  return (
    details.includes('fetch failed') ||
    /econnrefused|econnreset|enotfound|ehostunreach|epipe|socket hang up|und_err/.test(details)
  )
}

export function isWakeEligibleHostError(error: unknown): boolean {
  return isHostDownNetworkError(error) || isHostDrainingError(error)
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function respondHostWaking(
  res: ExpressResponse,
  details: { hostRef: string; retryAfterMs: number; lastKnownState: string }
): void {
  if (res.headersSent) return
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(details.retryAfterMs / 1000))))
  res.status(503).json({
    code: 'host_waking',
    hostRef: details.hostRef,
    retryAfterMs: details.retryAfterMs,
    message: 'Host is waking up',
    lastKnownState: details.lastKnownState,
  })
}

/**
 * Readiness probe (§11.3): mcp-host's UNAUTHENTICATED `/v1/runtime/health`.
 * It comes up before MCP background init and is the same signal the Pod
 * readiness probe uses. `forwardHostHealth` throws on non-2xx / network
 * failure, so a resolved value means the pod is answering runtime traffic —
 * the retried operation still enforces its own authorization/business
 * contract. Bounded by `config.upstreamTimeoutMs` (AbortController inside the
 * REST helper); on shutdown `drain()` stops the poll loop and any late result
 * is ignored via the entry `settled` latch.
 *
 * Rollout-skew note (review F5): an old mcp-host image without
 * `/v1/runtime/health` makes this probe return false until the hold deadline;
 * holds still settle because the retrigger wake's `active` response — derived
 * by control-api from replica/endpoint state, not from this endpoint — settles
 * `proceed`. Readiness latency degrades from ~pollMs to ~retriggerMs in that
 * skew window.
 */
export async function probeHostReadyViaHealth(host: ResolvedServerConnection): Promise<boolean> {
  try {
    await forwardHostHealth(host)
    return true
  } catch {
    // Unreachable/erroring health endpoint == not ready yet. Bounded by the
    // hold deadline — never a silent success.
    return false
  }
}

/** Singleton wired to production dependencies. Tests construct their own. */
export const hostWakeCoordinator = new WakeAndHoldCoordinator({
  requestWake: requestHostWakeFromControlApi,
  probeReady: probeHostReadyViaHealth,
  maxHoldMs: config.wakeMaxHoldMs,
  pollMs: config.wakePollMs,
  retriggerMs: config.wakeRetriggerMs,
  maxTrackedCoordinations: MAX_TRACKED_WAKE_COORDINATIONS,
})

export type RespondWithWakeAndHoldOptions = {
  res: ExpressResponse
  hostRef: string
  host: ResolvedServerConnection
  /** Parsed claims of the caller — principal keying + wake capability (§11.1). */
  claims: RpcAccessClaims
  /** Raw bearer forwarded to the wake plane when the caller is wake-capable. */
  rpcAccessToken: string
  /** Re-issues the original upstream request and writes the success response. */
  attemptUpstream: () => Promise<void>
  /** Writes today's error response (502/504) — the pre-wake behavior. */
  respondLegacy: (error: unknown) => void
  coordinator?: WakeAndHoldCoordinator
}

/**
 * Drives one held request through the wake flow and always writes a response:
 * - proceed  → short upstream retry schedule (draining bounces clear in ~1-2s),
 *              then structured host_waking if the pod is still not answering.
 * - legacy   → today's 502 path (409 not-stateless, wake plane failure, or a
 *              non-wake-capable caller with no wake authorization to ride).
 * - not-found→ 404.
 * - waking   → structured 503 {code:'host_waking'} + Retry-After.
 */
export async function respondWithWakeAndHold(
  options: RespondWithWakeAndHoldOptions
): Promise<void> {
  const coordinator = options.coordinator ?? hostWakeCoordinator
  if (options.res.headersSent) {
    // A response is already committed for this request: parking it could only
    // ever produce a duplicate upstream delivery. Refuse loudly.
    console.warn(
      `[RPC_PROXY] wake-hold refused: response already committed host=${options.hostRef}`
    )
    return
  }
  const outcome = await coordinator.hold({
    hostRef: options.hostRef,
    host: options.host,
    claims: options.claims,
    rpcAccessToken: options.rpcAccessToken,
  })

  switch (outcome.kind) {
    case 'proceed': {
      for (const delayMs of PROCEED_RETRY_DELAYS_MS) {
        if (delayMs > 0) await sleep(delayMs)
        if (options.res.headersSent) {
          // Resolution latch: the response was committed while this retry
          // schedule was pending. Re-forwarding now would duplicate a message
          // the upstream already accepted.
          console.debug(
            `[RPC_PROXY] late wake-hold artifact ignored (already resolved) host=${options.hostRef} artifact=proceed-retry`
          )
          return
        }
        try {
          await options.attemptUpstream()
          return
        } catch (error) {
          if (options.res.headersSent) {
            // The attempt failed AFTER committing the response (e.g. the
            // success write threw): the request is resolved. A retry here is
            // the duplicate-delivery bug — never re-forward, fail loudly.
            console.warn(
              `[RPC_PROXY] wake-hold post-response failure suppressed (already resolved) host=${options.hostRef} error=${
                error instanceof Error ? error.message : String(error)
              }`
            )
            return
          }
          if (isWakeEligibleHostError(error)) continue
          // The host answered with a non-availability failure — exactly
          // today's behavior for an up-but-erroring host.
          console.warn(
            `[RPC_PROXY] wake-hold upstream retry failed host=${options.hostRef} error=${
              error instanceof Error ? error.message : String(error)
            }`
          )
          options.respondLegacy(error)
          return
        }
      }
      if (options.res.headersSent) {
        console.debug(
          `[RPC_PROXY] late wake-hold artifact ignored (already resolved) host=${options.hostRef} artifact=host-waking-response`
        )
        return
      }
      console.warn(
        `[RPC_PROXY] wake-hold host still unreachable after wake host=${options.hostRef} lastKnownState=${outcome.lastKnownState}`
      )
      respondHostWaking(options.res, {
        hostRef: options.hostRef,
        retryAfterMs: config.wakePollMs,
        lastKnownState: outcome.lastKnownState,
      })
      return
    }
    case 'legacy':
      console.warn(
        `[RPC_PROXY] wake-hold falling back to legacy error path host=${options.hostRef} reason=${outcome.reason}`
      )
      options.respondLegacy(new Error(`Upstream host unavailable (${outcome.reason})`))
      return
    case 'not-found':
      res404(options.res)
      return
    case 'waking':
      console.info(
        `[RPC_PROXY] wake-hold responding host_waking host=${options.hostRef} reason=${outcome.reason} lastKnownState=${outcome.lastKnownState}`
      )
      respondHostWaking(options.res, {
        hostRef: options.hostRef,
        retryAfterMs: outcome.retryAfterMs,
        lastKnownState: outcome.lastKnownState,
      })
      return
  }
}

function res404(res: ExpressResponse): void {
  if (res.headersSent) return
  res.status(404).json({ error: 'Host not found or not accessible' })
}
