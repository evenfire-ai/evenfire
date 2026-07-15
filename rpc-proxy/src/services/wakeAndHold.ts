import type { Response as ExpressResponse } from 'express'
import { config } from '../config.js'
import type { ResolvedServerConnection } from '../types.js'
import { type HostWakeApiResponse, requestHostWakeFromControlApi } from './controlApiRestService.js'
import { forwardHostStatus } from './mcpHostRestService.js'

/**
 * Stateless wake-and-hold (Stage 5).
 *
 * When a request targets a stateless Host whose pod is suspended (network
 * failure) or draining (upstream 503 {code:'host_draining'}), rpc-proxy calls
 * the control-api wake endpoint and — for a 202 — parks the request while the
 * pod comes up, instead of surfacing the generic 502.
 *
 * Fleet note: rpc-proxy runs with replicas:2, so the in-memory dedup map here
 * is per-instance best effort. The fleet-level authority for wake dedup and
 * rate limiting is control-api (Postgres-backed generation + token bucket).
 */

const TOKEN_EXP_SAFETY_MARGIN_MS = 2_000
const ENTRY_TTL_MARGIN_MS = 5_000
const MAX_TRACKED_HOSTS = 1_000
/** Short upstream retry schedule after a wake reports the host is up. */
const PROCEED_RETRY_DELAYS_MS = [0, 250, 1_000]

export type WakeHoldOutcome =
  /** Host is (or just became) reachable — re-issue the upstream request now. */
  | { kind: 'proceed'; lastKnownState: string }
  /** Host is not stateless / wake plane failed — keep today's error behavior. */
  | { kind: 'legacy'; reason: string }
  /** Host CR is gone — 404 to the caller. */
  | { kind: 'not-found' }
  /** Still waking (or hold aborted) — structured retryable to the caller. */
  | { kind: 'waking'; retryAfterMs: number; reason: string; lastKnownState: string }

type Waiter = {
  id: number
  resolve: (outcome: WakeHoldOutcome) => void
  timer: NodeJS.Timeout
}

type HostWakeEntry = {
  hostRef: string
  createdAt: number
  /** Last state reported by the wake endpoint — surfaced as diagnostics. */
  lastKnownState: string
  waiters: Map<number, Waiter>
  /** Freshest credentials/connection among held requests, used by loops. */
  latest: { host: ResolvedServerConnection; token: string; tokenExpMs: number }
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
  maxTrackedHosts: number
  now?: () => number
}

export type WakeHoldParams = {
  hostRef: string
  host: ResolvedServerConnection
  rpcAccessToken: string
  /** Absolute expiry of the caller's rpc token (JWT `exp` in milliseconds). */
  tokenExpMs: number
}

export class WakeAndHoldCoordinator {
  private readonly entries = new Map<string, HostWakeEntry>()
  private waiterSeq = 0

  constructor(private readonly deps: WakeCoordinatorDeps) {}

  /** Exposed for tests and observability. */
  trackedHostCount(): number {
    return this.entries.size
  }

  async hold(params: WakeHoldParams): Promise<WakeHoldOutcome> {
    const now = this.now()
    const tokenBudgetMs = params.tokenExpMs - TOKEN_EXP_SAFETY_MARGIN_MS - now
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

    let entry = this.entries.get(params.hostRef)
    if (!entry) {
      entry = this.createEntry(params)
    } else if (params.tokenExpMs >= entry.latest.tokenExpMs) {
      // Keep the freshest token/connection so retriggers and the eventual
      // forward never run on the stalest credentials in the pack.
      entry.latest = {
        host: params.host,
        token: params.rpcAccessToken,
        tokenExpMs: params.tokenExpMs,
      }
    }

    const activeEntry = entry
    return await new Promise<WakeHoldOutcome>(resolve => {
      const id = ++this.waiterSeq
      const timer = setTimeout(() => {
        activeEntry.waiters.delete(id)
        resolve({
          kind: 'waking',
          retryAfterMs: this.deps.pollMs,
          reason: deadlineReason,
          lastKnownState: activeEntry.lastKnownState,
        })
        this.releaseIfEmpty(activeEntry)
      }, holdBudgetMs)
      activeEntry.waiters.set(id, { id, resolve, timer })
    })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private createEntry(params: WakeHoldParams): HostWakeEntry {
    this.enforceCapacity()
    const entry: HostWakeEntry = {
      hostRef: params.hostRef,
      createdAt: this.now(),
      lastKnownState: 'unknown',
      waiters: new Map(),
      latest: {
        host: params.host,
        token: params.rpcAccessToken,
        tokenExpMs: params.tokenExpMs,
      },
      pollTimer: null,
      retriggerTimer: null,
      ttlTimer: null,
      settled: false,
    }
    this.entries.set(params.hostRef, entry)
    // Safety net: even if a waiter bookkeeping bug ever left the entry behind,
    // it self-destructs loudly instead of leaking timers forever.
    entry.ttlTimer = setTimeout(() => {
      console.warn(
        `[RPC_PROXY] wake-hold entry TTL exceeded host=${entry.hostRef} waiters=${entry.waiters.size} — evicting`
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
    if (this.entries.size < this.deps.maxTrackedHosts) return
    let oldest: HostWakeEntry | null = null
    for (const candidate of this.entries.values()) {
      if (!oldest || candidate.createdAt < oldest.createdAt) oldest = candidate
    }
    if (!oldest) return
    console.warn(
      `[RPC_PROXY] wake-hold capacity exceeded (max=${this.deps.maxTrackedHosts}) — evicting oldest host=${oldest.hostRef} waiters=${oldest.waiters.size}`
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
      response = await this.deps.requestWake(entry.hostRef, entry.latest.token)
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
        // The caller's token passed rpc-proxy auth for this host, so a wake
        // 401/403 is unexpected — log loudly and keep today's behavior.
        console.warn(
          `[RPC_PROXY] wake call rejected host=${entry.hostRef} status=${response.status}`
        )
        this.settle(entry, { kind: 'legacy', reason: `wake-auth-${response.status}` })
        return
    }
  }

  private startHoldLoops(entry: HostWakeEntry): void {
    const schedulePoll = () => {
      entry.pollTimer = setTimeout(async () => {
        let ready = false
        try {
          ready = await this.deps.probeReady(entry.latest.host)
        } catch (error) {
          // A failed probe is "not ready yet" — the hold stays bounded by the
          // per-waiter deadlines, so a broken poll source cannot hang callers.
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
    this.entries.delete(entry.hostRef)
    for (const waiter of entry.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(outcome)
    }
    entry.waiters.clear()
  }

  private releaseIfEmpty(entry: HostWakeEntry): void {
    if (entry.settled || entry.waiters.size > 0) return
    entry.settled = true
    this.clearEntryTimers(entry)
    this.entries.delete(entry.hostRef)
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

/**
 * True for a network-level fetch failure against the upstream host (no HTTP
 * response at all — suspended pod, no endpoints). Excludes AbortError (today's
 * 504 path) and UpstreamHostError (the host answered).
 */
export function isHostDownNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'UpstreamHostError') return false
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
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(details.retryAfterMs / 1000))))
  res.status(503).json({
    code: 'host_waking',
    hostRef: details.hostRef,
    retryAfterMs: details.retryAfterMs,
    message: 'Host is waking up',
    lastKnownState: details.lastKnownState,
  })
}

/** Singleton wired to production dependencies. Tests construct their own. */
export const hostWakeCoordinator = new WakeAndHoldCoordinator({
  requestWake: requestHostWakeFromControlApi,
  probeReady: async (host: ResolvedServerConnection) => {
    // Same readiness source the host-status SSE stream polls: a parseable
    // /v1/runtime/status snapshot proves the pod answers runtime traffic.
    try {
      const status = await forwardHostStatus(host)
      return status !== null
    } catch {
      // Unreachable/erroring status endpoint == not ready yet. Bounded by the
      // hold deadline — never a silent success.
      return false
    }
  },
  maxHoldMs: config.wakeMaxHoldMs,
  pollMs: config.wakePollMs,
  retriggerMs: config.wakeRetriggerMs,
  maxTrackedHosts: MAX_TRACKED_HOSTS,
})

export type RespondWithWakeAndHoldOptions = {
  res: ExpressResponse
  hostRef: string
  host: ResolvedServerConnection
  rpcAccessToken: string
  /** JWT `exp` of the caller's rpc token, in milliseconds. */
  tokenExpMs: number
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
 * - legacy   → today's 502 path (409 not-stateless, wake plane failure).
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
    rpcAccessToken: options.rpcAccessToken,
    tokenExpMs: options.tokenExpMs,
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
  res.status(404).json({ error: 'Host not found or not accessible' })
}
