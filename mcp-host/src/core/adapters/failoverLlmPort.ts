/**
 * Provider-fallback (R5) — the agent glue between the reusable
 * {@link FailoverEngine} and the `LlmPort` used by the reasoning loop.
 *
 * Interception happens AT THE PORT (spec §3-R5.1): this wraps the primary
 * `LlmPort` so that when a `complete`/`completeWithTools` call throws a
 * classified `LlmError`, the engine switches to the next constructible fallback
 * and retries the SAME request — BELOW the loop's transport retry and BELOW the
 * canned workflow fallback of `toolUseLoopErrorRecovery`, so a configured policy
 * wins precedence.
 *
 * Adapter-per-attempt (spec §3-R5.9): each fallback entry is served by its OWN
 * `LlmPortAdapter` (built via `buildFallbackPort`) so `usage_events` records the
 * pair REALLY served — the primary adapter freezes provider/model in its
 * constructor, so reusing it would meter the wrong pair. Only the winning call
 * meters (the adapter records usage on success only).
 */
import type { ClassifiedLike, FailoverEngine } from '../../llm/failover/engine'
import type { FailoverTarget, LlmPolicy, ModelPair } from '../../llm/failover/types'
import { LlmError } from '../errors'
import type { LlmErrorCode } from '../errors'
import type { LlmPort } from '../interfaces'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import type {
  CompletionRequest,
  CompletionResponse,
  ToolCompletionRequest,
  ToolCompletionResponse,
} from '../types'

/** Classify a thrown error for the engine. Only real `LlmError`s are eligible. */
function classifyLlmError(err: unknown): ClassifiedLike | null {
  if (err instanceof LlmError) {
    return {
      code: err.code as LlmErrorCode,
      retryable: err.retryable,
      ...(err.providerCode ? { providerCode: err.providerCode } : {}),
    }
  }
  return null
}

export interface FailoverLlmPortOptions {
  /** The already-built primary port (the session's effective-model adapter). */
  primaryPort: LlmPort
  /** The primary's `(provider, model)` — the pair the engine reasons about. */
  primaryPair: ModelPair
  /** Shared, Host-wide sticky failover state. */
  engine: FailoverEngine
  /** The normalized policy (fallbacks non-empty). */
  policy: LlmPolicy
  /**
   * Build a fresh `LlmPort` (adapter) for a fallback entry, capturing the SAME
   * per-task usage resources as the primary. Returns `null` when the entry's
   * provider/credentials are not constructible (→ the engine skips it).
   */
  buildFallbackPort: (index: number) => LlmPort | null
}

class FailoverLlmPort implements LlmPort {
  private readonly fallbackPortCache = new Map<number, LlmPort | null>()

  constructor(private readonly o: FailoverLlmPortOptions) {}

  modelName(): string {
    return this.o.engine.servedBy()?.model ?? this.o.primaryPair.model
  }

  getTokenCounter(): TokenCounter {
    // The compaction/reasoning pre-flight counter is the primary's (built once
    // per task in buildLoopConfig). A cross-provider fallback uses a different
    // tokenizer for the actual call, but the pre-flight heuristic staying on the
    // primary is an accepted degradation (spec §3-R5.8) — it only nudges
    // compaction, never correctness. Delegating keeps a single counter.
    const counter = this.o.primaryPort.getTokenCounter?.()
    if (!counter) {
      throw new Error('[FailoverLlmPort] primary port has no token counter — wiring bug')
    }
    return counter
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.run(port => port.complete(request))
  }

  completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    return this.run(port => port.completeWithTools(request))
  }

  private portFor(target: FailoverTarget): LlmPort | null {
    if (target.kind === 'primary') return this.o.primaryPort
    if (this.fallbackPortCache.has(target.index)) {
      return this.fallbackPortCache.get(target.index) ?? null
    }
    const port = this.o.buildFallbackPort(target.index)
    this.fallbackPortCache.set(target.index, port)
    return port
  }

  private run<T>(call: (port: LlmPort) => Promise<T>): Promise<T> {
    return this.o.engine.run(
      this.o.primaryPair,
      target => {
        const port = this.portFor(target)
        if (!port) return null
        // Report the model the port will REALLY serve so the engine's servedBy
        // + `clerum_llm_fallback_total{to}` reflect it. A SAME-provider fallback
        // adapter was built with `servedModel = primaryModel` (R5.7), so its
        // `modelName()` is the session model, not `entry.model` (spec's FIX-2).
        return { run: () => call(port), servedModel: port.modelName() }
      },
      classifyLlmError
    )
  }
}

export interface WrapFailoverParams {
  primaryPort: LlmPort
  primaryPair: ModelPair
  engine: FailoverEngine
  policy: LlmPolicy
  buildFallbackPort: (index: number) => LlmPort | null
}

/**
 * Wrap `primaryPort` with failover when a policy with at least one fallback is
 * configured; otherwise return it UNCHANGED (byte-identical to today — spec
 * §3-R5.1, "sin llmPolicy = comportamiento actual byte a byte").
 */
export function maybeWrapFailover(params: WrapFailoverParams): LlmPort {
  if (params.policy.fallbacks.length === 0) return params.primaryPort
  return new FailoverLlmPort(params)
}
