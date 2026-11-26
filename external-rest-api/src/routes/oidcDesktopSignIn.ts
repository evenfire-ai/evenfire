import { type Response, Router } from 'express'
import {
  ControlApiError,
  type ControlApiFailureLogFields,
  UNUSABLE_CONTROL_API_ANSWER,
  controlApiFailureLogFields,
  controlApiRequestWithStatus,
} from '../controlApiClient.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import { requestedSessionContract } from './auth.js'
import { DESKTOP_SIGN_IN_CODE_RE, clientRateKey } from './oidcProfileFlow.js'

/** An RFC 7636 code verifier. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/
const SESSION_TOKEN_MAX_LENGTH = 4096
/** Redeems per minute for one client (forwarded IP). */
const REDEEM_PER_CLIENT_LIMIT = 60

/**
 * The refusal reasons redeem relays in its 403: exactly Desktop's closed set
 * (`DESKTOP_LOGIN_REFUSAL_REASONS` in packages/desktop-app-links). A test holds the two equal.
 * Any other reason is the 503 row. This is not /complete's set: that one also carries
 * `invitation_email_mismatch`, which Desktop has no reason for.
 */
export const DESKTOP_SIGN_IN_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'account_disabled',
  'identity_conflict',
  'account_needs_attention',
  'email_claim_missing',
  'email_unverified',
  'not_eligible',
  'no_account',
  'provider_configuration',
])

/** The control-api failures relayed with their own status, each with the one code it may carry. */
const RELAYED_FAILURES: ReadonlyMap<number, string> = new Map([
  [400, 'invalid_desktop_sign_in_code'],
  [409, 'desktop_sign_in_unavailable'],
  [426, 'upgrade_required'],
])

function sendIssuanceUnavailable(res: Response): void {
  res.status(503).json({ error: 'session_issuance_temporarily_unavailable' })
}

/**
 * Logs one generic 503. Nothing else would: control-api never saw a request the edge could not
 * deliver, the funnel's non-JSON 502 is not control-api's own answer, and an edge defect is the
 * edge's. This service has no structured logger, so this is the console line gfsWatch writes.
 * Only the class and the upstream status are written: a message embeds the control-api path and
 * upstream error text, and nothing here may log the code, verifier or token.
 */
function logIssuanceFallback(fields: ControlApiFailureLogFields): void {
  console.error(JSON.stringify({ msg: 'desktop sign-in redeem answered 503', ...fields }))
}

/**
 * Rebuilds a control-api failure from the allow-list. Anything not listed is the 503 row,
 * logged by class and upstream status.
 */
function relayFailure(error: ControlApiError, res: Response): void {
  const code = error.code
  if (code !== null && RELAYED_FAILURES.get(error.status) === code) {
    res.status(error.status).json({ error: code })
    return
  }
  const body = error.body
  const reason =
    body !== null && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined
  if (
    error.status === 403 &&
    code === 'desktop_sign_in_refused' &&
    typeof reason === 'string' &&
    DESKTOP_SIGN_IN_REFUSAL_REASONS.has(reason)
  ) {
    res.status(403).json({ error: 'desktop_sign_in_refused', reason })
    return
  }
  logIssuanceFallback(controlApiFailureLogFields(error))
  sendIssuanceUnavailable(res)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `POST /oidc/desktop-sign-in/redeem`: Desktop's main process trades the one-use code from its
 * browser sign-in, with its PKCE verifier, for the `{ token, me }` password login returns.
 * Every answer is rebuilt from the allow-list in design §7.6; nothing control-api sends is
 * passed through as it came.
 */
export function createOidcDesktopSignInRouter(): Router {
  const router = Router()
  // On the route itself: the router is mounted without a path, so a bare `router.use` would
  // count every later /api/v1 request against this budget.
  const perClient = createRateLimiter({
    windowMs: 60_000,
    maxRequests: REDEEM_PER_CLIENT_LIMIT,
    keyFn: clientRateKey,
    errorCode: 'rate_limited',
  })

  router.post('/oidc/desktop-sign-in/redeem', perClient, async (req, res) => {
    // Hardening, not the boundary: Desktop's main process sends neither header, and a web
    // page has no verifier. The global browser guard already refuses almost every browser
    // request; this also refuses a configured Origin sent with Sec-Fetch-Site: same-site.
    if (req.header('origin') !== undefined || req.header('sec-fetch-site') !== undefined) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    const { code, codeVerifier } = (req.body ?? {}) as { code?: unknown; codeVerifier?: unknown }
    if (
      typeof code !== 'string' ||
      !DESKTOP_SIGN_IN_CODE_RE.test(code) ||
      typeof codeVerifier !== 'string' ||
      !CODE_VERIFIER_RE.test(codeVerifier)
    ) {
      res.status(400).json({ error: 'invalid_desktop_sign_in_code' })
      return
    }
    try {
      const { data, status } = await controlApiRequestWithStatus<{
        token?: unknown
        me?: unknown
      } | null>('POST', '/external/oidc/desktop-sign-in/redeem', {
        body: {
          code,
          codeVerifier,
          ...(requestedSessionContract(req) ? { sessionContract: 'v2' } : {}),
        },
      })
      if (
        status === 200 &&
        typeof data?.token === 'string' &&
        data.token.length >= 1 &&
        data.token.length <= SESSION_TOKEN_MAX_LENGTH &&
        isObject(data.me)
      ) {
        // The token goes in the body and in no cookie: Desktop installs it as its own session.
        // `me` is relayed whole, as password login relays it.
        res.status(200).json({ token: data.token, me: data.me })
        return
      }
      // A 2xx that is not the 200 `{ token, me }` carries no error object: the status only.
      logIssuanceFallback({ error: UNUSABLE_CONTROL_API_ANSWER, upstreamStatus: status })
      sendIssuanceUnavailable(res)
    } catch (error) {
      if (error instanceof ControlApiError) {
        relayFailure(error, res)
        return
      }
      // Not forwarded to the global handler, which would answer 500: an unreachable
      // control-api, or any other failure, is the contract's 503 row. The global handler
      // would not log it either, so it is logged here by class (logIssuanceFallback).
      logIssuanceFallback(controlApiFailureLogFields(error))
      sendIssuanceUnavailable(res)
    }
  })

  return router
}
