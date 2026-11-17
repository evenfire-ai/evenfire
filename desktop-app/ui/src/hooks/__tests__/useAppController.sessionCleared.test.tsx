// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'
import { desktopQueryKeys } from '../domain/queryKeys'

afterEach(() => {
  cleanup()
  uninstallMockClerum()
})

describe('useAppController session-cleared notice', () => {
  it('keeps the live session generation after a logout storage failure', async () => {
    const { clerum } = installAppControllerClerum({ startAuthenticated: true })
    let currentGeneration = 4
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.getSessionGeneration = vi.fn(async () => currentGeneration)
    auth.logout = vi.fn(async () => {
      currentGeneration = 5
      throw new Error('secure_token_storage_unavailable')
    })
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await act(async () => app.result.current.handleLogout())

    expect(app.result.current.isAuthenticated).toBe(true)
    act(() =>
      reportFailure?.({
        correlationId: 'failed-logout-current-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: currentGeneration,
          profileId: null,
          profileIncarnation: null,
          restBaseUrl: 'http://127.0.0.1:8091',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('uses the main generation after a failed login for correlated browser reports', async () => {
    const { clerum } = installAppControllerClerum({
      startAuthenticated: false,
      passwordLoginError: new Error('401 Unauthorized'),
    })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    ;(auth.getSessionGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(2)

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    act(() => {
      app.result.current.setEmail('user@example.test')
      app.result.current.setPassword('bad-password')
    })
    await act(async () => app.result.current.handlePasswordLogin())

    act(() =>
      reportFailure?.({
        correlationId: 'failed-login-stale-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 1,
          profileId: null,
          profileIncarnation: null,
          restBaseUrl: 'http://127.0.0.1:8091',
        },
      })
    )
    expect(app.result.current.statusText).not.toBe(
      'Profile UI could not be opened in your browser.'
    )

    act(() =>
      reportFailure?.({
        correlationId: 'failed-login-current-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 2,
          profileId: null,
          profileIncarnation: null,
          restBaseUrl: 'http://127.0.0.1:8091',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('refreshes the main generation after failed Desktop Setup before accepting a report', async () => {
    const { clerum } = installAppControllerClerum({ startAuthenticated: false })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    ;(auth.getSessionGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    ;(auth.completeDesktopSetup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('desktop_setup_not_found')
    )

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    act(() => {
      app.result.current.setEmail('user@example.test')
      app.result.current.setDesktopSetupAuthorizationToken('invalid-invitation-token')
    })
    await act(async () => app.result.current.handleCompleteDesktopSetup())

    act(() =>
      reportFailure?.({
        correlationId: 'setup-generation-current-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 2,
          profileId: null,
          profileIncarnation: null,
          restBaseUrl: 'http://127.0.0.1:8091',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('refreshes the main generation after saving a runtime environment', async () => {
    const state = {
      configured: true,
      isLocalhost: false,
      selectorVisible: true,
      activeOptionId: 'profile-a',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api.example.test',
        rpcProxyBaseUrl: 'https://rpc.example.test',
        appName: 'Example',
      },
      envKey: 'example-env',
      storagePath: '/harness/runtime-configs',
      options: [
        {
          id: 'profile-a',
          label: 'Example',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/example.json',
          externalRestApiBaseUrl: 'https://api.example.test',
          rpcProxyBaseUrl: 'https://rpc.example.test',
          appName: 'Example',
          profileIncarnation: 'incarnation-a',
        },
      ],
    }
    const { clerum } = installAppControllerClerum({ runtimeConfigState: state })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    ;(auth.getSessionGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(4)
    ;(auth.saveRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue(state)

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    await act(async () =>
      app.result.current.handleSaveRuntimeConfig({
        externalRestApiBaseUrl: 'https://api.example.test',
        rpcProxyBaseUrl: 'https://rpc.example.test',
        appName: 'Example',
      })
    )

    act(() =>
      reportFailure?.({
        correlationId: 'save-generation-current-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 4,
          profileId: 'profile-a',
          profileIncarnation: 'incarnation-a',
          restBaseUrl: 'https://api.example.test',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('reconciles a committed environment when discovery rejects after saving it', async () => {
    const stateA = {
      configured: true,
      isLocalhost: false,
      selectorVisible: true,
      activeOptionId: 'profile-a',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api.a.example.test',
        rpcProxyBaseUrl: 'https://rpc.a.example.test',
        appName: 'Environment A',
      },
      envKey: 'environment-a',
      storagePath: '/harness/runtime-configs',
      options: [
        {
          id: 'profile-a',
          label: 'Environment A',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/environment-a.json',
          externalRestApiBaseUrl: 'https://api.a.example.test',
          rpcProxyBaseUrl: 'https://rpc.a.example.test',
          appName: 'Environment A',
          profileIncarnation: 'incarnation-a',
        },
      ],
    }
    const stateB = {
      ...stateA,
      activeOptionId: 'profile-b',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api.b.example.test',
        rpcProxyBaseUrl: 'https://rpc.b.example.test',
        appName: 'Environment B',
      },
      envKey: 'environment-b',
      options: [
        ...stateA.options,
        {
          id: 'profile-b',
          label: 'Environment B',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/environment-b.json',
          externalRestApiBaseUrl: 'https://api.b.example.test',
          rpcProxyBaseUrl: 'https://rpc.b.example.test',
          appName: 'Environment B',
          profileIncarnation: 'incarnation-b',
        },
      ],
    }
    const { clerum, handle } = installAppControllerClerum({
      startAuthenticated: false,
      runtimeConfigState: stateA,
    })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    ;(auth.getSessionGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(2)
    ;(auth.saveRuntimeConfig as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      handle.setRuntimeConfigState(stateB)
      throw new Error('Profile UI resolution is unavailable')
    })

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    await waitFor(() =>
      expect(app.result.current.runtimeConfigState?.activeOptionId).toBe('profile-a')
    )

    await act(async () =>
      app.result.current.handleSaveRuntimeConfig({
        externalRestApiBaseUrl: 'https://api.b.example.test',
        rpcProxyBaseUrl: 'https://rpc.b.example.test',
        appName: 'Environment B',
      })
    )

    await waitFor(() =>
      expect(app.result.current.runtimeConfigState?.activeOptionId).toBe('profile-b')
    )
    act(() =>
      reportFailure?.({
        correlationId: 'stale-environment-a-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 2,
          profileId: 'profile-a',
          profileIncarnation: 'incarnation-a',
          restBaseUrl: 'https://api.a.example.test',
        },
      })
    )
    expect(app.result.current.statusText).not.toBe(
      'Profile UI could not be opened in your browser.'
    )

    act(() =>
      reportFailure?.({
        correlationId: 'current-environment-b-report',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 2,
          profileId: 'profile-b',
          profileIncarnation: 'incarnation-b',
          restBaseUrl: 'https://api.b.example.test',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('preserves early correlated failures but lets later status updates supersede them', async () => {
    const { clerum } = installAppControllerClerum({
      runtimeConfigState: {
        configured: true,
        isLocalhost: false,
        selectorVisible: true,
        activeOptionId: 'profile-a',
        currentConfig: {
          externalRestApiBaseUrl: 'https://api.example.test',
          rpcProxyBaseUrl: 'https://rpc.example.test',
          appName: 'Example',
        },
        envKey: 'example-env',
        storagePath: '/harness/runtime-configs',
        options: [
          {
            id: 'profile-a',
            label: 'Example',
            source: 'file',
            configPath: '/harness/runtime-configs/example.json',
            externalRestApiBaseUrl: 'https://api.example.test',
            rpcProxyBaseUrl: 'https://rpc.example.test',
            appName: 'Example',
            profileIncarnation: 'incarnation-a',
          },
        ],
      },
    })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))

    const dispatchFailure = (correlationId: string) =>
      reportFailure?.({
        correlationId,
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile-a',
          profileIncarnation: 'incarnation-a',
          restBaseUrl: 'https://api.example.test',
        },
      })

    act(() => dispatchFailure('early-failure'))
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    act(() =>
      app.result.current.setStatus('Password reset opened in your browser.', 'success', undefined, {
        profileUiCorrelationId: 'early-failure',
      })
    )
    expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')

    act(() =>
      app.result.current.setStatus('A later account status.', 'info', undefined, { toast: false })
    )
    expect(app.result.current.statusText).toBe('A later account status.')

    act(() => dispatchFailure('retry-failure'))
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    act(() =>
      app.result.current.setStatus('Password reset opened in your browser.', 'success', undefined, {
        profileUiCorrelationId: 'retry-success',
      })
    )
    expect(app.result.current.statusText).toBe('Password reset opened in your browser.')
    app.unmount()
  })

  it('surfaces a browser failure for the selected environment after its generation changes', async () => {
    const stateA = {
      configured: true,
      isLocalhost: false,
      selectorVisible: true,
      activeOptionId: 'profile-a',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api-a.example.test',
        rpcProxyBaseUrl: 'https://rpc-a.example.test',
        appName: 'A',
      },
      envKey: 'env-a',
      storagePath: '/harness/runtime-configs',
      options: [
        {
          id: 'profile-a',
          label: 'A',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/a.json',
          externalRestApiBaseUrl: 'https://api-a.example.test',
          rpcProxyBaseUrl: 'https://rpc-a.example.test',
          appName: 'A',
          profileIncarnation: 'incarnation-a',
        },
        {
          id: 'profile-b',
          label: 'B',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/b.json',
          externalRestApiBaseUrl: 'https://api-b.example.test',
          rpcProxyBaseUrl: 'https://rpc-b.example.test',
          appName: 'B',
          profileIncarnation: 'incarnation-b',
        },
      ],
    }
    const stateB = {
      ...stateA,
      activeOptionId: 'profile-b',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api-b.example.test',
        rpcProxyBaseUrl: 'https://rpc-b.example.test',
        appName: 'B',
      },
      envKey: 'env-b',
    }
    const { clerum, handle } = installAppControllerClerum({ runtimeConfigState: stateA })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    auth.selectRuntimeConfig = vi.fn().mockResolvedValue(stateB)
    handle.getSessionGeneration.mockResolvedValue(9)

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    await act(async () => {
      await app.result.current.handleSelectRuntimeConfig('profile-b')
    })
    act(() =>
      reportFailure?.({
        correlationId: 'selected-profile-failure',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 9,
          profileId: 'profile-b',
          profileIncarnation: 'incarnation-b',
          restBaseUrl: 'https://api-b.example.test',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('surfaces a browser failure for invitation-only setup without a selected profile', async () => {
    const { clerum } = installAppControllerClerum({ startAuthenticated: false })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    act(() =>
      reportFailure?.({
        correlationId: 'invitation-only-failure',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 1,
          profileId: null,
          profileIncarnation: null,
          restBaseUrl: 'http://127.0.0.1:8091',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    app.unmount()
  })

  it('surfaces a correlated late Profile UI dispatch failure', async () => {
    const { clerum, handle } = installAppControllerClerum({
      runtimeConfigState: {
        configured: true,
        isLocalhost: false,
        selectorVisible: true,
        activeOptionId: 'profile-a',
        currentConfig: {
          externalRestApiBaseUrl: 'https://api.example.test',
          rpcProxyBaseUrl: 'https://rpc.example.test',
          appName: 'Example',
        },
        envKey: 'example-env',
        storagePath: '/harness/runtime-configs',
        options: [
          {
            id: 'profile-a',
            label: 'Example',
            source: 'file',
            configPath: '/harness/runtime-configs/example.json',
            externalRestApiBaseUrl: 'https://api.example.test',
            rpcProxyBaseUrl: 'https://rpc.example.test',
            appName: 'Example',
            profileIncarnation: 'incarnation-a',
          },
        ],
      },
    })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    let notifySessionCleared: (() => void) | null = null
    const auth = (
      clerum as unknown as {
        auth: {
          onProfileUiDispatchFailed: ReturnType<typeof vi.fn>
          onSessionCleared: ReturnType<typeof vi.fn>
        }
      }
    ).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    auth.onSessionCleared = vi.fn((listener: () => void) => {
      notifySessionCleared = listener
      return () => undefined
    })

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    act(() =>
      reportFailure?.({
        correlationId: 'profile-action-1',
        documentLease: 'document-lease',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile-a',
          profileIncarnation: 'incarnation-a',
          restBaseUrl: 'https://api.example.test',
        },
      })
    )

    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    expect(app.result.current.statusTone).toBe('error')
    handle.getSessionState.mockImplementation(async () => ({
      authenticated: false,
      me: null,
      sessionGeneration: 2,
    }))
    act(() => notifySessionCleared?.())
    await waitFor(() =>
      expect(app.result.current.statusText).not.toBe(
        'Profile UI could not be opened in your browser.'
      )
    )
    app.unmount()
  })

  it('clears only the prior correlation before an A to B to A selection is exposed', async () => {
    const stateA = {
      configured: true,
      isLocalhost: false,
      selectorVisible: true,
      activeOptionId: 'profile-a',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api-a.example.test',
        rpcProxyBaseUrl: 'https://rpc-a.example.test',
        appName: 'A',
      },
      envKey: 'env-a',
      storagePath: '/harness/runtime-configs',
      options: [
        {
          id: 'profile-a',
          label: 'A',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/a.json',
          externalRestApiBaseUrl: 'https://api-a.example.test',
          rpcProxyBaseUrl: 'https://rpc-a.example.test',
          appName: 'A',
          profileIncarnation: 'incarnation-a',
        },
        {
          id: 'profile-b',
          label: 'B',
          source: 'file' as const,
          configPath: '/harness/runtime-configs/b.json',
          externalRestApiBaseUrl: 'https://api-b.example.test',
          rpcProxyBaseUrl: 'https://rpc-b.example.test',
          appName: 'B',
          profileIncarnation: 'incarnation-b',
        },
      ],
    }
    const stateB = {
      ...stateA,
      activeOptionId: 'profile-b',
      currentConfig: {
        externalRestApiBaseUrl: 'https://api-b.example.test',
        rpcProxyBaseUrl: 'https://rpc-b.example.test',
        appName: 'B',
      },
      envKey: 'env-b',
    }
    const { clerum } = installAppControllerClerum({ runtimeConfigState: stateA })
    let reportFailure:
      | ((failure: {
          correlationId: string
          documentLease: string
          dispatchDeadline: number
          binding: {
            sessionGeneration: number
            profileId: string | null
            profileIncarnation: string | null
            restBaseUrl: string
          }
        }) => void)
      | null = null
    const auth = (
      clerum as unknown as {
        auth: {
          onProfileUiDispatchFailed: ReturnType<typeof vi.fn>
          selectRuntimeConfig: ReturnType<typeof vi.fn>
        }
      }
    ).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: NonNullable<typeof reportFailure>) => {
      reportFailure = listener
      return () => undefined
    })
    auth.selectRuntimeConfig = vi.fn().mockResolvedValueOnce(stateB).mockResolvedValueOnce(stateA)

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    const generationBefore = app.result.current.sessionGeneration
    act(() =>
      reportFailure?.({
        correlationId: 'profile-action-a',
        documentLease: 'document-lease-a',
        dispatchDeadline: Date.now() + 5_000,
        binding: {
          sessionGeneration: 1,
          profileId: 'profile-a',
          profileIncarnation: 'incarnation-a',
          restBaseUrl: 'https://api-a.example.test',
        },
      })
    )
    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )

    await act(async () => {
      await app.result.current.handleSelectRuntimeConfig('profile-b')
    })
    await waitFor(() =>
      expect(app.result.current.statusText).not.toBe(
        'Profile UI could not be opened in your browser.'
      )
    )
    await act(async () => {
      await app.result.current.handleSelectRuntimeConfig('profile-a')
    })

    expect(app.result.current.sessionGeneration).toBe(generationBefore)
    expect(app.result.current.statusText).not.toBe(
      'Profile UI could not be opened in your browser.'
    )
    expect(app.result.current.statusTone).not.toBe('error')
    app.unmount()
  })

  it('runs the signed-out transition when main ends the session', async () => {
    const { clerum, handle } = installAppControllerClerum()
    let notifySessionCleared: (() => void) | null = null
    const auth = (clerum as unknown as { auth: { onSessionCleared: ReturnType<typeof vi.fn> } })
      .auth
    auth.onSessionCleared = vi.fn((listener: () => void) => {
      notifySessionCleared = listener
      return () => undefined
    })

    const app = renderAppController()
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    const gfsRootKey = [...desktopQueryKeys.gfsRoot, 'session-cleared-probe']
    app.queryClient.setQueryData(gfsRootKey, { held: true })
    const sessionStateCallsBefore = handle.getSessionState.mock.calls.length
    if (!notifySessionCleared) throw new Error('the controller did not subscribe to the notice')

    handle.getSessionState.mockImplementation(async () => ({
      authenticated: false,
      me: null,
      sessionGeneration: 2,
    }))
    act(() => {
      notifySessionCleared?.()
    })

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(false))
    expect(handle.getSessionState.mock.calls.length).toBeGreaterThan(sessionStateCallsBefore)
    expect(app.result.current.me).toBeNull()
    // The signed-out branch of loadSession drops every GFS query.
    expect(app.queryClient.getQueryData(gfsRootKey)).toBeUndefined()
    app.unmount()
  })
})
