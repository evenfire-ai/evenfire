import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService GFS Move session generation', () => {
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
})
