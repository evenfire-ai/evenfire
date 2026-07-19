import { LlmErrorCode } from '../../core/errors'
import { type ChatMessage, FinishReason } from '../../core/types'
import { type SingleTurnProvider, createLLMProvider } from '../../llm'
import {
  ALL_FAILOVER_CLASSES,
  type ClassifiedLike,
  type FailoverClass,
  FailoverEngine,
  type LlmPolicy,
  type ModelPair,
} from '../../llm/failover'
import type { ApiKeys, ModelConfig } from '../../types'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError } from '../domain/errors'

/**
 * LLM bridge (plan §3.3 step 5, OQ-2): executes the authorized one-shot
 * completion against the provider bound to THIS mcp-host. The provider is
 * never selectable per request — only the model within it. Inference-only:
 * no tools, no session state (v1 invariant).
 *
 * Provider circuit breaker (plan §3.4): >50% failures over 30s opens the
 * circuit; subsequent calls return provider_unavailable until a 60s quiet
 * period elapses.
 *
 * Provider-fallback (R5 F6, spec §3-R5.7): when the caller supplies
 * `fallbackModels` (derived from the grant's `allowedModels`), an eligible
 * classified failure (`triggerOn`) switches to the next allowed model of the
 * SAME provider and retries the request. The bridge NEVER switches provider —
 * so, by construction, a fallback model always belongs to the grant's allowlist
 * (outside the grant = no switch, the original error propagates). The failover
 * decision runs on `classifyError(err).code`; the existing circuit breaker still
 * records every attempt (all classes) but stays OUTSIDE the trigger mechanism —
 * the reusable {@link FailoverEngine} decides the switch. Only the winning call
 * returns (and therefore meters, in the handler's `onUsage`).
 */

/**
 * Internal carrier: an attempt that failed with a provider error, holding both
 * the failover classification (for the engine) and the ready
 * {@link PluginWorkloadError} to surface once the ordered list is exhausted.
 * Non-eligible failures (our own guardrails) are thrown as `PluginWorkloadError`
 * directly and propagate unchanged — the engine's classifier returns `null`.
 */
class ClassifiedProviderError extends Error {
  constructor(
    readonly classified: ClassifiedLike,
    private readonly pwe: PluginWorkloadError
  ) {
    super(pwe.message)
    this.name = 'ClassifiedProviderError'
  }

  toPluginWorkloadError(): PluginWorkloadError {
    return this.pwe
  }
}

export interface LlmBridgeContext {
  keys: ApiKeys
  provider: ModelConfig['provider']
  defaultModel: string
}

export interface LlmBridgeRequest {
  model: string | null
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  timeoutMs: number
  /**
   * R5 F6 — ordered same-provider fallback models. Each MUST be a model the
   * grant permits (the caller derives this from the grant's `allowedModels`);
   * the bridge never switches provider, so a fallback is always inside the
   * grant. Empty/absent = no failover = byte-identical to today's single call.
   */
  fallbackModels?: string[]
  /**
   * R5 F6 — failover classes that trigger a switch. Default: all four
   * ({@link ALL_FAILOVER_CLASSES}). 400/validation is never eligible.
   */
  triggerOn?: FailoverClass[]
}

export interface LlmBridgeResult {
  model: string
  content: string
  usage: { inputTokens: number; outputTokens: number }
  finishReason: 'complete' | 'length' | 'content_filter'
}

const DEFAULT_MAX_LLM_RESPONSE_BYTES = 1024 * 1024

function mapFinishReason(reason: FinishReason): LlmBridgeResult['finishReason'] {
  if (reason === FinishReason.Length) return 'length'
  if (reason === FinishReason.ContentFilter) return 'content_filter'
  return 'complete'
}

export class LlmBridge {
  private readonly breaker: CircuitBreaker

  constructor(
    private readonly getContext: () => LlmBridgeContext | null,
    private readonly opts: {
      maxResponseBytes?: number
      breaker?: CircuitBreaker
      createProvider?: typeof createLLMProvider
    } = {}
  ) {
    this.breaker = opts.breaker ?? new CircuitBreaker()
  }

  async complete(request: LlmBridgeRequest): Promise<LlmBridgeResult> {
    if (!this.breaker.allow()) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'LLM provider circuit breaker is open',
        true
      )
    }

    const context = this.getContext()
    if (!context) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'no LLM provider is configured on this mcp-host',
        true
      )
    }

    const primaryModel = request.model ?? context.defaultModel
    const fallbackModels = this.resolveFallbackModels(request.fallbackModels, primaryModel)

    // No fallback configured → the single-attempt path, byte-identical to before
    // (R5 §3-R5.1: "sin política = comportamiento actual").
    if (fallbackModels.length === 0) {
      try {
        return await this.attempt(context, primaryModel, request)
      } catch (err) {
        throw err instanceof ClassifiedProviderError ? err.toPluginWorkloadError() : err
      }
    }

    // Per-call engine: a promptBridge request is a stateless one-shot, so the
    // sticky cooldown across requests is irrelevant — the engine is used purely
    // for its ordered attempt loop + eligibility classification + metric.
    const policy: LlmPolicy = {
      cooldownSeconds: 0,
      triggerOn: request.triggerOn ?? [...ALL_FAILOVER_CLASSES],
      fallbacks: fallbackModels.map(model => ({ provider: context.provider, model })),
    }
    const engine = new FailoverEngine(policy)
    const primaryPair: ModelPair = { provider: context.provider, model: primaryModel }
    try {
      return await engine.run(
        primaryPair,
        target => () => this.attempt(context, target.model, request),
        err => (err instanceof ClassifiedProviderError ? err.classified : null)
      )
    } catch (err) {
      throw err instanceof ClassifiedProviderError ? err.toPluginWorkloadError() : err
    }
  }

  /**
   * Dedupe fallback models against the primary + each other, preserving order.
   * The list arrives already gated to the grant's `allowedModels`, so nothing
   * here can widen it.
   */
  private resolveFallbackModels(raw: string[] | undefined, primaryModel: string): string[] {
    if (!raw || raw.length === 0) return []
    const seen = new Set<string>([primaryModel])
    const out: string[] = []
    for (const model of raw) {
      if (typeof model === 'string' && model.length > 0 && !seen.has(model)) {
        seen.add(model)
        out.push(model)
      }
    }
    return out
  }

  /**
   * One completion attempt against `model` (same provider). On success records
   * the breaker + returns the served pair; on an eligible provider failure
   * throws a {@link ClassifiedProviderError} (so the engine can switch); on a
   * guardrail failure (payload/usage/no-key) throws a `PluginWorkloadError`
   * (non-eligible → propagates unchanged).
   */
  private async attempt(
    context: LlmBridgeContext,
    model: string,
    request: LlmBridgeRequest
  ): Promise<LlmBridgeResult> {
    const factory = this.opts.createProvider ?? createLLMProvider
    const provider: SingleTurnProvider | null = factory(context.keys, {
      provider: context.provider,
      name: model,
    })
    if (!provider) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'LLM provider could not be constructed (missing API key)',
        true
      )
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      const response = await provider.completeSingleTurn(request.messages as ChatMessage[], {
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        signal: controller.signal,
      })
      this.breaker.record(true)

      const maxBytes = this.opts.maxResponseBytes ?? DEFAULT_MAX_LLM_RESPONSE_BYTES
      if (Buffer.byteLength(response.content, 'utf8') > maxBytes) {
        throw new PluginWorkloadError(
          'payload_too_large',
          'LLM response exceeded the maximum buffer size'
        )
      }
      const inputTokens = response.usage?.input_tokens ?? 0
      const outputTokens = response.usage?.output_tokens ?? 0
      if (inputTokens < 0 || outputTokens < 0) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'provider returned invalid usage',
          true
        )
      }

      return {
        model,
        content: response.content,
        usage: { inputTokens, outputTokens },
        finishReason: mapFinishReason(response.finish_reason),
      }
    } catch (err) {
      // Our own guardrails (payload/usage/no-key) are not provider failures:
      // propagate unchanged, never fail over.
      if (err instanceof PluginWorkloadError) throw err
      this.breaker.record(false)
      if (controller.signal.aborted) {
        throw new ClassifiedProviderError(
          // A timeout is a retryable transport failure → provider_unavailable.
          { code: LlmErrorCode.ApiCallFailed, retryable: true },
          new PluginWorkloadError(
            'provider_unavailable',
            'LLM provider did not respond within the request timeout',
            true
          )
        )
      }
      const classified = provider.classifyError(err)
      throw new ClassifiedProviderError(
        { code: classified.code, retryable: classified.retryable },
        new PluginWorkloadError(
          'provider_unavailable',
          `LLM provider error: ${classified.code}`,
          classified.retryable
        )
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
