import { Router } from 'express'
import { pool } from '../../db.js'
import { sendPublicApiError } from '../../http/publicApiError.js'
import type { K8sGateway } from '../../k8s.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { externalUserSessionEventsTotal } from '../../observability/metrics.js'
import { AuthClaims, RpcScope, TEAM_ROLES } from '../../profileTypes.js'
import { getLiveTeamMembership } from '../../services/access/liveTeamAuthorization.js'
import { authenticateExternalSessionToken } from '../../services/auth/externalSessionAuthentication.js'
import {
  issueExternalUserSession,
  requestedExternalSessionContract,
} from '../../services/auth/externalSessionIssuance.js'
import { authenticatePasswordAndIssueSession } from '../../services/auth/passwordSessionAuthentication.js'
import {
  renewUserSessionToken,
  revokeAllUserSessions,
  revokeLegacyUserSession,
  revokeUserSession,
} from '../../services/auth/userSessionService.js'
import {
  getTeamAgents,
  getUserAgents,
  googleLoginData,
  requestProfilePasswordReset,
} from '../../services/directory/index.js'
import { signExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import { verifyGoogleIdToken } from '../../utils/auth/googleAuth.js'
import {
  SANDBOX_UI_RPC_HOST_REF,
  classifyRpcTokenDenial,
  issueRpcAccessToken,
  normalizeRequestedHostRefs,
  normalizeRequestedScopes,
} from '../../utils/auth/rpcAuthToken.js'
import { userHasUiBearingRecipeAccess } from '../../utils/auth/sandboxUiScope.js'

const PASSWORD_RESET_RATE_LIMIT_PER_MINUTE = 5

export function createExternalAuthRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.post('/external/auth/google-login', async (req, res, next) => {
    try {
      const idToken = String(req.body?.idToken || '').trim()
      if (!idToken) return res.status(400).json({ error: 'idToken is required' })
      const google = await verifyGoogleIdToken(idToken)
      const login = await googleLoginData({
        email: google.email,
        name: google.name,
        picture: google.picture,
      })
      const role = login.membership.role
      const issued = await issueExternalUserSession({
        contract: requestedExternalSessionContract(req.body?.sessionContract),
        userId: login.user.id,
        email: google.email,
        teamId: login.membership.team_id,
        role,
        authenticationMethods: ['google'],
      })
      externalUserSessionEventsTotal.inc(
        { event: 'issue', contract: issued.contract, result: 'success' },
        1
      )
      return res.status(200).json({
        token: issued.token,
        sessionContract: issued.contract,
        me: {
          id: login.user.id,
          email: google.email,
          name: login.user.name,
          picture: login.user.picture,
          teamId: login.membership.team_id,
          teamName: login.membership.team_name,
          role,
        },
        isNewUser: login.isNewUser,
      })
    } catch (error) {
      return next(error)
    }
  })

  router.post('/external/auth/password-login', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const password = String(req.body?.password || '')
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' })
      }

      const login = await authenticatePasswordAndIssueSession({
        email,
        password,
        contract: requestedExternalSessionContract(req.body?.sessionContract),
      })
      if (!login) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      if ('error' in login) {
        if (login.error === 'password_not_set') {
          return res.status(409).json({ error: 'password_not_set' })
        }
        return res.status(403).json({ error: 'membership_not_found' })
      }

      const role = login.membership.role
      const issued = login.issued
      externalUserSessionEventsTotal.inc(
        { event: 'issue', contract: issued.contract, result: 'success' },
        1
      )
      return res.status(200).json({
        token: issued.token,
        sessionContract: issued.contract,
        me: {
          id: login.user.id,
          email: login.user.email,
          name: login.user.name,
          picture: login.user.picture,
          teamId: login.membership.team_id || null,
          teamName: login.membership.team_name,
          role,
        },
      })
    } catch (error) {
      return next(error)
    }
  })

  router.post(
    '/external/auth/password-reset/request',
    rateLimitMiddleware({
      bucketType: 'profile_password_reset_request',
      maxPerMinute: PASSWORD_RESET_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req => {
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        return email ? `profile_password_reset:${email}` : `profile_password_reset_ip:${req.ip}`
      },
    }),
    async (req, res, next) => {
      try {
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        await requestProfilePasswordReset(email)
        return res.status(200).json({ requested: true })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post('/external/auth/verify', async (req, res, next) => {
    try {
      const token = String(req.body?.token || '').trim()
      if (!token || token.length > 4096) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      const authentication = await authenticateExternalSessionToken(token)
      if (authentication.status !== 'authenticated') {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      return res.status(200).json({ claims: authentication.claims })
    } catch (error) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Session authority is temporarily unavailable.',
        true
      )
      return
    }
  })

  router.post('/external/auth/session-token', async (req, res, next) => {
    try {
      const role = String(req.body?.role || '').trim() as AuthClaims['role']
      const userId = String(req.body?.userId || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const teamId = String(req.body?.teamId || '').trim()
      if (!userId || !email || !teamId || !TEAM_ROLES.includes(role)) {
        return res.status(400).json({ error: 'invalid payload' })
      }
      const currentToken = String(
        req.header('x-user-session-token') || req.body?.sessionToken || ''
      ).trim()
      if (!currentToken || currentToken.length > 4096) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      const authentication = await authenticateExternalSessionToken(currentToken)
      if (
        authentication.status !== 'authenticated' ||
        authentication.claims.userId !== userId ||
        authentication.claims.email.toLowerCase() !== email
      ) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      const membership = await pool.query(
        `SELECT 1
           FROM users u
           JOIN team_members tm ON tm.user_id = u.id
          WHERE u.id = $1
            AND LOWER(u.email) = LOWER($2)
            AND tm.team_id = $3
            AND tm.role = $4
            AND tm.status = 'active'
          LIMIT 1`,
        [userId, email, teamId, role]
      )
      if ((membership.rowCount ?? 0) === 0) {
        externalUserSessionEventsTotal.inc(
          { event: 'legacy_switch', contract: 'compatibility', result: 'denied' },
          1
        )
        return res.status(403).json({ error: 'membership_not_found' })
      }
      externalUserSessionEventsTotal.inc(
        { event: 'legacy_switch', contract: 'compatibility', result: 'success' },
        1
      )
      const token =
        authentication.claims.sessionContract === 'v2'
          ? currentToken
          : signExternalSessionToken({ userId, email, teamId, role })
      return res.status(200).json({
        token,
        deprecated: true,
        sessionContract: authentication.claims.sessionContract === 'v2' ? 'v2' : 'v1',
      })
    } catch (error) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Authorization is temporarily unavailable.',
        true
      )
      return
    }
  })

  router.post('/external/auth/session/renew', async (req, res, next) => {
    try {
      const token = String(req.header('x-user-session-token') || req.body?.token || '').trim()
      if (!token || token.length > 4096) {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      const renewed = await renewUserSessionToken(token)
      if (!('token' in renewed)) {
        externalUserSessionEventsTotal.inc({ event: 'renew', contract: 'v2', result: 'denied' }, 1)
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      externalUserSessionEventsTotal.inc({ event: 'renew', contract: 'v2', result: 'success' }, 1)
      return res.status(200).json({
        token: renewed.token,
        expiresInSeconds: renewed.expiresInSeconds,
        absoluteExpiresAt: renewed.identity.absoluteExpiresAt.toISOString(),
      })
    } catch (error) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Session authority is temporarily unavailable.',
        true
      )
      return
    }
  })

  router.post('/external/auth/session/logout', async (req, res, next) => {
    try {
      const token = String(req.header('x-user-session-token') || req.body?.token || '').trim()
      const authentication = token ? await authenticateExternalSessionToken(token) : null
      if (!authentication || authentication.status !== 'authenticated') {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      if (authentication.claims.sessionContract !== 'v2' || !authentication.claims.sid) {
        const revoked = await revokeLegacyUserSession(token, authentication.claims, 'logout')
        return res.status(200).json({ revoked, legacy: true })
      }
      const revoked = await revokeUserSession(
        authentication.claims.userId,
        authentication.claims.sid,
        'logout'
      )
      if (!revoked) {
        sendPublicApiError(req, res, 401, 'session_revoked', 'The session is already revoked.')
        return
      }
      return res.status(200).json({ revoked: true })
    } catch (error) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Session authority is temporarily unavailable.',
        true
      )
      return
    }
  })

  router.post('/external/auth/sessions/:sid/revoke', async (req, res, next) => {
    try {
      const token = String(req.header('x-user-session-token') || '').trim()
      const authentication = token ? await authenticateExternalSessionToken(token) : null
      if (!authentication || authentication.status !== 'authenticated') {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      if (authentication.claims.sessionContract !== 'v2') {
        return res.status(409).json({ error: 'v2_session_required' })
      }
      const revoked = await revokeUserSession(
        authentication.claims.userId,
        String(req.params.sid || '').trim(),
        'user_revoked'
      )
      return res.status(200).json({ revoked })
    } catch (error) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Session authority is temporarily unavailable.',
        true
      )
      return
    }
  })

  router.post('/external/auth/sessions/revoke-all', async (req, res, next) => {
    try {
      const token = String(req.header('x-user-session-token') || '').trim()
      const authentication = token ? await authenticateExternalSessionToken(token) : null
      if (!authentication || authentication.status !== 'authenticated') {
        sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
        return
      }
      if (authentication.claims.sessionContract !== 'v2') {
        return res.status(409).json({ error: 'v2_session_required' })
      }
      const revoked = await revokeAllUserSessions(authentication.claims.userId, 'user_revoked_all')
      return res.status(200).json({ revoked })
    } catch (error) {
      sendPublicApiError(
        req,
        res,
        503,
        'authority_unavailable',
        'Session authority is temporarily unavailable.',
        true
      )
      return
    }
  })

  router.post('/external/rpc/token', async (req, res, next) => {
    try {
      const sessionToken = String(req.body?.sessionToken || '').trim()
      if (!sessionToken || sessionToken.length > 4096)
        return res.status(401).json({ error: 'Unauthorized' })
      const authentication = await authenticateExternalSessionToken(sessionToken)
      if (authentication.status !== 'authenticated') {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const claims = authentication.claims
      const liveTeam = claims.teamId
        ? await getLiveTeamMembership(claims.userId, claims.teamId)
        : null
      const requestedScopes = normalizeRequestedScopes(req.body?.scopes)
      const hostRefs = normalizeRequestedHostRefs(req.body?.hostRefs)
      if (hostRefs.length === 0) {
        return res.status(403).json({ error: 'invalid_host_refs' })
      }

      const requestsSandboxUiScope = requestedScopes.includes('sandbox:ui:view')
      const includesSandboxUiHostRef = hostRefs.includes(SANDBOX_UI_RPC_HOST_REF)
      if (requestsSandboxUiScope && !includesSandboxUiHostRef) {
        return res.status(403).json({ error: 'sandbox_ui_host_ref_required' })
      }
      if (includesSandboxUiHostRef && !requestsSandboxUiScope) {
        return res.status(403).json({ error: 'sandbox_ui_scope_required' })
      }

      const agentHostRefs = hostRefs.filter(hostRef => hostRef !== SANDBOX_UI_RPC_HOST_REF)
      if (includesSandboxUiHostRef && agentHostRefs.length > 0) {
        return res.status(403).json({ error: 'sandbox_ui_host_ref_exclusive' })
      }
      if (agentHostRefs.length > 0) {
        const userAgents = await getUserAgents(claims.userId)
        const grantedHostRefs = new Set(userAgents.agentNames)
        if (liveTeam) {
          const teamAgents = await getTeamAgents(liveTeam.teamId)
          for (const agentName of teamAgents.agentNames) grantedHostRefs.add(agentName)
        }
        if (agentHostRefs.some(hostRef => !grantedHostRefs.has(hostRef))) {
          return res.status(403).json({
            error: liveTeam ? 'host_access_denied' : 'direct_host_access_required',
          })
        }
      }

      const extraScopes: RpcScope[] = []
      // Resolve the K8s+DB sandbox UI grant only when the client explicitly
      // asks for the scope. This keeps ordinary agent-token issuance from
      // paying the sandbox UI recipe lookup cost or receiving unused grants.
      if (
        requestsSandboxUiScope &&
        (await userHasUiBearingRecipeAccess(claims.userId, gateway, pool, liveTeam?.teamId ?? null))
      ) {
        extraScopes.push('sandbox:ui:view')
      }
      const auth = {
        userId: claims.userId,
        teamId: liveTeam?.teamId ?? null,
        role: liveTeam?.role ?? 'member',
      }
      const result = issueRpcAccessToken(auth, req.body?.scopes, hostRefs, extraScopes)
      if (!result) {
        // Distinguish "you need a team for this" from a generic scope failure so
        // the desktop app can act on it (e.g. prompt to join/switch a team)
        // instead of surfacing an opaque "no access" state.
        return res
          .status(403)
          .json({ error: classifyRpcTokenDenial(auth, req.body?.scopes, extraScopes) })
      }
      return res.status(200).json(result)
    } catch (error) {
      return next(error)
    }
  })

  return router
}
