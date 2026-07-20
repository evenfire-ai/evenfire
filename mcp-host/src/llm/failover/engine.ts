/**
 * Provider-fallback (R5) — the reusable failover engine.
 *
 * AGENT-AGNOSTIC by design (spec §3-R5.6/R5.7): it holds ONLY the failover
 * policy + the sticky in-memory state (primary cooldown, current served pair),
 * and orchestrates the ordered attempt loop. It knows nothing about `LlmPort`,
 * the agent, workflows or promptBridge — F5 (agent) wires it through
 * `core/adapters/failoverLlmPort.ts`; F6 will wire the same engine into the
 * workflow step runner and the promptBridge `LlmBridge`.
 *
 * Semantics (spec §3-R5.1):
 *   - A call that fails with an ELIGIBLE error (`triggerOn ∋ class`) advances to
 *     the next constructible fallback in order; the primary enters a sticky
 *     cooldown (default 300 s).
 *   - While the primary is cooling, fresh calls start directly at the fallbacks
 *     (no immediate retry of the downed primary — anti-flapping, V13).
 *   - Lazy recovery: once the cooldown expires, the next call attempts the
 *     primary again (no active health-probe). If it fails again, cooldown renews.
 *   - A NON-eligible error (e.g. 400/validation) propagates immediately without
 *     failover (never mask bugs).
 *   - When the ordered list is exhausted the last error propagates — the agent
 *     loop's canned workflow fallback remains the last resort (precedence: the
 *     engine switches BELOW that layer, so it wins when a policy is configured).
 *
 * One pod = one agent, so the state lives in memory here (spec §3-R5.9).
 */
import { LlmErrorCode } from '../../core/errors'
import { classifyFailoverClass } from './classify'
import { llmFallbackTotal } from './metrics'
import type {
  FailoverClass,
  FailoverSwitchEvent,
  FailoverTarget,
  LlmPolicy,
  ModelPair,
  ServedBy,
} from './types'

/** Minimal shape the engine needs to classify a thrown provider error. */
export interface ClassifiedLike {
  code: LlmErrorCode
  retryable: boolean
}

export interface FailoverEngineOptions {
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Structured-WARN sink for each switch (no secrets). */
  onSwitch?: (event: FailoverSwitchEvent) => void
  /**
   * Metric sink for each switch. Defaults to the shared
   * `clerum_llm_fallback_total`. Injectable so tests can assert without the
   * global registry.
   */
  metricInc?: (labels: { from: string; to: string; reason: string }) => void
}

/**
 * A concrete attempt for a target: the call thunk, optionally paired with the
 * model the attempt will REALLY serve. The engine uses `servedModel` (when
 * present) for `servedBy` + the `clerum_llm_fallback_total{to}` metric instead
 * of the target's declared `model`. This matters for a SAME-provider fallback:
 * the runtime serves the SESSION model (per R5.7), not the entry's `model`, so
 * the caller reports the real served model here.
 */
export interface Attempt<T> {
  run: () => Promise<T>
  /** The model actually served by this attempt (overrides `target.model`). */
  servedModel?: string
}

/**
 * Builds the concrete attempt for a target, or returns `null` when that target
 * is not constructible right now (e.g. a fallback whose credential slot is
 * absent) — the engine then skips it. May return a bare `() => Promise<T>`
 * thunk (served model = `target.model`) or an {@link Attempt} carrying an
 * explicit `servedModel` override.
 */
export type AttemptBuilder<T> = (target: FailoverTarget) => (() => Promise<T>) | Attempt<T> | null

function pairLabel(p: ModelPair): string {
  return `${p.provider}/${p.model}`
}

export class FailoverEngine {
  private cooldownUntil: number | null = null
  private served: ServedBy | null = null

  constructor(
    private policy: LlmPolicy,
    private readonly opts: FailoverEngineOptions = {}
  ) {}

  /** The pair currently serving (for the status projection). */
  servedBy(): ServedBy | null {
    return this.served
  }

  /**
   * Replace the policy (Host CR edit). Resets the sticky state: a changed
   * fallback list / cooldown invalidates the old cursor + cooldown clock.
   */
  setPolicy(policy: LlmPolicy): void {
    this.policy = policy
    this.cooldownUntil = null
    this.served = null
  }

  /** Is this `(code, retryable)` eligible for fallback under the current policy? */
  isEligible(code: LlmErrorCode, retryable: boolean): boolean {
    const cls = classifyFailoverClass(code, retryable)
    return cls !== null && this.policy.triggerOn.includes(cls)
  }

  /** Record that `pair` is now serving via the primary (recovered / normal). */
  noteServedPrimary(pair: ModelPair): void {
    this.served = { provider: pair.provider, model: pair.model, fallback: false }
  }

  /**
   * Clear any active primary cooldown so the very next call retries the primary.
   * Called when the primary becomes constructible again out-of-band (e.g. the
   * LLM key is rotated/fixed) — the primary was never truly "down", so the
   * sticky cooldown should not delay its recovery.
   */
  clearCooldown(): void {
    this.cooldownUntil = null
  }

  /** Record that `pair` (a fallback) is now serving — used at boot too. */
  noteServedFallback(pair: ModelPair): void {
    this.served = { provider: pair.provider, model: pair.model, fallback: true }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /**
   * Ordered targets to try for a fresh call, honoring the sticky primary
   * cooldown + lazy recovery. Reads (and expires) the cooldown clock.
   */
  private planTargets(primary: ModelPair): FailoverTarget[] {
    let primaryCooling = false
    if (this.cooldownUntil !== null) {
      if (this.now() < this.cooldownUntil) primaryCooling = true
      else this.cooldownUntil = null // lazy recovery — expire and retry primary
    }
    const targets: FailoverTarget[] = []
    if (!primaryCooling) targets.push({ kind: 'primary', ...primary })
    this.policy.fallbacks.forEach((entry, index) => {
      targets.push({ kind: 'fallback', index, provider: entry.provider, model: entry.model })
    })
    return targets
  }

  private recordSwitch(from: ModelPair, to: ModelPair, reason: FailoverClass): void {
    const inc = this.opts.metricInc ?? (labels => llmFallbackTotal.inc(labels))
    inc({ from: pairLabel(from), to: pairLabel(to), reason })
    this.opts.onSwitch?.({ from, to, reason })
  }

  /**
   * Run one logical LLM call with failover. `primary` is the effective pair the
   * call would normally use (per-session resolved model, for the agent); `build`
   * produces the concrete attempt for each ordered target (or `null` to skip an
   * unconstructible one); `classify` extracts `(code, retryable)` from a thrown
   * error (or `null` when it is not a recognised provider error).
   */
  async run<T>(
    primary: ModelPair,
    build: AttemptBuilder<T>,
    classify: (err: unknown) => ClassifiedLike | null
  ): Promise<T> {
    const targets = this.planTargets(primary)
    let lastErr: unknown
    let prevFailure: { pair: ModelPair; reason: FailoverClass } | null = null

    for (const target of targets) {
      const built = build(target)
      if (!built) continue // not constructible → skip this target
      const attempt = typeof built === 'function' ? built : built.run
      // Report the model REALLY served (a same-provider fallback serves the
      // session model, not `entry.model`) so `servedBy` + the metric's `to`
      // label reflect it; bare-thunk builders fall back to the target model.
      const servedModel =
        typeof built === 'function' ? target.model : (built.servedModel ?? target.model)
      const pair: ModelPair = { provider: target.provider, model: servedModel }
      // Only count a switch once we actually attempt a DIFFERENT constructible
      // pair following an eligible failure (skipped/unconstructible targets in
      // between do not emit a phantom switch).
      if (prevFailure) this.recordSwitch(prevFailure.pair, pair, prevFailure.reason)
      try {
        const result = await attempt()
        if (target.kind === 'fallback') this.noteServedFallback(pair)
        else this.noteServedPrimary(pair)
        return result
      } catch (err) {
        lastErr = err
        const classified = classify(err)
        const failClass = classified
          ? classifyFailoverClass(classified.code, classified.retryable)
          : null
        const eligible = failClass !== null && this.policy.triggerOn.includes(failClass)
        if (!eligible) throw err // non-eligible → propagate, never mask (e.g. 400)
        if (target.kind === 'primary') {
          this.cooldownUntil = this.now() + this.policy.cooldownSeconds * 1000
        }
        prevFailure = { pair, reason: failClass }
        // fall through to next target
      }
    }

    // Exhausted (or nothing constructible): propagate the last error so the
    // caller's own recovery (agent loop's canned fallback) can act as last resort.
    throw lastErr ?? new Error('[Failover] no attemptable target')
  }
}
