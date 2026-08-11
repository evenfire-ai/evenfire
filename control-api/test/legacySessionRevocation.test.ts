import { describe, expect, it, vi } from 'vitest'
import {
  revokeAllUserSessions,
  revokeLegacyUserSession,
  validateLegacyUserSession,
} from '../src/services/auth/userSessionService.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../src/utils/auth/externalSessionAuthToken.js'

const claims = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'user@example.com',
  teamId: '00000000-0000-4000-8000-000000000010',
  role: 'member' as const,
  exp: 2_000_000_000,
  iat: 1_900_000_000,
}

describe('legacy session revocation compatibility', () => {
  it('retains the issued-at timestamp required by the live security epoch', () => {
    const token = signExternalSessionToken({
      userId: claims.userId,
      email: claims.email,
      teamId: claims.teamId,
      role: claims.role,
    })
    expect(verifyExternalSessionToken(token)?.iat).toEqual(expect.any(Number))
  })

  it('rejects a token revoked individually or by a later user security event', async () => {
    const revokedDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: claims.userId, valid_after: null, token_revoked: true }],
        rowCount: 1,
      }),
    }
    await expect(validateLegacyUserSession('legacy-token', claims, revokedDb)).resolves.toEqual({
      status: 'revoked',
      reason: 'logout',
    })

    const epochDb = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: claims.userId,
            valid_after: new Date((claims.iat + 1) * 1000),
            token_revoked: false,
          },
        ],
        rowCount: 1,
      }),
    }
    await expect(validateLegacyUserSession('legacy-token', claims, epochDb)).resolves.toEqual({
      status: 'revoked',
      reason: 'security_event',
    })
  })

  it('records individual logout and revoke-all state in the supplied transaction', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ token_hash: 'hash' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: claims.userId }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }),
    }
    await expect(revokeLegacyUserSession('legacy-token', claims, 'logout', db)).resolves.toBe(true)
    await expect(
      revokeAllUserSessions(claims.userId, 'password_changed', db, new Date('2030-01-01T00:00:00Z'))
    ).resolves.toBe(2)

    expect(String(db.query.mock.calls[0]?.[0])).toContain('external_v1_session_revocations')
    expect(String(db.query.mock.calls[1]?.[0])).toContain('FOR UPDATE')
    expect(String(db.query.mock.calls[2]?.[0])).toContain('external_user_session_security_epochs')
    expect(String(db.query.mock.calls[3]?.[0])).toContain('external_user_sessions')
  })
})
