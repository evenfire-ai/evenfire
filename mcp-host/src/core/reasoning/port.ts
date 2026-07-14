import { LlmError, LlmErrorCode } from '../errors'
import { LlmPort, PromptBuilder, ReasoningPort } from '../interfaces'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import {
  ChatMessage,
  ContextBreakdown,
  FinishReason,
  ReasoningContext,
  RespondResult,
  ToolCompletionResponse,
  ToolResult,
} from '../types'
import { cleanResponse } from './responseCleaner'
import type { SystemPromptParts } from './systemPrompt'

/** Raw send-time breakdown emitted by the port; `Conversation`-bound sink in
 *  `taskExecutor` records it via `ConversationManager.recordContextBreakdown`. */
export type ContextBreakdownRaw = {
  buckets: ContextBreakdown['buckets']
  maxTokens: number
}

/**
 * Default ReasoningPort implementation.
 *
 * Responsibilities:
 * 1. Build the full message array (system prompt + conversation + context)
 * 2. Call LlmPort.completeWithTools() for a SINGLE LLM turn
 * 3. Classify response into RespondResult (text, tool_calls, or error)
 * 4. Clean text responses through the pipeline
 *
 * This class NEVER executes tools — only returns tool_call requests.
 */
export class DefaultReasoningPort implements ReasoningPort {
  constructor(
    private readonly llmPort: LlmPort,
    private readonly promptBuilder: PromptBuilder,
    private readonly systemPrompt?: string,
    private readonly metadata?: Record<string, unknown>,
    /**
     * T2.2 — when set, the port uses the cache-aware path: no
     * `role:'system'` message is prepended; the parts ride on
     * `request.systemPromptParts` instead. `LlmPortAdapter` routes them to
     * the provider's cache-aware method or to a concat fallback. Mutually
     * exclusive with `systemPrompt`.
     */
    private readonly systemPromptParts?: SystemPromptParts,
    /**
     * Context-window-breakdown capture (F1.2). Both optional so existing
     * callsites (prod + test) that don't wire them keep compiling and the
     * breakdown is simply a no-op. When BOTH are present, `buildMessages`
     * computes the per-bucket `countSync` counts and emits them through the
     * sink (bound to the active `Conversation` by `taskExecutor`).
     */
    private readonly tokenCounter?: TokenCounter,
    private readonly onContextBreakdown?: (raw: ContextBreakdownRaw) => void,
    /** Denominator for the breakdown's fill ratio (appConfig.contextMaxTokens). */
    private readonly contextMaxTokens?: number
  ) {}

  async respondWithTools(context: ReasoningContext): Promise<RespondResult> {
    console.log(
      `[NewCore:Reasoning] respondWithTools → tools=${context.available_tools.length}, messages=${context.messages.length}, model=${this.llmPort.modelName()}, cache=${this.systemPromptParts ? 'on' : 'off'}`
    )
    try {
      const { messages, systemPromptParts } = this.buildMessages(context)

      const response = await this.llmPort.completeWithTools({
        messages,
        tools: context.available_tools,
        signal: context.signal,
        systemPromptParts,
      })

      return this.classifyResponse(response)
    } catch (err) {
      if (err instanceof LlmError) {
        return { type: 'error', error: err }
      }
      return {
        type: 'error',
        error: new LlmError(
          `Reasoning failed: ${(err as Error).message}`,
          this.llmPort.modelName(),
          LlmErrorCode.ApiCallFailed,
          false,
          err as Error
        ),
      }
    }
  }

  async continueWithToolResults(
    context: ReasoningContext,
    results: ToolResult[]
  ): Promise<RespondResult> {
    console.log(
      `[NewCore:Reasoning] continueWithToolResults → toolResults=${results.length}, messages=${context.messages.length}`
    )
    try {
      // Tool results are already appended to context.messages by the loop
      // (toolUseLoop.ts lines 145-159). Do NOT re-append them here.
      const { messages, systemPromptParts } = this.buildMessages(context)

      const response = await this.llmPort.completeWithTools({
        messages,
        tools: context.available_tools,
        signal: context.signal,
        systemPromptParts,
      })

      return this.classifyResponse(response)
    } catch (err) {
      if (err instanceof LlmError) {
        return { type: 'error', error: err }
      }
      return {
        type: 'error',
        error: new LlmError(
          `Continue with results failed: ${(err as Error).message}`,
          this.llmPort.modelName(),
          LlmErrorCode.ApiCallFailed,
          false,
          err as Error
        ),
      }
    }
  }

  private buildMessages(context: ReasoningContext): {
    messages: ChatMessage[]
    systemPromptParts?: SystemPromptParts
  } {
    if (this.systemPromptParts) {
      // T2.2 cache path — system content travels out-of-band as `parts`.
      this.captureBreakdown(context, this.systemPromptParts, undefined)
      return { messages: context.messages, systemPromptParts: this.systemPromptParts }
    }
    const systemMsg = this.promptBuilder.buildSystemPrompt(
      context.available_tools,
      this.systemPrompt,
      {
        ...this.metadata,
        job_description: context.job_description,
        current_state: context.current_state,
      }
    )

    this.captureBreakdown(context, undefined, systemMsg)
    return { messages: [systemMsg, ...context.messages] }
  }

  /**
   * F1.2 — Compute the send-time context-window breakdown and emit it through
   * the sink. Covers both system-prompt paths (#2):
   *   - cache path: `parts.stable` → `systemPrompt`, `parts.context` → `metaContext`.
   *   - legacy path: the single `role:'system'` message → `systemPrompt`, `metaContext = 0`.
   *
   * Wrapped in try/catch (#5): a tokenizer failure must NEVER abort a turn —
   * the breakdown is best-effort telemetry. No-op unless both `tokenCounter`
   * and `onContextBreakdown` are wired.
   */
  private captureBreakdown(
    context: ReasoningContext,
    parts: SystemPromptParts | undefined,
    systemMsg: ChatMessage | undefined
  ): void {
    if (!this.tokenCounter || !this.onContextBreakdown) return
    try {
      const c = this.tokenCounter
      const messagesOnly = context.messages.filter(m => m.role !== 'system')
      const messages = c.countSync(messagesOnly)
      // `countSync([], tools)` measures ONLY the tool framing. OpenAI/Fallback
      // accept `messages=[]` and process `tools`; Anthropic now folds the tool
      // schemas into its heuristic too (#12).
      const systemTools = c.countSync([], context.available_tools)
      let systemPrompt = 0
      let metaContext = 0
      if (parts) {
        // #2 cache path — stable/context are separate strings.
        systemPrompt = c.countSync([{ role: 'system', content: parts.stable }])
        metaContext = c.countSync([{ role: 'system', content: parts.context }])
      } else if (systemMsg) {
        // #2 legacy path — single system message, no stable/context split.
        systemPrompt = c.countSync([systemMsg])
        metaContext = 0
      }
      this.onContextBreakdown({
        buckets: { messages, systemTools, metaContext, systemPrompt },
        maxTokens: this.contextMaxTokens ?? 0,
      })
    } catch (err) {
      console.error('[NewCore:Reasoning] context breakdown capture failed (ignored):', err)
    }
  }

  private classifyResponse(response: ToolCompletionResponse): RespondResult {
    // Tool calls take priority
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolNames = response.tool_calls.map(tc => tc.name).join(', ')
      console.log(
        `[NewCore:Reasoning] classify → tool_calls (${response.tool_calls.length} calls: ${toolNames})`
      )
      return {
        type: 'tool_calls',
        calls: response.tool_calls,
        content: response.content ?? undefined,
        usage: response.usage,
      }
    }

    // Content filter is an error
    if (response.finish_reason === FinishReason.ContentFilter) {
      console.log(`[NewCore:Reasoning] classify → error (content_filter)`)
      return {
        type: 'error',
        error: new LlmError(
          'Response filtered by content policy',
          this.llmPort.modelName(),
          LlmErrorCode.ContentFiltered,
          false
        ),
      }
    }

    // Text response (clean it)
    if (response.content) {
      const cleaned = cleanResponse(response.content)
      if (cleaned.length > 0) {
        console.log(`[NewCore:Reasoning] classify → text (${cleaned.length} chars)`)
        return { type: 'text', content: cleaned }
      }
    }

    // Nothing useful
    console.log(`[NewCore:Reasoning] classify → error (empty_response)`)
    return {
      type: 'error',
      error: new LlmError(
        'LLM produced empty response (no text, no tool calls)',
        this.llmPort.modelName(),
        LlmErrorCode.InvalidResponse,
        false
      ),
    }
  }
}
