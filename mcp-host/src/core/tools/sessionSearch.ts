/**
 * T3.1 — `clerum__session_search` native tool.
 *
 * Lets the LLM recall past messages of the **same user** that issued the
 * current turn. The signature exposes `query`, `limit`, `since`, `scope` —
 * deliberately NOT `user_id`: the user identity is derived server-side from
 * the `IncomingMessage` that originated the turn (whose `sender` is already
 * pinned to `auth.sub` upstream for the `rpc` channel and to the
 * channel-reader's authenticated bridge for telegram/email/slack).
 *
 * Security posture (mirrors `T3.1-session-search.md §5`):
 *   - `params.user_id` / `params.userId` are silently ignored. We bump
 *     `clerum_session_search_unauthorized_user_id_attempts_total` so the
 *     attempt is observable in Prometheus without leaking that knowledge
 *     back to the caller.
 *   - `limit` is hard-clamped to `[1, 50]`; the LLM cannot fan out wide.
 *   - `scope='this_channel'` (default) ties the search to the originating
 *     `channelType`; any other value (or omission) falls back to that default.
 *     Only the literal `'all_channels'` widens the scope.
 *   - Empty/blank queries short-circuit before touching SQL.
 */
import type { IncomingMessage } from '../../server'
import { Tool } from '../interfaces'
import { SessionSearchService, sessionSearchUnauthorizedAttempts } from '../sessionSearch'
import { ToolOutput } from '../types'

export class SessionSearchTool implements Tool {
  constructor(
    private readonly service: SessionSearchService,
    private readonly sourceMessage: IncomingMessage | undefined
  ) {}

  name(): string {
    return 'clerum__session_search'
  }

  description(): string {
    return (
      'Search messages across past sessions of the same user. ' +
      'Returns short snippets with session_id, timestamp, channel, role. ' +
      'Use BEFORE asking "do you remember when…?". ' +
      'Scope defaults to the current channel; pass scope="all_channels" to widen. ' +
      'Cannot search across users: this is always limited to your interlocutor.'
    )
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "FTS5 query string. Supports MATCH operators: 'foo bar' (AND), " +
            "'\"exact phrase\"', 'foo OR bar', 'foo NOT bar'.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
          description: 'Max results to return (hard ceiling 50).',
        },
        since: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601 timestamp; only messages at or after this time are returned.',
        },
        scope: {
          type: 'string',
          enum: ['this_channel', 'all_channels'],
          default: 'this_channel',
          description:
            'Scope to current channel (default) or all channels of the same user. ' +
            'No other values are honored.',
        },
      },
      required: ['query'],
    }
  }

  requiresSanitization(): boolean {
    return false
  }

  requiresApproval(): boolean {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()

    // Anti-bypass: count any caller-supplied `user_id`/`userId` even when the
    // value is missing/garbled. The metric is silent to the caller; the
    // counter is what surfaces the attempt in Prometheus.
    if ('user_id' in params || 'userId' in params) {
      sessionSearchUnauthorizedAttempts?.inc()
    }

    if (!this.sourceMessage) {
      return this.error('Session context unavailable', start)
    }

    const userId = this.sourceMessage.sender
    const channelType = this.sourceMessage.channelType
    if (!userId) {
      return this.error('Session context unavailable', start)
    }

    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (!query) return this.error('Empty query', start)

    const requestedLimit = Number(params.limit ?? 20)
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20, 1),
      50
    )

    const since =
      typeof params.since === 'string' && params.since.length > 0 ? params.since : undefined

    const scope = params.scope === 'all_channels' ? 'all_channels' : 'this_channel'
    const effectiveChannelType = scope === 'this_channel' ? channelType : undefined

    try {
      const result = await this.service.search(
        {
          query,
          userId,
          channelType: effectiveChannelType,
          since,
          limit,
        },
        'llm'
      )
      return {
        content: JSON.stringify(result),
        duration_ms: Date.now() - start,
        is_error: false,
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return this.error(`Search failed: ${detail}`, start)
    }
  }

  private error(message: string, start: number): ToolOutput {
    return { content: message, duration_ms: Date.now() - start, is_error: true }
  }
}
