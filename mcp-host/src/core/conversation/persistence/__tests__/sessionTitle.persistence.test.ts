import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationManager } from '../../conversation'
import { InMemoryConversationStore } from '../../conversationStore'
import { DualConversationStore } from '../dualConversationStore'
import { makeSqliteStore } from './testHelpers'

const KEY = 'u-title:rpc:a:chat-1'
const PREFIX = 'u-title:rpc:'

function readTitle(db: import('better-sqlite3').Database, sessionKey: string): string | null {
  const row = db.prepare('SELECT title FROM sessions WHERE session_key = ?').get(sessionKey) as
    | { title: string | null }
    | undefined
  return row ? row.title : null
}

describe('auto-title persistence — COALESCE / turn gating (spec 15 A4/A6/A7)', () => {
  it('materializes the title on turn 1 (COALESCE from empty)', async () => {
    const sqlite = makeSqliteStore()
    try {
      const manager = new ConversationManager(sqlite.store)
      const conv = await manager.getOrCreate(KEY)
      await manager.startTurn(conv, 'plan a trip', 'task-1', null, 'Plan a trip')
      expect(readTitle(sqlite.worker.db, KEY)).toBe('Plan a trip')
      expect(conv.title).toBe('Plan a trip')
    } finally {
      await sqlite.shutdown()
    }
  })

  it('COALESCE keeps the first title when turn 1 is retried with a different value (idempotency)', async () => {
    const sqlite = makeSqliteStore()
    try {
      const manager = new ConversationManager(sqlite.store)
      const conv = await manager.getOrCreate(KEY)
      // Turn 1: writes 'First Title'. nextTurnNumber stays 1 until completeTurn.
      await manager.startTurn(conv, 'hello', 'task-1', null, 'First Title')
      // Simulate a retry of turn 1 that derived a different title: same
      // turnNumber (1) so the durable write runs again, but COALESCE ignores it.
      conv.title = 'Hijacked Title'
      await sqlite.store.persistTurnStart(conv, 'hello')
      expect(readTitle(sqlite.worker.db, KEY)).toBe('First Title')
    } finally {
      await sqlite.shutdown()
    }
  })

  it('turn 2 does NOT overwrite the turn-1 title (durable turnNumber gate + RAM ??=)', async () => {
    const sqlite = makeSqliteStore()
    try {
      const manager = new ConversationManager(sqlite.store)
      const conv = await manager.getOrCreate(KEY)
      await manager.startTurn(conv, 'first', 'task-1', null, 'First Title')
      await manager.completeTurn(conv, 'ok')
      // A second turn deriving a different title must not touch the column.
      await manager.startTurn(conv, 'second', 'task-2', null, 'Second Title')
      expect(readTitle(sqlite.worker.db, KEY)).toBe('First Title')
      expect(conv.title).toBe('First Title')
    } finally {
      await sqlite.shutdown()
    }
  })
})

describe('auto-title dual-store parity (spec 15 A10/A11 — assert observable output, T4)', () => {
  it('memory and SQLite project the SAME title (hot path) with no parity mismatch', async () => {
    const sqlite = makeSqliteStore()
    try {
      const memory = new InMemoryConversationStore()
      const mismatches: Array<{ op: string; match: boolean }> = []
      const dual = new DualConversationStore(memory, sqlite.store, {
        recordParity: (op, match) => {
          if (!match) mismatches.push({ op, match })
        },
      })
      const manager = new ConversationManager(dual)
      // Memory stamps lastActivityAt from `conversation.updated_at` while SQLite
      // stamps its row from an independent clock read in the persist worker; the
      // two land on the same millisecond ~98% of runs but straddle a second
      // boundary otherwise, so the parity probe reports a spurious lastActivityAt
      // mismatch (mirrors dualConversationStore.test.ts). Freeze Date at a
      // whole-second instant so both reads are identical and the seconds↔ms
      // round-trip is exact; only Date is faked so the persist queue's real
      // timers still run.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      try {
        const conv = await manager.getOrCreate(KEY)
        await manager.startTurn(conv, 'hello', 'task-1', null, 'My Title')
        await manager.completeTurn(conv, 'hi')
        // Wait for the durable row (stamped at the frozen instant) to land before
        // the parity probe reads it.
        await sqlite.persistQueue.drainPrefix(PREFIX)
      } finally {
        vi.useRealTimers()
      }

      const memSummaries = await memory.listSessionSummariesByPrefix(PREFIX, {})
      const sqlSummaries = await sqlite.store.listSessionSummariesByPrefix(PREFIX, {})
      expect(memSummaries[0]?.title).toBe('My Title')
      expect(sqlSummaries[0]?.title).toBe('My Title')

      // The dual store's own list must not detect a parity mismatch on title.
      await dual.listSessionSummariesByPrefix(PREFIX, {})
      expect(mismatches).toEqual([])
    } finally {
      await sqlite.shutdown()
    }
  })

  it('cold projection returns undefined (never null) for a session without a title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clerum-title-'))
    const dbPath = join(dir, 'sessions.db')
    // Seed with NO title, then shut the store to force a cold read from a fresh
    // store over the same file (cache empty → the `row.session.title` branch).
    const seed = makeSqliteStore({ dbPath })
    try {
      const manager = new ConversationManager(seed.store)
      const conv = await manager.getOrCreate(KEY)
      await manager.startTurn(conv, 'no title here', 'task-1') // autoTitle omitted
      await manager.completeTurn(conv, 'ok')
    } finally {
      await seed.shutdown()
    }

    const cold = makeSqliteStore({ dbPath })
    try {
      const summaries = await cold.store.listSessionSummariesByPrefix(PREFIX, {})
      expect(summaries).toHaveLength(1)
      // Must be undefined so normalizeParityValue drops it exactly like the
      // memory store; a null would survive and break dual-store parity.
      expect(summaries[0]?.title).toBeUndefined()
    } finally {
      await cold.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cold projection surfaces a persisted title from row.session.title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clerum-title-'))
    const dbPath = join(dir, 'sessions.db')
    const seed = makeSqliteStore({ dbPath })
    try {
      const manager = new ConversationManager(seed.store)
      const conv = await manager.getOrCreate(KEY)
      await manager.startTurn(conv, 'hello', 'task-1', null, 'Cold Title')
      await manager.completeTurn(conv, 'ok')
    } finally {
      await seed.shutdown()
    }

    const cold = makeSqliteStore({ dbPath })
    try {
      const summaries = await cold.store.listSessionSummariesByPrefix(PREFIX, {})
      expect(summaries[0]?.title).toBe('Cold Title')
    } finally {
      await cold.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
