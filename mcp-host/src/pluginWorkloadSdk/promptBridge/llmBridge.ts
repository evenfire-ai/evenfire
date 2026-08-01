import { LlmErrorCode } from '../../core/errors'
import { type ChatMessage, FinishReason } from '../../core/types'
import { type SingleTurnProvider, createLLMProvider } from '../../llm'
import {
  ALL_FAILOVER_CLASSES,
  type ClassifiedLike,
  type FailoverClass,
  classifyFailoverClass,
} from '../../llm/failover'
import { isLlmProvider } from '../../llm/registryCore'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import type { BrokeredCredential } from './credentialBrokerClient'

class ClassifiedProviderError extends Error {
  constructor(
    readonly classified: ClassifiedLike,
    private readonly publicError: PluginWorkloadError
  ) {
    super(publicError.message)
    this.name = 'ClassifiedProviderError'
  }

  toPluginWorkloadError(): PluginWorkloadError {
    return this.publicError
  }
}

export interface PromptBridgeCredentialResolver {
  resolve(input: {
    invocationId: string
    target: PromptBridgeTarget
    credentialTicket: string
  }): Promise<BrokeredCredential>
}

export interface LlmBridgeRequest {
  invocationId: string
  targets: Array<{ target: PromptBridgeTarget; credentialTicket: string }>
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  timeoutMs: number
  triggerOn?: FailoverClass[]
}

export interface LlmBridgeResult {
  model: string
  servedTarget: PromptBridgeTarget
  fallbackUsed: boolean
  llmSecretName: string
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

/**
 * Executes only the ordered target suffix authorized by control-api. Each
 * attempt redeems its own signed ticket and credential; credential/config
 * failures are terminal, while eligible provider failures alone advance to
 * the next authorized target.
 */
export class LlmBridge {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private static readonly MAX_TARGET_BREAKERS = 512

  constructor(
    private readonly credentials: PromptBridgeCredentialResolver,
    private readonly opts: {
      maxResponseBytes?: number
      /** Creates an isolated breaker for each effective provider target. */
      createBreaker?: (target: PromptBridgeTarget) => CircuitBreaker
      createProvider?: typeof createLLMProvider
    } = {}
  ) {
    // Breaker state is intentionally keyed by the complete target identity.
    // A provider/model/credential-slot policy can change while the mcp-host
    // remains alive, so targetRef alone is not sufficient isolation.
  }

  private breakerKey(target: PromptBridgeTarget): string {
    return [target.targetRef, target.provider, target.model, target.credentialSlot].join('\u0000')
  }

  private breakerFor(target: PromptBridgeTarget): CircuitBreaker {
    const key = this.breakerKey(target)
    const existing = this.breakers.get(key)
    if (existing) return existing

    const breaker = this.opts.createBreaker?.(target) ?? new CircuitBreaker()
    // A recipe policy is bounded, but the policy can be edited repeatedly over
    // the lifetime of a host. Keep this process-local cache bounded as well.
    if (this.breakers.size >= LlmBridge.MAX_TARGET_BREAKERS) {
      const oldest = this.breakers.keys().next().value
      if (typeof oldest === 'string') this.breakers.delete(oldest)
    }
    this.breakers.set(key, breaker)
    return breaker
  }

  async complete(request: LlmBridgeRequest): Promise<LlmBridgeResult> {
    if (request.targets.length === 0) {
      throw new PluginWorkloadError('provider_unavailable', 'no authorized provider target', false)
    }
    const triggerOn = new Set(request.triggerOn ?? ALL_FAILOVER_CLASSES)
    let lastProviderError: ClassifiedProviderError | null = null

    for (const [index, authorized] of request.targets.entries()) {
      if (!isLlmProvider(authorized.target.provider)) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'authorized provider configuration is unavailable',
          false
        )
      }

      const breaker = this.breakerFor(authorized.target)
      if (!breaker.allow()) {
        const error = new ClassifiedProviderError(
          { code: LlmErrorCode.ApiCallFailed, retryable: true },
          new PluginWorkloadError(
            'provider_unavailable',
            'LLM provider is temporarily unavailable',
            true
          )
        )
        lastProviderError = error
        const failureClass = classifyFailoverClass(
          error.classified.code,
          error.classified.retryable
        )
        const eligible = failureClass !== null && triggerOn.has(failureClass)
        if (!eligible || index === request.targets.length - 1) throw error.toPluginWorkloadError()
        continue
      }

      // Ticket redemption is deliberately inside the attempt loop. This value
      // is held only for the provider call and is never exposed in SDK output.
      const credential = await this.credentials.resolve({
        invocationId: request.invocationId,
        target: authorized.target,
        credentialTicket: authorized.credentialTicket,
      })

      try {
        const completion = await this.attempt(credential, request, breaker)
        return {
          ...completion,
          servedTarget: authorized.target,
          fallbackUsed: index > 0,
          llmSecretName: credential.llmSecretName,
        }
      } catch (error) {
        if (!(error instanceof ClassifiedProviderError)) throw error
        lastProviderError = error
        const failureClass = classifyFailoverClass(
          error.classified.code,
          error.classified.retryable
        )
        const eligible = failureClass !== null && triggerOn.has(failureClass)
        if (!eligible || index === request.targets.length - 1) throw error.toPluginWorkloadError()
      }
    }

    throw (
      lastProviderError?.toPluginWorkloadError() ??
      new PluginWorkloadError('provider_unavailable', 'authorized providers are unavailable', true)
    )
  }

  private async attempt(
    credential: BrokeredCredential,
    request: LlmBridgeRequest,
    breaker: CircuitBreaker
  ): Promise<Pick<LlmBridgeResult, 'model' | 'content' | 'usage' | 'finishReason'>> {
    const factory = this.opts.createProvider ?? createLLMProvider
    const providerId = credential.target.provider
    if (!isLlmProvider(providerId)) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'authorized provider configuration is unavailable',
        false
      )
    }
    const provider: SingleTurnProvider | null = factory(credential.keys, {
      provider: providerId,
      name: credential.target.model,
    })
    if (!provider) {
      throw new PluginWorkloadError(
        'provider_unavailable',
        'authorized provider credentials are unavailable',
        false
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
      breaker.record(true)
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
          false
        )
      }
      return {
        model: credential.target.model,
        content: response.content,
        usage: { inputTokens, outputTokens },
        finishReason: mapFinishReason(response.finish_reason),
      }
    } catch (error) {
      if (error instanceof PluginWorkloadError) throw error
      breaker.record(false)
      if (controller.signal.aborted) {
        throw new ClassifiedProviderError(
          { code: LlmErrorCode.ApiCallFailed, retryable: true },
          new PluginWorkloadError(
            'provider_unavailable',
            'LLM provider did not respond within the request timeout',
            true
          )
        )
      }
      const classified = provider.classifyError(error)
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
