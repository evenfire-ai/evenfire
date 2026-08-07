import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  type ConversationSessionSummary,
  InMemoryConversationStore,
} from '../../core/conversation/conversationStore'
import { makeSqliteStore } from '../../core/conversation/persistence/__tests__/testHelpers'
import {
  decodeSessionsCursor,
  encodeSessionsCursor,
  paginateSessionSummaries,
  sessionsCursorScope,
} from '../wireProjections'

// R1-M4 — property-based coverage for the session-list wire contract. Every
// summary is produced by the REAL stores (SqliteConversationStore /
// InMemoryConversationStore driven by ConversationManager), and paging runs
// through the REAL wire helpers (paginateSessionSummaries + encode/decode
// cursor). No hand-built fixtures (T1); assertions are on the observable list
// the desktop would see (T4).

const USER = 'u-1'
const AGENT = 'a'
const PREFIX = `${USER}:rpc:${AGENT}:`

interface Seed {
  sessions: Array<{ id: number; turns: number }>
  limit: number
}

const seedArb: fc.Arbitrary<Seed> = fc.record({
  sessions: fc.uniqueArray(
    fc.record({ id: fc.integer({ min: 0, max: 400 }), turns: fc.integer({ min: 0, max: 3 }) }),
    { selector: s => s.id, minLength: 1, maxLength: 10 }
  ),
  limit: fc.integer({ min: 1, max: 4 }),
})

async function seedInto(manager: ConversationManager, seed: Seed): Promise<string[]> {
  const keys: string[] = []
  for (const s of seed.sessions) {
    const key = `${PREFIX}c${s.id}`
    keys.push(key)
    const conv = await manager.getOrCreate(key, { userId: USER })
    for (let t = 0; t < s.turns; t += 1) {
      await manager.startTurn(conv, `q${t}`, `task-${s.id}-${t}`)
      await manager.completeTurn(conv, `a${t}`)
    }
  }
  return keys
}

/** a must not sort AFTER b under (lastActivityAt desc, key asc). */
function notOutOfOrder(a: ConversationSessionSummary, b: ConversationSessionSummary): boolean {
  const at = a.lastActivityAt.getTime()
  const bt = b.lastActivityAt.getTime()
  if (at !== bt) return at > bt // newer first
  return a.key <= b.key
}

function project(s: ConversationSessionSummary) {
  return {
    key: s.key,
    chatId: s.chatId,
    agent: s.agent,
    turnCount: s.turnCount,
    messageCount: s.messageCount,
    state: s.state,
  }
}

describe('session list pagination — property based (R1-M4)', () => {
  it('P1/P2/P3 — cursor paging yields a total order, unique pages, exact-once coverage', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async seed => {
        const sqlite = makeSqliteStore({ cacheSize: 4 })
        try {
          const manager = new ConversationManager(sqlite.store)
          const keys = await seedInto(manager, seed)
          for (const key of keys) await sqlite.persistQueue.drainSessionKey(key)

          // Ground truth from the real producer, unbounded.
          const eligible = await manager.listSessionSummariesForUserAsync(PREFIX, { agent: AGENT })

          const scope = sessionsCursorScope(USER, AGENT)
          const encodeKey = (k: string) => k.slice(PREFIX.length)
          const pages: ConversationSessionSummary[][] = []
          let cursorStr: string | undefined
          for (let guard = 0; guard <= eligible.length + 2; guard += 1) {
            const decoded = decodeSessionsCursor(cursorStr, scope)
            const entries = await manager.listSessionSummariesForUserAsync(PREFIX, {
              limit: seed.limit + 1,
              cursor: decoded
                ? { updatedAt: new Date(decoded.updatedAt), key: `${PREFIX}${decoded.key}` }
                : undefined,
              agent: AGENT,
            })
            const { page, nextCursor } = paginateSessionSummaries(
              entries,
              seed.limit,
              encodeKey,
              scope
            )
            pages.push(page)
            // P2 — no key repeats within a page and the page honors the limit.
            expect(page.length).toBeLessThanOrEqual(seed.limit)
            expect(new Set(page.map(p => p.key)).size).toBe(page.length)
            if (!nextCursor) break
            cursorStr = nextCursor
          }

          const flat = pages.flat()

          // P1 — the concatenation is a total order (lastActivityAt desc, key asc).
          for (let i = 1; i < flat.length; i += 1) {
            expect(notOutOfOrder(flat[i - 1]!, flat[i]!)).toBe(true)
          }

          // P3 — every eligible session appears exactly once across all pages.
          expect(flat.map(s => s.key)).toEqual(eligible.map(s => s.key))
          expect(new Set(flat.map(s => s.key)).size).toBe(eligible.length)
        } finally {
          await sqlite.shutdown()
        }
      }),
      { numRuns: 40 }
    )
  })

  it('P5 — InMemory and SQLite summaries agree for the same data', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async seed => {
        const sqlite = makeSqliteStore({ cacheSize: 4 })
        try {
          const memory = new InMemoryConversationStore()
          const memManager = new ConversationManager(memory)
          const sqlManager = new ConversationManager(sqlite.store)

          await seedInto(memManager, seed)
          const keys = await seedInto(sqlManager, seed)
          for (const key of keys) await sqlite.persistQueue.drainSessionKey(key)

          const memList = await memory.listSessionSummariesByPrefix(PREFIX, { agent: AGENT })
          const sqlList = await sqlite.store.listSessionSummariesByPrefix(PREFIX, { agent: AGENT })

          // Parity is on WHICH sessions and their counters — ordering-by-activity
          // is a separate concern proven in P1. Sort by key so sub-millisecond
          // clock jitter between the two stores cannot cause a spurious mismatch.
          const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1)
          expect(memList.map(project).sort(byKey)).toEqual(sqlList.map(project).sort(byKey))
        } finally {
          await sqlite.shutdown()
        }
      }),
      { numRuns: 40 }
    )
  })
})
