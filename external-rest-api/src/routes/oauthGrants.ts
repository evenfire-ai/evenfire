import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { sanitizeControlApiPublicError } from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { listOauthGrants, revokeOauthGrant } from '../services/oauthGrantsService.js'

const PROPAGATED_STATUSES = new Set([400, 401, 403, 404, 409, 422])

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  const sanitized = sanitizeControlApiPublicError(error, PROPAGATED_STATUSES)
  if (sanitized) {
    res.status(sanitized.status).json(sanitized.body)
    return
  }
  next(error)
}

export function createOauthGrantsRouter(): Router {
  const router = Router()

  router.get('/oauth/grants', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      res.json(await listOauthGrants(extractAuthToken(req)))
    } catch (err) {
      forwardControlApiError(err, res, next)
    }
  })

  router.delete(
    '/oauth/grants/:recipeNamespace/:recipeName/:oauthClientId',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        await revokeOauthGrant(
          extractAuthToken(req),
          String(req.params.recipeNamespace),
          String(req.params.recipeName),
          String(req.params.oauthClientId)
        )
        res.status(204).send()
      } catch (err) {
        forwardControlApiError(err, res, next)
      }
    }
  )

  return router
}
