import { vi } from 'vitest'

type MockChatAuthorityScope = {
  environmentKey: string
  userId: string
  teamId: string | null
}

/** A binding mock that exposes only the scope established by its producer. */
export function createChatStoreBindingMock() {
  let activeScope: MockChatAuthorityScope | null = null
  let bindingGeneration = 0
  const mockStore = {
    getAuthorityScope: () => (activeScope ? { ...activeScope } : null),
  }

  return {
    bindChatStoreForUser: vi.fn(
      async (userId: string, environmentKey: string, options: { teamId?: string | null } = {}) => {
        if (
          !activeScope ||
          activeScope.userId !== userId ||
          activeScope.environmentKey !== environmentKey
        )
          bindingGeneration += 1
        activeScope = null
        activeScope = {
          environmentKey,
          userId,
          teamId: String(options.teamId ?? '').trim() || null,
        }
      }
    ),
    prepareChatStoreBindingForUser: vi.fn(
      async (userId: string, environmentKey: string, options: { teamId?: string | null } = {}) => {
        const expectedGeneration = bindingGeneration
        const nextScope: MockChatAuthorityScope = {
          environmentKey,
          userId,
          teamId: String(options.teamId ?? '').trim() || null,
        }
        let state: 'prepared' | 'reserved' | 'published' | 'discarded' = 'prepared'
        const canPublish = () =>
          (state === 'prepared' || state === 'reserved') && bindingGeneration === expectedGeneration
        const reservePublication = () => {
          if (state !== 'prepared' || bindingGeneration !== expectedGeneration) return null
          state = 'reserved'
          return () => {
            state = 'published'
            activeScope = { ...nextScope }
            bindingGeneration += 1
            return bindingGeneration
          }
        }
        return {
          canPublish,
          reservePublication,
          publish() {
            const publishReserved = reservePublication()
            return publishReserved ? publishReserved() : null
          },
          afterPublication() {},
          discard() {
            if (state === 'prepared' || state === 'reserved') state = 'discarded'
          },
        }
      }
    ),
    requireChatStore: vi.fn(() => {
      if (!activeScope) throw new Error('Not authenticated')
      return mockStore
    }),
    getChatStore: vi.fn(() => {
      if (!activeScope) throw new Error('Not authenticated')
      return mockStore
    }),
    getChatStoreBindingGeneration: vi.fn(() => {
      if (!activeScope) throw new Error('Not authenticated')
      return bindingGeneration
    }),
    reserveBoundChatStoreTeamScope: vi.fn(
      (
        expectedGeneration: number,
        userId: string,
        environmentKey: string,
        teamId: string | null
      ) => {
        if (
          !activeScope ||
          bindingGeneration !== expectedGeneration ||
          activeScope.userId !== userId ||
          activeScope.environmentKey !== environmentKey
        )
          return null
        const storeScope = activeScope
        const nextTeamId = String(teamId || '').trim() || null
        return () => {
          storeScope.teamId = nextTeamId
          bindingGeneration += 1
          return bindingGeneration
        }
      }
    ),
    updateBoundChatStoreTeamScope: vi.fn(
      (
        expectedGeneration: number,
        userId: string,
        environmentKey: string,
        teamId: string | null
      ) => {
        if (
          !activeScope ||
          bindingGeneration !== expectedGeneration ||
          activeScope.userId !== userId ||
          activeScope.environmentKey !== environmentKey
        )
          return null
        activeScope.teamId = String(teamId || '').trim() || null
        bindingGeneration += 1
        return bindingGeneration
      }
    ),
    unbindChatStore: vi.fn(() => {
      activeScope = null
      bindingGeneration += 1
    }),
    __setChatStoreBaseDirForTests: vi.fn(),
    __resetChatStoreBindingForTests: () => {
      activeScope = null
      bindingGeneration += 1
    },
  }
}
