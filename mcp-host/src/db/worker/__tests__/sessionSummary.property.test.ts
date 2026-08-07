import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import { runMigrations } from '../../migrate'
import { applyPragmas } from '../../pragmas'
import { createDispatcher, dispatch } from '../dispatcher'
import type { MessageRow, SessionRow } from '../protocol'

// R1-M4 — property-based coverage for the two ways a session's summary counters
// are maintained: incrementally (updateSessionSummaryAfterInsert, run per
// inserted message) and by full recomputation (recomputeSessionMessageSummary).
// Every fixture is produced by the REAL dispatcher (insert_session /
// insert_message), never hand-built, so the shapes under test are exactly the
// ones production emits (T1).

interface SummarySnapshot {
  turn_count: number
  message_count: number
  last_activity_at: number | null
}

const messageArb = fc.record({
  role: fc.constantFrom('user', 'assistant', 'tool', 'system'),
  turnNumber: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
  hasToolCalls: fc.boolean(),
  timestamp: fc.integer({ min: 1, max: 100_000 }),
})

const seedArb = fc.record({
  startedAt: fc.integer({ min: 1, max: 100_000 }),
  messages: fc.array(messageArb, { minLength: 0, maxLength: 24 }),
})

interface Seed {
  startedAt: number
  messages: Array<{
    role: string
    turnNumber: number | null
    hasToolCalls: boolean
    timestamp: number
  }>
}

describe('session summary counters — property based (R1-M4)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    applyPragmas(db)
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  async function seedSession(seed: Seed): Promise<string> {
    const deps = createDispatcher(db)
    const id = 'conv-prop'
    const session: SessionRow = {
      ...baseSession(id, 'u-prop:rpc:agent:prop'),
      started_at: seed.startedAt,
    }
    await dispatch({ kind: 'insert_session', payload: session }, deps)
    let ordinal = 0
    for (const m of seed.messages) {
      const message: MessageRow = {
        session_id: id,
        ordinal: ordinal++,
        role: m.role as MessageRow['role'],
        content: `${m.role}-${ordinal}`,
        content_parts: null,
        tool_call_id: null,
        tool_calls: m.hasToolCalls && m.role === 'assistant' ? '[{"name":"search"}]' : null,
        tool_name: null,
        timestamp: m.timestamp,
        token_count: null,
        finish_reason: null,
        spillover_ref: null,
        is_error: 0,
        turn_number: m.turnNumber,
      }
      await dispatch({ kind: 'insert_message', payload: message }, deps)
    }
    return id
  }

  function readSummary(id: string): SummarySnapshot {
    return db
      .prepare('SELECT turn_count, message_count, last_activity_at FROM sessions WHERE id = ?')
      .get(id) as SummarySnapshot
  }

  it('P6 — incremental counters equal a full recomputation', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async seed => {
        db.exec('DELETE FROM messages; DELETE FROM sessions')
        const id = await seedSession(seed as Seed)
        const incremental = readSummary(id)
        const deps = createDispatcher(db)
        deps.statements.recomputeSessionMessageSummary.run({ id })
        const recomputed = readSummary(id)
        expect(incremental).toEqual(recomputed)
      }),
      { numRuns: 60 }
    )
  })

  it('P4 — recomputeSessionMessageSummary is idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async seed => {
        db.exec('DELETE FROM messages; DELETE FROM sessions')
        const id = await seedSession(seed as Seed)
        const deps = createDispatcher(db)
        deps.statements.recomputeSessionMessageSummary.run({ id })
        const once = readSummary(id)
        deps.statements.recomputeSessionMessageSummary.run({ id })
        const twice = readSummary(id)
        expect(twice).toEqual(once)
      }),
      { numRuns: 60 }
    )
  })
})

function baseSession(id: string, sessionKey: string): SessionRow {
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
    started_at: 1,
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
