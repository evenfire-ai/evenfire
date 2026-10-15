import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { getActiveEnvKey } from '../config.js'
import { TokenStore } from '../tokenStore.js'
import type { EntityChangeStreamEvent } from '../types.js'

const credentialFixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => true),
    getPath: vi.fn(() => credentialFixture.directory),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))

beforeEach(async () => {
  credentialFixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-team-restore-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(credentialFixture.directory, { recursive: true, force: true })
})

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

describe('AppService entity stream after failed team restore', () => {
  it('rebinds to the actual committed session token when restoring the original team fails', async () => {
    const tokenStore = new TokenStore({ isolatedUserDataPath: credentialFixture.directory })
    await tokenStore.setSessionToken('committed-team-a-token', getActiveEnvKey())
    const service = new AppService({
      tokenStore,
      getUserDataDirectory: () => credentialFixture.directory,
    }) as any
    Reflect.set(service, 'sessionToken', 'committed-team-a-token')
    Reflect.set(service, 'entityChangeSessionToken', 'committed-team-a-token')
    service.me = { id: 'user-1', teamId: 'team-a' }
    service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
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
        return { token: 'synthetic-committed-team-b-token' }
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

      expect(service.sessionToken).toBe('synthetic-committed-team-b-token')
      expect(await tokenStore.getSessionToken(getActiveEnvKey())).toBe(
        'synthetic-committed-team-b-token'
      )
      expect(opened[0]?.signal.aborted).toBe(true)
      expect(opened.map(entry => entry.token)).toEqual([
        'committed-team-a-token',
        'synthetic-committed-team-b-token',
      ])
    } finally {
      service.stopEntityChangeStream('stream-1', 7)
      vi.restoreAllMocks()
    }
  })
})
