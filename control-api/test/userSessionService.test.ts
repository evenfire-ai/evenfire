import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AuthClaims } from '../src/profileTypes.js'
import {
  USER_SESSION_ABSOLUTE_LIFETIME_SECONDS,
  USER_SESSION_IDLE_LIFETIME_SECONDS,
  USER_SESSION_MAX_ACTIVE_PER_USER,
  createUserSession,
  renewUserSession,
  revokeAllUserSessions,
  validateLegacyUserSession,
  validateUserSessionClaims,
} from '../src/services/auth/userSessionService.js'
import { verifyUserSessionV2Token } from '../src/utils/auth/userSessionV2Token.js'

const now = new Date(Math.floor(Date.now() / 1000) * 1000)

function row(overrides: Record<string, unknown> = {}) {
  return {
    sid: randomUUID(),
    user_id: randomUUID(),
    email: 'user@example.com',
    session_version: 1,
    current_jti: randomUUID(),
    current_issued_at: now,
    prior_jti: null,
    prior_jti_expires_at: null,
    created_at: now,
    last_used_at: now,
    idle_expires_at: new Date(now.getTime() + USER_SESSION_IDLE_LIFETIME_SECONDS * 1000),
    absolute_expires_at: new Date(now.getTime() + USER_SESSION_ABSOLUTE_LIFETIME_SECONDS * 1000),
    revoked_at: null,
    revocation_reason: null,
    authentication_methods: ['pwd'],
    authenticated_at: now,
    ...overrides,
  }
}

function claimsFor(value: ReturnType<typeof row>, jti = String(value.current_jti)) {
  return {
    sub: String(value.user_id),
    sid: String(value.sid),
    jti,
    sv: Number(value.session_version),
    ver: 2 as const,
    typ: 'user_session' as const,
    email: String(value.email),
    auth_time: Math.floor(now.getTime() / 1000),
    amr: ['pwd'],
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(now.getTime() / 1000) + 3600,
  }
}

describe('user session state machine', () => {
  it('creates one session with frozen idle, absolute, and active-session bounds', async () => {
    const inserted = row()
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM users')) return { rows: [{ id: inserted.user_id }], rowCount: 1 }
      if (sql.includes('clock_timestamp()')) return { rows: [{ db_now: now }], rowCount: 1 }
      if (sql.includes('INSERT INTO external_user_sessions')) {
        return {
          rows: [{ ...inserted, sid: values?.[0], user_id: values?.[1], current_jti: values?.[2] }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const issued = await createUserSession(
      {
        userId: String(inserted.user_id),
        email: 'User@Example.com',
        authenticationMethods: ['pwd'],
      },
      { db: { query } }
    )

    const insertCall = query.mock.calls.find(call =>
      String(call[0]).includes('INSERT INTO external_user_sessions')
    )!
    const values = insertCall[1] as unknown[]
    expect((values[4] as Date).getTime() - now.getTime()).toBe(
      USER_SESSION_IDLE_LIFETIME_SECONDS * 1000
    )
    expect((values[5] as Date).getTime() - now.getTime()).toBe(
      USER_SESSION_ABSOLUTE_LIFETIME_SECONDS * 1000
    )
    expect(verifyUserSessionV2Token(issued.token)).toMatchObject({
      sub: inserted.user_id,
      sid: values[0],
      jti: values[2],
      sv: 1,
    })
    expect(String(query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(String(query.mock.calls[1]?.[0])).toContain('clock_timestamp()')
    expect(String(query.mock.calls[2]?.[0])).toContain('DELETE FROM external_user_sessions')
    expect(String(query.mock.calls[3]?.[0])).toContain('OFFSET $3')
    expect(query.mock.calls[3]?.[1]?.[2]).toBe(USER_SESSION_MAX_ACTIVE_PER_USER - 1)
  })

  it('rotates once and returns the same successor to an overlapping renewal', async () => {
    const original = row()
    let current = original
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT s.sid')) return { rows: [current], rowCount: 1 }
      if (sql.includes('clock_timestamp()')) return { rows: [{ db_now: now }], rowCount: 1 }
      if (sql.includes('SET prior_jti = current_jti')) {
        current = row({
          ...original,
          prior_jti: original.current_jti,
          prior_jti_expires_at: values?.[1],
          current_jti: values?.[2],
          current_issued_at: values?.[3],
          last_used_at: values?.[3],
          idle_expires_at: values?.[4],
        })
        return { rows: [current], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    const first = await renewUserSession(claimsFor(original), { db: { query } })
    expect('token' in first).toBe(true)
    const successor = 'token' in first ? first.token : ''

    const concurrent = await renewUserSession(claimsFor(current, String(original.current_jti)), {
      db: { query },
    })
    expect('token' in concurrent && concurrent.token).toBe(successor)
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('SET prior_jti = current_jti'))
    ).toHaveLength(1)
  })

  it('revokes reuse outside overlap and never extends expired state', async () => {
    const reused = row({
      prior_jti: randomUUID(),
      prior_jti_expires_at: new Date(now.getTime() - 1000),
    })
    const reuseQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT s.sid')) return { rows: [reused], rowCount: 1 }
      if (sql.includes('clock_timestamp()')) return { rows: [{ db_now: now }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    await expect(
      validateUserSessionClaims(claimsFor(reused, String(reused.prior_jti)), {
        db: { query: reuseQuery },
      })
    ).resolves.toEqual({ status: 'revoked', reason: 'representation_reuse' })

    const expired = row({ idle_expires_at: new Date(now.getTime() - 1000) })
    const expiryQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT s.sid')) return { rows: [expired], rowCount: 1 }
      if (sql.includes('clock_timestamp()')) return { rows: [{ db_now: now }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    await expect(
      validateUserSessionClaims(claimsFor(expired), { db: { query: expiryQuery } })
    ).resolves.toEqual({ status: 'expired', reason: 'idle_expired' })
    expect(
      expiryQuery.mock.calls.some(([sql]) => String(sql).includes('idle_expires_at = LEAST'))
    ).toBe(false)
  })

  it('invalidates v1 and v2 sessions together in the supplied transaction', async () => {
    const userId = randomUUID()
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: userId }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ db_now: now }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }),
    }
    await expect(revokeAllUserSessions(userId, 'password_changed', db)).resolves.toBe(2)
    expect(String(db.query.mock.calls[0]?.[0])).toContain('FOR UPDATE')
    expect(String(db.query.mock.calls[1]?.[0])).toContain('clock_timestamp()')
    expect(String(db.query.mock.calls[2]?.[0])).toContain('security_epochs')
    expect(String(db.query.mock.calls[3]?.[0])).toContain('external_user_sessions')

    const claims = {
      userId,
      email: 'user@example.com',
      teamId: null,
      role: 'member' as const,
      authGeneration: 1,
      exp: Math.floor(now.getTime() / 1000) + 3600,
      iat: Math.floor(now.getTime() / 1000),
    }
    const epochDb = {
      query: vi.fn(async (sql: string) =>
        sql.includes('clock_timestamp()')
          ? { rows: [{ db_now: now }], rowCount: 1 }
          : {
              rows: [
                {
                  id: userId,
                  lifecycle_state: 'active',
                  lifecycle_version: 1,
                  valid_after: now,
                  token_revoked: false,
                },
              ],
              rowCount: 1,
            }
      ),
    }
    await expect(validateLegacyUserSession('v1-token', claims, { db: epochDb })).resolves.toEqual({
      status: 'revoked',
      reason: 'security_event',
    })
  })

  it.each([
    ['active generation one', 'active', 1, null, false, 'valid'],
    ['retired generation one', 'retired', 1, null, false, 'revoked'],
    ['reactivated generation two', 'active', 2, null, false, 'revoked'],
    ['password/security epoch', 'active', 1, now, false, 'revoked'],
    ['explicit token revocation', 'active', 1, null, true, 'revoked'],
  ] as const)(
    'maps a missing-generation legacy token against %s authority',
    async (_label, lifecycleState, lifecycleVersion, validAfter, tokenRevoked, expectedStatus) => {
      const claims: AuthClaims = {
        userId: randomUUID(),
        email: 'legacy@example.com',
        teamId: null,
        role: 'member',
        exp: Math.floor(now.getTime() / 1000) + 3600,
        iat: Math.floor(now.getTime() / 1000) - 1,
      }
      const db = {
        query: vi.fn(async (sql: string) =>
          sql.includes('clock_timestamp()')
            ? { rows: [{ db_now: now }], rowCount: 1 }
            : {
                rows: [
                  {
                    id: claims.userId,
                    lifecycle_state: lifecycleState,
                    lifecycle_version: lifecycleVersion,
                    valid_after: validAfter,
                    token_revoked: tokenRevoked,
                  },
                ],
                rowCount: 1,
              }
        ),
      }

      const result = await validateLegacyUserSession('legacy-v1-token', claims, { db })
      expect(result.status).toBe(expectedStatus)
    }
  )
})
