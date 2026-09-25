/**
 * Grant-existence probe policy — the decision module that bounds how often
 * mcp-host asks control-api "does this grant exist?" while opening remote OAuth
 * partitions eagerly (per-user catalog bootstrap and the SHARED oauth-context
 * gate). It sits in front of `checkGrantExistence` (grantExistenceClient.ts) and
 * exists because control-api meters `user-token` AND `grants/exists` on the SAME
 * 60/min-per-host bucket: an unbounded probe-per-turn could starve the host's own
 * token issuance. The policy is: negative cache, admission-failure cache, in-flight
 * dedup, a local per-minute request budget, and a global backoff after an endpoint
 * failure.
 *
 * `planProbe` is a PURE function of `(state, now, queries, config)` — it is the
 * property-tested core; `createGrantProbe` wraps it with the injected HTTP checker
 * and the mutable per-manager state. This module deliberately imports NOTHING at
 * runtime (config arrives by parameter, the checker is injected) so config.ts can
 * import its `McpCatalogBootstrapConfig` type without a cycle.
 */
import type { GrantExistsQuery, GrantExistsResult } from './grantExistenceClient'

/**
 * The 8 knobs of the eager-bootstrap probe policy. Exported from THIS module (not
 * config.ts) so config.ts can import the type without an import cycle through the
 * grant-existence client and the manager.
 */
export interface McpCatalogBootstrapConfig {
  /** Kill-switch back to today's lazy admission (turn bootstrap AND SHARED gate). */
  enabled: boolean
  /** Max a turn waits for its admissions before continuing with what landed. */
  waitBudgetMs: number
  /** Per-probe HTTP timeout; must stay below waitBudgetMs. */
  probeTimeoutMs: number
  /** Timeout handed to a bootstrap-initiated `connect()` so it cannot hang for the SDK default. */
  connectTimeoutMs: number
  /** Negative-cache TTL for a definitive `exists:false`. */
  negativeTtlMs: number
  /** Cache TTL after an admission fails despite a present grant. */
  failureTtlMs: number
  /** Local per-minute request budget (HTTP POSTs, not coordinates). */
  probesPerMin: number
  /** Global pause after the endpoint throws/times out/429s. */
  backoffMs: number
}

/**
 * The checker `createGrantProbe` calls to actually reach control-api. In
 * production `main.ts` wires this to `checkGrantExistence` with the broker deps
 * and a short timeout; tests inject a controlled fake. Throwing on any failure
 * mode (network/timeout/non-200 incl. 429/malformed body) is the contract the
 * policy relies on to trigger backoff — it mirrors `checkGrantExistence`.
 */
export type GrantExistenceChecker = (
  queries: GrantExistsQuery[],
  opts: { timeoutMs: number }
) => Promise<GrantExistsResult[]>

interface ProbeBucket {
  windowStartMs: number
  used: number
}

/** Mutable policy state; one instance per `McpManager`. */
export interface GrantProbeState {
  /** Negative cache: coordinate → epoch ms until which "no grant" holds. */
  absentUntil: Map<string, number>
  /** Admission-failure cache: coordinate → epoch ms until which we skip re-admitting. */
  failedUntil: Map<string, number>
  /** Coordinates already asked and awaiting a response (dedup across concurrent turns). */
  inFlight: Set<string>
  /** Global backoff: no probe is issued while `now < pausedUntil`. */
  pausedUntil: number
  /** Local per-minute request budget over a fixed 60s window. */
  bucket: ProbeBucket
}

/** The buckets `planProbe` sorts each coordinate into. `ask` carries the queries to send; the rest are coordinate keys. */
export interface ProbePlan {
  ask: GrantExistsQuery[]
  absentCached: string[]
  failedCached: string[]
  budgetExhausted: string[]
  inFlight: string[]
}

export interface PlanProbeResult extends ProbePlan {
  /** The new state after planning: asked coordinates recorded in `inFlight`, window reset if stale. */
  state: GrantProbeState
}

/** A probe verdict for a single coordinate (used by the SHARED oauth-context gate). */
export type ProbeVerdict = 'present' | 'absent' | 'unknown'

/** Fixed 1-minute window, aligned with control-api's per-minute limiter. */
const PROBE_WINDOW_MS = 60_000

/** control-api caps a single `grants/exists` batch at this many coordinates (routes/mcpOauth.ts). */
export const MAX_EXISTS_BATCH = 1000

/**
 * Stable coordinate key. MUST match the convention of
 * `grantExistenceClient.ts`'s `coordKey`/`selectRevokedPartitionKeys`
 * (`oauth-context` carries no userId → normalized to null) so the probe cache
 * and the revocation sweep agree on what "a grant" is.
 */
function coordKey(mcpServerName: string, userId?: string): string {
  return JSON.stringify([mcpServerName, userId ?? null])
}

function coordOf(query: GrantExistsQuery): string {
  return coordKey(query.mcpServerName, query.userId)
}

export function emptyProbeState(): GrantProbeState {
  return {
    absentUntil: new Map(),
    failedUntil: new Map(),
    inFlight: new Set(),
    pausedUntil: 0,
    bucket: { windowStartMs: 0, used: 0 },
  }
}

/**
 * Pure policy core (§6.3 table). Evaluates each DISTINCT coordinate of `queries`
 * against the state in the fixed order P1→P7 — the first row that applies wins —
 * and returns the new state plus the plan. It NEVER mutates its input state and
 * NEVER performs I/O. It records asked coordinates in the returned `inFlight`
 * (dedup) but does NOT charge the request budget: the bucket is charged per HTTP
 * request by `execute` (P7). `execute` splits the `ask` into ≤MAX_EXISTS_BATCH
 * chunks and each chunk is one limiter unit, so `plan` only authorizes as many
 * coordinates as the remaining window budget can pay for in chunks — the rest
 * spill to `budgetExhausted` (P6). This keeps the local budget an actual bound on
 * requests, not just on plans.
 */
export function planProbe(
  state: GrantProbeState,
  now: number,
  queries: readonly GrantExistsQuery[],
  config: McpCatalogBootstrapConfig
): PlanProbeResult {
  // Clone so the function stays pure; callers replace their state with the result.
  const absentUntil = new Map(state.absentUntil)
  const failedUntil = new Map(state.failedUntil)
  const inFlight = new Set(state.inFlight)
  const pausedUntil = state.pausedUntil
  // A window that has aged out (or never started) resets before any decision, so
  // budget checks in this plan see the current window. windowStartMs=0 on a fresh
  // state resets on the first real `now`.
  const windowExpired = now - state.bucket.windowStartMs >= PROBE_WINDOW_MS
  const bucket: ProbeBucket = windowExpired ? { windowStartMs: now, used: 0 } : { ...state.bucket }

  const plan: ProbePlan = {
    ask: [],
    absentCached: [],
    failedCached: [],
    budgetExhausted: [],
    inFlight: [],
  }

  const paused = now < pausedUntil

  // De-duplicate by coordinate: two queries for the same coordinate are one probe.
  const seen = new Set<string>()
  const candidates: GrantExistsQuery[] = []
  for (const query of queries) {
    const coord = coordOf(query)
    if (seen.has(coord)) continue
    seen.add(coord)

    if (inFlight.has(coord)) {
      plan.inFlight.push(coord) // P1
    } else if (now < (failedUntil.get(coord) ?? 0)) {
      plan.failedCached.push(coord) // P2
    } else if (now < (absentUntil.get(coord) ?? 0)) {
      plan.absentCached.push(coord) // P3
    } else if (paused) {
      plan.budgetExhausted.push(coord) // P4 (global backoff)
    } else {
      candidates.push(query) // P5/P6/P7 decided below
    }
  }

  if (candidates.length > 0) {
    // `execute` charges one bucket unit per ≤MAX_EXISTS_BATCH chunk, so the plan
    // may authorize at most `remaining units × chunk size` coordinates; the rest
    // spill to budgetExhausted (P6). Reserving in `inFlight` happens only for the
    // authorized slice, since only those coordinates reach `execute`.
    const remainingUnits = Math.max(0, config.probesPerMin - bucket.used)
    const askCapacity = remainingUnits * MAX_EXISTS_BATCH
    candidates.forEach((query, i) => {
      if (i < askCapacity) {
        plan.ask.push(query) // P7
        inFlight.add(coordOf(query))
      } else {
        plan.budgetExhausted.push(coordOf(query)) // P6: over the window budget
      }
    })
  }

  return {
    ...plan,
    state: { absentUntil, failedUntil, inFlight, pausedUntil, bucket },
  }
}

/** Stateful probe over an injected checker. One instance per `McpManager`. */
export interface GrantProbe {
  /**
   * Plan the batch for `queries` (advances state: reserves in-flight, resets a stale window).
   * Contract: every non-empty `ask` this returns MUST be handed to `execute` (which clears the
   * in-flight reservation on success or throw). Dropping an `ask` leaks its coordinates in
   * `inFlight`, and P1 would then skip them forever until `reset()`.
   */
  plan(queries: readonly GrantExistsQuery[]): ProbePlan
  /** Send the planned `ask` in ≤MAX_EXISTS_BATCH chunks; charges the bucket per HTTP request. Throws (after backoff + in-flight cleanup) if the checker throws. */
  execute(ask: GrantExistsQuery[]): Promise<GrantExistsResult[]>
  /** Convenience for the single-coordinate SHARED gate: plan+execute+interpret one query. */
  probeOne(query: GrantExistsQuery, nowMs?: number): Promise<ProbeVerdict>
  /** Cache a definitive `exists:false` and clear the coordinate's in-flight mark. */
  recordAbsent(coord: string, nowMs?: number): void
  /** Cache an admission that failed despite a present grant. */
  recordAdmissionFailure(coord: string, nowMs?: number): void
  /** Clear the failure/absent caches for a coordinate whose admission succeeded. */
  recordAdmissionOk(coord: string): void
  /** Enter global backoff after an endpoint failure. */
  recordFailure(nowMs?: number): void
  /** Drop all state (new manager / tests). */
  reset(): void
  /** Read-only view for metrics/tests. */
  snapshot(): {
    inFlight: number
    absentCached: number
    failedCached: number
    pausedUntil: number
    bucketUsed: number
    windowStartMs: number
  }
}

export function createGrantProbe(
  checker: GrantExistenceChecker,
  config: McpCatalogBootstrapConfig,
  now: () => number = Date.now
): GrantProbe {
  let state = emptyProbeState()

  const plan = (queries: readonly GrantExistsQuery[]): ProbePlan => {
    const result = planProbe(state, now(), queries, config)
    state = result.state
    return {
      ask: result.ask,
      absentCached: result.absentCached,
      failedCached: result.failedCached,
      budgetExhausted: result.budgetExhausted,
      inFlight: result.inFlight,
    }
  }

  const recordFailure = (nowMs: number = now()): void => {
    state.pausedUntil = nowMs + config.backoffMs
  }

  const execute = async (ask: GrantExistsQuery[]): Promise<GrantExistsResult[]> => {
    if (ask.length === 0) return []
    const results: GrantExistsResult[] = []
    try {
      for (let i = 0; i < ask.length; i += MAX_EXISTS_BATCH) {
        const chunk = ask.slice(i, i + MAX_EXISTS_BATCH)
        // One HTTP request costs one limiter unit at control-api (P7).
        state.bucket.used += 1
        const chunkResults = await checker(chunk, { timeoutMs: config.probeTimeoutMs })
        results.push(...chunkResults)
      }
    } catch (err) {
      // Endpoint failure: release every reserved coordinate and back off globally.
      for (const query of ask) state.inFlight.delete(coordOf(query))
      recordFailure()
      throw err
    }
    // The request completed for every asked coordinate; the caller records the
    // per-coordinate outcome (absent / admission ok / admission failed).
    for (const query of ask) state.inFlight.delete(coordOf(query))
    return results
  }

  const recordAbsent = (coord: string, nowMs: number = now()): void => {
    state.inFlight.delete(coord)
    state.absentUntil.set(coord, nowMs + config.negativeTtlMs)
  }

  const recordAdmissionFailure = (coord: string, nowMs: number = now()): void => {
    state.inFlight.delete(coord)
    state.failedUntil.set(coord, nowMs + config.failureTtlMs)
  }

  const recordAdmissionOk = (coord: string): void => {
    state.inFlight.delete(coord)
    state.failedUntil.delete(coord)
    state.absentUntil.delete(coord)
  }

  const probeOne = async (
    query: GrantExistsQuery,
    nowMs: number = now()
  ): Promise<ProbeVerdict> => {
    const planned = planProbe(state, nowMs, [query], config)
    state = planned.state
    const coord = coordOf(query)
    if (planned.ask.length === 0) {
      // A definitive negative cache is a real "absent"; every other skip
      // (in-flight, failure cache, backoff, budget) is "unknown" — we do not
      // know the grant's status, so the caller must not treat it as absent.
      return planned.absentCached.includes(coord) ? 'absent' : 'unknown'
    }
    try {
      const results = await execute(planned.ask)
      const match = results.find(r => coordOf(r) === coord)
      if (!match || typeof match.exists !== 'boolean') return 'unknown'
      if (match.exists) return 'present'
      recordAbsent(coord, nowMs)
      return 'absent'
    } catch {
      // execute already backed off and cleared in-flight; unknown is fail-open.
      return 'unknown'
    }
  }

  return {
    plan,
    execute,
    probeOne,
    recordAbsent,
    recordAdmissionFailure,
    recordAdmissionOk,
    recordFailure,
    reset: () => {
      state = emptyProbeState()
    },
    snapshot: () => ({
      inFlight: state.inFlight.size,
      absentCached: state.absentUntil.size,
      failedCached: state.failedUntil.size,
      pausedUntil: state.pausedUntil,
      bucketUsed: state.bucket.used,
      windowStartMs: state.bucket.windowStartMs,
    }),
  }
}
