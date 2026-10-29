import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { GfsClient } from '../gfs/uriHandler.js'
import { requestJson } from '../httpClient.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService GFS Move session generation', () => {
  it('invalidates the outgoing identity with the new authoritative generation before replacement publication', async () => {
    const { service } = await createNativeCommitTestHarness()
    const userA = {
      id: 'user-a',
      email: 'user-a@example.test',
      name: 'User A',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const userB = {
      id: 'user-b',
      email: 'user-b@example.test',
      name: 'User B',
      picture: null,
      teamId: 'team-b',
      teamName: 'Team B',
      role: 'member',
    }
    service.authClient = {
      googleLogin: vi
        .fn()
        .mockResolvedValueOnce({ token: 'session-a', me: userA })
        .mockResolvedValueOnce({ token: 'session-b', me: userB }),
    } as never
    const main = service as unknown as {
      getSessionGeneration(): number
      getCachedUserId(): string | null
      onSandboxUiSessionInvalidated?: () => void
      bindCurrentChatStore(userId: string): Promise<void>
    }
    await service.googleLogin('google-token-a')
    const outgoingGeneration = main.getSessionGeneration()
    const invalidated: Array<{ generation: number; outgoingUserId: string | null }> = []
    main.onSandboxUiSessionInvalidated = () => {
      invalidated.push({
        generation: main.getSessionGeneration(),
        outgoingUserId: main.getCachedUserId(),
      })
    }

    let markBindingStarted!: () => void
    const bindingStarted = new Promise<void>(resolve => {
      markBindingStarted = resolve
    })
    let releaseBinding!: () => void
    const bindingGate = new Promise<void>(resolve => {
      releaseBinding = resolve
    })
    main.bindCurrentChatStore = async userId => {
      if (userId === 'user-b') {
        markBindingStarted()
        await bindingGate
      }
    }

    let replacementPublished = false
    const replacement = service.googleLogin('google-token-b').then(result => {
      replacementPublished = true
      return result
    })
    try {
      await bindingStarted
      expect(invalidated).toEqual([
        { generation: main.getSessionGeneration(), outgoingUserId: 'user-a' },
      ])
      expect(main.getSessionGeneration()).toBeGreaterThan(outgoingGeneration)
      expect(await service.getSessionState()).toMatchObject({
        authenticated: true,
        me: { id: 'user-b' },
        sessionGeneration: main.getSessionGeneration(),
      })
      expect(replacementPublished).toBe(false)
    } finally {
      releaseBinding()
    }
    await replacement
    expect(replacementPublished).toBe(true)
  })

  it('rejects an old-generation Move after same-principal login replacement', async () => {
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
    service.authClient = {
      googleLogin: vi
        .fn()
        .mockResolvedValueOnce({ token: 'session-a', me })
        .mockResolvedValueOnce({ token: 'session-b', me }),
    } as never
    const main = service as unknown as {
      getSessionGeneration(): number
      gfsClient: { moveResource: ReturnType<typeof vi.fn> }
      moveGfsResource: (
        resourceId: string,
        destinationId: string,
        expectedSessionGeneration: number,
        drive?: string,
        ifMatch?: number,
        newName?: string
      ) => Promise<{ resourceId: string; version: number }>
    }
    const moveResource = vi.fn().mockResolvedValue({ resourceId: 'source-a', version: 9 })
    main.gfsClient = { moveResource }

    await service.googleLogin('google-token-a')
    const oldGeneration = main.getSessionGeneration()
    await service.googleLogin('google-token-b')

    expect(main.getSessionGeneration()).toBeGreaterThan(oldGeneration)
    await expect(
      main.moveGfsResource('source-a', 'destination-b', oldGeneration, 'main', 8)
    ).rejects.toThrow('stale_session_generation')
    expect(moveResource).not.toHaveBeenCalled()
  })

  it.each([200, 401, 403, 503])(
    'suppresses an old-generation Move result after a same-identity replacement (%s)',
    async status => {
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
      service.authClient = {
        googleLogin: vi
          .fn()
          .mockResolvedValueOnce({ token: 'session-a', me })
          .mockResolvedValueOnce({ token: 'session-b', me }),
      } as never
      await service.googleLogin('google-token-a')

      let markRequestStarted!: () => void
      let releaseResponse!: () => void
      const requestStarted = new Promise<void>(resolve => {
        markRequestStarted = resolve
      })
      const responseGate = new Promise<void>(resolve => {
        releaseResponse = resolve
      })
      const server = createServer((_request, response) => {
        markRequestStarted()
        void responseGate.then(() => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify(
              status === 200
                ? { ok: true, data: { resourceId: 'source-a', version: 9 } }
                : { ok: false, error: { code: 'move_failed', message: 'Move failed' } }
            )
          )
        })
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('expected loopback GFS server')
      const moveCalls: Array<{ method: string; url: string; token?: string }> = []
      const client = new GfsClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestJson: async (method, url, options) => {
          moveCalls.push({ method, url, token: options?.token })
          return requestJson(method, url, options)
        },
        fetchBytes: async () => new ArrayBuffer(0),
      })
      ;(service as unknown as { gfsClient: GfsClient }).gfsClient = client

      const main = service as unknown as {
        getSessionGeneration(): number
        moveGfsResource: (
          resourceId: string,
          destinationId: string,
          expectedSessionGeneration: number,
          drive?: string,
          ifMatch?: number,
          newName?: string
        ) => Promise<{ resourceId: string; version: number }>
      }
      const oldGeneration = main.getSessionGeneration()
      try {
        const pendingMove = main.moveGfsResource(
          'source-a',
          'destination-b',
          oldGeneration,
          'main',
          8
        )
        await requestStarted
        await service.googleLogin('google-token-b')
        expect(main.getSessionGeneration()).toBeGreaterThan(oldGeneration)
        releaseResponse()

        await expect(pendingMove).rejects.toThrow('stale_session_generation')
        expect(moveCalls).toHaveLength(1)
        expect(moveCalls[0]).toEqual({
          method: 'PATCH',
          url: `http://127.0.0.1:${address.port}/api/v1/me/gfs/resources/source-a?drive=main`,
          token: 'session-a',
        })
      } finally {
        releaseResponse()
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      }
    }
  )
})
