import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listVerifiedMediumAccountsWithPreference,
  preferVerifiedMediumAccount,
} from '../src/services/workflowApprovalMediumPreferenceService.js'

const dbMock = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: dbMock.query,
  },
}))

describe('workflowApprovalMediumPreferenceService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.query.mockReset()
  })

  it('lists verified media with the most recently selected account marked preferred', async () => {
    dbMock.query.mockResolvedValueOnce({
      rows: [{ id: 'account-1', medium: 'telegram', isPreferred: true }],
      rowCount: 1,
    } as any)

    const result = await listVerifiedMediumAccountsWithPreference('user-1')

    expect(result).toEqual([{ id: 'account-1', medium: 'telegram', isPreferred: true }])
    expect(String(dbMock.query.mock.calls[0]![0])).toContain('ROW_NUMBER() OVER')
    expect(String(dbMock.query.mock.calls[0]![0])).not.toContain('PARTITION BY medium')
    expect(String(dbMock.query.mock.calls[0]![0])).toContain('updated_at DESC')
    expect(dbMock.query.mock.calls[0]![1]).toEqual(['user-1', false])
  })

  it('sets preference by moving the selected active user account to the top', async () => {
    dbMock.query.mockResolvedValueOnce({
      rows: [{ id: 'account-2', medium: 'slack', isPreferred: true }],
      rowCount: 1,
    } as any)

    const result = await preferVerifiedMediumAccount({ userId: 'user-1', accountId: 'account-2' })

    expect(result).toEqual({ id: 'account-2', medium: 'slack', isPreferred: true })
    expect(String(dbMock.query.mock.calls[0]![0])).toContain('disabled_at IS NULL')
    expect(dbMock.query.mock.calls[0]![1]).toEqual(['account-2', 'user-1'])
  })
})
