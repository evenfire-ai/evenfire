import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
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
    const { service } = await createNativeCommitTestHarness()
    const app = service as unknown as {
      authClient: { getMe: ReturnType<typeof vi.fn> }
      tokenStore: { getSessionToken: ReturnType<typeof vi.fn> }
      getSessionGeneration: () => number
    }
    app.tokenStore.getSessionToken.mockResolvedValue('synthetic-saved-session-a')
    app.authClient = {
      getMe: vi.fn().mockRejectedValue(new Error('synthetic network failure')),
    }

    await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
    expect(app.getSessionGeneration()).toBe(0)
  })

  it.each(['Google', 'password'] as const)(
    'lets a pending %s login win over a background saved-session restore',
    async provider => {
      const { service } = await createNativeCommitTestHarness()
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
        getMe: vi.fn().mockResolvedValue(restoredUser),
      }
      app.tokenStore.getSessionToken.mockResolvedValue('synthetic-saved-session-a')

      const login =
        provider === 'Google'
          ? service.googleLogin('synthetic-google-login-b')
          : service.passwordLogin('user-b@example.test', 'synthetic-password-b')
      await expect(service.getSessionState()).resolves.toEqual({ authenticated: false, me: null })
      expect(app.authClient.getMe).not.toHaveBeenCalled()

      loginResponse.resolve({ token: 'synthetic-login-session-b', me: loginUser })
      await expect(login).resolves.toMatchObject({ authenticated: true, me: loginUser })
      await expect(service.getSessionState()).resolves.toMatchObject({
        authenticated: true,
        me: loginUser,
      })
      expect(app.sessionToken).toBe('synthetic-login-session-b')
      expect(app.me).toMatchObject({ id: 'user-b' })
    }
  )

  it('keeps a restored session when its saved-session commit beats pending setup', async () => {
    const { service, runtimeConfig, restA, restB } = await createNativeCommitTestHarness()
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
      getSessionGeneration: () => number
      resolveRuntimeConfigIfNeeded: () => Promise<void>
      sessionToken: string | null
      me: { id: string; teamId: string } | null
      gfsScopeIdentity: { ownerId: string; teamId: string | null; baseUrl: string } | null
    }
    app.authClient = { getMe: vi.fn().mockResolvedValue(user) }
    app.tokenStore.getSessionToken.mockResolvedValue('synthetic-session-a')
    app.memberRegistrationServiceClient = { completeDesktopSetup: setupRequest }
    app.resolveRuntimeConfigIfNeeded = vi.fn().mockResolvedValue(undefined)

    const setup = app.completeDesktopSetup('user-a@example.test', 'synthetic-setup-token')
    await setupStarted.promise
    await expect(app.getSessionState()).resolves.toMatchObject({ authenticated: true, me: user })
    const restoredGeneration = app.getSessionGeneration()

    setupActivation.resolve({
      valid: true,
      email: 'user-a@example.test',
      externalRestApiBaseUrl: restB,
      rpcProxyBaseUrl: '',
      appName: 'Environment B',
    })

    await expect(setup).rejects.toThrow('stale_session_generation')
    expect(setupRequest).toHaveBeenCalledOnce()
    expect(runtimeConfig.config.externalRestApiBaseUrl).toBe(restA)
    expect(app.getSessionGeneration()).toBe(restoredGeneration)
    expect(app.sessionToken).toBe('synthetic-session-a')
    expect(app.me).toMatchObject({ id: 'user-a', teamId: 'team-a' })
    expect(app.gfsScopeIdentity).toMatchObject({
      ownerId: 'user-a',
      teamId: 'team-a',
      baseUrl: restA,
    })
  })

  it('discards a saved-session response superseded by a completed setup', async () => {
    const { service, runtimeConfig, restB } = await createNativeCommitTestHarness()
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
    app.tokenStore.getSessionToken.mockResolvedValue('synthetic-session-a')
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
