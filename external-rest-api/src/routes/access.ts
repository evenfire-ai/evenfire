import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import { controlApiRequest } from '../controlApiClient.js'
import {
  publicCorrelationId,
  sanitizeControlApiPublicError,
  sendPublicApiError,
  sendSanitizedControlApiPublicError,
} from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { createRateLimiter } from '../middleware/rateLimit.js'

const ACCESS_PUBLIC_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503])
const ACCESS_CATALOG_QUERY_FIELDS = ['families', 'limit', 'cursor'] as const

function accessCatalogQuery(req: AuthedRequest): Record<string, string | undefined> | null {
  const query: Record<string, string | undefined> = {}
  for (const field of ACCESS_CATALOG_QUERY_FIELDS) {
    const value = req.query[field]
    if (value === undefined) {
      query[field] = undefined
      continue
    }
    if (typeof value !== 'string' || value.length === 0) return null
    query[field] = value
  }
  return query
}
function forwardAccessError(error: unknown, res: Response, next: NextFunction): void {
  const sanitized = sanitizeControlApiPublicError(
    error,
    ACCESS_PUBLIC_STATUSES,
    publicCorrelationId(res.req)
  )
  if (sanitized) {
    sendSanitizedControlApiPublicError(res, sanitized)
    return
  }
  next(error)
}

export function createAccessRouter(): Router {
  const router = Router()
  router.use('/me/access', requireAuth)
  const catalogRateLimit = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 10,
    keyFn: req => {
      const userId = (req as AuthedRequest).auth?.userId
      return userId ? `access-catalog:${userId}` : 'access-catalog:unknown'
    },
  })

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

  router.get('/me/access/catalog', catalogRateLimit, async (req: AuthedRequest, res, next) => {
    const query = accessCatalogQuery(req)
    if (!query) {
      sendPublicApiError(req, res, 400, 'invalid_request', 'The catalog query is not valid.')
      return
    }
    try {
      const result = await controlApiRequest('GET', '/external/access/catalog', {
        userSessionToken: extractAuthToken(req),
        query,
      })
      res.status(200).json(result)
    } catch (error) {
      forwardAccessError(error, res, next)
    }
  })

  // There is deliberately no POST /me/access/resolve here. The control-api
  // /external/access/resolve handler stays dormant until the access-resolution
  // contract is enabled, so this edge must not forward to it. Re-adding a
  // forwarding route re-exposes it; routes.accessResolveExposure.test.ts pins
  // the absence.
  return router
}
