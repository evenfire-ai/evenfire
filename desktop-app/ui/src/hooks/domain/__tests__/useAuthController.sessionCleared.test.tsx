// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAuthController } from '../useAuthController'

type Listener = () => void

const auth = {
  getRuntimeConfigState: vi.fn(),
  getSessionGeneration: vi.fn(),
  onDesktopSetupToken: vi.fn(),
  onDesktopEnvironmentSetup: vi.fn(),
  onExternalLogout: vi.fn(),
  onSessionCleared: vi.fn(),
}

let sessionClearedListener: Listener | null = null
const unsubscribeSessionCleared = vi.fn()

beforeEach(() => {
  sessionClearedListener = null
  unsubscribeSessionCleared.mockReset()
  auth.getRuntimeConfigState.mockResolvedValue({ options: [], selectedOptionId: null })
  auth.getSessionGeneration.mockResolvedValue(1)
  auth.onDesktopSetupToken.mockReturnValue(() => undefined)
  auth.onDesktopEnvironmentSetup.mockReturnValue(() => undefined)
  auth.onExternalLogout.mockReturnValue(() => undefined)
  auth.onSessionCleared.mockReset()
  auth.onSessionCleared.mockImplementation((listener: Listener) => {
    sessionClearedListener = listener
    return unsubscribeSessionCleared
  })
  window.clerum = { ...window.clerum, auth: { ...window.clerum?.auth, ...auth } } as never
})

afterEach(() => {
  cleanup()
})

function mountAuthController() {
  const setStatus = vi.fn()
  const onSessionNeedsLoad = vi.fn().mockResolvedValue(undefined)
  const hook = renderHook(() =>
    useAuthController({
      setStatus,
      onSessionNeedsLoad,
      onSessionEnded: vi.fn(),
      logoutForEnvironmentMismatch: vi.fn().mockResolvedValue(null),
    })
  )
  return { hook, setStatus, onSessionNeedsLoad }
}

describe('useAuthController session-cleared notice', () => {
  it('reloads the session when main reports that it ended the session', async () => {
    const { hook, setStatus, onSessionNeedsLoad } = mountAuthController()
    expect(auth.onSessionCleared).toHaveBeenCalledTimes(1)
    // The boot effect loads the session once on mount.
    await waitFor(() => expect(onSessionNeedsLoad).toHaveBeenCalledTimes(1))
    if (!sessionClearedListener) throw new Error('the hook did not subscribe to the notice')

    act(() => {
      sessionClearedListener?.()
    })

    await waitFor(() => expect(onSessionNeedsLoad).toHaveBeenCalledTimes(2))
    expect(setStatus).toHaveBeenCalledWith('Your session ended. Sign in again.', 'info')

    hook.unmount()
    expect(unsubscribeSessionCleared).toHaveBeenCalledTimes(1)
  })

  it('reports a failed reload after the session ended', async () => {
    const { setStatus, onSessionNeedsLoad } = mountAuthController()
    await waitFor(() => expect(onSessionNeedsLoad).toHaveBeenCalledTimes(1))
    onSessionNeedsLoad.mockRejectedValueOnce(new Error('restore unavailable'))

    act(() => {
      sessionClearedListener?.()
    })

    await waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith(
        'Your session ended, but the desktop could not refresh it: restore unavailable',
        'warn'
      )
    )
    expect(onSessionNeedsLoad).toHaveBeenCalledTimes(2)
  })
})
