/**
 * Prepared statements for the SQLite ConversationStore.
 *
 * Prepared once at worker boot; every dispatcher op reuses the cached
 * statement objects (`better-sqlite3.Statement`). Reparsing the SQL on every
 * call would be ~30% overhead in the hot path.
 *
 * Statements live in a single object so the dispatcher can carry it through
 * the call graph without threading individual handles.
 */
import type { Database, Statement } from 'better-sqlite3'

export interface PreparedStatements {
  insertSession: Statement
  updateSessionState: Statement
  clearSessionActiveTask: Statement
  selectProcessingSessions: Statement
  selectSessionMaxOrdinalTurn: Statement
  selectExpiredAwaitingApprovalSessions: Statement
  selectAwaitingApprovalSessions: Statement
  deleteUnrehydratablePendingApprovals: Statement
  deletePendingApprovalsBySession: Statement
  updateSessionCounters: Statement
  updateSessionSummaryAfterInsert: Statement
  recomputeSessionMessageSummary: Statement
  updateSessionPromptStableHash: Statement
  updateSessionModelSelections: Statement
  selectSessionBySessionKey: Statement
  selectSessionsByPrefix: Statement
  selectSessionSummariesByPrefix: Statement
  selectSessionTurnBounds: Statement
  selectMessagesBySessionNewestTurns: Statement
  selectMessagesBySessionTurnsBefore: Statement
  selectMessagesBySessionTurnsAfter: Statement

  insertMessage: Statement
  selectMessagesBySession: Statement
  deleteMessagesBySession: Statement

  insertPendingApproval: Statement
  deletePendingApproval: Statement
  selectPendingApprovalsAll: Statement
  selectPendingApprovalBySession: Statement

  sweepExpiredApprovals: Statement
  sweepEndedSessions: Statement

  ftsSearch: Statement
  ftsSearchByUser: Statement
  /** T3.1 — scoped to (userId [, channelType] [, since]) with hard JOIN on `s.id = m.session_id`. */
  ftsSearchMessages: Statement
  /** T3.1 — deletes sessions with `end_reason IS NOT NULL` closed before the cutoff. */
  sweepClosedSessions: Statement

  integrityCheck: Statement
}

export function prepareStatements(db: Database): PreparedStatements {
  return {
    insertSession: db.prepare(`
      INSERT INTO sessions (
        id, session_key, source, user_id, team_id,
        channel_type, channel_id, thread_id,
        model, model_selections, system_prompt_stable_hash, parent_session_id,
        started_at, last_activity_at, turn_count, ended_at, end_reason,
        message_count, tool_call_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_tokens_reported,
        title, state, active_task_id, active_trace_context
      ) VALUES (
        @id, @session_key, @source, @user_id, @team_id,
        @channel_type, @channel_id, @thread_id,
        @model, @model_selections, @system_prompt_stable_hash, @parent_session_id,
        @started_at, @last_activity_at, @turn_count, @ended_at, @end_reason,
        @message_count, @tool_call_count,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
        @cache_tokens_reported,
        @title, @state, @active_task_id, @active_trace_context
      )
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        ended_at = excluded.ended_at,
        end_reason = excluded.end_reason
    `),
    updateSessionState: db.prepare(`
      UPDATE sessions
         SET state = @state,
             ended_at = COALESCE(@ended_at, ended_at),
             end_reason = COALESCE(@end_reason, end_reason),
             active_task_id = COALESCE(@active_task_id, active_task_id),
             active_trace_context = CASE
               WHEN @clear_active_trace_context = 1 THEN NULL
               ELSE COALESCE(@active_trace_context, active_trace_context)
             END
       WHERE id = @id
    `),
    // D.1 — COALESCE above can SET or KEEP active_task_id but never CLEAR it
    // (a NULL param means "keep"). The dispatcher runs this dedicated clear
    // statement, inside the same transaction, when a caller explicitly passes
    // activeTaskId: null (turn complete/fail/cancel).
    clearSessionActiveTask: db.prepare(`
      UPDATE sessions
         SET active_task_id = NULL,
             active_trace_context = NULL
       WHERE id = @id
    `),
    // D.2 — processing reaper. Chunked so a DoS spam of processing sessions
    // can't block boot in one giant transaction (security P0-3).
    selectProcessingSessions: db.prepare(`
      SELECT id, session_key, active_task_id, user_id, channel_type, channel_id, thread_id
        FROM sessions
       WHERE state = 'processing'
       LIMIT @limit
    `),
    selectSessionMaxOrdinalTurn: db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal,
             MAX(turn_number)           AS max_turn
        FROM messages
       WHERE session_id = @session_id
    `),
    // D.8 (F7) — sessions stuck in 'awaiting_approval' whose approval can no
    // longer resolve: either every pending_approval row for the session has
    // expired (expires_at <= now), or the row is gone entirely (orphan, e.g. a
    // periodic sweep deleted it but left the session awaiting). The NOT EXISTS
    // "no LIVE approval" form is correct even with multiple approvals per
    // session (only reap when none is still live).
    selectExpiredAwaitingApprovalSessions: db.prepare(`
      SELECT id, session_key, active_task_id, user_id, channel_type, channel_id, thread_id
        FROM sessions s
       WHERE s.state = 'awaiting_approval'
         AND NOT EXISTS (
           SELECT 1 FROM pending_approvals pa
            WHERE pa.session_id = s.id AND pa.expires_at > @now_epoch_seconds
         )
       LIMIT @limit
    `),
    // Legacy explicit recovery query for operators that intentionally abandon
    // every awaiting approval. Normal boot reconstructs live executors and uses
    // the expired-only query above.
    selectAwaitingApprovalSessions: db.prepare(`
      SELECT id, session_key, active_task_id, user_id, channel_type, channel_id, thread_id
        FROM sessions s
       WHERE s.state = 'awaiting_approval'
       LIMIT @limit
    `),
    // A pending approval is rehydratable only while its parent session is still
    // awaiting that exact task. Cancellation persistence can fail after the
    // session has already returned to idle; keeping that inverse orphan would
    // make cold-start executor reconstruction fail for up to the approval TTL.
    deleteUnrehydratablePendingApprovals: db.prepare(`
      DELETE FROM pending_approvals
       WHERE NOT EXISTS (
         SELECT 1
           FROM sessions s
          WHERE s.id = pending_approvals.session_id
            AND s.state = 'awaiting_approval'
            AND s.active_task_id = pending_approvals.task_id
       )
    `),
    deletePendingApprovalsBySession: db.prepare(`
      DELETE FROM pending_approvals WHERE session_id = @session_id
    `),
    updateSessionPromptStableHash: db.prepare(`
      UPDATE sessions
         SET system_prompt_stable_hash = @system_prompt_stable_hash
       WHERE id = @id
    `),
    // R2 — overwrite the per-session `{ provider → model }` selection map. The
    // dispatcher passes the already-serialized JSON string; a full overwrite is
    // correct because ConversationManager owns the in-RAM map and re-serializes
    // it on every mutation.
    updateSessionModelSelections: db.prepare(`
      UPDATE sessions
         SET model_selections = @model_selections
       WHERE id = @id
    `),
    updateSessionCounters: db.prepare(`
      UPDATE sessions
         SET message_count        = message_count      + @message_count_delta,
             tool_call_count      = tool_call_count    + @tool_call_count_delta,
             input_tokens         = input_tokens       + @input_tokens_delta,
             output_tokens        = output_tokens      + @output_tokens_delta,
             cache_read_tokens    = cache_read_tokens  + @cache_read_tokens_delta,
             cache_write_tokens   = cache_write_tokens + @cache_write_tokens_delta,
             cache_tokens_reported = cache_tokens_reported | @cache_reported
       WHERE id = @id
    `),
    updateSessionSummaryAfterInsert: db.prepare(`
      UPDATE sessions
         SET last_activity_at = CASE
               WHEN last_activity_at IS NULL OR last_activity_at < @timestamp
                 THEN @timestamp
               ELSE last_activity_at
             END,
             turn_count = turn_count + CASE
               WHEN @turn_number IS NOT NULL
                AND (
                 SELECT COUNT(*)
                   FROM messages
                  WHERE session_id = @id
                    AND turn_number = @turn_number
               ) = 1
                 THEN 1
               ELSE 0
             END,
             message_count = message_count + @visible_message_delta
       WHERE id = @id
    `),
    recomputeSessionMessageSummary: db.prepare(`
      UPDATE sessions
         SET last_activity_at = MAX(
               COALESCE(last_activity_at, started_at),
               started_at,
               COALESCE(
                 (SELECT MAX(timestamp) FROM messages WHERE session_id = @id),
                 started_at
               )
             ),
             turn_count = (
               SELECT COUNT(DISTINCT turn_number)
                 FROM messages
                WHERE session_id = @id
                  AND turn_number IS NOT NULL
             ),
             message_count = (
               SELECT COUNT(*)
                 FROM messages
                WHERE session_id = @id
                  AND (
                    role = 'user'
                    OR (role = 'assistant' AND tool_calls IS NULL)
                  )
             )
       WHERE id = @id
    `),
    selectSessionBySessionKey: db.prepare(`
      SELECT * FROM sessions WHERE session_key = ?
    `),
    selectSessionsByPrefix: db.prepare(`
      SELECT * FROM sessions WHERE session_key LIKE ? ORDER BY started_at DESC
    `),
    selectSessionSummariesByPrefix: db.prepare(`
      WITH scoped_sessions AS (
        SELECT *
         FROM sessions
         WHERE user_id = @user_id
           AND session_key >= @prefix_start
           AND session_key < @prefix_end
           AND (
             (@agent_scoped = 1 AND length(session_key) > length(@prefix_start))
             OR
             (
               @agent_scoped = 0
               AND instr(substr(session_key, length(@prefix_start) + 1), ':') > 1
               AND instr(substr(session_key, length(@prefix_start) + 1), ':')
                 < length(substr(session_key, length(@prefix_start) + 1))
             )
           )
           AND (
             @cursor_updated_at IS NULL
             OR COALESCE(last_activity_at, started_at) < @cursor_updated_at
             OR (
               COALESCE(last_activity_at, started_at) = @cursor_updated_at
               AND session_key > @cursor_key
             )
           )
         ORDER BY COALESCE(last_activity_at, started_at) DESC, session_key ASC
         LIMIT @limit
      ),
      ranked_approvals AS (
        SELECT pa.session_id,
               pa.request_id,
               pa.tool_name,
               ROW_NUMBER() OVER (
                 PARTITION BY pa.session_id
                 ORDER BY pa.registered_at ASC, pa.request_id ASC
               ) AS approval_rank
          FROM pending_approvals pa
          JOIN scoped_sessions s ON s.id = pa.session_id
      )
      SELECT s.*,
             COALESCE(s.last_activity_at, s.started_at) AS summary_last_activity_at,
             COALESCE(s.turn_count, 0) AS summary_turn_count,
             pa.request_id AS pending_request_id,
             pa.tool_name AS pending_tool_name
        FROM scoped_sessions s
        LEFT JOIN ranked_approvals pa
          ON pa.session_id = s.id
         AND pa.approval_rank = 1
       ORDER BY summary_last_activity_at DESC, s.session_key ASC
    `),
    selectSessionTurnBounds: db.prepare(`
      SELECT (
               SELECT turn_number
                 FROM messages
                WHERE session_id = @session_id
                  AND turn_number IS NOT NULL
                ORDER BY turn_number ASC
                LIMIT 1
             ) AS first_turn_number,
             (
               SELECT turn_number
                 FROM messages
                WHERE session_id = @session_id
                  AND turn_number IS NOT NULL
                ORDER BY turn_number DESC
                LIMIT 1
             ) AS last_turn_number
    `),
    selectMessagesBySessionNewestTurns: db.prepare(`
      WITH selected_turns AS (
        SELECT turn_number
          FROM messages
         WHERE session_id = @session_id
           AND turn_number IS NOT NULL
         GROUP BY turn_number
         ORDER BY turn_number DESC
         LIMIT @limit
      )
      SELECT m.*
        FROM messages m
       WHERE m.session_id = @session_id
         AND m.turn_number >= (SELECT MIN(turn_number) FROM selected_turns)
         AND m.turn_number <= (SELECT MAX(turn_number) FROM selected_turns)
       ORDER BY m.turn_number ASC, m.ordinal ASC
    `),
    selectMessagesBySessionTurnsBefore: db.prepare(`
      WITH selected_turns AS (
        SELECT turn_number
          FROM messages
         WHERE session_id = @session_id
           AND turn_number IS NOT NULL
           AND turn_number < @before_turn
         GROUP BY turn_number
         ORDER BY turn_number DESC
         LIMIT @limit
      )
      SELECT m.*
        FROM messages m
       WHERE m.session_id = @session_id
         AND m.turn_number >= (SELECT MIN(turn_number) FROM selected_turns)
         AND m.turn_number <= (SELECT MAX(turn_number) FROM selected_turns)
       ORDER BY m.turn_number ASC, m.ordinal ASC
    `),
    selectMessagesBySessionTurnsAfter: db.prepare(`
      WITH selected_turns AS (
        SELECT turn_number
          FROM messages
         WHERE session_id = @session_id
           AND turn_number IS NOT NULL
           AND turn_number > @after_turn
         GROUP BY turn_number
         ORDER BY turn_number ASC
         LIMIT @limit
      )
      SELECT m.*
        FROM messages m
       WHERE m.session_id = @session_id
         AND m.turn_number >= (SELECT MIN(turn_number) FROM selected_turns)
         AND m.turn_number <= (SELECT MAX(turn_number) FROM selected_turns)
       ORDER BY m.turn_number ASC, m.ordinal ASC
    `),

    insertMessage: db.prepare(`
      INSERT INTO messages (
        session_id, ordinal, role, content, content_parts,
        tool_call_id, tool_calls, tool_name, timestamp,
        token_count, finish_reason, spillover_ref, is_error, turn_number,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      ) VALUES (
        @session_id, @ordinal, @role, @content, @content_parts,
        @tool_call_id, @tool_calls, @tool_name, @timestamp,
        @token_count, @finish_reason, @spillover_ref, @is_error, @turn_number,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens
      )
    `),
    selectMessagesBySession: db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal ASC
    `),
    deleteMessagesBySession: db.prepare(`
      DELETE FROM messages WHERE session_id = ?
    `),

    insertPendingApproval: db.prepare(`
      INSERT INTO pending_approvals (
        request_id, session_id, task_id, tool_name, tool_call_id,
        parameters, description, context_snapshot, completed_results,
        intent_summary, source_message, registered_at, expires_at, trace_context
      ) VALUES (
        @request_id, @session_id, @task_id, @tool_name, @tool_call_id,
        @parameters, @description, @context_snapshot, @completed_results,
        @intent_summary, @source_message, @registered_at, @expires_at, @trace_context
      )
      ON CONFLICT(request_id) DO UPDATE SET
        task_id = excluded.task_id,
        context_snapshot = excluded.context_snapshot,
        completed_results = excluded.completed_results,
        trace_context = excluded.trace_context,
        expires_at = excluded.expires_at
    `),
    deletePendingApproval: db.prepare(`
      DELETE FROM pending_approvals WHERE request_id = ?
    `),
    selectPendingApprovalsAll: db.prepare(`
      SELECT pa.*,
             s.session_key AS session_key,
             s.user_id AS session_user_id,
             s.channel_type AS session_channel_type,
             s.channel_id AS session_channel_id,
             s.thread_id AS session_thread_id
        FROM pending_approvals pa
        JOIN sessions s
          ON s.id = pa.session_id
         AND s.state = 'awaiting_approval'
         AND s.active_task_id = pa.task_id
       ORDER BY pa.registered_at ASC
    `),
    selectPendingApprovalBySession: db.prepare(`
      SELECT *
        FROM pending_approvals
       WHERE session_id = ?
       ORDER BY registered_at ASC, request_id ASC
       LIMIT 1
    `),

    sweepExpiredApprovals: db.prepare(`
      DELETE FROM pending_approvals WHERE expires_at < ?
    `),
    sweepEndedSessions: db.prepare(`
      DELETE FROM sessions
       WHERE ended_at IS NOT NULL
         AND ended_at < ?
    `),

    ftsSearch: db.prepare(`
      SELECT m.session_id AS session_id,
             m.id AS message_id,
             m.timestamp AS timestamp,
             snippet(messages_fts, 0, '«', '»', '…', 8) AS snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH @query
       ORDER BY rank
       LIMIT @limit
    `),
    ftsSearchByUser: db.prepare(`
      SELECT m.session_id AS session_id,
             m.id AS message_id,
             m.timestamp AS timestamp,
             snippet(messages_fts, 0, '«', '»', '…', 8) AS snippet
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH @query
         AND s.user_id = @user_id
       ORDER BY rank
       LIMIT @limit
    `),
    // T3.1 — session search. `s.id = m.session_id` per P0-003 (T2.1 keyed
    // sessions on `id`, not `session_id`). Optional channel + since filters
    // use the binding-IS-NULL trick so a single statement covers all four
    // combinations without dynamic SQL.
    ftsSearchMessages: db.prepare(`
      SELECT
        snippet(messages_fts, 0, '<mark>', '</mark>', '…', 32) AS snippet,
        m.session_id                                            AS session_id,
        m.timestamp                                             AS timestamp,
        s.channel_type                                          AS channel,
        m.role                                                  AS role
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH @query
        AND s.user_id = @user_id
        AND (@channel_type IS NULL OR s.channel_type = @channel_type)
        AND (@since IS NULL OR m.timestamp >= @since)
      ORDER BY rank
      LIMIT @limit
    `),
    // T3.1 — retention sweep. Only deletes sessions that are properly closed
    // (`end_reason IS NOT NULL`) AND aged past the cutoff. In-flight sessions
    // never get pruned, regardless of `started_at`. ON DELETE CASCADE on
    // `messages` cleans up the messages + FTS triggers handle the index.
    sweepClosedSessions: db.prepare(`
      DELETE FROM sessions
       WHERE end_reason IS NOT NULL
         AND ended_at IS NOT NULL
         AND ended_at < @cutoff
    `),
    integrityCheck: db.prepare(`PRAGMA integrity_check`),
  }
}
