import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  __setChatStoreBaseDirForTests,
  bindChatStoreForUser,
  requireChatStore,
  unbindChatStore,
} from '../chatStoreBinding'

describe('chatStoreBinding', () => {
  let tmpBase: string

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-chatstore-'))
    __setChatStoreBaseDirForTests(tmpBase)
    unbindChatStore()
  })

  afterEach(async () => {
    unbindChatStore()
    await fs.rm(tmpBase, { recursive: true, force: true })
  })

  it('requireChatStore throws Not authenticated before any bind', () => {
    expect(() => requireChatStore()).toThrow(/Not authenticated/)
  })

  it('bindChatStoreForUser returns a store rooted under the user subdir', async () => {
    await bindChatStoreForUser('user-a')
    const store = requireChatStore()
    await store.createChat('agent-x', 'chat-1')
    const exists = await fs
      .stat(path.join(tmpBase, 'user-a', 'agent-x', 'index.json'))
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  it('unbindChatStore makes requireChatStore throw again', async () => {
    await bindChatStoreForUser('user-a')
    unbindChatStore()
    expect(() => requireChatStore()).toThrow(/Not authenticated/)
  })

  it("rebinding to a different user does not touch the previous user's files", async () => {
    await bindChatStoreForUser('user-a')
    await requireChatStore().createChat('agent-x', 'chat-a')

    await bindChatStoreForUser('user-b')
    await requireChatStore().createChat('agent-x', 'chat-b')

    const userAIndex = path.join(tmpBase, 'user-a', 'agent-x', 'index.json')
    const userBIndex = path.join(tmpBase, 'user-b', 'agent-x', 'index.json')
    expect((await fs.stat(userAIndex)).isFile()).toBe(true)
    expect((await fs.stat(userBIndex)).isFile()).toBe(true)
  })

  it('rebinding the same userId is idempotent (no files moved or lost)', async () => {
    await bindChatStoreForUser('user-a')
    await requireChatStore().createChat('agent-x', 'chat-a')
    await bindChatStoreForUser('user-a')
    const chats = await requireChatStore().listChats('agent-x')
    expect(chats.find(c => c.id === 'chat-a')).toBeDefined()
  })

  it('rebinding the same userId keeps the store bound (no "Not authenticated" window)', async () => {
    await bindChatStoreForUser('user-a')
    const firstStore = requireChatStore()

    // Same-user re-bind (team switch / catalog refresh) must not tear down the
    // active store: a concurrent chat IPC between unbind and rebind would
    // throw "Not authenticated" and blank the UI's session lists.
    const rebind = bindChatStoreForUser('user-a')
    expect(requireChatStore()).toBe(firstStore)
    await rebind
    expect(requireChatStore()).toBe(firstStore)
  })

  it('coalesces concurrent binds for the same userId', async () => {
    const first = bindChatStoreForUser('user-a')
    const second = bindChatStoreForUser('user-a')
    await Promise.all([first, second])
    const store = requireChatStore()
    await store.createChat('agent-x', 'chat-1')
    expect((await store.listChats('agent-x')).map(c => c.id)).toEqual(['chat-1'])
  })

  // D.4 §7.1 / §5.2 — bootstrap wipes any pre-v2 (legacy) per-agent cache dir.
  describe('legacy cache wipe on bind', () => {
    async function seedAgentDir(
      userId: string,
      agentRef: string,
      indexContent: string | null,
      chatFiles: Record<string, string> = {}
    ) {
      const agentDir = path.join(tmpBase, userId, agentRef)
      await fs.mkdir(agentDir, { recursive: true })
      if (indexContent !== null) {
        await fs.writeFile(path.join(agentDir, 'index.json'), indexContent)
      }
      for (const [name, body] of Object.entries(chatFiles)) {
        await fs.writeFile(path.join(agentDir, name), body)
      }
    }

    const exists = (p: string) =>
      fs
        .stat(p)
        .then(() => true)
        .catch(() => false)

    it('wipes an agent dir whose index.json is v1', async () => {
      const v1Index = JSON.stringify({
        version: 1,
        chats: [{ id: 'old' }],
        lastActiveChatId: 'old',
      })
      await seedAgentDir('user-legacy', 'agent-x', v1Index, { 'old.json': '{"version":1}' })

      await bindChatStoreForUser('user-legacy')

      expect(await exists(path.join(tmpBase, 'user-legacy', 'agent-x'))).toBe(false)
      // A fresh store works and starts empty.
      const chats = await requireChatStore().listChats('agent-x')
      expect(chats).toEqual([])
    })

    it('wipes an agent dir with a missing/unparseable index.json', async () => {
      await seedAgentDir('user-broken', 'agent-x', 'not json{', { 'c.json': '{}' })
      await seedAgentDir('user-broken', 'agent-y', null, { 'c.json': '{}' })

      await bindChatStoreForUser('user-broken')

      expect(await exists(path.join(tmpBase, 'user-broken', 'agent-x'))).toBe(false)
      expect(await exists(path.join(tmpBase, 'user-broken', 'agent-y'))).toBe(false)
    })

    it('preserves a v2 agent dir', async () => {
      const v2Index = JSON.stringify({
        version: 2,
        chats: [{ id: 'keep', title: 'Keep', createdAt: 'x', updatedAt: 'x', messageCount: 1 }],
        lastActiveChatId: 'keep',
        chatPanelOpen: false,
        onboardingDismissed: false,
      })
      await seedAgentDir('user-current', 'agent-x', v2Index)

      await bindChatStoreForUser('user-current')

      expect(await exists(path.join(tmpBase, 'user-current', 'agent-x', 'index.json'))).toBe(true)
      const chats = await requireChatStore().listChats('agent-x')
      expect(chats.find(c => c.id === 'keep')).toBeDefined()
    })

    it('is a no-op when the user has no cache directory yet', async () => {
      await expect(bindChatStoreForUser('brand-new-user')).resolves.toBeUndefined()
      const chats = await requireChatStore().listChats('agent-x')
      expect(chats).toEqual([])
    })

    it('rejects an unsafe userId before touching the filesystem (no wipe escape)', async () => {
      for (const bad of ['', '.', '..', '../../etc', 'a/b', 'a\\b']) {
        await expect(bindChatStoreForUser(bad)).rejects.toThrow(/unsafe path segment/)
      }
      // A rejected bind leaves the store unbound rather than serving a wrong dir.
      expect(() => requireChatStore()).toThrow(/Not authenticated/)
    })
  })
})
