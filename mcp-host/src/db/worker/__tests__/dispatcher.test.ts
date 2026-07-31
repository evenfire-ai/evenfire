import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../migrate'
import { applyPragmas } from '../../pragmas'
import { prepareStatements } from '../../statements'
import { createDispatcher, dispatch } from '../dispatcher'
import type { MessageRow, PersistedSession, ReapedSession, SessionRow } from '../protocol'

describe('dbWorker dispatcher', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    applyPragmas(db)
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('runs migrations and creates expected tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('sessions')
    expect(names).toContain('messages')
    expect(names).toContain('pending_approvals')
    expect(names).toContain('messages_fts')
    expect(names).toContain('migrations_meta')
  })

  it('insert_session + load_active_session round-trip', async () => {
    const deps = createDispatcher(db)
    const row: SessionRow = {
      id: 'conv-1',
      session_key: 'u-1:rpc:agent:default',
      source: 'rpc',
      user_id: 'u-1',
      team_id: null,
      channel_type: 'rpc',
      channel_id: 'agent',
      thread_id: null,
      model: null,
      model_selections: null,
      system_prompt_stable_hash: null,
      parent_session_id: null,
      started_at: Date.now() / 1000,
      ended_at: null,
      end_reason: null,
      message_count: 0,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_tokens_reported: 0,
      title: null,
      state: 'idle',
      active_task_id: null,
      active_trace_context: null,
    }
    await dispatch({ kind: 'insert_session', payload: row }, deps)
    const loaded = (await dispatch(
      { kind: 'load_active_session', sessionKey: row.session_key },
      deps
    )) as PersistedSession
    expect(loaded.session.id).toBe('conv-1')
    expect(loaded.messages).toHaveLength(0)
    expect(loaded.pending_approval).toBeNull()
  })

  it('uses bounded turn-index ranges for transcript windows and bounds', () => {
    const statements = prepareStatements(db)
    const windowStatements = [
      statements.selectMessagesBySessionNewestTurns,
      statements.selectMessagesBySessionTurnsBefore,
      statements.selectMessagesBySessionTurnsAfter,
    ]

    for (const statement of windowStatements) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${statement.source}`)
        .all({ session_id: 'conv-plan', limit: 20, before_turn: 100, after_turn: 0 }) as Array<{
        detail: string
      }>
      expect(
        plan.some(step =>
          step.detail.includes(
            'idx_messages_session_turn_ordinal (session_id=? AND turn_number>? AND turn_number<?)'
          )
        )
      ).toBe(true)
    }

    const boundsPlan = db
      .prepare(`EXPLAIN QUERY PLAN ${statements.selectSessionTurnBounds.source}`)
      .all({ session_id: 'conv-plan' }) as Array<{ detail: string }>
    expect(
      boundsPlan.filter(step => step.detail.includes('idx_messages_session_turn_ordinal')).length
    ).toBe(2)
  })

  it('insert_message updates session counters', async () => {
    const deps = createDispatcher(db)
    const sessionRow = makeSession('conv-2', 'u-2:rpc:agent:default')
    await dispatch({ kind: 'insert_session', payload: sessionRow }, deps)
    await dispatch(
      {
        kind: 'insert_message',
        payload: {
          session_id: 'conv-2',
          ordinal: 0,
          role: 'user',
          content: 'hello',
          content_parts: null,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: Date.now() / 1000,
          token_count: null,
          finish_reason: null,
          spillover_ref: null,
          is_error: 0,
          turn_number: 1,
        },
      },
      deps
    )
    const row = db.prepare('SELECT message_count FROM sessions WHERE id = ?').get('conv-2') as {
      message_count: number
    }
    expect(row.message_count).toBe(1)
  })

  it('keeps incremental session summaries equal to a full recomputation', async () => {
    const deps = createDispatcher(db)
    const session = {
      ...makeSession('conv-summary', 'u-summary:rpc:agent:default'),
      started_at: 5,
    }
    await dispatch({ kind: 'insert_session', payload: session }, deps)

    const messages: MessageRow[] = [
      {
        session_id: session.id,
        ordinal: 0,
        role: 'user',
        content: 'question',
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 10,
        token_count: null,
        finish_reason: null,
        spillover_ref: null,
        is_error: 0,
        turn_number: 1,
      },
      {
        session_id: session.id,
        ordinal: 1,
        role: 'assistant',
        content: null,
        content_parts: null,
        tool_call_id: null,
        tool_calls: '[{"name":"search"}]',
        tool_name: null,
        timestamp: 11,
        token_count: null,
        finish_reason: 'tool_use',
        spillover_ref: null,
        is_error: 0,
        turn_number: 1,
      },
      {
        session_id: session.id,
        ordinal: 2,
        role: 'tool',
        content: 'result',
        content_parts: null,
        tool_call_id: 'tool-call-1',
        tool_calls: null,
        tool_name: 'search',
        timestamp: 12,
        token_count: null,
        finish_reason: null,
        spillover_ref: null,
        is_error: 0,
        turn_number: 1,
      },
      {
        session_id: session.id,
        ordinal: 3,
        role: 'assistant',
        content: 'answer',
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 13,
        token_count: null,
        finish_reason: 'stop',
        spillover_ref: null,
        is_error: 0,
        turn_number: 1,
      },
      {
        session_id: session.id,
        ordinal: 4,
        role: 'user',
        content: 'next question',
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 20,
        token_count: null,
        finish_reason: null,
        spillover_ref: null,
        is_error: 0,
        turn_number: 2,
      },
      {
        session_id: session.id,
        ordinal: 5,
        role: 'system',
        content: 'legacy metadata',
        content_parts: null,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 8,
        token_count: null,
        finish_reason: null,
        spillover_ref: null,
        is_error: 0,
        turn_number: null,
      },
    ]
    for (const message of messages) {
      await dispatch({ kind: 'insert_message', payload: message }, deps)
    }

    const readSummary = () =>
      db
        .prepare(
          `SELECT last_activity_at, turn_count, message_count
             FROM sessions
            WHERE id = ?`
        )
        .get(session.id)
    const incrementalSummary = readSummary()
    expect(incrementalSummary).toEqual({
      last_activity_at: 20,
      turn_count: 2,
      message_count: 3,
    })

    deps.statements.recomputeSessionMessageSummary.run({ id: session.id })
    expect(readSummary()).toEqual(incrementalSummary)
  })

  it('separates tool-call storage rows from visible messages and token counters', async () => {
    const deps = createDispatcher(db)
    await dispatch(
      { kind: 'insert_session', payload: makeSession('conv-2t', 'u-2t:rpc:agent:default') },
      deps
    )
    await dispatch(
      {
        kind: 'insert_message',
        payload: {
          session_id: 'conv-2t',
          ordinal: 0,
          role: 'assistant',
          content: 'hi',
          content_parts: null,
          tool_call_id: null,
          tool_calls: JSON.stringify([{ name: 'search', arguments: {} }]),
          tool_name: null,
          timestamp: Date.now() / 1000,
          token_count: null,
          finish_reason: 'tool_use',
          spillover_ref: null,
          is_error: 0,
          turn_number: 1,
        },
      },
      deps
    )
    const row = db
      .prepare(
        'SELECT message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions WHERE id = ?'
      )
      .get('conv-2t') as Record<string, number>
    expect(row.message_count).toBe(0)
    expect(row.tool_call_count).toBe(1)
    // tokens stay at DEFAULT 0 — only update_session_counters writes them
    expect(row.input_tokens).toBe(0)
    expect(row.output_tokens).toBe(0)
    expect(row.cache_read_tokens).toBe(0)
    expect(row.cache_write_tokens).toBe(0)
  })

  it('update_session_counters accumulates token deltas additively', async () => {
    const deps = createDispatcher(db)
    await dispatch(
      { kind: 'insert_session', payload: makeSession('conv-2u', 'u-2u:rpc:agent:default') },
      deps
    )
    await dispatch(
      {
        kind: 'update_session_counters',
        sessionId: 'conv-2u',
        counters: {
          inputTokensDelta: 100,
          outputTokensDelta: 40,
          cacheReadTokensDelta: 10,
          cacheWriteTokensDelta: 5,
        },
      },
      deps
    )
    await dispatch(
      {
        kind: 'update_session_counters',
        sessionId: 'conv-2u',
        counters: {
          inputTokensDelta: 50,
          outputTokensDelta: 20,
          cacheReadTokensDelta: 3,
          cacheWriteTokensDelta: 0,
        },
      },
      deps
    )
    const row = db
      .prepare(
        'SELECT message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions WHERE id = ?'
      )
      .get('conv-2u') as Record<string, number>
    expect(row.input_tokens).toBe(150)
    expect(row.output_tokens).toBe(60)
    expect(row.cache_read_tokens).toBe(13)
    expect(row.cache_write_tokens).toBe(5)
    // counter-only updates must not invent messages/tool calls
    expect(row.message_count).toBe(0)
    expect(row.tool_call_count).toBe(0)
  })

  it('update_session_counters sets cache_tokens_reported sticky (migration 006)', async () => {
    const deps = createDispatcher(db)
    await dispatch(
      { kind: 'insert_session', payload: makeSession('conv-cr', 'u-cr:rpc:agent:default') },
      deps
    )
    const read = () =>
      (
        db
          .prepare('SELECT cache_tokens_reported AS r FROM sessions WHERE id = ?')
          .get('conv-cr') as {
          r: number
        }
      ).r

    // not reported → stays 0
    await dispatch(
      { kind: 'update_session_counters', sessionId: 'conv-cr', counters: { cacheReported: false } },
      deps
    )
    expect(read()).toBe(0)
    // reported → flips to 1
    await dispatch(
      { kind: 'update_session_counters', sessionId: 'conv-cr', counters: { cacheReported: true } },
      deps
    )
    expect(read()).toBe(1)
    // not reported again → stays 1 (sticky OR)
    await dispatch(
      { kind: 'update_session_counters', sessionId: 'conv-cr', counters: { cacheReported: false } },
      deps
    )
    expect(read()).toBe(1)
  })

  it('insert_message persists per-turn token columns (migration 005), null when omitted', async () => {
    const deps = createDispatcher(db)
    await dispatch(
      { kind: 'insert_session', payload: makeSession('conv-mt', 'u-mt:rpc:agent:default') },
      deps
    )
    const base = {
      session_id: 'conv-mt',
      role: 'assistant' as const,
      content: 'hi',
      content_parts: null,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: Date.now() / 1000,
      token_count: null,
      finish_reason: 'stop',
      spillover_ref: null,
      is_error: 0 as const,
    }
    // Stamped final message of a turn.
    await dispatch(
      {
        kind: 'insert_message',
        payload: {
          ...base,
          ordinal: 0,
          turn_number: 1,
          input_tokens: 120,
          output_tokens: 45,
          cache_read_tokens: 10,
          cache_write_tokens: 0,
        },
      },
      deps
    )
    // A message that omits the token fields → bound as NULL (no throw).
    await dispatch(
      { kind: 'insert_message', payload: { ...base, ordinal: 1, turn_number: 2 } },
      deps
    )
    const rows = db
      .prepare(
        'SELECT ordinal, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM messages WHERE session_id = ? ORDER BY ordinal'
      )
      .all('conv-mt') as Array<Record<string, number | null>>
    expect(rows[0]).toMatchObject({
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
    })
    expect(rows[1]).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
    })
  })

  it('FTS search still works after migration 005 added columns to messages', async () => {
    const deps = createDispatcher(db)
    await dispatch(
      { kind: 'insert_session', payload: makeSession('conv-fts', 'u-fts:rpc:agent:default') },
      deps
    )
    await dispatch(
      {
        kind: 'insert_message',
        payload: {
          session_id: 'conv-fts',
          ordinal: 0,
          role: 'user',
          content: 'pineapple pizza recipe',
          content_parts: null,
          tool_call_id: null,
          tool_calls: null,
          tool_name: null,
          timestamp: Date.now() / 1000,
          token_count: null,
          finish_reason: null,
          spillover_ref: null,
          is_error: 0,
          turn_number: 1,
        },
      },
      deps
    )
    // makeSession sets sessions.user_id = id, and fts_search_messages scopes by it.
    const hits = (await dispatch(
      { kind: 'fts_search_messages', query: 'pineapple', userId: 'conv-fts', limit: 10 },
      deps
    )) as unknown[]
    expect(hits.length).toBe(1)
  })

  it('load_all_pending_approvals returns rows joined with session_key', async () => {
    const deps = createDispatcher(db)
    const sessionRow = {
      ...makeSession('conv-3', 'u-3:rpc:agent:default'),
      state: 'awaiting_approval',
      active_task_id: 'task-1',
    }
    await dispatch({ kind: 'insert_session', payload: sessionRow }, deps)
    const approvalRow = {
      request_id: 'req-1',
      session_id: 'conv-3',
      task_id: 'task-1',
      tool_name: 'shell_exec',
      tool_call_id: 'tc-1',
      parameters: '{}',
      description: 'test',
      context_snapshot: '[]',
      completed_results: null,
      intent_summary: null,
      source_message: null,
      registered_at: Date.now() / 1000,
      expires_at: Date.now() / 1000 + 3600,
      trace_context: null,
    }
    await dispatch({ kind: 'insert_pending_approval', payload: approvalRow }, deps)
    const rows = (await dispatch({ kind: 'load_all_pending_approvals' }, deps)) as Array<{
      approval: { request_id: string }
      session_key: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].approval.request_id).toBe('req-1')
    expect(rows[0].session_key).toBe('u-3:rpc:agent:default')
  })

  it('reaps only pending approvals whose session cannot rehydrate the same task', async () => {
    const deps = createDispatcher(db)
    const now = Date.now()
    const sessions = [
      {
        ...makeSession('conv-valid', 'u:rpc:agent:valid'),
        state: 'awaiting_approval',
        active_task_id: 'task-valid',
      },
      makeSession('conv-idle', 'u:rpc:agent:idle'),
      {
        ...makeSession('conv-mismatch', 'u:rpc:agent:mismatch'),
        state: 'awaiting_approval',
        active_task_id: 'task-current',
      },
    ]
    for (const session of sessions) {
      await dispatch({ kind: 'insert_session', payload: session }, deps)
    }

    const insertApproval = async (requestId: string, sessionId: string, taskId: string) => {
      await dispatch(
        {
          kind: 'insert_pending_approval',
          payload: {
            request_id: requestId,
            session_id: sessionId,
            task_id: taskId,
            tool_name: 'shell_exec',
            tool_call_id: `tc-${requestId}`,
            parameters: '{}',
            description: 'test',
            context_snapshot: '[]',
            completed_results: null,
            intent_summary: null,
            source_message: null,
            registered_at: now / 1000,
            expires_at: now / 1000 + 3600,
            trace_context: null,
          },
        },
        deps
      )
    }
    await insertApproval('req-valid', 'conv-valid', 'task-valid')
    await insertApproval('req-idle', 'conv-idle', 'task-idle')
    await insertApproval('req-mismatch', 'conv-mismatch', 'task-stale')

    const reaped = (await dispatch(
      { kind: 'reap_awaiting_approval_sessions', nowEpoch: now },
      deps
    )) as ReapedSession[]
    expect(reaped.map(row => row.sessionId)).toEqual(['conv-mismatch'])

    const approvals = db
      .prepare('SELECT request_id FROM pending_approvals ORDER BY request_id')
      .all() as Array<{ request_id: string }>
    expect(approvals.map(row => row.request_id)).toEqual(['req-valid'])

    const validRows = (await dispatch({ kind: 'load_all_pending_approvals' }, deps)) as Array<{
      approval: { request_id: string }
    }>
    expect(validRows.map(row => row.approval.request_id)).toEqual(['req-valid'])

    const mismatch = db
      .prepare('SELECT state, active_task_id FROM sessions WHERE id = ?')
      .get('conv-mismatch') as { state: string; active_task_id: string | null }
    expect(mismatch).toEqual({ state: 'idle', active_task_id: null })
  })

  it('integrity_check returns ok', async () => {
    const deps = createDispatcher(db)
    const r = (await dispatch({ kind: 'integrity_check' }, deps)) as {
      ok: boolean
      detail: string
    }
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('ok')
  })

  it('B11 regression — fts_search_messages rejects non-ISO `since`', async () => {
    const deps = createDispatcher(db)
    const sessionRow = makeSession('conv-b11', 'u-b11:rpc:agent:default')
    await dispatch({ kind: 'insert_session', payload: sessionRow }, deps)
    await expect(
      dispatch(
        {
          kind: 'fts_search_messages',
          query: 'anything',
          userId: 'u-b11',
          channelType: undefined,
          since: '1000000', // bare numeric string — Date.parse would accept it
          limit: 10,
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('B11 — fts_search_messages accepts a valid ISO 8601 `since`', async () => {
    const deps = createDispatcher(db)
    const sessionRow = makeSession('conv-b11b', 'u-b11b:rpc:agent:default')
    await dispatch({ kind: 'insert_session', payload: sessionRow }, deps)
    const rows = await dispatch(
      {
        kind: 'fts_search_messages',
        query: 'anything',
        userId: 'u-b11b',
        channelType: undefined,
        since: '2026-05-22T10:00:00Z',
        limit: 10,
      },
      deps
    )
    expect(Array.isArray(rows)).toBe(true)
  })
})

function makeSession(id: string, sessionKey: string): SessionRow {
  return {
    id,
    session_key: sessionKey,
    source: 'rpc',
    user_id: id,
    team_id: null,
    channel_type: 'rpc',
    channel_id: 'agent',
    thread_id: null,
    model: null,
    model_selections: null,
    system_prompt_stable_hash: null,
    parent_session_id: null,
    started_at: Date.now() / 1000,
    ended_at: null,
    end_reason: null,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_tokens_reported: 0,
    title: null,
    state: 'idle',
    active_task_id: null,
    active_trace_context: null,
  }
}
