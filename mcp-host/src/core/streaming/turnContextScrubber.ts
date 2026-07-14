/**
 * T2.2 — Streaming scrubber for `<turn-context>` fences.
 *
 * If the LLM ever echoes the volatile block we inject at the head of user
 * messages (e.g. when reciting context back to the user), strip it from the
 * output before the consumer (SSE channel, chat UI, etc.) sees it. The
 * scrubber is fence-aware across chunk boundaries: the closing `</turn-context>`
 * may arrive in a later chunk than the opening `<turn-context>` and the
 * fence header itself may be split mid-marker.
 *
 * Direct port of the `StreamingContextScrubber` pattern from Hermes
 * (`.specs/mcp-hermes/1-diagnostic-hermes.md:85-87`).
 */
const OPEN = '<turn-context>'
const CLOSE = '</turn-context>'

export class TurnContextScrubber {
  private buffer = ''
  private inFence = false

  /** Feed a streaming chunk; returns the safe-to-emit slice. */
  process(chunk: string): string {
    this.buffer += chunk
    let out = ''
    let cursor = 0
    while (cursor < this.buffer.length) {
      if (!this.inFence) {
        const openIdx = this.buffer.indexOf(OPEN, cursor)
        if (openIdx === -1) {
          const safeEnd = findSafePrefixEnd(this.buffer, cursor, OPEN)
          out += this.buffer.slice(cursor, safeEnd)
          this.buffer = this.buffer.slice(safeEnd)
          return out
        }
        out += this.buffer.slice(cursor, openIdx)
        cursor = openIdx + OPEN.length
        this.inFence = true
      } else {
        const closeIdx = this.buffer.indexOf(CLOSE, cursor)
        if (closeIdx === -1) {
          // Hold onto everything between the unclosed open and end-of-buffer.
          // The CLOSE marker may straddle into the next chunk.
          this.buffer = this.buffer.slice(cursor)
          return out
        }
        cursor = closeIdx + CLOSE.length
        this.inFence = false
      }
    }
    this.buffer = ''
    return out
  }

  /** End of stream. Anything still inside an unclosed fence is dropped. */
  flush(): string {
    if (this.inFence) {
      this.buffer = ''
      return ''
    }
    const tail = this.buffer
    this.buffer = ''
    return tail
  }
}

/**
 * Return an index `i` such that `buf.slice(from, i)` cannot accidentally
 * contain part of an upcoming `marker`. In practice: if the buffer ends with
 * a strict prefix of `marker`, hold that prefix back until the next chunk.
 */
function findSafePrefixEnd(buf: string, from: number, marker: string): number {
  for (let len = marker.length - 1; len > 0; len--) {
    const start = buf.length - len
    if (start < from) continue
    if (buf.endsWith(marker.slice(0, len))) {
      return start
    }
  }
  return buf.length
}
