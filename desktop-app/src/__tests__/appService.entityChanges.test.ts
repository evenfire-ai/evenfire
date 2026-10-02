import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { config } from '../config.js'
import { ApiError } from '../httpClient.js'
import type { EntityChangeStreamEvent } from '../types.js'

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => false),
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))

async function flushAsyncWork(iterations = 6): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve()
}

function mutableServiceState(service: object): {
  sessionToken?: string | null
  entityChangeSessionToken?: string | null
  entityChangeSessionGeneration?: number
} {
  return service as unknown as {
    sessionToken?: string | null
    entityChangeSessionToken?: string | null
    entityChangeSessionGeneration?: number
  }
}

function setSyntheticSessionToken(service: object, value: string): void {
  const state = mutableServiceState(service)
  state.sessionToken = value
  state.entityChangeSessionToken = value
}

function setSyntheticEntityChangeSession(service: object, value: string, generation: number): void {
  const state = mutableServiceState(service)
  state.entityChangeSessionToken = value
  state.entityChangeSessionGeneration = generation
}

describe('AppService runtime transition ownership', () => {
  it('rejects a handoff selection from an older session generation before reading profiles', async () => {
    const service = new AppService() as any
    service.sessionGeneration = 9

    await expect(service.selectRuntimeConfigForHandoff('saved-profile', 8)).rejects.toThrow(
      'stale_session_generation'
    )
    expect(service.getSessionGeneration()).toBe(9)
  })

  it('does not persist an environment selection after another transition supersedes it', async () => {
    const service = new AppService() as any
    service.sessionGeneration = 9
    service.sessionToken = 'synthetic-session-token'
    service.me = { id: 'user-1', teamId: 'team-1' }
    service.beginPrewarmAuthTransition = () => () => undefined
    service.ensureEntityChangeConnection = vi.fn()

    let finishUploadSuspension!: () => void
    service.suspendDesktopGfsUploadsForAuthBoundary = () =>
      new Promise<void>(resolve => {
        finishUploadSuspension = resolve
      })
    const persistEnvironmentSelection = vi.fn(async () => undefined)
    const changing = service.applyRuntimeEnvironmentChange(persistEnvironmentSelection, 9)

    await flushAsyncWork()
    expect(service.getSessionGeneration()).toBe(10)

    // A login or environment selection advances the same native owner revision.
    service.sessionGeneration += 1
    finishUploadSuspension()

    await expect(changing).rejects.toThrow('stale_session_generation')
    expect(persistEnvironmentSelection).not.toHaveBeenCalled()
    expect(service.entityChangeEnvironmentSwitching).toBe(false)
  })
})

describe('AppService entity-change fan-out', () => {
  it('rebinds a live subscriber after expiry through public Google login', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'old-committed-token')
    service.me = null
    service.beginPrewarmAuthTransition = () => () => undefined
    service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
    service.activateGfsAuthScope = vi.fn()
    service.tokenStore = { setSessionToken: vi.fn().mockResolvedValue(undefined) }
    service.rpcTokenManager = { clear: vi.fn() }
    const opened: Array<{
      token: string
      cursor: string | null
      onEvent: (event: EntityChangeStreamEvent) => void
      signal: AbortSignal
    }> = []
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-new-committed-token',
        me: { id: 'user-1', teamId: 'team-1' },
      }),
      openEntityChangeStream: vi.fn((token, cursor, onEvent, signal) => {
        opened.push({ token, cursor, onEvent, signal })
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
    }

    service.startEntityChangeStream('stream-1', 7, vi.fn())
    await flushAsyncWork()
    expect(opened[0]?.token).toBe('old-committed-token')

    opened[0]?.onEvent({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000000',
      reason: 'session_expired',
    })
    await flushAsyncWork()
    expect(service.entityChangeSubscribers.size).toBe(1)

    await service.googleLogin('id-token')
    await flushAsyncWork()

    expect(opened[0]?.signal.aborted).toBe(true)
    expect(opened[1]).toMatchObject({ token: 'synthetic-new-committed-token', cursor: null })
    expect(service.entityChangeSubscribers.size).toBe(1)
    service.stopEntityChangeStream('stream-1', 7)
  })

  it('owns one session stream and fans validated invalidations to two renderers', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, ['session', 'token'].join('-'))
    let publish!: (event: EntityChangeStreamEvent) => void
    let finishStream!: () => void
    const streamFinished = new Promise<void>(resolve => {
      finishStream = resolve
    })
    service.authClient = {
      openEntityChangeStream: vi.fn().mockImplementation(async (_token, _cursor, onEvent) => {
        publish = onEvent
        await streamFinished
      }),
    }
    const first: EntityChangeStreamEvent[] = []
    const second: EntityChangeStreamEvent[] = []
    service.startEntityChangeStream('stream-a', 11, (event: EntityChangeStreamEvent) =>
      first.push(event)
    )
    service.startEntityChangeStream('stream-b', 22, (event: EntityChangeStreamEvent) =>
      second.push(event)
    )
    await flushAsyncWork()
    publish({ type: 'open' })
    publish({
      type: 'scope.invalidated',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000000',
      scopes: ['gfs', 'authorization'],
    })
    await flushAsyncWork()

    expect(service.authClient.openEntityChangeStream).toHaveBeenCalledOnce()
    expect(service.authClient.openEntityChangeStream).toHaveBeenCalledWith(
      'session-token',
      null,
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(first.map(event => event.type)).toEqual(['open', 'scope.invalidated'])
    expect(second.map(event => event.type)).toEqual(['open', 'scope.invalidated'])

    expect(service.stopEntityChangeStream('stream-a', 22)).toBe(false)
    expect(service.stopEntityChangeStream('stream-a', 11)).toBe(true)
    finishStream()
    expect(service.stopEntityChangeStream('stream-b', 22)).toBe(true)
  })

  it('restarts with a cleared watermark when the authenticated session is replaced', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'old-session-token')
    const opens: Array<{
      token: string
      cursor: string | null
      onEvent: (event: EntityChangeStreamEvent) => void
      signal: AbortSignal
    }> = []
    service.authClient = {
      openEntityChangeStream: vi.fn(
        (
          token: string,
          cursor: string | null,
          onEvent: (event: EntityChangeStreamEvent) => void,
          signal: AbortSignal
        ) => {
          opens.push({ token, cursor, onEvent, signal })
          return new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
      ),
    }
    service.startEntityChangeStream('stream-a', 11, vi.fn())
    await flushAsyncWork()
    opens[0]?.onEvent({
      type: 'scope.invalidated',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000000',
      scopes: ['gfs', 'authorization'],
    })
    setSyntheticSessionToken(service, 'new-session-token')

    service.restartEntityChangeStreamForSessionReplacement()
    await flushAsyncWork()

    expect(opens[0]?.signal.aborted).toBe(true)
    expect(opens[1]).toMatchObject({ cursor: null })
    expect(opens[1]?.token).toBe(['new', 'session', 'token'].join('-'))
    service.stopEntityChangeStream('stream-a', 11)
  })
})

describe('AppService.startEntityChangeStream session expiry', () => {
  it('does not retry an old committed token against a changing environment', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const originalBaseUrl = config.externalRestApiBaseUrl
    const environmentA = 'https://environment-a.example'
    const environmentB = 'https://environment-b.example'
    config.externalRestApiBaseUrl = environmentA
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'synthetic-environment-a-committed-token')
    service.me = { id: 'user-1', teamId: 'team-1' }
    service.beginPrewarmAuthTransition = () => () => undefined
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.activateGfsAuthScope = vi.fn()
    service.stopAllStreams = vi.fn()
    service.tokenStore = { clearSessionToken: vi.fn().mockResolvedValue(undefined) }
    const opened: Array<{ token: string; baseUrl: string }> = []
    service.authClient = {
      openEntityChangeStream: vi.fn(async (token: string) => {
        opened.push({ token, baseUrl: config.externalRestApiBaseUrl })
        throw new Error('temporary connection failure')
      }),
    }

    let finishPersistence!: () => void
    try {
      service.startEntityChangeStream('stream-1', 7, vi.fn())
      await flushAsyncWork()
      expect(opened).toEqual([
        { token: 'synthetic-environment-a-committed-token', baseUrl: environmentA },
      ])

      const switching = service.applyRuntimeEnvironmentChange(async () => {
        config.externalRestApiBaseUrl = environmentB
        await new Promise<void>(resolve => {
          finishPersistence = resolve
        })
      })
      await flushAsyncWork()
      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsyncWork()

      expect(opened).toHaveLength(1)
      finishPersistence()
      await switching
      expect(service.sessionToken).toBeNull()
      expect(opened).toHaveLength(1)
    } finally {
      config.externalRestApiBaseUrl = originalBaseUrl
      service.stopEntityChangeStream('stream-1', 7)
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('does not reset reconnect backoff on synthetic transport-open callbacks', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    service.authClient = {
      openEntityChangeStream: vi.fn(async (_token, _cursor, onEvent) => {
        onEvent({ type: 'open' })
        throw new Error('network disconnected before a valid frame')
      }),
    }

    try {
      service.startEntityChangeStream('stream-1', 7, vi.fn())
      await flushAsyncWork()
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsyncWork()
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1_999)
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await flushAsyncWork()
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(3)
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('reconnects a half-open stream after the idle deadline without invalidating entities', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    const attempts: Array<{
      onEvent: (event: EntityChangeStreamEvent) => void
      signal: AbortSignal
    }> = []
    service.authClient = {
      openEntityChangeStream: vi.fn((_token, _cursor, onEvent, signal) => {
        attempts.push({ onEvent, signal })
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
    }
    const events: EntityChangeStreamEvent[] = []

    try {
      service.startEntityChangeStream('stream-1', 7, (event: EntityChangeStreamEvent) => {
        events.push(event)
      })
      await flushAsyncWork()
      expect(attempts).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(100_000)
      expect(attempts[0]?.signal.aborted).toBe(false)
      attempts[0]?.onEvent({
        schemaVersion: 1,
        type: 'heartbeat',
        cursor: '00000000-0000-0000-0000-000000000000',
        observedAt: '2026-09-30T00:00:00.000Z',
      })
      await vi.advanceTimersByTimeAsync(129_999)
      expect(attempts[0]?.signal.aborted).toBe(false)
      attempts[0]?.onEvent({ type: 'open' })
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts[0]?.signal.aborted).toBe(true)
      expect(events.map(event => event.type)).not.toContain('scope.invalidated')
      expect(events.map(event => event.type)).not.toContain('resync_required')

      await vi.advanceTimersByTimeAsync(1_000)
      await flushAsyncWork()
      expect(attempts).toHaveLength(2)
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('turns an initial 401 into a terminal session-expired frame without reconnecting', async () => {
    vi.useFakeTimers()
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    service.authClient = {
      openEntityChangeStream: vi
        .fn()
        .mockRejectedValue(new ApiError('Entity change stream failed (401)', 401, '')),
    }
    const events: EntityChangeStreamEvent[] = []

    try {
      service.startEntityChangeStream('stream-1', 7, (event: EntityChangeStreamEvent) => {
        events.push(event)
      })
      await flushAsyncWork()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledOnce()
      expect(events.map(event => event.type)).toEqual(['stream.closing'])
      expect(events[0]).toMatchObject({ reason: 'session_expired' })
      expect(service.entityChangeSubscribers.size).toBe(1)
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.useRealTimers()
    }
  })

  it('honors Retry-After before reconnecting after a terminal stream response', async () => {
    vi.useFakeTimers()
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    service.authClient = {
      openEntityChangeStream: vi
        .fn()
        .mockRejectedValueOnce(new ApiError('Entity change stream failed (404)', 404, '', '30'))
        .mockImplementation(
          (_token, _cursor, _onEvent, signal) =>
            new Promise<void>(resolve => {
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
        ),
    }
    try {
      service.startEntityChangeStream('stream-1', 7, vi.fn())
      await flushAsyncWork()
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(29_999)
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await flushAsyncWork()
      expect(service.authClient.openEntityChangeStream).toHaveBeenCalledTimes(2)
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.useRealTimers()
    }
  })

  it('keeps a dormant renderer owner after expiry until it rebinds or tears down', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    service.authClient = {
      openEntityChangeStream: vi.fn().mockImplementation(async (_token, _cursor, onEvent) => {
        onEvent({ type: 'open' })
        onEvent({
          type: 'stream.closing',
          schemaVersion: 1,
          cursor: '00000000-0000-0000-0000-000000000000',
          reason: 'session_expired',
        })
      }),
    }
    const events: EntityChangeStreamEvent[] = []

    service.startEntityChangeStream('stream-1', 7, (event: EntityChangeStreamEvent) => {
      events.push(event)
    })
    await flushAsyncWork()

    expect(events.map(event => event.type)).toEqual(['open', 'stream.closing'])
    expect(service.authClient.openEntityChangeStream).toHaveBeenCalledOnce()
    expect(service.entityChangeSubscribers.size).toBe(1)
    service.stopEntityChangeStream('stream-1', 7)
    expect(service.entityChangeSubscribers.size).toBe(0)
  })

  it('rebinds a stale expired connection once to the newer committed session', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'old-session-token')
    const opens: Array<{
      token: string
      cursor: string | null
      onEvent: (event: EntityChangeStreamEvent) => void
      signal: AbortSignal
    }> = []
    service.authClient = {
      openEntityChangeStream: vi.fn((token, cursor, onEvent, signal) => {
        opens.push({ token, cursor, onEvent, signal })
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
    }
    service.startEntityChangeStream('stream-1', 7, vi.fn())
    await flushAsyncWork()
    setSyntheticEntityChangeSession(service, 'new-committed-session-token', 1)

    opens[0]?.onEvent({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000000',
      reason: 'session_expired',
    })
    await flushAsyncWork()

    expect(opens.map(entry => entry.token)).toEqual([
      'old-session-token',
      'new-committed-session-token',
    ])
    expect(opens[1]?.cursor).toBeNull()
    expect(service.entityChangeSubscribers.size).toBe(1)
    service.stopEntityChangeStream('stream-1', 7)
  })

  it('does not strand subscribers when expiry is deferred through a transient hop', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'committed-session-token')
    let publish!: (event: EntityChangeStreamEvent) => void
    service.authClient = {
      openEntityChangeStream: vi.fn((_token, _cursor, onEvent, signal) => {
        publish = onEvent
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
    }
    const events: EntityChangeStreamEvent[] = []
    const releaseTransientHop = service.enterGfsTransientTeamHop()
    service.startEntityChangeStream('stream-1', 7, (event: EntityChangeStreamEvent) => {
      events.push(event)
    })
    await flushAsyncWork()

    publish({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000000',
      reason: 'session_expired',
    })
    await flushAsyncWork()

    expect(events).toEqual([])
    expect(service.entityChangeSubscribers.size).toBe(1)
    releaseTransientHop()
    expect(events.map(event => event.type)).toEqual(['stream.closing'])
    expect(service.entityChangeSubscribers.size).toBe(1)
    service.stopEntityChangeStream('stream-1', 7)
  })
})

describe('AppService entity-change stream team-context lifecycle', () => {
  it('never reconnects with a transient team token and rebinds after the hop', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'committed-session-token')
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.gfsScopeIdentity = {}
    service.bindCurrentChatStore = vi.fn()
    service.tokenStore = { setSessionToken: vi.fn() }

    const opened: Array<{ token: string; signal: AbortSignal }> = []
    let finishFirstStream!: () => void
    service.authClient = {
      openEntityChangeStream: vi.fn((token, _cursor, _onEvent, signal) => {
        opened.push({ token, signal })
        return new Promise<void>(resolve => {
          if (opened.length === 1) finishFirstStream = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
      switchTeam: vi.fn(async (_token, teamId) => ({
        token: teamId === 'team-b' ? 'transient-team-context-token' : 'restored-session-token',
      })),
      getMe: vi.fn(async token => ({
        id: 'user-1',
        teamId: token === 'transient-team-context-token' ? 'team-b' : 'team-a',
      })),
    }

    let finishOperation!: () => void
    const operationGate = new Promise<void>(resolve => {
      finishOperation = resolve
    })
    try {
      service.startEntityChangeStream('stream-1', 7, vi.fn())
      await flushAsyncWork()
      expect(opened[0]?.token).toBe('committed-session-token')

      const teamOperation = service.runWithTeamContext('team-b', async () => operationGate)
      await flushAsyncWork()
      expect(service.sessionToken).toBe('transient-team-context-token')

      finishFirstStream()
      await flushAsyncWork()
      await vi.advanceTimersByTimeAsync(1000)

      expect(opened.map(entry => entry.token)).not.toContain('transient-team-context-token')

      finishOperation()
      await teamOperation
      await flushAsyncWork()
      expect(opened.map(entry => entry.token)).toContain('restored-session-token')
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})
