import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { getActiveEnvKey } from '../config.js'
import { ApiError } from '../httpClient.js'
import type { SessionMe } from '../types.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

type Mock = ReturnType<typeof vi.fn>

type TestService = {
  sessionToken: string | null
  me: SessionMe | null
  workflowTeamByKey: Map<string, string>
  authClient: Record<string, Mock>
  suspendDesktopGfsUploadsForAuthBoundary: Mock
  runWithTeamContext<T>(
    teamId: string | null,
    operation: (sessionToken: string) => Promise<T>
  ): Promise<T>
  listWorkflows(): Promise<unknown>
  switchTeam(teamId: string): Promise<unknown>
}

function sessionMe(overrides: Partial<SessionMe> = {}): SessionMe {
  return {
    id: 'user-a',
    email: 'user-a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member',
    ...overrides,
  }
}

// A bare 401: what a non-/me call answers, and what /me answers when the edge's own
// service credential is refused. It is never a verdict on the session.
function unauthorized(): ApiError {
  return new ApiError('401 Unauthorized', 401, '{"error":"Unauthorized"}')
}

// The only /me answer that ends a session: the edge's invalid_session envelope.
function sessionEnded(): ApiError {
  return new ApiError(
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
}

function createService(me: SessionMe) {
  const tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  const onSessionCleared = vi.fn()
  const service = new AppService({
    tokenStore: tokenStore as never,
    onSessionCleared,
  }) as unknown as TestService
  service.sessionToken = 'synthetic-session-token'
  service.me = me
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  return { service, tokenStore, onSessionCleared }
}

function expectSessionEnded(
  service: TestService,
  tokenStore: { clearSessionToken: Mock },
  onSessionCleared: Mock
) {
  expect(service.sessionToken).toBeNull()
  expect(service.me).toBeNull()
  expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
  expect(tokenStore.clearSessionToken).toHaveBeenCalledWith(getActiveEnvKey(), {
    legacyEnvKeys: expect.any(Array),
  })
  expect(onSessionCleared).toHaveBeenCalledTimes(1)
}

describe('AppService session rejected by /me', () => {
  it('ends the session when /me rejects it during a team-context lookup', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe({ teamId: null }))
    const rejection = sessionEnded()
    const fenced: Array<{ token: string | null; ownerId: unknown }> = []
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(
      async (identity?: { ownerId?: string }) => {
        fenced.push({ token: service.sessionToken, ownerId: identity?.ownerId })
      }
    )
    service.authClient = { getMe: vi.fn().mockRejectedValue(rejection) }
    const operation = vi.fn()

    await expect(service.runWithTeamContext('team-b', operation)).rejects.toBe(rejection)

    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.authClient.getMe).toHaveBeenCalledWith('synthetic-session-token')
    expect(operation).not.toHaveBeenCalled()
    // The uploads of the rejected session are fenced before it is cleared, with its identity.
    expect(fenced).toEqual([{ token: 'synthetic-session-token', ownerId: 'user-a' }])
    expectSessionEnded(service, tokenStore, onSessionCleared)
  })

  it('keeps the session when /me fails without rejecting it', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe({ teamId: null }))
    const unavailable = new ApiError('503 Service Unavailable', 503, '')
    service.authClient = { getMe: vi.fn().mockRejectedValue(unavailable) }

    await expect(service.runWithTeamContext('team-b', vi.fn())).rejects.toBe(unavailable)

    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.sessionToken).toBe('synthetic-session-token')
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
  })

  it.each([
    ['a bare 401 (the edge service credential)', unauthorized()],
    ['a 401 that is not JSON', new ApiError('401 Unauthorized', 401, 'Unauthorized')],
    ['a 403', new ApiError('403 Forbidden', 403, '{"error":"Forbidden"}')],
    ['a 410', new ApiError('410 Gone', 410, '')],
  ])('keeps the session when /me answers %s during a team-context lookup', async (_name, error) => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe({ teamId: null }))
    service.authClient = { getMe: vi.fn().mockRejectedValue(error) }
    const operation = vi.fn()

    await expect(service.runWithTeamContext('team-b', operation)).rejects.toBe(error)

    // /me was asked, and its answer was not the session-ended envelope.
    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.authClient.getMe).toHaveBeenCalledWith('synthetic-session-token')
    expect(operation).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe('synthetic-session-token')
    expect(service.suspendDesktopGfsUploadsForAuthBoundary).not.toHaveBeenCalled()
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
  })

  it('leaves a newer committed session alone when /me rejects the old token', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe({ teamId: null }))
    const rejection = sessionEnded()
    const newerMe = sessionMe({ id: 'user-a', teamId: 'team-c' })
    service.authClient = {
      getMe: vi.fn(async () => {
        service.sessionToken = 'newer'
        service.me = newerMe
        throw rejection
      }),
    }

    await expect(service.runWithTeamContext('team-b', vi.fn())).rejects.toBe(rejection)

    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.sessionToken).toBe('newer')
    expect(service.me).toBe(newerMe)
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
  })

  it('stops a workflow listing and ends the session when /me rejects it', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe({ teamId: null }))
    const rejection = sessionEnded()
    service.workflowTeamByKey.set('sandbox-recipes/stale', 'team-old')
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: null,
        items: [
          { id: 'team-a', name: 'Team A', role: 'member' },
          { id: 'team-b', name: 'Team B', role: 'member' },
        ],
      }),
      getMe: vi.fn().mockRejectedValue(rejection),
      listWorkflows: vi.fn(),
    }

    await expect(service.listWorkflows()).rejects.toBe(rejection)

    expect(service.authClient.listTeams).toHaveBeenCalledTimes(1)
    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.authClient.listWorkflows).not.toHaveBeenCalled()
    expect(service.workflowTeamByKey.size).toBe(0)
    expectSessionEnded(service, tokenStore, onSessionCleared)
  })

  it('stops a workflow listing when a team hop ended the session with another error', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    // A failure after the hop token was issued ends the session by the existing rule in
    // switchSessionToTeam. The trigger is a token-store write, not /me: only a rejection
    // from /me is a reason of its own to end the session.
    const unavailable = new Error('keychain write failed')
    tokenStore.setSessionToken.mockRejectedValue(unavailable)
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: 'team-a',
        items: [
          { id: 'team-b', name: 'Team B', role: 'member' },
          { id: 'team-c', name: 'Team C', role: 'member' },
        ],
      }),
      switchTeam: vi.fn().mockResolvedValue({
        token: 'synthetic-session-team-b',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue(sessionMe({ teamId: 'team-b' })),
      listWorkflows: vi.fn(),
    }

    await expect(service.listWorkflows()).rejects.toBe(unavailable)

    // The hop issued a replacement token and then failed, so main ended the
    // session; the listing must not continue to the next team.
    expect(service.authClient.switchTeam).toHaveBeenCalledTimes(1)
    expect(service.authClient.listWorkflows).not.toHaveBeenCalled()
    expect(service.sessionToken).toBeNull()
    expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
  })

  it('ends the session when a team call answers 401 and /me rejects the session', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    const rejection = unauthorized()
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: 'team-a',
        items: [
          { id: 'team-a', name: 'Team A', role: 'member' },
          { id: 'team-b', name: 'Team B', role: 'member' },
        ],
      }),
      listWorkflows: vi.fn().mockRejectedValue(rejection),
      switchTeam: vi.fn(),
      getMe: vi.fn().mockRejectedValue(sessionEnded()),
    }

    await expect(service.listWorkflows()).rejects.toBe(rejection)

    expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1)
    expect(service.authClient.switchTeam).not.toHaveBeenCalled()
    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.authClient.getMe).toHaveBeenCalledWith('synthetic-session-token')
    expectSessionEnded(service, tokenStore, onSessionCleared)
  })

  it('keeps the session when a team call answers 401 and /me answers a bare 401', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    const rejection = unauthorized()
    const meAnswer = unauthorized()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: 'team-a',
        items: [{ id: 'team-a', name: 'Team A', role: 'member' }],
      }),
      listWorkflows: vi.fn().mockRejectedValue(rejection),
      switchTeam: vi.fn(),
      getMe: vi.fn().mockRejectedValue(meAnswer),
    }

    try {
      await expect(service.listWorkflows()).rejects.toBe(rejection)
      // /me was asked and gave no verdict, so the session stays.
      expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('[AppService] Session check returned no verdict:', meAnswer)
    } finally {
      warn.mockRestore()
    }
    expect(service.sessionToken).toBe('synthetic-session-token')
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
  })

  describe('listing without a team list (F9)', () => {
    const teamListings = [
      ['the team list fails', () => vi.fn().mockRejectedValue(new ApiError('503', 503, ''))],
      ['the team list is empty', () => vi.fn().mockResolvedValue({ currentTeamId: '', items: [] })],
    ] as const

    it.each(teamListings)(
      'ends the session when %s, the fallback answers 401 and /me ends the session',
      async (_name, listTeams) => {
        const { service, tokenStore, onSessionCleared } = createService(sessionMe())
        const rejection = unauthorized()
        service.authClient = {
          listTeams: listTeams(),
          listWorkflows: vi.fn().mockRejectedValue(rejection),
          getMe: vi.fn().mockRejectedValue(sessionEnded()),
        }

        await expect(service.listWorkflows()).rejects.toBe(rejection)

        expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1)
        expect(service.authClient.listWorkflows).toHaveBeenCalledWith('synthetic-session-token')
        expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
        expect(service.authClient.getMe).toHaveBeenCalledWith('synthetic-session-token')
        expectSessionEnded(service, tokenStore, onSessionCleared)
      }
    )

    it.each(teamListings)(
      'keeps the session when %s, the fallback answers 401 and /me accepts it',
      async (_name, listTeams) => {
        const { service, tokenStore, onSessionCleared } = createService(sessionMe())
        const rejection = unauthorized()
        service.authClient = {
          listTeams: listTeams(),
          listWorkflows: vi.fn().mockRejectedValue(rejection),
          getMe: vi.fn().mockResolvedValue(sessionMe()),
        }

        await expect(service.listWorkflows()).rejects.toBe(rejection)

        // /me was asked and accepted the session.
        expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
        expect(service.sessionToken).toBe('synthetic-session-token')
        expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
        expect(onSessionCleared).not.toHaveBeenCalled()
      }
    )

    it('rethrows a non-401 fallback failure without asking /me', async () => {
      const { service, tokenStore } = createService(sessionMe())
      const unavailable = new ApiError('503', 503, '')
      service.authClient = {
        listTeams: vi.fn().mockResolvedValue({ currentTeamId: '', items: [] }),
        listWorkflows: vi.fn().mockRejectedValue(unavailable),
        getMe: vi.fn(),
      }

      await expect(service.listWorkflows()).rejects.toBe(unavailable)

      expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1)
      expect(service.authClient.getMe).not.toHaveBeenCalled()
      expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    })
  })

  it('fails a workflow listing with a 401 team call even when /me accepts the session', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    const rejection = unauthorized()
    service.workflowTeamByKey.set('sandbox-recipes/kept', 'team-a')
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: 'team-a',
        items: [
          { id: 'team-a', name: 'Team A', role: 'member' },
          { id: 'team-b', name: 'Team B', role: 'member' },
        ],
      }),
      listWorkflows: vi.fn().mockRejectedValue(rejection),
      switchTeam: vi.fn(),
      getMe: vi.fn().mockResolvedValue(sessionMe()),
    }

    await expect(service.listWorkflows()).rejects.toBe(rejection)

    expect(service.authClient.getMe).toHaveBeenCalledTimes(1)
    expect(service.sessionToken).toBe('synthetic-session-token')
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
    expect([...service.workflowTeamByKey]).toEqual([['sandbox-recipes/kept', 'team-a']])
  })

  it('keeps listing other teams when a team switch is refused with 403', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    const recipe = { metadata: { namespace: 'sandbox-recipes', name: 'recipe-a' } }
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: 'team-a',
        items: [
          { id: 'team-a', name: 'Team A', role: 'member' },
          { id: 'team-b', name: 'Team B', role: 'member' },
        ],
      }),
      listWorkflows: vi.fn().mockResolvedValue({ items: [recipe], count: 1 }),
      switchTeam: vi
        .fn()
        .mockRejectedValue(new ApiError('403 Forbidden', 403, '{"error":"forbidden"}')),
      getMe: vi.fn(),
    }

    await expect(service.listWorkflows()).resolves.toEqual({ items: [recipe], count: 1 })

    expect(service.authClient.switchTeam).toHaveBeenCalledTimes(1)
    expect(service.authClient.getMe).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe('synthetic-session-token')
    expect(tokenStore.clearSessionToken).not.toHaveBeenCalled()
    expect(onSessionCleared).not.toHaveBeenCalled()
  })

  it('tells the window when a deliberate team switch ends the session', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    const rejection = unauthorized()
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: 'synthetic-session-team-b',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockRejectedValue(rejection),
    }

    await expect(service.switchTeam('team-b')).rejects.toBe(rejection)

    expect(service.authClient.switchTeam).toHaveBeenCalledTimes(1)
    expect(service.authClient.getMe).toHaveBeenCalledWith('synthetic-session-team-b')
    expectSessionEnded(service, tokenStore, onSessionCleared)
  })

  it('tells the window when the GFS fence of a deliberate team switch fails', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe())
    const fenceFailure = new Error('gfs state write failed')
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockRejectedValue(fenceFailure)
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: 'synthetic-session-team-b',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue(sessionMe({ teamId: 'team-b', teamName: 'Team B' })),
    }

    await expect(service.switchTeam('team-b')).rejects.toBe(fenceFailure)

    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledTimes(1)
    expectSessionEnded(service, tokenStore, onSessionCleared)
  })

  it('tells the window even when the saved token cannot be removed', async () => {
    const { service, tokenStore, onSessionCleared } = createService(sessionMe({ teamId: null }))
    tokenStore.clearSessionToken.mockRejectedValue(new Error('keychain unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rejection = sessionEnded()
    service.authClient = { getMe: vi.fn().mockRejectedValue(rejection) }

    try {
      await expect(service.runWithTeamContext('team-b', vi.fn())).rejects.toBe(rejection)
    } finally {
      warn.mockRestore()
    }

    expect(tokenStore.clearSessionToken).toHaveBeenCalledTimes(1)
    expect(service.sessionToken).toBeNull()
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
  })
})

describe('AppService workflow listing when the session is replaced', () => {
  const recipe = (name: string) => ({ metadata: { namespace: 'sandbox-recipes', name } })

  function listingService() {
    const built = createService(sessionMe())
    const service = built.service as unknown as TestService & Record<string, any>
    service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({
        currentTeamId: 'team-a',
        items: [
          { id: 'team-a', name: 'Team A', role: 'member' },
          { id: 'team-b', name: 'Team B', role: 'member' },
        ],
      }),
      listWorkflows: vi.fn(),
      switchTeam: vi.fn(async (token: string, teamId: string) => ({
        token: `${token}@${teamId}`,
        team: { id: teamId, name: teamId, role: 'member' },
      })),
      getMe: vi.fn(async () => sessionMe({ id: 'user-b', teamId: 'team-b' })),
    }
    // Another session (a new login) replaces the one that started the listing.
    const replaceSession = () =>
      service.withNativeAuthEnvironmentCommit(async () => {
        service.clearAuthenticatedSessionState()
        service.sessionGeneration += 1
        service.sessionToken = 'token-b'
        service.me = sessionMe({ id: 'user-b', teamId: 'team-c' })
        service.workflowTeamByKey.set('sandbox-recipes/b-own', 'team-c')
      })
    return { ...built, service, replaceSession }
  }

  it('rejects a listing whose session was replaced while a team answered', async () => {
    const { service, replaceSession } = listingService()
    let releaseTeamA!: () => void
    service.authClient.listWorkflows.mockImplementation(async (token: string) => {
      if (token !== 'synthetic-session-token') return { items: [recipe(`via-${token}`)], count: 1 }
      await new Promise<void>(resolve => (releaseTeamA = resolve))
      return { items: [recipe('from-a')], count: 1 }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const outcome = service.listWorkflows().then(
        () => 'resolved',
        () => 'rejected'
      )
      await vi.waitFor(() => expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1))
      expect(service.authClient.listWorkflows).toHaveBeenCalledWith('synthetic-session-token')
      await replaceSession()
      releaseTeamA()

      expect(await outcome).toBe('rejected')
    } finally {
      warn.mockRestore()
    }
    expect(service.authClient.switchTeam).not.toHaveBeenCalled()
    expect([...service.workflowTeamByKey]).toEqual([['sandbox-recipes/b-own', 'team-c']])
  })

  it('rejects a listing whose session was replaced inside a team request', async () => {
    const { service, replaceSession } = listingService()
    service.authClient.listWorkflows.mockImplementation(async (token: string) => {
      if (token !== 'synthetic-session-token') return { items: [recipe(`via-${token}`)], count: 1 }
      await replaceSession()
      return { items: [recipe('from-a')], count: 1 }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let outcome: string
    try {
      outcome = await service.listWorkflows().then(
        () => 'resolved',
        () => 'rejected'
      )
    } finally {
      warn.mockRestore()
    }

    expect(service.authClient.listWorkflows).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('rejected')
    expect(service.authClient.switchTeam).not.toHaveBeenCalled()
    expect([...service.workflowTeamByKey]).toEqual([['sandbox-recipes/b-own', 'team-c']])
  })

  it('rejects a listing whose next team ran under the replacement session', async () => {
    const { service, replaceSession } = listingService()
    service.authClient.listWorkflows.mockImplementation(async (token: string) => ({
      items: [recipe(`via-${token}`)],
      count: 1,
    }))
    const runWithTeamContext = service.runWithTeamContext.bind(service)
    service.runWithTeamContext = async (teamId: string | null, operation: any) => {
      if (teamId === 'team-b') await replaceSession()
      return runWithTeamContext(teamId, operation)
    }

    const outcome = await service.listWorkflows().then(
      () => 'resolved',
      () => 'rejected'
    )

    // The current team was listed with the session that started the listing.
    expect(service.authClient.listWorkflows).toHaveBeenCalledWith('synthetic-session-token')
    expect(outcome).toBe('rejected')
    expect([...service.workflowTeamByKey]).toEqual([['sandbox-recipes/b-own', 'team-c']])
  })
})
