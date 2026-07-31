import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ChatStore } from '../chatStore.js'
import { turnsToChatMessages } from '../serverTurnAdapter.js'
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

function chatSnapshotDir(
  chatId: string,
  kind: 'next' | 'previous' | 'corrupt',
  token: string
): string {
  return agentPath(
    'chats',
    '.snapshots',
    Buffer.from(chatId, 'utf8').toString('base64url'),
    `${kind}-${token}`
  )
}

function transientFileReadError(code = 'EMFILE'): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

async function readJsonFile<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf-8')) as T
}

async function writePagedSnapshotDir(chatId: string, dir: string, messages: ChatMessage[]) {
  await fs.mkdir(join(dir, 'pages'), { recursive: true })
  await fs.writeFile(
    join(dir, 'pages', '000001.json'),
    JSON.stringify({
      version: 1,
      chatId,
      pageNumber: 1,
      messages,
    })
  )
  await fs.writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({
      version: 1,
      chatId,
      pageSize: 100,
      messageCount: messages.length,
      localMessageCount: messages.length,
      pages: [
        {
          file: '000001.json',
          count: messages.length,
          serverSynced: false,
        },
      ],
    })
  )
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

  it('flushes the atomic index temp file and containing directory', async () => {
    const originalOpen = fs.open.bind(fs)
    const syncedPaths: string[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      const handle = await originalOpen(...(args as Parameters<typeof fs.open>))
      return {
        sync: async () => {
          syncedPaths.push(filePath)
          await handle.sync()
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof fs.open>>
    })

    await store.createChat('agent-1', 'durable-index')

    expect(syncedPaths).toContain(agentPath('index.json.tmp'))
    expect(syncedPaths).toContain(agentPath())
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

  it('removes the index temp file when its atomic rename fails', async () => {
    await store.createChat('agent-1', 'r1')
    const originalRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === agentPath('index.json.tmp')) {
        throw transientFileReadError('EACCES')
      }
      return originalRename(from, to)
    })

    await expect(store.renameChat('agent-1', 'r1', 'Renamed Chat')).rejects.toThrow()
    await expect(fs.access(agentPath('index.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('does not block paged reads behind writes to another chat', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'busy-chat')
    await pagedStore.createChat('agent-1', 'readable-chat')
    await pagedStore.saveMessages('agent-1', 'busy-chat', [
      { id: 'busy-0', role: 'user', content: 'busy', timestamp: 0 },
    ])
    await pagedStore.saveMessages('agent-1', 'readable-chat', [
      { id: 'readable-0', role: 'user', content: 'readable', timestamp: 0 },
    ])

    const originalWriteFile = fs.writeFile.bind(fs)
    const originalReadFile = fs.readFile.bind(fs)
    let releaseWrite: (() => void) | undefined
    let delayedWrite = false
    let readableChatReadStarted = false
    const busyWriteStarted = new Promise<void>(resolve => {
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const filePath = String(args[0])
        if (!delayedWrite && filePath.includes('busy-chat') && filePath.endsWith('.tmp')) {
          delayedWrite = true
          resolve()
          await new Promise<void>(release => {
            releaseWrite = release
          })
        }
        return originalWriteFile(...(args as Parameters<typeof fs.writeFile>))
      })
    })
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes('readable-chat')) readableChatReadStarted = true
      return originalReadFile(...(args as Parameters<typeof fs.readFile>))
    })

    const append = pagedStore.appendMessages('agent-1', 'busy-chat', [
      { id: 'busy-1', role: 'assistant', content: 'still busy', timestamp: 1 },
    ])
    await busyWriteStarted

    const readableMessages = pagedStore.loadMessages('agent-1', 'readable-chat')
    try {
      await vi.waitFor(() => expect(readableChatReadStarted).toBe(true))
    } finally {
      releaseWrite?.()
    }

    const [messages] = await Promise.all([readableMessages, append.then(() => undefined)])
    expect(messages.map(message => message.id)).toEqual(['readable-0'])
  })

  it('keeps the previous paged snapshot if a full rewrite fails while staged', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'rewrite-failure')
    const originalMessages = [
      { id: 'old-0', role: 'user' as const, content: 'old-0', timestamp: 0 },
      { id: 'old-1', role: 'assistant' as const, content: 'old-1', timestamp: 1 },
      { id: 'old-2', role: 'user' as const, content: 'old-2', timestamp: 2 },
      { id: 'old-3', role: 'assistant' as const, content: 'old-3', timestamp: 3 },
    ]
    await pagedStore.saveMessages('agent-1', 'rewrite-failure', originalMessages)

    const originalWriteFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      if (
        filePath.includes(
          join('.snapshots', Buffer.from('rewrite-failure').toString('base64url'))
        ) &&
        filePath.includes('next-') &&
        filePath.endsWith('000001.json.tmp')
      ) {
        throw new Error('injected page write failure')
      }
      return originalWriteFile(...(args as Parameters<typeof fs.writeFile>))
    })

    await expect(
      pagedStore.saveMessages('agent-1', 'rewrite-failure', [
        { id: 'new-0', role: 'user', content: 'new-0', timestamp: 4 },
      ])
    ).rejects.toThrow('injected page write failure')

    const reloaded = await pagedStore.loadMessages('agent-1', 'rewrite-failure')
    expect(reloaded.map(message => message.id)).toEqual(['old-0', 'old-1', 'old-2', 'old-3'])
  })

  it('flushes both parents when promoting a staged paged snapshot', async () => {
    const originalOpen = fs.open.bind(fs)
    const syncedPaths: string[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      const handle = await originalOpen(...(args as Parameters<typeof fs.open>))
      return {
        sync: async () => {
          syncedPaths.push(filePath)
          await handle.sync()
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof fs.open>>
    })

    await store.createChat('agent-1', 'durable-snapshot')
    await store.saveMessages('agent-1', 'durable-snapshot', [
      { id: 'm1', role: 'user', content: 'durable', timestamp: 1 },
    ])

    const encodedChatId = Buffer.from('durable-snapshot', 'utf8').toString('base64url')
    expect(syncedPaths).toContain(agentPath('chats'))
    expect(syncedPaths).toContain(agentPath('chats', '.snapshots', encodedChatId))
  })

  it('aborts append instead of resetting the transcript on transient meta read failure', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 5,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'meta-read-failure')
    await pagedStore.saveMessages('agent-1', 'meta-read-failure', [
      { id: 'old-0', role: 'user', content: 'old-0', timestamp: 0 },
      { id: 'old-1', role: 'assistant', content: 'old-1', timestamp: 1 },
    ])

    const originalReadFile = fs.readFile.bind(fs)
    let injected = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      if (!injected && filePath.endsWith(join('meta-read-failure', 'meta.json'))) {
        injected = true
        throw transientFileReadError()
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>))
    })

    await expect(
      pagedStore.appendMessages('agent-1', 'meta-read-failure', [
        { id: 'new-0', role: 'user', content: 'new-0', timestamp: 2 },
      ])
    ).rejects.toThrow()

    vi.restoreAllMocks()
    const reloaded = await pagedStore.loadMessages('agent-1', 'meta-read-failure')
    expect(reloaded.map(message => message.id)).toEqual(['old-0', 'old-1'])
  })

  it('aborts append instead of truncating the last page on transient page read failure', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 10,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'page-read-failure')
    const originalMessages = Array.from({ length: 5 }, (_, i) => ({
      id: `old-${i}`,
      role: 'user' as const,
      content: `old-${i}`,
      timestamp: i,
    }))
    await pagedStore.saveMessages('agent-1', 'page-read-failure', originalMessages)

    const originalReadFile = fs.readFile.bind(fs)
    let injected = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      if (!injected && filePath.includes('page-read-failure') && filePath.endsWith('000001.json')) {
        injected = true
        throw transientFileReadError()
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>))
    })

    await expect(
      pagedStore.appendMessages('agent-1', 'page-read-failure', [
        { id: 'new-0', role: 'assistant', content: 'new-0', timestamp: 6 },
      ])
    ).rejects.toThrow()

    vi.restoreAllMocks()
    const reloaded = await pagedStore.loadMessages('agent-1', 'page-read-failure')
    expect(reloaded.map(message => message.id)).toEqual(originalMessages.map(message => message.id))
  })

  it('recovers the previous paged snapshot after an interrupted directory switch', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'switch-recovery')
    await pagedStore.saveMessages('agent-1', 'switch-recovery', [
      { id: 'm0', role: 'user', content: 'msg-0', timestamp: 0 },
      { id: 'm1', role: 'assistant', content: 'msg-1', timestamp: 1 },
    ])

    const previousSnapshot = chatSnapshotDir('switch-recovery', 'previous', 'test')
    await fs.mkdir(dirname(previousSnapshot), { recursive: true })
    await fs.rename(chatCacheDir('switch-recovery'), previousSnapshot)
    const originalOpen = fs.open.bind(fs)
    const syncedPaths: string[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      const handle = await originalOpen(...(args as Parameters<typeof fs.open>))
      return {
        sync: async () => {
          syncedPaths.push(filePath)
          await handle.sync()
        },
        close: () => handle.close(),
      } as Awaited<ReturnType<typeof fs.open>>
    })

    const reloaded = await pagedStore.loadMessages('agent-1', 'switch-recovery')
    expect(reloaded.map(message => message.id)).toEqual(['m0', 'm1'])
    await expect(fs.access(chatMetaPath('switch-recovery'))).resolves.toBeUndefined()
    const encodedChatId = Buffer.from('switch-recovery', 'utf8').toString('base64url')
    expect(syncedPaths).toContain(agentPath('chats'))
    expect(syncedPaths).toContain(agentPath('chats', '.snapshots', encodedChatId))
  })

  it('completes recovery from a fully written next snapshot after a mid-swap crash', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'next-recovery')
    await pagedStore.saveMessages('agent-1', 'next-recovery', [
      { id: 'old-0', role: 'user', content: 'old-0', timestamp: 0 },
    ])

    const nextDir = chatSnapshotDir('next-recovery', 'next', 'test')
    await writePagedSnapshotDir('next-recovery', nextDir, [
      { id: 'new-0', role: 'user', content: 'new-0', timestamp: 1 },
      { id: 'new-1', role: 'assistant', content: 'new-1', timestamp: 2 },
    ])
    await fs.rename(
      chatCacheDir('next-recovery'),
      chatSnapshotDir('next-recovery', 'previous', 'test')
    )

    const reloaded = await pagedStore.loadMessages('agent-1', 'next-recovery')
    expect(reloaded.map(message => message.id)).toEqual(['new-0', 'new-1'])
    await expect(fs.access(chatSnapshotDir('next-recovery', 'next', 'test'))).rejects.toThrow()
    await expect(fs.access(chatSnapshotDir('next-recovery', 'previous', 'test'))).rejects.toThrow()
  })

  it('uses the newest valid snapshot group instead of preferring stale next snapshots', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'snapshot-order')
    await pagedStore.saveMessages('agent-1', 'snapshot-order', [
      { id: 'active-0', role: 'user', content: 'active-0', timestamp: 0 },
    ])

    const staleNext = chatSnapshotDir('snapshot-order', 'next', 'old')
    const freshPrevious = chatSnapshotDir('snapshot-order', 'previous', 'new')
    await writePagedSnapshotDir('snapshot-order', staleNext, [
      { id: 'stale-0', role: 'user', content: 'stale-0', timestamp: 1 },
    ])
    await writePagedSnapshotDir('snapshot-order', freshPrevious, [
      { id: 'fresh-0', role: 'assistant', content: 'fresh-0', timestamp: 2 },
    ])
    const oldTime = new Date('2026-01-01T00:00:00Z')
    const freshTime = new Date('2026-01-02T00:00:00Z')
    await fs.utimes(staleNext, oldTime, oldTime)
    await fs.utimes(freshPrevious, freshTime, freshTime)
    await fs.writeFile(chatMetaPath('snapshot-order'), 'not-json')

    const reloaded = await pagedStore.loadMessages('agent-1', 'snapshot-order')
    expect(reloaded.map(message => message.id)).toEqual(['fresh-0'])
  })

  it('does not promote an incomplete snapshot whose page files are missing', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'incomplete-snapshot')
    const incomplete = chatSnapshotDir('incomplete-snapshot', 'previous', 'test')
    await writePagedSnapshotDir('incomplete-snapshot', incomplete, [
      { id: 'backup-0', role: 'user', content: 'backup-0', timestamp: 0 },
    ])
    await fs.rm(join(incomplete, 'pages', '000001.json'), { force: true })

    const reloaded = await pagedStore.loadMessages('agent-1', 'incomplete-snapshot')
    expect(reloaded).toEqual([])
    await expect(fs.access(chatMetaPath('incomplete-snapshot'))).rejects.toThrow()
  })

  it('cleans stale snapshot siblings when the active paged snapshot is healthy', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'stale-snapshots')
    await pagedStore.saveMessages('agent-1', 'stale-snapshots', [
      { id: 'm0', role: 'user', content: 'msg-0', timestamp: 0 },
    ])

    await fs.mkdir(chatSnapshotDir('stale-snapshots', 'next', 'stale'), { recursive: true })
    await fs.mkdir(chatSnapshotDir('stale-snapshots', 'previous', 'stale'), { recursive: true })

    const restartedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    const reloaded = await restartedStore.loadMessages('agent-1', 'stale-snapshots')
    expect(reloaded.map(message => message.id)).toEqual(['m0'])
    await expect(fs.access(chatSnapshotDir('stale-snapshots', 'next', 'stale'))).rejects.toThrow()
    await expect(
      fs.access(chatSnapshotDir('stale-snapshots', 'previous', 'stale'))
    ).rejects.toThrow()
  })

  it('deletes snapshot siblings so removed chats cannot be recovered later', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'delete-siblings')
    await pagedStore.saveMessages('agent-1', 'delete-siblings', [
      { id: 'm0', role: 'user', content: 'msg-0', timestamp: 0 },
    ])
    await writePagedSnapshotDir(
      'delete-siblings',
      chatSnapshotDir('delete-siblings', 'previous', 'test'),
      [{ id: 'backup-0', role: 'user', content: 'backup-0', timestamp: 1 }]
    )

    await pagedStore.deleteChat('agent-1', 'delete-siblings')

    expect(await pagedStore.loadMessages('agent-1', 'delete-siblings')).toEqual([])
    await expect(
      fs.access(chatSnapshotDir('delete-siblings', 'previous', 'test'))
    ).rejects.toThrow()
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
    }>(chatMetaPath('pruned'))
    expect(meta).toMatchObject({
      messageCount: 6,
      localMessageCount: 4,
      prunedBeforeCount: 2,
    })

    const chat = (await prunedStore.listChats('agent-1')).find(item => item.id === 'pruned')
    expect(chat?.messageCount).toBe(6)
    const localMessages = await prunedStore.loadMessages('agent-1', 'pruned')
    expect(localMessages.map(message => message.id)).toEqual(['m2', 'm3', 'm4', 'm5'])
  })

  it('keeps a contiguous transcript when an older local-only page blocks pruning', async () => {
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
    expect(
      (await prunedStore.loadMessages('agent-1', 'local-only')).map(message => message.id)
    ).toEqual(msgs.map(message => message.id))
  })

  it('recognizes legacy turn-N-role ids as server-synced for safe prefix pruning', async () => {
    const prunedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: 2,
    })
    await prunedStore.createChat('agent-1', 'legacy-turn-ids')
    const msgs = [
      { id: 'turn-1-user', role: 'user' as const, content: 'q1', timestamp: 1 },
      { id: 'turn-1-assistant', role: 'assistant' as const, content: 'a1', timestamp: 2 },
      { id: 'turn-2-user', role: 'user' as const, content: 'q2', timestamp: 3 },
      { id: 'turn-2-assistant', role: 'assistant' as const, content: 'a2', timestamp: 4 },
    ]

    await prunedStore.saveMessages('agent-1', 'legacy-turn-ids', msgs)

    expect(await fs.readdir(chatPagesDir('legacy-turn-ids'))).toEqual(['000002.json'])
    expect(
      (await prunedStore.loadMessages('agent-1', 'legacy-turn-ids')).map(message => message.id)
    ).toEqual(['turn-2-user', 'turn-2-assistant'])
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

  it('keeps sidebar messageCount in visible user/assistant units after appends', async () => {
    await store.createChat('agent-1', 'visible-count')
    await store.saveMessages('agent-1', 'visible-count', [
      { id: 'm1', role: 'user', content: 'question', timestamp: 1 },
      { id: 's1', role: 'system', content: 'local status', timestamp: 2 },
    ])
    await store.appendMessages('agent-1', 'visible-count', [
      { id: 'm2', role: 'assistant', content: 'answer', timestamp: 3 },
      { id: 's2', role: 'system', content: 'another status', timestamp: 4 },
    ])

    const chat = (await store.listChats('agent-1')).find(item => item.id === 'visible-count')
    expect(chat?.messageCount).toBe(2)
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

  it('preserves aggregate counters when replaceMessages writes a bounded server window', async () => {
    await store.createChat('agent-1', 'bounded-replace')
    await store.saveMessages('agent-1', 'bounded-replace', [
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
      { id: 'm3', role: 'user', content: 'b', timestamp: 3 },
    ])

    await store.replaceMessages('agent-1', 'bounded-replace', [
      { id: 'm3', role: 'user', content: 'b', timestamp: 3 },
    ])

    const chat = (await store.listChats('agent-1')).find(item => item.id === 'bounded-replace')
    expect(chat).toMatchObject({
      messageCount: 3,
      errorCount: 1,
      toolCallCount: 2,
    })
    const meta = await readJsonFile<{ messageCount: number; localMessageCount: number }>(
      chatMetaPath('bounded-replace')
    )
    expect(meta).toMatchObject({ messageCount: 3, localMessageCount: 3 })
    expect(
      (await store.loadMessages('agent-1', 'bounded-replace')).map(message => message.id)
    ).toEqual(['m1', 'm2', 'm3'])
  })

  it('preserves local history around a bounded reconciliation fallback', async () => {
    await store.createChat('agent-1', 'bounded-window')
    await store.saveMessages('agent-1', 'bounded-window', [
      {
        id: 'local-note',
        role: 'assistant',
        content: 'local-only message outside the server window',
        timestamp: 0,
      },
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'stale',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'turn-999-user',
        role: 'user',
        content: 'newest',
        timestamp: 999,
        serverTurnNumber: 999,
      },
    ])

    await store.replaceMessages('agent-1', 'bounded-window', [
      {
        id: 'turn-999-user',
        role: 'user',
        content: 'newest',
        timestamp: 999,
        serverTurnNumber: 999,
      },
    ])

    expect(
      (await store.loadMessages('agent-1', 'bounded-window')).map(message => message.id)
    ).toEqual(['local-note', 'turn-1-user', 'turn-999-user'])
  })

  it('uses active task context while persisting an authoritative window', async () => {
    await store.createChat('agent-1', 'active-window')
    await store.saveMessages('agent-1', 'active-window', [
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'first',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'optimistic-user',
        role: 'user',
        content: 'second',
        timestamp: 2,
        task_id: 'task-2',
      },
    ])

    await store.replaceMessages(
      'agent-1',
      'active-window',
      [
        {
          id: 'turn-2-user',
          role: 'user',
          content: 'second',
          timestamp: 3,
          serverTurnNumber: 2,
        },
      ],
      { activeTaskIds: ['task-2'] }
    )

    expect(
      (await store.loadMessages('agent-1', 'active-window')).map(message => message.id)
    ).toEqual(['turn-1-user', 'optimistic-user'])
  })

  it('replaces a settled legacy turnless cache without persisting duplicate history', async () => {
    await store.createChat('agent-1', 'legacy-turnless')
    await store.saveMessages('agent-1', 'legacy-turnless', [
      { id: 'legacy-q1', role: 'user', content: 'q1', timestamp: 1 },
      { id: 'legacy-a1', role: 'assistant', content: 'a1', timestamp: 2 },
      { id: 'legacy-q2', role: 'user', content: 'q2', timestamp: 3 },
      { id: 'legacy-a2', role: 'assistant', content: 'a2', timestamp: 4 },
    ])

    const authoritative = turnsToChatMessages([
      {
        number: 1,
        user_input: 'q1',
        response: 'a1',
        started_at: '2026-01-01T00:00:01.000Z',
        completed_at: '2026-01-01T00:00:02.000Z',
      },
      {
        number: 2,
        user_input: 'q2',
        response: 'a2',
        started_at: '2026-01-01T00:00:03.000Z',
        completed_at: '2026-01-01T00:00:04.000Z',
      },
      {
        number: 3,
        user_input: 'q3',
        response: 'a3',
        started_at: '2026-01-01T00:00:05.000Z',
        completed_at: '2026-01-01T00:00:06.000Z',
      },
    ])

    await store.replaceMessages('agent-1', 'legacy-turnless', authoritative)

    expect(
      (await store.loadMessages('agent-1', 'legacy-turnless')).map(message => message.id)
    ).toEqual([
      'turn-1-user',
      'turn-1-assistant',
      'turn-2-user',
      'turn-2-assistant',
      'turn-3-user',
      'turn-3-assistant',
    ])
  })

  it('keeps unseen numbered history while replacing completed local-only echoes', async () => {
    await store.createChat('agent-1', 'reconcile-upsert')
    await store.saveMessages('agent-1', 'reconcile-upsert', [
      {
        id: 'turn-1-user',
        role: 'user',
        content: 'old',
        timestamp: 1,
        serverTurnNumber: 1,
      },
      {
        id: 'local-only',
        role: 'assistant',
        content: 'not on the server',
        timestamp: 2,
        task_id: 'local-task',
      },
      {
        id: 'turn-2-user',
        role: 'user',
        content: 'new',
        timestamp: 3,
        serverTurnNumber: 2,
      },
    ])

    await store.replaceMessages('agent-1', 'reconcile-upsert', [
      {
        id: 'turn-2-user',
        role: 'user',
        content: 'new',
        timestamp: 3,
        serverTurnNumber: 2,
      },
      {
        id: 'turn-2-assistant',
        role: 'assistant',
        content: 'reply',
        timestamp: 4,
        serverTurnNumber: 2,
      },
    ])

    expect(
      (await store.loadMessages('agent-1', 'reconcile-upsert')).map(message => message.id)
    ).toEqual(['turn-1-user', 'turn-2-user', 'turn-2-assistant'])
  })

  it('repairs a missing page from surviving pages and the compatibility snapshot', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'missing-page')
    await pagedStore.saveMessages(
      'agent-1',
      'missing-page',
      Array.from({ length: 6 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: `message-${index}`,
        timestamp: index,
        serverTurnNumber: index + 1,
      }))
    )
    await fs.rm(join(chatPagesDir('missing-page'), '000002.json'))
    const staleIndex = await readJsonFile<{
      chats: Array<{ id: string; messageCount: number }>
    }>(agentPath('index.json'))
    staleIndex.chats.find(chat => chat.id === 'missing-page')!.messageCount = 1
    await fs.writeFile(agentPath('index.json'), JSON.stringify(staleIndex))

    const restartedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    const recovered = await restartedStore.loadMessages('agent-1', 'missing-page')

    expect(recovered.map(message => message.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    const repairedMeta = await readJsonFile<{ localMessageCount: number }>(
      chatMetaPath('missing-page')
    )
    expect(repairedMeta.localMessageCount).toBe(6)
    expect(
      (await restartedStore.listChats('agent-1')).find(chat => chat.id === 'missing-page')
        ?.messageCount
    ).toBe(6)
  })

  it('adopts a fully written orphan page left by an interrupted append', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'orphan-append')
    await pagedStore.saveMessages('agent-1', 'orphan-append', [
      { id: 'm0', role: 'user', content: 'zero', timestamp: 0 },
      { id: 'm1', role: 'assistant', content: 'one', timestamp: 1 },
    ])
    await fs.writeFile(
      join(chatPagesDir('orphan-append'), '000002.json'),
      JSON.stringify({
        version: 1,
        chatId: 'orphan-append',
        pageNumber: 2,
        messages: [{ id: 'm2', role: 'user', content: 'durable local', timestamp: 2 }],
      })
    )

    const restartedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    const recovered = await restartedStore.loadMessages('agent-1', 'orphan-append')

    expect(recovered.map(message => message.id)).toEqual(['m0', 'm1', 'm2'])
    const repairedMeta = await readJsonFile<{ localMessageCount: number; pages: unknown[] }>(
      chatMetaPath('orphan-append')
    )
    expect(repairedMeta).toMatchObject({ localMessageCount: 3 })
    expect(repairedMeta.pages).toHaveLength(2)
    expect(
      (await restartedStore.listChats('agent-1')).find(chat => chat.id === 'orphan-append')
        ?.messageCount
    ).toBe(3)
  })

  it('does not adopt an orphan page across a missing page number', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'orphan-gap')
    await pagedStore.saveMessages('agent-1', 'orphan-gap', [
      { id: 'm0', role: 'user', content: 'zero', timestamp: 0 },
      { id: 'm1', role: 'assistant', content: 'one', timestamp: 1 },
    ])
    await fs.writeFile(
      join(chatPagesDir('orphan-gap'), '000003.json'),
      JSON.stringify({
        version: 1,
        chatId: 'orphan-gap',
        pageNumber: 3,
        messages: [{ id: 'm4', role: 'user', content: 'after missing page', timestamp: 4 }],
      })
    )

    const restartedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    const firstRead = await restartedStore.loadMessages('agent-1', 'orphan-gap')
    const secondRead = await restartedStore.loadMessages('agent-1', 'orphan-gap')
    const meta = await readJsonFile<{ pages: Array<{ file: string }> }>(chatMetaPath('orphan-gap'))

    expect(firstRead.map(message => message.id)).toEqual(['m0', 'm1'])
    expect(secondRead.map(message => message.id)).toEqual(['m0', 'm1'])
    expect(meta.pages.map(page => page.file)).toEqual(['000001.json'])
    await expect(
      fs.access(join(chatPagesDir('orphan-gap'), '000003.json'))
    ).resolves.toBeUndefined()
  })

  it('recovers page data when hot metadata contains an invalid page count', async () => {
    await store.createChat('agent-1', 'invalid-page-count')
    await store.saveMessages('agent-1', 'invalid-page-count', [
      { id: 'm0', role: 'user', content: 'keep me', timestamp: 0 },
    ])
    const meta = await readJsonFile<{ pages: Array<{ count: number | null }> }>(
      chatMetaPath('invalid-page-count')
    )
    meta.pages[0]!.count = null
    await fs.writeFile(chatMetaPath('invalid-page-count'), JSON.stringify(meta))

    const recovered = await store.loadMessages('agent-1', 'invalid-page-count')

    expect(recovered.map(message => message.id)).toEqual(['m0'])
    expect(
      (await readJsonFile<{ pages: Array<{ count: number }> }>(chatMetaPath('invalid-page-count')))
        .pages[0]!.count
    ).toBe(1)
  })

  it('re-derives page sync metadata before pruning local-only messages', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: 2,
    })
    await pagedStore.createChat('agent-1', 'corrupt-page-sync')
    await pagedStore.saveMessages(
      'agent-1',
      'corrupt-page-sync',
      Array.from({ length: 4 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message-${index}`,
        timestamp: index,
      }))
    )
    const metaPath = chatMetaPath('corrupt-page-sync')
    const meta = await readJsonFile<{ pages: Array<{ serverSynced: boolean }> }>(metaPath)
    meta.pages[0]!.serverSynced = true
    await fs.writeFile(metaPath, JSON.stringify(meta))

    const restarted = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: 2,
    })
    await restarted.appendMessages('agent-1', 'corrupt-page-sync', [
      { id: 'm4', role: 'user', content: 'message-4', timestamp: 4 },
    ])

    expect(
      (await restarted.loadMessages('agent-1', 'corrupt-page-sync')).map(message => message.id)
    ).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(
      (
        await readJsonFile<{ pages: Array<{ serverSynced: boolean }> }>(
          chatMetaPath('corrupt-page-sync')
        )
      ).pages[0]!.serverSynced
    ).toBe(false)
  })

  it('recovers strictly ordered pages before appending to reordered metadata', async () => {
    const pagedStore = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await pagedStore.createChat('agent-1', 'reordered-pages')
    await pagedStore.saveMessages(
      'agent-1',
      'reordered-pages',
      Array.from({ length: 6 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: `message-${index}`,
        timestamp: index,
      }))
    )
    const metaPath = chatMetaPath('reordered-pages')
    const meta = await readJsonFile<{ pages: unknown[] }>(metaPath)
    meta.pages = [meta.pages[2], meta.pages[0], meta.pages[1]]
    await fs.writeFile(metaPath, JSON.stringify(meta))

    const restarted = new ChatStore(tempDir, {
      pageSize: 2,
      maxLocalSyncedMessages: Number.POSITIVE_INFINITY,
    })
    await restarted.appendMessages('agent-1', 'reordered-pages', [
      { id: 'm6', role: 'assistant', content: 'message-6', timestamp: 6 },
    ])

    expect(
      (await restarted.loadMessages('agent-1', 'reordered-pages')).map(message => message.id)
    ).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
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
    const compatibility = await readJsonFile<{ version: number; messages: ChatMessage[] }>(
      join(tempDir, 'agent-1', 'v2-1.json')
    )
    expect(compatibility.version).toBe(2)
    expect(compatibility.messages[0]!.task_id).toBe('task-abc')

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
    await expect(fs.access(join(agentDir, 'legacy.json'))).resolves.toBeUndefined()
    await expect(fs.access(chatMetaPath('legacy'))).resolves.toBeUndefined()
  })

  it('backfills stale index counters while migrating a legacy chat file', async () => {
    const agentDir = join(tempDir, 'agent-1')
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(
      agentPath('index.json'),
      JSON.stringify({
        version: 2,
        lastActiveChatId: null,
        onboardingDismissed: false,
        chats: [
          {
            id: 'legacy-counters',
            title: 'Legacy counters',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messageCount: 0,
            errorCount: 0,
            toolCallCount: 0,
          },
        ],
      })
    )
    await fs.writeFile(
      join(agentDir, 'legacy-counters.json'),
      JSON.stringify({
        version: 1,
        chatId: 'legacy-counters',
        messages: [
          { id: 'm1', role: 'user', content: 'old', timestamp: 1 },
          {
            id: 'm2',
            role: 'assistant',
            content: 'failed',
            timestamp: 2,
            isError: true,
            toolSteps: [{ toolName: 'read', displayName: 'Read', state: 'completed' }],
          },
        ],
      })
    )

    const messages = await store.loadMessages('agent-1', 'legacy-counters')

    expect(messages).toHaveLength(2)
    const chat = (await store.listChats('agent-1')).find(item => item.id === 'legacy-counters')
    expect(chat).toMatchObject({
      messageCount: 2,
      errorCount: 1,
      toolCallCount: 1,
    })
    const migratedIndex = await readJsonFile<{ version: number }>(agentPath('index.json'))
    expect(migratedIndex.version).toBe(2)
  })

  it('keeps the downgrade snapshot bounded and current after appends', async () => {
    await store.createChat('agent-1', 'downgrade-window')
    const messages = Array.from({ length: 105 }, (_, index) => ({
      id: `m${index}`,
      role: 'user' as const,
      content: `message-${index}`,
      timestamp: index,
    }))

    await store.saveMessages('agent-1', 'downgrade-window', messages)

    const initial = await readJsonFile<{ version: number; messages: ChatMessage[] }>(
      agentPath('downgrade-window.json')
    )
    expect(initial.version).toBe(2)
    expect(initial.messages).toHaveLength(100)
    expect(initial.messages[0]!.id).toBe('m5')
    expect(initial.messages.at(-1)!.id).toBe('m104')

    await store.appendMessages('agent-1', 'downgrade-window', [
      { id: 'm105', role: 'assistant', content: 'message-105', timestamp: 105 },
    ])

    const appended = await readJsonFile<{ messages: ChatMessage[] }>(
      agentPath('downgrade-window.json')
    )
    expect(appended.messages).toHaveLength(100)
    expect(appended.messages[0]!.id).toBe('m6')
    expect(appended.messages.at(-1)!.id).toBe('m105')
  })

  it('bounds in-memory compatibility windows by serialized bytes', async () => {
    const largeContent = 'x'.repeat(2 * 1024 * 1024)
    for (let index = 0; index < 5; index += 1) {
      const chatId = `large-window-${index}`
      await store.createChat('agent-1', chatId)
      await store.saveMessages('agent-1', chatId, [
        {
          id: `message-${index}`,
          role: 'user',
          content: largeContent,
          timestamp: index,
        },
      ])
    }

    const internals = store as unknown as {
      compatibilityWindows: Map<string, ChatMessage[]>
      compatibilityWindowsTotalBytes: number
    }
    expect(internals.compatibilityWindowsTotalBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(internals.compatibilityWindows.size).toBeLessThan(5)
  })

  it('creates chat-store directories with owner-only permissions', async () => {
    await store.createChat('agent-1', 'private-chat')
    await store.saveMessages('agent-1', 'private-chat', [
      { id: 'm1', role: 'user', content: 'private', timestamp: 1 },
    ])

    for (const dir of [
      agentPath(),
      agentPath('chats'),
      chatCacheDir('private-chat'),
      chatPagesDir('private-chat'),
    ]) {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
    }
  })

  it('imports local messages written by a downgraded desktop build', async () => {
    await store.createChat('agent-1', 'downgraded-write')
    const original = { id: 'm1', role: 'user' as const, content: 'original', timestamp: 1 }
    await store.saveMessages('agent-1', 'downgraded-write', [original])

    const downgradedMessage = {
      id: 'm2',
      role: 'user' as const,
      content: 'written while downgraded',
      timestamp: 2,
    }
    await fs.writeFile(
      agentPath('downgraded-write.json'),
      JSON.stringify({
        version: 2,
        chatId: 'downgraded-write',
        messages: [original, downgradedMessage],
      })
    )

    const restartedStore = new ChatStore(tempDir)
    const recovered = await restartedStore.loadMessages('agent-1', 'downgraded-write')

    expect(recovered.map(message => message.id)).toEqual(['m1', 'm2'])
    const compatibility = await readJsonFile<{ messages: ChatMessage[] }>(
      agentPath('downgraded-write.json')
    )
    expect(compatibility.messages.map(message => message.id)).toEqual(['m1', 'm2'])
  })

  it('repairs a corrupt downgrade snapshot from the valid paged history', async () => {
    await store.createChat('agent-1', 'corrupt-downgrade-snapshot')
    await store.saveMessages('agent-1', 'corrupt-downgrade-snapshot', [
      { id: 'm1', role: 'user', content: 'still durable', timestamp: 1 },
    ])
    await fs.writeFile(agentPath('corrupt-downgrade-snapshot.json'), 'not json{')

    const restartedStore = new ChatStore(tempDir)
    const recovered = await restartedStore.loadMessages('agent-1', 'corrupt-downgrade-snapshot')

    expect(recovered.map(message => message.id)).toEqual(['m1'])
    const compatibility = await readJsonFile<{ messages: ChatMessage[] }>(
      agentPath('corrupt-downgrade-snapshot.json')
    )
    expect(compatibility.messages.map(message => message.id)).toEqual(['m1'])
  })

  it('does not retry an unreadable auxiliary downgrade snapshot on every hot read', async () => {
    await store.createChat('agent-1', 'unreadable-downgrade-snapshot')
    await store.saveMessages('agent-1', 'unreadable-downgrade-snapshot', [
      { id: 'm1', role: 'user', content: 'still durable', timestamp: 1 },
    ])
    const restartedStore = new ChatStore(tempDir)
    const originalReadFile = fs.readFile.bind(fs)
    let compatibilityReadAttempts = 0
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === agentPath('unreadable-downgrade-snapshot.json')) {
        compatibilityReadAttempts += 1
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>))
    })

    await expect(
      restartedStore.loadMessages('agent-1', 'unreadable-downgrade-snapshot')
    ).resolves.toHaveLength(1)
    await expect(
      restartedStore.loadMessages('agent-1', 'unreadable-downgrade-snapshot')
    ).resolves.toHaveLength(1)

    expect(compatibilityReadAttempts).toBe(1)
  })

  it('does not hide a failed legacy migration as an empty chat', async () => {
    const agentDir = join(tempDir, 'agent-1')
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(
      join(agentDir, 'migration-failure.json'),
      JSON.stringify({
        version: 1,
        chatId: 'migration-failure',
        messages: [{ id: 'm1', role: 'user', content: 'old', timestamp: 1 }],
      })
    )

    const originalWriteFile = fs.writeFile.bind(fs)
    let injected = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const filePath = String(args[0])
      if (
        !injected &&
        filePath.includes(
          join('.snapshots', Buffer.from('migration-failure').toString('base64url'))
        ) &&
        filePath.includes('next-')
      ) {
        injected = true
        throw transientFileReadError('ENOSPC')
      }
      return originalWriteFile(...(args as Parameters<typeof fs.writeFile>))
    })

    await expect(store.loadMessages('agent-1', 'migration-failure')).rejects.toThrow()

    vi.restoreAllMocks()
    await expect(fs.access(join(agentDir, 'migration-failure.json'))).resolves.toBeUndefined()
    const messages = await store.loadMessages('agent-1', 'migration-failure')
    expect(messages.map(message => message.id)).toEqual(['m1'])
  })

  it('keeps a committed paged rewrite successful when the downgrade snapshot write fails', async () => {
    const chatId = 'compatibility-write-failure'
    await store.createChat('agent-1', chatId)
    await store.saveMessages('agent-1', chatId, [
      { id: 'old', role: 'user', content: 'old', timestamp: 1 },
    ])

    const originalWriteFile = fs.writeFile.bind(fs)
    let injected = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (!injected && String(args[0]) === agentPath(`${chatId}.json.tmp`)) {
        injected = true
        throw transientFileReadError('ENOSPC')
      }
      return originalWriteFile(...(args as Parameters<typeof fs.writeFile>))
    })

    await expect(
      store.saveMessages('agent-1', chatId, [
        { id: 'new', role: 'assistant', content: 'new', timestamp: 2 },
      ])
    ).resolves.toBeUndefined()

    expect((await store.loadMessages('agent-1', chatId)).map(message => message.id)).toEqual([
      'new',
    ])
    expect(
      (await readJsonFile<{ messages: ChatMessage[] }>(agentPath(`${chatId}.json`))).messages.map(
        message => message.id
      )
    ).toEqual(['new'])
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
  it('fails closed without quarantining or downgrading a valid future index', async () => {
    const agentDir = join(tempDir, 'agent-1')
    const preservedChatDir = join(agentDir, 'chats', 'future-chat')
    await writePagedSnapshotDir('future-chat', preservedChatDir, [
      { id: 'future-local', role: 'user', content: 'keep me', timestamp: 1 },
    ])
    const preservedMeta = await fs.readFile(join(preservedChatDir, 'meta.json'), 'utf8')
    const preservedPage = await fs.readFile(join(preservedChatDir, 'pages', '000001.json'), 'utf8')
    const indexPath = join(agentDir, 'index.json')
    const futureIndex = JSON.stringify({
      version: 4,
      lastActiveChatId: 'future-chat',
      onboardingDismissed: false,
      chats: [
        {
          id: 'future-chat',
          title: 'Future chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messageCount: 1,
        },
      ],
    })
    await fs.writeFile(indexPath, futureIndex)

    await expect(store.getIndex('agent-1')).rejects.toThrow(/unsupported chat index version 4/i)
    await expect(store.createChat('agent-1', 'new-chat')).rejects.toThrow(
      /unsupported chat index version 4/i
    )
    await expect(
      store.appendMessages('agent-1', 'future-chat', [
        { id: 'new-local', role: 'assistant', content: 'do not write', timestamp: 2 },
      ])
    ).rejects.toThrow(/unsupported chat index version 4/i)
    await expect(
      store.replaceMessages('agent-1', 'future-chat', [
        {
          id: 'turn-1-user',
          role: 'user',
          content: 'server',
          timestamp: 3,
          serverTurnNumber: 1,
        },
      ])
    ).rejects.toThrow(/unsupported chat index version 4/i)

    expect(await fs.readFile(indexPath, 'utf8')).toBe(futureIndex)
    expect(await fs.readFile(join(preservedChatDir, 'meta.json'), 'utf8')).toBe(preservedMeta)
    expect(await fs.readFile(join(preservedChatDir, 'pages', '000001.json'), 'utf8')).toBe(
      preservedPage
    )
    await expect(fs.access(agentPath('.corrupt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('quarantines a torn index once and preserves paged transcripts while writes recover', async () => {
    const originalMessage: ChatMessage = {
      id: 'local-only-message',
      role: 'user',
      content: 'keep me',
      timestamp: 1,
      preserveLocal: true,
    }
    await store.createChat('agent-1', 'kept-chat')
    await store.appendMessages('agent-1', 'kept-chat', [originalMessage])

    const agentDir = join(tempDir, 'agent-1')
    const indexPath = join(agentDir, 'index.json')
    const corrupt = '{"version":2,"chats":[{"id":"kept-chat"'
    await fs.writeFile(indexPath, corrupt)

    await expect(store.getIndex('agent-1')).resolves.toEqual({
      version: 2,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    await expect(store.getIndex('agent-1')).resolves.toEqual({
      version: 2,
      lastActiveChatId: null,
      onboardingDismissed: false,
      chats: [],
    })
    const quarantinedIndexes = (await fs.readdir(agentPath('.corrupt'))).filter(name =>
      name.startsWith('index-')
    )
    expect(quarantinedIndexes).toHaveLength(1)
    expect(await fs.readFile(agentPath('.corrupt', quarantinedIndexes[0]!), 'utf8')).toBe(corrupt)

    await expect(
      store.appendMessages('agent-1', 'kept-chat', [
        {
          id: 'new-message',
          role: 'assistant',
          content: 'still writable',
          timestamp: 2,
        },
      ])
    ).resolves.toBeUndefined()
    expect((await store.loadMessages('agent-1', 'kept-chat')).map(message => message.id)).toEqual([
      'local-only-message',
      'new-message',
    ])
    await expect(store.createChat('agent-1', 'new-chat')).resolves.toMatchObject({ id: 'new-chat' })
    await expect(fs.access(chatCacheDir('kept-chat'))).resolves.toBeUndefined()
  })

  it('normalizes a readable v3 index during the next ordinary RMW', async () => {
    const agentDir = join(tempDir, 'agent-1')
    await fs.mkdir(agentDir, { recursive: true })
    const indexPath = join(agentDir, 'index.json')
    const future = JSON.stringify({
      version: 3,
      lastActiveChatId: 'kept',
      onboardingDismissed: false,
      chats: [
        {
          id: 'kept',
          title: 'Keep',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messageCount: 1,
        },
      ],
    })
    await fs.writeFile(indexPath, future)

    expect(await store.getIndex('agent-1')).toMatchObject({
      version: 2,
      chats: [expect.objectContaining({ id: 'kept' })],
    })
    await expect(store.renameChat('agent-1', 'kept', 'Changed')).resolves.toBeUndefined()
    expect(await readJsonFile(indexPath)).toMatchObject({
      version: 2,
      chats: [expect.objectContaining({ id: 'kept', title: 'Changed' })],
    })
  })

  it('quarantines a structurally invalid index before rebuilding the catalog', async () => {
    const agentDir = join(tempDir, 'agent-1')
    await fs.mkdir(agentDir, { recursive: true })
    const indexPath = join(agentDir, 'index.json')
    const invalid = JSON.stringify({
      version: 2,
      lastActiveChatId: 'kept',
      onboardingDismissed: false,
      chats: [
        {
          id: 'kept',
          title: 'Keep',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messageCount: 1e309,
        },
      ],
    })
    await fs.writeFile(indexPath, invalid)

    await expect(store.createChat('agent-1', 'new-chat')).resolves.toMatchObject({ id: 'new-chat' })
    const quarantinedIndexes = (await fs.readdir(agentPath('.corrupt'))).filter(name =>
      name.startsWith('index-')
    )
    expect(quarantinedIndexes).toHaveLength(1)
    expect(await fs.readFile(agentPath('.corrupt', quarantinedIndexes[0]!), 'utf8')).toBe(invalid)
    expect(await readJsonFile(indexPath)).toMatchObject({
      version: 2,
      chats: [expect.objectContaining({ id: 'new-chat' })],
    })
  })

  it('does not overwrite an index after a transient read failure', async () => {
    await store.createChat('agent-1', 'kept')
    const originalReadFile = fs.readFile.bind(fs)
    let injected = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (!injected && String(args[0]) === agentPath('index.json')) {
        injected = true
        throw transientFileReadError('EACCES')
      }
      return originalReadFile(...(args as Parameters<typeof fs.readFile>))
    })

    await expect(store.renameChat('agent-1', 'kept', 'Lost')).rejects.toThrow()

    vi.restoreAllMocks()
    expect((await store.listChats('agent-1')).find(chat => chat.id === 'kept')?.title).toBe(
      'New Chat'
    )
  })

  it('returns empty messages for missing chat file', async () => {
    const messages = await store.loadMessages('agent-1', 'nonexistent')
    expect(messages).toEqual([])
  })

  it('quarantines a corrupt legacy chat and allows it to become writable again', async () => {
    const chatId = 'corrupt-legacy'
    await store.createChat('agent-1', chatId)
    await fs.writeFile(agentPath(`${chatId}.json`), '{"version":2,"messages":[')

    await expect(store.loadMessages('agent-1', chatId)).resolves.toEqual([])
    const encodedChatId = Buffer.from(chatId, 'utf8').toString('base64url')
    const quarantined = await fs.readdir(agentPath('.corrupt', encodedChatId))
    expect(quarantined).toHaveLength(1)
    await expect(fs.stat(agentPath(`${chatId}.json`))).rejects.toMatchObject({ code: 'ENOENT' })

    const replacement = {
      id: 'turn-1-user',
      role: 'user' as const,
      content: 'rehydrated',
      timestamp: 1,
    }
    await store.appendMessages('agent-1', chatId, [replacement])
    await expect(store.loadMessages('agent-1', chatId)).resolves.toEqual([replacement])
  })

  it('quarantines an unreadable paged snapshot and allows server rehydration', async () => {
    const chatId = 'corrupt-paged'
    await store.createChat('agent-1', chatId)
    await store.saveMessages('agent-1', chatId, [
      { id: 'old', role: 'user', content: 'old', timestamp: 1 },
    ])
    await fs.rm(agentPath(`${chatId}.json`), { force: true })
    await fs.rm(agentPath(`${chatId}.compat`), { force: true })
    await fs.writeFile(chatMetaPath(chatId), JSON.stringify({ version: 999, chatId }))
    await fs.writeFile(join(chatPagesDir(chatId), '000001.json'), 'not-json')

    await expect(store.loadMessages('agent-1', chatId)).resolves.toEqual([])
    const snapshotRoot = agentPath(
      'chats',
      '.snapshots',
      Buffer.from(chatId, 'utf8').toString('base64url')
    )
    expect((await fs.readdir(snapshotRoot)).some(name => name.startsWith('corrupt-'))).toBe(true)

    const replacement = {
      id: 'turn-1-user',
      role: 'user' as const,
      content: 'rehydrated',
      timestamp: 2,
    }
    await store.appendMessages('agent-1', chatId, [replacement])
    await expect(store.loadMessages('agent-1', chatId)).resolves.toEqual([replacement])
  })

  it('deletes matching quarantined legacy files with the chat', async () => {
    const chatId = 'deleted-corrupt'
    const otherChatId = `${chatId}-other`
    await store.createChat('agent-1', chatId)
    const corruptDir = agentPath('.corrupt')
    const encodedChatId = Buffer.from(chatId, 'utf8').toString('base64url')
    const otherEncodedChatId = Buffer.from(otherChatId, 'utf8').toString('base64url')
    const legacyUuid = '00000000-0000-4000-8000-000000000000'
    await fs.mkdir(join(corruptDir, encodedChatId), { recursive: true })
    await fs.writeFile(join(corruptDir, encodedChatId, 'nested.json'), '{}')
    await fs.writeFile(join(corruptDir, `${encodedChatId}-${legacyUuid}.json`), '{}')
    await fs.writeFile(join(corruptDir, `${otherEncodedChatId}-${legacyUuid}.json`), '{}')

    await store.deleteChat('agent-1', chatId)

    await expect(fs.access(join(corruptDir, encodedChatId))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      fs.access(join(corruptDir, `${encodedChatId}-${legacyUuid}.json`))
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      fs.access(join(corruptDir, `${otherEncodedChatId}-${legacyUuid}.json`))
    ).resolves.toBeUndefined()
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
    await expect(store.createChat('agent\nforged', 'c1')).rejects.toThrow(/unsafe path segment/)
    await expect(store.createChat('CON', 'c1')).rejects.toThrow(/unsafe path segment/)
  })

  it('rejects a traversing chatId on replace/append', async () => {
    await expect(store.replaceMessages('agent-1', '../../evil', [])).rejects.toThrow(
      /unsafe path segment/
    )
    await expect(store.appendMessages('agent-1', '../../evil', [])).rejects.toThrow(
      /unsafe path segment/
    )
    await expect(store.saveMessages('agent-1', 'a/b', [])).rejects.toThrow(/unsafe path segment/)
    await expect(store.saveMessages('agent-1', 'other.next-shadow', [])).resolves.toBeUndefined()
    await expect(store.saveMessages('agent-1', '.snapshots', [])).rejects.toThrow(
      /unsafe path segment/
    )
    await expect(store.saveMessages('agent-1', 'index', [])).rejects.toThrow(/unsafe path segment/)
    for (const chatId of ['INDEX', 'chat:1', 'chat.', 'chat ', 'NUL.txt', 'chat\u0007id']) {
      await expect(store.saveMessages('agent-1', chatId, [])).rejects.toThrow(/unsafe path segment/)
    }
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
