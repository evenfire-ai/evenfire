// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { NOTIFICATION_SETTINGS_STORAGE_KEY } from '@constants/notificationSettings'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  deferred,
  localIndex,
  serverSessions,
} from '../domain/__tests__/__fixtures__/catalogFixtures'
import { ipcHostAccessRevoked } from '../domain/__tests__/__fixtures__/ipcErrors'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('notification selection after deferred host verification', () => {
  let unmount: (() => void) | null = null

  afterEach(async () => {
    unmount?.()
    unmount = null
    await new Promise(resolve => setTimeout(resolve, 20))
    uninstallMockClerum()
  })

  it('preserves a later explicit drawer selection when notification verification resolves', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] })
    await clerum.chat.create('agent-x', 'chat-x')
    await clerum.chat.create('agent-x', 'notification-chat-x')
    await clerum.chat.create('agent-y', 'chat-y')
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      localIndex(
        agentRef === 'agent-x'
          ? [
              { id: 'chat-x', title: 'Agent X chat' },
              { id: 'notification-chat-x', title: 'Notification chat' },
            ]
          : [{ id: 'chat-y', title: 'Agent Y chat' }]
      )
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, agentRef: string, chatId: string) => ({
        agent: agentRef,
        chatId,
        turns: [],
      })
    )

    const verification = deferred<ReturnType<typeof serverSessions>>()
    const verificationStarted = deferred<void>()
    clerum.rpc.listSessions.mockImplementation(
      async (hostRef: string, _teamId: string | undefined, query?: { limit?: number }) => {
        if (hostRef === 'agent-x' && query?.limit === 1) {
          verificationStarted.resolve()
          return verification.promise
        }
        return serverSessions([])
      }
    )

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-x',
        selectLatest: false,
      })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-x'))
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.apps))

    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    await act(async () => {
      await app.result.current.handleRenameChatForAgent('agent-x', 'chat-x', 'Renamed')
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)

    let notificationOpen!: Promise<void>
    act(() => {
      const notificationIntentSequence = app.result.current.beginUserNavigationIntent()
      notificationOpen = app.result.current.handleOpenNotification(
        {
          id: 'notification-x',
          kind: 'assistant_reply',
          agentName: 'agent-x',
          chatId: 'notification-chat-x',
          teamId: 'team-1',
          text: 'Agent X replied',
          timestamp: Date.now(),
          read: false,
        },
        { keepNavItem: true, navigationIntentSequence: notificationIntentSequence }
      )
    })
    await act(async () => verificationStarted.promise)

    act(() => {
      // App's drawer selection wrapper advances the shared navigation owner
      // before it delegates the new chat selection to the controller.
      app.result.current.beginUserNavigationIntent()
      app.result.current.handleSelectChatAgent('agent-y', {
        chatId: 'chat-y',
        title: 'Newer explicit selection',
        selectLatest: false,
        keepNavItem: true,
      })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-y'))

    await act(async () => {
      verification.resolve(serverSessions([{ agent: 'agent-x', chatId: 'notification-chat-x' }]))
      await notificationOpen
    })

    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-y'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    expect(app.result.current.activeChatId).toBe('chat-y')
    expect(app.result.current.selectedAgent).toBe('agent-y')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('preserves a later Files route when full-screen notification verification resolves', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-x')
    await clerum.chat.create('agent-x', 'notification-chat-x')
    clerum.chat.getIndex.mockImplementation(async () =>
      localIndex([
        { id: 'chat-x', title: 'Agent X chat' },
        { id: 'notification-chat-x', title: 'Notification chat' },
      ])
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, agentRef: string, chatId: string) => ({
        agent: agentRef,
        chatId,
        turns: [],
      })
    )

    const verification = deferred<ReturnType<typeof serverSessions>>()
    const verificationStarted = deferred<void>()
    clerum.rpc.listSessions.mockImplementation(
      async (hostRef: string, _teamId: string | undefined, query?: { limit?: number }) => {
        if (hostRef === 'agent-x' && query?.limit === 1) {
          verificationStarted.resolve()
          return verification.promise
        }
        return serverSessions([])
      }
    )

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-x',
        selectLatest: false,
      })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-x'))
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.apps))

    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    await act(async () => {
      await app.result.current.handleRenameChatForAgent('agent-x', 'chat-x', 'Renamed')
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)

    let notificationOpen!: Promise<void>
    act(() => {
      notificationOpen = app.result.current.handleOpenNotification({
        id: 'notification-x',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'notification-chat-x',
        teamId: 'team-1',
        text: 'Agent X replied',
        timestamp: Date.now(),
        read: false,
      })
    })
    await act(async () => verificationStarted.promise)

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files))
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.kind).toBe('files')

    await act(async () => {
      verification.resolve(serverSessions([{ agent: 'agent-x', chatId: 'notification-chat-x' }]))
      await notificationOpen
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.kind).toBe('files')
  })

  it('keeps the newer drawer notification after an older verification finishes last', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] })
    await clerum.chat.create('agent-x', 'chat-x')
    await clerum.chat.create('agent-x', 'notification-chat-x')
    await clerum.chat.create('agent-y', 'chat-y')
    await clerum.chat.create('agent-y', 'notification-chat-y')
    clerum.chat.getIndex.mockImplementation(async (agentRef: string) =>
      localIndex(
        agentRef === 'agent-x'
          ? [
              { id: 'chat-x', title: 'Agent X chat' },
              { id: 'notification-chat-x', title: 'Agent X notification' },
            ]
          : [
              { id: 'chat-y', title: 'Agent Y chat' },
              { id: 'notification-chat-y', title: 'Agent Y notification' },
            ]
      )
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, agentRef: string, chatId: string) => ({
        agent: agentRef,
        chatId,
        turns: [],
      })
    )

    const verifications = new Map([
      ['agent-x', deferred<ReturnType<typeof serverSessions>>()],
      ['agent-y', deferred<ReturnType<typeof serverSessions>>()],
    ])
    const verificationStarted = new Map([
      ['agent-x', deferred<void>()],
      ['agent-y', deferred<void>()],
    ])
    clerum.rpc.listSessions.mockImplementation(
      async (hostRef: string, _teamId: string | undefined, query?: { limit?: number }) => {
        if (query?.limit === 1 && verifications.has(hostRef)) {
          verificationStarted.get(hostRef)?.resolve()
          return verifications.get(hostRef)!.promise
        }
        return serverSessions([])
      }
    )

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-x',
        selectLatest: false,
      })
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-x'))
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.apps))

    clerum.rpc.renameSession.mockRejectedValue(await ipcHostAccessRevoked('rpc:renameSession'))
    await act(async () => {
      await app.result.current.handleRenameChatForAgent('agent-x', 'chat-x', 'Renamed X')
      await app.result.current.handleRenameChatForAgent('agent-y', 'chat-y', 'Renamed Y')
    })
    expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true)
    expect(app.result.current.isHostAccessBlocked('agent-y')).toBe(true)

    let olderNotification!: Promise<void>
    let newerNotification!: Promise<void>
    act(() => {
      olderNotification = app.result.current.handleOpenNotification({
        id: 'older-notification',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'notification-chat-x',
        teamId: 'team-1',
        text: 'Older notification',
        timestamp: Date.now(),
        read: false,
      })
    })
    await act(async () => verificationStarted.get('agent-x')!.promise)
    act(() => {
      newerNotification = app.result.current.handleOpenNotification(
        {
          id: 'newer-notification',
          kind: 'assistant_reply',
          agentName: 'agent-y',
          chatId: 'notification-chat-y',
          teamId: 'team-1',
          text: 'Newer notification',
          timestamp: Date.now() + 1,
          read: false,
        },
        { keepNavItem: true }
      )
    })
    await act(async () => verificationStarted.get('agent-y')!.promise)

    await act(async () => {
      verifications
        .get('agent-y')!
        .resolve(serverSessions([{ agent: 'agent-y', chatId: 'notification-chat-y' }]))
      await newerNotification
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe('notification-chat-y'))

    await act(async () => {
      verifications
        .get('agent-x')!
        .resolve(serverSessions([{ agent: 'agent-x', chatId: 'notification-chat-x' }]))
      await olderNotification
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
    expect(app.result.current.selectedAgent).toBe('agent-y')
    expect(app.result.current.activeChatId).toBe('notification-chat-y')
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.kind).toBe('chat')
  })

  it('lets an in-flight cross-team switch finish without activating stale Chat', async () => {
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    const switchResult = deferred<{ authenticated: true; me: typeof HARNESS_ME }>()
    handle.switchTeam.mockImplementation(async () => switchResult.promise)

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    let notificationOpen!: Promise<void>
    act(() => {
      notificationOpen = app.result.current.handleOpenNotification({
        id: 'cross-team-notification',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'cross-team-chat',
        teamId: 'team-2',
        text: 'Cross-team notification',
        timestamp: Date.now(),
        read: false,
      })
    })
    await waitFor(() => expect(handle.switchTeam).toHaveBeenCalledWith('team-2'))

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files))

    await act(async () => {
      switchResult.resolve({
        authenticated: true,
        me: { ...HARNESS_ME, teamId: 'team-2', teamName: 'Team 2' },
      })
      await notificationOpen
    })

    expect(app.result.current.currentTeamId).toBe('team-2')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.kind).toBe('files')
  })

  it('preserves a newer same-team notification after an older cross-team switch settles', async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'same-team-chat')
    await clerum.chat.create('agent-x', 'cross-team-chat')
    const firstSwitch = deferred<{ authenticated: true; me: typeof HARNESS_ME }>()
    handle.switchTeam.mockImplementation(async (teamId: string) => {
      if (teamId === 'team-2') return firstSwitch.promise
      return { authenticated: true, me: { ...HARNESS_ME, teamId, teamName: teamId } }
    })

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.apps))

    let olderNotification!: Promise<void>
    act(() => {
      olderNotification = app.result.current.handleOpenNotification({
        id: 'older-cross-team',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'cross-team-chat',
        teamId: 'team-2',
        text: 'Older cross-team notification',
        timestamp: Date.now(),
        read: false,
      })
    })
    await waitFor(() => expect(handle.switchTeam).toHaveBeenCalledWith('team-2'))

    let newerNotification!: Promise<void>
    act(() => {
      newerNotification = app.result.current.handleOpenNotification(
        {
          id: 'newer-same-team',
          kind: 'assistant_reply',
          agentName: 'agent-x',
          chatId: 'same-team-chat',
          teamId: 'team-1',
          text: 'Newer same-team notification',
          timestamp: Date.now(),
          read: false,
        },
        { keepNavItem: true }
      )
    })
    expect(handle.switchTeam).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstSwitch.resolve({
        authenticated: true,
        me: { ...HARNESS_ME, teamId: 'team-2', teamName: 'Team 2' },
      })
      await Promise.all([olderNotification, newerNotification])
    })

    await waitFor(() => expect(app.result.current.activeChatId).toBe('same-team-chat'))
    expect(app.result.current.currentTeamId).toBe('team-1')
    expect(handle.switchTeam.mock.calls.map(([teamId]) => teamId)).toEqual(['team-2', 'team-1'])
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps)
  })

  it('opens a cross-team notification when no newer user intent supersedes it', async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'cross-team-chat')
    clerum.chat.getIndex.mockImplementation(async () =>
      localIndex([{ id: 'cross-team-chat', title: 'Cross-team chat' }])
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, agentRef: string, chatId: string) => ({
        agent: agentRef,
        chatId,
        turns: [],
      })
    )

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    await act(async () => {
      await app.result.current.handleOpenNotification({
        id: 'cross-team-notification',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'cross-team-chat',
        teamId: 'team-2',
        text: 'Cross-team notification',
        timestamp: Date.now(),
        read: false,
      })
    })

    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))
    await waitFor(() => expect(app.result.current.activeChatId).toBe('cross-team-chat'))
    expect(handle.switchTeam).toHaveBeenCalledExactlyOnceWith('team-2')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)).toMatchObject({
      kind: 'chat',
      chat: { agentRef: 'agent-x', chatId: 'cross-team-chat' },
    })
  })

  it('cancels pending App work before a native reply notification enters controller navigation', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'native-notification-chat')
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'native-notification-task' })
    clerum.rpc.getTaskResult.mockResolvedValue({ response: 'A desktop reply' })
    const previousNotificationSettings = window.localStorage.getItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY
    )
    window.localStorage.setItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY,
      JSON.stringify({ inApp: 'always', desktop: 'always', soundVolume: 0 })
    )

    const notificationBridge = window.clerum.notifications
    let notificationId: string | null = null
    let clickHandler: ((event: { id: string }) => void) | null = null
    const originalShow = notificationBridge.show
    const originalOnClick = notificationBridge.onClick
    notificationBridge.show = vi.fn(async payload => {
      notificationId = payload.id
      return { supported: true, id: payload.id }
    })
    notificationBridge.onClick = callback => {
      clickHandler = callback
      return vi.fn()
    }

    const originalNotification = Object.getOwnPropertyDescriptor(window, 'Notification')
    class GrantedNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted' as NotificationPermission
      constructor(_title: string, _options?: NotificationOptions) {}
      close() {}
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: GrantedNotification,
    })

    const cancellationIntents: number[] = []
    let intentAtNativeClick = -1
    const app = renderAppController({
      onBeforeNativeAgentConversationNotification: () => {
        cancellationIntents.push(intentAtNativeClick)
      },
    })
    unmount = app.unmount
    try {
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      act(() => {
        app.result.current.handleSelectChatAgent('agent-x', {
          chatId: 'native-notification-chat',
          selectLatest: false,
        })
        app.result.current.handleNavSelect(DESKTOP_ROUTES.files)
      })
      const sendPromise = app.result.current.handleSendAgentMessage('Create a reply')
      await waitFor(() => expect(clerum.hasProgressHandler('native-notification-task')).toBe(true))
      await act(async () => {
        clerum.emitTaskProgress('native-notification-task', {
          type: 'open',
          taskId: 'native-notification-task',
          hostRef: 'agent-x',
        })
        clerum.emitTaskProgress('native-notification-task', {
          type: 'terminal',
          data: { taskId: 'native-notification-task', status: 'completed' },
        })
        await sendPromise
      })
      await waitFor(() => expect(notificationBridge.show).toHaveBeenCalledTimes(1))
      expect(notificationId).toBeTruthy()
      expect(clickHandler).toBeTypeOf('function')
      expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)

      intentAtNativeClick = app.result.current.navigationIntentSequence
      act(() => clickHandler?.({ id: notificationId! }))

      expect(cancellationIntents).toEqual([intentAtNativeClick])
      await waitFor(() =>
        expect(activeWorkspaceTab(app.result.current.workspaceTabs)).toMatchObject({
          kind: 'chat',
          chat: { agentRef: 'agent-x', chatId: 'native-notification-chat' },
        })
      )
      expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
      expect(app.result.current.navigationIntentSequence).toBeGreaterThan(intentAtNativeClick)
    } finally {
      notificationBridge.show = originalShow
      notificationBridge.onClick = originalOnClick
      if (previousNotificationSettings === null) {
        window.localStorage.removeItem(NOTIFICATION_SETTINGS_STORAGE_KEY)
      } else {
        window.localStorage.setItem(NOTIFICATION_SETTINGS_STORAGE_KEY, previousNotificationSettings)
      }
      if (originalNotification) {
        Object.defineProperty(window, 'Notification', originalNotification)
      } else {
        Reflect.deleteProperty(window, 'Notification')
      }
    }
  })

  it('suppresses stale cross-team switch failure feedback after a newer Files selection', async () => {
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    const switchResult = deferred<never>()
    handle.switchTeam.mockImplementation(async () => switchResult.promise)

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    const previousStatus = app.result.current.statusText

    let notificationOpen!: Promise<void>
    act(() => {
      notificationOpen = app.result.current.handleOpenNotification({
        id: 'failing-cross-team',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'cross-team-chat',
        teamId: 'team-2',
        text: 'Cross-team notification',
        timestamp: Date.now(),
        read: false,
      })
    })
    await waitFor(() => expect(handle.switchTeam).toHaveBeenCalledWith('team-2'))
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files))

    await act(async () => {
      switchResult.reject(new Error('network down'))
      await notificationOpen
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(app.result.current.statusText).toBe(previousStatus)
  })

  it('reports current cross-team notification switch failures', async () => {
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    handle.switchTeam.mockRejectedValue(new Error('network down'))

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    await act(async () => {
      await app.result.current.handleOpenNotification({
        id: 'current-cross-team-failure',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'cross-team-chat',
        teamId: 'team-2',
        text: 'Cross-team notification',
        timestamp: Date.now(),
        read: false,
      })
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)
    expect(app.result.current.statusText).toContain('Could not open notification: network down')
  })

  it('suppresses a stale full-screen chat-load failure after a newer Files route', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-x')
    await clerum.chat.create('agent-x', 'notification-chat-x')
    clerum.chat.getIndex.mockImplementation(async () =>
      localIndex([
        { id: 'chat-x', title: 'Agent X chat' },
        { id: 'notification-chat-x', title: 'Notification chat' },
      ])
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, agentRef: string, chatId: string) => ({
        agent: agentRef,
        chatId,
        turns: [],
      })
    )

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-x',
        selectLatest: false,
      })
    )
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-x'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))

    let rejectLastActive!: (error: Error) => void
    const lastActiveWrite = new Promise<void>((_resolve, reject) => {
      rejectLastActive = reject
    })
    clerum.chat.setLastActive.mockImplementation(async () => lastActiveWrite)
    const previousStatus = app.result.current.statusText
    let notificationOpen!: Promise<void>
    act(() => {
      notificationOpen = app.result.current.handleOpenNotification({
        id: 'full-screen-failing-chat-load',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'notification-chat-x',
        teamId: 'team-1',
        text: 'Agent X replied',
        timestamp: Date.now(),
        read: false,
      })
    })
    await waitFor(() =>
      expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'notification-chat-x')
    )

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files))
    await act(async () => {
      rejectLastActive(new Error('chat storage unavailable'))
      await notificationOpen
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(app.result.current.statusText).toBe(previousStatus)
  })

  it('suppresses a stale drawer chat-load failure after a newer Files route', async () => {
    const { clerum } = installAppControllerClerum({ agentNames: ['agent-x'] })
    await clerum.chat.create('agent-x', 'chat-x')
    await clerum.chat.create('agent-x', 'notification-chat-x')
    clerum.chat.getIndex.mockImplementation(async () =>
      localIndex([
        { id: 'chat-x', title: 'Agent X chat' },
        { id: 'notification-chat-x', title: 'Notification chat' },
      ])
    )
    clerum.rpc.loadSessionMessages.mockImplementation(
      async (_hostRef: string, agentRef: string, chatId: string) => ({
        agent: agentRef,
        chatId,
        turns: [],
      })
    )

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() =>
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-x',
        selectLatest: false,
      })
    )
    await waitFor(() => expect(app.result.current.activeChatId).toBe('chat-x'))
    await waitFor(() => expect(app.result.current.chatMessagesLoading).toBe(false))
    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.apps))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.apps))

    let rejectLastActive!: (error: Error) => void
    const lastActiveWrite = new Promise<void>((_resolve, reject) => {
      rejectLastActive = reject
    })
    clerum.chat.setLastActive.mockImplementation(async () => lastActiveWrite)
    const previousStatus = app.result.current.statusText
    let notificationOpen!: Promise<void>
    act(() => {
      const navigationIntentSequence = app.result.current.beginUserNavigationIntent()
      notificationOpen = app.result.current.handleOpenNotification(
        {
          id: 'drawer-failing-chat-load',
          kind: 'assistant_reply',
          agentName: 'agent-x',
          chatId: 'notification-chat-x',
          teamId: 'team-1',
          text: 'Agent X replied',
          timestamp: Date.now(),
          read: false,
        },
        { keepNavItem: true, navigationIntentSequence }
      )
    })
    await waitFor(() =>
      expect(clerum.chat.setLastActive).toHaveBeenCalledWith('agent-x', 'notification-chat-x')
    )

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files))
    await act(async () => {
      rejectLastActive(new Error('chat storage unavailable'))
      await notificationOpen
    })

    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(app.result.current.statusText).toBe(previousStatus)
  })

  it('skips a queued cross-team switch after a newer Files selection', async () => {
    const { handle } = installAppControllerClerum({ agentNames: ['agent-x'] })
    const firstSwitch = deferred<{ authenticated: true; me: typeof HARNESS_ME }>()
    handle.switchTeam.mockImplementation(async (teamId: string) => {
      if (teamId === 'team-2') return firstSwitch.promise
      return { authenticated: true, me: { ...HARNESS_ME, teamId, teamName: teamId } }
    })

    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    let userTeamSwitch!: Promise<boolean>
    act(() => {
      userTeamSwitch = app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(handle.switchTeam).toHaveBeenCalledWith('team-2'))

    let notificationOpen!: Promise<void>
    act(() => {
      notificationOpen = app.result.current.handleOpenNotification({
        id: 'queued-cross-team-notification',
        kind: 'assistant_reply',
        agentName: 'agent-x',
        chatId: 'queued-cross-team-chat',
        teamId: 'team-3',
        text: 'Queued cross-team notification',
        timestamp: Date.now(),
        read: false,
      })
    })

    act(() => app.result.current.handleNavSelect(DESKTOP_ROUTES.files))
    await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files))

    await act(async () => {
      firstSwitch.resolve({
        authenticated: true,
        me: { ...HARNESS_ME, teamId: 'team-2', teamName: 'Team 2' },
      })
      await userTeamSwitch
      await notificationOpen
    })

    expect(handle.switchTeam).toHaveBeenCalledTimes(1)
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(app.result.current.currentTeamId).toBe('team-2')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
  })
})
