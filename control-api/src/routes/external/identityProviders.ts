import { Router } from 'express'
import { getMe } from '../../services/directory/index.js'
import {
  exchangeIdentityProviderLoginCode,
  listPublicIdentityProviders,
  startMicrosoftOAuth,
} from '../../services/identityProviders/service.js'
import { verifyExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'

export function createExternalIdentityProvidersRouter(): Router {
  const router = Router()

  router.get('/external/auth/providers', async (_req, res, next) => {
    try {
      res.status(200).json(await listPublicIdentityProviders())
    } catch (error) {
      next(error)
    }
  })

  router.post('/external/auth/providers/microsoft/start', async (req, res, next) => {
    try {
      const flow = String(req.body?.flow || '')
      if (!['profile_login', 'desktop_login', 'invitation_link'].includes(flow)) {
        res.status(400).json({ error: 'invalid_identity_provider_flow' })
        return
      }
      res.status(200).json(
        await startMicrosoftOAuth({
          connectionId: String(req.body?.connectionId || ''),
          flow: flow as 'profile_login' | 'desktop_login' | 'invitation_link',
          returnUrl: String(req.body?.returnUrl || ''),
          invitationToken: String(req.body?.invitationToken || ''),
          flowBinding: String(req.body?.flowBinding || ''),
        })
      )
    } catch (error) {
      next(error)
    }
  })

  router.post('/external/auth/providers/exchange', async (req, res, next) => {
    try {
      const code = String(req.body?.code || '').trim()
      const flowBinding = String(req.body?.flowBinding || '').trim()
      if (!code || !flowBinding) {
        res.status(400).json({ error: 'code and flowBinding are required' })
        return
      }
      const token = await exchangeIdentityProviderLoginCode(code, flowBinding)
      if (!token) {
        res.status(400).json({ error: 'invalid_or_expired_login_code' })
        return
      }
      const claims = verifyExternalSessionToken(token)
      if (!claims) {
        res.status(400).json({ error: 'invalid_login_session' })
        return
      }
      const me = claims.teamId ? await getMe(claims.userId, claims.teamId) : null
      res.status(200).json({
        token,
        me: me || {
          id: claims.userId,
          email: claims.email,
          name: null,
          picture: null,
          teamId: null,
          teamName: null,
          role: claims.role,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}
