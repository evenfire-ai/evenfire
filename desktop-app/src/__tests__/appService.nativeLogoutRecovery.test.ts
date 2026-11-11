import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService logout recovery ownership', () => {
  it('keeps the current session when token removal fails on the same runtime boundary', async () => {
    const { service } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe: vi.fn().mockResolvedValue(login.me),
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    await expect(service.logout()).rejects.toThrow('keychain unavailable')

    expect(service.getCachedUserId()).toBe('user-a')
    expect(service.sessionToken).toBe('synthetic-session-a')
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
  })

  it('releases the renderer preclear when token removal and `/me` both fail transiently', async () => {
    const { service } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe: vi.fn().mockResolvedValue(login.me),
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))
    service.authClient.getMe = vi.fn().mockRejectedValue(new Error('network unavailable'))
    const preclearCancelled = vi.fn()
    service.onSessionPreclearCancelled = preclearCancelled

    await expect(service.logout()).rejects.toThrow('keychain unavailable')

    expect(service.getCachedUserId()).toBe('user-a')
    expect(service.sessionToken).toBe('synthetic-session-a')
    expect(service.pendingSessionPreclear).toBeNull()
    expect(preclearCancelled).toHaveBeenCalledOnce()
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
  })

  it('retires the captured session when `/me` confirms a different identity during logout recovery', async () => {
    const { service } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe: vi.fn().mockResolvedValue({ ...login.me, id: 'user-b', teamId: 'team-b' }),
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))
    const sessionCleared = vi.fn()
    service.onSessionCleared = sessionCleared

    await expect(service.logout()).rejects.toThrow('keychain unavailable')

    expect(service.sessionToken).toBeNull()
    expect(service.getCachedUserId()).toBeNull()
    expect(service.pendingSessionPreclear).toBeNull()
    expect(sessionCleared).toHaveBeenCalledOnce()
  })

  it('retires the old session when token cleanup fails after a runtime boundary change', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))
    const sessionCleared = vi.fn()
    service.onSessionCleared = sessionCleared

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow('keychain unavailable')

    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
    expect(service.sessionToken).toBeNull()
    expect(service.getCachedUserId()).toBeNull()
    expect(service.pendingSessionPreclear).toBeNull()
    expect(sessionCleared).toHaveBeenCalledOnce()
  })

  it('keeps the renderer hidden when queued logout shares a failing environment preclear', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
    } as never
    await service.googleLogin('initial-login')

    let notice: { transitionId: number; sessionGeneration: number; reason: string } | null = null
    const cancelled = vi.fn()
    service.onSessionPreclear = incoming => {
      notice = incoming
      return true
    }
    service.onSessionPreclearCancelled = cancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    const change = service.selectRuntimeConfig(optionB.id)
    await vi.waitFor(() => expect(notice).toMatchObject({ reason: 'environment-change' }))
    expect(service.acknowledgeSessionPreclear(notice)).toBe(true)
    const logout = service.logout()
    const logoutOutcome = logout.then(
      value => ({ value, error: null as unknown }),
      error => ({ value: null, error })
    )
    const changeOutcome = change.then(
      () => null,
      (error: unknown) => error
    )
    expect(await changeOutcome).toMatchObject({ message: 'runtime operation failed' })
    expect(cancelled).not.toHaveBeenCalled()
    const resolvedLogout = await logoutOutcome
    expect(resolvedLogout.error).toBeNull()
    expect(resolvedLogout.value).toBeGreaterThan(0)
    expect(service.pendingSessionPreclear).toBeNull()
    expect(service.sessionToken).toBeNull()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('releases a shared preclear when GFS suspension fails during queued logout', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
    } as never
    await service.googleLogin('initial-login')

    let notice: { transitionId: number; sessionGeneration: number; reason: string } | null = null
    const cancelled = vi.fn()
    service.onSessionPreclear = incoming => {
      notice = incoming
      return true
    }
    service.onSessionPreclearCancelled = cancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    const change = service.selectRuntimeConfig(optionB.id)
    await vi.waitFor(() => expect(notice).toMatchObject({ reason: 'environment-change' }))
    expect(service.acknowledgeSessionPreclear(notice)).toBe(true)
    const logout = service.logout()
    const duplicateLogout = service.logout()
    expect(duplicateLogout).toBe(logout)
    const changeOutcome = change.then(
      () => null,
      (error: unknown) => error
    )
    const suspendOwner = service as unknown as {
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
    }
    const originalSuspend = suspendOwner.suspendDesktopGfsUploadsForAuthBoundary
    const suspend = vi
      .spyOn(suspendOwner, 'suspendDesktopGfsUploadsForAuthBoundary')
      .mockImplementationOnce(() => originalSuspend.call(service))
      .mockRejectedValueOnce(new Error('GFS suspension failed'))
    expect(await changeOutcome).toMatchObject({ message: 'runtime operation failed' })

    await expect(logout).rejects.toThrow('GFS suspension failed')
    await expect(duplicateLogout).rejects.toThrow('GFS suspension failed')

    expect(suspend).toHaveBeenCalledTimes(2)
    expect(service.pendingSessionPreclear).toBeNull()
    expect(service.sessionToken).toBe('synthetic-session-a')
    expect(service.getCachedUserId()).toBe('user-a')
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
