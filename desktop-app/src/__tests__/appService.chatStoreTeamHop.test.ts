/**
 * A transient `runWithTeamContext` hop installs another team's token (and `me`)
 * for the duration of one operation and then restores the original team. The
 * chat store scope and the delete-fence authority must NOT follow that hop: a
 * confirmed deletion is bound to the store's scope, and a store rebound to the
 * hop team would accept a late append to a chat the user already deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import {
  __setChatStoreBaseDirForTests,
  requireChatStore,
  unbindChatStore,
} from '../chatStoreBinding.js'
import type { ChatMessage } from '../types.js'

let base: string

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-store-team-hop-'))
  __setChatStoreBaseDirForTests(base)
})

afterEach(async () => {
  unbindChatStore()
  __setChatStoreBaseDirForTests(null)
  await fs.rm(base, { recursive: true, force: true })
})

const member = (teamId: string) => ({
  id: 'user-1',
  email: 'user@example.test',
  name: 'Test User',
  picture: null,
  teamId,
  teamName: teamId,
  role: 'member',
})

/** An AppService signed in on team-a whose auth client answers team switches. */
function signedInService(getMeAnswers: string[]): AppService {
  const service = new AppService() as unknown as Record<string, unknown>
  service.sessionToken = 'team-a-token'
  service.me = member('team-a')
  const getMe = vi.fn()
  for (const teamId of getMeAnswers) getMe.mockResolvedValueOnce(member(teamId))
  service.authClient = {
    getMe,
    switchTeam: vi.fn(async (_token: string, teamId: string) => ({
      token: `${teamId}-token`,
      team: { id: teamId, name: teamId, role: 'member' },
    })),
  }
  service.tokenStore = { setSessionToken: vi.fn() }
  return service as unknown as AppService
}

const lateMessage = (): ChatMessage => ({
  id: 'late',
  role: 'user',
  content: 'late append',
  timestamp: Date.now(),
})

describe('chat store scope across a transient team hop', () => {
  it('keeps the store scope and the delete authority on the home team for the whole hop', async () => {
    const service = signedInService(['team-b', 'team-a'])
    const internals = service as unknown as {
      bindCurrentChatStore(userId: string): Promise<void>
      runWithTeamContext<T>(teamId: string, op: (token: string) => Promise<T>): Promise<T>
      me: { teamId: string }
    }
    await internals.bindCurrentChatStore('user-1')
    const store = requireChatStore()
    const fence = service.getChatDeletionFenceAuthority()
    await store.createChat('agent-1', 'c1')
    await store.deleteChat('agent-1', 'c1', fence.authorityScope)
    // Liveness witness: the deletion took effect in team-a.
    expect(await store.loadMessages('agent-1', 'c1')).toEqual([])

    const during: { sessionTeam?: string; store?: unknown; fence?: unknown; loaded?: string[] } = {}
    await internals.runWithTeamContext('team-b', async () => {
      during.sessionTeam = internals.me.teamId
      during.store = store.getAuthorityScope()
      during.fence = service.getChatDeletionFenceAuthority().authorityScope
      await store.appendMessages('agent-1', 'c1', [lateMessage()])
      during.loaded = (await store.loadMessages('agent-1', 'c1')).map(m => m.id)
    })

    // Liveness witness: the session really was on team-b during the operation.
    expect(during.sessionTeam).toBe('team-b')
    expect(during.store).toMatchObject({ userId: 'user-1', teamId: 'team-a' })
    expect(during.fence).toMatchObject({ userId: 'user-1', teamId: 'team-a' })
    // The late append to the deleted chat was rejected, not stored.
    expect(during.loaded).toEqual([])
    // Restored: same team, and the chat is still gone.
    expect(internals.me.teamId).toBe('team-a')
    expect(store.getAuthorityScope()?.teamId).toBe('team-a')
    expect(service.getChatDeletionFenceAuthority().authorityScope.teamId).toBe('team-a')
    expect(await store.loadMessages('agent-1', 'c1')).toEqual([])
  })

  it('still rebinds the store when the team changes without a restoring hop', async () => {
    const service = signedInService(['team-b'])
    const internals = service as unknown as {
      bindCurrentChatStore(userId: string): Promise<void>
      switchSessionToTeam(teamId: string): Promise<string>
    }
    await internals.bindCurrentChatStore('user-1')
    expect(requireChatStore().getAuthorityScope()?.teamId).toBe('team-a')

    await internals.switchSessionToTeam('team-b')

    expect(requireChatStore().getAuthorityScope()?.teamId).toBe('team-b')
    expect(service.getChatDeletionFenceAuthority().authorityScope.teamId).toBe('team-b')
  })
})
