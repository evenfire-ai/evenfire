import { randomUUID } from 'node:crypto'
import {
  GROK_VISUAL_LIMITS,
  type GrokCompletionRequest,
  type GrokCompletionRequestV2,
  LIMITS,
  hashCanonicalGrokRequest,
} from '@clerum/grok-provider-attempt-contract'
import { LlmErrorCode } from '../core/errors'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { logger } from '../logger'
import {
  attachmentBudgetRefusalMessageFor,
  buildAttachmentBudgetRefusals,
} from './attachmentBudgetRefusal'
import { classifyUnknown } from './errorClassification'
import { GrokLlmProxyClient, GrokProxyError } from './grokLlmProxyClient'
import { IMAGE_SOURCE_INVALID, isContextLengthRefusal, projectMessage } from './imageSource'
import { CodexAuthorizeError, ProviderAttemptAuthorizer } from './providerAttemptAuthorizer'
import { rateLimitRetryDelayMs, waitBeforeRetry } from './rateLimitRetry'
import { type LlmProvider, descriptorFor } from './registryCore'
import type { ClassifiedError, SingleTurnProvider } from './types'

export type GrokAttemptContext = {
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
 * The Grok image budget refusals, built from the Grok contract limits (see
 * `buildAttachmentBudgetRefusals`). Grok has no dimension or pixel limit, so
 * the table has only the per-image, total and whole-body rows (#784).
 */
const ATTACHMENT_BUDGET_REFUSALS = buildAttachmentBudgetRefusals({
  maxImageBytes: GROK_VISUAL_LIMITS.maxImageBytes,
  maxTotalImageBytes: GROK_VISUAL_LIMITS.maxTotalImageBytes,
  maxVisualRequestBodyBytes: LIMITS.maxVisualRequestBodyBytes,
})

/**
 * Pre-authorize rejections. These are known, non-retryable codes: the request
 * itself cannot succeed, so neither may trigger a retry or a provider fallback.
 */
const GROK_REQUEST_INVALID = 'invalid_request'
/** A local image budget refusal (`ATTACHMENT_BUDGET_REFUSALS`). */
const GROK_ATTACHMENT_TOO_LARGE = 'attachment_too_large'

function mapGrokUsage(usage?: { inputTokens: number; outputTokens: number }): {
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

export type GrokSubscriptionDeps = {
  authorizer: ProviderAttemptAuthorizer
  proxy: GrokLlmProxyClient
  attemptContext: (input: { model: string }) => GrokAttemptContext
}

function assertTerminalGrokOutcome(result: {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
}): void {
  if (result.toolCalls.length > LIMITS.maxToolCalls) {
    throw new GrokProxyError('tool_call_limit_exceeded', `tool calls exceed ${LIMITS.maxToolCalls}`)
  }
  if (result.toolCalls.length > 0 && result.outcome !== 'success') {
    throw new GrokProxyError(
      'provider_unavailable',
      'tool calls require a successful terminal outcome'
    )
  }
  if (result.outcome === 'error') {
    throw new GrokProxyError('provider_unavailable', 'proxy stream ended with an error outcome')
  }
  if (result.outcome === 'unknown' && !result.text && result.toolCalls.length === 0) {
    throw new GrokProxyError(
      'provider_unavailable',
      'proxy stream ended without a terminal outcome'
    )
  }
  // Only `success` may become a completion. Partial text from an unknown
  // terminal state or a cancellation is interrupted output: surfacing it as a
  // finished answer would let callers ack it as complete and count it as a
  // healthy call. The request was already dispatched, so keep it fenced.
  if (result.outcome === 'unknown') {
    throw new GrokProxyError(
      'outcome_unknown',
      'proxy stream ended without a successful terminal outcome'
    )
  }
  if (result.outcome === 'canceled') {
    throw new GrokProxyError(
      'canceled',
      'proxy stream was canceled before a successful terminal outcome'
    )
  }
}

export class GrokSubscriptionProvider implements SingleTurnProvider {
  readonly requiresImageSourceIdentity =
    descriptorFor('grok-subscription').requiresImageSourceIdentity === true
  private nextProviderAttemptIndex = 1

  constructor(
    private readonly model: string,
    private readonly deps: GrokSubscriptionDeps
  ) {
    if (!model.trim()) {
      throw new Error('[LLM] makeProvider: grok-subscription requires an explicit model')
    }
  }

  getProviderType(): LlmProvider {
    return 'grok-subscription'
  }

  classifyError(err: unknown): ClassifiedError {
    const code =
      err instanceof CodexAuthorizeError || err instanceof GrokProxyError ? err.code : undefined
    // Every CodexAuthorizeError throw site precedes `proxy.stream`, so an
    // authorize failure proves nothing was dispatched. A GrokProxyError knows
    // whether its own request had left the process. Anything else stays
    // undefined — an unrecognized error is not evidence of a missing call.
    const providerDispatched =
      err instanceof CodexAuthorizeError
        ? false
        : err instanceof GrokProxyError
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
    if (code === 'client_upgrade_required') {
      // Not retryable and not an outage: xAI refused the client identity, so a
      // human has to act (upgrade the Grok client Evenfire presents).
      return {
        code: LlmErrorCode.ModelNotAvailable,
        retryable: false,
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
    if (code === 'stream_duration_exceeded') {
      // Not retryable: the proxy already spent the attempt's whole stream
      // budget. A retry or a failover would spend it again on the same turn.
      return {
        code: LlmErrorCode.StreamDurationExceeded,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === GROK_ATTACHMENT_TOO_LARGE) {
      // An attached image broke a contract image budget. A shorter
      // conversation cannot fix it and neither can another provider, so it is
      // terminal; the message already names the limit for the user.
      return {
        code: LlmErrorCode.InvalidAttachment,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    if (code === IMAGE_SOURCE_INVALID) {
      // A host producer attached an image with no usable provenance source. The
      // same messages fail the same way on every provider, so it is terminal:
      // neither a retry nor a failover can fix it. The arm is explicit so a
      // change to the generic arm below cannot make it retryable.
      return {
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    // Same family as `request_limit_exceeded`, from the response side: the
    // transport refused a tool call whose arguments overran its size budget.
    // Treating it as an outage would retry the identical oversized call and,
    // being failover-eligible, spend a second provider on it.
    // `payload_too_large` is the proxy's 413 for an envelope over its body
    // limit: the same size refusal of this conversation, one hop later (#731).
    // `context_length_exceeded` is the upstream's refusal of a prompt over the
    // model's context window, forwarded by the proxy (R10).
    if (
      code === 'request_limit_exceeded' ||
      code === 'tool_call_arguments_exceeded' ||
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
    // The proxy's 408 for a body upload over its read deadline: the upstream
    // never saw the body. Not an outage, so never retryable: a retryable class
    // would put this provider in failover cooldown for the Host's own slow
    // upload (#739).
    if (code === 'request_timeout') {
      return {
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    // control-api's 403 for a redeem that arrived after the execution ticket's
    // `exp`, passed through by the proxy. The request waited in admission and
    // never reached the provider: a capacity race, not a defect. Retryable, so
    // the next attempt re-authorizes with a fresh ticket; the failover class is
    // `provider_unavailable`. `ticket_replayed` and `ticket_invalid` are
    // defects and stay terminal in the generic arm below (#739).
    if (code === 'ticket_expired') {
      return {
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'execution ticket expired before redeem; re-authorize',
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    // A control-plane hop no live process answered (#720): retryable, with the
    // failover class of the overload arm below; only the label differs.
    if (code === 'control_plane_unavailable') {
      return {
        code: LlmErrorCode.ControlPlaneUnavailable,
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(providerDispatched !== undefined ? { providerDispatched } : {}),
      }
    }
    // An upstream 4xx the proxy could not map (#720): the same request gets
    // the same answer, so it is terminal and has its own label.
    // httpStatus is the upstream's own status, when the proxy sent it (R1-H2).
    if (code === 'upstream_rejected') {
      const upstreamStatus = err instanceof GrokProxyError ? err.upstreamStatus : undefined
      return {
        code: LlmErrorCode.UpstreamRejected,
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
        providerCode: code,
        ...(upstreamStatus !== undefined ? { httpStatus: upstreamStatus } : {}),
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
    assertTerminalGrokOutcome(result)
    const usage = mapGrokUsage(result.usage)
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
    assertTerminalGrokOutcome(result)
    const usage = mapGrokUsage(result.usage)
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
      throw new GrokProxyError('canceled', 'aborted before authorize', { dispatched: false })
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
    const canonical = hashCanonicalGrokRequest(this.buildRequest(messages, tools, options))
    if (!canonical.ok) {
      // A conversation-volume refusal (bytes, element bound, message count,
      // tool-call count) is a context-length failure, not a malformed request;
      // it is thrown before authorize and dispatch so no provider attempt is
      // spent. Reported as `invalid_request` it reached the UI as "Connection
      // Error", a label that reads as transient, and invited a retry that
      // reproduced it (#731). The message-count guard above already used this
      // classification, and #728 left this path behind when it added that
      // guard. An image budget is an attachment failure with its own
      // user-facing message (#784). Any other `size` refusal stays
      // `payload_too_large`, which reaches the user as a context-length
      // failure. The order is the Codex one.
      const attachmentRefusal =
        canonical.code === 'limit'
          ? attachmentBudgetRefusalMessageFor(
              ATTACHMENT_BUDGET_REFUSALS,
              canonical.message,
              messages.some(message => message.contentParts?.some(part => part.type === 'image'))
            )
          : undefined
      if (attachmentRefusal !== undefined) {
        throw new CodexAuthorizeError(GROK_ATTACHMENT_TOO_LARGE, attachmentRefusal)
      }
      throw new CodexAuthorizeError(
        isContextLengthRefusal(canonical.code, canonical.message)
          ? 'request_limit_exceeded'
          : canonical.kind === 'size'
            ? 'payload_too_large'
            : GROK_REQUEST_INVALID,
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
      throw new CodexAuthorizeError('no_grant', 'Grok catalog policy binding is missing')
    }
    const attempt = async (providerAttemptIndex: number) => {
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
    try {
      return await attempt(context.providerAttemptIndex ?? this.nextProviderAttemptIndex++)
    } catch (err) {
      // G1-9 (#720): a 429 that advised a short Retry-After is retried once,
      // after that delay, under a new authorize: a redeemed ticket cannot be
      // reused. The 429 may come from the proxy or from control-api's
      // authorize limiter (G1-11). A caller that pins the attempt index owns
      // its own retries.
      const waitMs =
        context.providerAttemptIndex === undefined &&
        (err instanceof GrokProxyError || err instanceof CodexAuthorizeError)
          ? rateLimitRetryDelayMs(err.code, err.retryAfterMs)
          : undefined
      if (waitMs === undefined) throw err
      await waitBeforeRetry(waitMs, options?.signal)
      // The wait stops watching the signal once its timer fires: an abort in
      // that gap must not reach a second authorize (G1-12).
      options?.signal?.throwIfAborted()
      return attempt(this.nextProviderAttemptIndex++)
    }
  }

  private buildRequest(
    messages: CoreChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: { max_tokens?: number; temperature?: number; tool_choice?: string }
  ): GrokCompletionRequest {
    const projectedMessages = messages.map(message => projectMessage(message, GROK_REQUEST_INVALID))
    const request: Omit<GrokCompletionRequestV2, 'schemaVersion'> = {
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: 'grok-subscription',
      model: this.model,
      messages: projectedMessages,
    }
    if (tools && tools.length > 0) {
      // Presentation is owned by the agent loop. Preserve its final definitions
      // in both the authorized hash and the proxy request; MCP names are not
      // permissions and must never be discarded by the provider adapter.
      logger.debug(
        { provider: 'grok-subscription', presentedCount: tools.length },
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
    // V1 stays byte-identical for a turn with no contentParts. One message with
    // parts, even text-only parts left by redaction, moves the whole request to
    // V2, the only version that carries them.
    if (!projectedMessages.some(message => message.contentParts !== undefined)) {
      return { schemaVersion: 'grok-completion-request.v1', ...request }
    }
    return { schemaVersion: 'grok-completion-request.v2', ...request }
  }
}
