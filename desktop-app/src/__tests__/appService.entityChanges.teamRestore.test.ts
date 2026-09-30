import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
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

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

describe('AppService entity stream after failed team restore', () => {
  it('rebinds to the actual committed session token when restoring the original team fails', async () => {
    const service = new AppService() as any
    service.sessionToken = 'committed-team-a-token'
    service.entityChangeSessionToken = 'committed-team-a-token'
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
    service.tokenStore = { setSessionToken: vi.fn().mockResolvedValue(undefined) }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const opened: Array<{ token: string; signal: AbortSignal }> = []
    service.authClient = {
      openEntityChangeStream: vi.fn((token: string, _cursor, _onEvent, signal) => {
        opened.push({ token, signal })
        return new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        if (teamId === 'team-a') throw new Error('team restore failed')
        return { token: 'committed-team-b-token' }
      }),
      getMe: vi.fn(async () => ({ id: 'user-1', teamId: 'team-b' })),
    }

    try {
      service.startEntityChangeStream(
        'stream-1',
        7,
        vi.fn<(event: EntityChangeStreamEvent) => void>()
      )
      await flushAsyncWork()
      expect(opened.map(entry => entry.token)).toEqual(['committed-team-a-token'])

      await expect(
        service.runWithTeamContext('team-b', async () => {
          throw new Error('operation failed')
        })
      ).rejects.toThrow('operation failed')
      await flushAsyncWork()

      expect(service.sessionToken).toBe('committed-team-b-token')
      expect(opened[0]?.signal.aborted).toBe(true)
      expect(opened.map(entry => entry.token)).toEqual([
        'committed-team-a-token',
        'committed-team-b-token',
      ])
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.restoreAllMocks()
    }
  })
})
