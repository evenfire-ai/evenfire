import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../chatStore.js'
import type { ChatMessage } from '../types.js'

let tempDir: string
let store: ChatStore

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'chatstore-test-'))
  store = new ChatStore(tempDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tempDir, { recursive: true, force: true })
})

function agentPath(...segments: string[]): string {
  return join(tempDir, 'agent-1', ...segments)
}

function chatCacheDir(chatId: string): string {
  return agentPath('chats', chatId)
}

function chatMetaPath(chatId: string): string {
  return join(chatCacheDir(chatId), 'meta.json')
}

function chatPagesDir(chatId: string): string {
  return join(chatCacheDir(chatId), 'pages')
}

async function readJsonFile<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf-8')) as T
}

// ── listChats ────────────────────────────────────────────────────────────────

describe('listChats', () => {
  it('returns empty array when no chats exist', async () => {
    const chats = await store.listChats('agent-1')
    expect(chats).toEqual([])
  })

  it('returns created chats', async () => {
    await store.createChat('agent-1', 'c1')
    await store.createChat('agent-1', 'c2')
    const chats = await store.listChats('agent-1')
    expect(chats).toHaveLength(2)
    expect(chats[0]!.id).toBe('c1')
    expect(chats[1]!.id).toBe('c2')
  })
})

// ── createChat ───────────────────────────────────────────────────────────────

describe('createChat', () => {
  it('creates with default title and timestamps', async () => {
    const meta = await store.createChat('agent-1', 'chat-abc')
    expect(meta.id).toBe('chat-abc')
    expect(meta.title).toBe('New Chat')
    expect(meta.messageCount).toBe(0)
    expect(meta.createdAt).toBeTruthy()
    expect(meta.updatedAt).toBeTruthy()
  })

  it('does not create duplicate on re-create with same id', async () => {
    const first = await store.createChat('agent-1', 'dup-id')
    const second = await store.createChat('agent-1', 'dup-id')
    expect(first).toEqual(second)
    const chats = await store.listChats('agent-1')
    expect(chats).toHaveLength(1)
  })
})

// ── renameChat ───────────────────────────────────────────────────────────────

describe('renameChat', () => {
  it('updates title and updatedAt', async () => {
    const created = await store.createChat('agent-1', 'r1')
    await store.renameChat('agent-1', 'r1', 'Renamed Chat')
    const chats = await store.listChats('agent-1')
    const chat = chats.find(c => c.id === 'r1')
    expect(chat!.title).toBe('Renamed Chat')
    expect(chat!.updatedAt >= created.updatedAt).toBe(true)
  })
})

// ── deleteChat ───────────────────────────────────────────────────────────────

describe('deleteChat', () => {
  it('removes from index and deletes message cache', async () => {
    await store.createChat('agent-1', 'del-1')
    await store.saveMessages('agent-1', 'del-1', [
      { id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() },
    ])
    await store.deleteChat('agent-1', 'del-1')
    const chats = await store.listChats('agent-1')
    expect(chats).toHaveLength(0)

    await expect(fs.access(join(tempDir, 'agent-1', 'del-1.json'))).rejects.toThrow()
    await expect(fs.access(chatCacheDir('del-1'))).rejects.toThrow()
  })

  it('clears lastActiveChatId when deleting active chat', async () => {
    await store.createChat('agent-1', 'active-1')
    await store.setLastActiveChatId('agent-1', 'active-1')
    await store.deleteChat('agent-1', 'active-1')
    const lastActive = await store.getLastActiveChatId('agent-1')
    expect(lastActive).toBeNull()
  })
})

// ── messages ─────────────────────────────────────────────────────────────────

describe('messages', () => {
  it('append and load messages', async () => {
    await store.createChat('agent-1', 'msg-1')
    await store.appendMessages('agent-1', 'msg-1', [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1000 },
      { id: 'm2', role: 'assistant', content: 'hello', timestamp: 2000 },
    ])
    const messages = await store.loadMessages('agent-1', 'msg-1')
    expect(messages).toHaveLength(2)
    expect(messages[0]!.content).toBe('hi')
    expect(messages[1]!.content).toBe('hello')
  })

  it('pagination with limit and offset', async () => {
    await store.createChat('agent-1', 'pag-1')
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `msg-${i}`,
      timestamp: i * 1000,
    }))
    await store.saveMessages('agent-1', 'pag-1', msgs)

    // load last 3 messages (no offset)
    const last3 = await store.loadMessages('agent-1', 'pag-1', 3)
    expect(last3).toHaveLength(3)
    expect(last3[0]!.content).toBe('msg-7')
    expect(last3[2]!.content).toBe('msg-9')

    // load 3 messages with offset 2 (skip last 2)
    const offset2 = await store.loadMessages('agent-1', 'pag-1', 3, 2)
    expect(offset2).toHaveLength(3)
    expect(offset2[0]!.content).toBe('msg-5')
    expect(offset2[2]!.content).toBe('msg-7')
  })

  it('stores large chats in page files and reads windows across page boundaries', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 3,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'paged-1')
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `msg-${i}`,
      timestamp: i,
    }))

    await pagedStore.saveMessages('agent-1', 'paged-1', msgs)

    expect(await fs.readdir(chatPagesDir('paged-1'))).toEqual([
      '000001.json',
      '000002.json',
      '000003.json',
      '000004.json',
    ])
    const meta = await readJsonFile<{ messageCount: number; localMessageCount: number }>(
      chatMetaPath('paged-1')
    )
    expect(meta).toMatchObject({ messageCount: 10, localMessageCount: 10 })

    const window = await pagedStore.loadMessages('agent-1', 'paged-1', 4, 2)
    expect(window.map(message => message.content)).toEqual(['msg-4', 'msg-5', 'msg-6', 'msg-7'])
  })

  it('appends into the last page before creating another page', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'append-pages')
    await pagedStore.saveMessages('agent-1', 'append-pages', [
      { id: 'm0', role: 'user', content: 'msg-0', timestamp: 0 },
      { id: 'm1', role: 'user', content: 'msg-1', timestamp: 1 },
      { id: 'm2', role: 'user', content: 'msg-2', timestamp: 2 },
    ])

    await pagedStore.appendMessages('agent-1', 'append-pages', [
      { id: 'm3', role: 'user', content: 'msg-3', timestamp: 3 },
      { id: 'm4', role: 'user', content: 'msg-4', timestamp: 4 },
    ])

    expect(await fs.readdir(chatPagesDir('append-pages'))).toEqual([
      '000001.json',
      '000002.json',
      '000003.json',
    ])
    const secondPage = await readJsonFile<{ messages: ChatMessage[] }>(
      join(chatPagesDir('append-pages'), '000002.json')
    )
    expect(secondPage.messages.map(message => message.id)).toEqual(['m2', 'm3'])

    const messages = await pagedStore.loadMessages('agent-1', 'append-pages')
    expect(messages.map(message => message.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('serializes paged reads behind concurrent appends', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'atomic-read')
    await pagedStore.saveMessages('agent-1', 'atomic-read', [
      { id: 'm0', role: 'user', content: 'msg-0', timestamp: 0 },
      { id: 'm1', role: 'user', content: 'msg-1', timestamp: 1 },
    ])

    const originalWriteFile = fs.writeFile.bind(fs)
    let releaseWrite: (() => void) | undefined
    let delayedWrite = false
    const appendWriteStarted = new Promise<void>(resolve => {
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const filePath = String(args[0])
        if (!delayedWrite && filePath.includes('atomic-read') && filePath.endsWith('.tmp')) {
          delayedWrite = true
          resolve()
          await new Promise<void>(release => {
            releaseWrite = release
          })
        }
        return originalWriteFile(...(args as Parameters<typeof fs.writeFile>))
      })
    })

    const append = pagedStore.appendMessages('agent-1', 'atomic-read', [
      { id: 'm2', role: 'assistant', content: 'msg-2', timestamp: 2 },
    ])
    await appendWriteStarted

    const loadedDuringAppend = pagedStore.loadMessages('agent-1', 'atomic-read')
    await Promise.resolve()
    releaseWrite?.()

    const [messages] = await Promise.all([loadedDuringAppend, append.then(() => undefined)])
    expect(messages.map(message => message.id)).toEqual(['m0', 'm1', 'm2'])
  })

  it('prunes only old pages whose messages are known to exist on the server', async () => {
    const prunedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: 4,
    })
    await prunedStore.createChat('agent-1', 'pruned')
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `msg-${i}`,
      timestamp: i,
      serverTurnNumber: i + 1,
    }))

    await prunedStore.saveMessages('agent-1', 'pruned', msgs)

    expect(await fs.readdir(chatPagesDir('pruned'))).toEqual(['000002.json', '000003.json'])
    await expect(fs.access(join(chatPagesDir('pruned'), '000001.json'))).rejects.toThrow()
    const meta = await readJsonFile<{
      messageCount: number
      localMessageCount: number
      prunedBeforeCount: number
      prunedThroughServerTurnNumber: number
    }>(chatMetaPath('pruned'))
    expect(meta).toMatchObject({
      messageCount: 6,
      localMessageCount: 4,
      prunedBeforeCount: 2,
      prunedThroughServerTurnNumber: 2,
    })

    const chat = (await prunedStore.listChats('agent-1')).find(item => item.id === 'pruned')
    expect(chat?.messageCount).toBe(6)
    const localMessages = await prunedStore.loadMessages('agent-1', 'pruned')
    expect(localMessages.map(message => message.id)).toEqual(['m2', 'm3', 'm4', 'm5'])
  })

  it('does not prune pages containing local-only messages', async () => {
    const prunedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: 4,
    })
    await prunedStore.createChat('agent-1', 'local-only')
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      role: 'user' as const,
      content: `msg-${i}`,
      timestamp: i,
      ...(i >= 2 ? { serverTurnNumber: i + 1 } : {}),
    }))

    await prunedStore.saveMessages('agent-1', 'local-only', msgs)

    expect(await fs.readdir(chatPagesDir('local-only'))).toEqual([
      '000001.json',
      '000002.json',
      '000003.json',
    ])
    const meta = await readJsonFile<{ localMessageCount: number; prunedBeforeCount?: number }>(
      chatMetaPath('local-only')
    )
    expect(meta.localMessageCount).toBe(6)
    expect(meta.prunedBeforeCount).toBeUndefined()
  })

  it('updates messageCount in index after save', async () => {
    await store.createChat('agent-1', 'mc-1')
    await store.saveMessages('agent-1', 'mc-1', [
      { id: 'm1', role: 'user', content: 'a', timestamp: 1 },
      { id: 'm2', role: 'user', content: 'b', timestamp: 2 },
    ])
    const chats = await store.listChats('agent-1')
    const chat = chats.find(c => c.id === 'mc-1')
    expect(chat!.messageCount).toBe(2)
  })

  it('persists activity aggregates in the chat index', async () => {
    await store.createChat('agent-1', 'activity-1')
    await store.saveMessages('agent-1', 'activity-1', [
      { id: 'm1', role: 'user', content: 'a', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: 'failed',
        timestamp: 2,
        isError: true,
        toolSteps: [
          { toolName: 'search', displayName: 'Search', state: 'completed' },
          { toolName: 'write', displayName: 'Write', state: 'error' },
        ],
      },
    ])

    const chat = (await store.listChats('agent-1')).find(item => item.id === 'activity-1')
    expect(chat).toMatchObject({
      messageCount: 2,
      errorCount: 1,
      toolCallCount: 2,
    })
  })

  it('persists task_id and writes the paged chat cache', async () => {
    await store.createChat('agent-1', 'v2-1')
    await store.saveMessages('agent-1', 'v2-1', [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1, task_id: 'task-abc' },
    ])
    const meta = await readJsonFile<{ version: number; pages: Array<{ file: string }> }>(
      chatMetaPath('v2-1')
    )
    expect(meta.version).toBe(1)
    expect(meta.pages.map(page => page.file)).toEqual(['000001.json'])
    const page = await readJsonFile<{ messages: ChatMessage[] }>(
      join(chatPagesDir('v2-1'), '000001.json')
    )
    expect(page.messages[0]!.task_id).toBe('task-abc')
    await expect(fs.access(join(tempDir, 'agent-1', 'v2-1.json'))).rejects.toThrow()

    const messages = await store.loadMessages('agent-1', 'v2-1')
    expect(messages[0]!.task_id).toBe('task-abc')
  })

  it('loads a legacy v1 chat file without task_id (D.3)', async () => {
    const agentDir = join(tempDir, 'agent-1')
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(
      join(agentDir, 'legacy.json'),
      JSON.stringify({
        version: 1,
        chatId: 'legacy',
        messages: [{ id: 'm1', role: 'user', content: 'old', timestamp: 1 }],
      })
    )
    const messages = await store.loadMessages('agent-1', 'legacy')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.task_id).toBeUndefined()
    await expect(fs.access(join(agentDir, 'legacy.json'))).rejects.toThrow()
    await expect(fs.access(chatMetaPath('legacy'))).resolves.toBeUndefined()
  })
})

// ── lastActiveChatId ─────────────────────────────────────────────────────────

describe('lastActiveChatId', () => {
  it('returns null when none set', async () => {
    const id = await store.getLastActiveChatId('agent-1')
    expect(id).toBeNull()
  })

  it('persists and retrieves', async () => {
    await store.createChat('agent-1', 'last-1')
    await store.setLastActiveChatId('agent-1', 'last-1')
    const id = await store.getLastActiveChatId('agent-1')
    expect(id).toBe('last-1')
  })
})

// ── onboarding ───────────────────────────────────────────────────────────────

describe('onboarding', () => {
  it('defaults to not dismissed', async () => {
    const index = await store.getIndex('agent-1')
    expect(index.onboardingDismissed).toBe(false)
  })

  it('persists onboardingDismissed', async () => {
    await store.setOnboardingDismissed('agent-1', true)
    const index = await store.getIndex('agent-1')
    expect(index.onboardingDismissed).toBe(true)
  })
})

// ── corrupt/missing files ────────────────────────────────────────────────────

describe('corrupt/missing files', () => {
  it('recovers from corrupt index.json', async () => {
    const agentDir = join(tempDir, 'agent-1')
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(join(agentDir, 'index.json'), 'NOT VALID JSON{{{')
    const index = await store.getIndex('agent-1')
    expect(index.version).toBe(2) // empty index is created at the current schema (D.4)
    expect(index.chats).toEqual([])
  })

  it('returns empty messages for missing chat file', async () => {
    const messages = await store.loadMessages('agent-1', 'nonexistent')
    expect(messages).toEqual([])
  })
})

// ── unreadTerminal flag (D.5) ────────────────────────────────────────────────

describe('unreadTerminal', () => {
  it('markUnreadTerminal sets the flag + lastTerminalAt on the chat', async () => {
    await store.createChat('agent-1', 'c1')
    await store.markUnreadTerminal('agent-1', 'c1')
    const chat = (await store.listChats('agent-1')).find(c => c.id === 'c1')!
    expect(chat.unreadTerminal).toBe(true)
    expect(typeof chat.lastTerminalAt).toBe('string')
  })

  it('clearUnreadTerminal clears it', async () => {
    await store.createChat('agent-1', 'c1')
    await store.markUnreadTerminal('agent-1', 'c1')
    await store.clearUnreadTerminal('agent-1', 'c1')
    const chat = (await store.listChats('agent-1')).find(c => c.id === 'c1')!
    expect(chat.unreadTerminal).toBe(false)
  })

  it('is a no-op for an unknown chat (no throw, no phantom entry)', async () => {
    await expect(store.markUnreadTerminal('agent-1', 'missing')).resolves.toBeUndefined()
    expect(await store.listChats('agent-1')).toEqual([])
  })

  it('persists the flag across a reload from disk', async () => {
    await store.createChat('agent-1', 'c1')
    await store.markUnreadTerminal('agent-1', 'c1')
    const reloaded = new ChatStore(tempDir)
    const chat = (await reloaded.listChats('agent-1')).find(c => c.id === 'c1')!
    expect(chat.unreadTerminal).toBe(true)
  })

  it('does not drop the flag when a concurrent index write races it (serialized RMW)', async () => {
    await store.createChat('agent-1', 'c1')
    await store.createChat('agent-1', 'c2')
    // Mark c1 unread while c2 saves messages — both RMW the shared index.json.
    await Promise.all([
      store.markUnreadTerminal('agent-1', 'c1'),
      store.saveMessages('agent-1', 'c2', [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }]),
    ])
    const chats = await store.listChats('agent-1')
    // Neither write clobbered the other.
    expect(chats.find(c => c.id === 'c1')!.unreadTerminal).toBe(true)
    expect(chats.find(c => c.id === 'c2')!.messageCount).toBe(1)
  })
})

// ── path-traversal hardening (D.4 security review) ───────────────────────────

describe('path-segment validation', () => {
  // Write/overwrite verbs reject loudly on a traversing segment.
  it('rejects a traversing agentRef on write verbs', async () => {
    await expect(store.createChat('../escape', 'c1')).rejects.toThrow(/unsafe path segment/)
    await expect(store.createChat('a/b', 'c1')).rejects.toThrow(/unsafe path segment/)
    await expect(store.createChat('.', 'c1')).rejects.toThrow(/unsafe path segment/)
  })

  it('rejects a traversing chatId on replace/append', async () => {
    await expect(store.replaceMessages('agent-1', '../../evil', [])).rejects.toThrow(
      /unsafe path segment/
    )
    await expect(store.appendMessages('agent-1', '../../evil', [])).rejects.toThrow(
      /unsafe path segment/
    )
    await expect(store.saveMessages('agent-1', 'a/b', [])).rejects.toThrow(/unsafe path segment/)
  })

  // Read verbs are tolerant-by-contract (return empty on any failure) — the key
  // security property is that the traversing path is never read off disk.
  it('never reads a traversing path (returns empty without escaping the store)', async () => {
    await expect(store.loadMessages('../escape', 'c1')).resolves.toEqual([])
    await expect(store.loadMessages('agent-1', '..')).resolves.toEqual([])
    await expect(store.loadMessages('agent-1', 'a/b')).resolves.toEqual([])
  })
})

// ── upsertServerSessions (spec §5.3) ──────────────────────────────────────────

describe('upsertServerSessions', () => {
  it('refreshes updatedAt for an existing chat when the server is newer', async () => {
    await store.createChat('agent-1', 'c1')
    // Force an old updatedAt.
    await store.saveMessages('agent-1', 'c1', [])
    const before = (await store.listChats('agent-1')).find(c => c.id === 'c1')!
    const newer = new Date(Date.now() + 60_000).toISOString()

    const changed = await store.upsertServerSessions('agent-1', [
      { chatId: 'c1', lastActivityAt: newer },
    ])

    expect(changed).toBe(1)
    const after = (await store.listChats('agent-1')).find(c => c.id === 'c1')!
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime()
    )
    expect(after.updatedAt).toBe(newer)
  })

  it('does NOT resurrect a server-only session as a local chat (no delete-resurrection)', async () => {
    await store.createChat('agent-1', 'c1')
    const changed = await store.upsertServerSessions('agent-1', [
      { chatId: 'server-only', lastActivityAt: new Date().toISOString() },
    ])
    expect(changed).toBe(0)
    expect((await store.listChats('agent-1')).map(c => c.id)).toEqual(['c1'])
  })

  it('never moves a local chat backwards in time (server older is ignored)', async () => {
    await store.createChat('agent-1', 'c1')
    const current = (await store.listChats('agent-1')).find(c => c.id === 'c1')!
    const older = new Date(Date.now() - 60_000).toISOString()

    const changed = await store.upsertServerSessions('agent-1', [
      { chatId: 'c1', lastActivityAt: older },
    ])

    expect(changed).toBe(0)
    const after = (await store.listChats('agent-1')).find(c => c.id === 'c1')!
    expect(after.updatedAt).toBe(current.updatedAt)
  })

  it('is a no-op for an empty session list', async () => {
    await store.createChat('agent-1', 'c1')
    expect(await store.upsertServerSessions('agent-1', [])).toBe(0)
  })
})
