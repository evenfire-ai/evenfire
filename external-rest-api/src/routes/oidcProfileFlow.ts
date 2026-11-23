import { type NextFunction, type Request, type Response, Router } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { ControlApiError, controlApiRequestWithStatus } from '../controlApiClient.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import { setProfileSessionCookie } from '../sessionCookie.js'

/** Matches Control API's OIDC operation budget. The fetch waits one extra second so that budget can answer first. */
const OIDC_OPERATION_DEADLINE_MS = 12_000
const OIDC_UPSTREAM_WAIT_MS = OIDC_OPERATION_DEADLINE_MS + 1_000

const BINDING_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{32,512}$/
const CODE_RE = /^[\x21-\x7e]{1,4096}$/
const SESSION_TOKEN_MAX_LENGTH = 4096
const DISPLAY_LABEL_MAX_LENGTH = 80
/** Refusal reasons Profile UI may see. Anything else is an upstream contract break. */
const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
])
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

type SafeFailure = Readonly<{ error: string; retrySameAttempt?: boolean }>

function forwardFailure(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError) {
    const body = error.body as Partial<SafeFailure> | null
    const safeCode =
      typeof body?.error === 'string' && SAFE_ERRORS.has(body.error)
        ? body.error
        : 'oidc_unavailable'
    const status = [400, 404, 429, 503].includes(error.status) ? error.status : 503
    const retryabilityCode =
      safeCode === 'oidc_provider_unavailable' ||
      safeCode === 'oidc_storage_unavailable' ||
      safeCode === 'oidc_operation_cancelled'
    res.status(status).json({
      error: safeCode,
      ...(retryabilityCode && typeof body?.retrySameAttempt === 'boolean'
        ? { retrySameAttempt: body.retrySameAttempt }
        : {}),
    })
    return
  }
  next(error)
}

function connectionKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

/**
 * The directly connected peer (the Profile UI pod). Profile UI forwards the browser IP as
 * X-Forwarded-For, so with `trust proxy 1` req.ip is client-influenced; only the socket
 * address identifies the peer.
 */
function socketKey(req: Request): string {
  return req.socket.remoteAddress || 'unknown'
}

/**
 * One bucket per browser: the forwarded IP (`req.ip` under `trust proxy 1`), falling back to
 * the socket address. An IPv6 address shares a bucket with the rest of its /56, so a holder
 * of a prefix cannot rotate addresses inside it. No request header chooses the key.
 */
function clientRateKey(req: Request): string {
  return `ip:${ipKeyGenerator(connectionKey(req))}`
}

function upstreamCall(req: Request): { signal: AbortSignal; extraHeaders: Record<string, string> } {
  const requested = Number(req.get('x-oidc-operation-deadline-ms'))
  const budget =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, OIDC_OPERATION_DEADLINE_MS)
      : OIDC_OPERATION_DEADLINE_MS
  return {
    signal: AbortSignal.timeout(OIDC_UPSTREAM_WAIT_MS),
    extraHeaders: { 'x-oidc-operation-deadline-ms': String(budget) },
  }
}

/** Requests per minute for one browser (forwarded IP). */
export const OIDC_PER_CLIENT_LIMIT = 60
/**
 * Requests per minute for one directly connected peer (a Profile UI pod). A capacity bound,
 * not a fairness limit: fairness between browsers is the per-client limit. At about three
 * requests per sign-in, 6000 is about 2000 sign-ins per minute per pod. A caller that can
 * choose its own X-Forwarded-For (a deployment with no proxy in front that sets it) can
 * still reach this ceiling.
 */
export const OIDC_PER_SOCKET_LIMIT = 6000

export function createOidcProfileFlowRouter(): Router {
  const router = Router()
  // The per-client limiter runs first, so a request it refuses never counts against the
  // shared per-socket ceiling.
  const perClient = createRateLimiter({
    windowMs: 60_000,
    maxRequests: OIDC_PER_CLIENT_LIMIT,
    keyFn: clientRateKey,
    errorCode: 'oidc_unavailable',
  })
  const perConnection = createRateLimiter({
    windowMs: 60_000,
    maxRequests: OIDC_PER_SOCKET_LIMIT,
    keyFn: req => `edge:${socketKey(req)}`,
    errorCode: 'oidc_unavailable',
  })
  router.use('/oidc/profile-flow', perClient, perConnection)

  router.get('/oidc/profile-flow/configuration', async (req, res, next) => {
    try {
      const { data } = await controlApiRequestWithStatus<{
        redirectUri: string
        memberAuthenticationActivated: boolean
        displayLabel?: unknown
      }>('GET', '/external/oidc/profile-flow/configuration', upstreamCall(req))
      if (
        typeof data?.redirectUri !== 'string' ||
        typeof data.memberAuthenticationActivated !== 'boolean'
      ) {
        res.status(503).json({ error: 'oidc_unavailable' })
        return
      }
      // An edge can deploy before control-api: a missing or invalid label means "no button",
      // not an outage.
      const displayLabel =
        typeof data.displayLabel === 'string' &&
        data.displayLabel.length >= 1 &&
        data.displayLabel.length <= DISPLAY_LABEL_MAX_LENGTH
          ? data.displayLabel
          : undefined
      res.status(200).json({
        redirectUri: data.redirectUri,
        memberAuthenticationActivated: data.memberAuthenticationActivated,
        ...(displayLabel !== undefined ? { displayLabel } : {}),
      })
    } catch (error) {
      forwardFailure(error, res, next)
    }
  })

  router.post('/oidc/profile-flow/attempts', async (req, res, next) => {
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
        ...upstreamCall(req),
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

  router.post('/oidc/profile-flow/complete', async (req, res, next) => {
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
      const { data } = await controlApiRequestWithStatus<
        | { outcome: 'identity_proof_verified'; memberAuthenticationActivated: false }
        | { outcome: 'refused'; memberAuthenticationActivated: true; reason: string }
        | {
            outcome: 'member_signed_in'
            memberAuthenticationActivated: true
            token: string
            sessionContract: string
          }
      >('POST', '/external/oidc/profile-flow/complete', {
        body: { state, code, browserBinding, ...(issuer !== undefined ? { issuer } : {}) },
        ...upstreamCall(req),
      })
      if (
        data?.outcome === 'identity_proof_verified' &&
        data.memberAuthenticationActivated === false
      ) {
        res.status(200).json({
          outcome: 'identity_proof_verified',
          memberAuthenticationActivated: false,
        })
        return
      }
      if (
        data?.outcome === 'refused' &&
        data.memberAuthenticationActivated === true &&
        typeof data.reason === 'string' &&
        REFUSAL_REASONS.has(data.reason)
      ) {
        res.status(200).json({
          outcome: 'refused',
          memberAuthenticationActivated: true,
          reason: data.reason,
        })
        return
      }
      if (
        data?.outcome === 'member_signed_in' &&
        data.memberAuthenticationActivated === true &&
        typeof data.token === 'string' &&
        data.token.length > 0 &&
        data.token.length <= SESSION_TOKEN_MAX_LENGTH
      ) {
        // The same cookie password login sets. The token stays out of the body; Profile UI
        // relays this Set-Cookie header to the browser.
        setProfileSessionCookie(req, res, data.token)
        res.status(200).json({
          outcome: 'member_signed_in',
          memberAuthenticationActivated: true,
        })
        return
      }
      res.status(503).json({ error: 'oidc_unavailable' })
    } catch (error) {
      forwardFailure(error, res, next)
    }
  })

  router.post('/oidc/profile-flow/cancel', async (req, res, next) => {
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
        { body: { state, browserBinding }, ...upstreamCall(req) }
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
