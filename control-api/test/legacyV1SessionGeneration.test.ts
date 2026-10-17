import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import type { EffectiveUserAccessPolicy } from '../src/services/access/userAccessPolicy.js'
import { issueExternalUserSession } from '../src/services/auth/externalSessionIssuance.js'
import {
  revokeAllUserSessions,
  revokeLegacyUserSession,
  validateLegacyUserSession,
} from '../src/services/auth/userSessionService.js'
import { verifyExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'

const legacyPolicy = { issueV1: true, acceptV1: true } as EffectiveUserAccessPolicy

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function legacyAuthorityDatabase() {
  const state = {
    userId: randomUUID(),
    lifecycleVersion: 1,
    validAfter: null as Date | null,
    revokedFingerprints: new Set<string>(),
    now: new Date(Math.floor(Date.now() / 1000) * 1000),
  }

  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('clock_timestamp()')) return { rows: [{ db_now: state.now }], rowCount: 1 }
      if (sql.includes('SELECT lifecycle_state, lifecycle_version')) {
        return {
          rows: [{ lifecycle_state: 'active', lifecycle_version: state.lifecycleVersion }],
          rowCount: 1,
        }
      }
      if (sql.includes('SET lifecycle_version = lifecycle_version + 1')) {
        state.lifecycleVersion += 1
        return { rows: [{ lifecycle_version: state.lifecycleVersion }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO external_user_session_security_epochs')) {
        state.validAfter = values[1] as Date
        return { rows: [], rowCount: 1 }
      }
      if (
        sql.includes('SELECT valid_after') &&
        sql.includes('external_user_session_security_epochs')
      ) {
        return state.validAfter
          ? { rows: [{ valid_after: state.validAfter }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE external_user_sessions')) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO external_v1_session_revocations')) {
        state.revokedFingerprints.add(values[0] as string)
        return { rows: [{ token_hash: values[0] }], rowCount: 1 }
      }
      if (sql.includes('SELECT id FROM users WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: state.userId }], rowCount: 1 }
      }
      if (sql.includes('SELECT u.id, u.lifecycle_state, u.lifecycle_version')) {
        return {
          rows: [
            {
              id: state.userId,
              lifecycle_state: 'active',
              lifecycle_version: state.lifecycleVersion,
              valid_after: state.validAfter,
              token_revoked: state.revokedFingerprints.has(values[1] as string),
            },
          ],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected legacy authority query: ${sql}`)
    },
  }
  return { db, state }
}

async function issueLegacy(
  db: ReturnType<typeof legacyAuthorityDatabase>['db'],
  userId: string,
  authGeneration: number
): Promise<string> {
  return (
    await issueExternalUserSession(
      {
        contract: 'v1',
        userId,
        email: 'legacy@example.test',
        teamId: 'team-1',
        role: 'member',
        // This observed value models existing callers. The canonical issuer must
        // re-read lifecycle_version while it holds the user lock.
        authGeneration,
        authenticationMethods: ['password'],
      },
      { db, policy: legacyPolicy }
    )
  ).token
}

function verified(token: string) {
  const claims = verifyExternalSessionToken(token)
  if (!claims) throw new Error('expected real V1 signer to produce a verifiable token')
  return claims
}

describe('legacy V1 security-event generation and representation identity', () => {
  it('keeps a same-second post-event V1 issuance usable while revoking the predecessor', async () => {
    const { db, state } = legacyAuthorityDatabase()
    const predecessor = await issueLegacy(db, state.userId, state.lifecycleVersion)
    const predecessorClaims = verified(predecessor)

    await revokeAllUserSessions(state.userId, 'password_changed', db)
    const successor = await issueLegacy(db, state.userId, state.lifecycleVersion)
    const successorClaims = verified(successor)

    expect(successorClaims.authGeneration).toBe(2)
    expect(successorClaims.iat).toBe(Math.floor(state.now.getTime() / 1000))
    expect(successorClaims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    await expect(
      validateLegacyUserSession(predecessor, predecessorClaims, { db })
    ).resolves.toEqual({
      status: 'revoked',
      reason: 'security_event',
    })
    await expect(
      validateLegacyUserSession(successor, successorClaims, { db })
    ).resolves.toMatchObject({
      status: 'valid',
    })
  })

  it('keeps an individually revoked V1 representation revoked without revoking a same-second successor', async () => {
    const { db, state } = legacyAuthorityDatabase()
    const first = await issueLegacy(db, state.userId, state.lifecycleVersion)
    const firstClaims = verified(first)
    await expect(revokeLegacyUserSession(first, firstClaims, 'logout', db)).resolves.toBe(true)

    const successor = await issueLegacy(db, state.userId, state.lifecycleVersion)
    const successorClaims = verified(successor)

    expect(successor).not.toBe(first)
    expect(fingerprint(successor)).not.toBe(fingerprint(first))
    expect(successorClaims.jti).toEqual(expect.any(String))
    expect(state.lifecycleVersion).toBe(1)
    await expect(validateLegacyUserSession(first, firstClaims, { db })).resolves.toEqual({
      status: 'revoked',
      reason: 'logout',
    })
    await expect(
      validateLegacyUserSession(successor, successorClaims, { db })
    ).resolves.toMatchObject({
      status: 'valid',
    })
  })
})
