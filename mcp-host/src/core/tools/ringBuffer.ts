/**
 * Line-aware byte-capped ring buffer for streaming tool output.
 *
 * Used by the progress watcher in executeSingleTool to accumulate stdout/stderr
 * from long-running tools and publish periodic snapshots. The dirty flag lets
 * the watcher skip re-publishing when nothing has changed.
 *
 * Line alignment: after an eviction that leaves the head starting mid-line,
 * we trim the head to the first newline so snapshot()/contents() never return
 * a partial line at the start of the buffer.
 */
export class RingBuffer {
  private chunks: string[] = []
  private totalBytes = 0
  private dirty = false

  constructor(private readonly maxBytes: number = 64 * 1024) {}

  append(chunk: string): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.totalBytes += Buffer.byteLength(chunk, 'utf8')
    this.dirty = true
    this.evictToFit()
  }

  /** Returns current buffer contents, or "" if nothing was appended since last snapshot(). */
  snapshot(): string {
    if (!this.dirty) return ''
    this.dirty = false
    return this.chunks.join('')
  }

  /** Returns current buffer contents regardless of dirty state (for final return). */
  contents(): string {
    return this.chunks.join('')
  }

  private evictToFit(): void {
    // Keep at least one chunk — never evict the last chunk, even if it alone
    // exceeds capacity. This ensures a single oversized append is preserved
    // (trimmed at the first newline below if needed).
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const oldest = this.chunks.shift()!
      this.totalBytes -= Buffer.byteLength(oldest, 'utf8')
    }
    // After dropping whole chunks, the new head chunk may start mid-line. Trim
    // it at the first newline so snapshot() / contents() never return a partial
    // line at the head. If no newline exists in the new head chunk, leave it —
    // the next newline-bearing chunk will realign on the following eviction.
    if (this.chunks.length > 0) {
      const head = this.chunks[0]
      const firstNewline = head.indexOf('\n')
      // Only trim if there's a newline AND there's content after it (otherwise
      // cutting would leave an empty string and we'd lose the chunk entirely).
      if (firstNewline >= 0 && firstNewline < head.length - 1) {
        const trimmed = head.slice(firstNewline + 1)
        this.totalBytes -= Buffer.byteLength(head, 'utf8') - Buffer.byteLength(trimmed, 'utf8')
        this.chunks[0] = trimmed
      }
    }
  }
}
