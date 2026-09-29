import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { createRateLimitEnforcer } from '../../middleware/rateLimitMiddleware.js'
import { requireValidRpcAccessTokenAny } from '../../middleware/rpcAccessAuth.js'
import {
  LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
  legacySessionAdmissionBucketKey,
} from '../../services/legacySessionAdmission.js'

const enforceLegacySessionAdmission = createRateLimitEnforcer({
  bucketType: 'legacy_session_creation',
  maxPerMinute: LEGACY_SESSION_ADMISSION_LIMIT_PER_MINUTE,
  onBackendUnavailable: 'closed',
})

const router = Router()
router.post(
  '/internal/rpc-proxy/legacy-session-admission',
  requireInternalService('rpc-proxy'),
  requireValidRpcAccessTokenAny(['desktop:view', 'sandbox:ui:view']),
  async (req: any, res: any) => {
    const subject = req.rpcAuth?.sub
    if (!subject) {
      res.status(401).end()
      return
    }
    if (await enforceLegacySessionAdmission(req, res, legacySessionAdmissionBucketKey(subject))) {
      res.status(204).end()
    }
  }
)
