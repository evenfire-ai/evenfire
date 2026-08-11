import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import { controlApiRequest } from '../controlApiClient.js'
import { sanitizeControlApiPublicError } from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

const ACCESS_PUBLIC_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503])

function forwardAccessError(error: unknown, res: Response, next: NextFunction): void {
  const sanitized = sanitizeControlApiPublicError(error, ACCESS_PUBLIC_STATUSES)
  if (sanitized) {
    res.status(sanitized.status).json(sanitized.body)
    return
  }
  next(error)
}

export function createAccessRouter(): Router {
  const router = Router()
  router.use('/me/access', requireAuth)

  router.get('/me/access/capabilities', async (req: AuthedRequest, res, next) => {
    try {
      const result = await controlApiRequest('GET', '/external/access/capabilities', {
        userSessionToken: extractAuthToken(req),
      })
      res.status(200).json(result)
    } catch (error) {
      forwardAccessError(error, res, next)
    }
  })

  router.get('/me/access/catalog', async (req: AuthedRequest, res, next) => {
    try {
      const result = await controlApiRequest('GET', '/external/access/catalog', {
        userSessionToken: extractAuthToken(req),
        query: {
          families: typeof req.query.families === 'string' ? req.query.families : undefined,
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        },
      })
      res.status(200).json(result)
    } catch (error) {
      forwardAccessError(error, res, next)
    }
  })

  router.post('/me/access/resolve', async (req: AuthedRequest, res, next) => {
    try {
      const result = await controlApiRequest('POST', '/external/access/resolve', {
        userSessionToken: extractAuthToken(req),
        body: req.body,
      })
      res.status(200).json(result)
    } catch (error) {
      forwardAccessError(error, res, next)
    }
  })

  return router
}
