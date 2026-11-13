/**
 * AnthropicTokenCounter — uses the GA `client.messages.countTokens` endpoint
 * to get an authoritative input-token count for a message list. Free and
 * rate-limited separately from message creation (Tier 1: 100 RPM).
 *
 * Falls back to `heuristicCount × 1.5` on any error (rate limit, network,
 * offline mode) and increments the `clerum_tokenizer_fallback_total` counter
 * with a classified reason label so the operator can detect degradation.
 *
 * `countSync()` always returns the heuristic upper bound — Anthropic has no
 * synchronous tokenizer. Call `count()` from async paths whenever possible.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { MessageCountTokensParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { convertToClaudeMessages, separateSystemMessage } from '../../llm/claude/messageTranslate'
import { type ToolNameEnvelopeKey, toWireRequest } from '../../llm/toolWireNames'
import { logger } from '../../logger'
import type { ChatMessage, ToolDefinition } from '../types'
import { heuristicCount, heuristicCountTools } from './heuristic'
import {
  type TokenizerFallbackReason,
  tokenizerCountDurationSeconds,
  tokenizerFallbackTotal,
} from './metrics'
import type { TokenCounter } from './tokenCounter'

export interface AnthropicTokenCounterOptions {
  /**
   * When true, `count()` skips the network entirely and returns the
   * heuristic upper bound. Backed by `CLERUM_TOKENIZER_OFFLINE`.
   */
  offline?: boolean
  /**
   * Envelope of the provider whose requests are counted. `countTokens` rejects
   * the same names `messages.create` does, so the count must use the same
   * projection; the provider that creates the counter passes its own.
   */
  toolNameEnvelope?: ToolNameEnvelopeKey
}

export class AnthropicTokenCounter implements TokenCounter {
  readonly providerName = 'claude' as const
  private observed: number | null = null
  private readonly offline: boolean
  private readonly toolNameEnvelope: ToolNameEnvelopeKey

  constructor(
    private readonly client: Anthropic,
    public readonly modelName: string,
    options: AnthropicTokenCounterOptions = {}
  ) {
    this.offline = options.offline ?? false
    this.toolNameEnvelope = options.toolNameEnvelope ?? 'W_c'
  }

  async warmup(): Promise<void> {
    // SDK is already constructed; nothing to pre-warm.
  }

  async count(
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    options: { signal?: AbortSignal } = {}
  ): Promise<number> {
    if (this.offline) {
      this.incrementFallback('offline')
      return Math.ceil(heuristicCount(messages) * 1.5)
    }
    const endTimer = tokenizerCountDurationSeconds.startTimer({ provider: 'claude' })
    try {
      const wire = toWireRequest(messages, tools, this.toolNameEnvelope)
      const { systemPrompt, claudeMessages } = separateSystemMessage(wire.messages)
      const anthropicMessages = convertToClaudeMessages(claudeMessages)
      const translatedTools =
        wire.tools.length > 0
          ? wire.tools.map(t => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Tool['input_schema'],
            }))
          : undefined
      // SDK 0.32.x exposes countTokens only under the beta namespace. The
      // request shape is wire-compatible with the GA `messages.create` shape,
      // so the cast bridges the two type families without runtime change.
      const params = {
        model: this.modelName,
        system: systemPrompt ?? undefined,
        messages: anthropicMessages,
        tools: translatedTools,
      } as unknown as MessageCountTokensParams
      const response = await this.client.beta.messages.countTokens(params, {
        signal: options.signal,
      })
      return response.input_tokens
    } catch (err) {
      const reason = classifyFallbackReason(err)
      this.incrementFallback(reason)
      logger.warn(
        { provider: 'claude', reason, err },
        'countTokens failed, falling back to heuristic'
      )
      return Math.ceil(heuristicCount(messages) * 1.5)
    } finally {
      endTimer()
    }
  }

  countSync(messages: ChatMessage[], tools: ToolDefinition[] = []): number {
    this.incrementFallback('no_warmup')
    // Anthropic has no synchronous tokenizer; fold the tool schemas into the
    // heuristic the same way FallbackTokenCounter does so callers that pass
    // tools (e.g. the context-breakdown capture) get a non-zero estimate for
    // the tools bucket instead of silently dropping them.
    const total = heuristicCount(messages) + heuristicCountTools(tools)
    return Math.ceil(total * 1.5)
  }

  recordObservedUsage(usage: { input_tokens: number; output_tokens: number }): void {
    this.observed = usage.input_tokens
  }

  lastObservedInputTokens(): number | null {
    return this.observed
  }

  private incrementFallback(reason: TokenizerFallbackReason): void {
    tokenizerFallbackTotal.inc({ provider: 'claude', reason })
  }
}

function classifyFallbackReason(err: unknown): TokenizerFallbackReason {
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status
    if (status === 429) return 'rate_limit'
  }
  return 'count_call_failed'
}
