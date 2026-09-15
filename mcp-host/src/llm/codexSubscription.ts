import { randomUUID } from 'node:crypto'
import {
  type CodexCompletionRequestV1,
  hashCodexCompletionRequestV1,
} from '@clerum/llm-provider-attempt-contract'
import { LlmErrorCode } from '../core/errors'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { CodexLlmProxyClient, CodexProxyError } from './codexLlmProxyClient'
import { presentCodexTools } from './codexToolPresentation'
import { classifyUnknown } from './errorClassification'
import { CodexAuthorizeError, ProviderAttemptAuthorizer } from './providerAttemptAuthorizer'
import type { LlmProvider } from './registryCore'
import type { ClassifiedError, SingleTurnProvider } from './types'

export type CodexAttemptContext = {
  invocationId?: string
  attemptGeneration?: number
  providerAttemptIndex?: number
  pluginWorkloadSdkProviderAttemptId?: string
  targetRef?: string
  policyRevision: number
  policyHash: string
  hostRef?: string
  recipeNamespace?: string
  recipeName?: string
  userId?: string
}

function mapCodexUsage(usage?: { inputTokens: number; outputTokens: number }): {
  usage: { input_tokens: number; output_tokens: number; total_tokens: number }
  usage_reported: boolean
} {
  const inputTokens = usage?.inputTokens
  const outputTokens = usage?.outputTokens
  const usageKnown =
    typeof inputTokens === 'number' &&
    typeof outputTokens === 'number' &&
    Number.isInteger(inputTokens) &&
    Number.isInteger(outputTokens) &&
    inputTokens >= 0 &&
    outputTokens >= 0
  return {
    usage: {
      input_tokens: usageKnown ? inputTokens : 0,
      output_tokens: usageKnown ? outputTokens : 0,
      total_tokens: usageKnown ? inputTokens + outputTokens : 0,
    },
    usage_reported: usageKnown,
  }
}

export type CodexSubscriptionDeps = {
  authorizer: ProviderAttemptAuthorizer
  proxy: CodexLlmProxyClient
  attemptContext: (input: { model: string }) => CodexAttemptContext
  /**
   * #627 — how many tool definitions one request may advertise. Supplied by
   * `createCodexRuntimeDeps` from `config.codexMaxToolDefinitions` (already
   * clamped to the shared contract ceiling). Omitted only by tests and callers
   * that predate the setting, which fall back to `DEFAULT_CODEX_TOOL_CAPACITY`.
   */
  maxToolDefinitions?: number
}

/**
 * Fallback capacity when a caller supplies no explicit one. Matches the
 * `config.codexMaxToolDefinitions` default so the two cannot drift apart
 * silently: above the ~53 natives a fully-featured chat Host registers, and
 * within the shared contract's `maxToolDefinitions` ceiling.
 */
export const DEFAULT_CODEX_TOOL_CAPACITY = 64

function assertTerminalCodexOutcome(result: {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
}): void {
  if (result.outcome === 'error') {
    throw new CodexProxyError('provider_unavailable', 'proxy stream ended with an error outcome')
  }
  if (result.outcome === 'unknown' && !result.text && result.toolCalls.length === 0) {
    throw new CodexProxyError(
      'provider_unavailable',
      'proxy stream ended without a terminal outcome'
    )
  }
}

export class CodexSubscriptionProvider implements SingleTurnProvider {
  private nextProviderAttemptIndex = 1
  private readonly toolCapacity: number

  constructor(
    private readonly model: string,
    private readonly deps: CodexSubscriptionDeps
  ) {
    if (!model.trim()) {
      throw new Error('[LLM] makeProvider: codex-subscription requires an explicit model')
    }
    this.toolCapacity = deps.maxToolDefinitions ?? DEFAULT_CODEX_TOOL_CAPACITY
  }

  getProviderType(): LlmProvider {
    return 'codex-subscription'
  }

  classifyError(err: unknown): ClassifiedError {
    const code =
      err instanceof CodexAuthorizeError || err instanceof CodexProxyError ? err.code : undefined
    // Every CodexAuthorizeError throw site precedes `proxy.stream`, so an
    // authorize failure proves nothing was dispatched. A CodexProxyError knows
    // whether its own request had left the process. Anything else stays
    // undefined — an unrecognized error is not evidence of a missing call.
    const providerDispatched =
      err instanceof CodexAuthorizeError
        ? false
        : err instanceof CodexProxyError
          ? err.dispatched
          : undefined
    if (
      code === 'insufficient_scope' ||
      code === 'no_grant' ||
      code === 'host_binding_mismatch' ||
      code === 'origin_denied'
    ) {
      return {
        code: LlmErrorCode.AuthenticationFailed,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === 'budget_denied') {
      return {
        code: LlmErrorCode.InsufficientQuota,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === 'model_not_allowed') {
      return {
        code: LlmErrorCode.ModelNotAvailable,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === 'rate_limited') {
      return {
        code: LlmErrorCode.RateLimited,
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === 'provider_unavailable' || code === 'connection_unavailable') {
      return {
        code: LlmErrorCode.ModelOverloaded,
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code) {
      return {
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    return classifyUnknown(err)
  }

  async completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const result = await this.execute(messages, undefined, options)
    assertTerminalCodexOutcome(result)
    const usage = mapCodexUsage(result.usage)
    return {
      content: result.text,
      usage: usage.usage,
      usage_reported: usage.usage_reported,
      finish_reason:
        result.outcome === 'canceled' || result.outcome === 'unknown'
          ? FinishReason.Unknown
          : FinishReason.Stop,
      providerAttemptId: result.providerAttemptId,
      providerAttemptIndex: result.providerAttemptIndex,
    }
  }

  async completeSingleTurnWithTools(
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse> {
    const result = await this.execute(messages, tools, options)
    assertTerminalCodexOutcome(result)
    const usage = mapCodexUsage(result.usage)
    return {
      content: result.text || null,
      tool_calls:
        result.toolCalls.length > 0
          ? result.toolCalls.map(call => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            }))
          : null,
      usage: usage.usage,
      usage_reported: usage.usage_reported,
      finish_reason:
        result.toolCalls.length > 0
          ? FinishReason.ToolUse
          : result.outcome === 'canceled' || result.outcome === 'unknown'
            ? FinishReason.Unknown
            : FinishReason.Stop,
    }
  }

  private async execute(
    messages: CoreChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ) {
    if (options?.signal?.aborted) {
      throw new CodexProxyError('canceled', 'aborted before authorize', false)
    }
    const request = this.buildRequest(messages, tools, options)
    const requestHash = hashCodexCompletionRequestV1(request)
    const context = this.deps.attemptContext({ model: this.model })
    if (
      !Number.isInteger(context.policyRevision) ||
      context.policyRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(context.policyHash)
    ) {
      throw new CodexAuthorizeError('no_grant', 'Codex catalog policy binding is missing')
    }
    const providerAttemptIndex = context.providerAttemptIndex ?? this.nextProviderAttemptIndex++
    const authorized = await this.deps.authorizer.authorize(
      {
        request,
        requestHash,
        invocationId: context.invocationId ?? request.requestId,
        attemptGeneration: context.attemptGeneration ?? 1,
        providerAttemptIndex,
        policyRevision: context.policyRevision,
        policyHash: context.policyHash,
        hostRef: context.hostRef,
        recipeNamespace: context.recipeNamespace,
        recipeName: context.recipeName,
        userId: context.userId,
        ...(context.pluginWorkloadSdkProviderAttemptId
          ? { pluginWorkloadSdkProviderAttemptId: context.pluginWorkloadSdkProviderAttemptId }
          : {}),
        ...(context.targetRef ? { targetRef: context.targetRef } : {}),
      },
      // Authorize shares the caller's deadline. Without this the attempt could
      // keep a cancelled request alive on the control-api hop while the bridge
      // has already given up on it.
      { ...(options?.signal ? { signal: options.signal } : {}) }
    )
    if (!('accessToken' in authorized)) {
      // Bound: authorize returns ticket material only.
    }
    const streamed = await this.deps.proxy.stream({
      executionTicket: authorized.executionTicket,
      requestHash: authorized.requestHash,
      request,
      signal: options?.signal,
    })
    return {
      ...streamed,
      providerAttemptId: authorized.providerAttemptId,
      providerAttemptIndex,
    }
  }

  private buildRequest(
    messages: CoreChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: { max_tokens?: number; temperature?: number; tool_choice?: string }
  ): CodexCompletionRequestV1 {
    const request: CodexCompletionRequestV1 = {
      schemaVersion: 'codex-completion-request.v1',
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: 'codex-subscription',
      model: this.model,
      messages: messages.map(message => ({
        role: message.role,
        content: message.content ?? '',
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
        ...(message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0
          ? {
              toolCalls: message.tool_calls.map(call => ({
                id: call.id,
                name: call.name,
                arguments: call.arguments,
              })),
            }
          : {}),
      })),
    }
    if (tools && tools.length > 0) {
      const presentation = presentCodexTools(tools, { capacity: this.toolCapacity })
      // Counts and an outcome only — never tool schemas, arguments or results.
      if (presentation.outcome !== 'complete') {
        const diagnostic = {
          event: 'codex.tool_presentation',
          outcome: presentation.outcome,
          offered: tools.length,
          presented: presentation.presented.length,
          deferred: presentation.deferredCount,
          unreachable: presentation.unreachableCount,
          capacity: presentation.capacity,
        }
        // `deferred` is the designed steady state for a large catalog: every
        // deferred tool is still reachable through the discovery bridge, so it
        // is informational. `capacity_exceeded` means tools were dropped with
        // no way to reach them — the one case that is a real defect.
        if (presentation.outcome === 'capacity_exceeded') {
          console.error(JSON.stringify(diagnostic))
        } else {
          console.info(JSON.stringify(diagnostic))
        }
      }
      if (presentation.presented.length > 0) {
        request.tools = presentation.presented.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }))
      }
    }
    if (
      options?.temperature !== undefined ||
      options?.max_tokens !== undefined ||
      options?.tool_choice
    ) {
      request.generation = {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {}),
        ...(options.tool_choice === 'auto' ||
        options.tool_choice === 'none' ||
        options.tool_choice === 'required'
          ? { toolChoice: options.tool_choice }
          : {}),
      }
    }
    return request
  }
}
