import { Router } from 'express'
import {
  ControlApiError,
  type ControlApiFailureLogFields,
  UNUSABLE_CONTROL_API_ANSWER,
  controlApiFailureLogFields,
  controlApiRequestWithStatus,
} from '../controlApiClient.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import { clientRateKey } from './oidcProfileFlow.js'

/** The sign-in method names Desktop knows. Any other name is dropped. */
const METHOD_NAMES: ReadonlySet<string> = new Set(['password', 'oidc'])
const LABEL_MAX_LENGTH = 80
const SIGN_IN_URL_MAX_LENGTH = 2048
/** Reads per minute for one client (forwarded IP). */
const METHODS_PER_CLIENT_LIMIT = 60
const CACHE_TTL_MS = 30_000

type OidcMethod = Readonly<{ label: string; signInUrl: string }>
type MethodsAnswer = Readonly<{ methods: readonly string[]; oidc?: OidcMethod }>

/**
 * Logs one `503 methods_unavailable`. Nothing else would: control-api never saw a request the
 * edge could not deliver, the funnel's non-JSON 502 is not control-api's own answer, and an edge
 * defect is the edge's. This service has no structured logger, so this is the console line
 * gfsWatch writes. Only the class and the upstream status are written: a message embeds the
 * control-api path and upstream error text.
 */
function logMethodsUnavailable(fields: ControlApiFailureLogFields): void {
  console.error(JSON.stringify({ msg: 'auth methods answered 503', ...fields }))
}

/** `oidc` as exactly `{ label, signInUrl }`, or nothing when either field breaks its bounds. */
function usableOidc(value: unknown): OidcMethod | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { label, signInUrl } = value as { label?: unknown; signInUrl?: unknown }
  if (
    typeof label !== 'string' ||
    label.length < 1 ||
    label.length > LABEL_MAX_LENGTH ||
    typeof signInUrl !== 'string' ||
    signInUrl.length < 1 ||
    signInUrl.length > SIGN_IN_URL_MAX_LENGTH
  ) {
    return undefined
  }
  return { label, signInUrl }
}

/** The answer rebuilt from control-api's 200, or nothing when `methods` is not a list. */
function rebuildMethods(data: unknown): MethodsAnswer | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { methods, oidc } = data as { methods?: unknown; oidc?: unknown }
  if (!Array.isArray(methods)) return undefined
  const known = methods.filter(
    (name): name is string => typeof name === 'string' && METHOD_NAMES.has(name)
  )
  const usable = usableOidc(oidc)
  return { methods: known, ...(usable ? { oidc: usable } : {}) }
}

/**
 * `GET /auth/methods`: which sign-in methods Desktop offers. Public. A rebuilt 200 is cached
 * for 30 s as one answer for the whole environment; nothing else is cached. control-api's 404
 * (a control-api older than the route) stays a 404, and anything else is
 * `503 methods_unavailable`, never a default list.
 */
export function createAuthMethodsRouter(): Router {
  const router = Router()
  // On the route itself: the router is mounted without a path, so a bare `router.use` would
  // count every later /api/v1 request against this budget.
  const perClient = createRateLimiter({
    windowMs: 60_000,
    maxRequests: METHODS_PER_CLIENT_LIMIT,
    keyFn: clientRateKey,
    errorCode: 'rate_limited',
  })
  // One answer per router instance, keyed by nothing a client sends.
  let cached: Readonly<{ answer: MethodsAnswer; expiresAt: number }> | undefined

  router.get('/auth/methods', perClient, async (_req, res) => {
    if (cached && Date.now() < cached.expiresAt) {
      res.status(200).json(cached.answer)
      return
    }
    try {
      const { data, status } = await controlApiRequestWithStatus<unknown>(
        'GET',
        '/external/auth/methods'
      )
      const answer = status === 200 ? rebuildMethods(data) : undefined
      if (!answer) {
        // A 2xx that is not a usable 200 carries no error object: the status only.
        logMethodsUnavailable({ error: UNUSABLE_CONTROL_API_ANSWER, upstreamStatus: status })
        res.status(503).json({ error: 'methods_unavailable' })
        return
      }
      cached = { answer, expiresAt: Date.now() + CACHE_TTL_MS }
      res.status(200).json(answer)
    } catch (error) {
      if (error instanceof ControlApiError && error.status === 404) {
        res.status(404).json({ error: 'Not Found' })
        return
      }
      // Not forwarded to the global handler, which would answer 500 or relay control-api's
      // body: any other failure, an unreachable control-api included, is the contract's 503
      // row, and Desktop offers Retry. The global handler would not log it either, so it is
      // logged here by class (logMethodsUnavailable).
      logMethodsUnavailable(controlApiFailureLogFields(error))
      res.status(503).json({ error: 'methods_unavailable' })
    }
  })

  return router
}
