// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '../../constants/navigation'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '../../lib/composerDraftStore'
import { activeWorkspaceTab } from '../../lib/workspaceTabs'
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
    resetComposerDraftStore()
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

  // Queue API contract only; App producer races are covered in RecoveredAppDeepLinks.test.tsx.
  it('enforces the team-context queue contract for an old captured intent', async () => {
    let releaseDirectory!: () => void
    let directoryRefreshStarted!: () => void
    const directoryGate = new Promise<void>(resolve => (releaseDirectory = resolve))
    const directoryStarted = new Promise<void>(resolve => (directoryRefreshStarted = resolve))
    const { handle } = installAppControllerClerum()
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    handle.teamDirectory.mockImplementation(async () => {
      directoryRefreshStarted()
      await directoryGate
      return { items: [], currentTeamId: 'team-2' }
    })
    const capturedIntent = app.result.current.navigationIntentSequence
    let firstSwitch!: Promise<boolean>
    await act(async () => {
      firstSwitch = app.result.current.handleEnsureTeamContext({
        teamId: 'team-2',
        navigationIntentSequence: capturedIntent,
      })
      await Promise.resolve()
    })
    await directoryStarted

    let newerIntent = 0
    act(() => {
      newerIntent = app.result.current.beginUserNavigationIntent()
    })
    expect(newerIntent).toBe(capturedIntent + 1)
    let oldQueuedSwitch!: Promise<boolean>
    act(() => {
      oldQueuedSwitch = app.result.current.handleEnsureTeamContext({
        teamId: 'team-3',
        navigationIntentSequence: capturedIntent,
      })
    })

    expect(handle.switchTeam).toHaveBeenCalledTimes(1)
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    releaseDirectory()
    await act(async () => {
      await firstSwitch
      await oldQueuedSwitch
    })

    expect(handle.switchTeam).toHaveBeenCalledTimes(1)
    expect(app.result.current.currentTeamId).toBe('team-2')
    expect(app.result.current.navigationIntentSequence).toBe(newerIntent)
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
    // The directory still contains a team, but it is not authority to assign
    // this authenticated session to one when /me has no active team.
    expect(app.result.current.currentTeamId).toBe(expectedTeamId || '')

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

  it('keeps the principal signed in and clears the active team when /me revokes it', async () => {
    const { handle } = installAppControllerClerum({
      teamDirectory: { items: [], currentTeamId: 'team-dir' },
    })
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    handle.getSessionState.mockResolvedValueOnce({
      authenticated: true,
      me: { ...HARNESS_ME, teamId: null, teamName: null },
    })
    await act(async () => {
      await app.result.current.loadSession({ preserveNav: true })
    })

    expect(app.result.current.isAuthenticated).toBe(true)
    expect(app.result.current.me?.id).toBe(HARNESS_ME.id)
    expect(app.result.current.me?.teamId).toBeNull()
    expect(app.result.current.currentTeamId).toBe('')
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

  it('preserves the same-principal workspace and drafts across a team switch', async () => {
    const { handle } = installAppControllerClerum()
    const app = renderAppController()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'chat-1',
        title: 'Conversation',
        selectLatest: false,
      })
      app.result.current.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    })
    const before = app.result.current.workspaceTabs
    const activeBefore = activeWorkspaceTab(before)
    expect(activeBefore?.kind).toBe('files')
    const chatTab = before.tabs.find(tab => tab.kind === 'chat' && tab.chat?.chatId === 'chat-1')
    expect(chatTab?.kind).toBe('chat')
    if (chatTab?.kind !== 'chat') throw new Error('expected the producer-created chat tab')
    expect(setComposerDraft('chat-1', 'unsent workspace draft', 'agent-x', chatTab.id)).toBe(true)

    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })

    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    expect(app.result.current.workspaceTabs).toEqual(before)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.id).toBe(activeBefore?.id)
    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(getComposerDraft('chat-1', 'agent-x', chatTab.id)).toBe('unsent workspace draft')
    expect(app.result.current.currentTeamId).toBe('team-2')
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
  })
})
