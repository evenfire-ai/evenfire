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
import { classifyUnknown } from './errorClassification'
import { CodexAuthorizeError, ProviderAttemptAuthorizer } from './providerAttemptAuthorizer'
import type { LlmProvider } from './registryCore'
import type { ClassifiedError, SingleTurnProvider } from './types'

export type CodexAttemptContext = {
  invocationId?: string
  attemptGeneration?: number
  providerAttemptIndex?: number
  policyRevision: number
  policyHash: string
  hostRef?: string
  recipeNamespace?: string
  recipeName?: string
  userId?: string
}

export type CodexSubscriptionDeps = {
  authorizer: ProviderAttemptAuthorizer
  proxy: CodexLlmProxyClient
  attemptContext: () => CodexAttemptContext
}

export class CodexSubscriptionProvider implements SingleTurnProvider {
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
    if (code === 'insufficient_scope' || code === 'no_grant' || code === 'host_binding_mismatch') {
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
    return {
      content: result.text,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      usage_reported: false,
      finish_reason: result.outcome === 'canceled' ? FinishReason.Unknown : FinishReason.Stop,
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
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      usage_reported: false,
      finish_reason: result.toolCalls.length > 0 ? FinishReason.ToolUse : FinishReason.Stop,
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
    const context = this.deps.attemptContext()
    const authorized = await this.deps.authorizer.authorize({
      request,
      requestHash,
      invocationId: context.invocationId ?? request.requestId,
      attemptGeneration: context.attemptGeneration ?? 1,
      providerAttemptIndex: context.providerAttemptIndex ?? 1,
      policyRevision: context.policyRevision,
      policyHash: context.policyHash,
      hostRef: context.hostRef,
      recipeNamespace: context.recipeNamespace,
      recipeName: context.recipeName,
      userId: context.userId,
    })
    if (!('accessToken' in authorized)) {
      // Bound: authorize returns ticket material only.
    }
    return this.deps.proxy.stream({
      executionTicket: authorized.executionTicket,
      requestHash: authorized.requestHash,
      request,
      signal: options?.signal,
    })
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
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
      })),
    }
    if (tools && tools.length > 0) {
      request.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
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
