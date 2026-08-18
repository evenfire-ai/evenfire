import { SingleTurnProvider } from '../../llm'
import {
  clerumPromptCacheInputTokens,
  clerumPromptCacheReadTokens,
  clerumPromptCacheWriteTokens,
} from '../../llm/promptCacheMetrics'
import { LlmUsageEvent, UsageReporter, newRequestId } from '../../usage/usageReporter.js'
import type { SessionTokenUsage } from '../conversation/conversationStore'
import { LlmError } from '../errors'
import { LlmPort } from '../interfaces'
import type { SystemPromptParts } from '../reasoning/systemPrompt'
import { redactDiagnosticField } from '../redactDiagnostics.js'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
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

function providerErrorDiagnostics(err: unknown): string {
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

  const entries = Object.entries(fields)
  return entries.length > 0 ? ` diagnostics=${JSON.stringify(Object.fromEntries(entries))}` : ''
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
    private readonly onUsageRecorded?: (usage: SessionTokenUsage) => void
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
    console.log(
      `[NewCore:LlmPort] complete → model=${this.model}, messages=${request.messages.length}, cache=${request.systemPromptParts ? 'on' : 'off'}`
    )
    const requestId = newRequestId()
    try {
      const response = await this.dispatchComplete(request)
      console.log(`[NewCore:LlmPort] ← finish_reason=${response.finish_reason}`)
      this.recordUsage(requestId, request.usageContext, response.usage)
      return response
    } catch (err) {
      this.handleProviderError(err)
    }
  }

  async completeWithTools(request: ToolCompletionRequest): Promise<ToolCompletionResponse> {
    console.log(
      `[NewCore:LlmPort] completeWithTools → model=${this.model}, tools=${request.tools.length}, messages=${request.messages.length}, cache=${request.systemPromptParts ? 'on' : 'off'}`
    )
    const requestId = newRequestId()
    try {
      const response = await this.dispatchCompleteWithTools(request)
      const toolCallCount = response.tool_calls?.length ?? 0
      console.log(
        `[NewCore:LlmPort] ← finish_reason=${response.finish_reason}, tool_calls=${toolCallCount}, usage=${JSON.stringify(response.usage ?? {})}`
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
    if (parts && this.provider.completeSingleTurnAndCache) {
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
    if (parts && this.provider.completeSingleTurnWithToolsAndCache) {
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
        console.error('[NewCore:LlmPort] onUsageRecorded sink threw (ignored):', err)
      }
    }
    if (!this.usageReporter || !this.staticContext || !usageContext || !usage) return
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
    console.log(
      `[NewCore:LlmPort] ← ERROR: code=${classified.code} ` +
        `retryable=${classified.retryable} message="${classified.message}"` +
        providerErrorDiagnostics(err)
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
