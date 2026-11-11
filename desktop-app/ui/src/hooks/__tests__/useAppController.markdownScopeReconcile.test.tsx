// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

const teardownFailure = vi.hoisted(() => ({ error: null as Error | null }))

vi.mock('@hooks/domain/useAgentChatController', async importOriginal => {
  const actual = await importOriginal<typeof import('@hooks/domain/useAgentChatController')>()
  return {
    ...actual,
    useAgentChatController: (...args: Parameters<typeof actual.useAgentChatController>) => {
      const controller = actual.useAgentChatController(...args)
      return {
        ...controller,
        teardownTeamActivity: async () => {
          if (teardownFailure.error) throw teardownFailure.error
          await controller.teardownTeamActivity()
        },
      }
    },
  }
})

describe('useAppController Markdown scope reconciliation', () => {
  afterEach(() => {
    cleanup()
    teardownFailure.error = null
    uninstallMockClerum()
  })

  it('publishes confirmed Team B when local teardown fails after the main switch committed', async () => {
    const { handle } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    let teamId = 'team-a'
    let generation = 1
    const currentMe = () => ({
      ...HARNESS_ME,
      teamId,
      teamName: teamId === 'team-a' ? 'Team A' : 'Team B',
    })
    handle.getSessionState.mockImplementation(async () => ({
      authenticated: true,
      me: currentMe(),
      sessionGeneration: generation,
    }))
    Object.assign(window.clerum.team, {
      switch: vi.fn(async (nextTeamId: string) => {
        teamId = nextTeamId
        generation += 1
        return { authenticated: true, me: currentMe(), sessionGeneration: generation }
      }),
    })
    teardownFailure.error = new Error('team teardown failed')

    const app = renderAppController()
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-a'))

    await act(async () => {
      await expect(
        app.result.current.handleEnsureTeamContext({ teamId: 'team-b' })
      ).rejects.toThrow('team teardown failed')
    })

    await waitFor(() => {
      expect(app.result.current.currentTeamId).toBe('team-b')
      expect(app.result.current.markdownDraftOwner.hasPendingTransition()).toBe(false)
    })
    expect(app.result.current.me?.teamId).toBe('team-b')
    expect(app.result.current.sessionGeneration).toBe(2)
    app.unmount()
  })
})
