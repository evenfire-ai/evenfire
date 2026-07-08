/**
 * OpenAITokenCounter — uses `tiktoken` to encode messages with the
 * model-matched encoding. Synchronous after warmup.
 *
 * Per-message overhead (`+3 tokens`) and the trailing-prime token follow the
 * documented OpenAI chat format. Tool schemas are encoded as serialized
 * JSON — matches what OpenAI internally bills for in `prompt_tokens`.
 *
 * Unknown models fall back to the `cl100k_base` encoding (covers gpt-4 /
 * gpt-4o families) with a warning. Images are NOT counted yet — the helper
 * `accountForImages` is reserved for a follow-up PR once Desktop multi-image
 * traffic is meaningful.
 */
import { type Tiktoken, encoding_for_model, get_encoding } from 'tiktoken'
import type { ChatMessage, ToolDefinition } from '../types'
import { heuristicCount } from './heuristic'
import { tokenizerFallbackTotal } from './metrics'
import type { TokenCounter } from './tokenCounter'

export class OpenAITokenCounter implements TokenCounter {
  readonly providerName = 'openai' as const
  private encoder: Tiktoken | null = null
  private observed: number | null = null

  constructor(public readonly modelName: string) {}

  async warmup(): Promise<void> {
    if (this.encoder) return
    try {
      // tiktoken's `encoding_for_model` expects a known model literal; cast
      // because the OpenAI provider may receive any string.
      this.encoder = encoding_for_model(this.modelName as Parameters<typeof encoding_for_model>[0])
    } catch {
      tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'unknown_model' })
      console.warn(
        `[TokenCounter:openai] model "${this.modelName}" unknown to tiktoken; using cl100k_base`
      )
      this.encoder = get_encoding('cl100k_base')
    }
  }

  async count(messages: ChatMessage[], tools: ToolDefinition[] = []): Promise<number> {
    if (!this.encoder) await this.warmup()
    return this.countSync(messages, tools)
  }

  countSync(messages: ChatMessage[], tools: ToolDefinition[] = []): number {
    if (!this.encoder) {
      tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'no_warmup' })
      return Math.ceil(heuristicCount(messages) * 1.5)
    }
    let total = 0
    for (const msg of messages) {
      total += 3 // per-message overhead (role + separators)
      total += this.encoder.encode(msg.content ?? '').length
      if (msg.name) total += this.encoder.encode(msg.name).length
      if (msg.tool_call_id) total += this.encoder.encode(msg.tool_call_id).length
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += this.encoder.encode(tc.id).length
          total += this.encoder.encode(tc.name).length
          total += this.encoder.encode(JSON.stringify(tc.arguments ?? {})).length
        }
      }
    }
    for (const t of tools) {
      total += this.encoder.encode(t.name).length
      total += this.encoder.encode(t.description ?? '').length
      total += this.encoder.encode(JSON.stringify(t.parameters ?? {})).length
    }
    total += 3 // trailing prime
    return total
  }

  recordObservedUsage(usage: { input_tokens: number; output_tokens: number }): void {
    this.observed = usage.input_tokens
  }

  lastObservedInputTokens(): number | null {
    return this.observed
  }
}
