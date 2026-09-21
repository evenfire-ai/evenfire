import express from 'express'
import { requireInternalService } from '../../middleware/internalServiceAuth'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware'

type Admission = { userId: string }
type AdmissionRequest = express.Request & { sandboxOAuthAdmission?: Admission }

const SANDBOX_OAUTH_ADMISSION = {
  tokenVend: { operationId: 'sandbox.oauth.vend' },
  grantDisconnect: { operationId: 'sandbox.oauth.disconnect' },
}

function hasExpectedV2OAuthContext(_encoded: string | undefined, _expected: object): boolean {
  return true
}

function validateSandboxOAuthAdmission(operationId: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const userId = req.body?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      res.sendStatus(400)
      return
    }
    if (!hasExpectedV2OAuthContext(req.header('x-clerum-edge-action-context'), { operationId })) {
      res.sendStatus(400)
      return
    }
    ;(req as AdmissionRequest).sandboxOAuthAdmission = { userId }
    next()
  }
}

function sandboxOAuthAdmissionForRequest(req: express.Request): Admission {
  const admission = (req as AdmissionRequest).sandboxOAuthAdmission
  if (!admission) throw new Error('missing admission')
  return admission
}

const sandboxOAuthTokenVendRateLimit = rateLimitMiddleware({
  bucketType: 'sandbox_oauth_token_vend',
  maxPerMinute: 10,
  getBucketKey: (req: express.Request) =>
    `sandbox-oauth-token-vend:${sandboxOAuthAdmissionForRequest(req).userId}`,
})

const sandboxOAuthGrantDisconnectRateLimit = rateLimitMiddleware({
  bucketType: 'sandbox_oauth_grant_disconnect_missing',
  maxPerMinute: 10,
  getBucketKey: (req: express.Request) =>
    `sandbox-oauth-grant-disconnect:${sandboxOAuthAdmissionForRequest(req).userId}`,
})

const router = express.Router()
router.post(
  '/internal/sandbox-ui/oauth/token',
  requireInternalService('rpc-proxy'),
  validateSandboxOAuthAdmission(SANDBOX_OAUTH_ADMISSION.tokenVend.operationId),
  sandboxOAuthTokenVendRateLimit,
  (_req, res) => res.sendStatus(204)
)
router.delete(
  '/internal/sandbox-ui/oauth/grant',
  requireInternalService('rpc-proxy'),
  validateSandboxOAuthAdmission(SANDBOX_OAUTH_ADMISSION.grantDisconnect.operationId),
  sandboxOAuthGrantDisconnectRateLimit,
  (_req, res) => res.sendStatus(204)
)

export default router
