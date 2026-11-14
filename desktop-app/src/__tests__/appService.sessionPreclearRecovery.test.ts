import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService session preclear authority recovery', () => {
  it('keeps the renderer fenced on unreadable authority and restores only after a positive retry', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    const getMe = vi.fn().mockRejectedValue(new Error('network unavailable'))
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const recoveryRequired = vi.fn((_notice: typeof notice, _state: unknown) => undefined)
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearRecoveryRequired: typeof recoveryRequired
      onSessionPreclearCancelled: typeof preclearCancelled
      pendingSessionPreclear: unknown
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearRecoveryRequired = recoveryRequired
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledOnce())

    expect(notice).not.toBeNull()
    expect(internals.pendingSessionPreclear).not.toBeNull()
    expect(preclearCancelled).not.toHaveBeenCalled()
    expect(recoveryRequired).toHaveBeenLastCalledWith(notice, {
      attemptsRemaining: 2,
      retryAvailable: true,
    })

    getMe.mockResolvedValue(login.me)
    expect(service.retrySessionPreclearRecovery(notice!)).toBe(true)
    await vi.waitFor(() => expect(preclearCancelled).toHaveBeenCalledOnce())
    expect(preclearCancelled).toHaveBeenCalledWith(notice)
    expect(internals.pendingSessionPreclear).toBeNull()
  })

  it('retires the old recovery when a real login installs a replacement token', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    const replacementLogin = { ...login, token: 'replacement-session-token' }
    let resolveOldRead!: (value: typeof login.me) => void
    const getMe = vi.fn(
      () =>
        new Promise<typeof login.me>(resolve => {
          resolveOldRead = resolve
        })
    )
    const googleLogin = vi.fn().mockResolvedValueOnce(login).mockResolvedValueOnce(replacementLogin)
    service.authClient = {
      googleLogin,
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const retired = vi.fn()
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearRetired: typeof retired
      onSessionPreclearCancelled: typeof preclearCancelled
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearRetired = retired
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledOnce())
    await service.googleLogin('replacement-login')
    expect(service.sessionToken).toBe(replacementLogin.token)

    resolveOldRead(login.me)
    await vi.waitFor(() => expect(retired).toHaveBeenCalledOnce())
    expect(retired).toHaveBeenCalledWith(notice)
    expect(preclearCancelled).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe(replacementLogin.token)
    expect(service.getCachedUserId()).toBe(login.me.id)
    expect(service.pendingSessionPreclear).toBeNull()
  })

  it('retires the captured scope when /me authoritatively returns a different team', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    const getMe = vi.fn().mockResolvedValue({ ...login.me, teamId: 'team-b' })
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const sessionCleared = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionCleared: typeof sessionCleared
      pendingSessionPreclear: unknown
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionCleared = sessionCleared
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(sessionCleared).toHaveBeenCalledOnce())

    expect(service.sessionToken).toBeNull()
    expect(service.getCachedUserId()).toBeNull()
    expect(internals.pendingSessionPreclear).toBeNull()
    expect(notice).not.toBeNull()
  })

  it('retires the captured scope when /me authoritatively rejects the session', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const { ApiError } = await import('../httpClient.js')
    const login = testLoginResult()
    const getMe = vi.fn().mockRejectedValue(new ApiError('401 Unauthorized', 401, ''))
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    const sessionCleared = vi.fn()
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (
        notice: Parameters<typeof service.retrySessionPreclearRecovery>[0]
      ) => boolean
      onSessionCleared: typeof sessionCleared
      onSessionPreclearCancelled: typeof preclearCancelled
    }
    internals.onSessionPreclear = notice => {
      queueMicrotask(() => service.acknowledgeSessionPreclear(notice))
      return true
    }
    internals.onSessionCleared = sessionCleared
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(sessionCleared).toHaveBeenCalledOnce())
    expect(getMe).toHaveBeenCalledWith(login.token, expect.any(AbortSignal))
    expect(service.sessionToken).toBeNull()
    expect(service.getCachedUserId()).toBeNull()
    expect(preclearCancelled).not.toHaveBeenCalled()
  })

  it('does not treat a timed-out authority read or its late result as recovery proof', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    let resolveLateRead!: (value: typeof login.me) => void
    const getMe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof login.me>(resolve => {
            resolveLateRead = resolve
          })
      )
      .mockResolvedValue(login.me)
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const recoveryRequired = vi.fn()
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearRecoveryRequired: typeof recoveryRequired
      onSessionPreclearCancelled: typeof preclearCancelled
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearRecoveryRequired = recoveryRequired
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(recoveryRequired).toHaveBeenLastCalledWith(notice, {
      attemptsRemaining: 2,
      retryAvailable: true,
    })
    expect(preclearCancelled).not.toHaveBeenCalled()

    expect(service.retrySessionPreclearRecovery(notice!)).toBe(true)
    await vi.waitFor(() => expect(preclearCancelled).toHaveBeenCalledOnce())
    resolveLateRead({ ...login.me, teamId: 'team-stale' })
    await Promise.resolve()
    expect(service.getCachedUserId()).toBe(login.me.id)
    expect(service.pendingSessionPreclear).toBeNull()
  }, 10_000)

  it('accepts the same authoritative binding after a generation-only advance', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    let resolveRead!: (value: typeof login.me) => void
    const getMe = vi.fn(
      () =>
        new Promise<typeof login.me>(resolve => {
          resolveRead = resolve
        })
    )
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearCancelled: typeof preclearCancelled
      sessionGeneration: number
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledOnce())
    internals.sessionGeneration += 1
    resolveRead(login.me)
    await vi.waitFor(() => expect(preclearCancelled).toHaveBeenCalledOnce())
    expect(notice).not.toBeNull()
    expect(service.pendingSessionPreclear).toBeNull()
  })

  it('fences a late authority result after Exit wins', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    let resolveRead!: (value: typeof login.me) => void
    const getMe = vi.fn(
      () =>
        new Promise<typeof login.me>(resolve => {
          resolveRead = resolve
        })
    )
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearCancelled: typeof preclearCancelled
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledOnce())
    expect(service.exitSessionPreclearRecovery(notice!)).toBe(true)
    resolveRead({ ...login.me, teamId: 'team-stale' })
    await Promise.resolve()

    expect(service.sessionToken).toBe(login.token)
    expect(service.getCachedUserId()).toBe(login.me.id)
    expect(preclearCancelled).not.toHaveBeenCalled()
    expect(service.pendingSessionPreclear).toBeNull()
  })

  it('ignores an older attempt that settles after a newer retry owns recovery', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    const readResolvers: Array<(value: typeof login.me) => void> = []
    const getMe = vi.fn(
      () =>
        new Promise<typeof login.me>(resolve => {
          readResolvers.push(resolve)
        })
    )
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const preclearCancelled = vi.fn()
    const sessionCleared = vi.fn()
    const recoveryRequired = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearRecoveryRequired: typeof recoveryRequired
      onSessionPreclearCancelled: typeof preclearCancelled
      onSessionCleared: typeof sessionCleared
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearRecoveryRequired = recoveryRequired
    internals.onSessionPreclearCancelled = preclearCancelled
    internals.onSessionCleared = sessionCleared
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(getMe).toHaveBeenCalledOnce()
    expect(service.retrySessionPreclearRecovery(notice!)).toBe(true)
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledTimes(2))

    readResolvers[0]!({ ...login.me, teamId: 'stale-team' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.sessionToken).toBe(login.token)
    expect(service.getCachedUserId()).toBe(login.me.id)
    expect(sessionCleared).not.toHaveBeenCalled()
    expect(preclearCancelled).not.toHaveBeenCalled()

    readResolvers[1]!(login.me)
    await vi.waitFor(() => expect(preclearCancelled).toHaveBeenCalledOnce())
    expect(sessionCleared).not.toHaveBeenCalled()
  }, 10_000)

  it('caps each recovery at three explicit authority attempts', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    const getMe = vi.fn().mockRejectedValue(new Error('network unavailable'))
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    let notice: Parameters<typeof service.retrySessionPreclearRecovery>[0] | null = null
    const recoveryRequired = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: NonNullable<typeof notice>) => boolean
      onSessionPreclearRecoveryRequired: typeof recoveryRequired
    }
    internals.onSessionPreclear = current => {
      notice = current
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearRecoveryRequired = recoveryRequired
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledTimes(1))
    expect(recoveryRequired).toHaveBeenLastCalledWith(notice, {
      attemptsRemaining: 2,
      retryAvailable: true,
    })
    for (const [attempt, remaining] of [2, 1, 0].entries()) {
      if (attempt > 0) expect(service.retrySessionPreclearRecovery(notice!)).toBe(true)
      await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledTimes(attempt + 1))
      expect(recoveryRequired).toHaveBeenLastCalledWith(notice, {
        attemptsRemaining: remaining,
        retryAvailable: remaining > 0,
      })
    }
    expect(service.retrySessionPreclearRecovery(notice!)).toBe(false)
  })

  it('caps unresolved authority reads across recoveries and retries only after a slot settles', async () => {
    const { service, runtimeConfig, optionB } = await createNativeCommitTestHarness()
    const login = testLoginResult()
    const readResolvers: Array<(value: typeof login.me) => void> = []
    const getMe = vi.fn(
      () =>
        new Promise<typeof login.me>(resolve => {
          readResolvers.push(resolve)
        })
    )
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe,
    } as never
    await service.googleLogin('initial-login')

    const notices: Parameters<typeof service.retrySessionPreclearRecovery>[0][] = []
    const recoveryRequired = vi.fn()
    const preclearCancelled = vi.fn()
    const internals = service as unknown as {
      onSessionPreclear: (current: (typeof notices)[number]) => boolean
      onSessionPreclearRecoveryRequired: typeof recoveryRequired
      onSessionPreclearCancelled: typeof preclearCancelled
    }
    internals.onSessionPreclear = current => {
      notices.push(current)
      queueMicrotask(() => service.acknowledgeSessionPreclear(current))
      return true
    }
    internals.onSessionPreclearRecoveryRequired = recoveryRequired
    internals.onSessionPreclearCancelled = preclearCancelled
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockRejectedValue(
      new Error('runtime operation failed')
    )

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledTimes(1), {
      timeout: 4_000,
    })
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      expect(service.retrySessionPreclearRecovery(notices[0]!)).toBe(true)
      await vi.waitFor(() => expect(recoveryRequired).toHaveBeenCalledTimes(attempt), {
        timeout: 4_000,
      })
    }
    expect(getMe).toHaveBeenCalledTimes(3)
    expect(service.exitSessionPreclearRecovery(notices[0]!)).toBe(true)

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'runtime operation failed'
    )
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(getMe).toHaveBeenCalledTimes(3)
    await vi.waitFor(() =>
      expect(recoveryRequired).toHaveBeenLastCalledWith(notices[1], {
        attemptsRemaining: 3,
        retryAvailable: false,
      })
    )
    expect(getMe).toHaveBeenCalledTimes(3)

    readResolvers[0]!(login.me)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getMe).toHaveBeenCalledTimes(3)
    expect(recoveryRequired).toHaveBeenLastCalledWith(notices[1], {
      attemptsRemaining: 3,
      retryAvailable: true,
    })
    expect(service.retrySessionPreclearRecovery(notices[1]!)).toBe(true)
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledTimes(4))
    readResolvers[3]!(login.me)
    await vi.waitFor(() => expect(preclearCancelled).toHaveBeenCalledOnce())
    readResolvers[1]!({ ...login.me, teamId: 'stale-team' })
    readResolvers[2]!({ ...login.me, teamId: 'stale-team' })
  }, 15_000)
})
