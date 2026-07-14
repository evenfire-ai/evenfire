import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import { createChallengeCodeHash } from '../src/services/workflowApprovalMediumIdentityService.js'
import {
  TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
  type TelegramProviderEventChallengeRow,
  findMatchingTelegramProviderEventChallenge,
  upsertVerifiedTelegramAccount,
} from '../src/services/workflowApprovalMediumTelegramVerificationService.js'

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const mockedQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>

function challengeRow(
  id: string,
  userId: string,
  code: string,
  overrides: Partial<TelegramProviderEventChallengeRow> = {}
): TelegramProviderEventChallengeRow {
  return {
    id,
    userId,
    userEmail: `${userId}@example.com`,
    targetId: 'telegram:target',
    codeHash: createChallengeCodeHash({
      userId,
      medium: 'telegram',
      providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      code,
      saltHex: 'abcd'.repeat(8),
    }),
    isExpired: false,
    consumedAt: null,
    attempts: 0,
    ...overrides,
  }
}

describe('Telegram provider-event challenge matching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
  })

  it('uses the viable active challenge when stale consumed rows share the code', async () => {
    const stale = challengeRow('challenge-consumed', 'user-old', '123456', {
      consumedAt: '2026-06-02T12:00:00.000Z',
    })
    const active = challengeRow('challenge-active', 'user-current', '123456')
    mockedQuery.mockResolvedValueOnce({ rows: [stale, active], rowCount: 2 })

    await expect(findMatchingTelegramProviderEventChallenge('123456')).resolves.toMatchObject({
      id: 'challenge-active',
      userId: 'user-current',
    })
  })

  it('keeps failing closed when more than one viable challenge matches the code', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        challengeRow('challenge-a', 'user-a', '123456'),
        challengeRow('challenge-b', 'user-b', '123456'),
      ],
      rowCount: 2,
    })

    await expect(findMatchingTelegramProviderEventChallenge('123456')).resolves.toEqual({
      error: 'ambiguous_code',
    })
  })

  it('requires a server-derived communication channel ref before upserting Telegram accounts', async () => {
    const db = { query: vi.fn() }

    await expect(
      upsertVerifiedTelegramAccount(
        db as never,
        'user-1',
        {
          providerUserId: '777',
          providerChannelId: '777',
        },
        null
      )
    ).rejects.toThrow('telegram_channel_ref_required')

    expect(db.query).not.toHaveBeenCalled()
  })

  it('reactivates a disabled Telegram identity for the same user before inserting', async () => {
    const db = { query: vi.fn() }
    db.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'account-reactivated' }], rowCount: 1 })

    await expect(
      upsertVerifiedTelegramAccount(
        db as never,
        'user-1',
        {
          providerUserId: '777',
          providerChannelId: '777',
        },
        'channels/cc-a'
      )
    ).resolves.toEqual({ ok: true, accountId: 'account-reactivated' })

    expect(db.query).toHaveBeenCalledTimes(3)
    expect(db.query.mock.calls[2]![0]).toContain('disabled_at = NULL')
    expect(db.query.mock.calls[2]![0]).toContain('disabled_at IS NOT NULL')
  })

  it('treats an active Telegram identity owned by the same user as idempotent success', async () => {
    const db = { query: vi.fn() }
    db.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'account-existing', user_id: 'user-1' }], rowCount: 1 })

    await expect(
      upsertVerifiedTelegramAccount(
        db as never,
        'user-1',
        {
          providerUserId: '777',
          providerChannelId: '777',
        },
        'channels/cc-a'
      )
    ).resolves.toEqual({ ok: true, accountId: 'account-existing' })

    expect(db.query).toHaveBeenCalledTimes(2)
    expect(db.query.mock.calls[1]![0]).toContain('FOR UPDATE')
  })

  it('keeps failing closed when an active Telegram identity belongs to another user', async () => {
    const db = { query: vi.fn() }
    db.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'account-other', user_id: 'user-2' }], rowCount: 1 })

    await expect(
      upsertVerifiedTelegramAccount(
        db as never,
        'user-1',
        {
          providerUserId: '777',
          providerChannelId: '777',
        },
        'channels/cc-a'
      )
    ).resolves.toEqual({ ok: false, error: 'telegram_identity_already_verified' })
  })

  it('resolves a same-user insert race without aborting the transaction', async () => {
    const db = { query: vi.fn() }
    db.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 'account-raced', user_id: 'user-1' }], rowCount: 1 })

    await expect(
      upsertVerifiedTelegramAccount(
        db as never,
        'user-1',
        {
          providerUserId: '777',
          providerChannelId: '777',
        },
        'channels/cc-a'
      )
    ).resolves.toEqual({ ok: true, accountId: 'account-raced' })

    expect(db.query.mock.calls[3]![0]).toContain('ON CONFLICT DO NOTHING')
  })
})
