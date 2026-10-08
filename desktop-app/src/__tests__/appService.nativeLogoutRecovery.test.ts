import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService logout recovery ownership', () => {
  it('keeps the current session when token removal fails on the same runtime boundary', async () => {
    const { service } = await createNativeCommitTestHarness()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue({
        token: 'synthetic-session-a',
        me: {
          id: 'user-a',
          email: 'user-a@example.test',
          name: 'User A',
          picture: null,
          teamId: 'team-a',
          teamName: 'Team A',
          role: 'member',
        },
      }),
    } as never
    await service.googleLogin('initial-login')
    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))

    await expect(service.logout()).rejects.toThrow('keychain unavailable')

    expect(service.getCachedUserId()).toBe('user-a')
    expect(service.sessionToken).toBe('synthetic-session-a')
    await expect(service.listGfsUploadSessions()).resolves.toEqual([])
  })
})
