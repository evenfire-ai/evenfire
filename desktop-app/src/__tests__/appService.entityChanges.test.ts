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

describe('AppService entity-change fan-out', () => {
  it('owns one session stream and fans validated invalidations to two renderers', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
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
    service.sessionToken = 'old-session-token'
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
    service.sessionToken = 'new-session-token'

    service.restartEntityChangeStreamForSessionReplacement()
    await flushAsyncWork()

    expect(opens[0]?.signal.aborted).toBe(true)
    expect(opens[1]).toMatchObject({ token: 'new-session-token', cursor: null })
    service.stopEntityChangeStream('stream-a', 11)
  })
})

describe('AppService.startEntityChangeStream session expiry', () => {
  it('turns an initial 401 into a terminal session-expired frame without reconnecting', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
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

  it('does not reconnect after the server announces session expiry', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
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
    service.stopEntityChangeStream('stream-1', 7)
  })
})
