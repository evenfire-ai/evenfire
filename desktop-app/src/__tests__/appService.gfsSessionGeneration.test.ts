import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { buildGfsResourceDeepLink, buildSandboxUiDeepLink } from '@clerum/desktop-app-links'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testSessionTokenForIdentity } from '../../testSupport/authTestFixtures.js'
import { GfsClient } from '../gfs/uriHandler.js'
import { parseGfsResourceDeepLink } from '../gfsDeepLinks.js'
import { GfsResourceDeepLinkQueue } from '../gfsResourceDeepLinkQueue.js'
import { requestJson } from '../httpClient.js'
import { SandboxUiDeepLinkQueue } from '../sandboxUiDeepLinkQueue.js'
import { parseSandboxUiDeepLink } from '../sandboxUiDeepLinks.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService GFS Move session generation', () => {
  it('invalidates the outgoing GFS owner before publishing its replacement', async () => {
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
    const tokenA = testSessionTokenForIdentity('user-a', 'team-a')
    const tokenB = testSessionTokenForIdentity('user-b', 'team-b')
    service.authClient = {
      googleLogin: vi
        .fn()
        .mockResolvedValueOnce({ token: tokenA, me: userA })
        .mockResolvedValueOnce({ token: tokenB, me: userB }),
      getMe: vi.fn().mockResolvedValueOnce(userA).mockResolvedValueOnce(userB),
    } as never
    const main = service as unknown as {
      getSessionGeneration(): number
      getCachedUserId(): string | null
      me: { id: string } | null
      onSandboxUiSessionInvalidated?: (sessionGeneration: number) => void
    }
    const invalidateWithoutPreviousOwner = vi.fn()
    main.onSandboxUiSessionInvalidated = invalidateWithoutPreviousOwner
    await service.googleLogin('google-token-a')
    expect(invalidateWithoutPreviousOwner).not.toHaveBeenCalled()
    expect(main.getCachedUserId()).toBe('user-a')
    const outgoingGeneration = main.getSessionGeneration()
    const appQueue = new SandboxUiDeepLinkQueue()
    const gfsQueue = new GfsResourceDeepLinkQueue()
    const appTarget = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'old-owner', path: '/inbox' })
    )
    const gfsTarget = parseGfsResourceDeepLink(
      buildGfsResourceDeepLink('gfs://main/0123456789abcdef0123456789abcdef')
    )
    if (!appTarget || !gfsTarget) throw new Error('real deep-link producer returned no target')
    const oldAppLink = appQueue.enqueue(appTarget)
    const oldGfsLink = gfsQueue.enqueue(gfsTarget)
    const invalidated: Array<{
      generation: number
      visibleGeneration: number
      outgoingUserId: string | null
      appFloor: number
      gfsFloor: number
    }> = []
    main.onSandboxUiSessionInvalidated = sessionGeneration => {
      const appFloor = appQueue.clear()
      const gfsFloor = gfsQueue.clear()
      invalidated.push({
        generation: sessionGeneration,
        visibleGeneration: main.getSessionGeneration(),
        outgoingUserId: main.me?.id ?? null,
        appFloor,
        gfsFloor,
      })
      throw new Error('renderer invalidation delivery unavailable')
    }

    const result = await service.googleLogin('google-token-b')
    expect(result).toMatchObject({
      authenticated: true,
      me: { id: 'user-b' },
      sessionGeneration: expect.any(Number),
    })
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]).toMatchObject({
      generation: expect.any(Number),
      visibleGeneration: expect.any(Number),
      outgoingUserId: 'user-a',
      appFloor: oldAppLink.id + 1,
      gfsFloor: oldGfsLink.id + 1,
    })
    expect(invalidated[0]?.visibleGeneration).toBeLessThan(invalidated[0]?.generation ?? 0)
    expect(invalidated[0]?.generation).toBeGreaterThan(outgoingGeneration)
    expect(appQueue.list()).toEqual([])
    expect(gfsQueue.list()).toEqual([])
    expect(result.sessionGeneration).toBe(invalidated[0]?.generation)
  })

  it('preserves the accepted owner and queued navigation when replacement login is rejected', async () => {
    const { service } = await createNativeCommitTestHarness({ keytarAvailable: true })
    const userA = {
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
        .mockResolvedValueOnce({
          token: testSessionTokenForIdentity('user-a', 'team-a'),
          me: userA,
        })
        .mockRejectedValueOnce(new Error('replacement login rejected')),
      getMe: vi.fn().mockResolvedValue(userA),
    } as never
    const main = service as unknown as {
      getCachedUserId(): string | null
      onSandboxUiSessionInvalidated?: () => void
    }
    await service.googleLogin('google-token-a')
    const appQueue = new SandboxUiDeepLinkQueue()
    const gfsQueue = new GfsResourceDeepLinkQueue()
    const appTarget = parseSandboxUiDeepLink(
      buildSandboxUiDeepLink({ recipeNs: 'ns', recipeName: 'owner-a', path: '/inbox' })
    )
    const gfsTarget = parseGfsResourceDeepLink(
      buildGfsResourceDeepLink('gfs://main/abcdef0123456789abcdef0123456789')
    )
    if (!appTarget || !gfsTarget) throw new Error('real deep-link producer returned no target')
    const appLink = appQueue.enqueue(appTarget)
    const gfsLink = gfsQueue.enqueue(gfsTarget)
    const invalidate = vi.fn(() => {
      appQueue.clear()
      gfsQueue.clear()
    })
    main.onSandboxUiSessionInvalidated = invalidate

    await expect(service.googleLogin('google-token-b')).rejects.toThrow(
      'replacement login rejected'
    )

    expect(main.getCachedUserId()).toBe('user-a')
    expect(invalidate).not.toHaveBeenCalled()
    expect(appQueue.list()).toEqual([appLink])
    expect(gfsQueue.list()).toEqual([gfsLink])
  })

  it('invalidates only for the accepted winner when a newer login supersedes a pending candidate', async () => {
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
    const userB = { ...userA, id: 'user-b', email: 'user-b@example.test', teamId: 'team-b' }
    const userC = { ...userA, id: 'user-c', email: 'user-c@example.test', teamId: 'team-c' }
    const tokenB = testSessionTokenForIdentity('user-b', 'team-b')
    const tokenC = testSessionTokenForIdentity('user-c', 'team-c')
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: testSessionTokenForIdentity('user-a', 'team-a'),
        me: userA,
      }),
      getMe: vi.fn().mockResolvedValue(userA),
    } as never
    await service.googleLogin('google-token-a')

    let releaseB!: (result: { token: string; me: typeof userB }) => void
    let notifyBStarted!: () => void
    const bStarted = new Promise<void>(resolve => (notifyBStarted = resolve))
    const delayedB = new Promise<{ token: string; me: typeof userB }>(resolve => {
      releaseB = resolve
    })
    service.authClient = {
      googleLogin: vi.fn((token: string) => {
        if (token === 'google-token-b') {
          notifyBStarted()
          return delayedB
        }
        return Promise.resolve({ token: tokenC, me: userC })
      }),
      getMe: vi
        .fn()
        .mockImplementation((token: string) =>
          Promise.resolve(token === tokenC ? userC : token === tokenB ? userB : userA)
        ),
    } as never
    const invalidated: number[] = []
    ;(
      service as unknown as {
        onSandboxUiSessionInvalidated?: (sessionGeneration: number) => void
      }
    ).onSandboxUiSessionInvalidated = generation => invalidated.push(generation)

    const pendingB = service.googleLogin('google-token-b')
    await bStarted
    const acceptedC = await service.googleLogin('google-token-c')
    releaseB({ token: tokenB, me: userB })
    await expect(pendingB).rejects.toThrow()

    expect(acceptedC.me.id).toBe('user-c')
    expect(invalidated).toEqual([acceptedC.sessionGeneration])
    expect(service.getCachedUserId()).toBe('user-c')
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
    const tokenA = testSessionTokenForIdentity('user-a', 'team-a')
    const tokenB = testSessionTokenForIdentity('user-a', 'team-a', Date.now() + 90 * 60 * 1000)
    service.authClient = {
      googleLogin: vi
        .fn()
        .mockResolvedValueOnce({ token: tokenA, me })
        .mockResolvedValueOnce({ token: tokenB, me }),
      getMe: vi.fn().mockResolvedValue(me),
    } as never
    const main = service as unknown as {
      getSessionGeneration(): number
      onSandboxUiSessionInvalidated?: () => void
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
    const invalidate = vi.fn()
    main.onSandboxUiSessionInvalidated = invalidate
    const oldGeneration = main.getSessionGeneration()
    await service.googleLogin('google-token-b')

    expect(main.getSessionGeneration()).toBeGreaterThan(oldGeneration)
    expect(invalidate).not.toHaveBeenCalled()
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
      const tokenA = testSessionTokenForIdentity('user-a', 'team-a')
      const tokenB = testSessionTokenForIdentity('user-a', 'team-a', Date.now() + 90 * 60 * 1000)
      service.authClient = {
        googleLogin: vi
          .fn()
          .mockResolvedValueOnce({ token: tokenA, me })
          .mockResolvedValueOnce({ token: tokenB, me }),
        getMe: vi.fn().mockResolvedValue(me),
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
          token: tokenA,
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
