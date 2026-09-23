import { Request, Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  isCurrentExternalSession,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import type { AuthClaims } from '../../profileTypes.js'
import { parseRequestedEntityChangeCursor, streamEntityChanges } from '../entityChangeStream.js'

export function isEntityChangeExternalSessionCurrent(
  claims: AuthClaims,
  nowMs = Date.now()
): Promise<boolean> {
  if (claims.exp * 1000 <= nowMs) return Promise.resolve(false)
  return isCurrentExternalSession(claims)
}

export function createExternalEntityChangesRouter(): Router {
  const router = Router()
  const edgeLimits = createExternalClientRateLimiters(
    'entity-changes',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.get(
    '/external/entity-changes/stream',
    ...edgeLimits,
    requireValidExternalSessionToken,
    rateLimitMiddleware({
      bucketType: 'external_user',
      maxPerMinute: config.approvalRlExternalPerMin,
      getBucketKey: req => {
        const claims = (req as ExternalAuthedRequest).externalAuth
        return claims ? `user:${claims.userId}:entity-changes` : null
      },
    }),
    asyncHandler(async (req: Request, res: Response) => {
      const externalReq = req as ExternalAuthedRequest
      const claims = externalReq.externalAuth
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const cursor = parseRequestedEntityChangeCursor(req)
      if (cursor === false) {
        res.status(400).json({ error: 'Invalid entity change cursor' })
        return
      }
      streamEntityChanges(
        req,
        res,
        cursor,
        () => isEntityChangeExternalSessionCurrent(claims),
        'user'
      )
    })
  )
  return router
}
