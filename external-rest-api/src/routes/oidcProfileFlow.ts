import { type NextFunction, type Response, Router } from 'express'
import { ControlApiError, controlApiRequestWithStatus } from '../controlApiClient.js'
import { createRateLimiter } from '../middleware/rateLimit.js'

const BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
const CODE_RE = /^[\x21-\x7e]{1,4096}$/
const SAFE_ERRORS = new Set([
  'oidc_not_configured',
  'oidc_attempt_rejected',
  'invalid_oidc_attempt',
  'oidc_configuration_unavailable',
  'oidc_provider_unavailable',
  'oidc_provider_incompatible',
  'oidc_storage_unavailable',
  'oidc_operation_cancelled',
  'oidc_unavailable',
])

type SafeFailure = Readonly<{ error: string }>

function forwardFailure(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError) {
    const body = error.body as Partial<SafeFailure> | null
    const safeCode =
      typeof body?.error === 'string' && SAFE_ERRORS.has(body.error)
        ? body.error
        : 'oidc_unavailable'
    const status = [400, 404, 503].includes(error.status) ? error.status : 503
    res.status(status).json({ error: safeCode })
    return
  }
  next(error)
}

export function createOidcProfileFlowRouter(): Router {
  const router = Router()
  const limiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 60,
    keyFn: req => req.ip || req.socket.remoteAddress || 'unknown',
  })

  router.get('/oidc/profile-flow/configuration', limiter, async (_req, res, next) => {
    try {
      const { data } = await controlApiRequestWithStatus<{
        redirectUri: string
        memberAuthenticationActivated: false
      }>('GET', '/external/oidc/profile-flow/configuration')
      if (typeof data?.redirectUri !== 'string' || data.memberAuthenticationActivated !== false) {
        res.status(503).json({ error: 'oidc_unavailable' })
        return
      }
      res.status(200).json({
        redirectUri: data.redirectUri,
        memberAuthenticationActivated: false,
      })
    } catch (error) {
      forwardFailure(error, res, next)
    }
  })

  router.post('/oidc/profile-flow/attempts', limiter, async (req, res, next) => {
    const browserBinding = req.body?.browserBinding
    if (typeof browserBinding !== 'string' || !BINDING_RE.test(browserBinding)) {
      res.status(400).json({ error: 'invalid_oidc_attempt' })
      return
    }
    try {
      const { data } = await controlApiRequestWithStatus<{
        authorizationUrl: string
        expiresAt: string
      }>('POST', '/external/oidc/profile-flow/attempts', {
        body: { browserBinding },
      })
      if (
        typeof data?.authorizationUrl !== 'string' ||
        typeof data.expiresAt !== 'string' ||
        data.authorizationUrl.length > 8192 ||
        data.expiresAt.length > 64
      ) {
        res.status(503).json({ error: 'oidc_unavailable' })
        return
      }
      res.status(200).json({
        authorizationUrl: data.authorizationUrl,
        expiresAt: data.expiresAt,
      })
    } catch (error) {
      forwardFailure(error, res, next)
    }
  })

  router.post('/oidc/profile-flow/complete', limiter, async (req, res, next) => {
    const { state, code, browserBinding, issuer } = req.body ?? {}
    if (
      typeof state !== 'string' ||
      !STATE_RE.test(state) ||
      typeof code !== 'string' ||
      !CODE_RE.test(code) ||
      typeof browserBinding !== 'string' ||
      !BINDING_RE.test(browserBinding) ||
      (issuer !== undefined &&
        (typeof issuer !== 'string' || issuer.length === 0 || issuer.length > 2048))
    ) {
      res.status(400).json({ error: 'invalid_oidc_attempt' })
      return
    }
    try {
      const { data } = await controlApiRequestWithStatus<{
        outcome: 'identity_proof_verified'
        memberAuthenticationActivated: false
      }>('POST', '/external/oidc/profile-flow/complete', {
        body: { state, code, browserBinding, ...(issuer !== undefined ? { issuer } : {}) },
      })
      if (
        data?.outcome !== 'identity_proof_verified' ||
        data.memberAuthenticationActivated !== false
      ) {
        res.status(503).json({ error: 'oidc_unavailable' })
        return
      }
      res.status(200).json({
        outcome: 'identity_proof_verified',
        memberAuthenticationActivated: false,
      })
    } catch (error) {
      forwardFailure(error, res, next)
    }
  })

  router.post('/oidc/profile-flow/cancel', limiter, async (req, res, next) => {
    const { state, browserBinding } = req.body ?? {}
    if (
      typeof state !== 'string' ||
      !STATE_RE.test(state) ||
      typeof browserBinding !== 'string' ||
      !BINDING_RE.test(browserBinding)
    ) {
      res.status(400).json({ error: 'invalid_oidc_attempt' })
      return
    }
    try {
      const { data } = await controlApiRequestWithStatus<{ outcome: 'attempt_cancelled' }>(
        'POST',
        '/external/oidc/profile-flow/cancel',
        { body: { state, browserBinding } }
      )
      if (data?.outcome !== 'attempt_cancelled') {
        res.status(503).json({ error: 'oidc_unavailable' })
        return
      }
      res.status(200).json({ outcome: 'attempt_cancelled' })
    } catch (error) {
      forwardFailure(error, res, next)
    }
  })

  return router
}
