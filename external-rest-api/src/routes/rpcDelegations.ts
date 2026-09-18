import { Router } from 'express'
import {
  sanitizeControlApiPublicError,
  sendPublicApiError,
  sendSanitizedControlApiPublicError,
} from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { issueRpcDelegationV2 } from '../services/rpcDelegationService.js'

const RPC_DELEGATION_PUBLIC_STATUSES = new Set([400, 403, 404, 409, 429, 503])
const ACCESS_PATH_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/
const AUTHORIZATION_REVISION_PATTERN = /^ar1_[A-Za-z0-9_-]{43}$/

function boundedClientVersion(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized && normalized.length <= 128 ? normalized : undefined
}

export function createRpcDelegationsRouter(): Router {
  const router = Router()

  router.post('/rpc/delegations', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      if (!sessionToken) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const accessPathId = req.header('x-evenfire-access-path-id')
      const authorizationRevision = req.header('x-evenfire-authorization-revision')
      if (
        (accessPathId !== undefined && !ACCESS_PATH_PATTERN.test(accessPathId)) ||
        (authorizationRevision !== undefined &&
          !AUTHORIZATION_REVISION_PATTERN.test(authorizationRevision))
      ) {
        sendPublicApiError(req, res, 400, 'invalid_request', 'The request is not valid.')
        return
      }
      const result = await issueRpcDelegationV2({
        sessionToken,
        requestBody: req.body,
        clientIp: req.ip,
        clientVersion: boundedClientVersion(req.header('x-evenfire-client-version')),
        accessPathId,
        authorizationRevision,
      })
      res.status(200).json(result)
    } catch (error) {
      const sanitized = sanitizeControlApiPublicError(error, RPC_DELEGATION_PUBLIC_STATUSES)
      if (sanitized) {
        sendSanitizedControlApiPublicError(res, sanitized)
        return
      }
      next(error)
    }
  })

  return router
}
