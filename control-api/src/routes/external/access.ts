import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { createExternalClientRateLimiters } from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { userAccessCapabilityManifest } from '../../services/access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'

export function createExternalAccessRouter(): Router {
  const router = Router()
  const externalAccessRateLimits = createExternalClientRateLimiters(
    'users',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )
  router.use('/external/access', ...externalAccessRateLimits)

  router.get(
    '/external/access/capabilities',
    requireValidExternalSessionToken,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const policy = await resolveEffectiveUserAccessPolicy()
      res.status(200).json({
        contractVersion: '2',
        currentSessionContract: req.externalAuth!.sessionContract ?? 'v1',
        ...userAccessCapabilityManifest(policy),
      })
    })
  )

  return router
}
