import type { ImageInputDecision } from '@clerum/llm-providers'
import { SingleTurnProvider } from '../../llm'
import {
  type ImageInputCapabilitySource,
  type ImageInputResolver,
  type ImageTransportOperation,
  decideImageInput,
  imageInputDenialMessage,
  imageInputRolesFor,
  isCanonicalBase64Shape,
  isImageAttachmentMime,
} from '../../llm/imageInput'
import {
  clerumPromptCacheInputTokens,
  clerumPromptCacheReadTokens,
  clerumPromptCacheWriteTokens,
} from '../../llm/promptCacheMetrics'
import { logger } from '../../logger'
import { LlmUsageEvent, UsageReporter, newRequestId } from '../../usage/usageReporter.js'
import { type ImageInputCapability, VisualInputError } from '../../visualInput/policy'
import { assertVisualRequestFits, hasGfsImageInput } from '../../visualInput/requestPolicy'
import type { SessionTokenUsage } from '../conversation/conversationStore'
import { LlmError, LlmErrorCode } from '../errors'
import { LlmPort } from '../interfaces'
import type { SystemPromptParts } from '../reasoning/systemPrompt'
import { redactDiagnosticField } from '../redactDiagnostics.js'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  MessageRole,
  ToolCompletionRequest,
  ToolCompletionResponse,
  UsageContext,
} from '../types'

/**
 * T2.2 fallback: when the provider does not implement the cache-aware path,
 * concat `parts.stable` + `parts.context` into a single system message and
 * prepend it to the request `messages`. The wire shape stays identical to the
 * legacy single-string path, so providers without explicit cache markers
 * (OpenAI / ZAI / Bailian) keep working unchanged.
 */
function prependConcatSystem(parts: SystemPromptParts, messages: ChatMessage[]): ChatMessage[] {
  const content = [parts.stable, parts.context].filter(s => s && s.length > 0).join('\n\n')
  if (!content) return messages
  return [{ role: 'system', content }, ...messages]
}

/**
 * An image part the adapter may forward: PNG/JPEG mime and canonical base64
 * string data. Line-wrapped, `data:`-prefixed, URL-safe or unpadded base64
 * fails.
 */
function isWellFormedImagePart(part: { mimeType: unknown; data: unknown }): boolean {
  return (
    isImageAttachmentMime(part.mimeType) &&
    typeof part.data === 'string' &&
    isCanonicalBase64Shape(part.data)
  )
}

export type AdapterStaticContext = {
  host_ref: string
  context_ref: string | null
  llm_secret_name: string | null
}

function errorField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const fieldValue = record[field]
  if (typeof fieldValue !== 'string') return null
  const trimmed = fieldValue.trim()
  return trimmed ? redactDiagnosticField(trimmed).slice(0, 120) : null
}

function providerErrorDiagnostics(err: unknown): Record<string, string> {
  const fields: Record<string, string> = {}
  const name = errorField(err, 'name')
  const type = errorField(err, 'type')
  const code = errorField(err, 'code')
  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? String((err as { status: number }).status)
      : null
  const cause = err instanceof Error ? err.cause : undefined
  const causeName = errorField(cause, 'name')
  const causeCode = errorField(cause, 'code')

  if (name) fields.name = name
  if (type) fields.type = type
  if (code) fields.code = code
  if (status) fields.status = status
  if (causeName) fields.causeName = causeName
  if (causeCode) fields.causeCode = causeCode

  return fields
}

/**
 * Adapts an existing provider (implementing SingleTurnProvider)
 * to the spec's LlmPort interface.
 *
 * If a UsageReporter and staticContext are supplied, every successful LLM
 * call also produces an LlmUsageEvent enqueued to the reporter — this is
 * the single chokepoint described in
 * `docs/plans/llm-token-usage-tracking-*.md`.
 */
export class LlmPortAdapter implements LlmPort {
  constructor(
    private readonly provider: SingleTurnProvider,
    private readonly model: string,
    private readonly providerName: string,
    private readonly usageReporter?: UsageReporter,
    private readonly staticContext?: AdapterStaticContext,
    private readonly defaultUsageContext?: UsageContext,
    /**
     * Provider-aware token counter (P.2). Optional for legacy callers and
     * tests; production code paths always pass one constructed via
     * `createTokenCounter`. When present, `recordUsage` forwards the
     * `input_tokens` so the next pre-flight count can use the authoritative
     * number (Hermes `update_from_response` pattern).
     */
    private readonly tokenCounter?: TokenCounter,
    /**
     * Optional sink to accumulate each call's tokens into the durable
     * per-session counters (`sessions.*_tokens`). Per-task; bound to the active
     * Conversation by `taskExecutor.buildLoopConfig` / `stateMachine` (compact).
     * Tests and legacy callers omit it (no-op). Independent of `usageReporter`:
     * session persistence does not require control-api to be wired.
     */
    private readonly onUsageRecorded?: (usage: SessionTokenUsage) => void,
    /**
     * Issue #654 — live-catalog lookup for the image-input capability of the
     * (provider, model) this adapter is about to send. Absent (dev, tests,
     * unwired host) means `unknown`: requests without images are byte-identical
     * to today, requests carrying an image fail closed before the SDK.
     */
    private readonly imageInputResolver?: ImageInputResolver
  ) {}

  /**
   * Exposes the counter to downstream consumers (`PressureContextManager`,
   * `compactConversation`, future prompt-cache breakpoints). Returns
   * `undefined` only in tests that intentionally omit it.
   */
  getTokenCounter(): TokenCounter {
    if (!this.tokenCounter) {
      throw new Error(
        '[LlmPortAdapter] getTokenCounter() called before a counter was injected — wiring bug'
      )
    }
    return this.tokenCounter
  }

  getImageInputCapability(signal?: AbortSignal): Promise<ImageInputCapability> {
    return this.provider.getImageInputCapability?.(signal) ?? Promise.resolve({ status: 'unknown' })
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    logger.info(
      {
        provider: this.providerName,
        model: this.model,
        messageCount: request.messages.length,
        cache: Boolean(request.systemPromptParts),
      },
      'LLM completion started'
    )
    // Excluded from the SDK-classification catch below on purpose: a denied
    // image must stay a typed, terminal LlmError instead of being reclassified
    // by `provider.classifyError` (which would make it retryable).
    const messages = this.prepareMessagesForImageInput(
      request.messages,
      this.dispatchMethodFor(request, false)
    )
    const requestId = newRequestId()
    try {
      assertVisualRequestFits(messages, { ...request, messages })
      const response = await this.dispatchComplete({ ...request, messages })
      logger.info({ finishReason: response.finish_reason }, 'LLM completion finished')
      this.recordUsage(requestId, request.usageContext, response.usage)
      return response
    } catch (err) {
      this.handleProviderError(err)
    }
  }

  async completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    logger.info(
      {
        provider: this.providerName,
        model: this.model,
        toolCount: request.tools.length,
        messageCount: request.messages.length,
        cache: Boolean(request.systemPromptParts),
      },
      'LLM tool completion started'
    )
    // Same exclusion as `complete`: deny BEFORE the try/catch that classifies
    // provider SDK errors.
    const messages = this.prepareMessagesForImageInput(
      request.messages,
      this.dispatchMethodFor(request, true)
    )
    const requestId = newRequestId()
    try {
      assertVisualRequestFits(messages, { ...request, messages })
      const response = await this.dispatchCompleteWithTools(
        { ...request, messages },
        hasGfsImageInput(messages)
      )
      const toolCallCount = response.tool_calls?.length ?? 0
      logger.info(
        { finishReason: response.finish_reason, toolCallCount, usage: response.usage },
        'LLM tool completion finished'
      )
      this.recordUsage(requestId, request.usageContext, response.usage)
      return response
    } catch (err) {
      this.handleProviderError(err)
    }
  }

  /**
   * Preserve the historical content-deduplicated API-key view without changing
   * the loop's canonical messages. Each fallback adapter selects its own view;
   * source-binding transports retain all identities before hashing them.
   */
  private providerMessages(messages: ChatMessage[]): ChatMessage[] {
    if (
      this.provider.requiresImageSourceIdentity ||
      !messages.some(message => message.contentParts?.some(part => part.sourceIdentityOnly))
    ) {
      return messages
    }
    const imageKey = (part: { mimeType: string; data: string }) =>
      `${part.mimeType}\u0000${part.data}`
    const represented = new Set<string>()
    for (const message of messages) {
      for (const part of message.contentParts ?? []) {
        if (part.type === 'image' && !part.sourceIdentityOnly) represented.add(imageKey(part))
      }
    }
    return messages.flatMap(message => {
      if (!message.contentParts?.some(part => part.sourceIdentityOnly)) return [message]
      let restoredImage = false
      const selected = new Set(message.contentParts.filter(part => !part.sourceIdentityOnly))
      for (const part of message.contentParts) {
        if (part.type !== 'image' || !part.sourceIdentityOnly || represented.has(imageKey(part)))
          continue
        // In a mixed chain, pruning can remove the older legacy representative.
        // Retain one current frame rather than silently losing all visual input.
        selected.add(part)
        represented.add(imageKey(part))
        restoredImage = true
      }
      if (restoredImage) {
        for (const part of message.contentParts) if (part.type === 'text') selected.add(part)
      }
      const contentParts = message.contentParts
        .filter(part => selected.has(part))
        .map(part => {
          if (!part.sourceIdentityOnly) return part
          const visible = { ...part }
          delete visible.sourceIdentityOnly
          return visible
        })
      return contentParts.length ? [{ ...message, contentParts }] : []
    })
  }

  /** Native cache markers when supported, otherwise the existing system-text projection. */
  private async dispatchComplete(request: CompletionRequest): Promise<CompletionResponse> {
    const parts = request.systemPromptParts
    const providerMessages = this.providerMessages(request.messages)
    if (
      this.dispatchMethodFor(request, false) === 'completeAndCache' &&
      parts &&
      this.provider.completeSingleTurnAndCache
    ) {
      return this.provider.completeSingleTurnAndCache(parts, providerMessages, {
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        signal: request.signal,
      })
    }
    const messages = parts ? prependConcatSystem(parts, providerMessages) : providerMessages
    return this.provider.completeSingleTurn(messages, {
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      signal: request.signal,
    })
  }

  private async dispatchCompleteWithTools(
    request: ToolCompletionRequest,
    verificationRequired: boolean
  ): Promise<ToolCompletionResponse> {
    const parts = request.systemPromptParts
    const providerMessages = this.providerMessages(request.messages)
    if (
      this.dispatchMethodFor(request, true) === 'completeWithToolsAndCache' &&
      parts &&
      this.provider.completeSingleTurnWithToolsAndCache
    ) {
      return this.provider.completeSingleTurnWithToolsAndCache(
        parts,
        providerMessages,
        request.tools,
        {
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          tool_choice: request.tool_choice,
          signal: request.signal,
          ...(verificationRequired ? { verifyImageInput: true } : {}),
        }
      )
    }
    const messages = parts ? prependConcatSystem(parts, providerMessages) : providerMessages
    return this.provider.completeSingleTurnWithTools(messages, request.tools, {
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      tool_choice: request.tool_choice,
      signal: request.signal,
      ...(verificationRequired ? { verifyImageInput: true } : {}),
    })
  }

  /**
   * Issue #654 — the single source of truth for which transport implementation
   * a request will actually use. `dispatchComplete`/`dispatchCompleteWithTools`
   * branch on this same method, so the image guard can never evaluate a
   * different path than the one that runs.
   */
  private dispatchMethodFor(
    request: { systemPromptParts?: SystemPromptParts },
    withTools: boolean
  ): ImageTransportOperation {
    const parts = request.systemPromptParts
    if (withTools) {
      return parts && this.provider.completeSingleTurnWithToolsAndCache
        ? 'completeWithToolsAndCache'
        : 'completeWithTools'
    }
    return parts && this.provider.completeSingleTurnAndCache ? 'completeAndCache' : 'complete'
  }

  /**
   * Resolve the image decision for this physical attempt. Returns `unknown`
   * when no catalog resolver is wired or the pair is absent from it — an
   * absent catalog entry is never an implicit allow.
   */
  private decideImageInputForAttempt(
    method: ImageTransportOperation,
    roles: readonly MessageRole[]
  ): ImageInputDecision {
    if (!this.imageInputResolver) return { state: 'unknown', reason: 'model_unknown' }
    let source: ImageInputCapabilitySource | undefined
    try {
      source = this.imageInputResolver(this.providerName, this.model)
    } catch (err) {
      // A catalog read failure must not fail a text-only turn, and must not be
      // read as support: it degrades to `unknown`, which blocks images only.
      logger.warn(
        {
          component: 'LlmPortAdapter',
          provider: this.providerName,
          model: this.model,
          err,
        },
        'image-input capability resolver threw; treating as unknown'
      )
      source = undefined
    }
    if (!source) return { state: 'unknown', reason: 'model_unknown' }
    return decideImageInput({
      providerType: this.providerName,
      method,
      roles,
      capability: source.capability,
    })
  }

  /**
   * Fail closed when this attempt carries a USER image and the intersection of
   * model evidence, transport implementation and role is not
   * affirmative. Text-only requests return immediately (no resolver call).
   *
   * #654 — images the agent's own tools produced are withheld rather than
   * fatal: the turn is dispatched without them and `content` records how many
   * were dropped and why. A model with no image evidence must still be able to
   * finish a text task that happens to call a screenshot tool; refusing there
   * would turn a capability gap into a task failure the user never asked for.
   *
   * Encoding is validated before any capability decision. A malformed USER
   * image (mime other than PNG/JPEG, non-string data, or data that is not
   * canonical base64) is a terminal `InvalidAttachment`. A malformed image in a
   * `tool_result` message came from an external MCP server, not the user, so it
   * is removed instead: the message keeps its other parts and `content` records
   * how many were dropped for invalid encoding. It is never forwarded, even to
   * an image-capable model. A message left with no image part stops being an
   * image carrier; valid tool images continue through the capability decision.
   *
   * Returns the message array to dispatch. The input array is never mutated,
   * so a later failover attempt on a supported pair still sees the images.
   */
  private prepareMessagesForImageInput(
    input: ChatMessage[],
    method: ImageTransportOperation
  ): ChatMessage[] {
    const messages = this.removeMalformedToolImages(input, method)
    for (const message of messages) {
      if (message.contentParts === undefined) continue
      if (
        !Array.isArray(message.contentParts) ||
        message.contentParts.some(
          part =>
            !part ||
            (part.type !== 'text' && part.type !== 'image') ||
            (part.type === 'image' && !isWellFormedImagePart(part))
        )
      ) {
        throw new LlmError(
          'The request contains an unsupported image format or encoding.',
          this.providerName,
          LlmErrorCode.InvalidAttachment,
          false
        )
      }
    }
    const roles = imageInputRolesFor(messages)
    if (roles.length === 0) return messages
    const decision = this.decideImageInputForAttempt(method, roles)
    if (decision.state === 'supported') return messages

    const carriesImages = (message: ChatMessage): boolean =>
      message.contentParts?.some(part => part.type === 'image') === true
    const userImages = messages.some(
      message => carriesImages(message) && message.imageOrigin !== 'tool_result'
    )
    if (userImages) {
      logger.warn(
        {
          component: 'LlmPortAdapter',
          provider: this.providerName,
          model: this.model,
          method,
          roles,
          reason: decision.reason,
          validUntil: decision.validUntil,
        },
        'image input denied before provider dispatch'
      )
      throw new LlmError(
        imageInputDenialMessage(decision, { provider: this.providerName, model: this.model }),
        this.providerName,
        decision.state === 'unsupported'
          ? LlmErrorCode.ImageInputUnsupported
          : LlmErrorCode.ImageInputUnknown,
        false
      )
    }

    const withheld = messages.filter(
      message => message.imageOrigin === 'tool_result' && carriesImages(message)
    )
    const count = withheld.reduce(
      (total, message) =>
        total + message.contentParts!.filter(part => part.type === 'image').length,
      0
    )
    logger.warn(
      {
        component: 'LlmPortAdapter',
        provider: this.providerName,
        model: this.model,
        method,
        reason: decision.reason,
        withheldImages: count,
      },
      'tool screenshots withheld: model has no affirmative image-input evidence'
    )
    const notice = `[${count} screenshot(s) returned by tool results were not forwarded: ${imageInputDenialMessage(
      decision,
      { provider: this.providerName, model: this.model }
    )}]`
    // The rewritten message drops `contentParts` and `imageOrigin` and keeps
    // everything else the wire needs. `toolUseLoopMessages` builds this message
    // with only `role`/`content`/`contentParts`, so `tool_calls` and
    // `spillover_ref` are never set on it; `tool_call_id`/`name` are carried
    // anyway so the rewrite stays correct if another producer marks a message
    // `tool_result` in the future.
    return messages.map(message =>
      withheld.includes(message)
        ? {
            role: message.role,
            content: `${message.content}\n${notice}`,
            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.name ? { name: message.name } : {}),
          }
        : message
    )
  }

  /**
   * Remove image parts with an invalid encoding from `tool_result` messages.
   * Returns `messages` itself when nothing was removed; otherwise a new array
   * in which only the affected messages are rebuilt (inputs are not mutated).
   *
   * Providers render `contentParts` instead of `content` when parts are
   * present, so when valid images remain the notice is appended both to
   * `content` and as a trailing text part. When no image remains, the message
   * drops `contentParts` and `imageOrigin` and is sent as plain text.
   */
  private removeMalformedToolImages(
    messages: ChatMessage[],
    method: ImageTransportOperation
  ): ChatMessage[] {
    let removedTotal = 0
    const sanitized = messages.map((message): ChatMessage => {
      if (message.imageOrigin !== 'tool_result' || !Array.isArray(message.contentParts)) {
        return message
      }
      const kept = message.contentParts.filter(
        part => !(part && part.type === 'image' && !isWellFormedImagePart(part))
      )
      const removed = message.contentParts.length - kept.length
      if (removed === 0) return message
      removedTotal += removed
      const notice = `[${removed} screenshot(s) returned by tool results were not forwarded: invalid image encoding]`
      const content = `${message.content}\n${notice}`
      if (kept.some(part => part && part.type === 'image')) {
        return { ...message, content, contentParts: [...kept, { type: 'text', text: notice }] }
      }
      const { contentParts: _dropped, imageOrigin: _origin, ...rest } = message
      return { ...rest, content }
    })
    if (removedTotal === 0) return messages
    logger.warn(
      {
        component: 'LlmPortAdapter',
        provider: this.providerName,
        model: this.model,
        method,
        count: removedTotal,
      },
      'tool screenshots removed before provider dispatch: invalid image encoding'
    )
    return sanitized
  }

  private recordUsage(
    requestId: string,
    requestUsageContext: UsageContext | undefined,
    usage:
      | {
          input_tokens: number
          output_tokens: number
          cache_read_tokens?: number
          cache_write_tokens?: number
        }
      | undefined
  ): void {
    const usageContext = requestUsageContext ?? this.defaultUsageContext
    if (usage && this.tokenCounter) {
      // Hermes `update_from_response`: stamp the counter with the
      // authoritative input_tokens so the next compaction decision can skip
      // the network call.
      this.tokenCounter.recordObservedUsage(usage)
    }
    // T2.2 — observe cache histograms whenever the response carried the
    // cache_*_tokens fields (Anthropic populates them; concat-fallback
    // providers leave them undefined, which we treat as 0 so the denominator
    // gauge still works for the canary).
    if (usage) {
      clerumPromptCacheInputTokens.observe(usage.input_tokens)
      clerumPromptCacheReadTokens.observe(usage.cache_read_tokens ?? 0)
      clerumPromptCacheWriteTokens.observe(usage.cache_write_tokens ?? 0)
    }
    // Durable per-session token counters. Deliberately BEFORE the UsageReporter
    // early-return below: persisting to `sessions.*_tokens` must not depend on
    // control-api being wired. `cache_*` are forwarded verbatim (undefined when
    // the provider doesn't report cache) so the session can track capability.
    //
    // `recordUsage` runs inside the LLM call's `try` block, so the sink is
    // wrapped: a throw here must NEVER bubble up and get mis-classified as a
    // provider error (which would abort an otherwise-successful turn). Token
    // accounting is best-effort telemetry — log and swallow.
    if (usage && this.onUsageRecorded) {
      try {
        this.onUsageRecorded({
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_tokens: usage.cache_read_tokens,
          cache_write_tokens: usage.cache_write_tokens,
        })
      } catch (err) {
        logger.error(
          { err: providerErrorDiagnostics(err) },
          'Usage sink failed; completion preserved'
        )
      }
    }
    if (!this.usageReporter || !this.staticContext || !usageContext || !usage) return
    if (this.providerName === 'codex-subscription') return
    const event: LlmUsageEvent = {
      request_id: requestId,
      ts: new Date().toISOString(),
      run_id: usageContext.traceContext?.runId ?? null,
      host_ref: this.staticContext.host_ref,
      context_ref: this.staticContext.context_ref,
      team_id: usageContext.team_id ?? null,
      provider: this.providerName,
      model: this.model,
      llm_secret_name: this.staticContext.llm_secret_name,
      source_kind: usageContext.source_kind,
      user_id: usageContext.user_id ?? null,
      sender: usageContext.sender ?? null,
      channel_type: usageContext.channel_type ?? null,
      recipe_name: usageContext.recipe_name ?? null,
      cron_job_id: usageContext.cron_job_id ?? null,
      task_id: usageContext.task_id ?? null,
      iteration: usageContext.iteration ?? null,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
    }
    this.usageReporter.enqueue(event)
  }

  /**
   * Shared error path for provider calls. Classifies the error via the
   * provider, logs a structured line, and re-throws as an LlmError that
   * preserves the original SDK error as `cause`.
   *
   * Returns `never` so call sites can use it as a statement inside a catch
   * block without the compiler complaining about missing return paths.
   */
  private handleProviderError(err: unknown): never {
    if (err instanceof LlmError) throw err
    if (err instanceof VisualInputError) {
      throw new LlmError(
        err.message,
        this.providerName,
        err.code === 'limit_exceeded'
          ? LlmErrorCode.ContextLengthExceeded
          : LlmErrorCode.ApiCallFailed,
        false
      )
    }
    const classified = this.provider.classifyError(err)
    logger.info(
      {
        provider: this.providerName,
        model: this.model,
        code: classified.code,
        retryable: classified.retryable,
        diagnostics: providerErrorDiagnostics(err),
      },
      'LLM provider call failed'
    )
    throw new LlmError(
      classified.message,
      this.providerName,
      classified.code,
      classified.retryable,
      err as Error,
      classified.httpStatus,
      classified.providerCode
    )
  }

  modelName(): string {
    return this.model
  }
}
