import { Router } from 'express'
import { pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { RpcScope } from '../../profileTypes.js'
import { authenticateExternalUserSession } from '../../services/auth/externalSessionAuthentication.js'
import { renewExternalUserSession } from '../../services/auth/externalSessionAuthentication.js'
import {
  issueExternalUserSession,
  selectExternalSessionRepresentation,
} from '../../services/auth/externalSessionIssuance.js'
import {
  revokeAllUserSessions,
  revokeLegacyUserSession,
  revokeUserSession,
} from '../../services/auth/userSessionService.js'
import {
  getTeamAgents,
  getUserAgents,
  googleLoginData,
  passwordLoginData,
  requestProfilePasswordReset,
} from '../../services/directory/index.js'
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

function externalSessionClient(req: { body?: unknown; header(name: string): string | undefined }): {
  version?: string
  requestedContract?: 'v1' | 'v2'
} {
  const body = (req.body ?? {}) as { sessionContract?: unknown; clientVersion?: unknown }
  const requestedContract =
    body.sessionContract === 'v1' || body.sessionContract === 'v2'
      ? body.sessionContract
      : undefined
  const version = String(req.header('x-evenfire-client-version') || body.clientVersion || '').trim()
  return {
    ...(version ? { version } : {}),
    ...(requestedContract ? { requestedContract } : {}),
  }
}

function sessionTokenFromRequest(req: {
  body?: unknown
  header(name: string): string | undefined
}): string {
  const body = (req.body ?? {}) as { token?: unknown; sessionToken?: unknown }
  return String(req.header('x-user-session-token') || body.token || body.sessionToken || '').trim()
}

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
      const selection = selectExternalSessionRepresentation(externalSessionClient(req))
      if (selection.status !== 'selected') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      const issued = await issueExternalUserSession({
        contract: selection.contract,
        userId: login.user.id,
        email: google.email,
        teamId: login.membership.team_id || null,
        role,
        authenticationMethods: ['google'],
      })
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

      const login = await passwordLoginData({ email, password })
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
      const selection = selectExternalSessionRepresentation(externalSessionClient(req))
      if (selection.status !== 'selected') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      const issued = await issueExternalUserSession({
        contract: selection.contract,
        userId: login.user.id,
        email: login.user.email,
        teamId: login.membership.team_id || null,
        role,
        authenticationMethods: ['pwd'],
      })
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
      if (!token || token.length > 4096) return res.status(401).json({ error: 'Unauthorized' })
      const authentication = await authenticateExternalUserSession(token, {
        purpose: 'verify',
        client: externalSessionClient(req),
      })
      if (authentication.status === 'upgrade_required') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      if (authentication.status !== 'authenticated') {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      return res.status(200).json({ claims: authentication.claims })
    } catch (error) {
      return res.status(503).json({ error: 'authority_unavailable' })
    }
  })

  router.post('/external/auth/session-token', async (req, res, next) => {
    try {
      const userId = String(req.body?.userId || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const teamId = String(req.body?.teamId || '').trim()
      const currentToken = sessionTokenFromRequest(req)
      if (!userId || !email || !teamId || !currentToken || currentToken.length > 4096) {
        return res.status(400).json({ error: 'invalid payload' })
      }
      const authentication = await authenticateExternalUserSession(currentToken, {
        purpose: 'switch',
        client: externalSessionClient(req),
      })
      if (authentication.status === 'upgrade_required') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      if (
        authentication.status !== 'authenticated' ||
        authentication.claims.userId !== userId ||
        authentication.claims.email.toLowerCase() !== email
      ) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const membership = await pool.query(
        `SELECT tm.role
           FROM users u
           JOIN team_members tm ON tm.user_id = u.id
          WHERE u.id = $1
            AND LOWER(u.email) = LOWER($2)
            AND tm.team_id = $3
            AND tm.status = 'active'
          LIMIT 1`,
        [userId, email, teamId]
      )
      const liveRole = (membership.rows[0] as { role?: 'admin' | 'inviter' | 'member' } | undefined)
        ?.role
      if (!liveRole) {
        return res.status(403).json({ error: 'membership_not_found' })
      }
      if (authentication.contract === 'v2') {
        return res.status(200).json({
          token: currentToken,
          sessionContract: 'v2',
          deprecated: true,
        })
      }
      const issued = await issueExternalUserSession({
        contract: 'v1',
        userId,
        email,
        teamId,
        role: liveRole,
        authenticationMethods: [],
      })
      return res.status(200).json({
        token: issued.token,
        sessionContract: issued.contract,
        deprecated: true,
      })
    } catch (error) {
      return res.status(503).json({ error: 'authority_unavailable' })
    }
  })

  router.post('/external/auth/session/renew', async (req, res) => {
    try {
      const token = sessionTokenFromRequest(req)
      if (!token || token.length > 4096) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const renewal = await renewExternalUserSession(token, {
        client: externalSessionClient(req),
      })
      if (renewal.status === 'upgrade_required') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      if (renewal.status !== 'renewed') {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      return res.status(200).json({
        token: renewal.session.token,
        sessionContract: 'v2',
        expiresInSeconds: renewal.session.expiresInSeconds,
        absoluteExpiresAt: renewal.session.identity.absoluteExpiresAt.toISOString(),
      })
    } catch {
      return res.status(503).json({ error: 'authority_unavailable' })
    }
  })

  router.post('/external/auth/session/logout', async (req, res) => {
    try {
      const token = sessionTokenFromRequest(req)
      if (!token || token.length > 4096) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const authentication = await authenticateExternalUserSession(token, {
        purpose: 'revoke_cleanup',
        client: externalSessionClient(req),
      })
      if (authentication.status !== 'authenticated') {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const revoked =
        authentication.contract === 'v2' && authentication.claims.sid
          ? await revokeUserSession(
              authentication.claims.userId,
              authentication.claims.sid,
              'logout'
            )
          : await revokeLegacyUserSession(token, authentication.claims, 'logout')
      return res.status(200).json({ revoked })
    } catch {
      return res.status(503).json({ error: 'authority_unavailable' })
    }
  })

  router.post('/external/auth/sessions/revoke-all', async (req, res) => {
    try {
      const token = sessionTokenFromRequest(req)
      if (!token || token.length > 4096) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const authentication = await authenticateExternalUserSession(token, {
        purpose: 'protected',
        client: externalSessionClient(req),
      })
      if (authentication.status === 'upgrade_required') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      if (authentication.status !== 'authenticated') {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const revoked = await revokeAllUserSessions(authentication.claims.userId, 'user_revoked_all')
      return res.status(200).json({ revoked })
    } catch {
      return res.status(503).json({ error: 'authority_unavailable' })
    }
  })

  router.post('/external/rpc/token', async (req, res, next) => {
    try {
      const sessionToken = String(req.body?.sessionToken || '').trim()
      if (!sessionToken || sessionToken.length > 4096)
        return res.status(401).json({ error: 'Unauthorized' })
      const authentication = await authenticateExternalUserSession(sessionToken, {
        purpose: 'rpc_legacy',
        client: externalSessionClient(req),
      })
      if (authentication.status === 'upgrade_required') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      if (authentication.status !== 'authenticated') {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const claims = authentication.claims
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
        if (claims.teamId) {
          const teamAgents = await getTeamAgents(claims.teamId)
          for (const agentName of teamAgents.agentNames) grantedHostRefs.add(agentName)
        }
        if (agentHostRefs.some(hostRef => !grantedHostRefs.has(hostRef))) {
          return res.status(403).json({
            error: claims.teamId ? 'host_access_denied' : 'direct_host_access_required',
          })
        }
      }

      const extraScopes: RpcScope[] = []
      // Resolve the K8s+DB sandbox UI grant only when the client explicitly
      // asks for the scope. This keeps ordinary agent-token issuance from
      // paying the sandbox UI recipe lookup cost or receiving unused grants.
      if (
        requestsSandboxUiScope &&
        (await userHasUiBearingRecipeAccess(claims.userId, gateway, pool, claims.teamId))
      ) {
        extraScopes.push('sandbox:ui:view')
      }
      const auth = { userId: claims.userId, teamId: claims.teamId, role: claims.role }
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
