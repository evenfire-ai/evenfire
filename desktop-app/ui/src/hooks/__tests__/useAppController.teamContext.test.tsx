// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useAppController team context', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it('switches back when stale directory data disagrees with the authenticated team', async () => {
    const { handle } = installAppControllerClerum({
      teamDirectory: {
        items: [],
        currentTeamId: HARNESS_ME.teamId,
      },
    })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    handle.teamDirectory.mockClear()
    handle.teamDirectory.mockRejectedValueOnce(new Error('directory refresh failed'))

    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(handle.teamDirectory).toHaveBeenCalledOnce()

    handle.switchTeam.mockClear()
    let switchedBack = false
    await act(async () => {
      switchedBack = await app.result.current.handleEnsureTeamContext({
        teamId: HARNESS_ME.teamId,
      })
    })

    expect(switchedBack).toBe(true)
    expect(handle.switchTeam).toHaveBeenCalledWith(HARNESS_ME.teamId)
  })
})
