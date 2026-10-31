// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../../../testSupport/appService.nativeCommitTestHarness'
import {
  type AppControllerDesktopEnvironmentHandoffProducer,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '../domain/queryKeys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useAppController desktop environment handoff', () => {
  let unmount: (() => void) | null = null

  beforeEach(() => {
    resetComposerDraftStore()
  })

  afterEach(async () => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
    resetComposerDraftStore()
    await cleanupNativeCommitTestHarness()
  })

  async function openSwitchConfirmation() {
    const native = await createNativeCommitTestHarness()
    const producer = native.service as unknown as AppControllerDesktopEnvironmentHandoffProducer & {
      authClient: unknown
      googleLogin: (token: string) => Promise<unknown>
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    producer.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-session-a',
        me: {
          id: 'user-1',
          email: 'test@clerum.io',
          name: 'Test User',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
    }
    producer.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {})
    await producer.googleLogin('synthetic-google-token')

    const { handle } = installAppControllerClerum({
      desktopEnvironmentHandoffProducer: producer,
    })
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(handle.onDesktopEnvironmentSetup).toHaveBeenCalledOnce())

    let handoff!: Promise<void>
    await act(async () => {
      handoff = handle.emitDesktopEnvironmentSetup({
        appName: 'Environment B',
        externalRestApiBaseUrl: native.restB,
      })
    })
    await waitFor(() =>
      expect(app.result.current.pendingDesktopEnvironmentSwitchConfirmation).toMatchObject({
        targetEnvironmentName: 'Environment B',
        targetExternalRestApiBaseUrl: native.restB,
      })
    )
    return { app, handle, handoff, native, targetOptionId: native.optionB.id }
  }

  function seedSamePrincipalWorkspace(app: ReturnType<typeof renderAppController>) {
    act(() => {
      app.result.current.handleSelectChatAgent('agent-x', {
        chatId: 'logout-preservation-chat',
        title: 'Same-principal conversation',
        selectLatest: false,
      })
      app.result.current.openFilesSection('gfs://main/0123456789abcdef0123456789abcdef')
    })
    const workspace = app.result.current.workspaceTabs
    const activeTab = activeWorkspaceTab(workspace)
    const chatTab = workspace.tabs.find(
      tab => tab.kind === 'chat' && tab.chat?.chatId === 'logout-preservation-chat'
    )
    if (activeTab?.kind !== 'files') throw new Error('expected the producer-created Files tab')
    if (chatTab?.kind !== 'chat') throw new Error('expected the producer-created chat tab')
    const draft = 'same-principal owned draft'
    expect(setComposerDraft('logout-preservation-chat', draft, 'agent-x', chatTab.id)).toBe(true)
    const accessCatalog = app.queryClient.getQueryData(desktopQueryKeys.accessCatalog)
    if (!accessCatalog) throw new Error('expected the authenticated catalog query to be cached')
    const gfsCacheKey = [...desktopQueryKeys.gfsRoot, 'logout-preservation']
    const gfsCacheValue = { principalId: 'user-1', marker: 'same-principal gfs data' }
    app.queryClient.setQueryData(gfsCacheKey, gfsCacheValue)
    return {
      workspace,
      activeTabId: activeTab.id,
      chatTabId: chatTab.id,
      draft,
      accessCatalog,
      gfsCacheKey,
      gfsCacheValue,
    }
  }

  function expectSamePrincipalWorkspace(
    app: ReturnType<typeof renderAppController>,
    preserved: ReturnType<typeof seedSamePrincipalWorkspace>
  ) {
    expect(app.result.current.me?.id).toBe('user-1')
    expect(app.result.current.workspaceTabs).toEqual(preserved.workspace)
    expect(activeWorkspaceTab(app.result.current.workspaceTabs)?.id).toBe(preserved.activeTabId)
    expect(app.result.current.navItem).toBe(DESKTOP_ROUTES.files)
    expect(app.result.current.selectedAgent).toBe('agent-x')
    expect(getComposerDraft('logout-preservation-chat', 'agent-x', preserved.chatTabId)).toBe(
      preserved.draft
    )
    expect(app.queryClient.getQueryData(desktopQueryKeys.accessCatalog)).toEqual(
      preserved.accessCatalog
    )
    expect(app.queryClient.getQueryData(preserved.gfsCacheKey)).toEqual(preserved.gfsCacheValue)
  }

  it('keeps the signed-in session and skips selection when the user cancels', async () => {
    const { app, handle, handoff } = await openSwitchConfirmation()

    await act(async () => app.result.current.handleCancelDesktopEnvironmentSwitchConfirmation())
    await act(async () => handoff)

    expect(handle.logout).not.toHaveBeenCalled()
    expect(handle.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(app.result.current.isAuthenticated).toBe(true)
    expect(app.result.current.pendingDesktopEnvironmentSwitchConfirmation).toBeNull()
    expect(app.result.current.toasts.map(toast => toast.text)).toContain(
      'Environment switch cancelled. Your current session remains active.'
    )
  })

  it('signs out before selecting the saved environment with the logout generation', async () => {
    const { app, handle, handoff, native, targetOptionId } = await openSwitchConfirmation()
    const preserved = seedSamePrincipalWorkspace(app)
    const tokenStore = native.service as unknown as {
      tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
    }
    let finishNativeLogout!: () => void
    tokenStore.tokenStore.clearSessionToken.mockImplementationOnce(
      () => new Promise<void>(resolve => (finishNativeLogout = resolve))
    )

    act(() => app.result.current.handleConfirmDesktopEnvironmentSwitchConfirmation())
    await waitFor(() => expect(tokenStore.tokenStore.clearSessionToken).toHaveBeenCalledOnce())
    expectSamePrincipalWorkspace(app, preserved)
    await act(async () => {
      finishNativeLogout()
      await handoff
    })

    expect(handle.logout).toHaveBeenCalledOnce()
    const logoutResult = await handle.logout.mock.results[0]?.value
    expect(handle.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      targetOptionId,
      logoutResult.sessionGeneration
    )
    expect(handle.logout.mock.invocationCallOrder[0]!).toBeLessThan(
      handle.selectRuntimeConfigForHandoff.mock.invocationCallOrder[0]!
    )
    expect(app.result.current.isAuthenticated).toBe(false)
    expect(app.result.current.runtimeConfigState?.activeOptionId).toBe(targetOptionId)
    expect(app.result.current.selectedAgent).toBeNull()
    expect(app.result.current.workspaceTabs.tabs).toHaveLength(1)
    expect(getComposerDraft('logout-preservation-chat', 'agent-x', preserved.chatTabId)).toBe('')
    expect(app.queryClient.getQueryData(desktopQueryKeys.accessCatalog)).toBeUndefined()
    expect(app.queryClient.getQueryData(preserved.gfsCacheKey)).toBeUndefined()
  })

  it('keeps the committed logout when renderer session reload fails', async () => {
    const { app, handle, handoff, targetOptionId } = await openSwitchConfirmation()
    handle.setSessionStateError(new Error('session read unavailable'))

    await act(async () => app.result.current.handleConfirmDesktopEnvironmentSwitchConfirmation())
    await act(async () => handoff)

    expect(handle.logout).toHaveBeenCalledOnce()
    const logoutResult = await handle.logout.mock.results[0]?.value
    expect(handle.selectRuntimeConfigForHandoff).toHaveBeenCalledWith(
      targetOptionId,
      logoutResult.sessionGeneration
    )
    expect(app.result.current.isAuthenticated).toBe(false)
    expect(app.result.current.runtimeConfigState?.activeOptionId).toBe(targetOptionId)
    expect(app.result.current.statusText).toContain(
      'Could not load the selected desktop environment'
    )
  })

  it('keeps the signed-in session and reports the native logout failure', async () => {
    const { app, handle, handoff, native } = await openSwitchConfirmation()
    const preserved = seedSamePrincipalWorkspace(app)
    const tokenStore = native.service as unknown as {
      tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> }
    }
    tokenStore.tokenStore.clearSessionToken.mockRejectedValueOnce(
      new Error('secure storage unavailable')
    )

    await act(async () => app.result.current.handleConfirmDesktopEnvironmentSwitchConfirmation())
    await act(async () => handoff)

    expect(handle.logout).toHaveBeenCalledOnce()
    expect(handle.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(app.result.current.isAuthenticated).toBe(true)
    expectSamePrincipalWorkspace(app, preserved)
    expect(app.result.current.statusText).toContain(
      "Logout failed: Error invoking remote method 'auth:logout': Error: secure storage unavailable"
    )
  })
})
