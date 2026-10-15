import bcrypt from 'bcryptjs'
import { type DbClient, pool } from '../../db.js'
import { type MemberPasswordWorkLease, runPasswordMutation } from '../auth/passwordWorkOwnership.js'
import {
  type InvitationUserRow,
  ensureInvitationUser,
  getInvitationRecordById,
  invitationResponse,
  invitationUserIsRetired,
  loadInvitationTeams,
  lockPasswordResetUser,
} from './invitationStore.js'
import { getMemberSessionContext } from './login.js'

async function updateActivePasswordHash(
  db: Pick<DbClient, 'query'>,
  userId: string,
  passwordHash: string
): Promise<boolean> {
  const update = await db.query(
    `UPDATE users
        SET password_hash = $2,
            password_set_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND lifecycle_state = 'active'
      RETURNING id`,
    [userId, passwordHash]
  )
  return update.rows.length === 1
}

async function loadInvitationPasswordResponse(
  db: Pick<DbClient, 'query'>,
  invitationId: string,
  user: InvitationUserRow,
  passwordHash: string
) {
  const invitation = await getInvitationRecordById(db, invitationId)
  if (!invitation) return null
  const teams = await loadInvitationTeams(db, invitation.id, invitation)
  return invitationResponse(invitation, { ...user, password_hash: passwordHash }, teams)
}

async function revokeSiblingPasswordResets(
  db: Pick<DbClient, 'query'>,
  email: string,
  redeemedInvitationId: string,
  userId: string
): Promise<void> {
  await db.query(
    `UPDATE invitations
        SET status = 'revoked'
      WHERE lower(email) = $1
        AND purpose = 'password_reset'
        AND status IN ('draft', 'pending')
        AND id <> $2::uuid
        AND (accepted_user_id IS NULL OR accepted_user_id = $3)`,
    [email, redeemedInvitationId, userId]
  )
}

export async function setInvitationPasswordForUser(
  userId: string,
  email: string,
  invitationId: string,
  password: string,
  passwordWorkLease?: MemberPasswordWorkLease
) {
  const trimmedUserId = userId.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const trimmedInvitationId = invitationId.trim()
  const trimmedPassword = password.trim()
  if (!trimmedUserId || !normalizedEmail || !trimmedInvitationId) {
    return { error: 'not_found' as const }
  }
  if (trimmedPassword.length < 8 || trimmedPassword.length > 256) {
    return { error: 'invalid_password' as const }
  }

  const candidate = await getInvitationRecordById(pool, trimmedInvitationId)
  if (!candidate) return { error: 'not_found' as const }
  if (candidate.email.toLowerCase() !== normalizedEmail) {
    return { error: 'forbidden' as const }
  }
  if (candidate.purpose === 'password_reset') {
    const result = await setInvitationPasswordForEmail(
      normalizedEmail,
      trimmedInvitationId,
      trimmedPassword,
      trimmedUserId,
      passwordWorkLease
    )
    if ('error' in result) return result
    const { sessionContext: _sessionContext, ...data } = result.data
    return { data }
  }
  if (candidate.purpose !== 'member_invitation' && candidate.purpose !== 'admin_desktop_access') {
    return { error: 'not_found' as const }
  }
  if (candidate.status !== 'accepted') return { error: 'not_accepted' as const }

  return runPasswordMutation(
    async db => {
      const invitation = await getInvitationRecordById(db, trimmedInvitationId)
      if (!invitation) return { error: 'not_found' as const }
      if (invitation.email.toLowerCase() !== normalizedEmail) {
        return { error: 'forbidden' as const }
      }
      if (
        invitation.purpose !== 'member_invitation' &&
        invitation.purpose !== 'admin_desktop_access'
      ) {
        return { error: 'not_found' as const }
      }
      if (invitation.status !== 'accepted') return { error: 'not_accepted' as const }
      const user = await ensureInvitationUser(db, invitation.email, invitation.invitee_name)
      if (invitationUserIsRetired(user)) return { error: 'user_retired' as const }
      if (user.id !== trimmedUserId) return { error: 'forbidden' as const }
      const passwordHash = await bcrypt.hash(trimmedPassword, 12)
      if (!(await updateActivePasswordHash(db, user.id, passwordHash))) {
        return { error: 'user_retired' as const }
      }

      if (!invitation.accepted_user_id) {
        await db.query(`UPDATE invitations SET accepted_user_id = $2 WHERE id = $1`, [
          invitation.id,
          user.id,
        ])
      }

      const response = await loadInvitationPasswordResponse(db, invitation.id, user, passwordHash)
      if (!response) return { error: 'not_found' as const }
      return {
        data: {
          passwordUpdated: true,
          ...response,
        },
      }
    },
    { mode: 'standard', lease: passwordWorkLease }
  )
}

export async function setInvitationPasswordForEmail(
  email: string,
  invitationId: string,
  password: string,
  expectedUserId?: string,
  passwordWorkLease?: MemberPasswordWorkLease
) {
  const normalizedEmail = email.trim().toLowerCase()
  const trimmedInvitationId = invitationId.trim()
  const trimmedPassword = password.trim()
  if (!normalizedEmail || !trimmedInvitationId) {
    return { error: 'not_found' as const }
  }
  if (trimmedPassword.length < 8 || trimmedPassword.length > 256) {
    return { error: 'invalid_password' as const }
  }

  return runPasswordMutation(
    async db => {
      const candidate = await getInvitationRecordById(db, trimmedInvitationId)
      if (!candidate || candidate.purpose !== 'password_reset') {
        return { error: 'not_found' as const }
      }
      if (candidate.email.toLowerCase() !== normalizedEmail) {
        return { error: 'forbidden' as const }
      }

      const user = await lockPasswordResetUser(db, normalizedEmail)
      if (!user) return { error: 'not_found' as const }
      if (invitationUserIsRetired(user)) return { error: 'user_retired' as const }
      if (expectedUserId && user.id !== expectedUserId.trim()) {
        return { error: 'forbidden' as const }
      }
      const invitation = await getInvitationRecordById(db, trimmedInvitationId, true)
      if (!invitation || invitation.purpose !== 'password_reset') {
        return { error: 'not_found' as const }
      }
      if (invitation.email.toLowerCase() !== normalizedEmail) {
        return { error: 'forbidden' as const }
      }
      if (invitation.status !== 'pending') return { error: 'not_pending' as const }
      if (invitation.expires_at.getTime() <= Date.now()) return { error: 'expired' as const }
      if (invitation.accepted_user_id && invitation.accepted_user_id !== user.id) {
        return { error: 'forbidden' as const }
      }

      const passwordHash = await bcrypt.hash(trimmedPassword, 12)
      if (!(await updateActivePasswordHash(db, user.id, passwordHash))) {
        return { error: 'user_retired' as const }
      }

      const redeemed = await db.query(
        `UPDATE invitations
            SET status = 'accepted',
                accepted_at = NOW(),
                accepted_user_id = $2
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [invitation.id, user.id]
      )
      if (redeemed.rows.length !== 1) return { error: 'not_pending' as const }
      await revokeSiblingPasswordResets(db, normalizedEmail, invitation.id, user.id)

      const response = await loadInvitationPasswordResponse(db, invitation.id, user, passwordHash)
      if (!response) return { error: 'not_found' as const }
      const sessionContext = await getMemberSessionContext(db, user)
      return {
        data: {
          passwordUpdated: true,
          sessionContext,
          ...response,
        },
      }
    },
    { mode: 'one_use_recovery', lease: passwordWorkLease }
  )
}

export async function updateUserPassword(
  userId: string,
  email: string,
  currentPassword: string,
  newPassword: string
) {
  const normalizedUserId = userId.trim()
  const normalizedEmail = email.trim().toLowerCase()
  const nextPassword = newPassword.trim()
  if (!normalizedUserId || !normalizedEmail) {
    return { error: 'not_found' as const }
  }
  if (nextPassword.length < 8 || nextPassword.length > 256) {
    return { error: 'invalid_password' as const }
  }

  return runPasswordMutation(
    async db => {
      const result = await db.query(
        `SELECT password_hash, password_auth_generation
           FROM users
          WHERE id = $1
            AND email = $2
          LIMIT 1`,
        [normalizedUserId, normalizedEmail]
      )
      const user =
        (result.rows[0] as
          | { password_hash: string | null; password_auth_generation: string | number }
          | undefined) || null
      if (!user) {
        return { error: 'not_found' as const }
      }
      if (!user.password_hash) {
        return { error: 'password_not_set' as const }
      }
      const currentOk = await bcrypt.compare(currentPassword, user.password_hash)
      if (!currentOk) {
        return { error: 'invalid_current_password' as const }
      }

      const update = await db.query(
        `UPDATE users
            SET password_hash = $3,
                password_set_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
            AND password_auth_generation = $2
            AND password_hash = $4
          RETURNING id`,
        [
          normalizedUserId,
          user.password_auth_generation,
          await bcrypt.hash(nextPassword, 12),
          user.password_hash,
        ]
      )
      if (update.rows.length !== 1) return { error: 'credential_changed' as const }
      return { updated: true as const }
    },
    { mode: 'standard' }
  )
}
