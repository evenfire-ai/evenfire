// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../../../testSupport/appService.nativeCommitTestHarness'
import { testSessionTokenWithExpiry } from '../../../../testSupport/authTestFixtures'
import {
  type AppControllerDesktopEnvironmentHandoffProducer,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useAppController login-screen environment selection', () => {
  let unmount: (() => void) | null = null

  afterEach(async () => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
    await cleanupNativeCommitTestHarness()
  })

  async function openAuthenticatedApp(options: { keytarAvailable?: boolean } = {}) {
    const native = await createNativeCommitTestHarness({
      keytarAvailable: options.keytarAvailable ?? true,
    })
    const producer = native.service as unknown as AppControllerDesktopEnvironmentHandoffProducer & {
      authClient: unknown
      passwordLogin: (email: string, password: string) => Promise<unknown>
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    producer.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({
        token: testSessionTokenWithExpiry(),
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
      getMe: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'test@clerum.io',
        name: 'Test User',
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: 'member',
      }),
    }
    producer.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {})
    await producer.passwordLogin('test@clerum.io', 'synthetic-password')

    const { handle } = installAppControllerClerum({
      desktopEnvironmentHandoffProducer: producer,
    })
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(handle.onDesktopEnvironmentSetup).toHaveBeenCalledOnce())

    return { app, handle, native }
  }

  it('rejects a linked environment while authenticated until the user logs out', async () => {
    const { app, handle, native } = await openAuthenticatedApp()

    await act(async () =>
      handle.emitDesktopEnvironmentSetup({
        appName: 'Environment B',
        externalRestApiBaseUrl: native.restB,
      })
    )

    expect(handle.logout).not.toHaveBeenCalled()
    expect(handle.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(app.result.current.isAuthenticated).toBe(true)
    expect(native.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(
      native.optionA.id
    )
    expect(app.result.current.statusText).toContain('Log out before selecting another desktop')
  })

  it('shows signed-out UI while GFS resource cleanup remains pending', async () => {
    const { app, handle, native } = await openAuthenticatedApp()
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>(resolve => {
      releaseCleanup = resolve
    })
    const producer = native.service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    vi.mocked(producer.suspendDesktopGfsUploadsForAuthBoundary).mockReturnValue(cleanup)

    let logout!: Promise<void>
    try {
      await act(async () => {
        logout = app.result.current.handleLogout()
      })

      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(false))
      expect(handle.logout).toHaveBeenCalledOnce()
      await act(async () => {
        await expect(handle.logout.mock.results[0]?.value).resolves.toMatchObject({
          kind: 'committed',
        })
      })
      expect(app.result.current.isAuthenticated).toBe(false)
    } finally {
      await act(async () => {
        releaseCleanup()
        await cleanup
      })
    }

    await act(async () => logout)
  })
})
