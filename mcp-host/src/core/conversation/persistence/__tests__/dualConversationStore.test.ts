import { describe, expect, it } from 'vitest'
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
      expect(parity).toContainEqual({ op: 'listSessionSummariesByPrefix', match: false })
      expect(parity).toContainEqual({ op: 'getSessionMessagesByKey', match: false })
    } finally {
      await sqlite.shutdown()
    }
  })
})
