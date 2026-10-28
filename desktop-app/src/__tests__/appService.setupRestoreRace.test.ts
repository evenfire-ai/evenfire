import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistAcceptedPasswordSession } from '../../testSupport/acceptedPasswordSession.js'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testSessionTokenForIdentity } from '../../testSupport/authTestFixtures.js'
import type { SessionMe } from '../types.js'

afterEach(cleanupNativeCommitTestHarness)

type SetupActivation = {
  valid: boolean
  email: string
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
  appName: string
}

describe('AppService setup and saved-session ownership', () => {
  it('does not advance the session generation when saved-session restore fails while signed out', async () => {
    const { service, runtimeConfig } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const app = service as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
      getSessionGeneration: () => number
    }
    const savedToken = testSessionTokenForIdentity('user-a', 'team-a')
    await service.tokenStore.setSessionToken(savedToken, runtimeConfig.getActiveEnvKey())
    service.tokenStore.setSessionToken.mockClear()
    app.authClient = {
      getMe: vi.fn().mockRejectedValue(new Error('synthetic network failure')),
    }

    await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
    expect(app.getSessionGeneration()).toBe(0)
  })

  it.each(['Google', 'password'] as const)(
    'lets a pending %s login win over a background saved-session restore',
    async provider => {
      const { service, runtimeConfig } = await createNativeCommitTestHarness({
        keytarAvailable: true,
      })
      const restoredUser = {
        id: 'user-a',
        email: 'user-a@example.test',
        name: 'User A',
        picture: null,
        teamId: 'team-a',
        teamName: 'Team A',
        role: 'member',
      }
      const loginResponse = deferred<{ token: string; me: SessionMe }>()
      const loginUser = {
        id: 'user-b',
        email: 'user-b@example.test',
        name: 'User B',
        picture: null,
        teamId: 'team-b',
        teamName: 'Team B',
        role: 'member',
      }
      const loginToken = testSessionTokenForIdentity(loginUser.id, loginUser.teamId)
      const savedToken = testSessionTokenForIdentity(restoredUser.id, restoredUser.teamId)
      const app = service as unknown as {
        authClient: {
          googleLogin: ReturnType<typeof vi.fn>
          passwordLogin: ReturnType<typeof vi.fn>
          getMe: ReturnType<typeof vi.fn>
        }
        tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
        sessionToken: string | null
        me: { id: string } | null
      }
      app.authClient = {
        googleLogin: vi.fn(() => loginResponse.promise),
        passwordLogin: vi.fn(() => loginResponse.promise),
        getMe: vi.fn(async (token: string) => (token === loginToken ? loginUser : restoredUser)),
      }
      await service.tokenStore.setSessionToken(savedToken, runtimeConfig.getActiveEnvKey())
      service.tokenStore.setSessionToken.mockClear()

      const login =
        provider === 'Google'
          ? service.googleLogin('synthetic-google-login-b')
          : service.passwordLogin('user-b@example.test', 'synthetic-password-b')
      await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
      expect(app.authClient.getMe).not.toHaveBeenCalled()

      loginResponse.resolve({ token: loginToken, me: loginUser })
      await expect(login).resolves.toMatchObject({ authenticated: true, me: loginUser })
      await expect(service.getSessionState()).resolves.toMatchObject({
        authenticated: true,
        me: loginUser,
      })
      expect(app.sessionToken).toBe(loginToken)
      expect(app.me).toMatchObject({ id: 'user-b' })
    }
  )

  it('rejects setup for B while A remains the durable selected session', async () => {
    const { service, runtimeConfig, restA, userDataDir } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const user = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const savedToken = testSessionTokenForIdentity(user.id, user.teamId)
    const setupRequest = vi.fn()
    const app = service as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      getSessionState: () => Promise<unknown>
      getSessionGeneration: () => number
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      sessionToken: string | null
      me: { id: string; teamId: string } | null
      gfsScopeIdentity: { ownerId: string; teamId: string | null; baseUrl: string } | null
    }
    app.authClient = { getMe: vi.fn().mockResolvedValue(user) }
    await persistAcceptedPasswordSession({
      tokenStore: service.tokenStore,
      userDataDirectory: userDataDir,
      token: savedToken,
      me: user,
    })
    service.tokenStore.setSessionToken.mockClear()
    app.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }
    app.resolveRuntimeConfigIfNeeded = vi.fn().mockResolvedValue(undefined)

    await expect(
      app.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    ).rejects.toThrow('desktop_setup_requires_signout')
    expect(setupRequest).not.toHaveBeenCalled()

    await expect(app.getSessionState()).resolves.toMatchObject({ authenticated: true, me: user })
    const restoredGeneration = app.getSessionGeneration()
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(app.getSessionGeneration()).toBe(restoredGeneration)
    expect(app.sessionToken).toBe(savedToken)
    expect(app.me).toMatchObject({ id: 'user-a', teamId: 'team-a' })
    expect(app.gfsScopeIdentity).toMatchObject({
      ownerId: 'user-a',
      teamId: 'team-a',
      baseUrl: restA,
    })
  })

  it('discards a saved-session response superseded by a completed setup', async () => {
    const { service, runtimeConfig, restB } = await createNativeCommitTestHarness({
      keytarAvailable: true,
    })
    const setupActivation = deferred<SetupActivation>()
    const setupStarted = deferred<void>()
    const user = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const savedToken = testSessionTokenForIdentity(user.id, user.teamId)
    const restoredUser = deferred<typeof user>()
    const setupRequest = vi.fn(() => {
      setupStarted.resolve()
      return setupActivation.promise
    })
    const app = service as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
      memberRegistrationServiceClient: { completeDesktopSetup: typeof setupRequest }
      completeDesktopSetup: (email: string, authorizationToken: string) => Promise<unknown>
      getSessionState: () => Promise<unknown>
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      sessionToken: string | null
      me: { id: string; teamId: string } | null
    }
    app.authClient = {
      getMe: vi.fn().mockReturnValue(restoredUser.promise),
    }
    await service.tokenStore.setSessionToken(savedToken, runtimeConfig.getActiveEnvKey())
    service.tokenStore.setSessionToken.mockClear()
    app.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }
    app.resolveRuntimeConfigIfNeeded = vi.fn().mockResolvedValue(undefined)

    const setup = app.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    await setupStarted.promise
    const restore = app.getSessionState()

    setupActivation.resolve({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: '',
      appName: 'Environment B',
    })
    await setup
    restoredUser.resolve(user)

    await expect(restore).resolves.toEqual({ authenticated: false, me: null })
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restB)
    expect(app.sessionToken).toBeNull()
    expect(app.me).toBeNull()
  })
})
