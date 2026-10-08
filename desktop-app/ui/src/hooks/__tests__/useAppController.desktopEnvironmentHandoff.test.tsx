// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
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

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useAppController desktop environment handoff', () => {
  let unmount: (() => void) | null = null

  afterEach(async () => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
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
        token: 'session-a',
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
    return { app, handle, handoff, targetOptionId: native.optionB.id }
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
    const { app, handle, handoff, targetOptionId } = await openSwitchConfirmation()

    await act(async () => app.result.current.handleConfirmDesktopEnvironmentSwitchConfirmation())
    await act(async () => handoff)

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
})
