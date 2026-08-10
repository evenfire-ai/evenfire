import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  USER_SESSION_ABSOLUTE_LIFETIME_SECONDS,
  USER_SESSION_IDLE_LIFETIME_SECONDS,
  USER_SESSION_RENEWAL_OVERLAP_SECONDS,
  createUserSession,
  renewUserSession,
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
  it('creates one session with the frozen idle and absolute bounds', async () => {
    const inserted = row()
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: [{ ...inserted, sid: values?.[0], user_id: values?.[1], current_jti: values?.[2] }],
      rowCount: 1,
    }))

    const issued = await createUserSession(
      {
        userId: String(inserted.user_id),
        email: 'User@Example.com',
        authenticationMethods: ['pwd'],
      },
      { db: { query }, now }
    )

    const values = query.mock.calls[0]?.[1] as unknown[]
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
  })

  it('rotates the representation and returns the same successor to an overlapping renewal', async () => {
    const original = row()
    let current = original
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT s.sid')) return { rows: [current], rowCount: 1 }
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

    const first = await renewUserSession(claimsFor(original), { db: { query }, now })
    expect('token' in first).toBe(true)
    const successor = 'token' in first ? first.token : ''

    const concurrent = await renewUserSession(claimsFor(current, String(original.current_jti)), {
      db: { query },
      now: new Date(now.getTime() + (USER_SESSION_RENEWAL_OVERLAP_SECONDS - 1) * 1000),
    })
    expect('token' in concurrent && concurrent.token).toBe(successor)
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes('SET prior_jti = current_jti'))
    ).toHaveLength(1)
  })

  it('revokes a session when a superseded representation is reused outside overlap', async () => {
    const value = row({
      prior_jti: randomUUID(),
      prior_jti_expires_at: new Date(now.getTime() - 1000),
    })
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT s.sid')) return { rows: [value], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })

    await expect(
      validateUserSessionClaims(claimsFor(value, String(value.prior_jti)), {
        db: { query },
        now,
      })
    ).resolves.toEqual({ status: 'revoked', reason: 'representation_reuse' })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('revocation_reason'),
      expect.arrayContaining([String(value.sid), now, 'representation_reuse'])
    )
  })

  it('fails expired sessions without extending the idle or absolute limit', async () => {
    const value = row({ idle_expires_at: new Date(now.getTime() - 1000) })
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT s.sid')) return { rows: [value], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })

    await expect(
      validateUserSessionClaims(claimsFor(value), { db: { query }, now })
    ).resolves.toEqual({ status: 'expired', reason: 'idle_expired' })
    expect(query.mock.calls.some(([sql]) => String(sql).includes('idle_expires_at = LEAST'))).toBe(
      false
    )
  })
})
