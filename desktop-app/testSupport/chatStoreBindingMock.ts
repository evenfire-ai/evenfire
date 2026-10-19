import { vi } from 'vitest'

type MockChatAuthorityScope = {
  environmentKey: string
  userId: string
  teamId: string | null
}

/** A binding mock that exposes only the scope established by its producer. */
export function createChatStoreBindingMock() {
  let activeScope: MockChatAuthorityScope | null = null
  const mockStore = {
    getAuthorityScope: () => (activeScope ? { ...activeScope } : null),
  }

  return {
    bindChatStoreForUser: vi.fn(
      async (userId: string, environmentKey: string, options: { teamId?: string | null } = {}) => {
        activeScope = null
        activeScope = {
          environmentKey,
          userId,
          teamId: String(options.teamId ?? '').trim() || null,
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
    unbindChatStore: vi.fn(() => {
      activeScope = null
    }),
    __setChatStoreBaseDirForTests: vi.fn(),
    __resetChatStoreBindingForTests: () => {
      activeScope = null
    },
  }
}
