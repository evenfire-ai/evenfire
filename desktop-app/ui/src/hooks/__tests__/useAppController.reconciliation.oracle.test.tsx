// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
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
    const teamStateBeforeLateSnapshot = structuredClone(
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

    expect(app.result.current.controller.sessionStateByChatKey[key]).toEqual(
      teamStateBeforeLateSnapshot
    )
  })
})
