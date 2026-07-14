import { type ChatMessage, FinishReason } from '../../core/types'
import { type SingleTurnProvider, createLLMProvider } from '../../llm'
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
 */

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

    const model = request.model ?? context.defaultModel
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
      if (err instanceof PluginWorkloadError) throw err
      this.breaker.record(false)
      if (controller.signal.aborted) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'LLM provider did not respond within the request timeout',
          true
        )
      }
      const classified = provider.classifyError(err)
      throw new PluginWorkloadError(
        'provider_unavailable',
        `LLM provider error: ${classified.code}`,
        classified.retryable
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
