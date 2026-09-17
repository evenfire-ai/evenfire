import type { ImageInputDecision } from '@clerum/llm-providers'
import { SingleTurnProvider } from '../../llm'
import {
  type ImageInputCapabilitySource,
  type ImageInputResolver,
  type ImageTransportOperation,
  decideImageInput,
  imageInputDenialMessage,
  imageInputRolesFor,
} from '../../llm/imageInput'
import {
  clerumPromptCacheInputTokens,
  clerumPromptCacheReadTokens,
  clerumPromptCacheWriteTokens,
} from '../../llm/promptCacheMetrics'
import { logger } from '../../logger'
import { LlmUsageEvent, UsageReporter, newRequestId } from '../../usage/usageReporter.js'
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

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    logger.info(
      { provider: this.providerName, model: this.model, messageCount: request.messages.length },
      'Starting completion'
    )
    // Excluded from the SDK-classification catch below on purpose: a denied
    // image must stay a typed, terminal LlmError instead of being reclassified
    // by `provider.classifyError` (which would make it retryable).
    this.assertImageInputSupported(request.messages, this.dispatchMethodFor(request, false))
    const requestId = newRequestId()
    try {
      const response = await this.dispatchComplete(request)
      logger.info({ finishReason: response.finish_reason }, 'Completion returned')
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
      },
      'Starting tool completion'
    )
    // Same exclusion as `complete`: deny BEFORE the try/catch that classifies
    // provider SDK errors.
    this.assertImageInputSupported(request.messages, this.dispatchMethodFor(request, true))
    const requestId = newRequestId()
    try {
      const response = await this.dispatchCompleteWithTools(request)
      const toolCallCount = response.tool_calls?.length ?? 0
      logger.info(
        { finishReason: response.finish_reason, toolCallCount },
        'Tool completion returned'
      )
      this.recordUsage(requestId, request.usageContext, response.usage)
      return response
    } catch (err) {
      this.handleProviderError(err)
    }
  }

  /**
   * T2.2 — route to the provider's cache-aware path when both
   * `request.systemPromptParts` is set AND the provider implements the
   * cache-aware method (Claude). Otherwise concat the parts back into a
   * single `system` message and call the legacy method (OpenAI / ZAI /
   * Bailian don't expose explicit cache markers; they cache implicitly by
   * prefix when the routing is stable).
   */
  private async dispatchComplete(request: CompletionRequest): Promise<CompletionResponse> {
    const parts = request.systemPromptParts
    if (
      this.dispatchMethodFor(request, false) === 'completeAndCache' &&
      parts &&
      this.provider.completeSingleTurnAndCache
    ) {
      return this.provider.completeSingleTurnAndCache(parts, request.messages, {
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        signal: request.signal,
      })
    }
    const messages = parts ? prependConcatSystem(parts, request.messages) : request.messages
    return this.provider.completeSingleTurn(messages, {
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      signal: request.signal,
    })
  }

  private async dispatchCompleteWithTools(
    request: ToolCompletionRequest
  ): Promise<ToolCompletionResponse> {
    const parts = request.systemPromptParts
    if (
      this.dispatchMethodFor(request, true) === 'completeWithToolsAndCache' &&
      parts &&
      this.provider.completeSingleTurnWithToolsAndCache
    ) {
      return this.provider.completeSingleTurnWithToolsAndCache(
        parts,
        request.messages,
        request.tools,
        {
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          tool_choice: request.tool_choice,
          signal: request.signal,
        }
      )
    }
    const messages = parts ? prependConcatSystem(parts, request.messages) : request.messages
    return this.provider.completeSingleTurnWithTools(messages, request.tools, {
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      tool_choice: request.tool_choice,
      signal: request.signal,
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
      policyAllowed: source.policyAllowed,
    })
  }

  /**
   * Fail closed when this attempt carries an image and the intersection of
   * model evidence, selection policy, transport implementation and role is not
   * affirmative. Text-only requests return immediately (no resolver call).
   */
  private assertImageInputSupported(
    messages: readonly ChatMessage[],
    method: ImageTransportOperation
  ): void {
    for (const message of messages) {
      if (message.contentParts === undefined) continue
      if (
        !Array.isArray(message.contentParts) ||
        message.contentParts.some(
          part =>
            !part ||
            (part.type !== 'text' && part.type !== 'image') ||
            (part.type === 'image' &&
              (!['image/png', 'image/jpeg'].includes(part.mimeType) ||
                typeof part.data !== 'string' ||
                !part.data ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  part.data
                )))
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
    if (roles.length === 0) return
    const decision = this.decideImageInputForAttempt(method, roles)
    if (decision.state === 'supported') return
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
        logger.error({ err }, 'Usage sink failed after completion')
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
