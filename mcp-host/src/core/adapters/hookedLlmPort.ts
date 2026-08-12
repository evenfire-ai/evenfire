/**
 * HookedLlmPort — the LLM-lane guardrail boundary (spec §7), an `LlmPort`
 * decorator wrapping the effective port **above failover** so contributors fire
 * once per logical request, not per fallback attempt.
 *
 * On the MAIN lane (`completeWithTools`):
 *   1. apply the first-party built-in request-shaping chain (`prompt-shaping`,
 *      `token-trim`);
 *   2. run installed `pre_call` hooks (each may rewrite the request or reject);
 *   3. run installed `moderate` hooks;
 *   4. aggregate (spec §3) — a `deny` returns a content-filtered response WITHOUT
 *      calling the model; otherwise dispatch the (possibly rewritten) request;
 *   5. if the model call throws, run installed `on_error` hooks — a gated hook may
 *      `substitute` a safe text-only result (else the error surfaces);
 *   6. run installed `post_call` hooks over the result — each may redact content or
 *      drop tool_calls (never add them, N5), chained in `order`.
 * The aux/compaction lane (`complete`) runs the REDUCED set — no guardrail/PII
 * (spec §7.4) — a passthrough here.
 *
 * Response-capability enforcement (F4), system-prompt immutability (N4), and
 * subtractive actions (N5) are enforced inside `RemoteLlmHook`. The
 * concurrent-moderation latency optimization (spec §7.1) is a later increment.
 */
import { aggregateDecision } from '../guardrails'
import type { Contributor, GuardrailsConfig } from '../guardrails'
import { type RequestShaper, buildLlmBuiltinChain } from '../guardrails/llm/builtinChain'
import {
  type LlmLaneHookDeps,
  type LlmLaneHooks,
  buildLlmLaneHooks,
} from '../guardrails/llm/llmLaneHooks'
import type { LlmPort } from '../interfaces'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import {
  type CompletionRequest,
  type CompletionResponse,
  FinishReason,
  type ToolCompletionRequest,
  type ToolCompletionResponse,
} from '../types'

const EMPTY_HOOKS: LlmLaneHooks = { preCall: [], moderate: [], postCall: [], onError: [] }

/** A safe content-filtered response returned in place of a denied model call (spec §7.1). */
function filteredResponse(): ToolCompletionResponse {
  return {
    content: 'This request was blocked by a content guardrail policy.',
    tool_calls: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: FinishReason.ContentFilter,
  }
}

export class HookedLlmPort implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly shapeMainLane: RequestShaper,
    private readonly hooks: LlmLaneHooks = EMPTY_HOOKS
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

  /** Aux/compaction lane (spec §7.4): reduced set — passthrough. */
  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.inner.complete(request)
  }

  /** Main lane (spec §7): built-ins → installed pre_call/moderate → aggregate → dispatch. */
  async completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    let req = this.shapeMainLane(request)
    const contributions: Array<Contributor<ToolCompletionRequest, ToolCompletionResponse>> = []

    for (const hook of this.hooks.preCall) {
      const c = await hook.preCall(req)
      if (c) {
        contributions.push(c)
        if (c.rewrite) req = c.rewrite // already system-role-stripped + capability-gated (N4/F4)
      }
    }
    for (const hook of this.hooks.moderate) {
      const c = await hook.moderate(req)
      if (c) contributions.push(c)
    }

    if (aggregateDecision(contributions) === 'deny') {
      return filteredResponse()
    }

    let response: ToolCompletionResponse
    try {
      response = await this.inner.completeWithTools(req)
    } catch (err) {
      // on_error (spec §8.1): a gated hook may substitute a safe text-only result;
      // first substitute wins. No hook recovers → the error surfaces unchanged.
      for (const hook of this.hooks.onError) {
        const c = await hook.onError(req, err)
        if (c?.substitute) return c.substitute
      }
      throw err
    }

    // post_call (spec §8.1): redact/subtract over the result, chained in `order`.
    for (const hook of this.hooks.postCall) {
      const c = await hook.postCall(req, response)
      if (c?.substitute) response = c.substitute
    }
    return response
  }
}

/**
 * Wrap the effective (post-failover) port with the LLM-lane guardrails when any
 * built-ins OR installed hooks are configured; otherwise return it unchanged
 * (no-config compatibility, spec §5 — no extra decorator layer when unused).
 */
export function maybeWrapHookedLlmPort(
  port: LlmPort,
  config: GuardrailsConfig | undefined,
  deps: Partial<LlmLaneHookDeps> = {}
): LlmPort {
  const hasBuiltins = !!config?.builtins && config.builtins.length > 0
  const hooks = buildLlmLaneHooks(config?.hookDescriptors, {
    getAuthToken: deps.getAuthToken ?? (() => ''),
    fetchImpl: deps.fetchImpl,
  })
  const hasHooks =
    hooks.preCall.length > 0 ||
    hooks.moderate.length > 0 ||
    hooks.postCall.length > 0 ||
    hooks.onError.length > 0
  if (!hasBuiltins && !hasHooks) return port
  return new HookedLlmPort(port, buildLlmBuiltinChain(config?.builtins), hooks)
}
