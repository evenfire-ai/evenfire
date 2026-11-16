// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAuthController } from '../useAuthController'

const INCORRECT = 'Email or password is incorrect.'
const GENERIC = 'Login failed. Check your email and password.'

const auth = {
  getRuntimeConfigState: vi.fn(),
  getSessionGeneration: vi.fn(),
  onDesktopSetupToken: vi.fn(),
  onDesktopEnvironmentSetup: vi.fn(),
  onExternalLogout: vi.fn(),
  onSessionCleared: vi.fn(),
  passwordLogin: vi.fn(),
  startDesktopSetup: vi.fn(),
  diagnoseLoginBackend: vi.fn(),
}

beforeEach(() => {
  auth.getRuntimeConfigState.mockResolvedValue({ options: [], selectedOptionId: null })
  auth.getSessionGeneration.mockResolvedValue(1)
  auth.onDesktopSetupToken.mockReturnValue(() => undefined)
  auth.onDesktopEnvironmentSetup.mockReturnValue(() => undefined)
  auth.onExternalLogout.mockReturnValue(() => undefined)
  auth.onSessionCleared.mockReturnValue(() => undefined)
  auth.passwordLogin.mockReset()
  auth.startDesktopSetup.mockReset()
  auth.diagnoseLoginBackend.mockReset()
  auth.diagnoseLoginBackend.mockResolvedValue(null)
  Object.defineProperty(window, 'clerum', { configurable: true, value: { auth } })
})

afterEach(() => {
  cleanup()
})

async function mountAuthController() {
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
  // The boot effect loads the session once on mount.
  await waitFor(() => expect(onSessionNeedsLoad).toHaveBeenCalledTimes(1))
  setStatus.mockClear()
  return { hook, setStatus, onSessionNeedsLoad }
}

function errorTexts(setStatus: ReturnType<typeof vi.fn>): string[] {
  return setStatus.mock.calls.filter(call => call[1] === 'error').map(call => String(call[0]))
}

describe('useAuthController password login failures', () => {
  it('does not read an unmarked 401 as a wrong password, and probes the backend', async () => {
    const { hook, setStatus } = await mountAuthController()
    auth.passwordLogin.mockRejectedValueOnce(
      new Error("Error invoking remote method 'auth:passwordLogin': Error: 401 Unauthorized: x")
    )
    act(() => {
      hook.result.current.setEmail('user@example.com')
      hook.result.current.setPassword('secret')
    })

    await act(async () => {
      await hook.result.current.handlePasswordLogin()
    })

    expect(auth.passwordLogin).toHaveBeenCalledTimes(1)
    expect(errorTexts(setStatus)).toEqual([GENERIC])
    expect(auth.diagnoseLoginBackend).toHaveBeenCalledTimes(1)
  })

  it('does not read a session-load failure after a good password as a wrong password', async () => {
    const { hook, setStatus, onSessionNeedsLoad } = await mountAuthController()
    auth.passwordLogin.mockResolvedValueOnce({ authenticated: true, me: null })
    onSessionNeedsLoad.mockRejectedValueOnce(new Error('401 Unauthorized: session load failed'))
    act(() => {
      hook.result.current.setEmail('user@example.com')
      hook.result.current.setPassword('secret')
    })

    await act(async () => {
      await hook.result.current.handlePasswordLogin()
    })

    expect(onSessionNeedsLoad).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenCalledWith('Signed in.', 'success')
    expect(errorTexts(setStatus)).toEqual([GENERIC])
    expect(errorTexts(setStatus)).not.toContain(INCORRECT)
  })

  it('shows the generic text for the local required-fields failure', async () => {
    const { hook, setStatus } = await mountAuthController()

    await act(async () => {
      await hook.result.current.handlePasswordLogin()
    })

    expect(auth.passwordLogin).not.toHaveBeenCalled()
    expect(errorTexts(setStatus)).toEqual([GENERIC])
  })
})

describe('useAuthController desktop setup failures', () => {
  async function startSetupRejectedWith(message: string) {
    const { hook, setStatus } = await mountAuthController()
    auth.startDesktopSetup.mockRejectedValueOnce(new Error(message))
    act(() => {
      hook.result.current.setEmail('user@example.com')
    })

    await act(async () => {
      await hook.result.current.handleStartDesktopSetup()
    })

    expect(auth.startDesktopSetup).toHaveBeenCalledWith('user@example.com')
    return errorTexts(setStatus)
  }

  it('recognizes the code main raises for a missing invitation', async () => {
    await expect(
      startSetupRejectedWith(
        "Error invoking remote method 'auth:startDesktopSetup': Error: invitation_config_not_found"
      )
    ).resolves.toEqual(['You must be invited to be part of a team.'])
  })

  it('recognizes the bare code', async () => {
    await expect(startSetupRejectedWith('invitation_config_not_found')).resolves.toEqual([
      'You must be invited to be part of a team.',
    ])
  })

  it.each([
    "Error invoking remote method 'auth:startDesktopSetup': Error: 500 Internal Server Error: upstream 404",
    "Error invoking remote method 'auth:startDesktopSetup': Error: not invitation_config_not_found yet",
  ])('does not read %s as a missing invitation', async message => {
    await expect(startSetupRejectedWith(message)).resolves.toEqual([
      'Desktop setup could not be started.',
    ])
  })
})
