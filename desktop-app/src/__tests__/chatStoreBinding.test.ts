import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  __setChatStoreBaseDirForTests,
  bindChatStoreForUser,
  requireChatStore,
  unbindChatStore,
} from '../chatStoreBinding'

// Env keys are opaque, filesystem-safe slugs from resolveEnvKey. Any two distinct
// strings model two distinct environments for these tests.
const ENV_A = 'env-a-0011223344'
const ENV_B = 'env-b-5566778899'

const exists = (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false)

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

  it('does not publish a stale store when logout interrupts an in-flight bind', async () => {
    await bindChatStoreForUser('seed-user', ENV_A)
    unbindChatStore()

    const originalReadDir = fs.readdir.bind(fs)
    let releaseRead: (() => void) | undefined
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    let readStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      readStarted = resolve
    })
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(path.join(ENV_A, 'user-b'))) {
        readStarted?.()
        await readBlocked
      }
      return originalReadDir(...(args as Parameters<typeof fs.readdir>))
    })

    const binding = bindChatStoreForUser('user-b', ENV_A)
    await started
    unbindChatStore()
    releaseRead?.()
    await binding

    expect(() => requireChatStore()).toThrow(/Not authenticated/)
  })

  it('roots the store under <base>/<envKey>/<userId> (spec §5.2)', async () => {
    await bindChatStoreForUser('user-a', ENV_A)
    const store = requireChatStore()
    await store.createChat('agent-x', 'chat-1')
    expect(await exists(path.join(tmpBase, ENV_A, 'user-a', 'agent-x', 'index.json'))).toBe(true)
    // Never under the legacy (pre-envKey) location.
    expect(await exists(path.join(tmpBase, 'user-a', 'agent-x', 'index.json'))).toBe(false)
  })

  it('isolates the SAME user across environments (the cross-cluster bug)', async () => {
    await bindChatStoreForUser('user-a', ENV_A)
    await requireChatStore().createChat('agent-x', 'chat-in-a')

    await bindChatStoreForUser('user-a', ENV_B)
    // Env B starts empty — env A's chat is invisible here.
    expect(await requireChatStore().listChats('agent-x')).toEqual([])
    await requireChatStore().createChat('agent-x', 'chat-in-b')

    // Both env subtrees exist and hold only their own chat.
    await bindChatStoreForUser('user-a', ENV_A)
    expect((await requireChatStore().listChats('agent-x')).map(c => c.id)).toEqual(['chat-in-a'])
    await bindChatStoreForUser('user-a', ENV_B)
    expect((await requireChatStore().listChats('agent-x')).map(c => c.id)).toEqual(['chat-in-b'])
  })

  it('re-binds when the envKey changes for the same user', async () => {
    await bindChatStoreForUser('user-a', ENV_A)
    const storeA = requireChatStore()
    await bindChatStoreForUser('user-a', ENV_B)
    expect(requireChatStore()).not.toBe(storeA)
  })

  it('unbindChatStore makes requireChatStore throw again', async () => {
    await bindChatStoreForUser('user-a', ENV_A)
    unbindChatStore()
    expect(() => requireChatStore()).toThrow(/Not authenticated/)
  })

  it('rebinding the same (env, userId) is idempotent (no files moved or lost)', async () => {
    await bindChatStoreForUser('user-a', ENV_A)
    await requireChatStore().createChat('agent-x', 'chat-a')
    await bindChatStoreForUser('user-a', ENV_A)
    const chats = await requireChatStore().listChats('agent-x')
    expect(chats.find(c => c.id === 'chat-a')).toBeDefined()
  })

  it('rebinding the same (env, userId) keeps the store bound (no "Not authenticated" window)', async () => {
    await bindChatStoreForUser('user-a', ENV_A)
    const firstStore = requireChatStore()
    const rebind = bindChatStoreForUser('user-a', ENV_A)
    expect(requireChatStore()).toBe(firstStore)
    await rebind
    expect(requireChatStore()).toBe(firstStore)
  })

  it('coalesces concurrent binds for the same (env, userId)', async () => {
    const first = bindChatStoreForUser('user-a', ENV_A)
    const second = bindChatStoreForUser('user-a', ENV_A)
    await Promise.all([first, second])
    const store = requireChatStore()
    await store.createChat('agent-x', 'chat-1')
    expect((await store.listChats('agent-x')).map(c => c.id)).toEqual(['chat-1'])
  })

  it('rejects an unsafe userId or envKey before touching the filesystem (no wipe escape)', async () => {
    for (const bad of ['', '.', '..', '../../etc', 'a/b', 'a\\b']) {
      await expect(bindChatStoreForUser(bad, ENV_A)).rejects.toThrow(/unsafe path segment/)
      await expect(bindChatStoreForUser('user-a', bad)).rejects.toThrow(/unsafe path segment/)
    }
    expect(() => requireChatStore()).toThrow(/Not authenticated/)
  })

  // §5.2 / §7.1 — bootstrap wipes any pre-v2 (legacy schema) per-agent cache dir
  // WITHIN the env-scoped user directory.
  describe('legacy schema wipe on bind', () => {
    async function seedAgentDir(
      envKey: string,
      userId: string,
      agentRef: string,
      indexContent: string | null,
      chatFiles: Record<string, string> = {}
    ) {
      const agentDir = path.join(tmpBase, envKey, userId, agentRef)
      await fs.mkdir(agentDir, { recursive: true })
      if (indexContent !== null) {
        await fs.writeFile(path.join(agentDir, 'index.json'), indexContent)
      }
      for (const [name, body] of Object.entries(chatFiles)) {
        await fs.writeFile(path.join(agentDir, name), body)
      }
    }

    it('wipes an agent dir whose index.json is v1', async () => {
      const v1Index = JSON.stringify({
        version: 1,
        chats: [{ id: 'old' }],
        lastActiveChatId: 'old',
      })
      await seedAgentDir(ENV_A, 'user-legacy', 'agent-x', v1Index, { 'old.json': '{"version":1}' })

      await bindChatStoreForUser('user-legacy', ENV_A)

      expect(await exists(path.join(tmpBase, ENV_A, 'user-legacy', 'agent-x'))).toBe(false)
      expect(await requireChatStore().listChats('agent-x')).toEqual([])
    })

    it('wipes an agent dir with a missing/unparseable index.json', async () => {
      await seedAgentDir(ENV_A, 'user-broken', 'agent-x', 'not json{', { 'c.json': '{}' })
      await seedAgentDir(ENV_A, 'user-broken', 'agent-y', null, { 'c.json': '{}' })

      await bindChatStoreForUser('user-broken', ENV_A)

      expect(await exists(path.join(tmpBase, ENV_A, 'user-broken', 'agent-x'))).toBe(false)
      expect(await exists(path.join(tmpBase, ENV_A, 'user-broken', 'agent-y'))).toBe(false)
    })

    it('preserves the downgrade-compatible v2 agent index', async () => {
      const v2Index = JSON.stringify({
        version: 2,
        chats: [{ id: 'keep', title: 'Keep', createdAt: 'x', updatedAt: 'x', messageCount: 1 }],
        lastActiveChatId: 'keep',
        onboardingDismissed: false,
      })
      await seedAgentDir(ENV_A, 'user-current', 'agent-x', v2Index)

      await bindChatStoreForUser('user-current', ENV_A)

      expect(await exists(path.join(tmpBase, ENV_A, 'user-current', 'agent-x', 'index.json'))).toBe(
        true
      )
      expect(
        (await requireChatStore().listChats('agent-x')).find(c => c.id === 'keep')
      ).toBeDefined()
      const preserved = JSON.parse(
        await fs.readFile(
          path.join(tmpBase, ENV_A, 'user-current', 'agent-x', 'index.json'),
          'utf-8'
        )
      ) as { version: number }
      expect(preserved.version).toBe(2)
    })

    it('normalizes an earlier paging v3 index back to downgrade-compatible v2', async () => {
      const v3Index = JSON.stringify({
        version: 3,
        chats: [{ id: 'keep', title: 'Keep', createdAt: 'x', updatedAt: 'x', messageCount: 1 }],
        lastActiveChatId: 'keep',
        onboardingDismissed: false,
      })
      await seedAgentDir(ENV_A, 'user-v3', 'agent-x', v3Index, {
        'keep.json': JSON.stringify({
          version: 2,
          chatId: 'keep',
          messages: [{ id: 'm1', role: 'user', content: 'keep me', timestamp: 1 }],
        }),
      })

      await bindChatStoreForUser('user-v3', ENV_A)

      const normalized = JSON.parse(
        await fs.readFile(path.join(tmpBase, ENV_A, 'user-v3', 'agent-x', 'index.json'), 'utf-8')
      ) as { version: number }
      expect(normalized.version).toBe(2)
      expect(await exists(path.join(tmpBase, ENV_A, 'user-v3', 'agent-x', 'keep.json'))).toBe(true)
    })

    it('preserves a valid v3 cache when its index normalization cannot be renamed', async () => {
      const v3Index = JSON.stringify({
        version: 3,
        chats: [{ id: 'keep', title: 'Keep', createdAt: 'x', updatedAt: 'x', messageCount: 1 }],
        lastActiveChatId: 'keep',
        onboardingDismissed: false,
      })
      await seedAgentDir(ENV_A, 'user-v3-failure', 'agent-x', v3Index, {
        'keep.json': '{"version":2,"chatId":"keep","messages":[]}',
      })
      const originalRename = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(from).endsWith('index.json.v2.tmp')) {
          const error = new Error('read only') as NodeJS.ErrnoException
          error.code = 'EACCES'
          throw error
        }
        return originalRename(from, to)
      })

      await bindChatStoreForUser('user-v3-failure', ENV_A)

      expect(
        await exists(path.join(tmpBase, ENV_A, 'user-v3-failure', 'agent-x', 'keep.json'))
      ).toBe(true)
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(tmpBase, ENV_A, 'user-v3-failure', 'agent-x', 'index.json'),
            'utf-8'
          )
        ).version
      ).toBe(3)
    })

    it('is a no-op when the user has no cache directory yet', async () => {
      await expect(bindChatStoreForUser('brand-new-user', ENV_A)).resolves.toBeUndefined()
      expect(await requireChatStore().listChats('agent-x')).toEqual([])
    })
  })

  // §5.5 (D3) — the pre-envKey cache tree (<base>/<userId>/<agentRef>/…, no env
  // level) is discarded once on the first bind after the update, then rebuilt
  // from the server. Env-scoped subtrees are never touched.
  describe('one-shot pre-envKey legacy tree wipe', () => {
    async function seedLegacyUserDir(userId: string, agentRef: string) {
      const agentDir = path.join(tmpBase, userId, agentRef)
      await fs.mkdir(agentDir, { recursive: true })
      await fs.writeFile(
        path.join(agentDir, 'index.json'),
        JSON.stringify({
          version: 2,
          chats: [],
          lastActiveChatId: null,
          onboardingDismissed: false,
        })
      )
    }

    it('drops the legacy per-user tree on first env-scoped bind', async () => {
      await seedLegacyUserDir('user-a', 'agent-x')
      await seedLegacyUserDir('user-b', 'agent-y')

      await bindChatStoreForUser('user-a', ENV_A)

      // Both legacy user dirs are gone; the env-scoped store is separate + empty.
      expect(await exists(path.join(tmpBase, 'user-a', 'agent-x'))).toBe(false)
      expect(await exists(path.join(tmpBase, 'user-b', 'agent-y'))).toBe(false)
      expect(await requireChatStore().listChats('agent-x')).toEqual([])
    })

    it('runs only once — a legacy dir re-created after the marker survives', async () => {
      await seedLegacyUserDir('user-a', 'agent-x')
      await bindChatStoreForUser('user-a', ENV_A)
      expect(await exists(path.join(tmpBase, 'user-a', 'agent-x'))).toBe(false)

      // Simulate a stray legacy-shaped dir appearing after migration; the marker
      // must prevent a second destructive sweep.
      await seedLegacyUserDir('user-c', 'agent-z')
      unbindChatStore()
      await bindChatStoreForUser('user-a', ENV_A)
      expect(await exists(path.join(tmpBase, 'user-c', 'agent-z'))).toBe(true)
    })

    it('never wipes an env-scoped subtree (index.json is one level deeper)', async () => {
      // Pre-seed env A with a real chat, then bind env B for the first time.
      await bindChatStoreForUser('user-a', ENV_A)
      await requireChatStore().createChat('agent-x', 'chat-a')
      unbindChatStore()

      // A fresh process would re-run the one-shot if the marker were missing;
      // simulate that by removing the marker before binding a different env.
      await fs.rm(path.join(tmpBase, '.env-scoped'), { force: true })
      await bindChatStoreForUser('user-a', ENV_B)

      // Env A's data is untouched — it lives at depth 3, not the legacy depth 2.
      await bindChatStoreForUser('user-a', ENV_A)
      expect((await requireChatStore().listChats('agent-x')).map(c => c.id)).toEqual(['chat-a'])
    })
  })
})
