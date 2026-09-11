/**
 * U5 (mcp-oauth reactive consent) — cold-start buffer for OAuth completions.
 *
 * The OAuth "Connect <server>" deep link (`clerum://oauth-completed?…&source=mcp
 * &mcpServerName=<X>`) can arrive BEFORE the per-chat FSM snapshot has been
 * seeded — sessions load async/auth-gated after `rendererReady`, so on a cold
 * start `resolveConnectResumeTargets(getSnapshot(), X)` returns `[]` even though
 * the grant now exists and a conversation is suspended on that server. Dropping
 * the completion there loses the auto-resume (recoverable only by a second user
 * click).
 *
 * This is a bounded buffer-and-retry, NOT a decision module: no precedence,
 * merge, ordering or conflict resolution. A completion that found no targets is
 * kept (keyed by `mcpServerName`, with a wall-clock deadline). It stays buffered
 * until its deadline — it is NOT removed on the first match — because the real
 * cold-start seam (`seedSessionSnapshots`) dispatches ONE session per snapshot
 * (one store notification each), so sibling conversations suspended on the SAME
 * server surface across SEPARATE drains. Removing the entry on the first match
 * would resume only the sessions already seeded at that instant and silently drop
 * the later siblings — breaking the titular guarantee that a per-user grant
 * resumes EVERY conversation waiting on that server. Instead, every drain within
 * the window re-evaluates `resolve(server)` and fires whatever it returns.
 *
 * Idempotency is delegated to the caller, not re-implemented here (which would
 * drift toward a decision module): a conversation that has been resumed leaves
 * `awaiting_approval` (its FSM entry moves to `processing`), so it stops being a
 * target on the next `resolve` — each sibling fires once as a natural
 * consequence. Even a redundant re-fire is a guarded no-op: `decideApproval`
 * step 1 short-circuits an already-decided request client-side, and mcp-host is
 * idempotent per `requestId` server-side. Stale entries are discarded on the
 * first drain past their deadline — no timer, no zombie resume, no unbounded
 * growth (bounded by the number of distinct servers).
 *
 * Pure and store-agnostic: the caller injects a `resolve(server) => targets`
 * closure at drain time (which reads the live snapshot), so this is exhaustively
 * unit-testable without React or a store.
 */
export interface McpOauthResumeBuffer<T> {
  /**
   * Buffer a completion whose resume had no targets yet. Re-buffering the same
   * server refreshes its deadline (last write wins — a repeat completion is not
   * a second pending resume). A blank server name is ignored (fail-closed).
   */
  add(mcpServerName: string, deadline: number): void
  /**
   * Re-evaluate every buffered completion against the current snapshot.
   *  - An entry whose deadline has passed (`now > deadline`) is dropped (the ONLY
   *    removal path, besides an `add` that refreshes the deadline).
   *  - Every live entry fires whatever `resolve(server)` returns — nothing is
   *    removed on a match, so siblings on the same server that appear in LATER
   *    drains (the real per-dispatch seam) still resume within the window.
   * Returns the flattened targets to fire, in buffer-insertion order. A resumed
   * conversation drops out of `resolve` on its own, so each sibling fires once;
   * any redundant re-fire is a guarded no-op (see the module docstring).
   */
  drain(now: number, resolve: (mcpServerName: string) => T[]): T[]
  /** Number of completions still pending (0 ⇒ drain is a no-op). */
  size(): number
}

export function createMcpOauthResumeBuffer<T>(): McpOauthResumeBuffer<T> {
  // server name -> deadline (epoch ms). Map keeps insertion order for a stable
  // drain order across concurrent pending completions.
  const pending = new Map<string, number>()

  return {
    add(mcpServerName, deadline) {
      const server = String(mcpServerName || '').trim()
      if (!server) return
      pending.set(server, deadline)
    },
    drain(now, resolve) {
      if (pending.size === 0) return []
      const fired: T[] = []
      for (const [server, deadline] of pending) {
        if (now > deadline) {
          // TTL is the only removal path: a stale grant must not drive a resume
          // long after the window.
          pending.delete(server)
          continue
        }
        // Kept alive until the deadline — re-fire whatever resolves NOW so a
        // sibling seeded in a later dispatch is still resumed.
        fired.push(...resolve(server))
      }
      return fired
    },
    size() {
      return pending.size
    },
  }
}
