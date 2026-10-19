/**
 * T3.1 — `SessionSearchService`. Single backend for the native tool and the
 * REST endpoint.
 *
 * Inputs are already authenticated at the boundary (caller resolves `userId`
 * from JWT or `sourceMessage.sender`). This service trusts the caller for
 * `userId` and enforces nothing more — it only owns the SQL projection and
 * the result-shaping. The MATCH expression is forwarded verbatim to FTS5;
 * binding parameters neutralize SQL injection.
 */
import { Counter, Histogram } from 'prom-client'
import type { SearchMessageRow } from '../../db/worker/protocol'
import type { PersistQueue } from '../conversation/persistence/persistQueue'
import type { SessionSearchArgs, SessionSearchResult, SessionSearchResultItem } from './types'

const sessionSearchCallsCounter = (() => {
  try {
    return new Counter({
      name: 'clerum_session_search_calls_total',
      help: 'Number of clerum__session_search invocations',
      labelNames: ['caller'] as const,
    })
  } catch {
    return undefined
  }
})()

/**
 * Counter incremented when a caller (LLM via tool params) supplies a
 * `user_id` / `userId` that we ignore — `userId` is always derived
 * server-side from `sourceMessage.sender`. Wired in the **tool adapter**
 * (`core/tools/sessionSearch.ts:97`), NOT in this service, because the REST
 * route (`server/routes.ts:handleSessionSearchRoute`) never accepts a
 * client-supplied `user_id`: the route's only user filter is `auth.sub`.
 * Surfacing the counter here keeps it co-located with the rest of the
 * search instruments while the increment lives at the actual anti-bypass
 * boundary.
 */
const sessionSearchUnauthorizedAttempts = (() => {
  try {
    return new Counter({
      name: 'clerum_session_search_unauthorized_user_id_attempts_total',
      help: 'Caller-supplied user_id args that were ignored (always derived server-side)',
    })
  } catch {
    return undefined
  }
})()

const sessionSearchLatency = (() => {
  try {
    return new Histogram({
      name: 'clerum_session_search_latency_seconds',
      help: 'End-to-end latency of clerum__session_search',
      labelNames: ['caller'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    })
  } catch {
    return undefined
  }
})()

const sessionSearchResults = (() => {
  try {
    return new Histogram({
      name: 'clerum_session_search_results_returned',
      help: 'Number of results returned per session search call',
      buckets: [0, 1, 5, 10, 20, 50],
    })
  } catch {
    return undefined
  }
})()

const sessionSearchRetentionSweep = (() => {
  try {
    return new Counter({
      name: 'clerum_session_search_retention_sweep_deleted_total',
      help: 'Sessions removed by the boot-time retention sweep',
    })
  } catch {
    return undefined
  }
})()

export {
  sessionSearchCallsCounter,
  sessionSearchUnauthorizedAttempts,
  sessionSearchLatency,
  sessionSearchResults,
  sessionSearchRetentionSweep,
}

/**
 * Rows one retention-sweep operation may delete. Measured on the real worker
 * with 400k expired messages: max 123 ms per message-phase batch. Session
 * phase, with 200k expired sessions and the `parent_session_id` index
 * (migration 017): max 32 ms per batch (about 2.4 s without the index).
 * Both are far below the sync timeout and the worker progress bound.
 * The cap counts rows, not bytes: the FTS delete trigger re-tokenizes each
 * deleted message's content, so a batch of very large messages takes longer.
 */
const RETENTION_SWEEP_BATCH_ROWS = 250

export interface SessionSearchServiceDeps {
  persistQueue: PersistQueue
}

export class SessionSearchService {
  constructor(private readonly deps: SessionSearchServiceDeps) {}

  /**
   * Run an FTS5 search against the persisted messages table.
   *
   * `args.userId` is the canonical filter — already resolved server-side at the
   * caller boundary. Callers MUST NOT take `userId` from tool params or query
   * strings; see `SessionSearchTool` and `handleSessionSearchRoute` for the
   * derivation rules.
   */
  async search(args: SessionSearchArgs, caller: 'llm' | 'rest'): Promise<SessionSearchResult> {
    const end = sessionSearchLatency?.labels(caller).startTimer()
    try {
      const rows = await this.deps.persistQueue.enqueueSync<SearchMessageRow[]>({
        kind: 'fts_search_messages',
        query: args.query,
        userId: args.userId,
        channelType: args.channelType,
        since: args.since,
        limit: args.limit,
      })
      const results: SessionSearchResultItem[] = rows.map(row => ({
        snippet: row.snippet,
        session_id: row.session_id,
        timestamp: new Date(row.timestamp * 1000).toISOString(),
        channel: row.channel ?? '',
        role: row.role,
      }))
      sessionSearchCallsCounter?.labels(caller).inc()
      sessionSearchResults?.observe(results.length)
      return { results, total: results.length }
    } finally {
      end?.()
    }
  }

  /**
   * Boot-time retention sweep. Drops sessions with `end_reason IS NOT NULL`
   * whose `ended_at` is older than `retentionDays`. In-flight sessions
   * (`end_reason IS NULL`) are always preserved.
   *
   * The sweep runs as a sequence of worker operations of at most
   * `RETENTION_SWEEP_BATCH_ROWS` rows each, so the worker acknowledges every
   * batch and a large backlog never trips the queue's progress bound. A batch
   * deletes an expired session's messages before its row, so between batches
   * the session would load with part of its history; `main.ts` awaits the
   * whole sweep before bootstrap and before the Host serves traffic, so no
   * load runs between batches. The cutoff is fixed before the first batch,
   * so the loop ends once the expired set is empty.
   *
   * Idempotent. Failures are propagated to the caller; `main.ts` logs them.
   */
  async sweepRetention(retentionDays: number): Promise<number> {
    const cutoffEpoch = Date.now() / 1000 - retentionDays * 86400
    let deletedSessions = 0
    for (;;) {
      const batch = await this.deps.persistQueue.enqueueSync<{
        deleted_messages: number
        deleted_sessions: number
      }>({ kind: 'sweep_closed_sessions', cutoffEpoch, limit: RETENTION_SWEEP_BATCH_ROWS })
      sessionSearchRetentionSweep?.inc(batch.deleted_sessions)
      deletedSessions += batch.deleted_sessions
      if (batch.deleted_messages === 0 && batch.deleted_sessions === 0) return deletedSessions
    }
  }
}
