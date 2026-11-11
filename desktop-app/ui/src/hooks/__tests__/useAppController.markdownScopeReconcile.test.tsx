// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  HARNESS_ME,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

const teardownFailure = vi.hoisted(() => ({
  error: null as Error | null,
  wait: null as Promise<void> | null,
  started: null as (() => void) | null,
}))

vi.mock('@hooks/domain/useAgentChatController', async importOriginal => {
  const actual = await importOriginal<typeof import('@hooks/domain/useAgentChatController')>()
  return {
    ...actual,
    useAgentChatController: (...args: Parameters<typeof actual.useAgentChatController>) => {
      const controller = actual.useAgentChatController(...args)
      return {
        ...controller,
        teardownTeamActivity: async () => {
          if (teardownFailure.wait) {
            teardownFailure.started?.()
            await teardownFailure.wait
          }
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
    teardownFailure.wait = null
    teardownFailure.started = null
    uninstallMockClerum()
  })

  function configureSwitchingSession(
    handle: ReturnType<typeof installAppControllerClerum>['handle']
  ) {
    let teamId = 'team-a'
    let generation = 1
    let authenticated = true
    const currentMe = () => ({
      ...HARNESS_ME,
      teamId,
      teamName: teamId === 'team-a' ? 'Team A' : 'Team B',
    })
    const session = () => ({
      authenticated,
      me: authenticated ? currentMe() : null,
      sessionGeneration: generation,
    })
    handle.getSessionState.mockImplementation(async () => session())
    const switchTeam = vi.fn(async (nextTeamId: string) => {
      teamId = nextTeamId
      generation += 1
      return session()
    })
    Object.assign(window.clerum.team, { switch: switchTeam })
    return {
      currentSession: session,
      switchTeam,
      retireMainSession: () => {
        authenticated = false
        generation += 1
      },
    }
  }

  function beginUnacknowledgedAuthRetirement(app: ReturnType<typeof renderAppController>) {
    const owner = app.result.current.markdownDraftOwner
    const token = owner.beginAuthBarrier(
      app.result.current.markdownPrincipalOwner!,
      app.result.current.sessionGeneration,
      false
    )
    expect(token).not.toBeNull()
    expect(owner.reserveAuthBarrierFromMain(token!)).toBe(true)
    expect(owner.commitAuthNeutralSurface(token!)).toBe(true)
    return owner
  }

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

  it('does not publish Team B after auth retirement supersedes a switch during teardown', async () => {
    const { handle } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    const session = configureSwitchingSession(handle)
    let startTeardown!: () => void
    const teardownStarted = new Promise<void>(resolve => {
      startTeardown = resolve
    })
    let releaseTeardown!: () => void
    teardownFailure.wait = new Promise<void>(resolve => {
      releaseTeardown = resolve
    })
    teardownFailure.started = startTeardown

    const app = renderAppController()
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-a'))
    let switchPromise!: Promise<unknown>
    act(() => {
      switchPromise = app.result.current.handleEnsureTeamContext({ teamId: 'team-b' })
    })
    await teardownStarted
    expect(session.currentSession().me?.teamId).toBe('team-b')
    expect(app.result.current.markdownDraftOwner.hasPendingTransition()).toBe(true)

    const owner = beginUnacknowledgedAuthRetirement(app)
    session.retireMainSession()
    releaseTeardown()
    await act(async () => {
      await expect(switchPromise).rejects.toThrow(/superseded/)
    })

    expect(app.result.current.currentTeamId).toBe('team-a')
    expect(app.result.current.sessionGeneration).toBe(1)
    expect(owner.getAuthBarrier()).toMatchObject({
      mainReserved: true,
      neutralCommitted: true,
      acknowledged: false,
    })
    expect(owner.hasPendingTransition()).toBe(true)
    app.unmount()
  })

  it('does not publish Team B after auth retirement supersedes authority revalidation', async () => {
    const { handle } = installAppControllerClerum({
      me: { teamId: 'team-a', teamName: 'Team A' },
      teamDirectory: { items: [], currentTeamId: 'team-a' },
    })
    const session = configureSwitchingSession(handle)
    let startTeardown!: () => void
    const teardownStarted = new Promise<void>(resolve => {
      startTeardown = resolve
    })
    let releaseTeardown!: () => void
    teardownFailure.wait = new Promise<void>(resolve => {
      releaseTeardown = resolve
    })
    let holdSessionRead = false
    let startSessionRead!: () => void
    const sessionReadStarted = new Promise<void>(resolve => {
      startSessionRead = resolve
    })
    let resolveSessionRead!: (value: ReturnType<typeof session.currentSession>) => void
    const sessionRead = new Promise<ReturnType<typeof session.currentSession>>(resolve => {
      resolveSessionRead = resolve
    })
    handle.getSessionState.mockImplementation(async () => {
      if (holdSessionRead) {
        holdSessionRead = false
        startSessionRead()
        return sessionRead
      }
      return session.currentSession()
    })
    teardownFailure.started = startTeardown

    const app = renderAppController()
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-a'))
    let switchPromise!: Promise<unknown>
    act(() => {
      switchPromise = app.result.current.handleEnsureTeamContext({ teamId: 'team-b' })
    })
    await teardownStarted
    expect(app.result.current.markdownDraftOwner.hasPendingTransition()).toBe(true)
    holdSessionRead = true
    releaseTeardown()
    await sessionReadStarted
    const confirmedTeamB = session.currentSession()
    expect(confirmedTeamB.me?.teamId).toBe('team-b')

    const owner = beginUnacknowledgedAuthRetirement(app)
    session.retireMainSession()
    resolveSessionRead(confirmedTeamB)
    await act(async () => {
      await expect(switchPromise).rejects.toThrow(
        /no longer matches current main-process authority/
      )
    })

    expect(app.result.current.currentTeamId).toBe('team-a')
    expect(app.result.current.sessionGeneration).toBe(1)
    expect(owner.getAuthBarrier()).toMatchObject({
      mainReserved: true,
      neutralCommitted: true,
      acknowledged: false,
    })
    expect(owner.hasPendingTransition()).toBe(true)
    app.unmount()
  })
})
