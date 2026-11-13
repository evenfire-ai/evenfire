// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatActionsProvider } from '@contexts/AgentChatActionsContext'
import type { AgentChatActionsContextValue } from '@contexts/AgentChatActionsContext'
import { ChatComposerStateProvider } from '@contexts/ChatComposerStateContext'
import type { ChatComposerStateContextValue } from '@contexts/ChatComposerStateContext'
import { McpRuntimeProvider } from '@contexts/McpRuntimeContext'
import { NavigationContext } from '@contexts/NavigationContext'
import type { NavigationContextValue } from '@contexts/NavigationContext'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComposerPanel } from '@components/agents/ComposerPanel'
import { AGENT_WORKSPACE_ROUTES, DESKTOP_ROUTES } from '@constants/navigation'
import type { AccessCatalog } from '../../../../src/types'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { ipcHostAccessDenied } from '../domain/__tests__/__fixtures__/ipcErrors'
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
      <NavigationContext.Provider value={navigationValue}>
        <AgentChatActionsProvider value={actionValue}>
          <ChatComposerStateProvider value={emptyComposerState}>
            <McpRuntimeProvider value={runtimeValue}>
              <ComposerPanel inline />
            </McpRuntimeProvider>
          </ChatComposerStateProvider>
        </AgentChatActionsProvider>
      </NavigationContext.Provider>
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

type TeamTransition = 'team.switch' | 'same-principal loadSession'

const TEAM_TRANSITIONS: TeamTransition[] = ['team.switch', 'same-principal loadSession']
const TEAM_A_AGENT = 'team-a-only-agent'

function catalogQueryData(app: ReturnType<typeof renderAppController>) {
  return app.queryClient.getQueryData<AccessCatalog>(desktopQueryKeys.accessCatalog)
}

/** A session in Team A whose catalog is produced per team by the given function. */
function installTeamSession(catalogForTeam: (teamId: string) => AccessCatalog) {
  const { handle } = installAppControllerClerum({
    me: { teamId: 'team-a', teamName: 'Team A' },
    teamDirectory: { items: [], currentTeamId: 'team-a' },
  })
  let currentTeamId = 'team-a'
  const refreshCatalog = vi.fn(async () => catalogForTeam(currentTeamId))
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

  const moveToTeamB = async (
    app: ReturnType<typeof renderAppController>,
    transition: TeamTransition
  ) => {
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
  }

  return { refreshCatalog, moveToTeamB }
}

async function expectComposerSends(
  app: ReturnType<typeof renderAppController>,
  panel: ReturnType<typeof render>,
  agent: string,
  draft: string
) {
  panel.rerender(controllerComposerElement(app))
  const textarea = screen.getByRole('textbox', { name: 'Agent message composer' })
  fireEvent.change(textarea, { target: { value: draft } })
  expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(false)
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
  await vi.waitFor(() =>
    expect(window.clerum.rpc.invokeHostMessage).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ content: draft }),
      [agent],
      { async: true }
    )
  )
  expect(app.result.current.selectedAgent).toBe(agent)
}

describe('useAppController agent selection and sending do not depend on the team catalog', () => {
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

  async function bootInTeamAWithAgent(agent: string) {
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(catalogQueryData(app)?.teamId).toBe('team-a'))
    act(() => {
      app.result.current.handleSelectChatAgent(agent, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(agent))
    return app
  }

  it('keeps the selected agent through a same-principal team switch', async () => {
    const { moveToTeamB } = installTeamSession(teamId =>
      teamId === 'team-a'
        ? productionCatalog('team-a', TEAM_A_AGENT)
        : productionCatalog('team-b', 'team-b-only-agent')
    )
    const app = await bootInTeamAWithAgent(TEAM_A_AGENT)

    await moveToTeamB(app, 'team.switch')

    await waitFor(() => expect(catalogQueryData(app)?.teamId).toBe('team-b'))
    expect(catalogQueryData(app)?.teamAgentNames).toEqual(['team-b-only-agent'])
    expect(app.result.current.selectedAgent).toBe(TEAM_A_AGENT)
  })

  it('(a) sends when the settled catalog is stamped with another team', async () => {
    const { refreshCatalog, moveToTeamB } = installTeamSession(() =>
      productionCatalog('team-a', TEAM_A_AGENT)
    )
    const app = await bootInTeamAWithAgent(TEAM_A_AGENT)
    const panel = renderControllerComposer(app)
    unmountPanel = panel.unmount
    const callsBeforeSwitch = refreshCatalog.mock.calls.length

    await moveToTeamB(app, 'team.switch')

    await waitFor(() => expect(refreshCatalog.mock.calls.length).toBeGreaterThan(callsBeforeSwitch))
    await waitFor(() =>
      expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.fetchStatus).toBe(
        'idle'
      )
    )
    expect(catalogQueryData(app)?.teamId).toBe('team-a')
    await expectComposerSends(app, panel, TEAM_A_AGENT, 'send with a catalog of another team')
  })

  it.each(TEAM_TRANSITIONS)(
    '(b) keeps an unlisted agent sendable after %s when the new team catalog changes',
    async transition => {
      let teamBCatalog = productionCatalog('team-b', 'team-b-only-agent')
      const { refreshCatalog, moveToTeamB } = installTeamSession(teamId =>
        teamId === 'team-a' ? productionCatalog('team-a', TEAM_A_AGENT) : teamBCatalog
      )
      const app = await bootInTeamAWithAgent(TEAM_A_AGENT)
      const firstPanel = renderControllerComposer(app)

      await moveToTeamB(app, transition)
      await waitFor(() => expect(catalogQueryData(app)?.teamId).toBe('team-b'))
      expect(app.result.current.selectedAgent).toBe(TEAM_A_AGENT)

      // The second catalog must differ from the first. The query keeps the
      // same data object for an equal result, so nothing that reads the
      // catalog would see a change, and the assertion below could not tell
      // the refetched catalog from the first one.
      const secondAgentNames = ['team-b-only-agent', 'team-b-second-agent']
      teamBCatalog = {
        ...productionCatalog('team-b', 'team-b-only-agent'),
        teamAgentNames: secondAgentNames,
        agentNames: secondAgentNames,
      }
      await waitFor(() =>
        expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.fetchStatus).toBe(
          'idle'
        )
      )
      const callsBeforeRemount = refreshCatalog.mock.calls.length
      firstPanel.unmount()
      const panel = renderControllerComposer(app)
      unmountPanel = panel.unmount

      await waitFor(() =>
        expect(refreshCatalog.mock.calls.length).toBeGreaterThan(callsBeforeRemount)
      )
      await waitFor(() => expect(catalogQueryData(app)?.agentNames).toEqual(secondAgentNames))
      expect(app.result.current.selectedAgent).toBe(TEAM_A_AGENT)
      await expectComposerSends(app, panel, TEAM_A_AGENT, 'send after the catalog changed')
    }
  )

  it.each(TEAM_TRANSITIONS)(
    '(c) sends when the catalog refresh fails after %s',
    async transition => {
      const { moveToTeamB } = installTeamSession(teamId => {
        if (teamId === 'team-a') return productionCatalog('team-a', TEAM_A_AGENT)
        throw new Error('Team B catalog unavailable')
      })
      const app = await bootInTeamAWithAgent(TEAM_A_AGENT)
      const panel = renderControllerComposer(app)
      unmountPanel = panel.unmount

      await moveToTeamB(app, transition)

      await waitFor(() =>
        expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.status).toBe('error')
      )
      expect(catalogQueryData(app)?.teamId).toBe('team-a')
      expect(app.result.current.selectedAgent).toBe(TEAM_A_AGENT)
      await expectComposerSends(app, panel, TEAM_A_AGENT, 'send while the catalog is failing')
    }
  )

  it('(d) sends while the catalog query is still pending', async () => {
    const { handle } = installAppControllerClerum({
      agentNames: ['agent-x'],
      delayAuthenticatedLoad: true,
    })
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))
    const panel = renderControllerComposer(app)
    unmountPanel = panel.unmount

    expect(app.queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.status).toBe('pending')
    await expectComposerSends(app, panel, 'agent-x', 'send before the catalog loads')
    handle.resolveAuthenticatedLoad()
  })

  it('(e) keeps and sends to an agent the catalog does not list', async () => {
    installAppControllerClerum({ agentNames: ['agent-y'] })
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(catalogQueryData(app)?.agentNames).toEqual(['agent-y']))

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))

    const panel = renderControllerComposer(app)
    unmountPanel = panel.unmount
    await expectComposerSends(app, panel, 'agent-x', 'send to an unlisted agent')
  })

  it.each([
    ['held', true],
    ['not held', false],
  ] as const)(
    'a workspace snapshot that names an agent whose access is %s restores the selection only when it is not held',
    async (_label, held) => {
      const { clerum } = installAppControllerClerum({ agentNames: ['agent-x', 'agent-y'] })
      const app = renderAppController()
      unmount = app.unmount
      await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
      act(() => {
        app.result.current.handleOpenAgentWorkspace('agent-x', AGENT_WORKSPACE_ROUTES.members)
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-x'))
      const snapshot = app.result.current.captureWorkspaceNavigation()

      act(() => {
        app.result.current.handleSelectChatAgent('agent-y', { selectLatest: false })
      })
      await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-y'))
      if (held) {
        // The server denies agent-x's chat list, which holds it. The guarded
        // handlers refuse a held agent, so only the snapshot restore can name it.
        const denial = await ipcHostAccessDenied('rpc:listSessions')
        clerum.rpc.listSessions.mockImplementation(async (hostRef: string) => {
          if (hostRef === 'agent-x') throw denial
          return { items: [] } as never
        })
        act(() => {
          app.result.current.handleSelectChatAgent('agent-x', { selectLatest: false })
        })
        await waitFor(() => expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(true))
        act(() => {
          app.result.current.handleSelectChatAgent('agent-y', { selectLatest: false })
        })
        await waitFor(() => expect(app.result.current.selectedAgent).toBe('agent-y'))
      }
      expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.chat)

      let restored: number | null = null
      act(() => {
        restored = app.result.current.restoreWorkspaceNavigation(
          snapshot,
          app.result.current.navigationIntentSequence
        )
      })

      // Witness that the snapshot was applied: its route came back.
      expect(typeof restored).toBe('number')
      await waitFor(() => expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.agents))
      expect(app.result.current.selectedAgentRoute).toBe(AGENT_WORKSPACE_ROUTES.members)
      // The not-held row is the witness that the snapshot names agent-x.
      await waitFor(() => expect(app.result.current.selectedAgent).toBe(held ? null : 'agent-x'))
      expect(app.result.current.isHostAccessBlocked('agent-x')).toBe(held)
    }
  )

  describe('the server decides the selection', () => {
    const teamScopedCatalog = (teamId: string) =>
      teamId === 'team-a'
        ? productionCatalog('team-a', TEAM_A_AGENT)
        : productionCatalog('team-b', 'team-b-only-agent')

    const listSessionsCallsFor = (agent: string, fromCall: number) =>
      vi
        .mocked(window.clerum.rpc.listSessions)
        .mock.calls.slice(fromCall)
        .filter(([hostRef]) => hostRef === agent)

    it('deselects and holds the agent when the server denies its chat list after a switch', async () => {
      const { moveToTeamB } = installTeamSession(teamScopedCatalog)
      const app = await bootInTeamAWithAgent(TEAM_A_AGENT)
      const denial = await ipcHostAccessDenied('rpc:listSessions')
      const listSessions = vi.mocked(window.clerum.rpc.listSessions)
      const callsBeforeSwitch = listSessions.mock.calls.length
      listSessions.mockImplementation(async (hostRef: string) => {
        if (hostRef === TEAM_A_AGENT) throw denial
        return { items: [] } as never
      })

      await moveToTeamB(app, 'team.switch')

      await waitFor(() => expect(app.result.current.selectedAgent).toBeNull())
      expect(app.result.current.isHostAccessBlocked(TEAM_A_AGENT)).toBe(true)
      expect(listSessionsCallsFor(TEAM_A_AGENT, callsBeforeSwitch).length).toBeGreaterThan(0)
    })

    it('keeps and sends to the agent when the server allows its chat list after a switch', async () => {
      const { moveToTeamB } = installTeamSession(teamScopedCatalog)
      const app = await bootInTeamAWithAgent(TEAM_A_AGENT)
      const callsBeforeSwitch = vi.mocked(window.clerum.rpc.listSessions).mock.calls.length
      const panel = renderControllerComposer(app)
      unmountPanel = panel.unmount

      await moveToTeamB(app, 'team.switch')

      await waitFor(() =>
        expect(listSessionsCallsFor(TEAM_A_AGENT, callsBeforeSwitch).length).toBeGreaterThan(0)
      )
      expect(app.result.current.selectedAgent).toBe(TEAM_A_AGENT)
      expect(app.result.current.isHostAccessBlocked(TEAM_A_AGENT)).toBe(false)
      await expectComposerSends(app, panel, TEAM_A_AGENT, 'send after the server allowed the read')
    })
  })
})
