import { type NextFunction, type Request, type Response, Router } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { config } from '../config.js'
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
/** A Desktop sign-in code: 32 random bytes, base64url. */
export const DESKTOP_SIGN_IN_CODE_RE = /^[A-Za-z0-9_-]{43}$/
/** An S256 PKCE challenge: a SHA-256 digest, base64url. */
const DESKTOP_CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
/**
 * An invitation token from the member registration hub. The hub makes its tokens in another
 * repository, so only printable ASCII and a length are pinned, as control-api pins them.
 */
const INVITATION_TOKEN_RE = /^[\x21-\x7e]{1,2048}$/
/** A code lives 90 s. A lifetime over 120 s is an upstream contract break. */
const DESKTOP_SIGN_IN_CODE_MAX_TTL_SECONDS = 120
/**
 * Refusal reasons /complete relays to Profile UI. Anything else is an upstream contract break.
 * `invitation_email_mismatch` comes only from an invitation sign-in: an attempt is never both
 * for Desktop and from an invitation (design §9). Desktop sign-in redeem relays its own set,
 * Desktop's eight reasons (DESKTOP_SIGN_IN_REFUSAL_REASONS in oidcDesktopSignIn.ts).
 */
const REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
  'invitation_email_mismatch',
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
  'desktop_sign_in_unavailable',
])

type SafeFailure = Readonly<{ error: string; retrySameAttempt?: boolean }>

function forwardFailure(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError) {
    const body = error.body as Partial<SafeFailure> | null
    const safeCode =
      typeof body?.error === 'string' && SAFE_ERRORS.has(body.error)
        ? body.error
        : 'oidc_unavailable'
    // 409 means "Desktop sign-in is off here" and nothing else; any other 409 is an outage.
    const status =
      [400, 404, 429, 503].includes(error.status) ||
      (error.status === 409 && safeCode === 'desktop_sign_in_unavailable')
        ? error.status
        : 503
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
 * One bucket per client IP, for a browser and for Desktop's sign-in redeem and methods calls:
 * the forwarded IP (`req.ip` under `trust proxy 1`), falling back to the socket address. An
 * IPv6 address shares a bucket with the rest of its /56, so a holder of a prefix cannot rotate
 * addresses inside it. No request header chooses the key.
 */
export function clientRateKey(req: Request): string {
  return `ip:${ipKeyGenerator(connectionKey(req))}`
}

type DesktopSignInField =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'present'; codeChallenge: string }>

/**
 * `desktopSignIn` is absent, or an object whose only key is a well-formed `codeChallenge`.
 * Anything else, `null` included, is invalid, so a malformed Desktop request is never
 * forwarded as a plain Profile attempt.
 */
function desktopSignInField(value: unknown): DesktopSignInField {
  if (value === undefined) return { status: 'absent' }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'invalid' }
  }
  const keys = Object.keys(value)
  const codeChallenge = (value as { codeChallenge?: unknown }).codeChallenge
  if (
    keys.length !== 1 ||
    keys[0] !== 'codeChallenge' ||
    typeof codeChallenge !== 'string' ||
    !DESKTOP_CODE_CHALLENGE_RE.test(codeChallenge)
  ) {
    return { status: 'invalid' }
  }
  return { status: 'present', codeChallenge }
}

type InvitationTokenField =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'present'; invitationToken: string }>

/**
 * `invitationToken` is absent, or a string matching INVITATION_TOKEN_RE. Anything else, `null`
 * included, is invalid, so a malformed invitation request is never forwarded as a plain
 * attempt. The token is never logged.
 */
function invitationTokenField(value: unknown): InvitationTokenField {
  if (value === undefined) return { status: 'absent' }
  return typeof value === 'string' && INVITATION_TOKEN_RE.test(value)
    ? { status: 'present', invitationToken: value }
    : { status: 'invalid' }
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
    const desktopSignIn = desktopSignInField(req.body?.desktopSignIn)
    const invitation = invitationTokenField(req.body?.invitationToken)
    if (
      typeof browserBinding !== 'string' ||
      !BINDING_RE.test(browserBinding) ||
      desktopSignIn.status === 'invalid' ||
      invitation.status === 'invalid'
    ) {
      res.status(400).json({ error: 'invalid_oidc_attempt' })
      return
    }
    try {
      const { data } = await controlApiRequestWithStatus<{
        authorizationUrl: string
        expiresAt: string
        signInContext?: unknown
      }>('POST', '/external/oidc/profile-flow/attempts', {
        // Both fields together are forwarded as they are: control-api owns the rule that an
        // attempt is never both for Desktop and from an invitation, and answers its 400.
        body: {
          browserBinding,
          ...(desktopSignIn.status === 'present'
            ? { desktopSignIn: { codeChallenge: desktopSignIn.codeChallenge } }
            : {}),
          ...(invitation.status === 'present'
            ? { invitationToken: invitation.invitationToken }
            : {}),
        },
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
      // The echo tells Profile UI that control-api stored the Desktop context. Without it, a
      // Desktop request reached a control-api that started a plain attempt.
      res.status(200).json({
        authorizationUrl: data.authorizationUrl,
        expiresAt: data.expiresAt,
        ...(data.signInContext === 'desktop_sign_in' ? { signInContext: 'desktop_sign_in' } : {}),
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
        | {
            outcome: 'desktop_code_issued'
            memberAuthenticationActivated: true
            code: string
            expiresInSeconds: number
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
      if (
        data?.outcome === 'desktop_code_issued' &&
        data.memberAuthenticationActivated === true &&
        typeof data.code === 'string' &&
        DESKTOP_SIGN_IN_CODE_RE.test(data.code) &&
        Number.isInteger(data.expiresInSeconds) &&
        data.expiresInSeconds >= 1 &&
        data.expiresInSeconds <= DESKTOP_SIGN_IN_CODE_MAX_TTL_SECONDS
      ) {
        // No session cookie: Desktop redeems the code for its own session. `environment` is
        // this edge's own URL, never a value from control-api: Desktop refuses a code whose
        // environment is not the one it started the sign-in with.
        res.status(200).json({
          outcome: 'desktop_code_issued',
          memberAuthenticationActivated: true,
          code: data.code,
          expiresInSeconds: data.expiresInSeconds,
          environment: config.publicBaseUrl,
        })
        return
      }
      // control-api has already consumed the attempt, so retrying it cannot succeed.
      res.status(503).json({ error: 'oidc_unavailable', retrySameAttempt: false })
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
