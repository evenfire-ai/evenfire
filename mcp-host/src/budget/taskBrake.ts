/**
 * Token-budget per-task emergency brake (Phase P2, §5.2).
 *
 * Measures the DELTA of tokens spent by ONE task, not the session-cumulative
 * total. The in-RAM `Conversation.{input,output,cache_read,cache_write}_tokens`
 * counters are session-lifetime mirrors that persist across restarts
 * (`reconstruct.ts`), so reading them raw would abort a healthy long-lived
 * session. Instead the task snapshots those counters at start
 * (`snapshotTaskTokenBaseline`) and the loop compares `current − baseline`
 * before each LLM call (`evaluateTaskBrake`).
 *
 * Pure + dependency-free (only `BudgetPrice` from `./types`): no network, no
 * `this`, trivially unit-testable, and a total no-op when no per-task cap is
 * configured.
 */
import type { BudgetPrice } from './types'

/**
 * Snapshot of a Conversation's lifetime (session-cumulative) token counters,
 * captured at task start so the brake can measure THIS task's delta against it.
 */
export interface TaskTokenBaseline {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

/**
 * The minimal read-only shape the brake needs off a `Conversation` — its four
 * lifetime token counters. All optional (consumers treat `undefined` as 0),
 * structurally matching `Conversation`.
 */
export interface TaskTokenCounters {
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}

/**
 * Per-task brake parameters: the per-task caps + active price from the P1
 * budget verdict, plus the baseline snapshot taken at task start. Plumbed into
 * the tool-use loop via `LoopConfig.taskBrake`.
 */
export interface TaskBrakeConfig {
  /** Token cap (`maxTaskTokens` from the verdict). `null`/absent → no token cap. */
  maxTaskTokens?: number | null
  /** Cost cap in the verdict's currency (`maxTaskCost`). Needs `price` to apply. */
  maxTaskCost?: number | null
  /** Active price of this `(provider, model)`; converts the token delta → cost. */
  price?: BudgetPrice | null
  /** Counters snapshot captured at task start. */
  baseline: TaskTokenBaseline
}

/** Why the brake tripped — which cap was exceeded and by how much. */
export interface TaskBrakeTrip {
  unit: 'tokens' | 'cost'
  /** The configured cap. */
  limit: number
  /** The task's delta spend that exceeded it (tokens, or cost in the unit). */
  spent: number
}

/**
 * Snapshot the conversation's current lifetime token counters as the per-task
 * baseline. Called once at task start, BEFORE the task consumes anything.
 */
export function snapshotTaskTokenBaseline(c: TaskTokenCounters): TaskTokenBaseline {
  return {
    input_tokens: c.input_tokens ?? 0,
    output_tokens: c.output_tokens ?? 0,
    cache_read_tokens: c.cache_read_tokens ?? 0,
    cache_write_tokens: c.cache_write_tokens ?? 0,
  }
}

/**
 * Evaluate the per-task brake against the conversation's current counters.
 * Returns the trip (cap exceeded + amounts) or `null` when within budget — or
 * when no cap is configured (the brake is a no-op).
 *
 * Measures the DELTA (`current − baseline`) so accumulated session history
 * never trips the brake; only THIS task's spend counts (§5.2).
 */
export function evaluateTaskBrake(
  brake: TaskBrakeConfig,
  c: TaskTokenCounters
): TaskBrakeTrip | null {
  const b = brake.baseline
  const dIn = (c.input_tokens ?? 0) - b.input_tokens
  const dOut = (c.output_tokens ?? 0) - b.output_tokens
  const dCr = (c.cache_read_tokens ?? 0) - b.cache_read_tokens
  const dCw = (c.cache_write_tokens ?? 0) - b.cache_write_tokens

  // Token cap: sum of the four deltas.
  if (brake.maxTaskTokens != null && brake.maxTaskTokens > 0) {
    const tokens = dIn + dOut + dCr + dCw
    if (tokens > brake.maxTaskTokens) {
      return { unit: 'tokens', limit: brake.maxTaskTokens, spent: tokens }
    }
  }

  // Cost cap: convert the token delta to currency with the verdict's price
  // (prices are per 1,000,000 tokens → divide by 1e6). No network.
  if (brake.maxTaskCost != null && brake.maxTaskCost > 0 && brake.price) {
    const p = brake.price
    const cost = (dIn * p.input + dOut * p.output + dCr * p.cacheRead + dCw * p.cacheWrite) / 1e6
    if (cost > brake.maxTaskCost) {
      return { unit: 'cost', limit: brake.maxTaskCost, spent: cost }
    }
  }

  return null
}
