import { LlmPort, PromptBuilder, ReasoningFactory, ReasoningPort } from '../interfaces'
import type { TokenCounter } from '../tokenizer/tokenCounter'
import { ContextBreakdownRaw, DefaultReasoningPort } from './port'
import { DefaultPromptBuilder } from './promptBuilder'
import type { SystemPromptParts } from './systemPrompt'

/**
 * Creates per-conversation ReasoningPort instances.
 *
 * Each conversation may have a different system prompt.
 * The factory bakes the prompt into the instance so callers
 * never pass it on every call.
 *
 * T2.2 — `create(systemPrompt)` keeps the legacy single-string path; the new
 * `createWithParts(parts)` builds a cache-aware port that ships the parts
 * out-of-band through `LlmPort.completeWithTools(... systemPromptParts ...)`.
 */
export class DefaultReasoningFactory implements ReasoningFactory {
  private readonly promptBuilder: PromptBuilder

  constructor(
    private readonly llmPort: LlmPort,
    promptBuilder?: PromptBuilder,
    private readonly metadata?: Record<string, unknown>,
    /**
     * F1.2b — optional context-window-breakdown wiring propagated to every
     * port this factory builds. All optional ⇒ callsites (prod + test) that
     * don't pass them keep compiling and the breakdown is a no-op.
     */
    private readonly tokenCounter?: TokenCounter,
    private readonly onContextBreakdown?: (raw: ContextBreakdownRaw) => void,
    private readonly contextMaxTokens?: number
  ) {
    this.promptBuilder = promptBuilder ?? new DefaultPromptBuilder()
  }

  create(systemPrompt?: string): ReasoningPort {
    return new DefaultReasoningPort(
      this.llmPort,
      this.promptBuilder,
      systemPrompt,
      this.metadata,
      undefined,
      this.tokenCounter,
      this.onContextBreakdown,
      this.contextMaxTokens
    )
  }

  createWithParts(parts: SystemPromptParts): ReasoningPort {
    return new DefaultReasoningPort(
      this.llmPort,
      this.promptBuilder,
      undefined,
      this.metadata,
      parts,
      this.tokenCounter,
      this.onContextBreakdown,
      this.contextMaxTokens
    )
  }
}
