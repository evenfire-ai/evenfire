/**
 * UTF-16-safe encode-length helper shared by the tokenizer implementations.
 *
 * Two constraints shape this helper:
 *
 *  1. `encode()` with the default arguments REFUSES the special-token syntax
 *     (`<|endoftext|>`, `<|fim_prefix|>`, …) and throws
 *     `The text contains a special token that is not allowed`. Tool output is
 *     untrusted, so a page that happens to carry that literal would otherwise
 *     turn a token count into a task failure. Passing `[]` for
 *     `allowedSpecial`/`disallowedSpecial` lets tiktoken encode the syntax as
 *     ordinary text instead of rejecting the request.
 *
 *  2. A single call over a whole attachment page feeds one unbounded input into
 *     the WASM encoder. Slicing at 1024 UTF-16 units bounds the per-call input;
 *     throughput is comparable to one whole-string call, so the slicing is
 *     about the bound, not about speed.
 *
 * BPE counts can differ across slice boundaries. Aligning a cut with a nearby
 * line break or space reduces that difference for prose and line-based data.
 * The lookback is bounded; the caller still measures the whole emitted message
 * with its applicable counters rather than assuming a byte-to-token ratio.
 *
 * A slice boundary must never split a surrogate pair: `str.slice` on a lone
 * high surrogate produces an unpaired code unit, which the encoder replaces
 * with U+FFFD and the count drifts. The adjuster below moves the boundary back
 * one unit when the cut would land between a high and a low surrogate.
 */
import type { Tiktoken } from 'tiktoken'

/** UTF-16 code units per encode call. See the file header for the rationale. */
export const ENCODE_SLICE_UTF16_UNITS = 1024

/**
 * How far back the aligner may walk to find a separator. Bounded so a page of
 * dense characters still encodes in O(n) slices instead of degenerating into a
 * single full-page call.
 */
export const ENCODE_BOUNDARY_LOOKBACK_UTF16_UNITS = 256

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isLineBreak(code: number): boolean {
  return code === 0x0a || code === 0x0d
}

function isInlineSeparator(code: number): boolean {
  return code === 0x20 || code === 0x09
}

/**
 * Position <= `nominalEnd` where the next slice can start cleanly, or
 * `nominalEnd` itself when the bounded window holds no separator. Line breaks
 * win over spaces to keep complete lines together when possible; within one
 * class the nearest candidate wins.
 */
function alignSliceEnd(text: string, start: number, nominalEnd: number): number {
  const floor = Math.max(start + 1, nominalEnd - ENCODE_BOUNDARY_LOOKBACK_UTF16_UNITS)
  let inlineCandidate = nominalEnd
  for (let end = nominalEnd; end > floor; end--) {
    const code = text.charCodeAt(end - 1)
    if (isLineBreak(code)) return end
    if (inlineCandidate === nominalEnd && isInlineSeparator(code)) inlineCandidate = end
  }
  return inlineCandidate
}

/**
 * Number of tokens `encoder` assigns to `text`.
 *
 * Encodes in bounded UTF-16 slices, never splitting a surrogate pair, and
 * always with special-token syntax treated as ordinary text. Throws only what
 * the encoder itself throws; callers that must not fail own the fallback.
 */
export function encodeLength(encoder: Tiktoken, text: string): number {
  if (text.length === 0) return 0
  let total = 0
  let start = 0
  while (start < text.length) {
    const nominalEnd = Math.min(start + ENCODE_SLICE_UTF16_UNITS, text.length)
    let end = nominalEnd
    if (nominalEnd < text.length) end = alignSliceEnd(text, start, nominalEnd)
    if (
      end < text.length &&
      isHighSurrogate(text.charCodeAt(end - 1)) &&
      isLowSurrogate(text.charCodeAt(end))
    ) {
      end -= 1
    }
    total += encoder.encode(text.slice(start, end), [], []).length
    start = end
  }
  return total
}
