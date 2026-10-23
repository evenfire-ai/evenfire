import { type Request, Router } from 'express'
import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { createRateLimitEnforcer } from '../../middleware/rateLimitMiddleware.js'
import { requireValidRpcAccessTokenAny } from '../../middleware/rpcAccessAuth.js'
import type { RpcAccessClaims } from '../../profileTypes.js'
import {
  LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
  legacySessionAdmissionBucketKey,
} from '../../services/legacySessionAdmission.js'

type RpcAuthedRequest = Request & { rpcAuth?: RpcAccessClaims }

const enforceLegacySessionAdmission = createRateLimitEnforcer({
  bucketType: 'legacy_session_creation',
  maxPerMinute: LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
  onBackendUnavailable: 'closed',
})

/** The sole RPC Proxy admission authority for legacy Desktop/Sandbox sessions. */
export function createInternalRpcProxyLegacySessionAdmissionRouter(): Router {
  const router = Router()

  router.post(
    '/internal/rpc-proxy/legacy-session-admission',
    requireInternalService('rpc-proxy'),
    requireValidRpcAccessTokenAny(['desktop:view', 'sandbox:ui:view']),
    async (req, res, next) => {
      try {
        const subject = (req as RpcAuthedRequest).rpcAuth?.sub
        if (!subject) {
          res.status(401).json({ error: 'Unauthorized' })
          return
        }
        if (
          await enforceLegacySessionAdmission(req, res, legacySessionAdmissionBucketKey(subject))
        ) {
          res.status(204).end()
        }
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
