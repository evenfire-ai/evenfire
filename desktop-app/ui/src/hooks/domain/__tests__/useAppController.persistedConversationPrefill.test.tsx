// @vitest-environment jsdom
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  installAppControllerClerum,
  renderAppController,
} from '@hooks/domain/__tests__/__fixtures__/appControllerHarness'
import {
  deferred,
  serverSessionMessages,
  serverSessions,
} from '@hooks/domain/__tests__/__fixtures__/catalogFixtures'
import { ipcHostAccessRevoked } from '@hooks/domain/__tests__/__fixtures__/ipcErrors'
import { uninstallMockClerum } from '@hooks/domain/__tests__/__fixtures__/mockClerum'
import {
  clearLatestGfsConversationContext,
  getLatestGfsConversationContext,
} from '@lib/gfsConversationPrefill'
import {
  closeWorkspaceTab,
  openChatTab,
  openFilesTab,
  selectWorkspaceTab,
} from '@lib/workspaceTabs'
import type { SessionsListResult } from '../../../../../src/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const outputs: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const output of outputs.splice(0)) output.unmount()
  vi.restoreAllMocks()
  uninstallMockClerum()
  clearLatestGfsConversationContext()
})
async function mounted() {
  const { clerum } = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] })
  const app = renderAppController()
  outputs.push({ unmount: app.unmount })
  await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
  await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
  return { clerum, app }
}
async function holdHost(
  clerum: Awaited<ReturnType<typeof mounted>>['clerum'],
  app: Awaited<ReturnType<typeof mounted>>['app']
) {
  clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
  await act(async () => {
    await app.result.current.handleRenameChatForAgent('agent-x', 'chat-1', 'Renamed')
  })
  expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)
}
function sessions(items: Array<{ agent: string; chatId: string }>) {
  return serverSessions(items)
}
function publishResource(app: Awaited<ReturnType<typeof mounted>>['app']) {
  act(() => {
    app.result.current.setWorkspaceTabs(state =>
      openFilesTab(state, {
        id: 'files-u',
        path: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        title: 'Folder U',
      })
    )
  })
  expect(getLatestGfsConversationContext()).toEqual({
    uri: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceTabId: 'files-u',
  })
}

describe('r4 A6 real useAppController host-verification acceptance', () => {
  it('releases a held host after successful verification and loads the requested chat', async () => {
    const { clerum, app } = await mounted()
    await holdHost(clerum, app)
    const check = deferred<SessionsListResult>()
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? check.promise : sessions([])
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      await serverSessionMessages('agent-x', 'chat-1')
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-x', undefined, {
        agent: 'agent-x',
        limit: 1,
      })
    )
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)
    await act(async () => {
      check.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false))
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
  })

  it('keeps a revoked hold after verification rejection', async () => {
    const { clerum, app } = await mounted()
    await holdHost(clerum, app)
    clerum.rpc.listSessions.mockClear()
    clerum.rpc.listSessions
      .mockRejectedValueOnce(await ipcHostAccessRevoked('rpc:listSessions'))
      .mockResolvedValue(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-x', undefined, {
        agent: 'agent-x',
        limit: 1,
      })
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(
      clerum.rpc.listSessions.mock.calls.filter(([, , query]) => query?.limit === 1)
    ).toHaveLength(1)
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)
    expect(app.result.current.activeChatId).not.toBe('chat-1')
  })

  it('terminally retires a header receipt when the current chat switch fails', async () => {
    const { clerum, app } = await mounted()
    publishResource(app)
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
      })
    )
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat))

    const setLastActive = clerum.chat.setLastActive.getMockImplementation()!
    clerum.chat.setLastActive.mockImplementation((agentRef, chatId) =>
      agentRef === 'agent-x' && chatId === 'chat-2'
        ? Promise.reject(new Error('Conversation selection unavailable'))
        : setLastActive(agentRef, chatId)
    )
    await act(async () => {
      await app.result.current.handleOpenNotification({
        id: 'revoked-target',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'chat-2',
        teamId: 'team-1',
        text: 'Open the revoked conversation',
        timestamp: 2,
        read: false,
      } as Parameters<typeof app.result.current.handleOpenNotification>[0])
    })

    const receipt = app.result.current.persistedConversationPrefillReceipt
    expect(receipt).toMatchObject({
      chatId: 'chat-2',
      origin: 'header-conversation',
      status: 'terminally-cancelled',
    })
    expect(
      app.result.current.bindPersistedConversationPrefillDestination(receipt!.id, 'late-chat-tab')
    ).toBe(false)
    expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
      'terminally-cancelled'
    )
  })

  it('suppresses an older selection when a newer other-host selection wins', async () => {
    const { clerum, app } = await mounted()
    await holdHost(clerum, app)
    const check = deferred<SessionsListResult>()
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? check.promise : sessions([])
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      await serverSessionMessages('agent-y', 'chat-y')
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-x', undefined, {
        agent: 'agent-x',
        limit: 1,
      })
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-y', {
        chatId: 'chat-y',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-y'))
    await act(async () => {
      check.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(app.result.current.activeChatId).toBe('chat-y')
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false)
  })

  it('retires a suspended receipt when opening an Agent workspace changes the target', async () => {
    const { clerum, app } = await mounted()
    publishResource(app)
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      await serverSessionMessages('agent-x', 'chat-1')
    )
    act(() =>
      app.result.current.setWorkspaceTabs(state =>
        openChatTab(state, {
          id: 'chat-tab-c',
          agentRef: 'agent-x',
          chatId: 'chat-1',
          title: 'Conversation C',
        })
      )
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    const receiptId = app.result.current.persistedConversationPrefillReceipt?.id
    expect(receiptId).toBeDefined()

    act(() =>
      app.result.current.setWorkspaceTabs(state =>
        openFilesTab(state, {
          id: 'files-v',
          path: 'gfs://main/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          title: 'Folder V',
        })
      )
    )
    await waitFor(() =>
      expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
        'suspended-resource'
      )
    )

    act(() => app.result.current.handleOpenAgentWorkspace('agent-y'))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.agents))
    expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
      id: receiptId,
      status: 'terminally-cancelled',
    })

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.chat))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat))
    act(() =>
      app.result.current.setWorkspaceTabs(state =>
        openFilesTab(state, {
          id: 'files-u',
          path: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          title: 'Folder U',
        })
      )
    )
    await waitFor(() =>
      expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
        id: receiptId,
        status: 'terminally-cancelled',
      })
    )
  })

  it.each([
    ['newer verification first', [1, 0]],
    ['older verification first', [0, 1]],
  ])(
    'accepts only the newest same-host selection when verification completes %s',
    async (_label, order) => {
      const { clerum, app } = await mounted()
      await holdHost(clerum, app)
      const checks = [deferred<SessionsListResult>(), deferred<SessionsListResult>()]
      let reads = 0
      clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) => {
        if (query?.limit === 1) return checks[reads++]!.promise
        return sessions([])
      })
      clerum.rpc.loadSessionMessages.mockResolvedValue(
        await serverSessionMessages('agent-x', 'chat-2')
      )
      act(() =>
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-1',
          selectLatest: false,
          keepNavItem: true,
          activationOrigin: 'sidebar-session',
        })
      )
      act(() =>
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-2',
          selectLatest: false,
          keepNavItem: true,
          activationOrigin: 'sidebar-session',
        })
      )
      await waitFor(() => expect(reads).toBe(2))
      for (const index of order) {
        await act(async () => {
          checks[index]!.resolve(sessions([{ agent: 'agent-x', chatId: `chat-${index + 1}` }]))
          await checks[index]!.promise
        })
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
        })
      }
      expect({
        activeChatId: app.result.current.activeChatId,
        hostBlocked: app.result.current.isHostAccessBlocked('agent-x'),
      }).toEqual({ activeChatId: 'chat-2', hostBlocked: false })
    }
  )

  it('keeps a re-held host blocked when an older verification completes', async () => {
    const { clerum, app } = await mounted()
    await holdHost(clerum, app)
    const checks = [deferred<SessionsListResult>(), deferred<SessionsListResult>()]
    let reads = 0
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? checks[reads++]!.promise : sessions([])
    )
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      await serverSessionMessages('agent-x', 'chat-2')
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
      })
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-2',
        selectLatest: false,
        keepNavItem: true,
      })
    )
    await waitFor(() => expect(reads).toBe(2))

    await act(async () => {
      checks[1]!.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-2' }]))
      await checks[1]!.promise
    })
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalled())
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false)

    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    await act(async () => {
      await app.result.current.handleRenameChatForAgent('agent-x', 'chat-2', 'Re-hold')
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)

    await act(async () => {
      checks[0]!.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
      await checks[0]!.promise
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)
    expect(app.result.current.activeChatId).not.toBe('chat-1')
  })

  it('rejects the latest success when a new host hold appears between verifier completions', async () => {
    const { clerum, app } = await mounted()
    publishResource(app)
    await holdHost(clerum, app)
    const checks = [deferred<SessionsListResult>(), deferred<SessionsListResult>()]
    let reads = 0
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? checks[reads++]!.promise : sessions([])
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-2',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() => expect(reads).toBe(2))

    await act(async () => {
      checks[0]!.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
      await checks[0]!.promise
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(false)

    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    await act(async () => {
      await app.result.current.handleRenameChatForAgent('agent-x', 'chat-1', 'Re-hold')
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)

    await act(async () => {
      checks[1]!.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-2' }]))
      await checks[1]!.promise
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)
    expect(app.result.current.activeChatId).not.toBe('chat-2')
    expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
      chatId: 'chat-2',
      status: 'terminally-cancelled',
    })
  })

  it.each([
    ['old succeeds, latest rejects, old first', true, false, [0, 1]],
    ['old succeeds, latest rejects, latest first', true, false, [1, 0]],
    ['old rejects, latest succeeds, old first', false, true, [0, 1]],
    ['old rejects, latest succeeds, latest first', false, true, [1, 0]],
  ])(
    'does not borrow another same-host verification result (%s)',
    async (_label, oldSucceeds, latestSucceeds, order) => {
      const { clerum, app } = await mounted()
      publishResource(app)
      await holdHost(clerum, app)
      const checks = [deferred<SessionsListResult>(), deferred<SessionsListResult>()]
      let reads = 0
      clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
        query?.limit === 1 ? checks[reads++]!.promise : sessions([])
      )
      act(() =>
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-1',
          selectLatest: false,
          keepNavItem: true,
          activationOrigin: 'sidebar-session',
        })
      )
      act(() =>
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'chat-2',
          selectLatest: false,
          keepNavItem: true,
          activationOrigin: 'sidebar-session',
        })
      )
      await waitFor(() => expect(reads).toBe(2))

      for (const index of order as number[]) {
        const succeeds = index === 0 ? oldSucceeds : latestSucceeds
        await act(async () => {
          if (succeeds) {
            checks[index]!.resolve(
              sessions([{ agent: 'agent-x', chatId: index === 0 ? 'chat-1' : 'chat-2' }])
            )
            await checks[index]!.promise
          } else {
            checks[index]!.reject(await ipcHostAccessRevoked('rpc:listSessions'))
            await checks[index]!.promise.catch(() => undefined)
          }
        })
      }

      if (latestSucceeds) {
        await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-2'))
        expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
          chatId: 'chat-2',
          origin: 'sidebar-session',
          status: 'pending-ready',
        })
      } else {
        expect(app.result.current.activeChatId).not.toBe('chat-2')
        expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
          chatId: 'chat-2',
          status: 'terminally-cancelled',
        })
      }
    }
  )

  it('keeps the qualifying receipt current through a nonqualifying same-target focus', async () => {
    const { clerum, app } = await mounted()
    publishResource(app)
    await holdHost(clerum, app)
    const checks = [deferred<SessionsListResult>(), deferred<SessionsListResult>()]
    let reads = 0
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? checks[reads++]!.promise : sessions([])
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    const receiptId = app.result.current.persistedConversationPrefillReceipt?.id
    await waitFor(() => expect(reads).toBe(1))

    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
      })
    )
    await waitFor(() => expect(reads).toBe(2))
    expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
      id: receiptId,
      status: 'awaiting-authorization',
      origin: 'sidebar-session',
    })

    await act(async () => {
      checks[1]!.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
      await checks[1]!.promise
    })
    await act(async () => {
      checks[0]!.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
      await checks[0]!.promise
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
      id: receiptId,
      status: 'pending-ready',
      origin: 'sidebar-session',
    })
  })

  it('fences a successful held-host response after same-principal session replacement', async () => {
    const { clerum, app } = await mounted()
    publishResource(app)
    await holdHost(clerum, app)
    const verification = deferred<SessionsListResult>()
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? verification.promise : sessions([])
    )
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-x', undefined, {
        agent: 'agent-x',
        limit: 1,
      })
    )
    const previousScope = app.result.current.authorityScope
    const authBridge = clerum as unknown as {
      auth: {
        getSessionState: Mock<(...args: any[]) => any>
        getSessionGeneration: Mock<(...args: any[]) => any>
      }
    }
    authBridge.auth.getSessionState.mockResolvedValue({
      authenticated: true,
      me: { id: 'user-1', email: 'test@clerum.io', name: 'Test User', teamId: 'team-1' },
      sessionGeneration: 2,
    })
    authBridge.auth.getSessionGeneration.mockResolvedValue(2)
    await act(async () => {
      await app.result.current.loadSession({ preserveNav: true })
    })
    await waitFor(() => expect(app.result.current.sessionGeneration).toBe(2))
    expect(app.result.current.authorityScope).not.toBe(previousScope)
    expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
      'terminally-cancelled'
    )

    await act(async () => {
      verification.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
      await verification.promise
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(app.result.current.activeChatId).not.toBe('chat-1')
    expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
      'terminally-cancelled'
    )
  })

  it('binds an existing exact destination during verification and cannot revive it after close', async () => {
    const { clerum, app } = await mounted()
    publishResource(app)
    act(() => {
      const withDestination = openChatTab(app.result.current.workspaceTabs, {
        id: 'chat-destination',
        agentRef: 'agent-x',
        chatId: 'chat-1',
        title: 'Earlier chat',
      })
      app.result.current.setWorkspaceTabs(state =>
        selectWorkspaceTab(withDestination, state.activeTabId ?? 'files-u')
      )
    })
    await holdHost(clerum, app)
    const verification = deferred<SessionsListResult>()
    clerum.rpc.listSessions.mockImplementation(async (_host, _team, query) =>
      query?.limit === 1 ? verification.promise : sessions([])
    )

    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    )
    await waitFor(() =>
      expect(clerum.rpc.listSessions).toHaveBeenCalledWith('agent-x', undefined, {
        agent: 'agent-x',
        limit: 1,
      })
    )
    await waitFor(() =>
      expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
        'awaiting-authorization'
      )
    )
    const receiptId = app.result.current.persistedConversationPrefillReceipt?.id
    expect(receiptId).toBeDefined()
    let destinationBound = false
    act(() => {
      destinationBound = app.result.current.bindPersistedConversationPrefillDestination(
        receiptId!,
        'chat-destination'
      )
    })
    expect(destinationBound).toBe(true)
    expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
      id: receiptId,
      status: 'awaiting-authorization',
      destinationWorkspaceTabId: 'chat-destination',
    })

    act(() => {
      app.result.current.beginUserNavigationIntent()
      app.result.current.setWorkspaceTabs(state => closeWorkspaceTab(state, 'chat-destination'))
    })
    await waitFor(() =>
      expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
        'terminally-cancelled'
      )
    )
    await act(async () => {
      verification.resolve(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
      await verification.promise
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(app.result.current.activeChatId).not.toBe('chat-1')
    expect(app.result.current.persistedConversationPrefillReceipt).toMatchObject({
      id: receiptId,
      status: 'terminally-cancelled',
      destinationWorkspaceTabId: 'chat-destination',
    })
  })

  it('terminally fences a pending receipt when the session generation changes', async () => {
    const { clerum, app } = await mounted()
    clerum.rpc.listSessions.mockResolvedValue(sessions([{ agent: 'agent-x', chatId: 'chat-1' }]))
    clerum.rpc.loadSessionMessages.mockResolvedValue(
      await serverSessionMessages('agent-x', 'chat-1')
    )
    act(() => {
      app.result.current.setWorkspaceTabs(state =>
        openFilesTab(state, {
          id: 'files-u',
          path: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          title: 'Folder U',
        })
      )
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        selectLatest: false,
        keepNavItem: true,
        activationOrigin: 'sidebar-session',
      })
    })
    await waitFor(() =>
      expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe('pending-ready')
    )
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-1'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    const previousScope = app.result.current.authorityScope

    const authBridge = clerum as unknown as {
      auth: {
        getSessionState: Mock<(...args: any[]) => any>
        getSessionGeneration: Mock<(...args: any[]) => any>
      }
    }
    authBridge.auth.getSessionState.mockResolvedValue({
      authenticated: true,
      me: { id: 'user-1', email: 'test@clerum.io', name: 'Test User', teamId: 'team-1' },
      sessionGeneration: 2,
    })
    authBridge.auth.getSessionGeneration.mockResolvedValue(2)
    await act(async () => {
      await app.result.current.loadSession({ preserveNav: true })
    })

    await waitFor(() => expect(app.result.current.sessionGeneration).toBe(2))
    expect(app.result.current.authorityScope).not.toBe(previousScope)
    expect(app.result.current.persistedConversationPrefillReceipt?.status).toBe(
      'terminally-cancelled'
    )
    expect(app.result.current.activeChatId).toBe('chat-1')
  })
})
