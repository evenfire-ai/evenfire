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

  // R1-L10: the delete fence binds to the authenticated principal's team only.
  // The team directory is display data; a directory team must never stand in
  // for an absent `me.teamId`, or a deletion would be fenced to a team the
  // session never proved membership of.
  it.each([
    ['an absent me.teamId stays null despite a directory team', '', null],
    ['a padded me.teamId is trimmed', '  team-1  ', 'team-1'],
  ])('fences chat deletion to %s', async (_label, meTeamId, expectedTeamId) => {
    const { clerum } = installAppControllerClerum({
      me: { teamId: meTeamId },
      teamDirectory: { items: [], currentTeamId: 'team-dir' },
    })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    // Witness: the directory team is visible to the rest of the app, so a
    // fallback to it would have a value to use.
    expect(app.result.current.currentTeamId).toBe(meTeamId || 'team-dir')

    await act(async () => {
      await app.result.current.captureChatDeleteFence('agent-x')
    })

    expect(clerum.chat.captureDeleteFence).toHaveBeenCalledTimes(1)
    expect(clerum.chat.captureDeleteFence).toHaveBeenCalledWith({
      environmentKey: expect.any(String),
      userId: HARNESS_ME.id,
      teamId: expectedTeamId,
    })
  })

  // The cache scope (`currentTeamId`) and the delete fence read `me.teamId`
  // from one point: while it is present both carry it, and both follow it when
  // the session switches team, whatever the (unchanged) directory reports.
  it('derives the chat cache scope and the delete fence from the same me.teamId', async () => {
    const { clerum, handle } = installAppControllerClerum({
      teamDirectory: { items: [], currentTeamId: 'team-dir' },
    })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    const fencedTeamId = async () => {
      clerum.chat.captureDeleteFence.mockClear()
      await act(async () => {
        await app.result.current.captureChatDeleteFence('agent-x')
      })
      expect(clerum.chat.captureDeleteFence).toHaveBeenCalledTimes(1)
      return clerum.chat.captureDeleteFence.mock.calls[0]?.[0]?.teamId
    }

    expect(app.result.current.currentTeamId).toBe(HARNESS_ME.teamId)
    expect(await fencedTeamId()).toBe(HARNESS_ME.teamId)

    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })
    // Witness: the switch really went through and moved me.teamId.
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))
    expect(await fencedTeamId()).toBe('team-2')
  })
})
