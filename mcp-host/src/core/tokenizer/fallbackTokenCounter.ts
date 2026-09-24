/**
 * Heuristic fallback counter for every provider whose registry descriptor
 * declares `tokenizer: 'fallback'` (`registryCore.ts`): all of them except
 * `openai` and `claude`, including `codex-subscription` and `grok-subscription`.
 *
 * Bias factor: 1.3× over the byte-based `ceil(bytes / 4) + 4` heuristic, to
 * over-estimate. The ±25-40% error that motivated the bias was measured on the
 * word-count heuristic this replaced in #731; the byte count has not been
 * measured against provider usage. Biasing high reduces overflow risk at the
 * cost of slightly earlier compaction.
 *
 * `recordObservedUsage` matters here MORE than for the precise counters —
 * the provider's billed `input_tokens` is literally the ground truth, so
 * `lastObservedInputTokens()` is preferred over `count()` whenever available.
 */
import type { ChatMessage, ToolDefinition } from '../types'
import { heuristicCount, heuristicCountTools } from './heuristic'
import { tokenizerFallbackTotal } from './metrics'
import type { TokenCounter, TokenCounterProvider } from './tokenCounter'

export class FallbackTokenCounter implements TokenCounter {
  private observed: number | null = null

  constructor(
    // Any provider whose registry descriptor declares `tokenizer: 'fallback'`
    // (today zai/bailian, and any future OpenAI-compatible shim) — plus the
    // safe-default path for an unexpected provider type.
    public readonly providerName: TokenCounterProvider,
    public readonly modelName: string,
    private readonly biasFactor: number = 1.3
  ) {}

  async warmup(): Promise<void> {
    // No state to load.
  }

  async count(messages: ChatMessage[], tools: ToolDefinition[] = []): Promise<number> {
    return this.countSync(messages, tools)
  }

  countSync(messages: ChatMessage[], tools: ToolDefinition[] = []): number {
    tokenizerFallbackTotal.inc({ provider: this.providerName, reason: 'no_native_api' })
    const total = heuristicCount(messages) + heuristicCountTools(tools)
    return Math.ceil(total * this.biasFactor)
  }

  recordObservedUsage(usage: { input_tokens: number; output_tokens: number }): void {
    this.observed = usage.input_tokens
  }

  lastObservedInputTokens(): number | null {
    return this.observed
  }
}
