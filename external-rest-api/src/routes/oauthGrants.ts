import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { ControlApiError } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { listOauthGrants, revokeOauthGrant } from '../services/oauthGrantsService.js'

const PROPAGATED_STATUSES = new Set([400, 401, 403, 404, 409, 422])

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && PROPAGATED_STATUSES.has(error.status)) {
    const body =
      error.body && typeof error.body === 'object' ? error.body : { error: String(error.message) }
    res.status(error.status).json(body)
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
