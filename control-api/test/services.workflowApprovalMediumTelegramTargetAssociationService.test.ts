import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool } from '../src/db.js'
import { disableVerifiedMediumAccountWithTelegramAssociations } from '../src/services/workflowApprovalMediumTelegramTargetAssociationService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => ({
  getUserAgents: vi.fn(async () => ({ agentNames: [] as string[] })),
}))

const mockedQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>

describe('disableVerifiedMediumAccountWithTelegramAssociations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
  })

  it('clears the user preferred_account_id when soft-disabling the account', async () => {
    mockedQuery
      // 1. SELECT the target account (active, no providerChannelId → skip telegram cleanup)
      .mockResolvedValueOnce({
        rows: [
          {
            medium: 'slack',
            providerUserId: 'U123',
            providerChannelId: null,
            disabledAt: null,
          },
        ],
        rowCount: 1,
      } as never)
      // 2. UPDATE workflow_approval_medium_accounts (soft-disable succeeds)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      // 3. UPDATE user_notification_preferences (preferred_account_id lifecycle clear)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const result = await disableVerifiedMediumAccountWithTelegramAssociations({
      gateway: {} as never,
      userId: 'user-1',
      accountId: 'account-1',
    })

    expect(result).toBe(true)

    // The third query must clear preferred_account_id for the disabled account.
    const preferredClearCall = mockedQuery.mock.calls[2]!
    const sql = String(preferredClearCall[0])
    expect(sql).toContain('UPDATE user_notification_preferences')
    expect(sql).toContain('preferred_account_id = NULL')
    expect(sql).toContain('WHERE user_id = $1 AND preferred_account_id = $2')
    expect(preferredClearCall[1]).toEqual(['user-1', 'account-1'])
  })

  it('does not clear preferences when the soft-disable update matches no rows', async () => {
    mockedQuery
      // 1. SELECT the target account (active)
      .mockResolvedValueOnce({
        rows: [
          {
            medium: 'slack',
            providerUserId: 'U123',
            providerChannelId: null,
            disabledAt: null,
          },
        ],
        rowCount: 1,
      } as never)
      // 2. UPDATE workflow_approval_medium_accounts (no rows changed → early return false)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const result = await disableVerifiedMediumAccountWithTelegramAssociations({
      gateway: {} as never,
      userId: 'user-1',
      accountId: 'account-1',
    })

    expect(result).toBe(false)
    // Only the SELECT + the UPDATE ran; no preferred_account_id clear was issued.
    expect(mockedQuery).toHaveBeenCalledTimes(2)
    expect(
      mockedQuery.mock.calls.some(call => String(call[0]).includes('user_notification_preferences'))
    ).toBe(false)
  })
})
