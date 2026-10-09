import type { Response } from 'express'
import type { AuthedRequest } from '../middleware/auth.js'
import { extractAuthToken } from '../middleware/auth.js'
import {
  ControlApiHostAccessRejectedError,
  ControlApiHostRpcAdmissionError,
  requestHostRpcAdmission,
} from './controlApiRestService.js'

/**
 * Legacy adapter only. V2 has already consumed the shared budget inside its
 * Control API action-authority checkpoint before route handlers run.
 */
export async function admitLegacyHostRpcRequest(
  req: AuthedRequest,
  res: Response,
  hostRef: string,
  inaccessibleStatus: 403 | 404 = 403
): Promise<boolean> {
  if (req.userDelegationV2) return true
  const auth = req.auth
  if (!auth || !auth.hostRefs.includes(hostRef)) {
    res
      .status(auth ? inaccessibleStatus : 401)
      .json({ error: auth ? 'Forbidden: user cannot access this host' : 'Unauthorized' })
    return false
  }
  try {
    await requestHostRpcAdmission(auth.sub, hostRef, extractAuthToken(req))
    return true
  } catch (error) {
    if (error instanceof ControlApiHostRpcAdmissionError) {
      for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value)
      res.status(error.status).json(error.body)
      return false
    }
    if (error instanceof ControlApiHostAccessRejectedError) {
      res.status(error.status).json({ error: error.status === 401 ? 'Unauthorized' : 'Forbidden' })
      return false
    }
    // Network failures and malformed/missing Control API results are strict
    // denial, never an allow before protected Host work.
    res.status(503).json({ error: 'host_rpc_admission_unavailable' })
    return false
  }
}
