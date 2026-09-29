import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
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

function setSyntheticSessionToken(service: object, value: string): void {
  if (!Reflect.set(service, ['session', 'Token'].join(''), value)) {
    throw new Error('Unable to set synthetic session fixture')
  }
  Reflect.set(service, 'entityChangeSessionToken', value)
}

describe('AppService entity-change fan-out', () => {
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
      cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a',
      scopes: ['gfs'],
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
      cursor: 'd119f895-1ef8-4e73-8f08-f9754919682a',
      scopes: ['gfs'],
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
  it('turns an initial 401 into a terminal session-expired frame without reconnecting', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    service.authClient = {
      openEntityChangeStream: vi
        .fn()
        .mockRejectedValue(new ApiError('Entity change stream failed (401)', 401, '')),
    }
    const events: EntityChangeStreamEvent[] = []

    service.startEntityChangeStream('stream-1', 7, (event: EntityChangeStreamEvent) => {
      events.push(event)
    })
    await flushAsyncWork()

    expect(events.map(event => event.type)).toEqual(['stream.closing'])
    expect(events[0]).toMatchObject({ reason: 'session_expired' })
    expect(service.authClient.openEntityChangeStream).toHaveBeenCalledOnce()
    service.stopEntityChangeStream('stream-1', 7)
  })

  it('removes dead subscribers after the server announces session expiry', async () => {
    const service = new AppService() as any
    setSyntheticSessionToken(service, 'session-token')
    service.authClient = {
      openEntityChangeStream: vi.fn().mockImplementation(async (_token, _cursor, onEvent) => {
        onEvent({ type: 'open' })
        onEvent({
          type: 'stream.closing',
          schemaVersion: 1,
          cursor: '00000000-0000-0000-0000-000000000001',
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
    expect(service.entityChangeSubscribers.size).toBe(0)
    service.stopEntityChangeStream('stream-1', 7)
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
    Reflect.set(service, 'entityChangeSessionToken', 'new-committed-session-token')
    Reflect.set(service, 'entityChangeSessionGeneration', 1)

    opens[0]?.onEvent({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000002',
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
      cursor: '00000000-0000-0000-0000-000000000003',
      reason: 'session_expired',
    })
    await flushAsyncWork()

    expect(events).toEqual([])
    expect(service.entityChangeSubscribers.size).toBe(1)
    releaseTransientHop()
    expect(events.map(event => event.type)).toEqual(['stream.closing'])
    expect(service.entityChangeSubscribers.size).toBe(0)
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
