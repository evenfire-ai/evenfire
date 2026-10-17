import { type DbClient, pool } from '../../db.js'
import type { AuthClaims } from '../../profileTypes.js'
import type { UserSessionV2Claims } from '../../utils/auth/userSessionV2Token.js'
import type { ExternalSessionAuthentication } from './externalSessionAuthentication.js'
import { legacyExternalSessionAuthGeneration } from './legacyV1Generation.js'
import {
  ExternalSessionBackendUnavailableError,
  externalSessionDatabaseFailure,
  isExternalSessionBackendUnavailableError,
} from './sessionDatabaseFailure.js'

type AuthenticatedSession = Extract<ExternalSessionAuthentication, { status: 'authenticated' }>
type CurrentnessDatabase = Pick<DbClient, 'query'>

export type ExternalSessionCurrentness =
  | { status: 'current' }
  | { status: 'denied'; reason: string }
  | { status: 'unavailable'; error: ExternalSessionBackendUnavailableError }

function dateOf(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function sessionDatabase(options: { db?: CurrentnessDatabase }): CurrentnessDatabase {
  return options.db ?? pool
}

/**
 * Read-only stream currentness observation over the authority accepted by the
 * initial session verifier. This deliberately does not call the request-time
 * validator: V2 validation may touch or revoke a session as part of normal
 * authentication, while an observer must never mutate session state.
 */
export async function observeExternalSessionCurrentness(
  authentication: AuthenticatedSession,
  options: { db?: CurrentnessDatabase } = {}
): Promise<ExternalSessionCurrentness> {
  const context = authentication.authorityContext
  const db = sessionDatabase(options)

  try {
    if (authentication.contract === 'v1' && context.contract === 'v1') {
      const claims = authentication.tokenClaims as AuthClaims
      const generation = legacyExternalSessionAuthGeneration(claims)
      if (
        claims.userId !== context.userId ||
        claims.iat !== context.issuedAt ||
        generation === null ||
        generation !== context.authGeneration
      ) {
        return { status: 'denied', reason: 'legacy_authority_mismatch' }
      }

      const result = await db.query(
        `WITH observed_clock AS (SELECT clock_timestamp() AS db_now)
         SELECT u.lifecycle_state,
                u.lifecycle_version,
                epoch.valid_after,
                observed_clock.db_now,
                EXISTS (
                  SELECT 1
                    FROM external_v1_session_revocations revoked
                   WHERE revoked.token_hash = $2
                     AND revoked.user_id = u.id
                     AND revoked.expires_at > observed_clock.db_now
                ) AS token_revoked
           FROM users u
           CROSS JOIN observed_clock
           LEFT JOIN external_user_session_security_epochs epoch ON epoch.user_id = u.id
          WHERE u.id = $1
          LIMIT 1`,
        [context.userId, context.tokenHash]
      )
      const row = result.rows[0] as
        | {
            lifecycle_state?: unknown
            lifecycle_version?: unknown
            valid_after?: Date | string | null
            db_now?: Date | string
            token_revoked?: boolean
          }
        | undefined
      const now = dateOf(row?.db_now)
      if (!row || !now || typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) {
        return { status: 'denied', reason: 'legacy_authority_expired_or_missing' }
      }
      if (
        row.lifecycle_state !== 'active' ||
        Number(row.lifecycle_version) !== context.authGeneration
      ) {
        return { status: 'denied', reason: 'legacy_generation_changed' }
      }
      if (row.token_revoked) return { status: 'denied', reason: 'legacy_representation_revoked' }
      const validAfter = dateOf(row.valid_after)
      if (validAfter && context.issuedAt * 1000 <= validAfter.getTime()) {
        return { status: 'denied', reason: 'legacy_security_cutoff' }
      }
      return { status: 'current' }
    }

    if (authentication.contract === 'v2' && context.contract === 'v2') {
      const claims = authentication.tokenClaims as UserSessionV2Claims
      if (
        claims.sub !== context.userId ||
        claims.sid !== context.sid ||
        claims.jti !== context.jti ||
        claims.sv !== context.sessionVersion
      ) {
        return { status: 'denied', reason: 'v2_authority_mismatch' }
      }

      const result = await db.query(
        `WITH observed_clock AS (SELECT clock_timestamp() AS db_now)
         SELECT s.user_id,
                s.session_version,
                s.current_jti,
                s.prior_jti,
                s.prior_jti_expires_at,
                s.idle_expires_at,
                s.absolute_expires_at,
                s.revoked_at,
                u.lifecycle_state,
                observed_clock.db_now
           FROM external_user_sessions s
           JOIN users u ON u.id = s.user_id
           CROSS JOIN observed_clock
          WHERE s.sid = $1
          LIMIT 1`,
        [context.sid]
      )
      const row = result.rows[0] as
        | {
            user_id?: string
            session_version?: number | string
            current_jti?: string
            prior_jti?: string | null
            prior_jti_expires_at?: Date | string | null
            idle_expires_at?: Date | string
            absolute_expires_at?: Date | string
            revoked_at?: Date | string | null
            lifecycle_state?: unknown
            db_now?: Date | string
          }
        | undefined
      const now = dateOf(row?.db_now)
      if (!row || !now || typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) {
        return { status: 'denied', reason: 'v2_authority_expired_or_missing' }
      }
      if (
        row.user_id !== context.userId ||
        row.lifecycle_state !== 'active' ||
        row.revoked_at !== null ||
        Number(row.session_version) !== context.sessionVersion
      ) {
        return { status: 'denied', reason: 'v2_session_revoked_or_changed' }
      }
      const idleExpiresAt = dateOf(row.idle_expires_at)
      const absoluteExpiresAt = dateOf(row.absolute_expires_at)
      if (
        !idleExpiresAt ||
        !absoluteExpiresAt ||
        now.getTime() >= idleExpiresAt.getTime() ||
        now.getTime() >= absoluteExpiresAt.getTime()
      ) {
        return { status: 'denied', reason: 'v2_session_expired' }
      }
      const currentRepresentation = claims.jti === row.current_jti
      const priorExpiry = dateOf(row.prior_jti_expires_at)
      const priorRepresentation =
        claims.jti === row.prior_jti &&
        priorExpiry !== null &&
        now.getTime() <= priorExpiry.getTime()
      if (!currentRepresentation && !priorRepresentation) {
        return { status: 'denied', reason: 'v2_representation_superseded' }
      }
      return { status: 'current' }
    }

    return { status: 'denied', reason: 'session_contract_mismatch' }
  } catch (error) {
    const classified = externalSessionDatabaseFailure(error)
    if (isExternalSessionBackendUnavailableError(classified)) {
      return { status: 'unavailable', error: classified }
    }
    throw classified
  }
}
