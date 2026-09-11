import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticatePasswordAndIssueSession } from '../src/services/auth/passwordSessionAuthentication.js'

const mocks = vi.hoisted(() => ({
  passwordLoginData: vi.fn(),
  issueExternalUserSession: vi.fn(),
  transactionQuery: vi.fn(),
  beforeTransaction: vi.fn(async () => undefined),
}))

vi.mock('../src/services/directory/login.js', () => ({
  passwordLoginData: mocks.passwordLoginData,
}))
vi.mock('../src/services/auth/externalSessionIssuance.js', () => ({
  issueExternalUserSession: mocks.issueExternalUserSession,
}))
vi.mock('../src/db.js', () => ({
  withTransaction: async (work: (db: { query: typeof mocks.transactionQuery }) => unknown) => {
    await mocks.beforeTransaction()
    return work({ query: mocks.transactionQuery })
  },
}))

const verifiedLogin = {
  user: { id: 'user-1', email: 'user@example.com', name: 'Ada', picture: null },
  membership: { team_id: 'team-1', team_name: 'Team 1', role: 'member' },
  credentialHash: 'old-password-hash',
}

describe('password session issuance serialization', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.passwordLoginData.mockResolvedValue(verifiedLogin)
    mocks.beforeTransaction.mockResolvedValue(undefined)
    mocks.issueExternalUserSession.mockResolvedValue({ token: 'v2-token', contract: 'v2' })
  })

  it('does not issue after a password change commits between verification and the row lock', async () => {
    let releasePasswordChange!: () => void
    const passwordChangeCommitted = new Promise<void>(resolve => {
      releasePasswordChange = resolve
    })
    mocks.beforeTransaction.mockImplementationOnce(async () => passwordChangeCommitted)
    mocks.transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const login = authenticatePasswordAndIssueSession({
      email: 'user@example.com',
      password: 'old-password',
      contract: 'v2',
    })
    await vi.waitFor(() => expect(mocks.passwordLoginData).toHaveBeenCalledTimes(1))

    releasePasswordChange()

    await expect(login).resolves.toBeNull()
    expect(String(mocks.transactionQuery.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(mocks.issueExternalUserSession).not.toHaveBeenCalled()
  })

  it('issues in the locked transaction while the verified credential is current', async () => {
    mocks.transactionQuery.mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 })

    await expect(
      authenticatePasswordAndIssueSession({
        email: 'user@example.com',
        password: 'current-password',
        contract: 'v2',
      })
    ).resolves.toMatchObject({ issued: { token: 'v2-token', contract: 'v2' } })

    expect(mocks.issueExternalUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', authenticationMethods: ['pwd'] }),
      { db: { query: mocks.transactionQuery } }
    )
  })
})
