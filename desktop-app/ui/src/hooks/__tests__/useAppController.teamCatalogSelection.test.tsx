// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { AccessCatalog } from '../../../../src/types'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '../domain/queryKeys'

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

  afterEach(() => {
    unmount?.()
    unmount = undefined
    uninstallMockClerum()
  })

  it('keeps a team-A-only agent selected through a successful same-principal switch', async () => {
    const { clerum } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    let currentTeamId = 'team-a'
    Object.assign(clerum.team, {
      switch: vi.fn(async (teamId: string) => {
        currentTeamId = teamId
        return {
          authenticated: true,
          me: { ...HARNESS_ME, teamId, teamName: teamId === 'team-a' ? 'Team A' : 'Team B' },
        }
      }),
    })
    Object.assign(clerum.access, {
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
})
