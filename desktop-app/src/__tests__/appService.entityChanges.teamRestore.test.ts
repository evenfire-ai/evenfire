import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
  deferred,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import {
  testLoginResult,
  testSessionMe,
  testTeamSwitchResult,
} from '../../testSupport/authTestFixtures.js'
import type { EntityChangeStreamEvent } from '../types.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupNativeCommitTestHarness()
})

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

describe('AppService entity stream after failed team restore', () => {
  it('dispatches under its accepted owner and keeps a delayed reconnect revoked after logout', async () => {
    const { service } = await createNativeCommitTestHarness({ keytarAvailable: true })
    const { getSessionRequestContext } = await import('../httpClient.js')
    const me = testSessionMe()
    vi.spyOn(service.authClient, 'passwordLogin').mockResolvedValue({
      token: 'accepted-entity-stream-token',
      me,
    })
    vi.spyOn(service.authClient, 'getMe').mockResolvedValue(me)
    await service.passwordLogin(me.email, 'fixture-password')

    const firstDispatch = deferred<void>()
    const reconnectStarted = deferred<void>()
    const reconnectOwnerStatus = deferred<{
      tokenMatches: boolean
      contextPresent: boolean
      sameLineage: boolean
      exactOwner: boolean
    }>()
    const releaseReconnect = deferred<void>()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      firstDispatch.resolve()
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.close(), { once: true })
        },
      })
      return new Response(body, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const ownerAuthority = (
      service as unknown as {
        sessionAuthority: {
          isSessionRequestContextInCurrentLineage(context: unknown, token: string): boolean
          assertTemporaryRequestAllowed(token: string, context: unknown): void
        }
      }
    ).sessionAuthority
    const originalOpen = service.authClient.openEntityChangeStream.bind(service.authClient)
    let openCalls = 0
    vi.spyOn(service.authClient, 'openEntityChangeStream').mockImplementation(
      async (token, cursor, onEvent, signal) => {
        openCalls += 1
        if (openCalls === 2) {
          const requestContext = getSessionRequestContext()
          let exactOwner = true
          try {
            ownerAuthority.assertTemporaryRequestAllowed(token, requestContext)
          } catch {
            exactOwner = false
          }
          reconnectOwnerStatus.resolve({
            tokenMatches: token === 'accepted-entity-stream-token',
            contextPresent: requestContext !== undefined,
            sameLineage: ownerAuthority.isSessionRequestContextInCurrentLineage(
              requestContext,
              token
            ),
            exactOwner,
          })
          reconnectStarted.resolve()
          await releaseReconnect.promise
        }
        return originalOpen(token, cursor, onEvent, signal)
      }
    )

    service.startEntityChangeStream('accepted-stream', 7, vi.fn())
    await firstDispatch.promise
    expect(fetchMock).toHaveBeenCalledOnce()

    service.stopEntityChangeStream('accepted-stream', 7)
    await flushAsyncWork()
    service.startEntityChangeStream('delayed-reconnect', 7, vi.fn())
    await reconnectStarted.promise
    await expect(reconnectOwnerStatus.promise).resolves.toEqual({
      tokenMatches: true,
      contextPresent: true,
      sameLineage: true,
      exactOwner: true,
    })

    await service.logout()
    releaseReconnect.resolve()
    await flushAsyncWork()

    expect(openCalls).toBe(2)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rebinds only the verified accepted team owner after the home restore fails', async () => {
    const { service } = await createNativeCommitTestHarness({ keytarAvailable: true })
    const { getActiveEnvKey } = await import('../config.js')
    const meA = testSessionMe()
    const meB = testSessionMe({ teamId: 'team-b', teamName: 'Team B' })
    const app = service as unknown as {
      authClient: unknown
      workflowTeamByKey: Map<string, string>
      workflowKey(ns: string, name: string): string
      startEntityChangeStream(
        streamId: string,
        generation: number,
        onEvent: (event: EntityChangeStreamEvent) => void
      ): void
      stopEntityChangeStream(streamId: string, generation: number): void
      getSessionGeneration(): number
    }
    const opened: Array<{ token: string; signal: AbortSignal }> = []
    app.authClient = {
      passwordLogin: vi.fn().mockResolvedValue(testLoginResult('committed-team-a-token', meA)),
      getMe: vi.fn(async (token: string) => (token === 'committed-team-b-token' ? meB : meA)),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        if (teamId === 'team-a') throw new Error('team restore failed')
        return testTeamSwitchResult(teamId, 'committed-team-b-token')
      }),
      readWorkflow: vi.fn(async () => {
        throw new Error('operation failed')
      }),
      openEntityChangeStream: vi.fn((token: string, _cursor, _onEvent, signal) => {
        opened.push({ token, signal })
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
    }

    try {
      await service.passwordLogin(meA.email, 'fixture-password')
      app.workflowTeamByKey.set(app.workflowKey('team-a', 'flow-a'), 'team-b')
      app.startEntityChangeStream('stream-1', 7, vi.fn())
      await flushAsyncWork()
      expect(opened.map(entry => entry.token)).toEqual(['committed-team-a-token'])

      const previousGeneration = app.getSessionGeneration()
      await expect(service.readWorkflow('team-a', 'flow-a')).rejects.toThrow('operation failed')
      await flushAsyncWork()

      expect(service.getCachedUserId()).toBe(meA.id)
      expect(service.sessionToken).toBe('committed-team-b-token')
      const { readSessionAuthoritySourceSelection } =
        await import('../sessionAuthorityAcceptance.js')
      const selected = await readSessionAuthoritySourceSelection({
        tokenStore: service.tokenStore as never,
        envKey: getActiveEnvKey(),
      })
      expect(selected.status).toBe('accepted')
      if (selected.status !== 'accepted') throw new Error('Expected accepted team source')
      expect(selected.session.token).toBe('committed-team-b-token')
      expect(app.getSessionGeneration()).toBe(previousGeneration + 1)
      expect(opened[0]?.signal.aborted).toBe(true)
      expect(opened.map(entry => entry.token)).toEqual([
        'committed-team-a-token',
        'committed-team-b-token',
      ])
    } finally {
      app.stopEntityChangeStream('stream-1', 7)
      vi.restoreAllMocks()
    }
  })

  it('does not rebind the failed-restore chat scope after queued logout is requested', async () => {
    const { service, userDataDir } = await createNativeCommitTestHarness({ keytarAvailable: true })
    const { AppService } = await import('../appService.js')
    const { TokenStore } = await import('../tokenStore.js')
    const meHome = testSessionMe()
    const meHop = testSessionMe({ teamId: 'team-b', teamName: 'Team B' })
    const app = service as unknown as {
      authClient: unknown
      workflowTeamByKey: Map<string, string>
      workflowKey(ns: string, name: string): string
      drainHomeTeamOperations(activeHop: unknown): Promise<void>
    }
    app.authClient = {
      passwordLogin: vi.fn().mockResolvedValue(testLoginResult('accepted-home-token', meHome)),
      getMe: vi.fn(async (token: string) => (token === 'accepted-hop-token' ? meHop : meHome)),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        if (teamId === 'team-a') throw new Error('home-team restore failed')
        return testTeamSwitchResult(teamId, 'accepted-hop-token')
      }),
      readWorkflow: vi.fn(async () => {
        throw new Error('workflow operation failed')
      }),
    }

    await service.passwordLogin(meHome.email, 'fixture-password')
    app.workflowTeamByKey.set(app.workflowKey('team-a', 'flow-a'), 'team-b')

    const drainStarted = deferred<void>()
    const releaseDrain = deferred<void>()
    const drainHomeOperations = app.drainHomeTeamOperations.bind(service)
    vi.spyOn(app, 'drainHomeTeamOperations').mockImplementation(async activeHop => {
      drainStarted.resolve()
      await releaseDrain.promise
      await drainHomeOperations(activeHop)
    })

    const operation = service.readWorkflow('team-a', 'flow-a')
    await drainStarted.promise

    const chatBinding = await import('../chatStoreBinding.js')
    const bindChatStore = vi.mocked(chatBinding.bindChatStoreForUser)
    const publishTeamScope = vi.mocked(chatBinding.reserveBoundChatStoreTeamScope)
    bindChatStore.mockClear()
    publishTeamScope.mockClear()

    // logout() raises its cancellation fence synchronously even though its durable work is
    // queued behind the in-flight team operation. The post-drain rebind must observe that fence.
    const logout = service.logout()
    releaseDrain.resolve()

    await expect(operation).rejects.toThrow('workflow operation failed')
    // Observe the post-drain window before logout's final teardown can unbind the store. The old
    // implementation called bindCurrentChatStore() here, which bypassed the new reserved scope
    // path and rebound the stale Home operation while logout was queued.
    expect(bindChatStore).not.toHaveBeenCalled()
    expect(publishTeamScope).not.toHaveBeenCalled()
    await expect(logout).resolves.toMatchObject({ kind: 'committed' })
    expect(service.getCachedUserId()).toBeNull()
    expect(() => chatBinding.requireChatStore()).toThrow('Not authenticated')

    const restartGetMe = vi.fn()
    const restart = new AppService({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => userDataDir,
    }) as unknown as {
      authClient: { getMe: typeof restartGetMe }
      initialize(): Promise<unknown>
    }
    restart.authClient = { getMe: restartGetMe }
    await expect(restart.initialize()).resolves.toMatchObject({ authenticated: false, me: null })
    expect(restartGetMe).not.toHaveBeenCalled()
  })
})
