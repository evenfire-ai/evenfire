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
    mocks.issueExternalUserSession.mockResolvedValue({
      token: 'synthetic-v2-token',
      contract: 'v2',
    })
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
      password: 'synthetic-old-password',
      contract: 'v2',
    })
    await vi.waitFor(() => expect(mocks.passwordLoginData).toHaveBeenCalledTimes(1))

    releasePasswordChange()

    await expect(login).resolves.toBeNull()
    const credentialLock = String(mocks.transactionQuery.mock.calls[0]?.[0])
    expect(credentialLock).toContain('lifecycle_state, lifecycle_version')
    expect(credentialLock).toContain('FOR NO KEY UPDATE')
    expect(credentialLock).not.toMatch(/\bFOR UPDATE\b/)
    expect(mocks.issueExternalUserSession).not.toHaveBeenCalled()
  })

  it('issues in the locked transaction while the verified credential is current', async () => {
    mocks.transactionQuery.mockResolvedValueOnce({
      rows: [{ id: 'user-1', lifecycle_state: 'active', lifecycle_version: 5 }],
      rowCount: 1,
    })

    await expect(
      authenticatePasswordAndIssueSession({
        email: 'user@example.com',
        password: 'synthetic-current-password',
        contract: 'v2',
      })
    ).resolves.toMatchObject({ issued: { token: 'synthetic-v2-token', contract: 'v2' } })

    // The issuer reuses the credential lock's row instead of locking the user again.
    expect(mocks.issueExternalUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', authenticationMethods: ['pwd'] }),
      expect.objectContaining({
        db: { query: mocks.transactionQuery },
        lockedUser: { lifecycleState: 'active', lifecycleVersion: 5 },
      })
    )
    expect(mocks.transactionQuery).toHaveBeenCalledTimes(1)
    expect(String(mocks.transactionQuery.mock.calls[0]?.[0])).toContain('FOR NO KEY UPDATE')
  })
})
