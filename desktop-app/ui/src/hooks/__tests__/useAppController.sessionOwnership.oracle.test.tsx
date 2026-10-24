// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  HARNESS_ME,
  installAppControllerClerum,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { useAppController } from '../useAppController'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function installCoordinatorHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AgentTaskTrackerProvider>{children}</AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  return renderHook(() => ({ controller: useAppController(), tracker: useAgentTaskTracker() }), {
    wrapper,
  })
}

describe('useAppController session ownership oracle', () => {
  let tracker: ReturnType<typeof useAgentTaskTracker> | null = null

  afterEach(() => {
    tracker?.releaseAll()
    tracker = null
    vi.restoreAllMocks()
    uninstallMockClerum()
    resetComposerDraftStore()
  })

  it('tears down old-team task ownership while preserving same-principal tabs and drafts', async () => {
    const { clerum, handle } = installAppControllerClerum()
    const app = installCoordinatorHarness()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', {
        chatId: 'team-a-chat',
        title: 'Team A conversation',
        selectLatest: false,
      })
    })
    await waitFor(() => expect(app.result.current.controller.activeChatId).toBe('team-a-chat'))
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'team-a-task' })
    await act(async () => {
      await app.result.current.controller.handleSendAgentMessage('team scoped task')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('team-a-task')).toBe(true))
    const key = 'agent-x::team-a-chat'
    await waitFor(() =>
      expect(app.result.current.controller.sessionStateByChatKey[key]?.state).toBe('processing')
    )

    act(() =>
      app.result.current.controller.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    )
    const before = app.result.current.controller.workspaceTabs
    const chatTab = before.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'team-a-chat'
    )
    expect(chatTab?.kind).toBe('chat')
    if (chatTab?.kind !== 'chat') throw new Error('expected the producer-created chat tab')
    expect(setComposerDraft('team-a-chat', 'keep this draft', 'agent-x', chatTab.id)).toBe(true)

    expect(app.result.current.tracker.get(key)?.taskId).toBe('team-a-task')
    expect(app.result.current.tracker.getResend('team-a-task')).toBeTruthy()

    await act(async () => {
      await app.result.current.controller.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.controller.currentTeamId).toBe('team-2'))

    // The team is a data scope: tabs and drafts survive, team-owned task state does not.
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(app.result.current.controller.workspaceTabs).toEqual(before)
    expect(activeWorkspaceTab(app.result.current.controller.workspaceTabs)?.id).toBe(
      before.activeTabId
    )
    expect(getComposerDraft('team-a-chat', 'agent-x', chatTab.id)).toBe('keep this draft')
    expect.soft(app.result.current.tracker.get(key)).toBeUndefined()
    expect.soft(app.result.current.tracker.getResend('team-a-task')).toBeUndefined()
    expect.soft(app.result.current.controller.sessionStateByChatKey[key]).toBeUndefined()
    expect.soft(clerum.hasProgressHandler('team-a-task')).toBe(false)
  })

  it('does not apply an old-team reconciliation result after switching teams', async () => {
    const { clerum } = installAppControllerClerum()
    const app = installCoordinatorHarness()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))
    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', {
        chatId: 'team-a-reconcile-chat',
        title: 'Team A reconciliation',
        selectLatest: false,
      })
    })
    await waitFor(() =>
      expect(app.result.current.controller.activeChatId).toBe('team-a-reconcile-chat')
    )
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'team-a-reconcile-task' })
    await act(async () => {
      await app.result.current.controller.handleSendAgentMessage('reconcile after stream loss')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('team-a-reconcile-task')).toBe(true))

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
    clerum.rpc.loadSessionMessages.mockClear()
    clerum.rpc.loadSessionMessages.mockImplementationOnce(() => pendingSnapshot)
    await act(async () => {
      clerum.emitTaskProgress('team-a-reconcile-task', {
        type: 'error',
        message: 'progress stream dropped',
      })
    })
    await waitFor(() => expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledOnce())

    await act(async () => {
      await app.result.current.controller.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    await waitFor(() => expect(app.result.current.controller.currentTeamId).toBe('team-2'))
    const key = 'agent-x::team-a-reconcile-chat'
    expect.soft(app.result.current.controller.sessionStateByChatKey[key]).toBeUndefined()
    expect.soft(app.result.current.tracker.get(key)).toBeUndefined()
    expect.soft(clerum.hasProgressHandler('team-a-reconcile-task')).toBe(false)

    resolveSnapshot({
      agent: 'agent-x',
      chatId: 'team-a-reconcile-chat',
      state: 'processing',
      activeTaskId: 'team-a-reconcile-task',
      turns: [],
    })
    await act(async () => pendingSnapshot)

    expect.soft(app.result.current.controller.sessionStateByChatKey[key]).toBeUndefined()
    expect.soft(app.result.current.tracker.get(key)).toBeUndefined()
    expect.soft(clerum.hasProgressHandler('team-a-reconcile-task')).toBe(false)
  })

  it('does not carry the prior principal workspace through A → null → B', async () => {
    const { handle } = installAppControllerClerum()
    const app = installCoordinatorHarness()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))
    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', {
        chatId: 'principal-a-chat',
        title: 'Principal A conversation',
        selectLatest: false,
      })
      app.result.current.controller.openFilesSection('gfs://main/fedcba9876543210fedcba9876543210')
    })
    const priorWorkspace = app.result.current.controller.workspaceTabs
    expect(app.result.current.controller.selectedAgent).toBe('agent-x')
    expect(priorWorkspace.tabs.some(tab => tab.kind === 'files')).toBe(true)

    handle.getSessionState
      .mockResolvedValueOnce({ authenticated: false, me: null })
      .mockResolvedValueOnce({
        authenticated: true,
        me: {
          ...HARNESS_ME,
          id: 'user-b',
          email: 'user-b@example.test',
          teamId: 'team-b',
          teamName: 'Team B',
        },
      })

    await act(async () => {
      await app.result.current.controller.loadSession()
    })
    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(false))

    await act(async () => {
      await app.result.current.controller.loadSession()
    })
    await waitFor(() => expect(app.result.current.controller.currentTeamId).toBe('team-b'))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))

    expect(app.result.current.controller.selectedAgent).toBeNull()
    expect(app.result.current.controller.workspaceTabs).not.toEqual(priorWorkspace)
    expect(app.result.current.controller.workspaceTabs.tabs).not.toContainEqual(
      expect.objectContaining({ kind: 'files' })
    )
  })
})
