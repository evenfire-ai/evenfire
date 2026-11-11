import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { getActiveEnvKey } from '../config.js'
import { ApiError } from '../httpClient.js'

// passwordLogin refuses to run until the desktop runtime is configured.
vi.hoisted(() => {
  process.env.EXTERNAL_REST_API_BASE_URL = 'https://api.example.test'
  process.env.RPC_PROXY_BASE_URL = 'https://rpc.example.test'
})

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/tmp/clerum-desktop-test') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))
vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

type LoginKind = 'google' | 'password'

// The only /me answer that ends a session: the edge's invalid_session envelope.
const sessionEnded = () =>
  new ApiError(
    '401 Unauthorized: invalid_session',
    401,
    JSON.stringify({
      error: {
        code: 'invalid_session',
        message: 'The session is not valid.',
        correlationId: 'synthetic-correlation',
        retryable: false,
      },
    })
  )
const sessionMe = (id: string, teamId: string | null) => ({
  id,
  email: `${id}@example.test`,
  name: id,
  picture: null,
  teamId,
  teamName: teamId,
  role: 'member',
})

function createService() {
  const tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  const onSessionCleared = vi.fn()
  const service = new AppService({ tokenStore: tokenStore as never, onSessionCleared }) as any
  service.sessionToken = 'token-a'
  service.me = sessionMe('user-a', 'team-a')
  service.beginPrewarmAuthTransition = () => () => undefined
  service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
  service.activateGfsAuthScope = vi.fn()
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  return { service, tokenStore, onSessionCleared }
}

/**
 * Session A is committed. Each login in `kinds` is reserved and its request is
 * dispatched; then `/me` rejects A. Returns the pending logins and their
 * settle functions, after checking that the rejection reached the close
 * decision and was deferred (A still committed, no notice yet).
 */
async function rejectSessionDuringLogins(kinds: LoginKind[]) {
  const built = createService()
  const { service, onSessionCleared } = built
  const endRejected = vi.spyOn(service, 'endSessionRejectedByMe')
  let rejectMe!: (error: unknown) => void
  const settlers: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> =
    []
  const pendingLogin = () =>
    new Promise((resolve, reject) => {
      settlers.push({ resolve, reject })
    })
  service.authClient = {
    getMe: vi.fn(() => new Promise((_, reject) => (rejectMe = reject))),
    googleLogin: vi.fn(pendingLogin),
    passwordLogin: vi.fn(pendingLogin),
  }
  const check = service.confirmCommittedSessionWithMe()
  const logins: Array<Promise<unknown>> = []
  for (const kind of kinds) {
    const login =
      kind === 'google'
        ? service.googleLogin('id-token')
        : service.passwordLogin('user-b@example.test', 'password')
    // Observe the outcome so an early rejection is not reported as unhandled.
    login.catch(() => undefined)
    logins.push(login)
    await vi.waitFor(() => expect(settlers).toHaveLength(logins.length))
  }

  rejectMe(sessionEnded())
  await check

  // Liveness: the rejection of A reached the close decision.
  expect(service.authClient.getMe).toHaveBeenCalledWith('token-a')
  expect(endRejected).toHaveBeenCalledTimes(1)
  expect(endRejected).toHaveBeenCalledWith('token-a')
  // Deferred: A is still committed while a login is reserved.
  expect(service.sessionToken).toBe('token-a')
  expect(onSessionCleared).not.toHaveBeenCalled()
  return { ...built, endRejected, logins, settlers }
}

function expectSessionAEnded(
  service: any,
  tokenStore: { clearSessionToken: ReturnType<typeof vi.fn> },
  onSessionCleared: ReturnType<typeof vi.fn>
) {
  expect(service.sessionToken).toBeNull()
  expect(service.me).toBeNull()
  expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledTimes(1)
  expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
  expect(tokenStore.clearSessionToken).toHaveBeenCalledWith(getActiveEnvKey(), {
    legacyEnvKeys: expect.any(Array),
  })
  expect(onSessionCleared).toHaveBeenCalledTimes(1)
}

describe('AppService session rejected by /me while a login is reserved (K4d-C01)', () => {
  it.each<LoginKind>(['google', 'password'])(
    'ends the rejected session once a failed %s login settles',
    async kind => {
      const { service, tokenStore, onSessionCleared, endRejected, logins, settlers } =
        await rejectSessionDuringLogins([kind])
      const loginFailure = new Error(`${kind} login failed`)

      settlers[0].reject(loginFailure)
      await expect(logins[0]).rejects.toBe(loginFailure)

      expectSessionAEnded(service, tokenStore, onSessionCleared)
      // It was the kept rejection, evaluated again when the login settled.
      expect(endRejected).toHaveBeenCalledTimes(2)
      expect(endRejected).toHaveBeenLastCalledWith('token-a')
      expect(service.interactiveLoginAttempts).toBe(0)
    }
  )

  it.each<LoginKind>(['google', 'password'])(
    'leaves the session installed by a successful %s login',
    async kind => {
      const { service, tokenStore, onSessionCleared, endRejected, logins, settlers } =
        await rejectSessionDuringLogins([kind])

      settlers[0].resolve({ token: 'token-b', me: sessionMe('user-b', 'team-b') })
      await expect(logins[0]).resolves.toMatchObject({ authenticated: true, me: { id: 'user-b' } })

      // Liveness: the kept rejection was evaluated and found A replaced.
      expect(endRejected).toHaveBeenCalledTimes(2)
      expect(endRejected).toHaveBeenLastCalledWith('token-a')
      expect(service.sessionToken).toBe('token-b')
      expect(service.me).toMatchObject({ id: 'user-b' })
      expect(tokenStore.setSessionToken).toHaveBeenCalledWith('token-b', expect.any(String))
      expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
      expect(onSessionCleared).not.toHaveBeenCalled()
    }
  )

  it('leaves a logout made during the login as the only sign-out', async () => {
    const { service, tokenStore, onSessionCleared, endRejected, logins, settlers } =
      await rejectSessionDuringLogins(['google'])

    await service.logout()
    expect(service.sessionToken).toBeNull()
    expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledTimes(1)

    // The logout advanced the generation, so the login can no longer install.
    settlers[0].resolve({ token: 'token-b', me: sessionMe('user-b', 'team-b') })
    await expect(logins[0]).rejects.toThrow('stale_session_generation')

    // Liveness: the kept rejection was evaluated after the logout.
    expect(endRejected).toHaveBeenCalledTimes(2)
    expect(endRejected).toHaveBeenLastCalledWith('token-a')
    // Nothing was ended, cleared, fenced or announced a second time.
    expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledTimes(1)
    expect(tokenStore.setSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).toHaveBeenCalledOnce()
    expect(service.sessionToken).toBeNull()
  })

  it('keeps the rejection until the last of two failed logins settles', async () => {
    const { service, tokenStore, onSessionCleared, endRejected, logins, settlers } =
      await rejectSessionDuringLogins(['google', 'password'])

    settlers[0].reject(new Error('google login failed'))
    await expect(logins[0]).rejects.toThrow('google login failed')
    // Liveness: the first login settled; the second still holds a reservation.
    expect(service.interactiveLoginAttempts).toBe(1)
    expect(service.sessionToken).toBe('token-a')
    expect(onSessionCleared).not.toHaveBeenCalled()

    settlers[1].reject(new Error('password login failed'))
    await expect(logins[1]).rejects.toThrow('password login failed')
    expectSessionAEnded(service, tokenStore, onSessionCleared)
    expect(endRejected).toHaveBeenLastCalledWith('token-a')
  })
})

describe('AppService workflow listing fallback when the session is replaced (K4d-C04)', () => {
  const recipe = (name: string) => ({ metadata: { namespace: 'sandbox-recipes', name } })
  type TeamOutcome = 'error' | 'empty'
  const settleTeams = (
    outcome: TeamOutcome,
    settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  ) =>
    outcome === 'error'
      ? settle.reject(new Error('teams unavailable'))
      : settle.resolve({ currentTeamId: 'team-a', items: [] })

  function listingService() {
    const built = createService()
    const { service } = built
    service.workflowTeamByKey.set('sandbox-recipes/a-old', 'team-a')
    service.authClient = {
      listTeams: vi.fn(),
      listWorkflows: vi.fn(),
      googleLogin: vi
        .fn()
        .mockResolvedValue({ token: 'token-b', me: sessionMe('user-b', 'team-c') }),
    }
    // A login replaces A, and B's own listing publishes B's map.
    const replaceWithSessionB = async () => {
      await service.googleLogin('id-token')
      expect(service.sessionToken).toBe('token-b')
      service.workflowTeamByKey.set('sandbox-recipes/b-own', 'team-c')
    }
    return { ...built, replaceWithSessionB }
  }

  it.each<TeamOutcome>(['error', 'empty'])(
    'rejects the fallback when B is installed before teams answer (%s)',
    async outcome => {
      const { service, replaceWithSessionB } = listingService()
      let teams!: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
      service.authClient.listTeams.mockImplementation(
        () => new Promise((resolve, reject) => (teams = { resolve, reject }))
      )
      const listing = service.listWorkflows()
      listing.catch(() => undefined)
      await vi.waitFor(() => expect(service.authClient.listTeams).toHaveBeenCalledTimes(1))
      expect(service.authClient.listTeams).toHaveBeenCalledWith('token-a')

      await replaceWithSessionB()
      settleTeams(outcome, teams)

      // Liveness: the listing ran to the session check and rejected there.
      await expect(listing).rejects.toThrow('stale_auth_epoch')
      expect(service.authClient.listWorkflows).not.toHaveBeenCalled()
      expect([...service.workflowTeamByKey]).toEqual([['sandbox-recipes/b-own', 'team-c']])
    }
  )

  it.each<TeamOutcome>(['error', 'empty'])(
    'rejects the fallback result when B is installed while it is in flight (%s)',
    async outcome => {
      const { service, replaceWithSessionB } = listingService()
      service.authClient.listTeams.mockImplementation(
        () => new Promise((resolve, reject) => settleTeams(outcome, { resolve, reject }))
      )
      let releaseA!: () => void
      service.authClient.listWorkflows.mockImplementation(async () => {
        await new Promise<void>(resolve => (releaseA = resolve))
        return { items: [recipe('from-a')], count: 1 }
      })
      const listing = service.listWorkflows()
      listing.catch(() => undefined)
      // Liveness: the fallback dispatched A's request.
      await vi.waitFor(() => expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1))
      expect(service.authClient.listWorkflows).toHaveBeenCalledWith('token-a')

      await replaceWithSessionB()
      releaseA()

      await expect(listing).rejects.toThrow('stale_auth_epoch')
      expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1)
      expect([...service.workflowTeamByKey]).toEqual([['sandbox-recipes/b-own', 'team-c']])
    }
  )

  it.each<TeamOutcome>(['error', 'empty'])(
    'still returns the fallback list for the same session (%s)',
    async outcome => {
      const { service } = listingService()
      service.authClient.listTeams.mockImplementation(
        () => new Promise((resolve, reject) => settleTeams(outcome, { resolve, reject }))
      )
      service.authClient.listWorkflows.mockResolvedValue({ items: [recipe('from-a')], count: 1 })

      await expect(service.listWorkflows()).resolves.toEqual({
        items: [recipe('from-a')],
        count: 1,
      })
      expect(service.authClient.listWorkflows).toHaveBeenCalledWith('token-a')
      expect(service.workflowTeamByKey.size).toBe(0)
    }
  )
})

describe('AppService session preclear acknowledgment', () => {
  it('keeps the committed token and avoids logout cleanup until the renderer acknowledges neutral UI', async () => {
    let notice: { transitionId: number; sessionGeneration: number; reason: string } | null = null
    const tokenStore = {
      clearSessionToken: vi.fn().mockResolvedValue(undefined),
      getSessionToken: vi.fn().mockResolvedValue(null),
      setSessionToken: vi.fn().mockResolvedValue(undefined),
    }
    const service = new AppService({
      tokenStore: tokenStore as never,
      onSessionPreclear: incoming => {
        notice = incoming
        return true
      },
    }) as any
    service.sessionToken = 'token-a'
    service.me = sessionMe('user-a', 'team-a')
    service.beginPrewarmAuthTransition = () => () => undefined
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)

    const logout = service.logout()
    await vi.waitFor(() => expect(notice).toMatchObject({ reason: 'logout' }))

    expect(service.sessionToken).toBe('token-a')
    expect(service.suspendDesktopGfsUploadsForAuthBoundary).not.toHaveBeenCalled()
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()

    expect(service.acknowledgeSessionPreclear(notice)).toBe(true)
    await expect(logout).resolves.toBeGreaterThan(0)
    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledOnce()
    expect(tokenStore.clearSessionToken).toHaveBeenCalledOnce()
    expect(service.sessionToken).toBeNull()
  })
})
