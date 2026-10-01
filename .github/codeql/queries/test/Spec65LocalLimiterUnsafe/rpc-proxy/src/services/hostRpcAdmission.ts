import { extractAuthToken } from '../middleware/auth.js'
import { requestHostRpcAdmission } from './controlApiRestService.js'

export async function admitLegacyHostRpcRequest(
  req: any,
  res: any,
  hostRef: string,
  inaccessibleStatus: number = 403
): Promise<boolean> {
  const auth = req.auth
  if (req.userDelegationV2) return true
  if (!auth || !auth.hostRefs.includes(hostRef)) {
    res.status(auth ? inaccessibleStatus : 401).json({ error: 'Forbidden' })
    return false
  }
  try {
    await requestHostRpcAdmission(auth.sub, hostRef, extractAuthToken(req))
    return true
  } catch (error: any) {
    if (error.status === 503) {
      res.status(503).json({ error: 'host_rpc_admission_unavailable' })
      return false
    }
    if (error.status === 401 || error.status === 403) {
      res.status(error.status).json({ error: 'Forbidden' })
      return false
    }
    res.status(503).json({ error: 'host_rpc_admission_unavailable' })
    return false
  }
}
