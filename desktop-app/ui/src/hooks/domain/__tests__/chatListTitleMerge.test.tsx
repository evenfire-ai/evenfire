// @vitest-environment jsdom
/**
 * spec 15 §2.2 — the session-title precedence merge, asserted through the
 * observable sidebar output (pr-discipline T4: assert the title the user sees,
 * not an intermediate effect). Covers cases A–D of the decision table for the
 * agent-scoped chat list, plus the cross-agent "Latest sessions" placeholder.
 *
 * T1: the server-side `listSessions` payloads are run through the REAL wire
 * parser (`parseSessionsListResult`) before being handed to the IPC mock, so the
 * fixtures are derived from the producer instead of hand-built parsed shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { act, waitFor } from '@testing-library/react'
import { parseSessionsListResult } from '../../../../../src/rpcProxyClient'
import type { ChatIndex, SessionsListResult } from '../../../../../src/types'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

const NOW = '2026-09-12T00:00:00.000Z'

/** Parse a raw wire payload through the real producer parser (T1). */
function serverSessions(
  items: Array<{ agent: string; chatId: string; title?: string }>
): SessionsListResult {
  return parseSessionsListResult({
    items: items.map(i => ({
      agent: i.agent,
      chatId: i.chatId,
      turnCount: 1,
      lastActivityAt: NOW,
      ...(i.title !== undefined ? { title: i.title } : {}),
    })),
  })
}

function localIndex(
  chats: Array<{ id: string; title: string }>,
  deletedChatIds: string[] = []
): ChatIndex {
  const authorityScope = { environmentKey: 'env-test', userId: 'unknown-user', teamId: 'team-1' }
  return {
    version: 1,
    lastActiveChatId: null,
    onboardingDismissed: false,
    chats: chats.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: NOW,
      updatedAt: NOW,
      messageCount: 0,
    })),
    deletedChatIds,
    deletedChatTombstones: deletedChatIds.map(chatId => ({ chatId, authorityScope })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => {
    resolve = finish
  })
  return { promise, resolve }
}

describe('chat list title merge (spec 15 §2.2, cases A–D)', () => {
  it('case A: server-only session with a title shows the server title (no placeholder)', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-a', title: 'Deploy staging' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() =>
      expect(result.current.chatList.find(c => c.id === 'chat-a')?.title).toBe('Deploy staging')
    )
  })

  it('case B: server-only session with no title shows the "Chat <id>" placeholder', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-bcdef012345' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() =>
      expect(result.current.chatList.find(c => c.id === 'chat-bcdef012345')?.title).toBe(
        'Chat chat-bcd'
      )
    )
  })

  it('case C: cached session + server title -> server wins (picks up a rename from another device)', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'chat-c', title: 'old local name' }]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-c', title: 'renamed on device B' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    await waitFor(() =>
      expect(result.current.chatList.find(c => c.id === 'chat-c')?.title).toBe(
        'renamed on device B'
      )
    )
  })

  it('case D: cached session + server sends no title -> local fallback survives', async () => {
    clerum.chat.getIndex.mockResolvedValue(
      localIndex([{ id: 'chat-d', title: 'my local only name' }])
    )
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-x', chatId: 'chat-d' }])
    )

    const { result } = renderController({ selectedAgent: 'agent-x', agentNames: ['agent-x'] })

    // Wait until the server catalog has been merged (the entry is present), then
    // confirm the local title was NOT clobbered by a placeholder.
    await waitFor(() => expect(result.current.chatList.some(c => c.id === 'chat-d')).toBe(true))
    expect(result.current.chatList.find(c => c.id === 'chat-d')?.title).toBe('my local only name')
  })
})

describe('cross-agent "Latest sessions" title merge (spec 15 §2.2)', () => {
  it('case A: server title on a cross-agent session replaces the "Remote ·" placeholder', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? serverSessions([{ agent: 'agent-y', chatId: 'chat-y', title: 'Cross-device title' }])
        : serverSessions([])
    )

    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
    })

    await waitFor(() =>
      expect(
        result.current.latestChatSessions.find(s => s.agentRef === 'agent-y' && s.id === 'chat-y')
          ?.title
      ).toBe('Cross-device title')
    )
  })

  it('case B: no server title on a cross-agent session shows the "Remote ·" placeholder', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? serverSessions([{ agent: 'agent-y', chatId: 'chat-yabcdef01' }])
        : serverSessions([])
    )

    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
    })

    await waitFor(() =>
      expect(
        result.current.latestChatSessions.find(
          s => s.agentRef === 'agent-y' && s.id === 'chat-yabcdef01'
        )?.title
      ).toBe('Remote · chat-yab')
    )
  })
})

describe('confirmed deletion catalog protection', () => {
  it('keeps a deleted session out of selected-agent and cross-agent catalogs after reload', async () => {
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? localIndex([], ['deleted-y'])
        : localIndex([{ id: 'kept-x', title: 'Kept chat' }], ['deleted-x'])
    )
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? serverSessions([{ agent: 'agent-y', chatId: 'deleted-y' }])
        : serverSessions([
            { agent: 'agent-x', chatId: 'deleted-x' },
            { agent: 'agent-x', chatId: 'kept-x' },
          ])
    )

    const { result } = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
    })
    await waitFor(() => expect(result.current.chatList.map(chat => chat.id)).toEqual(['kept-x']))
    await waitFor(() => expect(result.current.latestChatSessionsLoading).toBe(false))
    expect(result.current.latestChatSessions.map(session => session.id)).not.toContain('deleted-x')
    expect(result.current.latestChatSessions.map(session => session.id)).not.toContain('deleted-y')
  })
})

describe('revoked host catalog protection', () => {
  it('hides a nonselected host after 403 and blocks direct reselection', async () => {
    const blocked = new Set<string>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockImplementation(async (agentRef: string) =>
      agentRef === 'agent-y'
        ? serverSessions([{ agent: 'agent-y', chatId: 'protected-y' }])
        : serverSessions([])
    )
    const controller = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x', 'agent-y'],
      onHostAccessRevoked: agentRef => blocked.add(agentRef),
      onHostAuthorityUncertain: agentRef => blocked.add(agentRef),
      isHostAccessBlocked: agentRef => blocked.has(agentRef),
    })
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.some(s => s.id === 'protected-y')).toBe(
        true
      )
    )

    clerum.rpc.loadSessionMessages.mockRejectedValue(
      new Error('403 forbidden: host_access_revoked')
    )
    await expect(
      controller.result.current.reconcileChat(makeTaskKey('agent-y', 'protected-y'), {
        reason: 'background_refresh',
      })
    ).resolves.toBe('revoked')
    expect(blocked.has('agent-y')).toBe(true)
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.some(s => s.id === 'protected-y')).toBe(
        false
      )
    )

    await controller.result.current.switchToChat('agent-y', 'protected-y')
    expect(controller.result.current.activeChatId).toBeNull()
    expect(clerum.chat.loadMessages).not.toHaveBeenCalledWith(
      'agent-y',
      'protected-y',
      expect.anything()
    )
  })

  it.each([401, 403])(
    'hides cached sessions when the catalog returns an uncertain %i',
    async status => {
      const blocked = new Set<string>()
      clerum.chat.getIndex.mockResolvedValue(
        localIndex([{ id: 'protected-a', title: 'Cached protected chat' }])
      )
      clerum.rpc.listSessions.mockRejectedValue(new Error(`${status} forbidden`))
      const { result } = renderController({
        selectedAgent: null,
        agentNames: ['agent-a'],
        onHostAccessRevoked: agentRef => blocked.add(agentRef),
        onHostAuthorityUncertain: agentRef => blocked.add(agentRef),
        isHostAccessBlocked: agentRef => blocked.has(agentRef),
      })

      await waitFor(() => expect(blocked.has('agent-a')).toBe(true))
      expect(result.current.latestChatSessions.some(chat => chat.agentRef === 'agent-a')).toBe(
        false
      )
    }
  )

  it('retains cached sessions when a 503 body merely mentions 403', async () => {
    const blocked = new Set<string>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'cached-a', title: 'Cached chat' }]))
    clerum.rpc.listSessions.mockRejectedValue(
      new Error('503 Service Unavailable: upstream body mentioned 403')
    )
    const { result } = renderController({
      selectedAgent: null,
      agentNames: ['agent-a'],
      onHostAccessRevoked: agentRef => blocked.add(agentRef),
      onHostAuthorityUncertain: agentRef => blocked.add(agentRef),
      isHostAccessBlocked: agentRef => blocked.has(agentRef),
    })
    await waitFor(() =>
      expect(result.current.latestChatSessions.some(chat => chat.id === 'cached-a')).toBe(true)
    )
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    expect(blocked.has('agent-a')).toBe(false)
    expect(result.current.latestChatSessions.some(chat => chat.id === 'cached-a')).toBe(true)
  })
})

describe('host authority verification', () => {
  it('discards a pre-verification authorization denial after the host authority epoch advances', async () => {
    let hostAuthorityEpoch = 0
    const revoked = new Set<string>()
    const uncertain = new Set<string>()
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    let rejectFirst!: (reason: unknown) => void
    let firstCatalogRead = true
    clerum.rpc.listSessions.mockImplementation(() => {
      if (!firstCatalogRead) return Promise.resolve(serverSessions([]))
      firstCatalogRead = false
      return new Promise((_resolve, reject) => {
        rejectFirst = reject
      })
    })

    const controller = renderController({
      selectedAgent: 'agent-x',
      agentNames: ['agent-x'],
      onHostAccessRevoked: agentRef => revoked.add(agentRef),
      onHostAuthorityUncertain: agentRef => uncertain.add(agentRef),
      isHostAccessBlocked: agentRef => revoked.has(agentRef) || uncertain.has(agentRef),
      getHostAuthorityEpoch: () => hostAuthorityEpoch,
    })

    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    hostAuthorityEpoch += 1
    rejectFirst(new Error('403 stale'))
    await waitFor(() => expect(controller.result.current.latestChatSessionsLoading).toBe(false))
    expect(revoked.has('agent-x')).toBe(false)
    expect(uncertain.has('agent-x')).toBe(false)
  })
})

describe('late global catalog response', () => {
  it.each(['revocation', 'confirmed deletion'])(
    'does not republish Host A after %s while Host B is pending',
    async action => {
      const blocked = new Set<string>()
      const deliveredA = deferred<void>()
      const pendingB = deferred<SessionsListResult>()
      clerum.chat.getIndex.mockResolvedValue(localIndex([]))
      clerum.rpc.listSessions.mockImplementation(async (agentRef: string) => {
        if (agentRef === 'agent-a') {
          deliveredA.resolve()
          return serverSessions([{ agent: 'agent-a', chatId: 'session-a' }])
        }
        return pendingB.promise
      })
      const controller = renderController({
        selectedAgent: null,
        agentNames: ['agent-a', 'agent-b'],
        onHostAccessRevoked: agentRef => blocked.add(agentRef),
        onHostAuthorityUncertain: agentRef => blocked.add(agentRef),
        isHostAccessBlocked: agentRef => blocked.has(agentRef),
      })
      await deliveredA.promise
      await waitFor(() =>
        expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-b', undefined, {
          agent: 'agent-b',
          limit: 50,
        })
      )

      if (action === 'revocation') {
        clerum.rpc.loadSessionMessages.mockRejectedValue(new Error('403 forbidden'))
        await act(async () => {
          await controller.result.current.reconcileChat(makeTaskKey('agent-a', 'session-a'), {
            reason: 'background_refresh',
          })
        })
        expect(blocked.has('agent-a')).toBe(true)
      } else {
        await act(async () => {
          const deletion = await controller.result.current.captureChatDeleteFence('agent-a')
          await controller.result.current.handleDeleteChatForAgent('agent-a', 'session-a', deletion)
        })
        expect(clerum.chat.delete).toHaveBeenCalledWith(
          'agent-a',
          'session-a',
          expect.objectContaining({ version: 1, bindingGeneration: 1 })
        )
      }

      await act(async () => {
        pendingB.resolve(serverSessions([{ agent: 'agent-b', chatId: 'session-b' }]))
        await pendingB.promise
      })
      await waitFor(() =>
        expect(
          controller.result.current.latestChatSessions.some(chat => chat.id === 'session-b')
        ).toBe(true)
      )
      expect(
        controller.result.current.latestChatSessions.some(chat => chat.id === 'session-a')
      ).toBe(false)
    }
  )
})
