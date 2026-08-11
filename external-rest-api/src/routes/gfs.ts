import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import type { Request } from 'express'
import { rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ControlApiError, controlApiRequest, controlApiStreamRequest } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

/**
 * End-user gfs (Global File System) surface — the user side of the delegation UI
 * (Desktop / profile). Pure passthrough on the Session-JWT plane: every route
 * requires the user session (requireAuth) and forwards to control-api
 * `/external/gfs/*` with the user session token. No auth is invented here — the
 * control-api side mints/verifies via the existing JWT scheme. Mirrors
 * `routes/contextSharedFilesystems.ts` + `routes/rpc.ts`.
 */

// 5xx included so control-api's gfsc failure codes reach the desktop verbatim:
// 504 gfsc_timeout, 502 gfsc_unreachable, plus 500/503 forwarded from gfsc. Without
// them forwardControlApiError falls through to the global handler, which collapses
// every 5xx to a generic 500 and the documented codes become unobservable at the
// client (a wedged gfsc looks identical to an internal bug).
const PROPAGATED = new Set([400, 401, 403, 404, 409, 410, 412, 422, 429, 500, 502, 503, 504])
const STREAM_HEADERS = ['content-type', 'content-length', 'content-disposition']
const CONTROL_API_ERROR_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
] as const
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Approved GFS source-IP boundary; control-api adds the class-specific
// per-session/IP/effective-actor 10/30 limits after this public edge.
const EXTERNAL_GFS_INGRESS_LIMIT_PER_MIN = 30

type GfsAuthedRequest = AuthedRequest & { gfsRequestId?: string }
type GfsRequestOptions = {
  query?: Record<string, string | undefined>
  body?: unknown
  userSessionToken?: string
  extraHeaders?: Record<string, string>
}

function attachGfsRequestId(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header('x-request-id')?.trim()
  const requestId = raw && UUID_ANY_RE.test(raw) ? raw.toLowerCase() : randomUUID()
  ;(req as GfsAuthedRequest).gfsRequestId = requestId
  res.setHeader('x-request-id', requestId)
  next()
}

function withGfsRequestId(req: GfsAuthedRequest, options: GfsRequestOptions): GfsRequestOptions {
  // The control-api is behind profile-control-funnel, which appends its own
  // peer to X-Forwarded-For. Preserve the external-rest API's proxy-attested
  // client address as the first value so the control-api's pre-resolution
  // limiter can enforce its approved per-source-IP bucket. This overwrites
  // any caller-supplied value; only req.ip (after this service's trust-proxy
  // policy) is propagated across the authenticated service boundary.
  const clientIp = req.ip?.trim()
  const forwardedClientIp = clientIp && isIP(clientIp) !== 0 ? clientIp : undefined
  return {
    ...options,
    extraHeaders: {
      ...options.extraHeaders,
      'x-request-id': req.gfsRequestId!,
      ...(forwardedClientIp ? { 'x-forwarded-for': forwardedClientIp } : {}),
    },
  }
}

function gfsControlApiRequest<T>(
  req: GfsAuthedRequest,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: GfsRequestOptions
): Promise<T> {
  return controlApiRequest<T>(method, path, withGfsRequestId(req, options))
}

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && PROPAGATED.has(error.status)) {
    // The internal client has already filtered this map. Keep the allowlist at
    // this last hop too so a hand-constructed/mocked ControlApiError cannot
    // accidentally turn arbitrary internal response headers into public ones.
    for (const name of CONTROL_API_ERROR_HEADERS) {
      const value = error.headers?.[name]
      if (value) res.setHeader(name, value)
    }
    const body =
      error.body && typeof error.body === 'object' ? error.body : { error: String(error.message) }
    res.status(error.status).json(body)
    return
  }
  next(error)
}

export function createGfsRouter(): Router {
  const router = Router()

  // Keep a direct, recognised edge guard at this service as well as the
  // cross-replica control-api buckets. It runs before JWT work and prevents a
  // client from using the proxy hop to make auth or downstream requests
  // unbounded. Headers remain owned by control-api's durable limiter.
  router.use(
    '/me/gfs',
    rateLimit({
      windowMs: 60_000,
      limit: EXTERNAL_GFS_INGRESS_LIMIT_PER_MIN,
      standardHeaders: false,
      legacyHeaders: false,
      message: { error: 'Too Many Requests' },
    }),
    attachGfsRequestId,
    requireAuth
  )

  router.post('/me/gfs/token', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'POST', '/external/gfs/token', {
        userSessionToken: extractAuthToken(req),
        body: req.body ?? {},
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resolve', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'GET', '/external/gfs/resolve', {
        userSessionToken: extractAuthToken(req),
        query: { uri: typeof req.query.uri === 'string' ? req.query.uri : undefined },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resources', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'GET', '/external/gfs/resources', {
        userSessionToken: extractAuthToken(req),
        query: {
          drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resources/:id/children', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'GET',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/children`,
        {
          userSessionToken: extractAuthToken(req),
          query: {
            drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
            limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
            cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          },
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resources/:id/affordances', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'GET',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/affordances`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.patch('/me/gfs/resources/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'PATCH',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.post('/me/gfs/resources/:id/children', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'POST',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/children`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(201).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.put('/me/gfs/resources/:id/content', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'PUT',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/content`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.delete('/me/gfs/resources/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'DELETE',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/proxy/:rid', async (req: AuthedRequest, res, next) => {
    try {
      const upstream = await controlApiStreamRequest(
        'GET',
        `/external/gfs/proxy/${encodeURIComponent(req.params.rid)}`,
        withGfsRequestId(req, {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
        })
      )
      res.status(upstream.status)
      for (const header of STREAM_HEADERS) {
        const value = upstream.headers.get(header)
        if (value) res.setHeader(header, value)
      }
      if (!upstream.body) {
        res.end()
        return
      }
      await pipeline(
        Readable.fromWeb(
          upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
        ),
        res
      )
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  // Delegation (folder-owner): grant/share as the user. control-api's
  // assertMayGrant enforces no-escalation against the user's own held bits.
  // The grants list requires manage_acl on the resource (view-ACL = manage-ACL,
  // enforced by control-api's handleGrantListForCaller); its item `id` is what
  // powers per-row revoke in the Manage modal.
  router.get('/me/gfs/grants', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'GET', '/external/gfs/grants', {
        userSessionToken: extractAuthToken(req),
        query: {
          drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
          resourceId: typeof req.query.resourceId === 'string' ? req.query.resourceId : undefined,
        },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.put('/me/gfs/grants', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'PUT', '/external/gfs/grants', {
        userSessionToken: extractAuthToken(req),
        body: req.body ?? {},
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.delete('/me/gfs/grants/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'DELETE',
        `/external/gfs/grants/${encodeURIComponent(req.params.id)}`,
        { userSessionToken: extractAuthToken(req) }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.post('/me/gfs/shares', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'POST', '/external/gfs/shares', {
        userSessionToken: extractAuthToken(req),
        body: req.body ?? {},
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/shares', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(req, 'GET', '/external/gfs/shares', {
        userSessionToken: extractAuthToken(req),
        query: {
          drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
          resourceId: typeof req.query.resourceId === 'string' ? req.query.resourceId : undefined,
        },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.delete('/me/gfs/shares/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await gfsControlApiRequest(
        req,
        'DELETE',
        `/external/gfs/shares/${encodeURIComponent(req.params.id)}`,
        { userSessionToken: extractAuthToken(req) }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  return router
}
