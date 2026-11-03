// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTaskTrackerProvider, useAgentTaskTracker } from '@contexts/AgentTaskTrackerContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult, testSessionMe } from '../../../../testSupport/authTestFixtures.js'
import {
  type AppControllerDesktopEnvironmentHandoffProducer,
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
  const rendered = renderHook(
    () => ({ controller: useAppController(), tracker: useAgentTaskTracker() }),
    { wrapper }
  )
  return { ...rendered, queryClient }
}

async function installNativeLogoutOwner(
  options: { userId?: string; keytarAvailable?: boolean } = {}
) {
  const native = await createNativeCommitTestHarness({
    keytarAvailable: options.keytarAvailable ?? true,
  })
  const userId = options.userId ?? 'user-a'
  const user = testSessionMe({ id: userId, email: `${userId}@example.test` })
  const getMe = vi.fn().mockResolvedValue(user)
  native.service.authClient = {
    googleLogin: vi.fn().mockResolvedValue(testLoginResult(undefined, user)),
    getMe,
  } as never
  await native.service.googleLogin('initial-login')

  const { handle } = installAppControllerClerum({
    desktopEnvironmentHandoffProducer:
      native.service as unknown as AppControllerDesktopEnvironmentHandoffProducer,
  })
  const app = installCoordinatorHarness()
  await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
  await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))
  return { ...native, handle, app, user }
}

describe('useAppController session ownership oracle', () => {
  let tracker: ReturnType<typeof useAgentTaskTracker> | null = null

  afterEach(async () => {
    cleanup()
    tracker?.releaseAll()
    tracker = null
    vi.restoreAllMocks()
    uninstallMockClerum()
    resetComposerDraftStore()
    await cleanupNativeCommitTestHarness()
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

  it('preserves workspace and tears down team activity when loadSession observes a team change', async () => {
    const { clerum, handle } = installAppControllerClerum()
    const app = installCoordinatorHarness()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))

    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', {
        chatId: 'team-a-load-session-chat',
        title: 'Team A conversation',
        selectLatest: false,
      })
    })
    await waitFor(() =>
      expect(app.result.current.controller.activeChatId).toBe('team-a-load-session-chat')
    )
    clerum.rpc.invokeHostMessage.mockResolvedValue({ taskId: 'team-a-load-session-task' })
    await act(async () => {
      await app.result.current.controller.handleSendAgentMessage('team scoped task')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('team-a-load-session-task')).toBe(true))
    const chatKey = 'agent-x::team-a-load-session-chat'
    await waitFor(() =>
      expect(app.result.current.controller.sessionStateByChatKey[chatKey]?.state).toBe('processing')
    )

    act(() =>
      app.result.current.controller.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    )
    const before = app.result.current.controller.workspaceTabs
    const chatTab = before.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'team-a-load-session-chat'
    )
    expect(chatTab?.kind).toBe('chat')
    if (chatTab?.kind !== 'chat') throw new Error('expected the producer-created chat tab')
    expect(
      setComposerDraft('team-a-load-session-chat', 'keep this draft', 'agent-x', chatTab.id)
    ).toBe(true)
    expect(app.result.current.tracker.get(chatKey)?.taskId).toBe('team-a-load-session-task')

    handle.getSessionState.mockResolvedValue({
      authenticated: true,
      me: {
        ...HARNESS_ME,
        teamId: 'team-2',
        teamName: 'Team 2',
      },
    })

    await act(async () => {
      await app.result.current.controller.loadSession()
    })
    await waitFor(() => expect(app.result.current.controller.currentTeamId).toBe('team-2'))

    expect(app.result.current.controller.workspaceTabs).toEqual(before)
    expect(getComposerDraft('team-a-load-session-chat', 'agent-x', chatTab.id)).toBe(
      'keep this draft'
    )
    expect(app.result.current.tracker.get(chatKey)).toBeUndefined()
    expect(app.result.current.tracker.getResend('team-a-load-session-task')).toBeUndefined()
    expect(app.result.current.controller.sessionStateByChatKey[chatKey]).toBeUndefined()
    expect(clerum.hasProgressHandler('team-a-load-session-task')).toBe(false)
  })

  it('refetches active GFS data when the same published identity gets a new session generation', async () => {
    const { handle } = installAppControllerClerum()
    const app = installCoordinatorHarness()
    tracker = app.result.current.tracker

    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    await waitFor(() => expect(app.result.current.controller.initialExperienceLoading).toBe(false))

    let publishedGeneration = 1
    const loadReplacementGfsData = vi.fn(async () => ({ generation: publishedGeneration }))
    const loadOtherScopeData = vi.fn(async () => ({ generation: 'other-scope' }))
    const currentGfsQueryKey = desktopQueryKeys.gfsAccessible(
      `harness-environment:${HARNESS_ME.id}:${HARNESS_ME.teamId}`,
      'main',
      publishedGeneration
    )
    const otherGfsQueryKey = desktopQueryKeys.gfsAccessible(
      'other-environment:user-z:team-z',
      'main',
      1
    )
    await app.queryClient.fetchQuery({
      queryKey: currentGfsQueryKey,
      queryFn: loadReplacementGfsData,
    })
    await app.queryClient.fetchQuery({
      queryKey: otherGfsQueryKey,
      queryFn: loadOtherScopeData,
    })
    expect(app.queryClient.getQueryData(currentGfsQueryKey)).toEqual({ generation: 1 })

    publishedGeneration = 2
    const replacementGfsQueryKey = desktopQueryKeys.gfsAccessible(
      `harness-environment:${HARNESS_ME.id}:${HARNESS_ME.teamId}`,
      'main',
      publishedGeneration
    )
    await app.queryClient.fetchQuery({
      queryKey: replacementGfsQueryKey,
      queryFn: loadReplacementGfsData,
    })
    handle.getSessionGeneration.mockResolvedValue(publishedGeneration)
    handle.getSessionState.mockResolvedValue({
      authenticated: true,
      me: { ...HARNESS_ME },
      sessionGeneration: publishedGeneration,
    })
    await act(async () => {
      await app.result.current.controller.loadSession()
    })

    await waitFor(() => expect(loadReplacementGfsData).toHaveBeenCalledTimes(3))
    expect(loadOtherScopeData).toHaveBeenCalledTimes(1)
    expect(app.queryClient.getQueryData(currentGfsQueryKey)).toEqual({ generation: 1 })
    expect(app.queryClient.getQueryData(replacementGfsQueryKey)).toEqual({ generation: 2 })
    expect(app.result.current.controller.sessionGeneration).toBe(2)
    expect(app.queryClient.getQueryData(otherGfsQueryKey)).toEqual({ generation: 'other-scope' })
    expect(app.result.current.controller.currentTeamId).toBe(HARNESS_ME.teamId)
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

  it('continues logout cleanup when one query-cache reset throws', async () => {
    const { service, handle, app } = await installNativeLogoutOwner({ keytarAvailable: false })
    tracker = app.result.current.tracker
    act(() => {
      app.result.current.controller.handleSelectChatAgent('agent-x', {
        chatId: 'logout-cleanup-chat',
        title: 'Current conversation',
        selectLatest: false,
      })
      app.result.current.controller.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    })
    await waitFor(() =>
      expect(app.result.current.controller.activeChatId).toBe('logout-cleanup-chat')
    )

    const removeQueries = app.queryClient.removeQueries.bind(app.queryClient)
    const failedCleanup = vi.spyOn(app.queryClient, 'removeQueries').mockImplementation(filters => {
      if (JSON.stringify(filters?.queryKey) === JSON.stringify(desktopQueryKeys.gfsRoot)) {
        throw new Error('diagnostic cache cleanup failure')
      }
      return removeQueries(filters)
    })
    const clearCache = vi.spyOn(app.queryClient, 'clear')
    await act(async () => {
      await app.result.current.controller.handleLogout()
    })

    expect(handle.logout).toHaveBeenCalledOnce()
    await expect(handle.logout.mock.results[0]?.value).resolves.toMatchObject({
      kind: 'committed',
      cleanup: 'not-required',
    })
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: false,
      me: null,
    })
    expect(failedCleanup).toHaveBeenCalledWith({ queryKey: desktopQueryKeys.gfsRoot })
    expect(clearCache).toHaveBeenCalledOnce()
    expect(app.result.current.controller.isAuthenticated).toBe(false)
    expect(app.result.current.controller.selectedAgent).toBeNull()
    expect(app.result.current.controller.activeChatId).toBeNull()
    expect(app.result.current.controller.workspaceTabs.tabs).toHaveLength(1)
    expect(activeWorkspaceTab(app.result.current.controller.workspaceTabs)).toMatchObject({
      kind: 'chat',
      chat: { agentRef: null, chatId: null },
    })
    expect(app.result.current.controller.statusText).toContain(
      'Signed out, but some local cleanup failed'
    )
    expect(app.result.current.controller.statusTone).toBe('warn')
  })

  it('shows the normal success status for a committed logout without cleanup debt', async () => {
    const { handle, app } = await installNativeLogoutOwner({ keytarAvailable: false })
    tracker = app.result.current.tracker

    await act(async () => {
      await app.result.current.controller.handleLogout()
    })

    await expect(handle.logout.mock.results[0]?.value).resolves.toMatchObject({
      kind: 'committed',
      cleanup: 'not-required',
    })
    expect(app.result.current.controller.statusText).toBe('Logged out.')
    expect(app.result.current.controller.statusTone).toBe('success')
  })

  it('shows secure credential cleanup pending when local cleanup succeeds', async () => {
    const { service, handle, app } = await installNativeLogoutOwner()
    tracker = app.result.current.tracker
    service.tokenStore.clearSessionTokenStrictly = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    await act(async () => {
      await app.result.current.controller.handleLogout()
    })

    await expect(handle.logout.mock.results[0]?.value).resolves.toMatchObject({
      kind: 'committed',
      cleanup: 'pending',
    })
    expect(app.result.current.controller.statusText).toBe(
      'Logged out. Secure credential cleanup is pending.'
    )
    expect(app.result.current.controller.statusTone).toBe('success')
  })

  it('does not show logout success when the actual durable acceptance CAS loses', async () => {
    const { service, handle, app } = await installNativeLogoutOwner()
    tracker = app.result.current.tracker
    const tokenStore = service.tokenStore as unknown as {
      applySessionAuthorityMarkerCas: (...args: unknown[]) => boolean
    }
    vi.spyOn(tokenStore, 'applySessionAuthorityMarkerCas').mockReturnValue(false)

    await act(async () => {
      await app.result.current.controller.handleLogout()
    })

    await expect(handle.logout.mock.results[0]?.value).resolves.toMatchObject({
      kind: 'not-committed',
    })
    const authoritativeSession = (await service.getSessionState()) as { authenticated: boolean }
    expect(app.result.current.controller.isAuthenticated).toBe(authoritativeSession.authenticated)
    expect(app.result.current.controller.statusText).not.toBe('Logged out.')
    expect(app.result.current.controller.statusTone).not.toBe('success')
  })

  it('preserves pending credential cleanup disclosure when local cache cleanup also fails', async () => {
    const { service, handle, app } = await installNativeLogoutOwner()
    tracker = app.result.current.tracker
    service.tokenStore.clearSessionTokenStrictly = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    const removeQueries = app.queryClient.removeQueries.bind(app.queryClient)
    vi.spyOn(app.queryClient, 'removeQueries').mockImplementation(filters => {
      if (JSON.stringify(filters?.queryKey) === JSON.stringify(desktopQueryKeys.gfsRoot)) {
        throw new Error('diagnostic cache cleanup failure')
      }
      return removeQueries(filters)
    })

    await act(async () => {
      await app.result.current.controller.handleLogout()
    })

    expect(handle.logout).toHaveBeenCalledOnce()
    await expect(handle.logout.mock.results[0]?.value).resolves.toMatchObject({
      kind: 'committed',
      cleanup: 'pending',
    })
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: false,
      me: null,
    })
    expect(app.result.current.controller.isAuthenticated).toBe(false)
    expect(app.result.current.controller.statusTone).toBe('warn')
    expect(app.result.current.controller.statusText).toContain('credential cleanup is pending')
    expect(app.result.current.controller.statusText).toContain('local cleanup failed')
    expect(app.result.current.controller.statusText).toContain('diagnostic cache cleanup failure')
  })

  it('does not apply an old local-cleanup warning after a newer owner is accepted', async () => {
    const { service, handle, app } = await installNativeLogoutOwner()
    tracker = app.result.current.tracker
    const removeQueries = app.queryClient.removeQueries.bind(app.queryClient)
    vi.spyOn(app.queryClient, 'removeQueries').mockImplementation(filters => {
      if (JSON.stringify(filters?.queryKey) === JSON.stringify(desktopQueryKeys.gfsRoot)) {
        throw new Error('diagnostic cache cleanup failure')
      }
      return removeQueries(filters)
    })

    let releaseLogout!: () => void
    const logoutResponseHeld = new Promise<void>(resolve => {
      releaseLogout = resolve
    })
    const realLogout = service.logout.bind(service)
    const logoutProducer = vi.fn(async () => {
      const outcome = await realLogout()
      await logoutResponseHeld
      return outcome
    })
    const realGetSessionState = service.getSessionState.bind(service)
    const producerService = service as unknown as Omit<
      AppControllerDesktopEnvironmentHandoffProducer,
      'logout'
    >
    const producer: AppControllerDesktopEnvironmentHandoffProducer = {
      getSessionState: () =>
        realGetSessionState() as Promise<{ authenticated: boolean; me: unknown | null }>,
      getSessionGeneration: () => producerService.getSessionGeneration(),
      getRuntimeConfigState: () => producerService.getRuntimeConfigState(),
      selectRuntimeConfigForHandoff: (optionId, expectedGeneration) =>
        producerService.selectRuntimeConfigForHandoff(optionId, expectedGeneration),
      logout: logoutProducer,
    }
    handle.logout.mockImplementation(async () => {
      const outcome = await producer.logout()
      return outcome
    })

    let pendingLogout!: Promise<void>
    act(() => {
      pendingLogout = app.result.current.controller.handleLogout()
    })
    await waitFor(async () => {
      expect(await realGetSessionState()).toMatchObject({ authenticated: false, me: null })
    })
    const newUser = testSessionMe({ id: 'user-b', email: 'user-b@example.test' })
    const getMe = service.authClient.getMe
    getMe.mockResolvedValue(newUser)
    service.authClient.googleLogin.mockResolvedValue(testLoginResult(undefined, newUser))
    await service.googleLogin('replacement-login')
    handle.emitSessionStateChanged()
    await waitFor(() => expect(app.result.current.controller.isAuthenticated).toBe(true))
    const replacementGeneration = service.getSessionGeneration()
    await waitFor(() =>
      expect(app.result.current.controller.sessionGeneration).toBe(replacementGeneration)
    )

    releaseLogout()
    await act(async () => pendingLogout)

    expect(app.result.current.controller.isAuthenticated).toBe(true)
    expect(app.result.current.controller.me?.id).toBe('user-b')
    expect(app.result.current.controller.sessionGeneration).toBe(replacementGeneration)
    expect(app.result.current.controller.statusText).not.toContain(
      'diagnostic cache cleanup failure'
    )
  })
})
