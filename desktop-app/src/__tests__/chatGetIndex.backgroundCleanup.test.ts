import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deletedChatIdsForScope } from '../../ui/src/hooks/domain/useChatListController'
import { runChatGetIndex } from '../chatGetIndexHandler.js'
import { ChatStore } from '../chatStore.js'
import type { ChatIndex, ChatMetadata } from '../types.js'

const authorityScope = { environmentKey: 'env-a', userId: 'user-a', teamId: 'team-a' }
const agentRef = 'agent-1'
const deletedChatId = 'deleted-chat'
const tombstone = { chatId: deletedChatId, authorityScope }
let tempDir: string
let artifactPath: string
let store: ChatStore

beforeEach(async () => {
  tempDir = await fs.mkdtemp(join(tmpdir(), 'chat-get-index-background-'))
  artifactPath = join(tempDir, agentRef, 'chats', deletedChatId)
  store = new ChatStore(tempDir)
  store.setAuthorityScope(authorityScope)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tempDir, { recursive: true, force: true })
})

async function queuePendingCleanup(): Promise<ChatMetadata> {
  await store.createChat(agentRef, 'kept-chat')
  await store.createChat(agentRef, deletedChatId)
  await store.saveMessages(agentRef, deletedChatId, [
    { id: 'message-1', role: 'user', content: 'Deleted transcript', timestamp: 1 },
  ])
  const originalIndex = await store.getIndex(agentRef)
  const deletedChat = originalIndex.chats.find(chat => chat.id === deletedChatId)!
  const remove = fs.rm.bind(fs)
  const denial = Object.assign(new Error('Artifact removal denied'), { code: 'EACCES' })
  const rm = vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (String(args[0]) === artifactPath) throw denial
    return remove(...args)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    await expect(store.deleteChat(agentRef, deletedChatId, authorityScope)).resolves.toEqual({
      cleanupPending: true,
    })
    expect((await store.getIndex(agentRef)).pendingChatCleanup).toEqual([tombstone])
    await expect(fs.access(artifactPath)).resolves.toBeUndefined()
  } finally {
    rm.mockRestore()
    warn.mockRestore()
  }
  return deletedChat
}

async function readWhileArtifactRemovalIsBlocked(inspect: (index: ChatIndex) => void) {
  let release!: () => void
  let removalStarted = false
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  const remove = fs.rm.bind(fs)
  vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (String(args[0]) === artifactPath) {
      removalStarted = true
      await blocked
    }
    return remove(...args)
  })
  const retry = vi.spyOn(store, 'retryPendingDeleteCleanups')
  const warnCleanupFailure = vi.fn()
  let returnedIndex: ChatIndex | undefined
  const read = runChatGetIndex(
    {
      store,
      getChatDeletionFenceAuthority: () => ({ authorityScope }),
      warnCleanupFailure,
    },
    agentRef
  ).then(index => {
    returnedIndex = index
    return index
  })
  try {
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith(authorityScope, agentRef)
    await vi.waitFor(() => {
      expect(removalStarted).toBe(true)
      expect(returnedIndex).toBeDefined()
    })
    await expect(fs.access(artifactPath)).resolves.toBeUndefined()
    const index = await read
    expect(index.pendingChatCleanup).toEqual([tombstone])
    inspect(index)
  } finally {
    release()
    await Promise.allSettled([read, ...retry.mock.results.map(result => result.value)])
  }
  await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const finishedIndex = await store.getIndex(agentRef)
  expect(finishedIndex.pendingChatCleanup).toEqual([])
  expect(finishedIndex.deletedChatTombstones).toEqual([tombstone])
  expect(warnCleanupFailure).not.toHaveBeenCalled()
}

describe('runChatGetIndex background artifact cleanup', () => {
  it('returns the real index before artifact removal, then removes the artifact and clears its queue', async () => {
    await queuePendingCleanup()

    await readWhileArtifactRemovalIsBlocked(index => {
      expect(index.chats.map(chat => chat.id)).toEqual(['kept-chat'])
    })
  })

  it('keeps a pending deletion hidden by the renderer tombstone filter before cleanup finishes', async () => {
    const staleChat = await queuePendingCleanup()
    const pendingIndex = await store.getIndex(agentRef)
    // Include a stale catalog row so visibility depends on the durable tombstone,
    // rather than passing merely because deleteChat already removed the row.
    await fs.writeFile(
      join(tempDir, agentRef, 'index.json'),
      JSON.stringify({ ...pendingIndex, chats: [...pendingIndex.chats, staleChat] })
    )

    await readWhileArtifactRemovalIsBlocked(index => {
      expect(index.chats.map(chat => chat.id)).toEqual(['kept-chat', deletedChatId])
      expect(index.deletedChatTombstones).toEqual([tombstone])
      const deleted = new Set(deletedChatIdsForScope(index, authorityScope))
      expect([...deleted]).toEqual([deletedChatId])
      const visible = index.chats.filter(chat => !deleted.has(chat.id))
      expect(visible.map(chat => chat.id)).toEqual(['kept-chat'])
    })
  })

  it('finishes a pending cleanup once when two reads overlap', async () => {
    await queuePendingCleanup()
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const remove = fs.rm.bind(fs)
    let artifactRemovals = 0
    vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]) === artifactPath) {
        artifactRemovals += 1
        await blocked
      }
      return remove(...args)
    })
    const serializeChat = vi.spyOn(
      store as unknown as { serializeChat: (...args: unknown[]) => Promise<unknown> },
      'serializeChat'
    )
    const saveIndex = vi.spyOn(
      store as unknown as { saveIndex: (...args: unknown[]) => Promise<void> },
      'saveIndex'
    )
    const retry = vi.spyOn(store, 'retryPendingDeleteCleanups')
    const warnCleanupFailure = vi.fn()
    const deps = {
      store,
      getChatDeletionFenceAuthority: () => ({ authorityScope }),
      warnCleanupFailure,
    }

    const reads = [runChatGetIndex(deps, agentRef), runChatGetIndex(deps, agentRef)]
    try {
      // Both passes snapshot the queue with the tombstone in it: the first is
      // blocked removing the artifact, the second waits behind it for the chat.
      await vi.waitFor(() => {
        expect(artifactRemovals).toBe(1)
        expect(serializeChat).toHaveBeenCalledTimes(2)
      })
      for (const index of await Promise.all(reads)) {
        expect(index.pendingChatCleanup).toEqual([tombstone])
      }
    } finally {
      release()
      await Promise.allSettled([...reads, ...retry.mock.results.map(result => result.value)])
    }

    expect(retry).toHaveBeenCalledTimes(2)
    // Liveness: the cleanup ran to completion and the kept chat is untouched.
    await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const finishedIndex = await store.getIndex(agentRef)
    expect(finishedIndex.pendingChatCleanup).toEqual([])
    expect(finishedIndex.chats.map(chat => chat.id)).toEqual(['kept-chat'])
    // The second pass found the tombstone dequeued: no second removal or save.
    expect(artifactRemovals).toBe(1)
    expect(saveIndex).toHaveBeenCalledTimes(1)
    expect(warnCleanupFailure).not.toHaveBeenCalled()
  })
})
