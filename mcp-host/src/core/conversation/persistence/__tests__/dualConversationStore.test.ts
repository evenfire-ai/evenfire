import { describe, expect, it, vi } from 'vitest'
import { ConversationManager } from '../../conversation'
import { InMemoryConversationStore } from '../../conversationStore'
import { DualConversationStore } from '../dualConversationStore'
import { makeSqliteStore } from './testHelpers'

describe('DualConversationStore — dual-write parity', () => {
  it('writes flow to both stores and both end up with the same approval', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const memory = new InMemoryConversationStore()
      const dual = new DualConversationStore(memory, sqlite.store)
      const manager = new ConversationManager(dual)

      const conv = await manager.getOrCreate('u-1:rpc:a:default')
      await manager.startTurn(conv, 'hello', 'test-task')
      await manager.suspendForApproval(conv, {
        request_id: 'req-parity',
        tool_name: 'shell_exec',
        tool_call_id: 'tc-parity',
        parameters: {},
        description: 'parity probe',
        context_snapshot: [],
      })

      // Memory store sees the live mutation immediately.
      const memConv = memory.get('u-1:rpc:a:default')
      expect(memConv?.pending_approval?.request_id).toBe('req-parity')

      // SQLite store has the durable row.
      const rows = sqlite.worker.db
        .prepare('SELECT request_id FROM pending_approvals')
        .all() as Array<{ request_id: string }>
      expect(rows.map(r => r.request_id)).toContain('req-parity')
    } finally {
      await sqlite.shutdown()
    }
  })

  it('reads come from the memory store (canonical during validation)', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const memory = new InMemoryConversationStore()
      const dual = new DualConversationStore(memory, sqlite.store)
      const manager = new ConversationManager(dual)
      const conv = await manager.getOrCreate('u-1:rpc:a:default')
      // The dual store should return the exact memory reference.
      expect(dual.get('u-1:rpc:a:default')).toBe(conv)
    } finally {
      await sqlite.shutdown()
    }
  })

  it('B6 regression — getOrLoad hydrates memory from sqlite on cold-cache miss', async () => {
    // Before the B6 fix, `getOrLoad` returned `memVal` unconditionally; a
    // cold session present in SQLite but absent from memory looked like a
    // brand-new key, which the caller then duplicated via ON CONFLICT
    // (clobbering the original `started_at`). After the fix, the durable
    // row hydrates memory transparently.
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const memory = new InMemoryConversationStore()
      const dual = new DualConversationStore(memory, sqlite.store)

      // Seed SQLite with a session, then bypass memory entirely by going
      // through a fresh dual store (memory is empty by construction).
      const seedManager = new ConversationManager(sqlite.store)
      const seeded = await seedManager.getOrCreate('u-cold:rpc:a:default')
      const seededId = seeded.id

      // Memory has no entry; SQLite does. getOrLoad must surface the
      // durable row AND populate memory for subsequent sync hits.
      expect(memory.get('u-cold:rpc:a:default')).toBeUndefined()
      const loaded = await dual.getOrLoad('u-cold:rpc:a:default')
      expect(loaded).toBeDefined()
      expect(loaded?.id).toBe(seededId)
      // Memory now has it (hydrated).
      expect(memory.get('u-cold:rpc:a:default')?.id).toBe(seededId)
    } finally {
      await sqlite.shutdown()
    }
  })

  it('returns memory summaries and messages while recording sqlite parity', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const memory = new InMemoryConversationStore()
      const parity: Array<{ op: string; match: boolean }> = []
      const dual = new DualConversationStore(memory, sqlite.store, {
        recordParity: (op, match) => parity.push({ op, match }),
      })
      const manager = new ConversationManager(memory)
      const memoryOnly = await manager.getOrCreate('u-1:rpc:a:memory-only')
      await manager.startTurn(memoryOnly, 'memory only', 'task-memory')
      await manager.completeTurn(memoryOnly, 'done')

      const summaries = await dual.listSessionSummariesByPrefix('u-1:rpc:', { limit: 1 })
      expect(summaries.map(summary => summary.chatId)).toEqual(['memory-only'])

      const messages = await dual.getSessionMessagesByKey('u-1:rpc:a:memory-only', 'u-1:rpc:', {
        limit: 1,
      })
      expect(messages?.turns.map(turn => turn.user_input)).toEqual(['memory only'])
      await new Promise(resolve => setImmediate(resolve))
      expect(parity).toContainEqual({ op: 'listSessionSummariesByPrefix', match: false })
      expect(parity).toContainEqual({ op: 'getSessionMessagesByKey', match: false })
    } finally {
      await sqlite.shutdown()
    }
  })

  it('returns a cold sqlite transcript when memory has no session', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const seedManager = new ConversationManager(sqlite.store)
      const seeded = await seedManager.getOrCreate('u-cold:rpc:a:chat-1')
      await seedManager.startTurn(seeded, 'cold question', 'task-cold')
      await seedManager.completeTurn(seeded, 'cold answer')
      await sqlite.persistQueue.drainSessionKey('u-cold:rpc:a:chat-1')

      const dual = new DualConversationStore(new InMemoryConversationStore(), sqlite.store)
      const page = await dual.getSessionMessagesByKey('u-cold:rpc:a:chat-1', 'u-cold:rpc:', {
        limit: 1,
      })

      expect(page?.turns.map(turn => turn.user_input)).toEqual(['cold question'])
    } finally {
      await sqlite.shutdown()
    }
  })

  it('returns cold sqlite summaries when memory has no sessions', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const seedManager = new ConversationManager(sqlite.store)
      const seeded = await seedManager.getOrCreate('u-cold:rpc:a:chat-1')
      await seedManager.startTurn(seeded, 'cold question', 'task-cold')
      await seedManager.completeTurn(seeded, 'cold answer')
      await sqlite.persistQueue.drainSessionKey('u-cold:rpc:a:chat-1')

      const dual = new DualConversationStore(new InMemoryConversationStore(), sqlite.store)
      const summaries = await dual.listSessionSummariesByPrefix('u-cold:rpc:', { limit: 10 })

      expect(summaries.map(summary => summary.chatId)).toEqual(['chat-1'])
    } finally {
      await sqlite.shutdown()
    }
  })

  it('records matching parity for summaries written through both stores', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    // Memory derives lastActivityAt from `conversation.updated_at` (stamped when
    // the turn completes) while SQLite stamps its row from `Date.now()` when the
    // persist worker writes it — two independent clock reads. They usually land
    // on the same millisecond, but ~2% of runs straddle a boundary and the parity
    // probe reports a spurious mismatch (the source of this test's flake). Freeze
    // the clock so both reads are identical; a whole-second boundary keeps the
    // SQLite seconds↔ms round-trip exact. Only Date is faked, so the persist
    // queue's real setImmediate/setInterval timing (and vi.waitFor) still runs.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      const memory = new InMemoryConversationStore()
      const parity: Array<{ op: string; match: boolean }> = []
      const dual = new DualConversationStore(memory, sqlite.store, {
        recordParity: (op, match) => parity.push({ op, match }),
      })
      const manager = new ConversationManager(dual)
      const conversation = await manager.getOrCreate('u-1:rpc:a:chat-1', { userId: 'u-1' })
      await manager.startTurn(conversation, 'question', 'task-1')
      await manager.completeTurn(conversation, 'answer')
      // Writes reach SQLite through the async persist queue; drainPrefix waits
      // for every in-flight write under this prefix so the durable row (stamped
      // at the frozen instant) has landed before the parity probe reads it.
      await sqlite.persistQueue.drainPrefix('u-1:rpc:')
      // Timestamps are now locked into both stores; the clock can advance again.
      vi.useRealTimers()

      await dual.listSessionSummariesByPrefix('u-1:rpc:', { limit: 10 })
      await dual.getSessionMessagesByKey('u-1:rpc:a:chat-1', 'u-1:rpc:', { limit: 10 })
      // getSessionMessagesByKey records its parity fire-and-forget (a
      // queueMicrotask awaiting a SQLite worker round-trip), so poll until both
      // probes have recorded instead of racing a single fixed wait.
      await vi.waitFor(() => {
        expect(parity).toContainEqual({ op: 'listSessionSummariesByPrefix', match: true })
        expect(parity).toContainEqual({ op: 'getSessionMessagesByKey', match: true })
      })
    } finally {
      vi.useRealTimers()
      await sqlite.shutdown()
    }
  })

  it('bounds durable catalog probes when memory already has the requested page', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 128 })
    try {
      const memory = new InMemoryConversationStore()
      const dual = new DualConversationStore(memory, sqlite.store)
      const manager = new ConversationManager(dual)
      for (let index = 0; index < 100; index += 1) {
        await manager.getOrCreate(`u-1:rpc:a:chat-${index.toString().padStart(3, '0')}`, {
          userId: 'u-1',
        })
      }

      const expected = await memory.listSessionSummariesByPrefix('u-1:rpc:', { limit: 2 })
      const sqliteList = vi.spyOn(sqlite.store, 'listSessionSummariesByPrefix')
      const firstPage = await dual.listSessionSummariesByPrefix('u-1:rpc:', { limit: 1 })

      expect(firstPage.map(summary => summary.key)).toEqual([expected[0]!.key])
      expect(sqliteList).toHaveBeenCalledTimes(1)

      const [first] = firstPage
      const secondPage = await dual.listSessionSummariesByPrefix('u-1:rpc:', {
        limit: 1,
        cursor: { updatedAt: first!.lastActivityAt, key: first!.key },
      })
      expect(secondPage.map(summary => summary.key)).toEqual([expected[1]!.key])
      expect(sqliteList).toHaveBeenCalledTimes(2)
    } finally {
      await sqlite.shutdown()
    }
  })

  it('does not repeat a memory-owned key when sqlite has an older copy', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const memory = new InMemoryConversationStore()
      const memoryManager = new ConversationManager(memory)
      const sqliteManager = new ConversationManager(sqlite.store)
      const keyA = 'u-1:rpc:a:chat-a'
      const keyB = 'u-1:rpc:a:chat-b'
      const keyC = 'u-1:rpc:a:chat-c'

      const memoryA = await memoryManager.getOrCreate(keyA, { userId: 'u-1' })
      const memoryB = await memoryManager.getOrCreate(keyB, { userId: 'u-1' })
      memoryA.updated_at = new Date(400_000)
      memoryB.updated_at = new Date(300_000)

      const sqliteA = await sqliteManager.getOrCreate(keyA, { userId: 'u-1' })
      const sqliteC = await sqliteManager.getOrCreate(keyC, { userId: 'u-1' })
      await sqlite.persistQueue.drainSessionKey(keyA)
      await sqlite.persistQueue.drainSessionKey(keyC)
      sqlite.worker.db
        .prepare('UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?')
        .run(100, 250, sqliteA.id)
      sqlite.worker.db
        .prepare('UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?')
        .run(100, 200, sqliteC.id)

      const parity: Array<{ op: string; match: boolean }> = []
      const dual = new DualConversationStore(memory, sqlite.store, {
        recordParity: (op, match) => parity.push({ op, match }),
      })
      const keys: string[] = []
      let cursor: { updatedAt: Date; key: string } | undefined
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const page = await dual.listSessionSummariesByPrefix('u-1:rpc:', {
          limit: 1,
          cursor,
        })
        if (page.length === 0) break
        keys.push(page[0]!.key)
        cursor = { updatedAt: page[0]!.lastActivityAt, key: page[0]!.key }
      }

      expect(keys).toEqual([keyA, keyB, keyC])
      expect(parity).toContainEqual({ op: 'listSessionSummariesByPrefix', match: false })
    } finally {
      await sqlite.shutdown()
    }
  })

  it('keeps canonical memory reads available when sqlite parity probes fail', async () => {
    const sqlite = makeSqliteStore({ cacheSize: 4 })
    try {
      const memory = new InMemoryConversationStore()
      const manager = new ConversationManager(memory)
      const conversation = await manager.getOrCreate('u-1:rpc:a:chat-1')
      await manager.startTurn(conversation, 'question', 'task-1')
      await manager.completeTurn(conversation, 'answer')
      const parity: Array<{ op: string; match: boolean }> = []
      const failingSqlite = new Proxy(sqlite.store, {
        get(target, property, receiver) {
          if (
            property === 'listSessionSummariesByPrefix' ||
            property === 'getSessionMessagesByKey'
          ) {
            return async () => {
              throw new Error('sqlite boom')
            }
          }
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const dual = new DualConversationStore(memory, failingSqlite, {
        recordParity: (op, match) => parity.push({ op, match }),
      })

      await expect(dual.listSessionSummariesByPrefix('u-1:rpc:')).resolves.toHaveLength(1)
      await expect(
        dual.getSessionMessagesByKey('u-1:rpc:a:chat-1', 'u-1:rpc:')
      ).resolves.toBeDefined()
      await new Promise(resolve => setImmediate(resolve))

      expect(parity).toContainEqual({ op: 'listSessionSummariesByPrefix', match: false })
      expect(parity).toContainEqual({ op: 'getSessionMessagesByKey', match: false })
    } finally {
      await sqlite.shutdown()
    }
  })
})
