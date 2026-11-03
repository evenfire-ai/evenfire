import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

let sessionTokenCounter = 0
function sessionTokenFor(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'test', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      jti: `native-commit-${++sessionTokenCounter}`,
    })
  ).toString('base64url')
  return `${header}.${payload}.test-signature`
}

describe('AppService native auth and environment commit ordering', () => {
  it('allows login-screen selection after LP while exact source cleanup is pending', async () => {
    const { service, runtimeConfig, restA, optionB } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    await service.passwordLogin(me.email, 'fixture-password')

    const { TokenStore } = await import('../tokenStore.js')
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const tokenStore = service.tokenStore as unknown as InstanceType<typeof TokenStore>
    const oldEnvKey = runtimeConfig.resolveEnvKey(restA, 'https://rpc-a.example.test')
    const storageScope = await tokenStore.createSessionAuthorityStorageScope()
    const authority = new SessionAuthorityRecordRepository(storageScope, oldEnvKey, tokenStore)
    const before = authority.observe()
    expect(before.status).toBe('observed')
    if (before.status !== 'observed') throw new Error('accepted source was not observable')
    expect(before.record.frame.mode).toBe('persistent')
    const acceptedSource = before.record.frame.source
    expect(acceptedSource).not.toBeNull()

    const cleanupStarted = deferred<void>()
    const allowCleanup = deferred<void>()
    const cleanupFinished = deferred<void>()
    vi.spyOn(tokenStore, 'deleteSessionCredentialSourceIfUnselectedWithProof').mockImplementation(
      async () => {
        cleanupStarted.resolve()
        try {
          await allowCleanup.promise
          throw new Error('simulated native cleanup failure')
        } finally {
          cleanupFinished.resolve()
        }
      }
    )
    vi.spyOn(tokenStore, 'clearSessionToken').mockRejectedValue(
      new Error('legacy broad clear must not gate environment handoff')
    )

    const logout = await service.logout()
    expect(logout).toMatchObject({ kind: 'committed', cleanup: 'pending' })
    await cleanupStarted.promise

    try {
      const selection = await service.selectRuntimeConfigForHandoff(
        optionB.id,
        logout.sessionGeneration
      )
      expect(selection.runtimeConfigState.activeOptionId).toBe(optionB.id)
      expect(service.sessionToken).toBeNull()
      expect(service.me).toBeNull()
    } finally {
      allowCleanup.resolve()
      await cleanupFinished.promise
    }
    const after = authority.observe()
    expect(after.status).toBe('observed')
    if (after.status !== 'observed') throw new Error('logout authority was not observable')
    expect(after.record.frame.mode).toBe('logged-out')
    expect(after.record.cleanupDebts).toEqual([expect.objectContaining({ source: acceptedSource })])
    expect(token).toBeTruthy()
  })

  it('persists real version-2 GFS state as suspended_auth on logout', async () => {
    const { service } = await createNativeCommitTestHarness()
    const me = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    await service.passwordLogin(me.email, 'fixture-password')
    const app = service as unknown as {
      gfsScopeIdentity: {
        ownerId: string
        teamId: string | null
        environmentKey: string
        baseUrl: string
      }
      gfsAuthEpoch: number
      persistDesktopGfsUpload(record: unknown): Promise<void>
      desktopGfsUploadStatePath(): Promise<string>
    }
    const identity = app.gfsScopeIdentity
    const uploadId = '92929292-9292-4292-8292-929292929292'
    await app.persistDesktopGfsUpload({
      version: 2,
      uploadId,
      filePath: '/tmp/payload.bin',
      fileName: 'payload.bin',
      fileSize: 4,
      target: { operation: 'create', parentRid: 'parent-a' },
      name: 'payload.bin',
      session: {
        uploadId,
        drive: 'main',
        operation: 'create',
        expectedBytes: 4,
        partBytes: 4,
        partCount: 1,
        state: 'uploading',
        contiguousBytes: 0,
        committedBytes: 0,
        committedPartCount: 0,
        activePartCount: 0,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      scope: { ...identity, drive: 'main', authEpoch: app.gfsAuthEpoch },
      status: 'active',
      updatedAt: new Date().toISOString(),
    })

    await service.logout()

    const statePath = await app.desktopGfsUploadStatePath()
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      version: number
      records: Array<{ uploadId: string; status: string }>
    }
    expect(state.version).toBe(2)
    expect(state.records).toEqual([expect.objectContaining({ uploadId, status: 'suspended_auth' })])
  })

  it('binds password login after logout-first selection to the selected profile', async () => {
    const { service, runtimeConfig, restA, restB, optionB } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const userA = {
      id: 'user-a',
      email: 'user-a@example.test',
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const userB = { ...userA, id: 'user-b', email: 'user-b@example.test' }
    const tokenA = sessionTokenFor(userA.id)
    const tokenB = sessionTokenFor(userB.id)
    const loginStarted = deferred<void>()
    const releaseLogin = deferred<void>()
    let handoffRequestRest = ''
    service.authClient = {
      passwordLogin: vi.fn(async (email: string) => {
        if (email === userB.email) {
          handoffRequestRest = runtimeConfig.config.externalRestApiBaseUrl
          loginStarted.resolve()
          await releaseLogin.promise
          return { token: tokenB, me: userB }
        }
        return { token: tokenA, me: userA }
      }),
      getMe: vi.fn(async (token: string) => (token === tokenB ? userB : userA)),
    } as never
    await service.passwordLogin(userA.email, 'fixture-password')
    const logout = await service.logout()
    expect(logout).toMatchObject({ kind: 'committed' })
    if (logout.kind !== 'committed') throw new Error('logout did not commit before handoff')

    let handoffLogin: Promise<unknown> | undefined
    const selectReal = runtimeConfig.selectDesktopRuntimeConfigOption.bind(runtimeConfig)
    vi.spyOn(runtimeConfig, 'selectDesktopRuntimeConfigOption').mockImplementation(async id => {
      if (id === optionB.id) handoffLogin = service.passwordLogin(userB.email, 'fixture-password')
      await selectReal(id)
    })

    const selection = await service.selectRuntimeConfigForHandoff(
      optionB.id,
      logout.sessionGeneration
    )
    await loginStarted.promise
    releaseLogin.resolve()
    const loginOutcome = await handoffLogin

    expect(selection.runtimeConfigState.activeOptionId).toBe(optionB.id)
    expect(handoffRequestRest).toBe(restB)
    expect(handoffRequestRest).not.toBe(restA)
    expect(loginOutcome).toMatchObject({ authenticated: true, me: { id: userB.id } })
    expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionB.id)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: { id: userB.id },
    })
    expect(service.gfsScopeIdentity).toMatchObject({
      ownerId: userB.id,
      environmentKey: runtimeConfig.getDesktopRuntimeConfigState().envKey,
      baseUrl: restB,
    })
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
  })

  it('rejects desktop setup while preserving the active authenticated environment', async () => {
    const { service, runtimeConfig, restA, restB } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    const setupRequest = vi.fn().mockResolvedValue({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
      appName: 'Environment B',
    })
    const serviceInternals = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      getSessionGeneration: () => number
    }
    serviceInternals.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }

    await service.passwordLogin(me.email, 'fixture-password')
    const runtimeBeforeSetup = runtimeConfig.getDesktopRuntimeConfigState()
    const generationBeforeSetup = serviceInternals.getSessionGeneration()
    const gfsScopeBeforeSetup = service.gfsScopeIdentity

    await expect(
      serviceInternals.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    ).rejects.toThrow('desktop_setup_requires_signout')

    expect(setupRequest).not.toHaveBeenCalled()
    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(runtimeBeforeSetup)
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(service.sessionToken).toBe(token)
    expect(service.getCachedUserId()).toBe('user-a')
    await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: true, me })
    expect(serviceInternals.getSessionGeneration()).toBe(generationBeforeSetup)
    expect(service.gfsScopeIdentity).toEqual(gfsScopeBeforeSetup)
  })

  it('rejects desktop setup while an explicit login is in flight', async () => {
    const { service } = await createNativeCommitTestHarness()
    const loginStarted = deferred<void>()
    const loginResponse = deferred<{
      token: string
      me: { id: string; email: string; teamId: string }
    }>()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn(() => {
        loginStarted.resolve()
        return loginResponse.promise
      }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    const setupRequest = vi.fn().mockRejectedValue(new Error('unexpected setup dispatch'))
    const serviceInternals = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
    }
    serviceInternals.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }

    const login = service.passwordLogin(me.email, 'fixture-password')
    await loginStarted.promise
    const generationDuringLogin = service.getSessionGeneration()
    const setupOutcome = await serviceInternals
      .completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
      .then(
        () => ({ error: null as unknown }),
        error => ({ error })
      )
    const generationAfterSetup = service.getSessionGeneration()
    loginResponse.resolve({ token, me })
    const loginOutcome = await login.then(
      result => ({ result, error: null as unknown }),
      error => ({ result: null, error })
    )

    expect(setupOutcome.error).toBeInstanceOf(Error)
    expect((setupOutcome.error as Error).message).toBe('auth_transition_in_progress')
    expect(setupRequest).not.toHaveBeenCalled()
    expect(generationAfterSetup).toBe(generationDuringLogin)
    expect(loginOutcome.error).toBeNull()
    expect(loginOutcome.result).toMatchObject({ authenticated: true, me })
    expect(service.getSessionGeneration()).toBe(generationDuringLogin + 1)
  })

  it('uses the captured generation when login wins before setup dispatch', async () => {
    const { service } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    const setupRequest = vi.fn().mockResolvedValue({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: 'https://api-b.example.test',
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
      appName: 'Environment B',
    })
    const app = service as unknown as {
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      withNativeAuthEnvironmentCommit<T>(operation: () => Promise<T>): Promise<T>
    }
    app.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }
    const originalCommit = app.withNativeAuthEnvironmentCommit.bind(service)
    let commitCount = 0
    app.withNativeAuthEnvironmentCommit = async operation => {
      commitCount += 1
      if (commitCount === 2) {
        app.withNativeAuthEnvironmentCommit = originalCommit
        await service.passwordLogin(me.email, 'fixture-password')
      }
      return originalCommit(operation)
    }

    await expect(
      app.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    ).rejects.toThrow('stale_session_generation')

    expect(setupRequest).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe(token)
    expect(service.getCachedUserId()).toBe('user-a')
  })

  it('rejects stale selection during login and permits selection after logout', async () => {
    const { service, runtimeConfig, optionB, restA, restB } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const loginStarted = deferred<void>()
    const loginResponse = deferred<{
      token: string
      me: { id: string; email: string; teamId: string }
    }>()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn(() => {
        loginStarted.resolve()
        return loginResponse.promise
      }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never

    const nextConfig = {
      appName: 'Environment B',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: 'https://rpc-b.example.test',
    }
    const saveRuntimeConfigForHandoff = service.saveRuntimeConfig.bind(service) as (
      config: Parameters<typeof service.saveRuntimeConfig>[0],
      expectedSessionGeneration: number
    ) => Promise<unknown>
    const expectedGeneration = service.getSessionGeneration()
    const login = service.passwordLogin(me.email, 'fixture-password')
    await loginStarted.promise
    const generationDuringLogin = service.getSessionGeneration()

    await expect(
      service.selectRuntimeConfigForHandoff(optionB.id, expectedGeneration)
    ).rejects.toThrow('stale_session_generation')
    await expect(
      service.selectRuntimeConfigForHandoff(optionB.id, generationDuringLogin)
    ).rejects.toThrow('auth_transition_in_progress')
    await expect(saveRuntimeConfigForHandoff(nextConfig, expectedGeneration)).rejects.toThrow(
      'stale_session_generation'
    )
    await expect(saveRuntimeConfigForHandoff(nextConfig, generationDuringLogin)).rejects.toThrow(
      'auth_transition_in_progress'
    )
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)

    loginResponse.resolve({ token, me })
    await expect(login).resolves.toMatchObject({ authenticated: true, me })
    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('logout did not commit before selection')
    const selection = await service.selectRuntimeConfigForHandoff(
      optionB.id,
      logout.sessionGeneration
    )
    expect(selection.runtimeConfigState.activeOptionId).toBe(optionB.id)
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restB)
    expect(service.sessionToken).toBeNull()
    await expect(service.getSessionState()).resolves.toMatchObject({ authenticated: false })
    await expect(
      saveRuntimeConfigForHandoff(nextConfig, service.getSessionGeneration())
    ).resolves.toBeDefined()
  })

  it('rejects environment selection while a memory-only owner is authenticated', async () => {
    const { service, runtimeConfig, optionB, restA } = await createNativeCommitTestHarness()
    const me = { id: 'user-a', email: 'user-a@example.test', teamId: 'team-a' }
    const token = sessionTokenFor(me.id)
    service.authClient = {
      passwordLogin: vi.fn().mockResolvedValue({ token, me }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    await service.passwordLogin(me.email, 'fixture-password')
    const startingGeneration = service.getSessionGeneration()

    await expect(
      service.selectRuntimeConfigForHandoff(optionB.id, startingGeneration)
    ).rejects.toThrow('desktop_setup_requires_signout')

    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(service.sessionToken).toBe(token)
    expect(service.getCachedUserId()).toBe(me.id)
    expect(service.getSessionGeneration()).toBe(startingGeneration)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me,
    })
  })

  it('keeps generic selection blocked until explicit logout and restart remains signed out', async () => {
    const { service, runtimeConfig, restA, restB, optionB } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const tokenA = sessionTokenFor('user-a')
    const userA = { id: 'user-a' }
    const passwordLogin = vi.fn().mockResolvedValue({ token: tokenA, me: userA })
    service.authClient = {
      passwordLogin,
      getMe: vi.fn().mockResolvedValue(userA),
    } as never
    await service.passwordLogin('initial@example.test', 'fixture-password')
    const runtimeBefore = runtimeConfig.getDesktopRuntimeConfigState()
    const sourceBefore = await service.tokenStore.getSessionToken(runtimeConfig.getActiveEnvKey())
    const { SessionAuthorityRecordRepository } = await import('../sessionAuthorityRecord.js')
    const storageScope = await service.tokenStore.createSessionAuthorityStorageScope()
    const authority = new SessionAuthorityRecordRepository(
      storageScope,
      runtimeConfig.getActiveEnvKey(),
      service.tokenStore
    )
    const authorityBefore = authority.observe()
    expect(authorityBefore.status).toBe('observed')
    if (authorityBefore.status !== 'observed') throw new Error('accepted source was not observable')
    const generationBefore = service.getSessionGeneration()
    passwordLogin.mockClear()

    await expect(service.selectRuntimeConfig(optionB.id)).rejects.toThrow(
      'desktop_setup_requires_signout'
    )

    expect(runtimeConfig.getDesktopRuntimeConfigState()).toEqual(runtimeBefore)
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(runtimeConfig.config.externalRestApiBaseUrl).not.toBe(restB)
    expect(passwordLogin).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe(tokenA)
    expect(await service.tokenStore.getSessionToken(runtimeConfig.getActiveEnvKey())).toBe(
      sourceBefore
    )
    expect(service.getSessionGeneration()).toBe(generationBefore)
    expect(authority.observe()).toEqual(authorityBefore)
    await expect(service.getSessionState()).resolves.toMatchObject({
      authenticated: true,
      me: userA,
    })

    const logout = await service.logout()
    if (logout.kind !== 'committed') throw new Error('logout did not commit before selection')
    const selection = await service.selectRuntimeConfigForHandoff(
      optionB.id,
      logout.sessionGeneration
    )
    expect(selection.runtimeConfigState.activeOptionId).toBe(optionB.id)
    expect(service.sessionToken).toBeNull()
    const selectedB = await service.tokenStore.getSessionToken(runtimeConfig.getActiveEnvKey())
    expect(selectedB).toBeNull()

    const { PROFILE_SESSION_AUTHORITY_ENV_KEY } = await import('../sessionAuthorityRecord.js')
    const profileScope = await service.tokenStore.createSessionAuthorityStorageScope()
    const profile = new SessionAuthorityRecordRepository(
      profileScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      service.tokenStore
    ).observeProfileSelection()
    expect(profile.status).toBe('observed')
    if (profile.status !== 'observed') throw new Error('profile selector was not observable')
    expect(profile.selection).toMatchObject({ state: 'signed-out' })

    const { AppService } = await import('../appService.js')
    const { TokenStore } = await import('../tokenStore.js')
    const restarted = new AppService()
    const getMe = vi.fn().mockResolvedValue(userA)
    restarted.authClient = {
      getMe,
    } as never
    restarted.tokenStore = new TokenStore() as never
    await expect(restarted.initialize()).resolves.toMatchObject({ authenticated: false })
    expect(restarted.sessionToken).toBeNull()
    expect(getMe).not.toHaveBeenCalled()
    expect(authority.observe()).not.toEqual(authorityBefore)
  })
})
