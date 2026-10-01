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

  it('releases the home-team pin once the hop completes so the store follows the session again', async () => {
    const service = signedInService(['team-b', 'team-a', 'team-c'])
    const internals = service as unknown as {
      bindCurrentChatStore(userId: string): Promise<void>
      runWithTeamContext<T>(teamId: string, op: (token: string) => Promise<T>): Promise<T>
      switchSessionToTeam(teamId: string): Promise<string>
      chatStoreTeamId(): string | null
      me: { teamId: string }
    }
    await internals.bindCurrentChatStore('user-1')

    const during: { sessionTeam?: string; chatStoreTeam?: string | null } = {}
    await internals.runWithTeamContext('team-b', async () => {
      during.sessionTeam = internals.me.teamId
      during.chatStoreTeam = internals.chatStoreTeamId()
    })

    // Liveness witness: the pin was really held during the hop (the session was on
    // team-b while the store team stayed on team-a) and the hop restored team-a.
    expect(during).toEqual({ sessionTeam: 'team-b', chatStoreTeam: 'team-a' })
    expect(internals.me.teamId).toBe('team-a')
    expect(internals.chatStoreTeamId()).toBe('team-a')

    // A genuine team switch after the hop: the store team follows `me.teamId`, it
    // is not stuck on the team the finished hop was pinned to.
    await internals.switchSessionToTeam('team-c')

    expect(internals.me.teamId).toBe('team-c')
    expect(internals.chatStoreTeamId()).toBe('team-c')
    expect(requireChatStore().getAuthorityScope()?.teamId).toBe('team-c')
    expect(service.getChatDeletionFenceAuthority().authorityScope.teamId).toBe('team-c')
  })

  describe('when the switch back to the home team fails', () => {
    type HopInternals = {
      bindCurrentChatStore(userId: string): Promise<void>
      runWithTeamContext<T>(teamId: string, op: (token: string) => Promise<T>): Promise<T>
      me: { teamId: string }
    }

    /** team-a service whose auth client accepts the hop to team-b and refuses the way back. */
    function serviceFailingToRestore(): { service: AppService; internals: HopInternals } {
      const service = signedInService(['team-b'])
      const authClient = (service as unknown as { authClient: { switchTeam: unknown } }).authClient
      authClient.switchTeam = vi.fn(async (_token: string, teamId: string) => {
        if (teamId === 'team-a') throw new Error('network down')
        return { token: `${teamId}-token`, team: { id: teamId, name: teamId, role: 'member' } }
      })
      return { service, internals: service as unknown as HopInternals }
    }

    it('rebinds the store to the team the session is really on so the delete fence still matches', async () => {
      const { service, internals } = serviceFailingToRestore()
      await internals.bindCurrentChatStore('user-1')
      const store = requireChatStore()
      await store.createChat('agent-1', 'c1')

      const during: { store?: string | null; fence?: string | null } = {}
      await expect(
        internals.runWithTeamContext('team-b', async () => {
          during.store = store.getAuthorityScope()?.teamId
          during.fence = service.getChatDeletionFenceAuthority().authorityScope.teamId
          return 'done'
        })
      ).rejects.toThrow('network down')

      // Liveness witness: the hop really happened (store and fence stayed on
      // team-a while the operation ran) and the switch back really failed
      // (the session is left on team-b).
      expect(during).toEqual({ store: 'team-a', fence: 'team-a' })
      expect(internals.me.teamId).toBe('team-b')
      // The pin is gone and the store follows the session again.
      const fence = service.getChatDeletionFenceAuthority()
      expect(fence.authorityScope.teamId).toBe('team-b')
      expect(requireChatStore().getAuthorityScope()?.teamId).toBe('team-b')
      // A deletion authorized by that fence is accepted instead of throwing
      // "Chat authority scope changed".
      await requireChatStore().createChat('agent-1', 'c2')
      await requireChatStore().deleteChat('agent-1', 'c2', fence.authorityScope)
      expect(await requireChatStore().loadMessages('agent-1', 'c2')).toEqual([])
    })

    it('logs a failed rebind and keeps the error of the failed operation', async () => {
      const { internals } = serviceFailingToRestore()
      await internals.bindCurrentChatStore('user-1')
      const realBind = internals.bindCurrentChatStore.bind(internals)
      let hopFinished = false
      const rebindAttempts: string[] = []
      internals.bindCurrentChatStore = vi.fn(async (userId: string) => {
        if (!hopFinished) return realBind(userId)
        rebindAttempts.push(userId)
        throw new Error('rebind exploded')
      })
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        await expect(
          internals.runWithTeamContext('team-b', async () => {
            hopFinished = true
            throw new Error('operation failed')
          })
        ).rejects.toThrow('operation failed')

        // Liveness witness: the rebind ran and failed, and it was reported.
        expect(rebindAttempts).toEqual(['user-1'])
        expect(errorLog).toHaveBeenCalledWith(
          expect.stringContaining('Failed to rebind the chat store'),
          expect.objectContaining({ message: 'rebind exploded' })
        )
      } finally {
        errorLog.mockRestore()
      }
    })
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
