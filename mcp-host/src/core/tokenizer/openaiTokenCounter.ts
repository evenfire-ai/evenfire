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
 *
 * Every encode goes through `encodeLength` (bounded slices, surrogate-safe,
 * special-token syntax treated as ordinary text) so untrusted tool output can
 * never make a count throw on `<|endoftext|>`. When an encode still fails, the
 * count falls back to the exact UTF-8 byte length of the same fields — never
 * `bytes / 4`, never `0` — and records one bounded metric plus one structured
 * warning.
 */
import { type Tiktoken, encoding_for_model, get_encoding } from 'tiktoken'
import { logger } from '../../logger'
import type { ChatMessage, ToolDefinition } from '../types'
import { encodeLength } from './encodeLength'
import { tokenizerFallbackTotal } from './metrics'
import type { TokenCounter } from './tokenCounter'

/**
 * One-shot guard for the encode-failure warning. `countSync` runs on every
 * pressure decision, so an encoder that stays broken must not log per call.
 */
let encodeFailureWarned = false

/** Fixed reason values: never an exception name, never model or text content. */
export type OpenAiCountFallbackReason = 'no_warmup' | 'encoder_load_failed' | 'encode_failed'

function warnEncodeFailureOnce(reason: OpenAiCountFallbackReason): void {
  if (encodeFailureWarned) return
  encodeFailureWarned = true
  logger.warn(
    { component: 'OpenAITokenCounter', reason },
    'tiktoken encode failed; using the exact UTF-8 byte length as the conservative count'
  )
}

/** An unserializable payload cannot be priced or emitted; saturate the bound. */
function safeJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined
      ? Number.MAX_SAFE_INTEGER
      : Buffer.byteLength(serialized, 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Conservative fallback for a failed encode: the message framing the healthy
 * path always adds (3 per message + 3 trailing prime) plus the exact UTF-8 byte
 * length of every field the healthy path counts. Never `bytes / 4`, and never
 * zero for a message list, because the framing is real request weight.
 */
function byteLengthFallback(messages: ChatMessage[], tools: ToolDefinition[]): number {
  let total = 3 // trailing prime, same as the healthy path
  for (const msg of messages) {
    total += 3 // per-message overhead (role + separators)
    total += Buffer.byteLength(msg.content ?? '', 'utf8')
    if (msg.name) total += Buffer.byteLength(msg.name, 'utf8')
    if (msg.tool_call_id) total += Buffer.byteLength(msg.tool_call_id, 'utf8')
    for (const tc of msg.tool_calls ?? []) {
      total += Buffer.byteLength(tc.id, 'utf8')
      total += Buffer.byteLength(tc.name, 'utf8')
      total += safeJsonBytes(tc.arguments ?? {})
    }
  }
  for (const t of tools) {
    total += Buffer.byteLength(t.name, 'utf8')
    total += Buffer.byteLength(t.description ?? '', 'utf8')
    total += safeJsonBytes(t.parameters ?? {})
  }
  return Math.min(total, Number.MAX_SAFE_INTEGER)
}

export { encodeLength } from './encodeLength'

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
      // The model string is request-controlled, so the record names only the
      // fixed reason; the metric carries the bounded provider label.
      logger.warn(
        { component: 'OpenAITokenCounter', reason: 'unknown_model' },
        'Model unknown to tiktoken; using cl100k_base'
      )
      try {
        this.encoder = get_encoding('cl100k_base')
      } catch {
        // Letting this escape would reject `warmup()` and make the counter
        // unusable on a host whose WASM encoding is unavailable. `countSync`
        // below answers with the conservative byte-length bound instead.
        tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'count_call_failed' })
        warnEncodeFailureOnce('encoder_load_failed')
      }
    }
  }

  async count(messages: ChatMessage[], tools: ToolDefinition[] = []): Promise<number> {
    if (!this.encoder) await this.warmup()
    return this.countSync(messages, tools)
  }

  countSync(messages: ChatMessage[], tools: ToolDefinition[] = []): number {
    if (!this.encoder) {
      tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'no_warmup' })
      warnEncodeFailureOnce('no_warmup')
      return byteLengthFallback(messages, tools)
    }
    const encoder = this.encoder
    try {
      return countWithEncoder(encoder, messages, tools)
    } catch {
      // A broken or partially-loaded encoder must not throw from a count: the
      // conservative byte-length bound keeps every budget check usable.
      tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'count_call_failed' })
      warnEncodeFailureOnce('encode_failed')
      return byteLengthFallback(messages, tools)
    }
  }

  recordObservedUsage(usage: { input_tokens: number; output_tokens: number }): void {
    this.observed = usage.input_tokens
  }

  lastObservedInputTokens(): number | null {
    return this.observed
  }
}

function countWithEncoder(
  encoder: Tiktoken,
  messages: ChatMessage[],
  tools: ToolDefinition[]
): number {
  let total = 0
  for (const msg of messages) {
    total += 3 // per-message overhead (role + separators)
    total += encodeLength(encoder, msg.content ?? '')
    if (msg.name) total += encodeLength(encoder, msg.name)
    if (msg.tool_call_id) total += encodeLength(encoder, msg.tool_call_id)
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += encodeLength(encoder, tc.id)
        total += encodeLength(encoder, tc.name)
        total += encodeLength(encoder, JSON.stringify(tc.arguments ?? {}))
      }
    }
  }
  for (const t of tools) {
    total += encodeLength(encoder, t.name)
    total += encodeLength(encoder, t.description ?? '')
    total += encodeLength(encoder, JSON.stringify(t.parameters ?? {}))
  }
  total += 3 // trailing prime
  return total
}
