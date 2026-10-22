import { sign } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromControlApi = createRequire(
  new URL('../../../control-api/package.json', import.meta.url)
)
const bcrypt = requireFromControlApi('bcryptjs')

export const RECOVERY_CONTROL_API_SERVICE_TOKEN = 'synthetic-profile-recovery-token'

export const RECOVERY_PASSWORDS = {
  recovery: 'Synthetic-Recovery-Password-123',
  logout: 'Synthetic-Logout-Password-123',
  replacement: 'Synthetic-Replacement-Password-123',
  onboarding: 'Synthetic-Onboarding-Password-123',
}

export const RECOVERY_USERS = {
  onboarding: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'onboarding-member@example.invalid',
    name: 'Synthetic Member',
    teamId: '22222222-2222-4222-8222-222222222222',
    teamName: 'Synthetic Member Team',
    role: 'member',
    password: null,
  },
  recovery: {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'recovery-member@example.invalid',
    name: 'Synthetic Recovery Member',
    teamId: null,
    teamName: null,
    role: 'member',
    password: RECOVERY_PASSWORDS.recovery,
  },
  logout: {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'logout-member@example.invalid',
    name: 'Synthetic Logout Member',
    teamId: null,
    teamName: null,
    role: 'member',
    password: RECOVERY_PASSWORDS.logout,
  },
  usedInvitee: {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'used-invitee@example.invalid',
    name: 'Synthetic Used Invitee',
    teamId: null,
    teamName: null,
    role: 'member',
    password: RECOVERY_PASSWORDS.replacement,
  },
}

export const RECOVERY_INVITATIONS = [
  {
    token: 'synthetic-member-invitation',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    email: RECOVERY_USERS.onboarding.email,
    purpose: 'member_invitation',
    status: 'pending',
    role: 'member',
    teamId: RECOVERY_USERS.onboarding.teamId,
    teamName: RECOVERY_USERS.onboarding.teamName,
    userId: RECOVERY_USERS.onboarding.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
    acceptedAt: null,
  },
  {
    token: 'synthetic-reset-proof',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    email: RECOVERY_USERS.recovery.email,
    purpose: 'password_reset',
    status: 'pending',
    role: 'member',
    teamId: null,
    teamName: null,
    userId: RECOVERY_USERS.recovery.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
    acceptedAt: null,
  },
  {
    token: 'synthetic-used-reset-proof',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    email: RECOVERY_USERS.logout.email,
    purpose: 'password_reset',
    status: 'accepted',
    role: 'member',
    teamId: null,
    teamName: null,
    userId: RECOVERY_USERS.logout.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
    acceptedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    token: 'synthetic-pending-reset-proof',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
    email: RECOVERY_USERS.logout.email,
    purpose: 'password_reset',
    status: 'pending',
    role: 'member',
    teamId: null,
    teamName: null,
    userId: RECOVERY_USERS.logout.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
    acceptedAt: null,
  },
  {
    token: 'synthetic-used-invitation',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    email: RECOVERY_USERS.usedInvitee.email,
    purpose: 'member_invitation',
    status: 'accepted',
    role: 'member',
    teamId: null,
    teamName: null,
    userId: RECOVERY_USERS.usedInvitee.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
    acceptedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    token: 'synthetic-expired-invitation',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    email: RECOVERY_USERS.usedInvitee.email,
    purpose: 'member_invitation',
    status: 'pending',
    role: 'member',
    teamId: null,
    teamName: null,
    userId: null,
    expiresAt: '2020-01-01T00:00:00.000Z',
    acceptedAt: null,
  },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

/**
 * Synthetic control-api authority for the Profile UI recovery browser lane.
 * It mirrors the production routes the lane depends on and is parity-tested
 * against the real Control API with real PostgreSQL.
 */
export async function createRecoveryControlApi({
  privateKey,
  issuer = 'control-api',
  audience = 'profile-ui',
}) {
  if (!privateKey) throw new Error('Recovery control-api fixture requires a session signer')

  const users = new Map()
  for (const [key, seed] of Object.entries(RECOVERY_USERS)) {
    users.set(seed.id, {
      key,
      id: seed.id,
      email: seed.email,
      name: seed.name,
      teamId: seed.teamId,
      teamName: seed.teamName,
      role: seed.role,
      lifecycleVersion: 1,
      passwordHash: seed.password ? await bcrypt.hash(seed.password, 12) : null,
      lifecycleState: 'active',
    })
  }

  const invitations = new Map(
    RECOVERY_INVITATIONS.map(seed => [
      seed.token,
      {
        ...clone(seed),
        acceptedUserId: seed.status === 'accepted' ? seed.userId : null,
      },
    ])
  )
  const sessions = new Map()
  const metrics = {
    previewRequests: [],
    acceptRequests: [],
    passwordTokenRequests: [],
    passwordRequests: [],
    loginRequests: [],
    loginSuccesses: [],
    meRequests: [],
    logoutRequests: [],
    passwordUpdates: [],
    unauthorizedMeRequests: [],
  }

  function invitationPreview(invitation) {
    const user = users.get(invitation.userId) || null
    return {
      id: invitation.id,
      teamId: invitation.teamId,
      teamName: invitation.teamName,
      teams:
        invitation.teamId && invitation.teamName
          ? [{ id: invitation.teamId, name: invitation.teamName, role: invitation.role }]
          : [],
      email: invitation.email,
      role: invitation.role,
      purpose: invitation.purpose,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      userId: invitation.acceptedUserId || invitation.userId,
      passwordPending: !user || !user.passwordHash,
      authGeneration: user ? user.lifecycleVersion : null,
      lifecycleState: user ? user.lifecycleState : null,
    }
  }

  function activeSession(token) {
    const session = sessions.get(token)
    if (!session || session.revoked) return null
    const user = users.get(session.userId)
    if (!user) return null
    if (user.lifecycleState !== 'active' || session.authGeneration !== user.lifecycleVersion) {
      return null
    }
    return { session, user }
  }

  function issueSession(user) {
    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(
      JSON.stringify({
        userId: user.id,
        email: user.email,
        teamId: user.teamId,
        role: user.role,
        authGeneration: user.lifecycleVersion,
        iat: now,
        exp: now + 3600,
        iss: issuer,
        aud: audience,
      })
    )
    const signed = `${header}.${payload}`
    const token = `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`
    sessions.set(token, {
      userId: user.id,
      authGeneration: user.lifecycleVersion,
      revoked: false,
    })
    return token
  }

  function revokeUserSessions(userId) {
    for (const session of sessions.values()) {
      if (session.userId === userId) session.revoked = true
    }
  }

  function passwordHash(password) {
    if (password.trim().length < 8 || password.length > 256) return null
    return bcrypt.hash(password, 12)
  }

  function setPassword(user, passwordHashValue, invitation) {
    user.passwordHash = passwordHashValue
    user.lifecycleVersion += 1
    revokeUserSessions(user.id)
    if (invitation) {
      invitation.status = 'accepted'
      invitation.acceptedAt = new Date().toISOString()
      invitation.acceptedUserId = user.id
      invitation.userId = user.id
    }
    metrics.passwordUpdates.push({ userId: user.id, invitationId: invitation?.id || null })
  }

  function serviceAuthorized(headers) {
    return String(headers.authorization || '') === `Bearer ${RECOVERY_CONTROL_API_SERVICE_TOKEN}`
  }

  function sessionToken(headers) {
    return String(headers['x-user-session-token'] || '').trim()
  }

  async function handle({ method, path, headers = {}, body }) {
    if (!serviceAuthorized(headers)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }

    const previewMatch = path.match(/^\/external\/invitations\/token\/([^/]+)$/)
    if (method === 'GET' && previewMatch) {
      const token = decodeURIComponent(previewMatch[1])
      metrics.previewRequests.push({ token })
      const invitation = invitations.get(token)
      if (!invitation) {
        return { status: 400, body: { error: 'invalid_invitation' } }
      }
      if (
        invitation.status === 'draft' ||
        invitation.status === 'revoked' ||
        (invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now())
      ) {
        return { status: 404, body: { error: 'not_found' } }
      }
      return { status: 200, body: invitationPreview(invitation) }
    }

    if (method === 'POST' && path === '/external/invitations/accept') {
      const token = String(body?.token || '').trim()
      const email = String(body?.email || '')
        .trim()
        .toLowerCase()
      metrics.acceptRequests.push({ token })
      const invitation = invitations.get(token)
      if (!invitation) return { status: 400, body: { error: 'invalid_invitation' } }
      if (invitation.email.toLowerCase() !== email) {
        return { status: 400, body: { error: 'invalid_invitation' } }
      }
      if (invitation.purpose === 'password_reset') {
        return { status: 400, body: { error: 'not_pending' } }
      }
      // An accepted invitation replayed by its owner is a success without a
      // session: the token no longer proves a pending capability.
      if (invitation.status === 'accepted') {
        return {
          status: 200,
          body: { accepted: true, ...invitationPreview(invitation), replay: true },
        }
      }
      if (invitation.status !== 'pending') {
        return { status: 400, body: { error: 'not_pending' } }
      }
      if (Date.parse(invitation.expiresAt) <= Date.now()) {
        return { status: 410, body: { error: 'expired' } }
      }
      const user = users.get(invitation.userId) || null
      if (!user) return { status: 404, body: { error: 'not_found' } }
      invitation.status = 'accepted'
      invitation.acceptedAt = new Date().toISOString()
      invitation.acceptedUserId = user.id
      return {
        status: 200,
        body: {
          accepted: true,
          ...invitationPreview(invitation),
          token: issueSession(user),
          sessionContract: 'v1',
        },
      }
    }

    if (method === 'POST' && path === '/external/invitations/password-token') {
      const token = String(body?.token || '').trim()
      const email = String(body?.email || '')
        .trim()
        .toLowerCase()
      const invitationId = String(body?.invitationId || '').trim()
      const password = String(body?.password || '')
      metrics.passwordTokenRequests.push({ token, invitationId })
      const invitation = invitations.get(token)
      if (!invitation) {
        return { status: 400, body: { error: 'invalid_invitation' } }
      }
      if (invitation.email.toLowerCase() !== email) {
        return { status: 400, body: { error: 'invalid_invitation' } }
      }
      if (invitation.id !== invitationId) {
        return { status: 403, body: { error: 'forbidden' } }
      }
      if (invitation.purpose !== 'password_reset') {
        return { status: 409, body: { error: 'invitation_not_pending' } }
      }
      if (invitation.status !== 'pending') {
        return { status: 409, body: { error: 'invitation_not_pending' } }
      }
      if (Date.parse(invitation.expiresAt) <= Date.now()) {
        return { status: 410, body: { error: 'expired' } }
      }
      const user = users.get(invitation.userId) || null
      if (!user) return { status: 404, body: { error: 'not_found' } }
      const nextHash = await passwordHash(password)
      if (!nextHash) return { status: 400, body: { error: 'invalid_password' } }
      setPassword(user, nextHash, invitation)
      return {
        status: 200,
        body: {
          ...invitationPreview(invitation),
          passwordUpdated: true,
          reauthenticationRequired: true,
        },
      }
    }

    if (method === 'POST' && path === '/external/invitations/password') {
      const userId = String(body?.userId || '').trim()
      const email = String(body?.email || '')
        .trim()
        .toLowerCase()
      const invitationId = String(body?.invitationId || '').trim()
      const password = String(body?.password || '')
      metrics.passwordRequests.push({ userId, invitationId })
      const session = activeSession(sessionToken(headers))
      if (!session || session.user.id !== userId || session.user.email.toLowerCase() !== email) {
        return { status: 403, body: { error: 'forbidden' } }
      }
      const invitation = [...invitations.values()].find(row => row.id === invitationId)
      if (!invitation) return { status: 404, body: { error: 'not_found' } }
      if (invitation.userId !== userId || invitation.email.toLowerCase() !== email) {
        return { status: 403, body: { error: 'forbidden' } }
      }
      if (!['member_invitation', 'admin_desktop_access'].includes(invitation.purpose)) {
        return { status: 404, body: { error: 'not_found' } }
      }
      if (invitation.status !== 'accepted') {
        return { status: 409, body: { error: 'invitation_not_accepted' } }
      }
      const nextHash = await passwordHash(password)
      if (!nextHash) return { status: 400, body: { error: 'invalid_password' } }
      // The session route sets only the first password; a later change goes
      // through the reset link or Settings.
      if (session.user.passwordHash) {
        return { status: 409, body: { error: 'password_already_set' } }
      }
      setPassword(session.user, nextHash, invitation)
      return {
        status: 200,
        body: {
          ...invitationPreview(invitation),
          passwordUpdated: true,
        },
      }
    }

    if (method === 'POST' && path === '/external/auth/password-login') {
      const email = String(body?.email || '')
        .trim()
        .toLowerCase()
      const password = String(body?.password || '')
      metrics.loginRequests.push({ email })
      const user = [...users.values()].find(candidate => candidate.email.toLowerCase() === email)
      if (!user) return { status: 401, body: { error: 'Unauthorized' } }
      if (!user.passwordHash) return { status: 409, body: { error: 'password_not_set' } }
      if (!(await bcrypt.compare(password, user.passwordHash))) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const token = issueSession(user)
      metrics.loginSuccesses.push({ userId: user.id })
      return {
        status: 200,
        body: {
          token,
          sessionContract: 'v1',
          me: {
            id: user.id,
            email: user.email,
            name: user.name,
            picture: null,
            teamId: user.teamId,
            teamName: user.teamName,
            role: user.role,
          },
        },
      }
    }

    const [pathname, search = ''] = path.split('?')
    const meMatch = pathname.match(/^\/external\/users\/([^/]+)\/me$/)
    if (method === 'GET' && meMatch) {
      const session = activeSession(sessionToken(headers))
      if (!session || session.user.id !== meMatch[1]) {
        metrics.unauthorizedMeRequests.push({ userId: meMatch[1] })
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const user = session.user
      const requestedTeamId = new URLSearchParams(search).get('teamId') || ''
      const memberTeam = Boolean(user.teamId) && requestedTeamId === user.teamId
      metrics.meRequests.push({ userId: user.id })
      return {
        status: 200,
        body: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: null,
          teamId: memberTeam ? user.teamId : null,
          teamName: memberTeam ? user.teamName : null,
          role: memberTeam ? user.role : null,
          profile: {
            displayName: user.name || user.email,
            channels: {
              emails: [],
              telegramHandles: [],
              slackUserNames: [],
              telegramIds: [],
              discordUserNames: [],
              whatsappNumbers: [],
            },
          },
        },
      }
    }

    if (method === 'POST' && path === '/external/auth/session/logout') {
      const token = sessionToken(headers)
      metrics.logoutRequests.push({ hasToken: Boolean(token) })
      const session = sessions.get(token)
      if (!session || session.revoked) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      session.revoked = true
      return { status: 200, body: { revoked: true } }
    }

    return { status: 404, body: { error: 'not_found' } }
  }

  function snapshot() {
    return clone({
      ...metrics,
      users: [...users.values()].map(user => ({
        id: user.id,
        email: user.email,
        lifecycleVersion: user.lifecycleVersion,
        passwordPending: !user.passwordHash,
      })),
      invitations: [...invitations.values()].map(invitation => ({
        id: invitation.id,
        token: invitation.token,
        purpose: invitation.purpose,
        status: invitation.status,
        acceptedUserId: invitation.acceptedUserId,
        passwordPending: invitationPreview(invitation).passwordPending,
      })),
    })
  }

  return {
    handle,
    snapshot,
    users,
    invitations,
    metrics,
    issueSession,
    sessionValid(token) {
      return Boolean(activeSession(token))
    },
  }
}
