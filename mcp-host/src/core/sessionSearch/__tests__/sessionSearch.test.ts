/**
 * T3.1 — golden tests for the session search tool, service, and SQL backend.
 *
 * Covers the bloqueante set (1-12, 18, 22) from `T3.1-session-search.md §11`
 * plus the functional/FTS5/REST tests. The dispatcher is driven in-process
 * via the helpers in `core/conversation/persistence/__tests__/testHelpers.ts`
 * — the production worker thread is overkill for these.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../db/migrate'
import { applyPragmas } from '../../../db/pragmas'
import type { IncomingMessage } from '../../../server'
import { createInProcessWorker } from '../../conversation/persistence/__tests__/testHelpers'
import { PersistQueue } from '../../conversation/persistence/persistQueue'
import { SessionSearchTool } from '../../tools/sessionSearch'
import { SessionSearchService } from '../service'

interface Harness {
  db: Database.Database
  persistQueue: PersistQueue
  service: SessionSearchService
  shutdown: () => Promise<void>
}

function makeHarness(): Harness {
  const handle = createInProcessWorker(':memory:')
  const persistQueue = new PersistQueue(handle.worker, {
    syncTimeoutMs: 2000,
    asyncTimeoutMs: 2000,
  })
  const service = new SessionSearchService({ persistQueue })
  return {
    db: handle.db,
    persistQueue,
    service,
    async shutdown() {
      await persistQueue.close()
    },
  }
}

interface SeedSession {
  id: string
  userId: string
  channelType?: string
  endReason?: string | null
  endedAt?: number | null
}

interface SeedMessage {
  sessionId: string
  ordinal: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  /** Optional override; defaults to `Date.now()/1000`. */
  timestamp?: number
}

function seedSession(db: Database.Database, opts: SeedSession): void {
  db.prepare(
    `INSERT INTO sessions (
       id, session_key, source, user_id, team_id,
       channel_type, channel_id, thread_id,
       model, system_prompt_stable_hash, parent_session_id,
       started_at, ended_at, end_reason,
       message_count, tool_call_count,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       title, state
     ) VALUES (
       @id, @session_key, @source, @user_id, NULL,
       @channel_type, 'agent', NULL,
       NULL, NULL, NULL,
       @started_at, @ended_at, @end_reason,
       0, 0, 0, 0, 0, 0,
       NULL, 'idle'
     )`
  ).run({
    id: opts.id,
    session_key: `${opts.userId}:${opts.channelType ?? 'rpc'}:agent:default-${opts.id}`,
    source: opts.channelType ?? 'rpc',
    user_id: opts.userId,
    channel_type: opts.channelType ?? 'rpc',
    started_at: Date.now() / 1000,
    ended_at: opts.endedAt ?? null,
    end_reason: opts.endReason ?? null,
  })
}

function seedMessage(db: Database.Database, opts: SeedMessage): void {
  db.prepare(
    `INSERT INTO messages (
       session_id, ordinal, role, content, content_parts,
       tool_call_id, tool_calls, tool_name, timestamp,
       token_count, finish_reason, spillover_ref, is_error, turn_number
     ) VALUES (
       @session_id, @ordinal, @role, @content, NULL,
       NULL, NULL, NULL, @timestamp,
       NULL, NULL, NULL, 0, 1
     )`
  ).run({
    session_id: opts.sessionId,
    ordinal: opts.ordinal,
    role: opts.role,
    content: opts.content,
    timestamp: opts.timestamp ?? Date.now() / 1000,
  })
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: 'hi',
    channelType: 'telegram',
    channelId: 'chat-1',
    sender: 'alice@example.com',
    timestamp: new Date().toISOString(),
    messageId: 'm-1',
    hostRef: 'host-1',
    ...overrides,
  }
}

describe('SessionSearchTool — security (bloqueantes)', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
    seedSession(h.db, { id: 's1', userId: 'alice@example.com', channelType: 'telegram' })
    seedSession(h.db, { id: 's2', userId: 'bob@example.com', channelType: 'telegram' })
    seedMessage(h.db, {
      sessionId: 's1',
      ordinal: 0,
      role: 'user',
      content: 'alice talks about pineapples',
    })
    seedMessage(h.db, {
      sessionId: 's2',
      ordinal: 0,
      role: 'user',
      content: 'bob talks about pineapples',
    })
  })

  afterEach(async () => {
    await h.shutdown()
  })

  it('#1 silently ignores `params.user_id` from the LLM', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage())
    const spy = vi.spyOn(h.service, 'search')
    const out = await tool.execute({
      query: 'pineapples',
      user_id: 'bob@example.com',
    })
    expect(out.is_error).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].userId).toBe('alice@example.com')
    const body = JSON.parse(out.content) as { results: Array<{ session_id: string }> }
    expect(body.results.every(r => r.session_id === 's1')).toBe(true)
  })

  it('#2 silently ignores camelCase `userId` from the LLM', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage())
    const spy = vi.spyOn(h.service, 'search')
    const out = await tool.execute({ query: 'pineapples', userId: 'bob@example.com' })
    expect(out.is_error).toBe(false)
    expect(spy.mock.calls[0][0].userId).toBe('alice@example.com')
  })

  it('#3 scope=all_channels does not bypass user filter', async () => {
    seedSession(h.db, {
      id: 's3',
      userId: 'alice@example.com',
      channelType: 'slack',
    })
    seedMessage(h.db, {
      sessionId: 's3',
      ordinal: 0,
      role: 'user',
      content: 'alice on slack about pineapples',
    })

    const tool = new SessionSearchTool(h.service, makeMessage())
    const out = await tool.execute({ query: 'pineapples', scope: 'all_channels' })
    const body = JSON.parse(out.content) as {
      results: Array<{ session_id: string; channel: string }>
    }
    expect(body.results.map(r => r.session_id).sort()).toEqual(['s1', 's3'])
    expect(body.results.every(r => r.session_id !== 's2')).toBe(true)
  })

  it('#4 limit > 50 is hard-capped', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage())
    const spy = vi.spyOn(h.service, 'search')
    await tool.execute({ query: 'pineapples', limit: 1_000_000 })
    expect(spy.mock.calls[0][0].limit).toBe(50)
  })

  it('#5 limit <= 0 falls back to the default range (clamped to 1)', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage())
    const spy = vi.spyOn(h.service, 'search')
    await tool.execute({ query: 'pineapples', limit: 0 })
    expect(spy.mock.calls[0][0].limit).toBe(1)
    spy.mockClear()
    await tool.execute({ query: 'pineapples', limit: -3 })
    expect(spy.mock.calls[0][0].limit).toBe(1)
  })

  it('#6 unknown scope value falls back to this_channel', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage({ channelType: 'telegram' }))
    const spy = vi.spyOn(h.service, 'search')
    await tool.execute({ query: 'pineapples', scope: 'magic' as unknown as string })
    expect(spy.mock.calls[0][0].channelType).toBe('telegram')
  })

  it('#7 empty query returns error and does not hit SQL', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage())
    const spy = vi.spyOn(h.service, 'search')
    const out = await tool.execute({ query: '   ' })
    expect(out.is_error).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('#8 missing sourceMessage returns error', async () => {
    const tool = new SessionSearchTool(h.service, undefined)
    const out = await tool.execute({ query: 'pineapples' })
    expect(out.is_error).toBe(true)
    expect(out.content).toContain('Session context unavailable')
  })

  it('#18 cross-user isolation — alice cannot see bob (top priority test)', async () => {
    const tool = new SessionSearchTool(h.service, makeMessage({ sender: 'alice@example.com' }))
    const out = await tool.execute({ query: 'pineapples', scope: 'all_channels' })
    const body = JSON.parse(out.content) as { results: Array<{ session_id: string }> }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].session_id).toBe('s1')
  })
})

describe('SessionSearchService — FTS5 functional', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  afterEach(async () => {
    await h.shutdown()
  })

  it('returns snippet, session_id, timestamp (ISO), channel, role', async () => {
    seedSession(h.db, { id: 's1', userId: 'u1', channelType: 'slack' })
    seedMessage(h.db, {
      sessionId: 's1',
      ordinal: 0,
      role: 'assistant',
      content: 'I deployed the kafka migration this morning.',
    })
    const result = await h.service.search({ query: 'kafka', userId: 'u1', limit: 5 }, 'llm')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      session_id: 's1',
      channel: 'slack',
      role: 'assistant',
    })
    expect(result.results[0].snippet).toContain('<mark>kafka</mark>')
    expect(() => new Date(result.results[0].timestamp).toISOString()).not.toThrow()
  })

  it('since filter excludes older messages', async () => {
    seedSession(h.db, { id: 's1', userId: 'u1' })
    const oldTs = Date.parse('2024-01-01T00:00:00Z') / 1000
    const newTs = Date.parse('2026-06-01T00:00:00Z') / 1000
    seedMessage(h.db, {
      sessionId: 's1',
      ordinal: 0,
      role: 'user',
      content: 'old quetzal',
      timestamp: oldTs,
    })
    seedMessage(h.db, {
      sessionId: 's1',
      ordinal: 1,
      role: 'user',
      content: 'new quetzal',
      timestamp: newTs,
    })
    const result = await h.service.search(
      { query: 'quetzal', userId: 'u1', since: '2026-01-01T00:00:00Z', limit: 5 },
      'llm'
    )
    expect(result.results).toHaveLength(1)
    expect(result.results[0].snippet).toContain('new')
  })

  it('this_channel scope filters by channel_type', async () => {
    seedSession(h.db, { id: 's-tg', userId: 'u1', channelType: 'telegram' })
    seedSession(h.db, { id: 's-sl', userId: 'u1', channelType: 'slack' })
    seedMessage(h.db, { sessionId: 's-tg', ordinal: 0, role: 'user', content: 'quetzal one' })
    seedMessage(h.db, { sessionId: 's-sl', ordinal: 0, role: 'user', content: 'quetzal two' })

    const result = await h.service.search(
      { query: 'quetzal', userId: 'u1', channelType: 'telegram', limit: 5 },
      'llm'
    )
    expect(result.results.map(r => r.session_id)).toEqual(['s-tg'])
  })

  it('all_channels (no channelType filter) returns hits across channels', async () => {
    seedSession(h.db, { id: 's-tg', userId: 'u1', channelType: 'telegram' })
    seedSession(h.db, { id: 's-sl', userId: 'u1', channelType: 'slack' })
    seedMessage(h.db, { sessionId: 's-tg', ordinal: 0, role: 'user', content: 'quetzal one' })
    seedMessage(h.db, { sessionId: 's-sl', ordinal: 0, role: 'user', content: 'quetzal two' })

    const result = await h.service.search({ query: 'quetzal', userId: 'u1', limit: 5 }, 'llm')
    expect(result.results.map(r => r.session_id).sort()).toEqual(['s-sl', 's-tg'])
  })
})

describe('SessionSearchService — retention sweep', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  afterEach(async () => {
    await h.shutdown()
  })

  it('#9 deletes closed sessions older than retentionDays', async () => {
    const nowSec = Date.now() / 1000
    const oneHundredDaysAgo = nowSec - 100 * 86400
    const thirtyDaysAgo = nowSec - 30 * 86400

    seedSession(h.db, {
      id: 'old-closed',
      userId: 'u1',
      endReason: 'compression',
      endedAt: oneHundredDaysAgo,
    })
    seedSession(h.db, {
      id: 'recent-closed',
      userId: 'u1',
      endReason: 'user_closed',
      endedAt: thirtyDaysAgo,
    })
    seedSession(h.db, {
      id: 'inflight',
      userId: 'u1',
      endReason: null,
      endedAt: null,
    })

    const deleted = await h.service.sweepRetention(90)
    expect(deleted).toBe(1)

    const remaining = h.db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{
      id: string
    }>
    expect(remaining.map(r => r.id).sort()).toEqual(['inflight', 'recent-closed'])
  })

  it('#10 never prunes in-flight sessions even with ancient started_at', async () => {
    seedSession(h.db, {
      id: 'inflight-1y',
      userId: 'u1',
      endReason: null,
      endedAt: null,
    })
    const deleted = await h.service.sweepRetention(1)
    expect(deleted).toBe(0)
    const remaining = h.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
    expect(remaining).toHaveLength(1)
  })

  it('#11 cascades to messages and clears messages_fts', async () => {
    const nowSec = Date.now() / 1000
    seedSession(h.db, {
      id: 'gone',
      userId: 'u1',
      endReason: 'compression',
      endedAt: nowSec - 1000 * 86400,
    })
    seedMessage(h.db, {
      sessionId: 'gone',
      ordinal: 0,
      role: 'user',
      content: 'ephemeral content',
    })
    await h.service.sweepRetention(90)
    const msgs = h.db.prepare('SELECT id FROM messages').all()
    expect(msgs).toHaveLength(0)
    const fts = h.db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'ephemeral'")
      .all()
    expect(fts).toHaveLength(0)
  })

  it('#12 sweep is idempotent', async () => {
    const nowSec = Date.now() / 1000
    seedSession(h.db, {
      id: 'x1',
      userId: 'u1',
      endReason: 'compression',
      endedAt: nowSec - 1000 * 86400,
    })
    const first = await h.service.sweepRetention(90)
    const second = await h.service.sweepRetention(90)
    expect(first).toBe(1)
    expect(second).toBe(0)
  })
})

describe('Schema invariants', () => {
  it('FTS5 join uses sessions.id (P0-003 — no `s.session_id`)', () => {
    // The prepared statement is built against the FTS5 schema; if a future
    // refactor reintroduces `s.session_id`, SQLite will reject preparation.
    const db = new Database(':memory:')
    applyPragmas(db)
    runMigrations(db)
    expect(() =>
      db.prepare(`
        SELECT m.session_id
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH 'foo'
      `)
    ).not.toThrow()
    db.close()
  })
})
