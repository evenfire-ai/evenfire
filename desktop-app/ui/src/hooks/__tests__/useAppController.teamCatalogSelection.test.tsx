// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatActionsProvider } from '@contexts/AgentChatActionsContext'
import type { AgentChatActionsContextValue } from '@contexts/AgentChatActionsContext'
import { AuthContext } from '@contexts/AuthContext'
import type { AuthContextValue } from '@contexts/AuthContext'
import { ChatComposerStateProvider } from '@contexts/ChatComposerStateContext'
import type { ChatComposerStateContextValue } from '@contexts/ChatComposerStateContext'
import { McpRuntimeProvider } from '@contexts/McpRuntimeContext'
import { NavigationContext } from '@contexts/NavigationContext'
import type { NavigationContextValue } from '@contexts/NavigationContext'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComposerPanel } from '@components/agents/ComposerPanel'
import type { AccessCatalog } from '../../../../src/types'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '../domain/queryKeys'

vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => ({ visualSendBlocked: false, imageBlockMessage: null }),
}))
vi.mock('@components/agents/ModelSelector', () => ({ ModelSelector: () => null }))

const emptyComposerState: ChatComposerStateContextValue = {
  composerImageAttachments: [],
  composerFileAttachments: [],
  composerFileRefusals: [],
  composerReferenceAttachments: [],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: null,
  workspaceChatTabId: null,
  activeMessageCount: 0,
  composerFocusRequestId: 0,
  requestComposerFocus: vi.fn(),
}

function controllerComposerElement(
  app: ReturnType<typeof renderAppController>,
  send: AgentChatActionsContextValue['handleSendAgentMessage'] = app.result.current
    .handleSendAgentMessage
) {
  const view = app.result.current
  const noOp = () => undefined
  const authValue = {
    isAuthenticated: view.isAuthenticated,
    me: view.me,
  } as AuthContextValue
  const navigationValue = {
    navItem: view.navItem,
    selectedAgent: view.selectedAgent,
    selectedAgentRoute: view.selectedAgentRoute,
    handleNavSelect: noOp,
    handleOpenAgentWorkspace: noOp,
    handleSelectChatAgent: noOp,
    handleBackToAgents: noOp,
  } as NavigationContextValue
  const actionValue = {
    clearComposerSendError: noOp,
    handleSendAgentMessage: send,
  } as AgentChatActionsContextValue
  const runtimeValue = {
    hostRuntimeStatus: null,
    hostRuntimeLoading: false,
    hostRuntimeError: null,
    hostRuntimeLastUpdatedAt: null,
    hostRuntimeIsStale: false,
    activeLlmModel: null,
    activeLlmProvider: null,
    mcpHealthRefreshing: false,
    handleRefreshMcpHealth: async () => undefined,
    cancelTask: async () => undefined,
  }

  return (
    <QueryClientProvider client={app.queryClient}>
      <AuthContext.Provider value={authValue}>
        <NavigationContext.Provider value={navigationValue}>
          <AgentChatActionsProvider value={actionValue}>
            <ChatComposerStateProvider value={emptyComposerState}>
              <McpRuntimeProvider value={runtimeValue}>
                <ComposerPanel inline />
              </McpRuntimeProvider>
            </ChatComposerStateProvider>
          </AgentChatActionsProvider>
        </NavigationContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>
  )
}

function renderControllerComposer(app: ReturnType<typeof renderAppController>) {
  return render(controllerComposerElement(app))
}

function productionCatalog(teamId: string, agentName: string): AccessCatalog {
  return {
    userId: HARNESS_ME.id,
    teamId,
    userContextIds: [],
    userAgentNames: [],
    teamContextIds: [],
    teamAgentNames: [agentName],
    contextIds: [],
    agentNames: [agentName],
    mcpServersByAgent: {},
    agentContextByName: { [agentName]: null },
    agentProviderByName: { [agentName]: null },
    agentDisplayByName: { [agentName]: agentName },
  }
}

describe('useAppController team-scoped catalog selection', () => {
  let unmount: (() => void) | undefined
  let unmountPanel: (() => void) | undefined

  afterEach(() => {
    cleanup()
    unmountPanel?.()
    unmountPanel = undefined
    unmount?.()
    unmount = undefined
    uninstallMockClerum()
  })

  it('keeps a team-A-only agent selected through a successful same-principal switch', async () => {
    installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    let currentTeamId = 'team-a'
    Object.assign(window.clerum.team, {
      switch: vi.fn(async (teamId: string) => {
        currentTeamId = teamId
        return {
          authenticated: true,
          me: { ...HARNESS_ME, teamId, teamName: teamId === 'team-a' ? 'Team A' : 'Team B' },
        }
      }),
    })
    Object.assign(window.clerum.access, {
      refreshCatalog: vi.fn(async () =>
        currentTeamId === 'team-a'
          ? productionCatalog('team-a', 'team-a-only-agent')
          : productionCatalog('team-b', 'team-b-only-agent')
      ),
    })

    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() =>
      expect(
        app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamAgentNames
      ).toEqual(['team-a-only-agent'])
    )
    act(() => {
      app.result.current.handleSelectChatAgent('team-a-only-agent', {
        chatId: 'team-a-chat',
        title: 'Team A conversation',
        selectLatest: false,
      })
    })
    expect(app.result.current.selectedAgent).toBe('team-a-only-agent')

    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-b' })
    })

    await waitFor(() =>
      expect(
        app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamId
      ).toBe('team-b')
    )
    expect(app.result.current.currentTeamId).toBe('team-b')
    expect(
      app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamAgentNames
    ).toEqual(['team-b-only-agent'])
    expect(app.result.current.selectedAgent).toBe('team-a-only-agent')
  })

  it.each(['team.switch', 'same-principal loadSession'] as const)(
    'blocks the retained unavailable agent after %s until an agent in Team B is selected',
    async transition => {
      const { handle } = installAppControllerClerum({
        me: { teamId: 'team-a', teamName: 'Team A' },
        teamDirectory: { items: [], currentTeamId: 'team-a' },
      })
      let currentTeamId = 'team-a'
      Object.assign(window.clerum.team, {
        switch: vi.fn(async (teamId: string) => {
          currentTeamId = teamId
          return {
            authenticated: true,
            me: { ...HARNESS_ME, teamId, teamName: teamId === 'team-a' ? 'Team A' : 'Team B' },
          }
        }),
      })
      Object.assign(window.clerum.access, {
        refreshCatalog: vi.fn(async () =>
          currentTeamId === 'team-a'
            ? productionCatalog('team-a', 'team-a-only-agent')
            : productionCatalog('team-b', 'team-b-only-agent')
        ),
      })

      const app = renderAppController()
      unmount = app.unmount
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      await waitFor(() =>
        expect(
          app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamId
        ).toBe('team-a')
      )
      act(() => {
        app.result.current.handleSelectChatAgent('team-a-only-agent', { selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe('team-a-only-agent'))

      const send = vi.fn(async () => undefined)
      const panel = renderControllerComposer(app)
      unmountPanel = panel.unmount
      const textarea = screen.getByRole('textbox', { name: 'Agent message composer' })
      fireEvent.change(textarea, { target: { value: 'keep this draft for a valid agent' } })
      expect((textarea as HTMLTextAreaElement).value).toBe('keep this draft for a valid agent')

      if (transition === 'team.switch') {
        await act(async () => {
          await app.result.current.handleEnsureTeamContext({ teamId: 'team-b' })
        })
      } else {
        currentTeamId = 'team-b'
        handle.getSessionState.mockResolvedValue({
          authenticated: true,
          me: { ...HARNESS_ME, teamId: 'team-b', teamName: 'Team B' },
        })
        await act(async () => {
          await app.result.current.loadSession({ preserveNav: true })
        })
      }

      await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-b'))
      await waitFor(() =>
        expect(
          app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamId
        ).toBe('team-b')
      )
      expect(app.result.current.selectedAgent).toBe('team-a-only-agent')
      panel.rerender(controllerComposerElement(app, send))

      const unavailableStatus = await screen.findByRole('alert')
      expect(unavailableStatus.textContent).toContain(
        'team-a-only-agent is unavailable in this team'
      )
      expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(true)
      expect((textarea as HTMLTextAreaElement).value).toBe('keep this draft for a valid agent')
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
      expect(send).not.toHaveBeenCalled()

      act(() => {
        app.result.current.handleSelectChatAgent('team-b-only-agent', { selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe('team-b-only-agent'))
      panel.rerender(controllerComposerElement(app, send))
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      const teamBTextarea = screen.getByRole('textbox', { name: 'Agent message composer' })
      expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.change(teamBTextarea, { target: { value: 'send with the Team B agent' } })
      expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(false)
      fireEvent.keyDown(teamBTextarea, { key: 'Enter', shiftKey: false })
      expect(send).toHaveBeenCalledExactlyOnceWith('send with the Team B agent')
    }
  )

  it.each(['team.switch', 'same-principal loadSession'] as const)(
    'shows a settled Team B catalog failure and retries only the catalog after %s',
    async transition => {
      const { handle } = installAppControllerClerum({
        me: { teamId: 'team-a', teamName: 'Team A' },
        teamDirectory: { items: [], currentTeamId: 'team-a' },
      })
      let currentTeamId = 'team-a'
      let failTeamBRefresh = true
      const refreshCatalog = vi.fn(async () => {
        if (currentTeamId === 'team-a') return productionCatalog('team-a', 'team-a-only-agent')
        if (failTeamBRefresh) throw new Error('Team B catalog unavailable')
        return productionCatalog('team-b', 'team-b-only-agent')
      })
      Object.assign(window.clerum.team, {
        switch: vi.fn(async (teamId: string) => {
          currentTeamId = teamId
          return {
            authenticated: true,
            me: { ...HARNESS_ME, teamId, teamName: teamId === 'team-a' ? 'Team A' : 'Team B' },
          }
        }),
      })
      Object.assign(window.clerum.access, { refreshCatalog })

      const app = renderAppController()
      unmount = app.unmount
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      await waitFor(() =>
        expect(
          app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamId
        ).toBe('team-a')
      )
      act(() => {
        app.result.current.handleSelectChatAgent('team-a-only-agent', { selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe('team-a-only-agent'))

      const send = vi.fn(async () => undefined)
      const panel = renderControllerComposer(app)
      unmountPanel = panel.unmount
      const textarea = screen.getByRole('textbox', { name: 'Agent message composer' })
      fireEvent.change(textarea, { target: { value: 'preserve while Team B access is checked' } })

      if (transition === 'team.switch') {
        await act(async () => {
          await app.result.current.handleEnsureTeamContext({ teamId: 'team-b' })
        })
      } else {
        currentTeamId = 'team-b'
        handle.getSessionState.mockResolvedValue({
          authenticated: true,
          me: { ...HARNESS_ME, teamId: 'team-b', teamName: 'Team B' },
        })
        await act(async () => {
          await app.result.current.loadSession({ preserveNav: true })
        })
      }

      await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-b'))
      await waitFor(() =>
        expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.status).toBe('error')
      )
      expect(
        app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamId
      ).toBe('team-a')
      expect(app.result.current.selectedAgent).toBe('team-a-only-agent')
      panel.rerender(controllerComposerElement(app, send))

      expect((await screen.findByRole('alert')).textContent).toContain(
        'Could not verify agent access for this team'
      )
      expect(screen.queryByText(/Checking agent access for this team/)).toBeNull()
      expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(true)
      expect((textarea as HTMLTextAreaElement).value).toBe(
        'preserve while Team B access is checked'
      )
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
      expect(send).not.toHaveBeenCalled()

      const callsBeforeRetry = refreshCatalog.mock.calls.length
      failTeamBRefresh = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry access check' }))
      await waitFor(() => expect(refreshCatalog).toHaveBeenCalledTimes(callsBeforeRetry + 1))
      await waitFor(() =>
        expect(
          app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)?.teamId
        ).toBe('team-b')
      )
      panel.rerender(controllerComposerElement(app, send))
      expect((await screen.findByRole('alert')).textContent).toContain(
        'team-a-only-agent is unavailable in this team'
      )
      expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
      expect(send).not.toHaveBeenCalled()
    }
  )
})
