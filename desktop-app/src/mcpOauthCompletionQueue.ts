/**
 * U5 (mcp-oauth reactive consent) — cold-start delivery guard for the OAuth
 * `oauth-completed?source=mcp` deep link.
 *
 * On a cold start the deep link arrives (macOS `app.on('open-url')`, or the
 * non-darwin startup-argv sweep) BEFORE the renderer has mounted and installed
 * its `onMcpOauthCompleted` listener. A bare `webContents.send` at that moment is
 * swallowed and the suspended task never resumes. This mirrors the
 * `pendingEvenfireUrls` queue: deliver immediately when the renderer is ready,
 * otherwise queue and drain after the `app:rendererReady` handshake.
 *
 * Extracted as an injectable class (like `SandboxUiDeepLinkQueue`) so the
 * "never swallowed on cold start" invariant is unit-testable without booting the
 * Electron main process.
 */
export interface McpOauthCompletion {
  mcpServerName: string
  provider: string
}

export class McpOauthCompletionQueue {
  private readonly pending: McpOauthCompletion[] = []

  /**
   * @param deliver Sends the completion to the renderer, returning `true` iff it
   *   was accepted (window alive AND renderer past its ready handshake). A
   *   `false` return means "not ready" → the completion is queued.
   */
  constructor(
    private readonly deliver: (completion: McpOauthCompletion) => boolean,
    private readonly maxSize = 20
  ) {}

  /** Deliver now if the renderer accepts it; otherwise queue for `drain()`. */
  submit(completion: McpOauthCompletion): void {
    if (this.deliver(completion)) return
    // Dedup identical completions (a retried deep link) while keeping distinct
    // servers/providers — two conversations on different servers must both queue.
    const duplicate = this.pending.some(
      c => c.mcpServerName === completion.mcpServerName && c.provider === completion.provider
    )
    if (duplicate) return
    this.pending.push(completion)
    if (this.pending.length > this.maxSize) this.pending.shift()
  }

  /**
   * Flush queued completions — called after the renderer-ready handshake. Any the
   * renderer still cannot accept (window died mid-drain) are re-queued rather than
   * dropped.
   */
  drain(): void {
    const batch = this.pending.splice(0)
    for (const completion of batch) {
      if (!this.deliver(completion)) this.pending.push(completion)
    }
  }

  pendingCount(): number {
    return this.pending.length
  }
}
