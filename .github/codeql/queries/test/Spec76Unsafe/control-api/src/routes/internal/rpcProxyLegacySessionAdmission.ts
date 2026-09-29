import { requireInternalService } from '../../middleware/internalServiceAuth'
import { requireValidRpcAccessTokenAny } from '../../middleware/rpcAccessAuth'

const processBuckets = new Map<string, number>()
function legacySessionAdmissionBucketKey(hostRef: string): string {
  return `legacy-session:${hostRef}`
}
const enforceLegacySessionAdmission = async (_req: any, _res: any, key: string) => {
  processBuckets.set(key, Date.now())
  return true
}

const router = Router()
router.post(
  '/internal/rpc-proxy/legacy-session-admission',
  requireInternalService('rpc-proxy'),
  requireValidRpcAccessTokenAny(['desktop:view', 'sandbox:ui:view']),
  async (req: any, res: any) => {
    const hostRef = req.params.hostRef
    if (await enforceLegacySessionAdmission(req, res, legacySessionAdmissionBucketKey(hostRef))) {
      res.status(204).end()
    }
  }
)
