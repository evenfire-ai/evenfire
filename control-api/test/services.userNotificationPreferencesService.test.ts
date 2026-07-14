import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
}))

const { pool } = await import('../src/db.js')
const { getUserNotificationPreferences, upsertUserNotificationPreferences } =
  await import('../src/services/userNotificationPreferencesService.js')

describe('userNotificationPreferencesService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns defaults when no preference row exists', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ medium: 'telegram' }, { medium: 'slack' }] } as never)

    const result = await getUserNotificationPreferences('user-1')

    expect(result).toEqual({
      preferredMedium: null,
      preferredAccountId: null,
      channelFallbackEnabled: true,
      verifiedMedia: ['telegram', 'slack'],
    })
  })

  it('rejects unverified preferred mediums', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never)

    await expect(
      upsertUserNotificationPreferences('user-1', {
        preferredMedium: 'slack',
        channelFallbackEnabled: true,
      })
    ).rejects.toThrow('preferred_medium_not_verified')
  })

  it('rejects missing preferredMedium without upserting', async () => {
    await expect(
      upsertUserNotificationPreferences('user-1', { channelFallbackEnabled: true })
    ).rejects.toThrow('invalid_preferred_medium')

    expect(pool.query).not.toHaveBeenCalled()
  })

  it('rejects missing channelFallbackEnabled without upserting', async () => {
    await expect(
      upsertUserNotificationPreferences('user-1', { preferredMedium: 'telegram' })
    ).rejects.toThrow('invalid_channel_fallback_enabled')

    expect(pool.query).not.toHaveBeenCalled()
  })

  it('rejects non-boolean channelFallbackEnabled without coercion', async () => {
    await expect(
      upsertUserNotificationPreferences('user-1', {
        preferredMedium: null,
        channelFallbackEnabled: 'true' as unknown as boolean,
      })
    ).rejects.toThrow('invalid_channel_fallback_enabled')

    expect(pool.query).not.toHaveBeenCalled()
  })

  it('persists channelFallbackEnabled false on full replace', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            preferredMedium: null,
            channelFallbackEnabled: false,
          },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)

    const result = await upsertUserNotificationPreferences('user-1', {
      preferredMedium: null,
      channelFallbackEnabled: false,
    })

    expect(result.channelFallbackEnabled).toBe(false)
    // INSERT params: userId, preferredMedium, preferredAccountId, channelFallbackEnabled, accountProvided.
    // accountProvided=false here (preferredAccountId was not in the input) so the
    // stored preferred_account_id is preserved by the ON CONFLICT CASE.
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_notification_preferences'),
      ['user-1', null, null, false, false]
    )
  })

  const ACCT_ID = '22222222-2222-2222-2222-222222222222'

  it('persists a preferred account id after validating ownership', async () => {
    vi.mocked(pool.query)
      // getVerifiedMediumAccountById ownership check (account belongs to user, active)
      .mockResolvedValueOnce({
        rows: [{ id: ACCT_ID, userId: 'user-1', medium: 'telegram' }],
      } as never)
      // INSERT
      .mockResolvedValueOnce({ rows: [] } as never)
      // getUserNotificationPreferences: prefs + media
      .mockResolvedValueOnce({
        rows: [
          { preferredMedium: null, preferredAccountId: ACCT_ID, channelFallbackEnabled: true },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [{ medium: 'telegram' }] } as never)

    const result = await upsertUserNotificationPreferences('user-1', {
      preferredMedium: null,
      preferredAccountId: ACCT_ID,
      channelFallbackEnabled: true,
    })

    expect(result.preferredAccountId).toBe(ACCT_ID)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_notification_preferences'),
      ['user-1', null, ACCT_ID, true, true]
    )
  })

  it('rejects a preferred account id that does not belong to the user or is disabled', async () => {
    // Valid UUID shape so it passes the regex and reaches the ownership lookup,
    // which returns no row (not owned / disabled / missing).
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never)

    await expect(
      upsertUserNotificationPreferences('user-1', {
        preferredMedium: null,
        preferredAccountId: '11111111-1111-1111-1111-111111111111',
        channelFallbackEnabled: true,
      })
    ).rejects.toThrow('preferred_account_not_found')

    expect(pool.query).toHaveBeenCalledOnce()
  })

  it('rejects a non-uuid preferred account id without a db lookup', async () => {
    await expect(
      upsertUserNotificationPreferences('user-1', {
        preferredMedium: null,
        preferredAccountId: 'not-a-uuid',
        channelFallbackEnabled: true,
      })
    ).rejects.toThrow('preferred_account_not_found')

    expect(pool.query).not.toHaveBeenCalled()
  })
})
