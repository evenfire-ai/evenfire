import { randomUUID } from 'node:crypto'
import {
  type CodexCompletionRequestV1,
  LIMITS,
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
}

/**
 * Codex authorize is capped at `LIMITS.maxTools` (32). MCP tools use
 * `serverName__toolName`; native tools are unprefixed or `clerum__*`.
 * Drop MCP tools first so a Host with a large MCP catalog can still
 * authorize. If natives still exceed the cap, keep the leading native
 * slice in registry order.
 */
export function isCodexNativeToolName(name: string): boolean {
  const idx = name.indexOf('__')
  if (idx <= 0) return true
  return name.startsWith('clerum__')
}

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

export function selectCodexAdvertisedTools(tools: ToolDefinition[]): ToolDefinition[] {
  const natives = tools.filter(tool => isCodexNativeToolName(tool.name))
  if (natives.length <= LIMITS.maxTools) return natives
  return natives.slice(0, LIMITS.maxTools)
}

export class CodexSubscriptionProvider implements SingleTurnProvider {
  private nextProviderAttemptIndex = 1

  constructor(
    private readonly model: string,
    private readonly deps: CodexSubscriptionDeps
  ) {
    if (!model.trim()) {
      throw new Error('[LLM] makeProvider: codex-subscription requires an explicit model')
    }
  }

  getProviderType(): LlmProvider {
    return 'codex-subscription'
  }

  classifyError(err: unknown): ClassifiedError {
    const code =
      err instanceof CodexAuthorizeError || err instanceof CodexProxyError ? err.code : undefined
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
      }
    }
    if (code === 'budget_denied') {
      return {
        code: LlmErrorCode.InsufficientQuota,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
      }
    }
    if (code === 'model_not_allowed') {
      return {
        code: LlmErrorCode.ModelNotAvailable,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
      }
    }
    if (code === 'rate_limited') {
      return {
        code: LlmErrorCode.RateLimited,
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
      }
    }
    if (code === 'provider_unavailable' || code === 'connection_unavailable') {
      return {
        code: LlmErrorCode.ModelOverloaded,
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
      }
    }
    if (code) {
      return {
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
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
      throw new CodexProxyError('canceled', 'aborted before authorize')
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
    const authorized = await this.deps.authorizer.authorize({
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
    })
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
      const advertised = selectCodexAdvertisedTools(tools)
      if (advertised.length !== tools.length) {
        console.warn(
          `[Codex] advertised ${advertised.length} native tool(s) of ${tools.length} offered (MCP omitted, cap ${LIMITS.maxTools})`
        )
      }
      if (advertised.length > 0) {
        request.tools = advertised.map(tool => ({
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
