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

describe('useAppController retained environment behavior', () => {
  it('keeps a committed environment selected when origin discovery rejects', async () => {
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
    const auth = (clerum as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth
    auth.saveRuntimeConfig.mockImplementation(async () => {
      handle.setRuntimeConfigState(stateB)
      throw new Error('Profile UI resolution is unavailable')
    })

    const app = renderAppController()
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
    expect(app.result.current.runtimeConfigState?.currentConfig).toMatchObject({
      externalRestApiBaseUrl: 'https://api.b.example.test',
      rpcProxyBaseUrl: 'https://rpc.b.example.test',
    })
    app.unmount()
  })
})
