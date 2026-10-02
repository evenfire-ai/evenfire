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
import type { SessionsListResult } from '../../../../../src/types'
import {
  HOST_ACCESS_REVOKED_CODE,
  HOST_ACCESS_REVOKED_MESSAGE,
} from '../../../../../src/upstreamErrors'
import { httpErrorStatus, isConfirmedHostAccessRevoked } from '../../../lib/format'
import { deferred, localIndex, serverSessions } from './__fixtures__/catalogFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import {
  ipcGenericForbidden,
  ipcHostAccessDenied,
  ipcHostAccessRevoked,
  ipcHostWaking,
  ipcHttpError,
  ipcServerErrorMentioning403,
  wrapLikeElectronIpc,
} from './__fixtures__/ipcErrors'
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

describe('HTTP status parsing through Electron IPC', () => {
  it.each([
    [
      "Error invoking remote method 'rpc:listSessions': Error: 403 Forbidden: host_access_revoked",
      403,
    ],
    ["Error invoking remote method 'rpc:listSessions': Error: 401 Unauthorized", 401],
    [
      "Error invoking remote method 'rpc:listSessions': Error: 503 Service Unavailable: upstream mentioned 403",
      503,
    ],
    ["Error invoking remote method 'rpc:invoke': Error: 403 Forbidden", 403],
    ['request to support-401 failed', undefined],
  ])('parses %s as %s', (message, expected) => {
    expect(httpErrorStatus(message)).toBe(expected)
  })

  // Electron never emits the wrapper without the quoted channel, so a
  // quote-less prefix is not stripped and no status is read through it.
  it('does not strip a wrapper that lacks the quoted channel Electron always emits', () => {
    expect(
      httpErrorStatus("Error invoking remote method 'rpc:listSessions': Error: 403 Forbidden")
    ).toBe(403)
    expect(httpErrorStatus('Error invoking remote method: Error: 403 Forbidden')).toBeUndefined()
  })

  // R2-B1 / NEW-dui-3: every shape the real producers emit, wrapped by IPC.
  it.each([
    ['listSessions revoked', () => ipcHostAccessRevoked('rpc:listSessions'), 403, true],
    [
      'loadSessionMessages revoked',
      () => ipcHostAccessRevoked('rpc:loadSessionMessages'),
      403,
      true,
    ],
    ['renameSession revoked', () => ipcHostAccessRevoked('rpc:renameSession'), 403, true],
    ['invokeHostMessage revoked', () => ipcHostAccessRevoked('rpc:invokeHostMessage'), 403, true],
    ['getTaskResult revoked', () => ipcHostAccessRevoked('rpc:getTaskResult'), 403, true],
    ['listSessions host_access_denied', () => ipcHostAccessDenied('rpc:listSessions'), 403, false],
    ['List sessions failed (403)', () => ipcGenericForbidden('rpc:listSessions'), 403, false],
    ['Rename session failed (403)', () => ipcGenericForbidden('rpc:renameSession'), 403, false],
    ['ApiError 403 Forbidden: …', () => ipcGenericForbidden('rpc:invokeHostMessage'), 403, false],
    [
      'ApiError 401 Unauthorized: …',
      () => ipcHttpError('rpc:getTaskResult', 401, 'Unauthorized', { error: 'expired' }),
      401,
      false,
    ],
    [
      'List sessions 503 body mentions 403',
      () => ipcServerErrorMentioning403('rpc:listSessions'),
      503,
      false,
    ],
    [
      'ApiError 503 body mentions 403',
      () => ipcServerErrorMentioning403('rpc:invokeHostMessage'),
      503,
      false,
    ],
    [
      'host_waking for support-401',
      async () => ipcHostWaking('rpc:invokeHostMessage', 'support-401'),
      undefined,
      false,
    ],
  ])('classifies the real %s', async (_label, build, status, revoked) => {
    const error = await build()
    expect(error.message).toMatch(/^Error invoking remote method 'rpc:[A-Za-z]+': Error: /)
    expect(httpErrorStatus(error)).toBe(status)
    expect(isConfirmedHostAccessRevoked(error)).toBe(revoked)
  })

  // R3-L16: only the upstream projection's exact text confirms a revocation.
  // No producer emits a rename-prefixed revocation, so that spelling is not
  // accepted either; every case still carries a parsed 403.
  it.each([
    ['the IPC-wrapped Host-wide revocation', HOST_ACCESS_REVOKED_MESSAGE, true],
    [
      'a rename-prefixed revocation no producer emits',
      `Rename session failed (403): ${HOST_ACCESS_REVOKED_CODE}`,
      false,
    ],
    ['the real generic rename denial', 'Rename session failed (403)', false],
  ])('confirms revocation only for %s', (_label, message, revoked) => {
    const error = wrapLikeElectronIpc('rpc:renameSession', new Error(message))
    expect(httpErrorStatus(error)).toBe(403)
    expect(isConfirmedHostAccessRevoked(error)).toBe(revoked)
  })
})

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
  it('filters held-host sessions from the sidebar while retaining them for recovery', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([]))
    clerum.rpc.listSessions.mockResolvedValue(
      serverSessions([{ agent: 'agent-a', chatId: 'cached-session', title: 'Private title' }])
    )
    const controller = renderController({
      selectedAgent: null,
      agentNames: ['agent-a'],
    })

    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(session => session.id)).toEqual([
        'cached-session',
      ])
    )

    controller.hostAuthority.hold('agent-a', 'uncertain')
    expect(controller.hostAuthority.isBlocked('agent-a')).toBe(true)
    expect(controller.result.current.latestChatSessions).toEqual([])

    controller.hostAuthority.release('agent-a')
    await waitFor(() =>
      expect(controller.result.current.latestChatSessions.map(session => session.id)).toEqual([
        'cached-session',
      ])
    )
  })

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
      await ipcHostAccessRevoked('rpc:loadSessionMessages')
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

  it.each([
    [
      'List sessions failed (401)',
      () => ipcHttpError('rpc:listSessions', 401, 'Unauthorized', { error: 'expired' }),
    ],
    ['List sessions failed (403)', () => ipcGenericForbidden('rpc:listSessions')],
    ['403 Forbidden: host_access_denied', () => ipcHostAccessDenied('rpc:listSessions')],
  ])(
    'holds the Host as uncertain after a generic %s survives the forced retry',
    async (_label, build) => {
      const revoked = new Set<string>()
      const uncertain = new Set<string>()
      clerum.chat.getIndex.mockResolvedValue(
        localIndex([{ id: 'protected-a', title: 'Cached protected chat' }])
      )
      clerum.rpc.listSessions.mockRejectedValue(await build())
      const { result } = renderController({
        selectedAgent: null,
        agentNames: ['agent-a'],
        onHostAccessRevoked: agentRef => revoked.add(agentRef),
        onHostAuthorityUncertain: agentRef => uncertain.add(agentRef),
        isHostAccessBlocked: agentRef => revoked.has(agentRef) || uncertain.has(agentRef),
      })

      await waitFor(() => expect(uncertain.has('agent-a')).toBe(true))
      expect(revoked.has('agent-a')).toBe(false)
      expect(clerum.rpc.listSessions).toHaveBeenCalledTimes(2)
      expect(result.current.latestChatSessions.some(chat => chat.id === 'protected-a')).toBe(false)
    }
  )

  it('revokes the Host on the first confirmed catalog denial without a forced retry', async () => {
    const revoked = new Set<string>()
    const uncertain = new Set<string>()
    clerum.chat.getIndex.mockResolvedValue(
      localIndex([{ id: 'protected-a', title: 'Cached protected chat' }])
    )
    clerum.rpc.listSessions.mockRejectedValue(await ipcHostAccessRevoked('rpc:listSessions'))
    const { result, spies } = renderController({
      selectedAgent: null,
      agentNames: ['agent-a'],
      onHostAccessRevoked: agentRef => revoked.add(agentRef),
      onHostAuthorityUncertain: agentRef => uncertain.add(agentRef),
      isHostAccessBlocked: agentRef => revoked.has(agentRef) || uncertain.has(agentRef),
    })

    await waitFor(() => expect(revoked.has('agent-a')).toBe(true))
    expect(uncertain.has('agent-a')).toBe(false)
    expect(clerum.rpc.listSessions).toHaveBeenCalledTimes(1)
    expect(result.current.latestChatSessions.some(chat => chat.id === 'protected-a')).toBe(false)
    expect(spies.pushToast).not.toHaveBeenCalledWith(expect.stringContaining('Chat list'), 'info')
  })

  it('keeps the selected agent and cached chat list after a 503 catalog failure', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'cached-a', title: 'Cached chat' }]))
    clerum.rpc.listSessions.mockRejectedValue(
      await ipcHttpError('rpc:listSessions', 503, 'Service Unavailable', {
        error: 'upstream unavailable',
      })
    )
    const controller = renderController({
      selectedAgent: 'agent-a',
      agentNames: ['agent-a'],
      // R2-L4: the toast names the Host the way the catalog displays it.
      agentDisplayName: agentRef => (agentRef === 'agent-a' ? 'Research Agent' : agentRef),
    })
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    await waitFor(() =>
      expect(controller.result.current.chatList.some(chat => chat.id === 'cached-a')).toBe(true)
    )
    expect(controller.hostAuthority.isBlocked('agent-a')).toBe(false)
    await waitFor(() => expect(controller.spies.pushToast).toHaveBeenCalledTimes(1))
    expect(controller.spies.pushToast).toHaveBeenCalledWith(
      'Chat list for Research Agent is offline. Showing saved chats.',
      'info'
    )
  })

  it('does not show the offline toast for a client-side catalog error', async () => {
    clerum.chat.getIndex.mockResolvedValue(localIndex([{ id: 'cached-a', title: 'Cached chat' }]))
    clerum.rpc.listSessions.mockRejectedValue(
      await ipcHttpError('rpc:listSessions', 400, 'Bad Request', { error: 'invalid cursor' })
    )
    const controller = renderController({
      selectedAgent: 'agent-a',
      agentNames: ['agent-a'],
    })

    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(controller.spies.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining('Chat list'),
      'info'
    )
  })

  // NEW-dui-2: every non-auth, non-429 client error ends the page chain.
  it.each([
    [400, 'Bad Request', { error: 'Invalid sessions cursor' }],
    [404, 'Not Found', { error: 'cursor session not found' }],
  ])('clears a rejected load-more cursor after a terminal %s', async (status, statusText, body) => {
    const rejection = await ipcHttpError('rpc:listSessions', status, statusText, body)
    clerum.rpc.listSessions.mockImplementation(
      async (_agentRef: string, _teamId: string | undefined, query?: { cursor?: string }) => {
        if (query?.cursor) throw rejection
        return serverSessions([{ agent: 'agent-x', chatId: 'remote-page-1' }], 'cursor-invalid')
      }
    )
    const controller = renderController()

    await waitFor(() => expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true))
    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })
    expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(false)

    // The cursor is gone: a second request never re-sends it.
    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })
    expect(
      clerum.rpc.listSessions.mock.calls.filter(
        call => (call[2] as { cursor?: string } | undefined)?.cursor === 'cursor-invalid'
      )
    ).toHaveLength(1)
    expect(controller.spies.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load more chats"),
      'info'
    )
  })

  // R3-L10: the main process validates the cursor before any request and throws
  // without an HTTP status (`ipc.ts` sanitizeSessionsListQuery). Re-sending the
  // same cursor repeats that refusal, so it ends the page chain like a 400.
  it('clears a load-more cursor the main process refuses without an HTTP status', async () => {
    const rejection = wrapLikeElectronIpc('rpc:listSessions', new Error('Invalid sessions cursor'))
    expect(httpErrorStatus(rejection)).toBeUndefined()
    clerum.rpc.listSessions.mockImplementation(
      async (_agentRef: string, _teamId: string | undefined, query?: { cursor?: string }) => {
        if (query?.cursor) throw rejection
        return serverSessions([{ agent: 'agent-x', chatId: 'remote-page-1' }], 'cursor-refused')
      }
    )
    const controller = renderController()

    await waitFor(() => expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true))
    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })
    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })

    // Witness: the refused cursor was sent exactly once.
    expect(
      clerum.rpc.listSessions.mock.calls.filter(
        call => (call[2] as { cursor?: string } | undefined)?.cursor === 'cursor-refused'
      )
    ).toHaveLength(1)
    expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(false)
    expect(controller.spies.pushToast).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load more chats"),
      'info'
    )
  })

  // NEW-dui-2: 408, 429 and 5xx keep the cursor, tell the user once per attempt
  // and never retry on their own. A 408 is retryable (RFC 9110 §15.5.9).
  it.each([
    [408, 'Request Timeout'],
    [429, 'Too Many Requests'],
    [503, 'Service Unavailable'],
  ])('preserves the load-more cursor after a retryable %s', async (status, statusText) => {
    const rejection = await ipcHttpError('rpc:listSessions', status, statusText, {
      error: 'try later',
    })
    clerum.rpc.listSessions.mockImplementation(
      async (_agentRef: string, _teamId: string | undefined, query?: { cursor?: string }) => {
        if (query?.cursor) throw rejection
        return serverSessions([{ agent: 'agent-x', chatId: 'remote-page-1' }], 'cursor-retryable')
      }
    )
    const controller = renderController({
      agentDisplayName: agentRef => (agentRef === 'agent-x' ? 'Agent X' : agentRef),
    })

    await waitFor(() => expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true))
    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })
    expect(controller.result.current.chatListHasMoreRemoteSessions).toBe(true)
    expect(controller.spies.pushToast).toHaveBeenCalledTimes(1)
    expect(controller.spies.pushToast).toHaveBeenCalledWith(
      "Couldn't load more chats for Agent X. Try again shortly.",
      'info'
    )

    await act(async () => {
      await controller.result.current.loadMoreChatSessions()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    // Exactly the two user-initiated attempts: no automatic retry loop.
    expect(
      clerum.rpc.listSessions.mock.calls.filter(
        call => (call[2] as { cursor?: string } | undefined)?.cursor === 'cursor-retryable'
      )
    ).toHaveLength(2)
    expect(controller.spies.pushToast).toHaveBeenCalledTimes(2)
  })
})

describe('host authority verification', () => {
  // R3-M3: the epoch negative and its same-epoch control share one IPC-shaped
  // revocation (never retried, so it reaches the classifier directly); the
  // control proves the denial holds the Host when the epoch does not advance.
  it.each([
    [
      'discards a pre-verification authorization denial after the host authority epoch advances',
      1,
      false,
    ],
    ['holds the Host on a catalog denial when the host authority epoch is unchanged', 0, true],
  ] as const)('%s', async (_label, epochAdvance, expectedRevoked) => {
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

    const denial = await ipcHostAccessRevoked('rpc:listSessions')
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled())
    hostAuthorityEpoch += epochAdvance
    rejectFirst(denial)
    await waitFor(() => expect(controller.result.current.latestChatSessionsLoading).toBe(false))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(revoked.has('agent-x')).toBe(expectedRevoked)
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
        clerum.rpc.loadSessionMessages.mockRejectedValue(
          await ipcHostAccessRevoked('rpc:loadSessionMessages')
        )
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
