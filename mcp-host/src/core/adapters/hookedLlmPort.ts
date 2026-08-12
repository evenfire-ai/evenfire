/**
 * HookedLlmPort — the LLM-lane guardrail boundary (spec §7), an `LlmPort`
 * decorator wrapping the effective port **above failover** so contributors fire
 * once per logical request, not per fallback attempt.
 *
 * Phase 2 (increment 1): applies the first-party built-in request-shaping chain
 * (`prompt-shaping`) on the MAIN lane (`completeWithTools`). The aux/compaction
 * lane (`complete`) runs the REDUCED set — no guardrail/PII (spec §7.4) — which
 * in this increment is a passthrough. Moderation (concurrent with the call),
 * `on_error` recovery, and installed hooks are later increments / Phase 3.
 */
import type { GuardrailsConfig } from '../guardrails'
import { type RequestShaper, buildLlmBuiltinChain } from '../guardrails/llm/builtinChain'
import type { LlmPort } from '../interfaces'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import type {
  CompletionRequest,
  CompletionResponse,
  ToolCompletionRequest,
  ToolCompletionResponse,
} from '../types'

export class HookedLlmPort implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly shapeMainLane: RequestShaper
  ) {}

  modelName(): string {
    return this.inner.modelName()
  }

  getTokenCounter(): TokenCounter {
    const counter = this.inner.getTokenCounter?.()
    if (!counter) {
      throw new Error('[HookedLlmPort] inner port has no token counter — wiring bug')
    }
    return counter
  }

  /** Aux/compaction lane (spec §7.4): reduced set. Increment 1 = passthrough. */
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.inner.complete(request)
  }

  /** Main lane (spec §7): apply the built-in `pre` request shaping, then dispatch. */
  completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    return this.inner.completeWithTools(this.shapeMainLane(request))
  }
}

/**
 * Wrap the effective (post-failover) port with the LLM-lane guardrails when any
 * built-ins are configured; otherwise return it unchanged (no-config
 * compatibility, spec §5 — no extra decorator layer when unused).
 */
export function maybeWrapHookedLlmPort(
  port: LlmPort,
  config: GuardrailsConfig | undefined
): LlmPort {
  // No built-ins → no decorator layer (byte-identical to today).
  if (!config?.builtins || config.builtins.length === 0) return port
  return new HookedLlmPort(port, buildLlmBuiltinChain(config.builtins))
}
