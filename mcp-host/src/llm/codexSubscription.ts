import { randomUUID } from 'node:crypto'
import {
  type CodexCompletionRequest,
  LIMITS,
  VISUAL_LIMITS,
  hashCanonicalCodexRequest,
} from '@clerum/llm-provider-attempt-contract'
import { LlmErrorCode } from '../core/errors'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  MessageContentImageSource,
  MessageContentPart,
  ToolCompletionResponse,
  ToolDefinition,
  textContentFromParts,
} from '../core/types'
import { logger } from '../logger'
import { CodexLlmProxyClient, CodexProxyError } from './codexLlmProxyClient'
import { classifyUnknown } from './errorClassification'
import { CodexAuthorizeError, ProviderAttemptAuthorizer } from './providerAttemptAuthorizer'
import { type LlmProvider, descriptorFor } from './registryCore'
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
 * Of the `fail('limit', …)` checks on a request, only these are about
 * conversation volume, all in `llm-provider-attempt-contract/index.cjs`: the
 * real byte bound and its non-image share on a V2 request (both in
 * `parseCodexCompletionRequestRoot`), the element bound that proxies it
 * (`checkStructure`), and `maxMessages` and `messages[i].toolCalls` (both in
 * `parseMessages`).
 * All five are "this conversation is too long", which is exactly what
 * `ContextLengthExceeded` — "Conversation Too Long" — promises the user.
 * Compaction reaches them unevenly. The context manager counts bytes and,
 * through the registry's `maxMessages`, the message count, so it compacts
 * before either bound; a single turn holding more than `maxMessages`
 * messages stays unshrinkable, because the cut never lands inside a turn.
 * `maxToolCalls` also bounds every response, so only history produced by
 * another provider can carry an over-long `toolCalls` array.
 *
 * The others are not. Nesting depth (`checkStructure`, `assertFiniteTree`),
 * `generation.maxOutputTokens` (`parseGeneration`) and `deadlineMs`
 * (`parseCodexCompletionRequestRoot`) out of range are malformed or
 * out-of-range parameters, and a shorter conversation fixes none of them;
 * labelling them a context-length failure would send the user into a
 * compaction loop that cannot converge. They stay `invalid_request`, which is
 * what "fails an over-deep tool schema locally without a stack overflow" in
 * `subscriptionRequestHash.test.ts` pins for the over-deep schema.
 * The image budgets belong to the attachments, not the conversation: a `size`
 * one is `attachment_too_large` (see `ATTACHMENT_BUDGET_REFUSALS`), the
 * `maxImages` `count` one stays `invalid_request`.
 *
 * `hashCanonicalCodexRequest` also returns a `kind`, but it cannot replace the
 * message here: `size` covers the conversation bytes and the image byte and
 * dimension budgets alike, and `count` covers `maxMessages` and `maxImages`
 * alike. A shorter conversation fixes the first of each pair and none of the
 * second, so the message stays the discriminator at this boundary (#731). The
 * byte pattern is a prefix so it covers both the element bound and the
 * `outside image data` check of a V2 request.
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

const BYTES_PER_MIB = 1024 * 1024

/**
 * The contract `size` refusals that an attached image caused, each with the
 * sentence the user reads. The Desktop renders the classified message as the
 * error bubble under "Invalid Attachment", so the sentence names the limit the
 * image broke; the numbers come from the contract's own limits.
 *
 * The per-image messages carry a `messages[i].contentParts[j]: ` prefix, so
 * they are anchored at the end only. `maxImagePixels` equals
 * `maxImageDimension` squared and the dimension check runs first, so the pixel
 * refusal is unreachable with today's limits; it is mapped so a looser pixel
 * limit cannot reach the user as a raw contract string.
 *
 * The V2 whole-body ceiling (`maxVisualRequestBodyBytes`) is checked before any
 * part is parsed. It is an attachment refusal only when the request carries an
 * image: a V2 request whose text alone crosses it is a conversation that is too
 * long, and blaming an attachment the user never sent would be false.
 */
const ATTACHMENT_BUDGET_REFUSALS: ReadonlyArray<{
  pattern: RegExp
  requiresImage: boolean
  userMessage: string
}> = [
  {
    pattern: /image exceeds \d+ decoded bytes$/,
    requiresImage: false,
    userMessage: `An attached image is too large: it exceeds ${VISUAL_LIMITS.maxImageBytes / BYTES_PER_MIB} MiB. Reduce its size and send it again.`,
  },
  {
    pattern: /image dimension exceeds \d+$/,
    requiresImage: false,
    userMessage: `An attached image is too large: its width or height exceeds ${VISUAL_LIMITS.maxImageDimension} pixels. Resize it and send it again.`,
  },
  {
    pattern: /image pixel count exceeds \d+$/,
    requiresImage: false,
    userMessage: `An attached image is too large: it has more than ${VISUAL_LIMITS.maxImagePixels.toLocaleString('en-US')} pixels. Resize it and send it again.`,
  },
  {
    pattern: /^request exceeds \d+ total image bytes$/,
    requiresImage: false,
    userMessage: `The attached images are too large together: they exceed ${VISUAL_LIMITS.maxTotalImageBytes / BYTES_PER_MIB} MiB in total. Send fewer or smaller images.`,
  },
  {
    pattern: /^request exceeds maxVisualRequestBodyBytes$/,
    requiresImage: true,
    userMessage: `The message and its attached images are too large together: they exceed ${LIMITS.maxVisualRequestBodyBytes / BYTES_PER_MIB} MiB. Send fewer or smaller images.`,
  },
]

/**
 * The user-facing sentence for a contract refusal caused by an attached image,
 * or `undefined` when the refusal is not an image budget.
 */
export function attachmentBudgetRefusalMessage(
  contractMessage: string,
  requestCarriesImage: boolean
): string | undefined {
  return ATTACHMENT_BUDGET_REFUSALS.find(
    refusal =>
      refusal.pattern.test(contractMessage) && (requestCarriesImage || !refusal.requiresImage)
  )?.userMessage
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
 * Pre-authorize rejections. These are known, non-retryable codes: the request
 * itself cannot succeed, so neither may trigger a retry or a provider fallback.
 */
const CODEX_REQUEST_INVALID = 'invalid_request'
const CODEX_IMAGE_SOURCE_INVALID = 'image_source_invalid'
/** A local image budget refusal (`ATTACHMENT_BUDGET_REFUSALS`). */
const CODEX_ATTACHMENT_TOO_LARGE = 'attachment_too_large'

/** One image part as the Codex V2 contract serializes it. */
type ProjectedImagePart = {
  type: 'image'
  mimeType: 'image/jpeg' | 'image/png'
  data: string
  source: MessageContentImageSource
}

/** One message as either contract version serializes it. */
type ProjectedMessage = {
  role: CoreChatMessage['role']
  content: string
  contentParts?: Array<{ type: 'text'; text: string } | ProjectedImagePart>
  name?: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

/**
 * Provenance for one image part. The shared contract requires a source on every
 * Codex V2 image and bounds its id charset; this checks only presence and shape,
 * so the contract stays the single owner of format and size limits.
 */
function imageSourceError(detail: string): CodexAuthorizeError {
  return new CodexAuthorizeError(
    CODEX_IMAGE_SOURCE_INVALID,
    `image part has no usable provenance source (${detail}); host producers must attach the attachment or tool call it came from`
  )
}

function projectImageSource(
  part: Extract<MessageContentPart, { type: 'image' }>
): MessageContentImageSource {
  const source = part.source
  if (!source) throw imageSourceError('missing source')
  if (source.kind === 'attachment') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.messageId?.trim()) throw imageSourceError('empty messageId')
    return {
      kind: 'attachment',
      attachmentId: source.attachmentId,
      messageId: source.messageId,
    }
  }
  if (source.kind === 'tool') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.toolCallId?.trim()) throw imageSourceError('empty toolCallId')
    return { kind: 'tool', attachmentId: source.attachmentId, toolCallId: source.toolCallId }
  }
  throw imageSourceError('unknown source kind')
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
  readonly requiresImageSourceIdentity =
    descriptorFor('codex-subscription').requiresImageSourceIdentity === true
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
    if (code === CODEX_ATTACHMENT_TOO_LARGE) {
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
      // A conversation-volume refusal (bytes, element bound, message count,
      // tool-call count) is a context-length failure, not a malformed request;
      // it is thrown before authorize and dispatch so no provider attempt is
      // spent. Reported as `invalid_request` it reached the UI as "Connection
      // Error", a label that reads as transient, and invited a retry that
      // reproduced it (#731). The message-count guard above already used this
      // classification. An image budget is an attachment failure with its own
      // user-facing message. Any other `size` refusal stays
      // `payload_too_large`, which reaches the user as a context-length
      // failure.
      const attachmentRefusal =
        canonical.code === 'limit'
          ? attachmentBudgetRefusalMessage(
              canonical.message,
              messages.some(message => message.contentParts?.some(part => part.type === 'image'))
            )
          : undefined
      if (attachmentRefusal !== undefined) {
        throw new CodexAuthorizeError(CODEX_ATTACHMENT_TOO_LARGE, attachmentRefusal)
      }
      throw new CodexAuthorizeError(
        isContextLengthRefusal(canonical.code, canonical.message)
          ? 'request_limit_exceeded'
          : canonical.kind === 'size'
            ? 'payload_too_large'
            : CODEX_REQUEST_INVALID,
        `codex completion request rejected: ${canonical.message}`
      )
    }
    const wireRequest = canonical.value.request
    const requestHash = canonical.value.requestHash
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
        request: wireRequest,
        requestHash,
        invocationId: context.invocationId ?? wireRequest.requestId,
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
      request: wireRequest,
      signal: options?.signal,
    })
    return {
      ...streamed,
      providerAttemptId: authorized.providerAttemptId,
      providerAttemptIndex,
    }
  }

  /**
   * Project the loop's messages onto the wire contract.
   *
   * A turn with no parts stays byte-identical to V1. As soon as one message
   * carries parts the whole request moves to V2, where the text parts are
   * authoritative for `content` — that is what keeps a redacted (text-only)
   * message consistent with the contract's equality rule.
   */
  private projectMessage(message: CoreChatMessage): ProjectedMessage {
    const projected: ProjectedMessage = {
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
    }
    const parts = message.contentParts
    if (!parts || parts.length === 0) return projected
    if (message.role !== 'user') {
      throw new CodexAuthorizeError(
        CODEX_REQUEST_INVALID,
        `content parts are only supported on user messages (role=${message.role})`
      )
    }
    const contentParts: NonNullable<ProjectedMessage['contentParts']> = parts.map(part =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : {
            type: 'image',
            mimeType: part.mimeType,
            data: part.data,
            source: projectImageSource(part),
          }
    )
    return { ...projected, content: textContentFromParts(contentParts), contentParts }
  }

  private buildRequest(
    messages: CoreChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: { max_tokens?: number; temperature?: number; tool_choice?: string }
  ): CodexCompletionRequest {
    const projectedMessages = messages.map(message => this.projectMessage(message))
    const presentedTools =
      tools && tools.length > 0
        ? tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }))
        : undefined
    if (presentedTools) {
      // Presentation is owned by the agent loop. Preserve its final definitions
      // in both the authorized hash and the proxy request; MCP names are not
      // permissions and must never be discarded by the provider adapter.
      logger.debug(
        { provider: 'codex-subscription', presentedCount: presentedTools.length },
        'Tool definitions prepared for authorization'
      )
    }
    const hasGeneration =
      options?.temperature !== undefined ||
      options?.max_tokens !== undefined ||
      Boolean(options?.tool_choice)
    const base: Omit<CodexCompletionRequest, 'schemaVersion'> = {
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: 'codex-subscription' as const,
      model: this.model,
      messages: projectedMessages,
      ...(presentedTools ? { tools: presentedTools } : {}),
      ...(hasGeneration
        ? {
            generation: {
              ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options?.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {}),
              ...(options?.tool_choice === 'auto' ||
              options?.tool_choice === 'none' ||
              options?.tool_choice === 'required'
                ? { toolChoice: options.tool_choice }
                : {}),
            },
          }
        : {}),
    }
    // V1 stays byte-identical for every text-only turn; one message with parts
    // moves the whole request to V2, which is the only version that carries them.
    if (!projectedMessages.some(message => message.contentParts !== undefined)) {
      return { schemaVersion: 'codex-completion-request.v1', ...base }
    }
    return { schemaVersion: 'codex-completion-request.v2', ...base }
  }
}
