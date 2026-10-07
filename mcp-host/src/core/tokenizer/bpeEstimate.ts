/**
 * BPE token estimate for the OpenAI-family tokenizer.
 *
 * Healthy estimates use bounded cl100k_base encoding. Encoder failures use
 * the full UTF-8 byte length, including zero for empty text, without dividing
 * by a guessed bytes-per-token ratio.
 *
 * The cl100k_base encoder is loaded lazily on first use, from the same
 * `get_encoding` helper `OpenAITokenCounter` already imports, and reused for
 * the life of the process. A load or encode failure never throws and never
 * aborts startup: the exact byte length is returned, one bounded metric
 * counter and one structured warning record the reason. A failed initial load
 * keeps using the byte bound for this process rather than repeatedly loading
 * an unavailable encoder.
 */
import { type Tiktoken, get_encoding } from 'tiktoken'
import { logger } from '../../logger'
import { encodeLength } from './encodeLength'
import { tokenizerFallbackTotal } from './metrics'

let encoder: Tiktoken | null = null
let encoderLoadFailed = false
let warned = false

/** Fixed reason values: never an exception name and never text content. */
export type BpeFallbackReason = 'encoder_load_failed' | 'encode_failed'

function warnOnce(reason: BpeFallbackReason): void {
  if (warned) return
  warned = true
  logger.warn(
    { component: 'BpeEstimate', reason },
    'BPE token estimate unavailable; using UTF-8 byte length'
  )
}

function getEncoder(): Tiktoken | null {
  if (encoder) return encoder
  if (encoderLoadFailed) return null
  try {
    encoder = get_encoding('cl100k_base')
    return encoder
  } catch {
    encoderLoadFailed = true
    tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'bpe_estimate_failed' })
    warnOnce('encoder_load_failed')
    return null
  }
}

/**
 * Token estimate for `text` under cl100k_base, with the exact UTF-8 byte
 * length as the documented conservative fallback.
 */
export function bpeTokenEstimate(text: string): number {
  if (text.length === 0) return 0
  const encoderOrNull = getEncoder()
  if (!encoderOrNull) return Buffer.byteLength(text, 'utf8')
  try {
    return encodeLength(encoderOrNull, text)
  } catch {
    tokenizerFallbackTotal.inc({ provider: 'openai', reason: 'bpe_estimate_failed' })
    warnOnce('encode_failed')
    return Buffer.byteLength(text, 'utf8')
  }
}
