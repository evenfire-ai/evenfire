import { RequestHandler, Router } from 'express'
import {
  completeMicrosoftOAuthCallback,
  completeMicrosoftOAuthErrorCallback,
} from '../../services/identityProviders/service.js'

export function createIdentityProviderCallbackRouter(): Router {
  const router = Router()
  router.get('/identity-provider-callback/microsoft', handleMicrosoftIdentityProviderCallback)
  return router
}

export const handleMicrosoftIdentityProviderCallback: RequestHandler = async (req, res, next) => {
  try {
    const code = String(req.query.code || '').trim()
    const state = String(req.query.state || '').trim()
    const providerError = String(req.query.error_description || req.query.error || '').trim()
    if (providerError) {
      if (!state) {
        res.status(400).json({ error: 'missing_state' })
        return
      }
      const result = await completeMicrosoftOAuthErrorCallback({ state })
      res.redirect(303, result.redirectUrl)
      return
    }
    if (!code || !state) {
      res.status(400).json({ error: 'missing_code_or_state' })
      return
    }
    const result = await completeMicrosoftOAuthCallback({ code, state })
    res.redirect(303, result.redirectUrl)
  } catch (error) {
    next(error)
  }
}
