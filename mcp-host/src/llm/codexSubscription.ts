import { randomUUID } from 'node:crypto'
import {
  type CodexCompletionRequestV1,
  LIMITS,
  hashCanonicalCodexRequest,
} from '@clerum/llm-provider-attempt-contract'
import { LlmErrorCode } from '../core/errors'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { logger } from '../logger'
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

/**
 * The contract `limit` refusals that mean "this turn carries too much".
 *
 * `fail('limit', …)` guards eight checks, and only these are about volume: the
 * real byte bound (`index.cjs:391`), the element bound that proxies it
 * (`:193`), `maxMessages` (`:239`) and `messages[i].toolCalls` (`:266`).
 * All four are "this conversation is too long", which is exactly what
 * `ContextLengthExceeded` — "Conversation Too Long" — promises the user.
 * Compaction reaches them unevenly. The context manager counts bytes and,
 * through the registry's `maxMessages`, the message count, so it compacts
 * before either bound; a single turn holding more than `maxMessages`
 * messages stays unshrinkable, because the cut never lands inside a turn.
 * `maxToolCalls` also bounds every response, so only history produced by
 * another provider can carry an over-long `toolCalls` array.
 *
 * The other four are not. Nesting depth (`:180`, `:215`),
 * `generation.maxOutputTokens` and `deadlineMs` out of range are malformed or
 * out-of-range parameters, and a shorter conversation fixes none of them;
 * labelling them a context-length failure would send the user into a
 * compaction loop that cannot converge. They stay `invalid_request`, which is
 * what `subscriptionRequestHash.test.ts:155-168` pins for the over-deep schema.
 *
 * `hashCanonicalCodexRequest` returns `{ ok, code, message }` and nothing else,
 * so the message is the only discriminator available at this boundary (#731).
 * The byte pattern is a prefix so it keeps matching once the element bound gets
 * its own distinct wording.
 *
 * `messages exceed` is defence in depth rather than a reachable branch: the
 * guard below raises that exact message with this same classification before
 * `hashCanonicalCodexRequest` runs, so the contract's own copy of it only
 * arrives here if that guard is ever removed.
 */
const CONTEXT_LENGTH_REFUSALS = [
  /^request exceeds maxRequestBodyBytes/,
  /^messages exceed \d+$/,
  /^messages\[\d+\]\.toolCalls exceed \d+$/,
]

function isContextLengthRefusal(code: string, message: string): boolean {
  return code === 'limit' && CONTEXT_LENGTH_REFUSALS.some(pattern => pattern.test(message))
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

function assertTerminalCodexOutcome(result: {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
}): void {
  if (result.toolCalls.length > LIMITS.maxToolCalls) {
    // Defence in depth: codex-llm-proxy enforces the same limit first.
    throw new CodexProxyError(
      'tool_call_limit_exceeded',
      `tool calls exceed ${LIMITS.maxToolCalls}`
    )
  }
  if (result.toolCalls.length > 0 && result.outcome !== 'success') {
    throw new CodexProxyError(
      'provider_unavailable',
      'tool calls require a successful terminal outcome'
    )
  }
  if (result.outcome === 'error') {
    throw new CodexProxyError('provider_unavailable', 'proxy stream ended with an error outcome')
  }
  if (result.outcome === 'unknown' && !result.text && result.toolCalls.length === 0) {
    throw new CodexProxyError(
      'provider_unavailable',
      'proxy stream ended without a terminal outcome'
    )
  }
  // Only `success` may become a completion. Partial text from an unknown
  // terminal state or a cancellation is interrupted output: surfacing it as a
  // finished answer would let callers ack it as complete and count it as a
  // healthy call. The request was already dispatched, so keep it fenced.
  if (result.outcome === 'unknown') {
    throw new CodexProxyError(
      'outcome_unknown',
      'proxy stream ended without a successful terminal outcome'
    )
  }
  if (result.outcome === 'canceled') {
    throw new CodexProxyError(
      'canceled',
      'proxy stream was canceled before a successful terminal outcome'
    )
  }
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
    if (code === 'tool_call_limit_exceeded') {
      // Not retryable: `retryable: true` would make this error
      // failover-eligible and enable the workflow fallback after tool
      // results, re-running the turn on another provider. The limit is a
      // contract rejection of the model output, not a provider outage.
      return {
        code: LlmErrorCode.ToolCallLimitExceeded,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === 'invalid_tool_arguments') {
      // The proxy refused a tool call whose arguments are not a JSON object.
      // Same reasoning as the limit above: the model output is invalid, and a
      // retry or failover would re-run the turn on a rejected response.
      return {
        code: LlmErrorCode.InvalidResponse,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    // `payload_too_large` is the proxy's 413 for an envelope over its body
    // limit: the same size refusal of this conversation, one hop later.
    // `context_length_exceeded` is the upstream's refusal of a request over the
    // model's context window, forwarded by the proxy (#731).
    if (
      code === 'request_limit_exceeded' ||
      code === 'payload_too_large' ||
      code === 'context_length_exceeded'
    ) {
      return {
        code: LlmErrorCode.ContextLengthExceeded,
        retryable: false,
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
      finish_reason: FinishReason.Stop,
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
      throw new CodexProxyError('canceled', 'aborted before authorize', false)
    }
    // An over-long history is reported as a context-length failure instead of
    // a generic invalid request; it is thrown before authorize and dispatch.
    if (messages.length > LIMITS.maxMessages) {
      throw new CodexAuthorizeError(
        'request_limit_exceeded',
        `messages exceed ${LIMITS.maxMessages}`
      )
    }
    // Hash and send the validated wire projection — exactly what control-api
    // authorize and the proxy re-derive. Hashing the locally built object let
    // shapes the parser normalizes away (an empty `generation` from a
    // tool-name tool_choice, empty tools/hints) fail authorize with a
    // requestHash mismatch. An invalid request never leaves the process.
    const canonical = hashCanonicalCodexRequest(this.buildRequest(messages, tools, options))
    if (!canonical.ok) {
      // A size refusal (bytes, element bound, message count, tool-call count)
      // is a context-length failure, not a malformed request; it is thrown
      // before authorize and dispatch so no provider attempt is spent.
      // Reported as `invalid_request` it reached the UI as "Connection Error",
      // a label that reads as transient, and invited a retry that reproduced it
      // (#731). The message-count guard above already used this classification.
      throw new CodexAuthorizeError(
        isContextLengthRefusal(canonical.code, canonical.message)
          ? 'request_limit_exceeded'
          : 'invalid_request',
        canonical.message
      )
    }
    const { request, requestHash } = canonical.value
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
      // Presentation is owned by the agent loop. Preserve its final definitions
      // in both the authorized hash and the proxy request; MCP names are not
      // permissions and must never be discarded by the provider adapter.
      logger.debug(
        { provider: 'codex-subscription', presentedCount: tools.length },
        'Tool definitions prepared for authorization'
      )
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
