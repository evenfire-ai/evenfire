/**
 * Dispatcher — handles `WorkerOp` requests received over the message port.
 *
 * Lives in its own file (separate from `dbWorker.ts`) so tests can drive it
 * directly with an in-memory Database and stubbed statements, without the
 * worker_threads boilerplate.
 */
import type { Database } from 'better-sqlite3'
import { PreparedStatements, prepareStatements } from '../statements'
import { withBusyRetry } from './busyRetry'
import type {
  LoadAllPendingApprovalsRow,
  PendingApprovalRow,
  PersistedSession,
  ReapedSession,
  SessionRow,
  WorkerOp,
} from './protocol'

export interface DispatcherDeps {
  db: Database
  statements: PreparedStatements
}

export function createDispatcher(db: Database): DispatcherDeps {
  return { db, statements: prepareStatements(db) }
}

/**
 * Strict ISO 8601 — `YYYY-MM-DD` optionally followed by `THH:MM[:SS[.sss]]`
 * and a `Z`/`±HH:MM` offset. Rejects bare numeric strings ("1000000") that
 * `Date.parse` would otherwise happily interpret as a four-digit year. The
 * dispatcher is the last line of defense before raw SQL, so we fail hard
 * here rather than at the REST/tool layer (which has its own checks).
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/

export function parseIsoSinceOrThrow(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (!ISO_8601_RE.test(raw)) {
    const err: Error & { code?: string } = new Error(
      `fts_search_messages: invalid 'since' value: ${JSON.stringify(raw)} (expected ISO 8601 datetime)`
    )
    err.code = 'INVALID_ARGUMENT'
    throw err
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    const err: Error & { code?: string } = new Error(
      `fts_search_messages: unparseable 'since' value: ${JSON.stringify(raw)}`
    )
    err.code = 'INVALID_ARGUMENT'
    throw err
  }
  return ms / 1000
}

/**
 * Execute a single worker op. Throws on unknown op kinds. Write ops are
 * wrapped in `withBusyRetry`; reads run directly (`better-sqlite3` reads
 * don't hit `SQLITE_BUSY` in WAL mode unless someone forced `journal_mode`
 * back to `delete`).
 *
 * B4 fix — `dispatch` is now async because `withBusyRetry` is async. The
 * inner SQL work (`tx.immediate()`) is still synchronous, so two concurrent
 * `dispatch()` invocations cannot interleave SQL — they only interleave
 * during the inter-retry sleep. The per-session FIFO chain in
 * `PersistQueue.enqueueAsync` keeps ordering correct cross-message.
 */
export async function dispatch(op: WorkerOp, deps: DispatcherDeps): Promise<unknown> {
  const { db, statements: s } = deps
  switch (op.kind) {
    case 'ping':
      return { pong: true }

    case 'insert_session':
      return withBusyRetry(() => {
        const tx = db.transaction((row: SessionRow) => {
          s.insertSession.run({
            id: row.id,
            session_key: row.session_key,
            source: row.source,
            user_id: row.user_id ?? null,
            team_id: row.team_id ?? null,
            channel_type: row.channel_type ?? null,
            channel_id: row.channel_id ?? null,
            thread_id: row.thread_id ?? null,
            model: row.model ?? null,
            system_prompt_stable_hash: row.system_prompt_stable_hash ?? null,
            parent_session_id: row.parent_session_id ?? null,
            started_at: row.started_at,
            ended_at: row.ended_at ?? null,
            end_reason: row.end_reason ?? null,
            message_count: row.message_count ?? 0,
            tool_call_count: row.tool_call_count ?? 0,
            input_tokens: row.input_tokens ?? 0,
            output_tokens: row.output_tokens ?? 0,
            cache_read_tokens: row.cache_read_tokens ?? 0,
            cache_write_tokens: row.cache_write_tokens ?? 0,
            cache_tokens_reported: row.cache_tokens_reported ?? 0,
            title: row.title ?? null,
            state: row.state ?? 'idle',
            active_task_id: row.active_task_id ?? null,
          })
        })
        tx.immediate(op.payload)
        return { ok: true }
      })

    case 'update_session_state':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          // active_task_id: a string sets it; null/undefined pass NULL to the
          // COALESCE (keeps current). The explicit clear below handles null.
          s.updateSessionState.run({
            id: op.sessionId,
            state: op.state,
            ended_at: op.endedAt ?? null,
            end_reason: op.endReason ?? null,
            active_task_id: op.activeTaskId ?? null,
          })
          // D.1 — null means "clear". COALESCE can't clear, so run the
          // dedicated statement in the SAME transaction (atomic with the state
          // change — no window where state=idle but active_task_id is stale).
          if (op.activeTaskId === null) {
            s.clearSessionActiveTask.run({ id: op.sessionId })
          }
        })
        tx.immediate()
        return { ok: true }
      })

    case 'reap_processing_sessions': {
      // D.2 — at boot, every session left in 'processing' has no live reporter
      // (it died with the previous pod). Transition each to 'idle', clear its
      // active_task_id, and append a synthetic error message to the open turn
      // so the chat is usable again and the desktop sees the interruption.
      //
      // Chunked (security P0-3): a spam of processing sessions must not block
      // boot in one giant transaction. One transaction per chunk; the SELECT
      // runs inside it and sees committed state, so the loop terminates once
      // no 'processing' rows remain.
      const chunkSize = op.chunkSize ?? 500
      const nowMs = op.nowEpoch
      const reaped: ReapedSession[] = []
      for (;;) {
        const chunkReaped = await withBusyRetry(() => {
          const tx = db.transaction(() => {
            const sessions = s.selectProcessingSessions.all({ limit: chunkSize }) as Array<{
              id: string
              session_key: string
              active_task_id: string | null
              user_id: string | null
              channel_type: string | null
              channel_id: string | null
              thread_id: string | null
            }>
            const out: ReapedSession[] = []
            for (const sess of sessions) {
              const agg = s.selectSessionMaxOrdinalTurn.get({ session_id: sess.id }) as {
                max_ordinal: number
                max_turn: number
              }
              // Synthetic assistant message on the open turn. The marker lives
              // in content_parts JSON (machine-detectable) while finish_reason
              // stays a conventional 'error' (cross-ref D.2 P3 — no overload of
              // finish_reason, no non-existent error_code column).
              s.insertMessage.run({
                session_id: sess.id,
                ordinal: agg.max_ordinal + 1,
                role: 'assistant',
                content: '[Task interrupted by server restart]',
                content_parts: JSON.stringify({
                  kind: 'system_error',
                  error_code: 'POD_RESTART_DURING_EXECUTION',
                  synthetic: true,
                }),
                tool_call_id: null,
                tool_calls: null,
                tool_name: null,
                timestamp: nowMs / 1000,
                token_count: null,
                finish_reason: 'error',
                spillover_ref: null,
                is_error: 1,
                turn_number: agg.max_turn,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
              })
              s.updateSessionState.run({
                id: sess.id,
                state: 'idle',
                ended_at: null,
                end_reason: null,
                active_task_id: null,
              })
              s.clearSessionActiveTask.run({ id: sess.id })
              out.push({
                sessionId: sess.id,
                sessionKey: sess.session_key,
                userId: sess.user_id,
                channelType: sess.channel_type,
                channelId: sess.channel_id,
                threadId: sess.thread_id,
                activeTaskId: sess.active_task_id,
                reapedAt: nowMs,
              })
            }
            return out
          })
          return tx.immediate()
        })
        if (chunkReaped.length === 0) break
        reaped.push(...chunkReaped)
      }
      return reaped
    }

    case 'reap_awaiting_approval_sessions': {
      // D.8 (F7) / S1 — at boot, transition stuck 'awaiting_approval' sessions to
      // 'idle', delete the stale approval row(s), clear active_task_id, and append
      // a synthetic error message so the chat is usable again and the desktop sees
      // the interruption.
      //
      // Two modes, selected by op.includeLive:
      //  - includeLive=false (D.8 default): reap only sessions whose approval can
      //    no longer resolve (all pending_approvals expired, or the row was already
      //    swept leaving an orphan). Synthetic msg: APPROVAL_EXPIRED_DURING_DOWNTIME.
      //  - includeLive=true (S1, used by the boot reaper): reap EVERY
      //    'awaiting_approval' session, live or expired. After a restart no such
      //    session is resumable (executor rehydration was never implemented), so a
      //    live approval is as un-resolvable as an expired one — handleApproval
      //    finds an empty activeExecutors and returns "Task is no longer awaiting
      //    approval" without transitioning the session, leaving the chat stuck on
      //    "Connecting". Synthetic msg: APPROVAL_INTERRUPTED_BY_RESTART.
      //
      // Runs at PHASE 1b (before approval rehydration) so loadAllPendingApprovals
      // never re-hydrates an approval we just deleted. Chunked like D.2 so a
      // backlog can't stall boot; the SELECT runs inside the tx and sees
      // committed state, so the loop terminates once no eligible rows remain.
      const chunkSize = op.chunkSize ?? 500
      const nowMs = op.nowEpoch
      const nowEpochSeconds = op.nowEpoch / 1000 // pending_approvals.expires_at is REAL seconds
      const includeLive = op.includeLive ?? false
      const syntheticContent = includeLive
        ? '[Approval interrupted by server restart]'
        : '[Approval expired during server downtime]'
      const syntheticErrorCode = includeLive
        ? 'APPROVAL_INTERRUPTED_BY_RESTART'
        : 'APPROVAL_EXPIRED_DURING_DOWNTIME'
      const reaped: ReapedSession[] = []
      for (;;) {
        const chunkReaped = await withBusyRetry(() => {
          const tx = db.transaction(() => {
            const sessions = (
              includeLive
                ? s.selectAwaitingApprovalSessions.all({ limit: chunkSize })
                : s.selectExpiredAwaitingApprovalSessions.all({
                    now_epoch_seconds: nowEpochSeconds,
                    limit: chunkSize,
                  })
            ) as Array<{
              id: string
              session_key: string
              active_task_id: string | null
              user_id: string | null
              channel_type: string | null
              channel_id: string | null
              thread_id: string | null
            }>
            const out: ReapedSession[] = []
            for (const sess of sessions) {
              const agg = s.selectSessionMaxOrdinalTurn.get({ session_id: sess.id }) as {
                max_ordinal: number
                max_turn: number
              }
              s.insertMessage.run({
                session_id: sess.id,
                ordinal: agg.max_ordinal + 1,
                role: 'assistant',
                content: syntheticContent,
                content_parts: JSON.stringify({
                  kind: 'system_error',
                  error_code: syntheticErrorCode,
                  synthetic: true,
                }),
                tool_call_id: null,
                tool_calls: null,
                tool_name: null,
                timestamp: nowMs / 1000,
                token_count: null,
                finish_reason: 'error',
                spillover_ref: null,
                is_error: 1,
                turn_number: agg.max_turn,
                input_tokens: null,
                output_tokens: null,
                cache_read_tokens: null,
                cache_write_tokens: null,
              })
              // Resolve the (expired) approval row(s) atomically with the state
              // flip so PHASE 2's load_all_pending_approvals can't resurrect them.
              // No-op for the orphan case (row already gone).
              s.deletePendingApprovalsBySession.run({ session_id: sess.id })
              s.updateSessionState.run({
                id: sess.id,
                state: 'idle',
                ended_at: null,
                end_reason: null,
                active_task_id: null,
              })
              s.clearSessionActiveTask.run({ id: sess.id })
              out.push({
                sessionId: sess.id,
                sessionKey: sess.session_key,
                userId: sess.user_id,
                channelType: sess.channel_type,
                channelId: sess.channel_id,
                threadId: sess.thread_id,
                activeTaskId: sess.active_task_id,
                reapedAt: nowMs,
              })
            }
            return out
          })
          return tx.immediate()
        })
        if (chunkReaped.length === 0) break
        reaped.push(...chunkReaped)
      }
      return reaped
    }

    case 'update_session_counters':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          s.updateSessionCounters.run({
            id: op.sessionId,
            message_count_delta: op.counters.messageCountDelta ?? 0,
            tool_call_count_delta: op.counters.toolCallCountDelta ?? 0,
            input_tokens_delta: op.counters.inputTokensDelta ?? 0,
            output_tokens_delta: op.counters.outputTokensDelta ?? 0,
            cache_read_tokens_delta: op.counters.cacheReadTokensDelta ?? 0,
            cache_write_tokens_delta: op.counters.cacheWriteTokensDelta ?? 0,
            cache_reported: op.counters.cacheReported ? 1 : 0,
          })
        })
        tx.immediate()
        return { ok: true }
      })

    case 'update_session_prompt_stable_hash':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          s.updateSessionPromptStableHash.run({
            id: op.sessionId,
            system_prompt_stable_hash: op.stableHash,
          })
        })
        tx.immediate()
        return { ok: true }
      })

    case 'insert_message':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          s.insertMessage.run({
            session_id: op.payload.session_id,
            ordinal: op.payload.ordinal,
            role: op.payload.role,
            content: op.payload.content,
            content_parts: op.payload.content_parts,
            tool_call_id: op.payload.tool_call_id,
            tool_calls: op.payload.tool_calls,
            tool_name: op.payload.tool_name,
            timestamp: op.payload.timestamp,
            token_count: op.payload.token_count,
            finish_reason: op.payload.finish_reason,
            spillover_ref: op.payload.spillover_ref,
            is_error: op.payload.is_error,
            turn_number: op.payload.turn_number,
            // Named-param bind requires every key present; default to NULL for
            // callers that don't stamp per-turn usage (migration 005).
            input_tokens: op.payload.input_tokens ?? null,
            output_tokens: op.payload.output_tokens ?? null,
            cache_read_tokens: op.payload.cache_read_tokens ?? null,
            cache_write_tokens: op.payload.cache_write_tokens ?? null,
          })
          s.updateSessionCounters.run({
            id: op.payload.session_id,
            message_count_delta: 1,
            tool_call_count_delta: op.payload.role === 'assistant' && op.payload.tool_calls ? 1 : 0,
            input_tokens_delta: 0,
            output_tokens_delta: 0,
            cache_read_tokens_delta: 0,
            cache_write_tokens_delta: 0,
            cache_reported: 0,
          })
        })
        tx.immediate()
        return { ok: true }
      })

    case 'replace_messages':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          s.deleteMessagesBySession.run(op.sessionId)
          for (const m of op.messages) {
            s.insertMessage.run({
              session_id: m.session_id,
              ordinal: m.ordinal,
              role: m.role,
              content: m.content,
              content_parts: m.content_parts,
              tool_call_id: m.tool_call_id,
              tool_calls: m.tool_calls,
              tool_name: m.tool_name,
              timestamp: m.timestamp,
              token_count: m.token_count,
              finish_reason: m.finish_reason,
              spillover_ref: m.spillover_ref,
              is_error: m.is_error,
              turn_number: m.turn_number,
              input_tokens: m.input_tokens ?? null,
              output_tokens: m.output_tokens ?? null,
              cache_read_tokens: m.cache_read_tokens ?? null,
              cache_write_tokens: m.cache_write_tokens ?? null,
            })
          }
        })
        tx.immediate()
        return { ok: true, count: op.messages.length }
      })

    case 'insert_pending_approval':
      return withBusyRetry(() => {
        const tx = db.transaction((row: PendingApprovalRow) => {
          s.insertPendingApproval.run(row)
        })
        tx.immediate(op.payload)
        return { ok: true }
      })

    case 'delete_pending_approval':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          s.deletePendingApproval.run(op.requestId)
        })
        tx.immediate()
        return { ok: true }
      })

    case 'load_active_session': {
      const sessionRow = s.selectSessionBySessionKey.get(op.sessionKey) as SessionRow | undefined
      if (!sessionRow) return null
      const messageRows = s.selectMessagesBySession.all(sessionRow.id)
      const pendingRow = s.selectPendingApprovalBySession.get(sessionRow.id)
      const persisted: PersistedSession = {
        session: sessionRow,
        messages: messageRows as PersistedSession['messages'],
        pending_approval: (pendingRow ?? null) as PersistedSession['pending_approval'],
      }
      return persisted
    }

    case 'list_sessions_by_prefix': {
      const pattern = `${op.sessionKeyPrefix}%`
      const sessionRows = s.selectSessionsByPrefix.all(pattern) as SessionRow[]
      const result: PersistedSession[] = []
      for (const row of sessionRows) {
        const messageRows = s.selectMessagesBySession.all(row.id)
        const pendingRow = s.selectPendingApprovalBySession.get(row.id)
        result.push({
          session: row,
          messages: messageRows as PersistedSession['messages'],
          pending_approval: (pendingRow ?? null) as PersistedSession['pending_approval'],
        })
      }
      return result
    }

    case 'load_all_pending_approvals': {
      const rows = s.selectPendingApprovalsAll.all() as Array<
        PendingApprovalRow & { session_key: string }
      >
      const out: LoadAllPendingApprovalsRow[] = []
      for (const row of rows) {
        const { session_key, ...approval } = row
        out.push({ approval: approval as PendingApprovalRow, session_key })
      }
      return out
    }

    case 'sweep_expired':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          const expiredApprovals = s.sweepExpiredApprovals.run(op.nowEpoch)
          const expiredSessions = s.sweepEndedSessions.run(op.nowEpoch - op.ttlSeconds)
          return {
            approvals_removed: expiredApprovals.changes,
            sessions_removed: expiredSessions.changes,
          }
        })
        return tx.immediate()
      })

    case 'fts_search': {
      const rows = op.userId
        ? s.ftsSearchByUser.all({ query: op.query, limit: op.limit, user_id: op.userId })
        : s.ftsSearch.all({ query: op.query, limit: op.limit })
      return rows
    }

    case 'fts_search_messages': {
      // T3.1 — `since` is propagated as a SQLite REAL (UNIX seconds) so the
      // comparison with `m.timestamp` (stored as REAL too) is a direct numeric
      // compare instead of lexical text. The handler converts ISO strings.
      //
      // B11 fix: `Date.parse` accepts numeric strings like "1000000" and
      // interprets them as a year — silently dropping a meaningful filter.
      // Reject anything that doesn't look like ISO 8601 BEFORE parsing so the
      // caller sees a hard error instead of a phantom result set.
      const sinceEpoch = parseIsoSinceOrThrow(op.since)
      const rows = s.ftsSearchMessages.all({
        query: op.query,
        user_id: op.userId,
        channel_type: op.channelType ?? null,
        since: sinceEpoch,
        limit: op.limit,
      })
      return rows
    }

    case 'sweep_closed_sessions':
      return withBusyRetry(() => {
        const tx = db.transaction(() => {
          const result = s.sweepClosedSessions.run({ cutoff: op.cutoffEpoch })
          return { deleted_sessions: result.changes }
        })
        return tx.immediate()
      })

    case 'integrity_check': {
      const row = s.integrityCheck.get() as { integrity_check?: string } | undefined
      return { ok: row?.integrity_check === 'ok', detail: row?.integrity_check ?? 'unknown' }
    }

    case 'checkpoint': {
      const result = db.pragma('wal_checkpoint(PASSIVE)')
      return result
    }

    case 'shutdown':
      // Closing happens in the worker entry; dispatcher just returns ack.
      return { ok: true }

    default: {
      const exhaustive: never = op
      throw new Error(`Unknown op kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}
