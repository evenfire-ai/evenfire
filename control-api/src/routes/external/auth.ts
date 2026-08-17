import { Router } from 'express'
import { pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import { isCurrentExternalSession } from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { AuthClaims, RpcScope, TEAM_ROLES } from '../../profileTypes.js'
import {
  getTeamAgents,
  getUserAgents,
  googleLoginData,
  passwordLoginData,
  requestProfilePasswordReset,
} from '../../services/directory/index.js'
import {
  signExternalSessionToken,
  verifyExternalSessionToken,
} from '../../utils/auth/externalSessionAuthToken.js'
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
      if ('error' in login) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      const role = login.membership.role
      const token = signExternalSessionToken({
        userId: login.user.id,
        email: google.email,
        teamId: login.membership.team_id || null,
        role,
        authGeneration: login.authGeneration,
      })
      return res.status(200).json({
        token,
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
        if (login.error === 'user_retired') {
          return res.status(401).json({ error: 'Unauthorized' })
        }
        if (login.error === 'password_not_set') {
          return res.status(409).json({ error: 'password_not_set' })
        }
        return res.status(403).json({ error: 'membership_not_found' })
      }

      const role = login.membership.role
      const token = signExternalSessionToken({
        userId: login.user.id,
        email: login.user.email,
        teamId: login.membership.team_id || null,
        role,
        authGeneration: login.authGeneration,
      })
      return res.status(200).json({
        token,
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
      const claims = verifyExternalSessionToken(token)
      if (!claims) return res.status(401).json({ error: 'Unauthorized' })
      if (!(await isCurrentExternalSession(claims))) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
      return res.status(200).json({ claims })
    } catch (error) {
      return next(error)
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
      const membership = await pool.query(
        `SELECT u.lifecycle_version
           FROM users u
           JOIN team_members tm ON tm.user_id = u.id
          WHERE u.id = $1
            AND LOWER(u.email) = LOWER($2)
            AND u.lifecycle_state = 'active'
            AND tm.team_id = $3
            AND tm.role = $4
            AND tm.status = 'active'
          LIMIT 1`,
        [userId, email, teamId, role]
      )
      if ((membership.rowCount ?? 0) === 0) {
        return res.status(403).json({ error: 'membership_not_found' })
      }
      const authGeneration = Number(
        (membership.rows[0] as { lifecycle_version?: unknown }).lifecycle_version
      )
      if (!Number.isSafeInteger(authGeneration) || authGeneration < 1) {
        return res.status(403).json({ error: 'membership_not_found' })
      }
      const token = signExternalSessionToken({ userId, email, teamId, role, authGeneration })
      return res.status(200).json({ token })
    } catch (error) {
      return next(error)
    }
  })

  router.post('/external/rpc/token', async (req, res, next) => {
    try {
      const sessionToken = String(req.body?.sessionToken || '').trim()
      if (!sessionToken || sessionToken.length > 4096)
        return res.status(401).json({ error: 'Unauthorized' })
      const claims = verifyExternalSessionToken(sessionToken)
      if (!claims) return res.status(401).json({ error: 'Unauthorized' })
      if (!(await isCurrentExternalSession(claims))) {
        return res.status(401).json({ error: 'Unauthorized' })
      }
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
