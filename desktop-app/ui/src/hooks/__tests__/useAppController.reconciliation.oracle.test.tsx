// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import { ChatListContext } from '@contexts/ChatListContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { WorkspaceTabStrip } from '@components/WorkspaceTabStrip'
import { installAppControllerClerum } from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { useAppController } from '../useAppController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderController() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => ({ controller: useAppController(), tracker: useAgentTaskTracker() }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
      </QueryClientProvider>
    ),
  })
}

describe('useAppController reconciliation ownership oracle', () => {
  let tracker: ReturnType<typeof useAgentTaskTracker> | null = null

  afterEach(() => {
    tracker?.releaseAll()
    tracker = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('does not apply a pending old-team reconciliation after switching teams', async () => {
    const { clerum } = installAppControllerClerum()
    const app = renderController()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))
    let resolveSnapshot!: (value: {
      agent: string
      chatId: string
      state: 'processing'
      activeTaskId: string
      turns: []
    }) => void
    const pendingSnapshot = new Promise<{
      agent: string
      chatId: string
      state: 'processing'
      activeTaskId: string
      turns: []
    }>(resolve => {
      resolveSnapshot = resolve
    })
    clerum.rpc.loadSessionMessages.mockImplementationOnce(() => pendingSnapshot)
    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.controller.selectedAgent).toBe('agent-x'))
    let switchPromise!: Promise<void>
    act(() => {
      switchPromise = app.result.current.controller.handleSelectChat('team-a-reconcile-chat')
    })
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledOnce())

    await act(async () => {
      await app.result.current.controller.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.controller.currentTeamId).toBe('team-2'))
    const key = 'agent-x::team-a-reconcile-chat'
    // Capture the ownership boundary separately from the late RPC result. The
    // approved contract tears down Team A reconciliation state on the switch.
    const oldTeamStateAtSwitch = structuredClone(
      app.result.current.controller.sessionStateByChatKey[key]
    )

    resolveSnapshot({
      agent: 'agent-x',
      chatId: 'team-a-reconcile-chat',
      state: 'processing',
      activeTaskId: 'team-a-reconcile-task',
      turns: [],
    })
    await act(async () => {
      await switchPromise
    })
    const oldTeamStateAfterLateResult = structuredClone(
      app.result.current.controller.sessionStateByChatKey[key]
    )

    expect.soft(oldTeamStateAtSwitch).toBeUndefined()
    expect.soft(oldTeamStateAfterLateResult).toEqual(oldTeamStateAtSwitch)
    expect.soft(oldTeamStateAfterLateResult).toBeUndefined()
  })

  it('keeps Team B task state unchanged when a delayed Team A snapshot settles', async () => {
    const { clerum } = installAppControllerClerum()
    const app = renderController()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))

    let resolveTeamASnapshot!: (value: {
      agent: string
      chatId: string
      state: 'processing'
      activeTaskId: string
      turns: []
    }) => void
    const teamASnapshot = new Promise<{
      agent: string
      chatId: string
      state: 'processing'
      activeTaskId: string
      turns: []
    }>(resolve => {
      resolveTeamASnapshot = resolve
    })
    clerum.rpc.loadSessionMessages.mockImplementationOnce(() => teamASnapshot)

    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.controller.selectedAgent).toBe('agent-x'))

    let teamASwitchPromise!: Promise<void>
    act(() => {
      teamASwitchPromise = app.result.current.controller.handleSelectChat('team-a-late-chat')
    })
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledOnce())

    await act(async () => {
      await app.result.current.controller.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.controller.currentTeamId).toBe('team-2'))

    // A real Team B chat/task provides a clean target projection even though
    // the separate teardown regression currently leaves Team A state behind.
    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', {
        chatId: 'team-b-owned-chat',
        title: 'Team B task',
        selectLatest: false,
      })
    })
    await waitFor(() =>
      expect(app.result.current.controller.activeChatId).toBe('team-b-owned-chat')
    )
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'team-b-owned-task' })
    await act(async () => {
      await app.result.current.controller.handleSendAgentMessage('Team B task')
    })
    const teamBKey = 'agent-x::team-b-owned-chat'
    await waitFor(() =>
      expect(app.result.current.tracker.get(teamBKey)?.taskId).toBe('team-b-owned-task')
    )
    await waitFor(() =>
      expect(app.result.current.controller.sessionStateByChatKey[teamBKey]?.state).toBe(
        'processing'
      )
    )

    const renderTeamBTabStrip = () => {
      const controller = app.result.current.controller
      return (
        <ChatListContext.Provider
          value={{
            activeChatId: controller.activeChatId,
            chatList: controller.chatList,
            chatListLoading: controller.chatListLoading,
            latestChatSessions: controller.latestChatSessions,
            latestChatSessionsLoading: controller.latestChatSessionsLoading,
            sessionStateByChatId: controller.sessionStateByChatId,
            sessionStateByChatKey: controller.sessionStateByChatKey,
          }}
        >
          <WorkspaceTabStrip
            tabs={controller.workspaceTabs.tabs}
            activeTabId={controller.workspaceTabs.activeTabId}
            onSelect={() => undefined}
            onClose={() => undefined}
            onReorder={() => undefined}
          />
        </ChatListContext.Provider>
      )
    }
    const tabStrip = render(renderTeamBTabStrip())
    expect(tabStrip.getByRole('status', { name: 'Running' })).toBeTruthy()

    const teamBProjectionBefore = structuredClone({
      teamId: app.result.current.controller.currentTeamId,
      activeChatId: app.result.current.controller.activeChatId,
      selectedAgent: app.result.current.controller.selectedAgent,
      workspaceTabs: app.result.current.controller.workspaceTabs,
      sessionState: app.result.current.controller.sessionStateByChatKey[teamBKey],
      task: app.result.current.tracker.get(teamBKey),
      resend: app.result.current.tracker.getResend('team-b-owned-task'),
      progressByMessageId: app.result.current.controller.progressByMessageId,
      renderedBadge: tabStrip
        .queryByRole('status', { name: 'Running' })
        ?.getAttribute('aria-label'),
    })

    resolveTeamASnapshot({
      agent: 'agent-x',
      chatId: 'team-a-late-chat',
      state: 'processing',
      activeTaskId: 'team-a-late-task',
      turns: [],
    })
    await act(async () => {
      await teamASwitchPromise
    })
    tabStrip.rerender(renderTeamBTabStrip())

    expect(
      structuredClone({
        teamId: app.result.current.controller.currentTeamId,
        activeChatId: app.result.current.controller.activeChatId,
        selectedAgent: app.result.current.controller.selectedAgent,
        workspaceTabs: app.result.current.controller.workspaceTabs,
        sessionState: app.result.current.controller.sessionStateByChatKey[teamBKey],
        task: app.result.current.tracker.get(teamBKey),
        resend: app.result.current.tracker.getResend('team-b-owned-task'),
        progressByMessageId: app.result.current.controller.progressByMessageId,
        renderedBadge: tabStrip
          .queryByRole('status', { name: 'Running' })
          ?.getAttribute('aria-label'),
      })
    ).toEqual(teamBProjectionBefore)
  })
})
