import { config } from '../config.js'
import { type DbClient, pool, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { gfsDesktopOperatorLinkService } from './gfsDesktopOperatorLinkService.js'
import { currentAdministrativeRequestContext } from './tracing/adminOperationContext.js'
import { AdministrativeEventService } from './tracing/administrativeEvents.js'
import { CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1 } from './tracing/controlApiLocalAdministrativeBindingResolver.js'
import { canonicalTracingEnvironment } from './tracing/environment.js'

const administrativeEvents = new AdministrativeEventService({
  transaction: async () => {
    throw new Error('administrative event append requires the caller transaction')
  },
})

export type AdminUserRecord = {
  id: string
  username: string
  email: string | null
  passwordHash: string
  sessionVersion: number
  role: 'admin'
  status: 'active' | 'disabled'
  failedAttempts: number
  lockedUntil: Date | null
}

export type ControlAdminListItem = {
  id: string
  username: string
  email: string | null
  memberId: string | null
  status: 'active' | 'disabled' | 'pending_password'
  passwordPending?: boolean
  invitationId?: string
  gfsOperatorLink?: {
    desktopUserId: string
    controlAdminId: string
    source: 'initial_setup' | 'unknown'
    createdAt: string | null
    status: 'active' | 'inactive_admin' | 'revoked' | 'error'
    generation: number | null
    rowVersion: number | null
    revocationReason: string | null
  } | null
  gfsOperatorLinkStatus?: 'none' | 'active' | 'inactive_admin' | 'revoked' | 'error'
  lastLoginAt: string | null
  createdAt: string
}

export type ControlAdminInvitationRecord = {
  id: string
  email: string
  status: 'pending' | 'opened' | 'accepted' | 'revoked'
  expiresAt: Date
  createdAt: Date
  acceptedAt: Date | null
}

export type ControlAdminEmailChangeRequestRecord = {
  id: string
  adminId: string
  email: string
  status: 'pending' | 'confirmed' | 'revoked'
  expiresAt: Date
  createdAt: Date
  confirmedAt: Date | null
}

export type ControlAdminPasswordResetRequestRecord = {
  id: string
  adminId: string
  email: string
  status: 'pending' | 'used' | 'revoked'
  expiresAt: Date
  createdAt: Date
  usedAt: Date | null
}

function mapAdminRow(row: {
  id: string
  username: string
  email: string | null
  password_hash: string
  session_version?: number | null
  role: 'admin'
  status: 'active' | 'disabled'
  failed_attempts: number
  locked_until: Date | null
}): AdminUserRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    passwordHash: row.password_hash,
    sessionVersion: Number(row.session_version || 0),
    role: row.role,
    status: row.status,
    failedAttempts: Number(row.failed_attempts || 0),
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
  }
}

function mapInvitationRow(row: {
  id: string
  email: string
  status: 'pending' | 'accepted' | 'revoked'
  expires_at: Date
  created_at: Date
  accepted_at: Date | null
}): ControlAdminInvitationRecord {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
  }
}

function mapEmailChangeRequestRow(row: {
  id: string
  admin_id: string
  email: string
  status: 'pending' | 'confirmed' | 'revoked'
  expires_at: Date
  created_at: Date
  confirmed_at: Date | null
}): ControlAdminEmailChangeRequestRecord {
  return {
    id: row.id,
    adminId: row.admin_id,
    email: row.email,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
  }
}

function mapPasswordResetRequestRow(row: {
  id: string
  admin_id: string
  email: string
  status: 'pending' | 'used' | 'revoked'
  expires_at: Date
  created_at: Date
  used_at: Date | null
}): ControlAdminPasswordResetRequestRecord {
  return {
    id: row.id,
    adminId: row.admin_id,
    email: row.email,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    usedAt: row.used_at ? new Date(row.used_at) : null,
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidAdminEmail(email: string): boolean {
  const normalized = normalizeEmail(email)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
}

export function isValidAdminUsername(username: string): boolean {
  return /^[a-zA-Z0-9._-]{3,64}$/.test(username.trim())
}

export async function findAdminByUsername(username: string): Promise<AdminUserRecord | null> {
  const result = await pool.query(
    `SELECT id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until
       FROM control_admin_users
      WHERE username = $1
      LIMIT 1`,
    [username]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapAdminRow(result.rows[0] as never)
}

export async function findAdminByLogin(login: string): Promise<AdminUserRecord | null> {
  const normalized = login.trim()
  const result = await pool.query(
    `SELECT id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until
       FROM control_admin_users
      WHERE username = $1
         OR lower(email) = lower($1)
      LIMIT 1`,
    [normalized]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapAdminRow(result.rows[0] as never)
}

export async function findAdminById(id: string): Promise<AdminUserRecord | null> {
  const result = await pool.query(
    `SELECT id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until
       FROM control_admin_users
      WHERE id = $1
      LIMIT 1`,
    [id]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapAdminRow(result.rows[0] as never)
}

export async function getPendingControlAdminEmailChangeForAdmin(
  adminId: string
): Promise<ControlAdminEmailChangeRequestRecord | null> {
  const result = await pool.query(
    `SELECT id, admin_id, email, status, expires_at, created_at, confirmed_at
       FROM control_admin_email_change_requests
      WHERE admin_id = $1
        AND status = 'pending'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [adminId]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapEmailChangeRequestRow(result.rows[0] as never)
}

export async function getPendingControlAdminPasswordResetRequest(
  db: DbClient,
  requestId: string,
  email: string
): Promise<ControlAdminPasswordResetRequestRecord | null> {
  const result = await db.query(
    `SELECT id, admin_id, email, status, expires_at, created_at, used_at
       FROM control_admin_password_reset_requests
      WHERE id = $1
        AND lower(email) = lower($2)
        AND status = 'pending'
        AND expires_at > NOW()
      LIMIT 1`,
    [requestId, normalizeEmail(email)]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapPasswordResetRequestRow(result.rows[0] as never)
}

export async function registerAdminFailedLogin(
  userId: string,
  lockMinutes: number,
  maxFailures: number
): Promise<void> {
  await pool.query(
    `UPDATE control_admin_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3::text || ' minutes')::interval
              ELSE locked_until
            END,
            updated_at = NOW()
      WHERE id = $1`,
    [userId, maxFailures, lockMinutes]
  )
}

export async function registerAdminSuccessfulLogin(userId: string): Promise<void> {
  await pool.query(
    `UPDATE control_admin_users
        SET failed_attempts = 0,
            locked_until = NULL,
            last_login_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [userId]
  )
}

export async function revokeAdminTokenJti(jti: string, expUnix: number): Promise<void> {
  await pool.query(
    `INSERT INTO control_admin_revoked_tokens(jti, expires_at)
     VALUES($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expUnix]
  )
}

export async function isAdminTokenRevoked(jti: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM control_admin_revoked_tokens
      WHERE jti = $1
      LIMIT 1`,
    [jti]
  )
  return (result.rowCount ?? 0) > 0
}

export async function cleanupExpiredAdminRevokedTokens(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM control_admin_revoked_tokens WHERE expires_at < NOW()`
  )
  return result.rowCount ?? 0
}

let adminRevokedTokenCleanupHandle: ReturnType<typeof setInterval> | null = null

export function startAdminRevokedTokenCleanup(intervalMs: number): void {
  if (adminRevokedTokenCleanupHandle) return
  adminRevokedTokenCleanupHandle = setInterval(() => {
    cleanupExpiredAdminRevokedTokens().catch(error => {
      rootLogger.warn(
        {
          event: 'admin_revoked_token_cleanup_error',
          err: error instanceof Error ? error.message : String(error),
        },
        'admin revoked token cleanup failed'
      )
    })
  }, intervalMs)
  adminRevokedTokenCleanupHandle.unref()
}

export function stopAdminRevokedTokenCleanup(): void {
  if (!adminRevokedTokenCleanupHandle) return
  clearInterval(adminRevokedTokenCleanupHandle)
  adminRevokedTokenCleanupHandle = null
}

export async function setupInitialAdminCredentials(
  bootstrapUsername: string,
  email: string,
  username: string,
  passwordHash: string,
  db: Pick<DbClient, 'query'> = pool
): Promise<AdminUserRecord | null> {
  const result = await db.query(
    `UPDATE control_admin_users
        SET email = $2,
            username = $3,
            password_hash = $4,
            role = 'admin',
            status = 'active',
            failed_attempts = 0,
            locked_until = NULL,
            last_login_at = NOW(),
            updated_at = NOW()
      WHERE id IN (
        SELECT id
          FROM control_admin_users
         WHERE username = $1
           AND status = 'active'
           AND last_login_at IS NULL
         ORDER BY created_at ASC
         LIMIT 1
      )
        AND (
          SELECT COUNT(*)
            FROM control_admin_users
           WHERE status = 'active'
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM control_admin_users WHERE lower(email) = lower($2)
        )
        AND NOT EXISTS (
          SELECT 1 FROM control_admin_users WHERE username = $3 AND username <> $1
        )
      RETURNING id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until`,
    [bootstrapUsername, normalizeEmail(email), username.trim(), passwordHash]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapAdminRow(result.rows[0] as never)
}

export async function updateAdminUsername(
  adminId: string,
  username: string
): Promise<AdminUserRecord | { error: 'duplicate_username' | 'not_found' }> {
  const normalizedUsername = username.trim()
  const result = await pool.query(
    `UPDATE control_admin_users
        SET username = $2,
            updated_at = NOW()
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1 FROM control_admin_users WHERE id <> $1 AND username = $2
        )
      RETURNING id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until`,
    [adminId, normalizedUsername]
  )

  if ((result.rowCount ?? 0) === 0) {
    const current = await findAdminById(adminId)
    if (!current) return { error: 'not_found' }
    return { error: 'duplicate_username' }
  }

  return mapAdminRow(result.rows[0] as never)
}

export async function createControlAdminEmailChangeRequest(
  adminId: string,
  email: string
): Promise<ControlAdminEmailChangeRequestRecord | { error: 'duplicate_email' | 'not_found' }> {
  const normalizedEmail = normalizeEmail(email)

  return withTransaction(async db => {
    const admin = await db.query(
      `SELECT id, email
         FROM control_admin_users
        WHERE id = $1
          AND status = 'active'
        LIMIT 1`,
      [adminId]
    )
    if ((admin.rowCount ?? 0) === 0) return { error: 'not_found' as const }

    await db.query(
      `UPDATE control_admin_email_change_requests
          SET status = 'revoked'
        WHERE status = 'pending'
          AND (expires_at <= NOW() OR admin_id = $1)`,
      [adminId]
    )

    const result = await db.query(
      `INSERT INTO control_admin_email_change_requests(admin_id, email)
       SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM control_admin_users
           WHERE id <> $1
             AND lower(email) = lower($2)
        )
          AND NOT EXISTS (
            SELECT 1 FROM control_admin_email_change_requests
             WHERE lower(email) = lower($2)
               AND status = 'pending'
          )
       RETURNING id, admin_id, email, status, expires_at, created_at, confirmed_at`,
      [adminId, normalizedEmail]
    )

    if ((result.rowCount ?? 0) === 0) return { error: 'duplicate_email' as const }
    return mapEmailChangeRequestRow(result.rows[0] as never)
  })
}

export async function createControlAdminPasswordResetRequest(
  login: string
): Promise<ControlAdminPasswordResetRequestRecord | { skipped: true }> {
  const normalizedLogin = login.trim()
  if (!normalizedLogin) return { skipped: true }

  const admin = await findAdminByLogin(normalizedLogin)
  if (!admin || admin.status !== 'active' || !admin.email) {
    return { skipped: true }
  }
  const adminEmail = admin.email

  return withTransaction(async db => {
    await db.query(
      `UPDATE control_admin_password_reset_requests
          SET status = 'revoked'
        WHERE status = 'pending'
          AND (expires_at <= NOW() OR admin_id = $1)`,
      [admin.id]
    )

    const result = await db.query(
      `INSERT INTO control_admin_password_reset_requests(admin_id, email)
       VALUES ($1, $2)
       RETURNING id, admin_id, email, status, expires_at, created_at, used_at`,
      [admin.id, normalizeEmail(adminEmail)]
    )

    return mapPasswordResetRequestRow(result.rows[0] as never)
  })
}

export async function revokeControlAdminPasswordResetRequest(requestId: string): Promise<void> {
  await pool.query(
    `UPDATE control_admin_password_reset_requests
        SET status = 'revoked'
      WHERE id = $1
        AND status = 'pending'`,
    [requestId]
  )
}

export async function revokeControlAdminEmailChangeRequest(requestId: string): Promise<void> {
  await pool.query(
    `UPDATE control_admin_email_change_requests
        SET status = 'revoked'
      WHERE id = $1
        AND status = 'pending'`,
    [requestId]
  )
}

export async function updateAdminPassword(adminId: string, passwordHash: string): Promise<void> {
  await pool.query(
    `UPDATE control_admin_users
        SET password_hash = $2,
            failed_attempts = 0,
            locked_until = NULL,
            updated_at = NOW(),
            session_version = session_version + 1
      WHERE id = $1`,
    [adminId, passwordHash]
  )
}

export async function completeControlAdminPasswordResetRequest(input: {
  requestId: string
  email: string
  passwordHash: string
}): Promise<AdminUserRecord | { error: 'not_found' }> {
  return withTransaction(async db => {
    const resetResult = await db.query(
      `UPDATE control_admin_password_reset_requests
          SET status = 'used',
              used_at = NOW()
        WHERE id = $1
          AND lower(email) = lower($2)
          AND status = 'pending'
          AND expires_at > NOW()
        RETURNING admin_id`,
      [input.requestId, normalizeEmail(input.email)]
    )

    if ((resetResult.rowCount ?? 0) === 0) return { error: 'not_found' as const }

    const reset = resetResult.rows[0] as { admin_id: string }
    const adminResult = await db.query(
      `UPDATE control_admin_users
          SET password_hash = $2,
              failed_attempts = 0,
              locked_until = NULL,
              updated_at = NOW(),
              session_version = session_version + 1
        WHERE id = $1
          AND lower(email) = lower($3)
          AND status = 'active'
        RETURNING id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until`,
      [reset.admin_id, input.passwordHash, normalizeEmail(input.email)]
    )

    if ((adminResult.rowCount ?? 0) === 0) return { error: 'not_found' as const }
    return mapAdminRow(adminResult.rows[0] as never)
  })
}

export async function deleteControlAdmin(
  actorAdminId: string,
  adminId: string
): Promise<{ deleted: true } | { error: 'not_found' }> {
  return withTransaction(async db => {
    const actorResult = await db.query(
      `SELECT id, username, email
         FROM control_admin_users
        WHERE id = $1
        LIMIT 1`,
      [actorAdminId]
    )
    await gfsDesktopOperatorLinkService.retireParentInTransaction(db, {
      kind: 'control_admin',
      parentId: adminId,
      actor: { kind: 'control_admin', controlAdminId: actorAdminId },
      reason: 'control_admin_retired',
    })
    const deletedResult = await db.query(
      `UPDATE control_admin_users
          SET status = 'disabled', session_version = session_version + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING id, username, email`,
      [adminId]
    )

    if ((deletedResult.rowCount ?? 0) === 0) return { error: 'not_found' as const }

    const actor = actorResult.rows[0] as
      | { id: string; username: string; email: string | null }
      | undefined
    const deleted = deletedResult.rows[0] as {
      id: string
      username: string
      email: string | null
    }

    const auditResult = await db.query(
      `INSERT INTO control_admin_deletion_audit (
         actor_admin_id,
         actor_username,
         actor_email,
         target_admin_id,
         target_username,
         target_email
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [
        actor?.id ?? actorAdminId,
        actor?.username ?? null,
        actor?.email ?? null,
        deleted.id,
        deleted.username,
        deleted.email,
      ]
    )

    const audit = auditResult.rows[0] as { id: string } | undefined
    if (!audit?.id) throw new Error('control admin deletion audit insert did not return an id')
    const requestContext = currentAdministrativeRequestContext()
    await administrativeEvents.appendInTransaction(
      db,
      CONTROL_API_LOCAL_ADMINISTRATIVE_PRINCIPAL_V1,
      {
        action: 'control_admin_deleted',
        outcome: 'committed',
        operatorSub: actor?.id ?? actorAdminId,
        operatorUserId: actor?.id ?? actorAdminId,
        operationId: audit.id,
        relatedRunId: null,
        requestId:
          requestContext?.operatorSub === (actor?.id ?? actorAdminId)
            ? requestContext.requestId
            : null,
        targetType: 'control_admin',
        targetRef: `control_admin:${deleted.id}`,
        environment: canonicalTracingEnvironment(),
        tenantId: null,
        teamId: null,
        namespace: null,
        sourceAuditRef: `control_admin_deletion_audit:${audit.id}`,
        identityIssuer: config.adminJwtIssuer,
        resourceAud: config.adminJwtAudience,
        effectiveScopes: [],
        authorizationDecision: 'allow',
        decisionActorSub: actor?.id ?? actorAdminId,
        targetIdentityIssuer: config.adminJwtIssuer,
        targetHumanSub: deleted.id,
        targetUserId: null,
      },
      {
        kind: 'service_action',
        sourceEventId: `control_admin_deletion_audit:${audit.id}`,
        occurredAt: new Date().toISOString(),
        reasonCode: 'control_admin_access_revoked',
        payload: {
          resource_class: 'control_admin_access',
          status: 'revoked',
          target_label: deleted.username,
        },
      }
    )

    return { deleted: true as const }
  })
}

export async function listControlAdmins(): Promise<{
  admins: ControlAdminListItem[]
  invitations: ControlAdminInvitationRecord[]
}> {
  const [adminsResult, setupInvitationsResult, invitationsResult] = await Promise.all([
    pool.query(
      `SELECT a.id,
              a.username,
              a.email,
              u.id AS member_id,
              gfs_link.user_id AS gfs_operator_user_id,
              gfs_link.control_admin_id AS gfs_operator_admin_id,
              gfs_link.source AS gfs_operator_source,
              gfs_link.created_at AS gfs_operator_link_created_at,
              gfs_link.state AS gfs_operator_link_state,
              gfs_link.generation AS gfs_operator_link_generation,
              gfs_link.row_version AS gfs_operator_link_row_version,
              gfs_link.revocation_reason AS gfs_operator_link_revocation_reason,
              a.status,
              a.last_login_at,
              a.created_at
         FROM control_admin_users a
    LEFT JOIN users u ON lower(u.email) = lower(a.email)
    LEFT JOIN LATERAL (
      SELECT user_id, control_admin_id, source, created_at, state, generation,
             row_version, revocation_reason
        FROM gfs_desktop_operator_links
       WHERE control_admin_id = a.id
       ORDER BY generation DESC NULLS LAST, created_at DESC
       LIMIT 1
    ) gfs_link ON TRUE
        ORDER BY a.created_at ASC`
    ),
    pool.query(
      `SELECT id, email, expires_at, created_at, accepted_at
         FROM control_admin_invitations
        WHERE status = 'opened'
          AND expires_at > NOW()
        ORDER BY accepted_at DESC, created_at DESC`
    ),
    pool.query(
      `SELECT id, email, status, expires_at, created_at, accepted_at
         FROM control_admin_invitations
        WHERE status = 'pending'
        ORDER BY created_at DESC`
    ),
  ])

  return {
    admins: [
      ...adminsResult.rows.map(row => {
        const record = row as {
          id: string
          username: string
          email: string | null
          member_id: string | null
          gfs_operator_user_id: string | null
          gfs_operator_admin_id: string | null
          gfs_operator_source: 'initial_setup' | null
          gfs_operator_link_created_at: Date | null
          gfs_operator_link_state: 'active' | 'revoked' | null
          gfs_operator_link_generation: number | null
          gfs_operator_link_row_version: number | null
          gfs_operator_link_revocation_reason: string | null
          status: 'active' | 'disabled'
          last_login_at: Date | null
          created_at: Date
        }
        return {
          id: record.id,
          username: record.username,
          email: record.email || null,
          memberId: record.member_id || null,
          gfsOperatorLink: record.gfs_operator_user_id
            ? {
                desktopUserId: record.gfs_operator_user_id,
                controlAdminId: record.gfs_operator_admin_id || 'unknown',
                source: (record.gfs_operator_source === 'initial_setup'
                  ? 'initial_setup'
                  : 'unknown') as 'initial_setup' | 'unknown',
                createdAt: record.gfs_operator_link_created_at
                  ? record.gfs_operator_link_created_at.toISOString()
                  : null,
                status: (record.gfs_operator_link_state === 'revoked'
                  ? 'revoked'
                  : record.gfs_operator_source === 'initial_setup' &&
                      record.gfs_operator_link_created_at
                    ? record.status === 'active'
                      ? 'active'
                      : 'inactive_admin'
                    : 'error') as 'active' | 'inactive_admin' | 'revoked' | 'error',
                generation:
                  record.gfs_operator_link_generation === null
                    ? null
                    : Number(record.gfs_operator_link_generation),
                rowVersion:
                  record.gfs_operator_link_row_version === null
                    ? null
                    : Number(record.gfs_operator_link_row_version),
                revocationReason: record.gfs_operator_link_revocation_reason ?? null,
              }
            : null,
          gfsOperatorLinkStatus: (record.gfs_operator_user_id
            ? record.gfs_operator_link_state === 'revoked'
              ? 'revoked'
              : record.gfs_operator_source === 'initial_setup' &&
                  record.gfs_operator_link_created_at
                ? record.status === 'active'
                  ? 'active'
                  : 'inactive_admin'
                : 'error'
            : 'none') as 'none' | 'active' | 'inactive_admin' | 'revoked' | 'error',
          status: record.status,
          lastLoginAt: record.last_login_at ? record.last_login_at.toISOString() : null,
          createdAt: record.created_at.toISOString(),
        }
      }),
      ...setupInvitationsResult.rows.map(row => {
        const record = row as {
          id: string
          email: string
          expires_at: Date
          created_at: Date
          accepted_at: Date | null
        }
        return {
          id: `invitation:${record.id}`,
          username: 'Pending setup',
          email: record.email,
          memberId: null,
          status: 'pending_password' as const,
          passwordPending: true,
          invitationId: record.id,
          lastLoginAt: null,
          createdAt: record.accepted_at
            ? record.accepted_at.toISOString()
            : record.created_at.toISOString(),
        }
      }),
    ],
    invitations: invitationsResult.rows.map(row => mapInvitationRow(row as never)),
  }
}

export async function createControlAdminInvitation(
  email: string,
  invitedByAdminId: string
): Promise<ControlAdminInvitationRecord | { error: 'duplicate_email' }> {
  const normalizedEmail = normalizeEmail(email)
  // Revoke expired active invitations first so the INSERT guard can treat any remaining
  // pending/opened invitation as a real blocker for the partial unique index.
  await pool.query(
    `UPDATE control_admin_invitations
        SET status = 'revoked'
      WHERE lower(email) = lower($1)
        AND status IN ('pending', 'opened')
        AND expires_at <= NOW()`,
    [normalizedEmail]
  )

  let result
  try {
    result = await pool.query(
      `INSERT INTO control_admin_invitations(email, invited_by_admin_id)
       SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM control_admin_users WHERE lower(email) = lower($1)
        )
          AND NOT EXISTS (
            SELECT 1 FROM control_admin_invitations
             WHERE lower(email) = lower($1)
               AND status IN ('pending', 'opened')
          )
       RETURNING id, email, status, expires_at, created_at, accepted_at`,
      [normalizedEmail, invitedByAdminId]
    )
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === '23505' &&
      String((error as { constraint?: unknown }).constraint || '').includes(
        'control_admin_invitations'
      )
    ) {
      return { error: 'duplicate_email' as const }
    }
    throw error
  }

  if ((result.rowCount ?? 0) === 0) return { error: 'duplicate_email' }
  return mapInvitationRow(result.rows[0] as never)
}

export async function revokeControlAdminInvitation(invitationId: string): Promise<void> {
  await pool.query(
    `UPDATE control_admin_invitations
        SET status = 'revoked'
      WHERE id = $1
        AND (
          status = 'pending'
          OR status = 'opened'
        )`,
    [invitationId]
  )
}

export async function getPendingControlAdminInvitation(
  db: DbClient,
  invitationId: string,
  email: string
): Promise<ControlAdminInvitationRecord | null> {
  const result = await db.query(
    `SELECT id, email, status, expires_at, created_at, accepted_at
       FROM control_admin_invitations
      WHERE id = $1
        AND lower(email) = lower($2)
        AND (
          status = 'pending'
          OR status = 'opened'
        )
        AND expires_at > NOW()
      LIMIT 1`,
    [invitationId, normalizeEmail(email)]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapInvitationRow(result.rows[0] as never)
}

export async function markControlAdminInvitationOpened(invitationId: string): Promise<void> {
  await pool.query(
    `UPDATE control_admin_invitations
        SET status = 'opened',
            accepted_at = COALESCE(accepted_at, NOW())
      WHERE id = $1
        AND status = 'pending'
        AND accepted_admin_id IS NULL`,
    [invitationId]
  )
}

export async function getPendingControlAdminEmailChangeRequest(
  db: DbClient,
  requestId: string,
  email: string
): Promise<ControlAdminEmailChangeRequestRecord | null> {
  const result = await db.query(
    `SELECT id, admin_id, email, status, expires_at, created_at, confirmed_at
       FROM control_admin_email_change_requests
      WHERE id = $1
        AND lower(email) = lower($2)
        AND status = 'pending'
        AND expires_at > NOW()
      LIMIT 1`,
    [requestId, normalizeEmail(email)]
  )
  if ((result.rowCount ?? 0) === 0) return null
  return mapEmailChangeRequestRow(result.rows[0] as never)
}

export async function completeControlAdminInvitation(input: {
  email: string
  invitationId: string
  username: string
  passwordHash: string
}): Promise<AdminUserRecord | { error: 'duplicate_email' | 'duplicate_username' | 'not_found' }> {
  const email = normalizeEmail(input.email)
  const username = input.username.trim()
  return withTransaction(async db => {
    const invitation = await getPendingControlAdminInvitation(db, input.invitationId, email)
    if (!invitation) return { error: 'not_found' as const }

    const conflict = await db.query(
      `SELECT
         EXISTS(SELECT 1 FROM control_admin_users WHERE lower(email) = lower($1)) AS email_exists,
         EXISTS(SELECT 1 FROM control_admin_users WHERE username = $2) AS username_exists`,
      [email, username]
    )
    const row = conflict.rows[0] as { email_exists: boolean; username_exists: boolean }
    if (row.email_exists) return { error: 'duplicate_email' as const }
    if (row.username_exists) return { error: 'duplicate_username' as const }

    const inserted = await db.query(
      `INSERT INTO control_admin_users(email, username, password_hash, role, status, session_version)
       VALUES($1, $2, $3, 'admin', 'active', 1)
       RETURNING id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until`,
      [email, username, input.passwordHash]
    )
    const admin = mapAdminRow(inserted.rows[0] as never)

    await db.query(
      `UPDATE control_admin_invitations
          SET status = 'accepted',
              accepted_admin_id = $2,
              accepted_at = NOW()
        WHERE id = $1`,
      [invitation.id, admin.id]
    )

    return admin
  })
}

export async function completeControlAdminEmailChangeRequest(input: {
  requestId: string
  email: string
}): Promise<
  | AdminUserRecord
  | { alreadyConfirmed: true; admin: AdminUserRecord }
  | { error: 'duplicate_email' | 'not_found' }
> {
  const email = normalizeEmail(input.email)

  return withTransaction(async db => {
    const request = await getPendingControlAdminEmailChangeRequest(db, input.requestId, email)
    if (!request) {
      const confirmed = await db.query(
        `SELECT u.id,
                u.username,
                u.email,
                u.password_hash,
                u.session_version,
                u.role,
                u.status,
                u.failed_attempts,
                u.locked_until
           FROM control_admin_email_change_requests r
           JOIN control_admin_users u ON u.id = r.admin_id
          WHERE r.id = $1
            AND lower(r.email) = lower($2)
            AND r.status = 'confirmed'
            AND lower(u.email) = lower($2)
          LIMIT 1`,
        [input.requestId, email]
      )
      if ((confirmed.rowCount ?? 0) > 0) {
        return {
          alreadyConfirmed: true as const,
          admin: mapAdminRow(confirmed.rows[0] as never),
        }
      }
      return { error: 'not_found' as const }
    }

    const conflict = await db.query(
      `SELECT 1
         FROM control_admin_users
        WHERE id <> $1
          AND lower(email) = lower($2)
        LIMIT 1`,
      [request.adminId, email]
    )
    if ((conflict.rowCount ?? 0) > 0) return { error: 'duplicate_email' as const }

    const updated = await db.query(
      `UPDATE control_admin_users
          SET email = $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, username, email, password_hash, session_version, role, status, failed_attempts, locked_until`,
      [request.adminId, email]
    )
    if ((updated.rowCount ?? 0) === 0) return { error: 'not_found' as const }

    await db.query(
      `UPDATE control_admin_email_change_requests
          SET status = 'confirmed',
              confirmed_at = NOW()
        WHERE id = $1`,
      [request.id]
    )

    return mapAdminRow(updated.rows[0] as never)
  })
}
