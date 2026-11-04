import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DbClient } from '../src/db.js'
import type { AuthClaims, TeamRole } from '../src/profileTypes.js'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { exchangeLegacyExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const signer = vi.hoisted(() => ({ sign: vi.fn() }))

// issueExternalUserSession is called through a local binding inside the module,
// so the signer is observed through a module mock that delegates to the real one.
vi.mock('../src/utils/auth/externalSessionAuthToken.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/utils/auth/externalSessionAuthToken.js')>()
  signer.sign.mockImplementation(actual.signExternalSessionToken)
  return { ...actual, signExternalSessionToken: signer.sign }
})

const legacyPolicy = { issueV1: true, acceptV1: true } as EffectiveUserAccessPolicy

function exchangeDatabase(lockedRole: TeamRole) {
  const userId = randomUUID()
  const membershipQueries: unknown[][] = []
  const now = new Date(Math.floor(Date.now() / 1000) * 1000)
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('clock_timestamp()')) return { rows: [{ db_now: now }], rowCount: 1 }
      if (sql.includes('SELECT tm.role, u.lifecycle_state, u.lifecycle_version')) {
        membershipQueries.push(values)
        return {
          rows: [{ role: lockedRole, lifecycle_state: 'active', lifecycle_version: 1 }],
          rowCount: 1,
        }
      }
      if (sql.includes('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE')) {
        return { rows: [{ id: userId }], rowCount: 1 }
      }
      if (sql.includes('SELECT u.id, u.lifecycle_state, u.lifecycle_version')) {
        return {
          rows: [
            {
              id: userId,
              lifecycle_state: 'active',
              lifecycle_version: 1,
              valid_after: null,
              token_revoked: false,
            },
          ],
          rowCount: 1,
        }
      }
      if (
        sql.includes('SELECT valid_after') &&
        sql.includes('external_user_session_security_epochs')
      ) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`unexpected exchange query: ${sql}`)
    },
  }
  return { db, userId, membershipQueries, now }
}

async function exchange(requestedRole: TeamRole, database: ReturnType<typeof exchangeDatabase>) {
  const email = `exchange-${database.userId}@example.test`
  const teamId = randomUUID()
  const issuedAt = Math.floor(database.now.getTime() / 1000) - 60
  const claims: AuthClaims = {
    userId: database.userId,
    email,
    teamId: null,
    role: 'member',
    authGeneration: 1,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }
  const result = await exchangeLegacyExternalUserSession(
    {
      token: 'legacy-session-token',
      claims,
      userId: database.userId,
      email,
      teamId,
      role: requestedRole,
    },
    {
      policy: legacyPolicy,
      transaction: work => work(database.db as unknown as DbClient),
    }
  )
  return { result, email, teamId }
}

describe('legacy session exchange role check', () => {
  beforeEach(() => {
    signer.sign.mockClear()
  })

  it('answers membership_not_found without signing when the requested role differs from the locked membership', async () => {
    const database = exchangeDatabase('member')

    const { result, email, teamId } = await exchange('admin', database)

    expect(result).toEqual({ status: 'membership_not_found' })
    // Witness: the locked membership read ran once for this identity and team.
    expect(database.membershipQueries).toEqual([[database.userId, email, teamId]])
    expect(signer.sign).not.toHaveBeenCalled()
  })

  it('issues a token carrying the locked role when the requested role matches', async () => {
    const database = exchangeDatabase('member')

    const { result, email, teamId } = await exchange('member', database)

    expect(result).toMatchObject({ status: 'issued', role: 'member' })
    expect(database.membershipQueries).toEqual([[database.userId, email, teamId]])
    expect(signer.sign).toHaveBeenCalledOnce()
    expect(signer.sign.mock.calls[0]?.[0]).toMatchObject({ role: 'member', teamId })
    const token = (result as { token: string }).token
    expect(verifyExternalSessionToken(token)).toMatchObject({ role: 'member', teamId })
  })
})
