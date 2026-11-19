import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import * as migration from '../019-sessions-approval-mode'
import { ConversationManager } from '../../../core/conversation/conversation'
import { InMemoryConversationStore } from '../../../core/conversation/conversationStore'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../../core/conversation/persistence/__tests__/testHelpers'
import { DualConversationStore } from '../../../core/conversation/persistence/dualConversationStore'
import { reconstructConversation } from '../../../core/conversation/persistence/reconstruct'
import type { PersistedSession, SessionRow } from '../../worker/protocol'
import { migrations } from '../index'

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    c => c.name
  )
}

function preMigrationDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of migrations) {
    if (m.name === migration.name) break
    m.up(db)
  }
  db.prepare(
    `INSERT INTO sessions (id, session_key, source, started_at) VALUES (?, ?, 'rpc', 0)`
  ).run('s-legacy', 'u:rpc:a:1')
  return db
}

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's-mode',
    session_key: 'alice:rpc:agent:chat',
    source: 'rpc',
    user_id: 'alice',
    team_id: null,
    channel_type: 'rpc',
    channel_id: 'agent',
    thread_id: 'chat',
    model: null,
    model_selections: null,
    system_prompt_stable_hash: null,
    parent_session_id: null,
    started_at: 0,
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
    ...overrides,
  }
}

function persisted(overrides: Partial<SessionRow> = {}): PersistedSession {
  return { session: sessionRow(overrides), messages: [], pending_approval: null }
}

async function withStore(
  cacheSize: number,
  run: (handle: StoreHandle, manager: ConversationManager) => Promise<void>
): Promise<void> {
  const handle = makeSqliteStore({ cacheSize })
  try {
    await run(handle, new ConversationManager(handle.store))
  } finally {
    await handle.shutdown()
  }
}

/** Idle sessions are unpinned, so one extra insert evicts the row under test. */
async function evict(
  manager: ConversationManager,
  handle: StoreHandle,
  key: string
): Promise<void> {
  const filler = `filler:rpc:agent:${key}`
  await manager.getOrCreate(filler, { userId: 'filler', channelType: 'rpc' })
  await handle.persistQueue.drainSessionKey(filler)
  expect(handle.store.get(key)).toBeUndefined()
}

describe('migration 019 — sessions.approval_mode', () => {
  it('sorts last, after 018', () => {
    expect(migrations.at(-1)?.name).toBe(migration.name)
    expect(migration.name).toBe('019-sessions-approval-mode')
    expect(migrations.at(-2)?.name).toBe('018-session-denied-tools')
  })

  it('adds a manual default, is idempotent, and drops the column', () => {
    const db = preMigrationDb()
    try {
      expect(tableColumns(db, 'sessions')).not.toContain('approval_mode')
      migration.up(db)
      expect(tableColumns(db, 'sessions')).toContain('approval_mode')
      const legacy = db
        .prepare('SELECT approval_mode AS mode FROM sessions WHERE id = ?')
        .get('s-legacy') as { mode: string }
      expect(legacy.mode).toBe('manual')

      db.prepare(
        `INSERT INTO sessions (id, session_key, source, started_at) VALUES (?, ?, 'rpc', 0)`
      ).run('s-new', 'u:rpc:a:2')
      expect(
        (
          db.prepare('SELECT approval_mode AS mode FROM sessions WHERE id = ?').get('s-new') as {
            mode: string
          }
        ).mode
      ).toBe('manual')
      expect(() =>
        db
          .prepare(
            'INSERT INTO sessions (id, session_key, source, started_at, approval_mode) VALUES (?, ?, ?, 0, ?)'
          )
          .run('s-bad', 'u:rpc:a:3', 'rpc', null)
      ).toThrow()

      migration.up(db)
      db.prepare('UPDATE sessions SET approval_mode = ? WHERE id = ?').run('auto', 's-legacy')
      migration.up(db)
      expect(
        (
          db.prepare('SELECT approval_mode AS mode FROM sessions WHERE id = ?').get('s-legacy') as {
            mode: string
          }
        ).mode
      ).toBe('auto')
      expect(tableColumns(db, 'sessions').filter(name => name === 'approval_mode')).toEqual([
        'approval_mode',
      ])

      migration.down(db)
      expect(tableColumns(db, 'sessions')).not.toContain('approval_mode')
      migration.down(db)
    } finally {
      db.close()
    }
  })
})

describe('session approval mode and channel type', () => {
  it('reconstructs an unknown stored mode as manual and keeps the column channel type', () => {
    const yolo = reconstructConversation(
      persisted({ approval_mode: 'yolo', channel_type: 'slack' })
    ).conversation
    expect(yolo.approval_mode).toBe('manual')
    expect(yolo.channel_type).toBe('slack')
    expect(yolo.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
    expect(yolo.last_effective_approval_mode).toBeUndefined()

    const auto = reconstructConversation(
      persisted({ approval_mode: 'auto', channel_type: 'rpc' })
    ).conversation
    expect(auto.approval_mode).toBe('auto')
    expect(auto.channel_type).toBe('rpc')
    expect(auto.auto_shell_grants.commands).not.toBe(yolo.auto_shell_grants.commands)
    expect(
      reconstructConversation(persisted({ approval_mode: null, channel_type: null })).conversation
        .channel_type
    ).toBeUndefined()
  })

  it('persists an approval mode across a cold reconstruct', async () => {
    await withStore(1, async (handle, manager) => {
      const key = 'alice:rpc:agent:cold'
      const conv = await manager.getOrCreate(key, {
        userId: 'alice',
        channelType: 'rpc',
        approvalMode: 'manual',
      })
      await handle.store.persistApprovalMode(conv, 'allow_all')
      expect(conv.approval_mode).toBe('allow_all')
      await handle.persistQueue.drainSessionKey(key)
      const row = handle.worker.db
        .prepare('SELECT approval_mode AS mode, channel_type FROM sessions WHERE session_key = ?')
        .get(key) as { mode: string; channel_type: string | null }
      expect(row).toEqual({ mode: 'allow_all', channel_type: 'rpc' })

      await evict(manager, handle, key)
      const cold = await handle.store.getOrLoad(key)
      expect(cold?.approval_mode).toBe('allow_all')
      expect(cold?.channel_type).toBe('rpc')
      expect(cold?.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
      expect(cold?.last_effective_approval_mode).toBeUndefined()
      expect(cold).not.toBe(conv)
    })
  })

  it('moves the in-memory mode only after the worker stored it', async () => {
    await withStore(1, async (handle, manager) => {
      const key = 'erin:rpc:agent:barrier'
      const conv = await manager.getOrCreate(key, {
        userId: 'erin',
        channelType: 'rpc',
        approvalMode: 'manual',
      })
      const write = handle.store.persistApprovalMode(conv, 'auto')
      expect(conv.approval_mode).toBe('manual')
      await write
      expect(conv.approval_mode).toBe('auto')
      // No drain: the awaited write is the barrier.
      const row = handle.worker.db
        .prepare('SELECT approval_mode AS mode FROM sessions WHERE session_key = ?')
        .get(key) as { mode: string }
      expect(row.mode).toBe('auto')
    })
  })

  it('rejects a write for a missing row and keeps the previous in-memory mode', async () => {
    await withStore(1, async (handle, manager) => {
      const key = 'erin:rpc:agent:gone'
      const conv = await manager.getOrCreate(key, {
        userId: 'erin',
        channelType: 'rpc',
        approvalMode: 'manual',
      })
      await handle.persistQueue.drainSessionKey(key)
      const removed = handle.worker.db
        .prepare('DELETE FROM sessions WHERE session_key = ?')
        .run(key)
      expect(removed.changes).toBe(1)

      await expect(handle.store.persistApprovalMode(conv, 'allow_all')).rejects.toMatchObject({
        code: 'APPROVAL_MODE_SESSION_NOT_FOUND',
        message: expect.stringContaining(`no session row for id=${conv.id}`),
      })
      expect(conv.approval_mode).toBe('manual')
    })
  })

  it('updates the in-memory store', async () => {
    const store = new InMemoryConversationStore()
    const manager = new ConversationManager(store)
    const key = 'alice:rpc:agent:mem'
    const conv = await manager.getOrCreate(key, { userId: 'alice', approvalMode: 'manual' })
    expect(conv.approval_mode).toBe('manual')
    await store.persistApprovalMode(conv, 'auto')
    expect(store.get(key)?.approval_mode).toBe('auto')
    expect(conv.auto_shell_grants).toEqual({ wholeTool: false, commands: new Set() })
  })

  it('stores the create-branch mode and channel, and ignores them on a cold row', async () => {
    await withStore(1, async (handle, manager) => {
      const key = 'alice:rpc:agent:create'
      const created = await manager.getOrCreate(key, {
        userId: 'alice',
        approvalMode: 'auto',
        channelType: 'rpc',
      })
      expect(created.approval_mode).toBe('auto')
      expect(created.channel_type).toBe('rpc')
      await handle.persistQueue.drainSessionKey(key)

      const cached = await manager.getOrCreate(key, {
        userId: 'alice',
        approvalMode: 'allow_all',
        channelType: 'slack',
      })
      expect(cached).toBe(created)
      expect(cached.approval_mode).toBe('auto')
      expect(cached.channel_type).toBe('rpc')

      await evict(manager, handle, key)
      const reloaded = await manager.getOrCreate(key, {
        userId: 'alice',
        approvalMode: 'allow_all',
        channelType: 'slack',
      })
      expect(reloaded.approval_mode).toBe('auto')
      expect(reloaded.channel_type).toBe('rpc')
      await handle.persistQueue.drainSessionKey(key)
      const row = handle.worker.db
        .prepare('SELECT approval_mode AS mode, channel_type FROM sessions WHERE session_key = ?')
        .get(key) as { mode: string; channel_type: string | null }
      expect(row).toEqual({ mode: 'auto', channel_type: 'rpc' })
    })
  })

  it('stores a null channel type when create omits channelType, even for an rpc key', async () => {
    await withStore(2, async (handle, manager) => {
      const key = 'bob:rpc:agent:chat'
      const conv = await manager.getOrCreate(key, { userId: 'bob' })
      expect(conv.approval_mode).toBe('manual')
      expect(conv.channel_type).toBeUndefined()
      await handle.persistQueue.drainSessionKey(key)
      const row = handle.worker.db
        .prepare('SELECT approval_mode AS mode, channel_type FROM sessions WHERE session_key = ?')
        .get(key) as { mode: string; channel_type: string | null }
      expect(row).toEqual({ mode: 'manual', channel_type: null })
    })
  })

  it('reports created only when the create branch ran', async () => {
    await withStore(1, async (handle, manager) => {
      const key = 'carol:rpc:agent:detail'
      const created = await manager.getOrCreateDetailed(key, {
        userId: 'carol',
        channelType: 'rpc',
        approvalMode: 'auto',
      })
      expect(created.created).toBe(true)
      expect(created.conversation.approval_mode).toBe('auto')

      const cached = await manager.getOrCreateDetailed(key, {
        userId: 'carol',
        approvalMode: 'allow_all',
      })
      expect(cached.created).toBe(false)
      expect(cached.conversation).toBe(created.conversation)
      expect(cached.conversation.approval_mode).toBe('auto')

      const delegated = await manager.getOrCreate(key, { userId: 'carol' })
      expect(delegated).toBe(created.conversation)

      await handle.persistQueue.drainSessionKey(key)
      await evict(manager, handle, key)
      const cold = await manager.getOrCreateDetailed(key, {
        userId: 'carol',
        approvalMode: 'allow_all',
        channelType: 'slack',
      })
      expect(cold.created).toBe(false)
      expect(cold.conversation.approval_mode).toBe('auto')
      expect(cold.conversation.channel_type).toBe('rpc')
    })
  })

  it('delegates the durable approval-mode write the way model selection does', async () => {
    const handle = makeSqliteStore({ cacheSize: 2 })
    try {
      const dual = new DualConversationStore(new InMemoryConversationStore(), handle.store)
      const manager = new ConversationManager(dual)
      const key = 'dave:rpc:agent:dual'
      const conv = await manager.getOrCreate(key, {
        userId: 'dave',
        channelType: 'rpc',
        approvalMode: 'manual',
      })
      await dual.persistApprovalMode(conv, 'auto')
      expect(conv.approval_mode).toBe('auto')
      await handle.persistQueue.drainSessionKey(key)
      const row = handle.worker.db
        .prepare('SELECT approval_mode AS mode FROM sessions WHERE session_key = ?')
        .get(key) as { mode: string }
      expect(row.mode).toBe('auto')
    } finally {
      await handle.shutdown()
    }
  })
})
