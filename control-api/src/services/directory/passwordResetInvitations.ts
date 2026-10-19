import { pool, withTransaction } from '../../db.js'
import { registerAndSendInvitation } from '../invitationFlowRegistrationService.js'
import {
  activateDraftInvitation,
  cleanupStaleDraftInvitations,
  getInvitationRecordById,
  insertInvitationForTeams,
  invitationForTeamsResponse,
  invitationUserIsRetired,
  lockPasswordResetUser,
} from './invitationStore.js'

class PasswordResetPrincipalUnavailableError extends Error {}

async function createResetInvitation(
  input: { email: string; inviteeName: string },
  options: { sendEmail: boolean }
) {
  cleanupStaleDraftInvitations().catch(() => undefined)
  const purpose = 'password_reset' as const
  const inserted = await withTransaction(async db => {
    const principal = await lockPasswordResetUser(db, input.email.trim().toLowerCase())
    if (!principal || invitationUserIsRetired(principal)) {
      throw new PasswordResetPrincipalUnavailableError()
    }
    return insertInvitationForTeams(db, {
      ...input,
      teamAssignments: [],
      fallbackRole: 'member',
      purpose,
      status: options.sendEmail ? 'draft' : 'pending',
    })
  })

  if (!options.sendEmail) {
    return invitationForTeamsResponse(inserted.invitation, inserted.teams)
  }

  await registerAndSendInvitation(
    inserted.invitation.email,
    inserted.invitation.token,
    inserted.teams.length > 0
      ? inserted.teams.map(team => team.team_name).join(', ')
      : inserted.invitation.team_name,
    inserted.invitation.created_at.toISOString(),
    inserted.invitation.expires_at.toISOString(),
    {
      purpose,
      teamNames: inserted.teams.map(team => team.team_name),
    }
  )

  const pending = await activateDraftInvitation(pool, inserted.invitation.id)
  if (!pending) {
    const current = await getInvitationRecordById(pool, inserted.invitation.id)
    if (current?.status === 'revoked') {
      return invitationForTeamsResponse(current, inserted.teams)
    }
    throw new Error('Failed to activate invitation after registration')
  }
  return invitationForTeamsResponse(
    {
      ...pending,
      team_name: inserted.invitation.team_name,
    },
    inserted.teams
  )
}

export function createPasswordResetInvitation(input: { email: string; inviteeName: string }) {
  return createResetInvitation(input, { sendEmail: true })
}

export function createSilentPasswordResetInvitation(input: { email: string; inviteeName: string }) {
  return createResetInvitation(input, { sendEmail: false })
}

export async function requestProfilePasswordReset(email: string): Promise<{ requested: true }> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return { requested: true }

  const userResult = await pool.query(
    `SELECT id, email, name
       FROM users
      WHERE email = $1
        AND lifecycle_state = 'active'
      LIMIT 1`,
    [normalizedEmail]
  )
  const user =
    (userResult.rows[0] as { id: string; email: string; name: string | null } | undefined) || null
  if (!user) {
    return { requested: true }
  }

  try {
    await createPasswordResetInvitation({
      inviteeName: user.name || user.email.split('@')[0] || user.email,
      email: user.email,
    })
  } catch (error) {
    if (!(error instanceof PasswordResetPrincipalUnavailableError)) throw error
  }
  return { requested: true }
}
