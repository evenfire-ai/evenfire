import { Request, Response, Router } from 'express'
import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import type { ExternalSessionAuthentication } from '../../services/auth/externalSessionAuthentication.js'
import {
  type ExternalSessionCurrentness,
  observeExternalSessionCurrentness,
} from '../../services/auth/externalSessionCurrentnessObserver.js'
import { parseRequestedEntityChangeCursor, streamEntityChanges } from '../entityChangeStream.js'

export function isEntityChangeExternalSessionCurrent(
  authentication: Extract<ExternalSessionAuthentication, { status: 'authenticated' }>,
  options: { db?: Pick<DbClient, 'query'> } = {}
): Promise<ExternalSessionCurrentness> {
  return observeExternalSessionCurrentness(authentication, options)
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
      onBackendUnavailable: 'closed',
      getBucketKey: req => {
        const claims = (req as ExternalAuthedRequest).externalAuth
        return claims ? `user:${claims.userId}:entity-changes` : null
      },
    }),
    asyncHandler(async (req: Request, res: Response) => {
      const externalReq = req as ExternalAuthedRequest
      const claims = externalReq.externalAuth
      const authentication = externalReq.externalSessionAuthentication
      if (!claims || !authentication) {
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
        () => isEntityChangeExternalSessionCurrent(authentication),
        'user',
        `user:${claims.userId}`
      )
    })
  )
  return router
}
