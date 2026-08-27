/**
 * T3.1 — shared types for `clerum__session_search` (tool + REST endpoint).
 *
 * The same backend handler serves both surfaces; the only difference is how
 * `userId` is derived (sourceMessage.sender vs. rpc-proxy's trusted edge).
 * Both call sites land in `SessionSearchService.search` with the user already
 * resolved server-side.
 */

export interface SessionSearchArgs {
  /**
   * FTS5 MATCH expression. Forwarded verbatim to SQLite; malformed queries
   * surface as an error in `ToolOutput`/REST 500. We do not sanitize: the
   * binding-parameterized statement neutralizes SQL injection on its own.
   */
  query: string
  /**
   * Authenticated user identifier. ALWAYS derived server-side. The tool
   * resolves it from `sourceMessage.sender`; the REST handler resolves it
   * from rpc-proxy's validated edge context. Never from caller input.
   */
  userId: string
  /**
   * When set, restricts results to messages whose session shares this
   * `channel_type`. When omitted the search spans every channel of the user.
   */
  channelType?: string
  /** ISO 8601 timestamp; messages older than this are filtered out. */
  since?: string
  /** Max results (post-clamp). Hard ceiling enforced by callers (50). */
  limit: number
}

export interface SessionSearchResultItem {
  snippet: string
  session_id: string
  /** ISO 8601 string. Converted from REAL epoch seconds at the service layer. */
  timestamp: string
  channel: string
  role: string
}

export interface SessionSearchResult {
  results: SessionSearchResultItem[]
  total: number
}
