import { createHash, randomUUID } from 'node:crypto'
import { type DbClient, pool, withTransaction } from '../../db.js'
import type { AuthClaims } from '../../profileTypes.js'
import type { UserSessionV2Claims } from '../../utils/auth/userSessionV2Token.js'
import {
  USER_SESSION_V2_TTL_SECONDS,
  USER_SESSION_V2_TYPE,
  USER_SESSION_V2_VERSION,
  signUserSessionV2Token,
} from '../../utils/auth/userSessionV2Token.js'
import {
  runAccessDatabaseQuery,
  withAccessDatabaseTransaction,
} from '../access/accessDatabaseQuery.js'
import type { AccessExecutionBudget } from '../access/accessExecutionBudget.js'
import type { ExternalSessionAuthorityContext } from './externalSessionAuthentication.js'
import { legacyExternalSessionAuthGeneration } from './legacyV1Generation.js'

export const USER_SESSION_IDLE_LIFETIME_SECONDS = 14 * 24 * 60 * 60
export const USER_SESSION_ABSOLUTE_LIFETIME_SECONDS = 30 * 24 * 60 * 60
export const USER_SESSION_RENEWAL_OVERLAP_SECONDS = 10
export const USER_SESSION_MAX_ACTIVE_PER_USER = 20

type SessionDatabase = Pick<DbClient, 'query'>

type SessionRow = {
  sid: string
  user_id: string
  email: string
  session_version: number
  current_jti: string
  current_issued_at: Date | string
  prior_jti: string | null
  prior_jti_expires_at: Date | string | null
  created_at: Date | string
  last_used_at: Date | string
  idle_expires_at: Date | string
  absolute_expires_at: Date | string
  revoked_at: Date | string | null
  revocation_reason: string | null
  authentication_methods: string[]
  authenticated_at: Date | string
}

export type UserSessionIdentity = {
  userId: string
  email: string
  sid: string
  jti: string
  sessionVersion: number
  expiresAt: Date
  absoluteExpiresAt: Date
  authenticationMethods: string[]
}

export type UserSessionValidation =
  | { status: 'valid'; identity: UserSessionIdentity }
  | { status: 'invalid' | 'expired' | 'revoked'; reason: string }

export type IssuedUserSession = {
  token: string
  expiresInSeconds: number
  identity: UserSessionIdentity
}

function budgetedSessionDatabase(
  db: SessionDatabase,
  budget: AccessExecutionBudget
): SessionDatabase {
  const query = (text: string, values?: unknown[]) =>
    runAccessDatabaseQuery(db, budget, text, values ?? [])
  return Object.assign(Object.create(db), { query }) as SessionDatabase
}

function atSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
}

function plusSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function nullableDateOf(value: Date | string | null): Date | null {
  return value === null ? null : dateOf(value)
}

async function loadDatabaseNow(db: SessionDatabase): Promise<Date> {
  const result = await db.query(`SELECT date_trunc('second', clock_timestamp()) AS db_now`)
  const value = (result.rows[0] as { db_now?: Date | string } | undefined)?.db_now
  const now = value ? dateOf(value) : null
  if (!now || !Number.isFinite(now.getTime())) {
    throw new Error('database session clock unavailable')
  }
  return now
}

function identityFromRow(row: SessionRow): UserSessionIdentity {
  return {
    userId: row.user_id,
    email: row.email,
    sid: row.sid,
    jti: row.current_jti,
    sessionVersion: Number(row.session_version),
    expiresAt: plusSeconds(dateOf(row.current_issued_at), USER_SESSION_V2_TTL_SECONDS),
    absoluteExpiresAt: dateOf(row.absolute_expires_at),
    authenticationMethods: [...row.authentication_methods],
  }
}

function tokenFromRow(row: SessionRow): string {
  return signUserSessionV2Token(
    {
      sub: row.user_id,
      sid: row.sid,
      jti: row.current_jti,
      sv: Number(row.session_version),
      email: row.email,
      auth_time: Math.floor(dateOf(row.authenticated_at).getTime() / 1000),
      amr: [...row.authentication_methods],
    },
    Math.floor(dateOf(row.current_issued_at).getTime() / 1000)
  )
}

async function loadSessionForUpdate(db: SessionDatabase, sid: string): Promise<SessionRow | null> {
  const result = await db.query(
    `SELECT s.sid, s.user_id, u.email, s.session_version,
            s.current_jti, s.current_issued_at,
            s.prior_jti, s.prior_jti_expires_at,
            s.created_at, s.last_used_at, s.idle_expires_at,
            s.absolute_expires_at, s.revoked_at, s.revocation_reason,
            s.authentication_methods, s.authenticated_at
       FROM external_user_sessions s
       JOIN users u ON u.id = s.user_id AND u.lifecycle_state = 'active'
      WHERE s.sid = $1
      FOR UPDATE OF s`,
    [sid]
  )
  return (result.rows[0] as SessionRow | undefined) ?? null
}

async function revokeLoadedSession(
  db: SessionDatabase,
  row: SessionRow,
  reason: string,
  now: Date
): Promise<void> {
  await db.query(
    `UPDATE external_user_sessions
        SET revoked_at = COALESCE(revoked_at, $2),
            revocation_reason = COALESCE(revocation_reason, $3),
            session_version = session_version + CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END
      WHERE sid = $1`,
    [row.sid, now, reason]
  )
}

async function validateLoadedSession(
  db: SessionDatabase,
  row: SessionRow | null,
  claims: UserSessionV2Claims,
  now: Date,
  touch: boolean
): Promise<UserSessionValidation> {
  if (!row || row.user_id !== claims.sub) return { status: 'invalid', reason: 'session_not_found' }
  if (row.revoked_at) return { status: 'revoked', reason: row.revocation_reason || 'revoked' }
  if (Number(row.session_version) !== claims.sv) {
    return { status: 'revoked', reason: 'session_version_mismatch' }
  }
  if (now >= dateOf(row.absolute_expires_at)) {
    await revokeLoadedSession(db, row, 'absolute_expired', now)
    return { status: 'expired', reason: 'absolute_expired' }
  }
  if (now >= dateOf(row.idle_expires_at)) {
    await revokeLoadedSession(db, row, 'idle_expired', now)
    return { status: 'expired', reason: 'idle_expired' }
  }

  const priorExpiry = nullableDateOf(row.prior_jti_expires_at)
  const acceptedCurrent = claims.jti === row.current_jti
  const acceptedPrior =
    claims.jti === row.prior_jti && priorExpiry !== null && now.getTime() <= priorExpiry.getTime()
  if (!acceptedCurrent && !acceptedPrior) {
    await revokeLoadedSession(db, row, 'representation_reuse', now)
    return { status: 'revoked', reason: 'representation_reuse' }
  }

  if (touch) {
    await db.query(
      `UPDATE external_user_sessions
          SET last_used_at = $2,
              idle_expires_at = LEAST(absolute_expires_at, $3)
        WHERE sid = $1
          AND revoked_at IS NULL`,
      [row.sid, now, plusSeconds(now, USER_SESSION_IDLE_LIFETIME_SECONDS)]
    )
  }

  return { status: 'valid', identity: identityFromRow(row) }
}

export async function createUserSession(
  input: {
    userId: string
    email: string
    authenticationMethods: string[]
    authenticatedAt?: Date
  },
  options: { db?: SessionDatabase } = {}
): Promise<IssuedUserSession> {
  const sid = randomUUID()
  const jti = randomUUID()

  const work = async (db: SessionDatabase) => {
    const user = await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [input.userId])
    if ((user.rowCount ?? 0) === 0) throw new Error('user session principal does not exist')
    const now = await loadDatabaseNow(db)
    const authenticatedAt = atSecond(input.authenticatedAt ?? now)
    const idleExpiresAt = plusSeconds(now, USER_SESSION_IDLE_LIFETIME_SECONDS)
    const absoluteExpiresAt = plusSeconds(now, USER_SESSION_ABSOLUTE_LIFETIME_SECONDS)

    await db.query(
      `DELETE FROM external_user_sessions
        WHERE user_id = $1
          AND (revoked_at IS NOT NULL OR absolute_expires_at <= $2)`,
      [input.userId, now]
    )
    await db.query(
      `WITH overflow AS (
         SELECT sid
           FROM external_user_sessions
          WHERE user_id = $1
            AND revoked_at IS NULL
            AND absolute_expires_at > $2
          ORDER BY last_used_at DESC, created_at DESC, sid
         OFFSET $3
       )
       UPDATE external_user_sessions sessions
          SET revoked_at = $2,
              revocation_reason = 'session_limit',
              session_version = session_version + 1
         FROM overflow
        WHERE sessions.sid = overflow.sid`,
      [input.userId, now, USER_SESSION_MAX_ACTIVE_PER_USER - 1]
    )

    const result = await db.query(
      `INSERT INTO external_user_sessions(
         sid, user_id, session_version, current_jti, current_issued_at,
         created_at, last_used_at, idle_expires_at, absolute_expires_at,
         authentication_methods, authenticated_at
       )
       VALUES($1, $2, 1, $3, $4, $4, $4, $5, $6, $7::text[], $8)
       RETURNING sid, user_id, $9::text AS email, session_version,
                 current_jti, current_issued_at, prior_jti, prior_jti_expires_at,
                 created_at, last_used_at, idle_expires_at, absolute_expires_at,
                 revoked_at, revocation_reason, authentication_methods, authenticated_at`,
      [
        sid,
        input.userId,
        jti,
        now,
        idleExpiresAt,
        absoluteExpiresAt,
        input.authenticationMethods,
        authenticatedAt,
        input.email.trim().toLowerCase(),
      ]
    )
    const row = result.rows[0] as SessionRow | undefined
    if (!row) throw new Error('user session insert did not return a row')
    return {
      token: tokenFromRow(row),
      expiresInSeconds: USER_SESSION_V2_TTL_SECONDS,
      identity: identityFromRow(row),
    }
  }

  return options.db ? work(options.db) : withTransaction(work)
}

export async function validateUserSessionClaims(
  claims: UserSessionV2Claims,
  options: { db?: SessionDatabase; budget?: AccessExecutionBudget } = {}
): Promise<UserSessionValidation> {
  const work = async (db: SessionDatabase) => {
    const row = await loadSessionForUpdate(db, claims.sid)
    const now = await loadDatabaseNow(db)
    return validateLoadedSession(db, row, claims, now, true)
  }
  if (options.db) {
    return work(options.budget ? budgetedSessionDatabase(options.db, options.budget) : options.db)
  }
  return options.budget
    ? withAccessDatabaseTransaction(options.budget, work, { mode: 'read_write' })
    : withTransaction(work)
}

export async function renewUserSession(
  claims: UserSessionV2Claims,
  options: { db?: SessionDatabase; budget?: AccessExecutionBudget } = {}
): Promise<IssuedUserSession | UserSessionValidation> {
  const work = async (db: SessionDatabase) => {
    const row = await loadSessionForUpdate(db, claims.sid)
    const now = await loadDatabaseNow(db)
    const validation = await validateLoadedSession(db, row, claims, now, false)
    if (validation.status !== 'valid' || !row) return validation

    const priorExpiry = nullableDateOf(row.prior_jti_expires_at)
    const legitimateConcurrentRenewal =
      claims.jti === row.prior_jti && priorExpiry !== null && now <= priorExpiry
    if (legitimateConcurrentRenewal) {
      return {
        token: tokenFromRow(row),
        expiresInSeconds: USER_SESSION_V2_TTL_SECONDS,
        identity: identityFromRow(row),
      }
    }

    const nextJti = randomUUID()
    const idleExpiresAt = new Date(
      Math.min(
        plusSeconds(now, USER_SESSION_IDLE_LIFETIME_SECONDS).getTime(),
        dateOf(row.absolute_expires_at).getTime()
      )
    )
    const rotated = await db.query(
      `UPDATE external_user_sessions
          SET prior_jti = current_jti,
              prior_jti_expires_at = $2,
              current_jti = $3,
              current_issued_at = $4,
              last_used_at = $4,
              idle_expires_at = $5
        WHERE sid = $1
          AND revoked_at IS NULL
       RETURNING sid, user_id, $6::text AS email, session_version,
                 current_jti, current_issued_at, prior_jti, prior_jti_expires_at,
                 created_at, last_used_at, idle_expires_at, absolute_expires_at,
                 revoked_at, revocation_reason, authentication_methods, authenticated_at`,
      [
        row.sid,
        plusSeconds(now, USER_SESSION_RENEWAL_OVERLAP_SECONDS),
        nextJti,
        now,
        idleExpiresAt,
        row.email,
      ]
    )
    const next = rotated.rows[0] as SessionRow | undefined
    if (!next) return { status: 'invalid' as const, reason: 'session_not_found' }
    return {
      token: tokenFromRow(next),
      expiresInSeconds: USER_SESSION_V2_TTL_SECONDS,
      identity: identityFromRow(next),
    }
  }
  if (options.db) {
    return work(options.budget ? budgetedSessionDatabase(options.db, options.budget) : options.db)
  }
  return options.budget
    ? withAccessDatabaseTransaction(options.budget, work, { mode: 'read_write' })
    : withTransaction(work)
}

export async function revokeUserSession(
  userId: string,
  sid: string,
  reason: string,
  db?: SessionDatabase
): Promise<boolean> {
  const work = async (transaction: SessionDatabase): Promise<boolean> => {
    const locked = await transaction.query(
      `SELECT sid
         FROM external_user_sessions
        WHERE sid = $1
          AND user_id = $2
        FOR UPDATE`,
      [sid, userId]
    )
    if ((locked.rowCount ?? 0) === 0) return false
    const now = await loadDatabaseNow(transaction)
    const result = await transaction.query(
      `UPDATE external_user_sessions
          SET revoked_at = COALESCE(revoked_at, $3),
              revocation_reason = COALESCE(revocation_reason, $4),
              session_version = session_version + CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END
        WHERE sid = $1
          AND user_id = $2
          AND revoked_at IS NULL
        RETURNING sid`,
      [sid, userId, now, reason]
    )
    return (result.rowCount ?? 0) > 0
  }
  return db ? work(db) : withTransaction(work)
}

export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  db?: SessionDatabase
): Promise<number> {
  const work = async (transaction: SessionDatabase) => {
    const user = await transaction.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId])
    if ((user.rowCount ?? 0) === 0) return 0
    const revokedAt = await loadDatabaseNow(transaction)

    await transaction.query(
      `INSERT INTO external_user_session_security_epochs(user_id, valid_after, reason, updated_at)
       VALUES($1, $2, $3, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET valid_after = GREATEST(
               external_user_session_security_epochs.valid_after,
               EXCLUDED.valid_after
             ),
             reason = EXCLUDED.reason,
             updated_at = EXCLUDED.updated_at`,
      [userId, revokedAt, reason]
    )
    const result = await transaction.query(
      `UPDATE external_user_sessions
          SET revoked_at = $2,
              revocation_reason = $3,
              session_version = session_version + 1
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [userId, revokedAt, reason]
    )
    return result.rowCount ?? 0
  }

  return db ? work(db) : withTransaction(work)
}

export async function validateExternalSessionAuthorityContext(
  context: ExternalSessionAuthorityContext,
  options: { db?: SessionDatabase } = {}
): Promise<UserSessionValidation> {
  const work = async (db: SessionDatabase): Promise<UserSessionValidation> => {
    if (context.contract === 'v2') {
      const principal = await db.query(
        `SELECT id
           FROM users
          WHERE id = $1
            AND lifecycle_state = 'active'
          FOR UPDATE`,
        [context.userId]
      )
      if ((principal.rowCount ?? 0) === 0) {
        return { status: 'revoked', reason: 'user_unavailable' }
      }
      const row = await loadSessionForUpdate(db, context.sid)
      const now = await loadDatabaseNow(db)
      const claims: UserSessionV2Claims = {
        sub: context.userId,
        sid: context.sid,
        jti: context.jti,
        sv: context.sessionVersion,
        ver: USER_SESSION_V2_VERSION,
        typ: USER_SESSION_V2_TYPE,
        auth_time: 0,
        amr: ['session'],
        iat: 0,
        exp: 0,
      }
      return validateLoadedSession(db, row, claims, now, false)
    }

    const principal = await db.query(
      `SELECT id, email, lifecycle_state, lifecycle_version
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [context.userId]
    )
    const user = principal.rows[0] as
      | {
          id: string
          email: string
          lifecycle_state: string
          lifecycle_version: number | string
        }
      | undefined
    if (!user) return { status: 'invalid', reason: 'user_not_found' }
    if (
      user.lifecycle_state !== 'active' ||
      context.authGeneration !== Number(user.lifecycle_version)
    ) {
      return { status: 'revoked', reason: 'security_event' }
    }

    const now = await loadDatabaseNow(db)
    const authority = await db.query(
      `SELECT epoch.valid_after,
              EXISTS (
                SELECT 1
                  FROM external_v1_session_revocations revoked
                 WHERE revoked.token_hash = $2
                   AND revoked.user_id = $1
                   AND revoked.expires_at > $3
              ) AS token_revoked
         FROM users u
    LEFT JOIN external_user_session_security_epochs epoch ON epoch.user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [context.userId, context.tokenHash, now]
    )
    const row = authority.rows[0] as
      | {
          valid_after: Date | string | null
          token_revoked: boolean
        }
      | undefined
    if (!row) return { status: 'invalid', reason: 'user_not_found' }
    if (row.token_revoked) return { status: 'revoked', reason: 'logout' }
    if (row.valid_after && context.issuedAt * 1000 <= dateOf(row.valid_after).getTime()) {
      return { status: 'revoked', reason: 'security_event' }
    }
    return {
      status: 'valid',
      identity: {
        userId: context.userId,
        email: user.email,
        sid: '',
        jti: context.tokenHash,
        sessionVersion: 0,
        expiresAt: new Date(context.issuedAt * 1000),
        absoluteExpiresAt: new Date(context.issuedAt * 1000),
        authenticationMethods: [],
      },
    }
  }
  return work(options.db ?? pool)
}

function legacySessionFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export async function validateLegacyUserSession(
  token: string,
  claims: AuthClaims,
  options: { db?: SessionDatabase; budget?: AccessExecutionBudget; lockUser?: boolean } = {}
): Promise<UserSessionValidation> {
  const issuedAt = claims.iat
  if (!issuedAt) return { status: 'invalid', reason: 'invalid_legacy_representation' }
  const authGeneration = legacyExternalSessionAuthGeneration(claims)
  if (authGeneration === null) {
    return { status: 'invalid', reason: 'invalid_legacy_representation' }
  }
  const work = async (db: SessionDatabase): Promise<UserSessionValidation> => {
    if (options.lockUser) {
      const locked = await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        claims.userId,
      ])
      if ((locked.rowCount ?? 0) === 0) return { status: 'revoked', reason: 'user_unavailable' }
    }
    const now = await loadDatabaseNow(db)
    const result = await db.query(
      `SELECT u.id, u.lifecycle_state, u.lifecycle_version,
            epoch.valid_after,
            EXISTS (
              SELECT 1
                FROM external_v1_session_revocations revoked
               WHERE revoked.token_hash = $2
                 AND revoked.user_id = u.id
                 AND revoked.expires_at > $3
            ) AS token_revoked
       FROM users u
       LEFT JOIN external_user_session_security_epochs epoch ON epoch.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
      [claims.userId, legacySessionFingerprint(token), now]
    )
    const row = result.rows[0] as
      | {
          id: string
          lifecycle_state: string
          lifecycle_version: number | string
          valid_after: Date | string | null
          token_revoked: boolean
        }
      | undefined
    if (!row) return { status: 'invalid', reason: 'user_not_found' }
    if (row.lifecycle_state !== 'active' || authGeneration !== Number(row.lifecycle_version)) {
      return { status: 'revoked', reason: 'security_event' }
    }
    if (row.token_revoked) return { status: 'revoked', reason: 'logout' }
    if (row.valid_after && issuedAt * 1000 <= dateOf(row.valid_after).getTime()) {
      return { status: 'revoked', reason: 'security_event' }
    }
    return {
      status: 'valid',
      identity: {
        userId: claims.userId,
        email: claims.email,
        sid: '',
        jti: legacySessionFingerprint(token),
        sessionVersion: 0,
        expiresAt: new Date(claims.exp * 1000),
        absoluteExpiresAt: new Date(claims.exp * 1000),
        authenticationMethods: [],
      },
    }
  }
  const db = options.db ?? pool
  if (!options.budget) return work(db)
  if (options.db) return work(budgetedSessionDatabase(db, options.budget))
  return withAccessDatabaseTransaction(options.budget, work, { mode: 'read_only' })
}

export async function revokeLegacyUserSession(
  token: string,
  claims: AuthClaims,
  reason: string,
  db?: SessionDatabase
): Promise<boolean> {
  const work = async (transaction: SessionDatabase): Promise<boolean> => {
    const user = await transaction.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
      claims.userId,
    ])
    if ((user.rowCount ?? 0) === 0) return false
    const now = await loadDatabaseNow(transaction)
    const result = await transaction.query(
      `INSERT INTO external_v1_session_revocations(
         token_hash, user_id, expires_at, revoked_at, reason
       )
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO NOTHING
       RETURNING token_hash`,
      [legacySessionFingerprint(token), claims.userId, new Date(claims.exp * 1000), now, reason]
    )
    return (result.rowCount ?? 0) > 0
  }
  return db ? work(db) : withTransaction(work)
}
