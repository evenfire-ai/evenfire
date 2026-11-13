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
  it('surfaces a correlated late Profile UI dispatch failure', async () => {
    const { clerum } = installAppControllerClerum()
    let reportFailure: ((correlationId: string) => void) | null = null
    const auth = (
      clerum as unknown as {
        auth: { onProfileUiDispatchFailed: ReturnType<typeof vi.fn> }
      }
    ).auth
    auth.onProfileUiDispatchFailed = vi.fn((listener: (correlationId: string) => void) => {
      reportFailure = listener
      return () => undefined
    })

    const app = renderAppController()
    await waitFor(() => expect(reportFailure).toBeTypeOf('function'))
    act(() => reportFailure?.('profile-action-1'))

    await waitFor(() =>
      expect(app.result.current.statusText).toBe('Profile UI could not be opened in your browser.')
    )
    expect(app.result.current.statusTone).toBe('error')
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
