import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import {
  confirmMediumChallenge,
  createChallengeCodeHash,
  createMediumChallenge,
  disableVerifiedMediumAccount,
  findVerifiedMediumAccount,
  listVerifiedMediumAccounts,
} from '../src/services/workflowApprovalMediumIdentityService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const mockedQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>
const mockedWithTransaction = vi.mocked(withTransaction)

describe('workflowApprovalMediumIdentityService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
    mockedWithTransaction.mockReset()
  })

  it('creates a six-digit challenge, stores only a hash, and queues first-party delivery', async () => {
    mockedQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'challenge-1', expiresAt: '2026-05-03T12:10:00.000Z' }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

    const result = await createMediumChallenge({
      userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      identity: {
        medium: 'discord',
        providerUserId: 'discord-user-1',
        providerWorkspaceId: 'guild-1',
        providerChannelId: 'chat-1',
      },
    })

    expect(result).toEqual({ id: 'challenge-1', expiresAt: '2026-05-03T12:10:00.000Z' })
    const insertParams = mockedQuery.mock.calls[0][1] as unknown[]
    expect(String(insertParams[5])).toMatch(/^sha256:/)
    expect(String(insertParams[5])).not.toMatch(/^\d{6}$/)

    const deliveryParams = mockedQuery.mock.calls[1][1] as unknown[]
    const payload = JSON.parse(String(deliveryParams[3])) as { code: string }
    expect(payload.code).toMatch(/^\d{6}$/)
  })

  it('rejects generic Telegram challenges because Telegram requires a target', async () => {
    await expect(
      createMediumChallenge({
        userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        identity: {
          medium: 'telegram',
          providerUserId: 'telegram-user-1',
          providerChannelId: 'chat-1',
        },
      })
    ).rejects.toThrow('telegram_target_required')

    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('rejects generic Slack challenges because Slack requires a target', async () => {
    await expect(
      createMediumChallenge({
        userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        identity: {
          medium: 'slack',
          providerUserId: 'slack-user-1',
          providerWorkspaceId: 'T123',
          providerChannelId: 'chat-1',
        },
      })
    ).rejects.toThrow('slack_target_required')

    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('confirms a valid code and upserts the verified medium account', async () => {
    const txQuery = vi.fn()
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))
    const codeHash = createChallengeCodeHash({
      userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      medium: 'discord',
      providerUserId: 'U123',
      code: '123456',
      saltHex: 'abcd'.repeat(8),
    })
    txQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'challenge-1',
            userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            medium: 'discord',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'C123',
            codeHash,
            isExpired: false,
            consumedAt: null,
            attempts: 0,
          },
        ],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: 'account-1' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

    const result = await confirmMediumChallenge({
      challengeId: '99999999-8888-7777-6666-555555555555',
      userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      code: '123456',
    })

    expect(result).toEqual({ ok: true, accountId: 'account-1' })
    const accountUpdateSql = String(txQuery.mock.calls[1]![0])
    expect(accountUpdateSql).toContain("COALESCE(provider_channel_id, '') = COALESCE($5, '')")
    expect(accountUpdateSql).not.toContain('provider_channel_id = $5,')
    const legacyDisableSql = String(txQuery.mock.calls[2]![0])
    expect(legacyDisableSql).toContain('provider_channel_id IS NULL')
    expect(legacyDisableSql).toContain('disabled_at IS NULL')
    expect(txQuery.mock.calls[2]![1]).toEqual(['discord', 'U123', 'T123'])
    expect(txQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE workflow_approval_medium_challenges'),
      ['challenge-1']
    )
  })

  it('increments attempts when the challenge code is invalid', async () => {
    const txQuery = vi.fn()
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))
    const codeHash = createChallengeCodeHash({
      userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      medium: 'discord',
      providerUserId: 'D123',
      code: '654321',
      saltHex: 'dcba'.repeat(8),
    })
    txQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'challenge-1',
            userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            medium: 'discord',
            providerUserId: 'D123',
            providerWorkspaceId: null,
            providerChannelId: null,
            codeHash,
            isExpired: false,
            consumedAt: null,
            attempts: 0,
          },
        ],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

    const result = await confirmMediumChallenge({
      challengeId: '99999999-8888-7777-6666-555555555555',
      userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      code: '000000',
    })

    expect(result).toEqual({ ok: false, error: 'invalid_code' })
    expect(txQuery).toHaveBeenCalledWith(expect.stringContaining('SET attempts = attempts + 1'), [
      'challenge-1',
    ])
  })

  it('rejects malformed confirmation codes before opening a transaction', async () => {
    const result = await confirmMediumChallenge({
      challengeId: '99999999-8888-7777-6666-555555555555',
      userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      code: '12345x',
    })

    expect(result).toEqual({ ok: false, error: 'invalid_code' })
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('rejects legacy Telegram challenge confirmation before upserting an account', async () => {
    const txQuery = vi.fn()
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))
    txQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'challenge-1',
          userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          medium: 'telegram',
          providerUserId: '123',
          providerWorkspaceId: null,
          providerChannelId: '123',
          codeHash: createChallengeCodeHash({
            userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            medium: 'telegram',
            providerUserId: '123',
            code: '123456',
            saltHex: '1234'.repeat(8),
          }),
          isExpired: false,
          consumedAt: null,
          attempts: 0,
        },
      ],
      rowCount: 1,
    } as any)

    await expect(
      confirmMediumChallenge({
        challengeId: '99999999-8888-7777-6666-555555555555',
        userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        code: '123456',
      })
    ).resolves.toEqual({ ok: false, error: 'telegram_target_required' })

    expect(txQuery).toHaveBeenCalledTimes(1)
  })

  it('rejects legacy Slack challenge confirmation before upserting an account', async () => {
    const txQuery = vi.fn()
    mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as any))
    txQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'challenge-1',
          userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
          codeHash: createChallengeCodeHash({
            userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            medium: 'slack',
            providerUserId: 'U123',
            code: '123456',
            saltHex: '1234'.repeat(8),
          }),
          isExpired: false,
          consumedAt: null,
          attempts: 0,
        },
      ],
      rowCount: 1,
    } as any)

    await expect(
      confirmMediumChallenge({
        challengeId: '99999999-8888-7777-6666-555555555555',
        userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        code: '123456',
      })
    ).resolves.toEqual({ ok: false, error: 'slack_target_required' })

    expect(txQuery).toHaveBeenCalledTimes(1)
  })

  it('rejects consumed, expired, and exhausted challenges without upserting an account', async () => {
    const cases = [
      {
        consumedAt: '2026-05-03T12:00:00.000Z',
        isExpired: false,
        attempts: 0,
        error: 'challenge_consumed',
      },
      { consumedAt: null, isExpired: true, attempts: 0, error: 'challenge_expired' },
      { consumedAt: null, isExpired: false, attempts: 5, error: 'too_many_attempts' },
    ]

    for (const testCase of cases) {
      const txQuery = vi.fn()
      mockedWithTransaction.mockImplementationOnce(async work => work({ query: txQuery } as any))
      txQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'challenge-1',
            userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            medium: 'discord',
            providerUserId: '123',
            providerWorkspaceId: 'T123',
            providerChannelId: null,
            codeHash: createChallengeCodeHash({
              userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              medium: 'discord',
              providerUserId: '123',
              code: '123456',
              saltHex: '1234'.repeat(8),
            }),
            isExpired: testCase.isExpired,
            consumedAt: testCase.consumedAt,
            attempts: testCase.attempts,
          },
        ],
        rowCount: 1,
      } as any)

      await expect(
        confirmMediumChallenge({
          challengeId: '99999999-8888-7777-6666-555555555555',
          userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          code: '123456',
        })
      ).resolves.toEqual({ ok: false, error: testCase.error })

      expect(
        txQuery.mock.calls.some(call =>
          String(call[0]).includes('workflow_approval_medium_accounts')
        )
      ).toBe(false)
    }
  })

  it('binds verified account lookup to the stable provider channel when provided', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

    await expect(
      findVerifiedMediumAccount({
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'chat-2',
      })
    ).resolves.toBeNull()

    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining('provider_channel_id'), [
      'telegram',
      '123456',
      null,
      'chat-2',
    ])
    expect(String(mockedQuery.mock.calls[0]![0])).toContain('provider_channel_id = $4')
  })

  it('requires stable provider channel identity before verified account lookup', async () => {
    await expect(
      findVerifiedMediumAccount({
        medium: 'telegram',
        providerUserId: '123456',
      })
    ).rejects.toThrow('provider_channel_id_required')
    expect(mockedQuery).not.toHaveBeenCalled()
  })

  it('binds Slack account lookup to both workspace and channel identity', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

    await expect(
      findVerifiedMediumAccount({
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T999',
        providerChannelId: 'C123',
      })
    ).resolves.toBeNull()

    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining('provider_channel_id'), [
      'slack',
      'U123',
      'T999',
      'C123',
    ])
  })

  it('finds, lists, and disables verified accounts without using usernames as identity', async () => {
    mockedQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'account-1',
            userId: 'user-1',
            medium: 'telegram',
            providerUserId: '123456',
            providerWorkspaceId: null,
            providerChannelId: 'chat-1',
          },
        ],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'account-1',
            userId: 'user-1',
            medium: 'telegram',
            providerUserId: '123456',
            providerWorkspaceId: null,
            providerChannelId: 'chat-1',
          },
        ],
        rowCount: 1,
      } as any)
      // disable runs inside withTransaction: UPDATE the account (rowCount 1) ...
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      // ... then the preferred_account_id lifecycle cleanup.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
    // disableVerifiedMediumAccount now wraps its work in withTransaction; run the
    // callback against the same query mock.
    mockedWithTransaction.mockImplementation(async work => work({ query: mockedQuery } as never))

    await expect(
      findVerifiedMediumAccount({
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'chat-1',
      })
    ).resolves.toMatchObject({ id: 'account-1', providerUserId: '123456' })
    await expect(listVerifiedMediumAccounts('user-1')).resolves.toHaveLength(1)
    expect(String(mockedQuery.mock.calls[1]![0])).toContain('disabled_at IS NULL')
    await expect(
      disableVerifiedMediumAccount({ userId: 'user-1', accountId: 'account-1' })
    ).resolves.toBe(true)
    // Lifecycle cleanup query targets user_notification_preferences.
    expect(String(mockedQuery.mock.calls[3]![0])).toContain('user_notification_preferences')
  })

  it('can list disabled medium accounts only when explicitly requested', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'account-disabled',
          userId: 'user-1',
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'chat-1',
          disabledAt: '2026-06-05T18:00:00.000Z',
        },
      ],
      rowCount: 1,
    } as any)

    await expect(
      listVerifiedMediumAccounts('user-1', { includeDisabled: true })
    ).resolves.toHaveLength(1)
    expect(String(mockedQuery.mock.calls[0]![0])).not.toContain('disabled_at IS NULL')
    expect(String(mockedQuery.mock.calls[0]![0])).toContain('disabled_at IS NOT NULL')
  })
})
