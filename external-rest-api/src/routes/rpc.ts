import { Router } from 'express'
import { publicCorrelationId, sanitizeControlApiPublicError } from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { issueRpcAccessToken } from '../services/rpcService.js'

const RPC_PUBLIC_STATUSES = new Set([403])

export function createRpcRouter(): Router {
  const router = Router()

  router.post('/rpc/token', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      if (!sessionToken) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const result = await issueRpcAccessToken(
        sessionToken,
        req.body?.scopes,
        req.body?.hostRefs,
        req.ip
      )
      res.status(200).json(result)
    } catch (error) {
      const sanitized = sanitizeControlApiPublicError(
        error,
        RPC_PUBLIC_STATUSES,
        publicCorrelationId(req)
      )
      if (sanitized) {
        res.status(sanitized.status).json(sanitized.body)
        return
      }
      next(error)
    }
  })

  return router
}
