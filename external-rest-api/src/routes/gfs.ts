import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { type AugmentedRequest, ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.js'
import { controlApiRequest, controlApiStreamRequest } from '../controlApiClient.js'
import {
  publicCorrelationId,
  sanitizeControlApiPublicError,
  sendSanitizedControlApiPublicError,
} from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

type GfsRouterOptions = {
  edgeRequestLimit?: number
  edgeLimits?: ExternalGfsEdgeLimits
}

/**
 * End-user gfs (Global File System) surface — the user side of the delegation UI
 * (Desktop / profile). Pure passthrough on the Session-JWT plane: every route
 * requires the user session (requireAuth) and forwards to control-api
 * `/external/gfs/*` with the user session token. No auth is invented here — the
 * control-api side mints/verifies via the existing JWT scheme. Mirrors
 * `routes/contextSharedFilesystems.ts` + `routes/rpc.ts`.
 */

// 5xx included so control-api's gfsc failure codes reach the desktop verbatim:
// Preserve the GFS transport contract at this boundary. The client retry policy
// distinguishes transient 408/425/5xx responses from terminal 507 storage
// exhaustion, so collapsing an unlisted status into the process-wide 500 handler
// would change the meaning of a writer response. The 4xx allowlist remains
// explicit; every 5xx is safe to forward because it is already a ControlApiError
// produced by the authenticated control-plane request.
const PROPAGATED = new Set([400, 401, 403, 404, 408, 409, 410, 411, 412, 413, 422, 425, 429, 507])
const STREAM_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'location',
  'upload-offset',
  'upload-length',
  'upload-part-bytes',
  'upload-part-count',
  'upload-active-parts',
  'upload-state',
  'upload-expires',
  'upload-part-number',
  'upload-part-offset',
  'upload-part-length',
  'upload-checksum',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-gfs-ratelimit-scope',
]
const CONTROL_API_ERROR_HEADERS = [
  'retry-after',
  'ratelimit',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
] as const
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EXTERNAL_GFS_EDGE_WINDOW_MS = 60_000

function retryAfterSecondsFromHeader(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
  const text = typeof raw === 'string' ? raw.trim() : ''
  const seconds = Number(text)
  if (Number.isSafeInteger(seconds) && seconds > 0) return seconds
  const retryAt = Date.parse(text)
  if (Number.isFinite(retryAt)) return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
  return 1
}

export type ExternalGfsEdgeLimits = {
  aggregatePerMin: number
  authenticatedIpPerMin: number
  tokenIpPerMin: number
}

/**
 * Derive the coarse edge backstop from the number of users expected to share
 * one trusted proxy address. The values deliberately scale the edge only:
 * Control API PG buckets still enforce the 10/min token and 30/min
 * session/actor product budgets across replicas.
 */
const DEFAULT_EXTERNAL_GFS_EDGE_LIMITS: ExternalGfsEdgeLimits = {
  aggregatePerMin: config.externalGfsEdgeAggregateRlPerMin,
  authenticatedIpPerMin: config.externalGfsEdgeAuthenticatedIpRlPerMin,
  tokenIpPerMin: config.externalGfsEdgeTokenIpRlPerMin,
}

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
  const statuses =
    error instanceof Error &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number' &&
    (error as { status: number }).status >= 500 &&
    (error as { status: number }).status <= 599
      ? new Set([...PROPAGATED, (error as { status: number }).status])
      : PROPAGATED
  const sanitized = sanitizeControlApiPublicError(error, statuses, publicCorrelationId(res.req))
  if (sanitized) {
    sendSanitizedControlApiPublicError(res, sanitized)
    return
  }
  next(error)
}

export function createGfsRouter(options: GfsRouterOptions = {}): Router {
  const router = Router()
  const edgeLimits = options?.edgeLimits ?? DEFAULT_EXTERNAL_GFS_EDGE_LIMITS

  const edgeLimiter = (
    limit: number,
    bucket: string,
    options?: { keyGenerator?: (req: Request) => string }
  ) =>
    rateLimit({
      windowMs: EXTERNAL_GFS_EDGE_WINDOW_MS,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      identifier: `gfs-edge-${bucket}`,
      ...(options?.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
      handler: (_req, res) => {
        const retryAfterSeconds = retryAfterSecondsFromHeader(res.getHeader('Retry-After'))
        res.status(429).json({
          error: 'Too Many Requests',
          rateLimitLayer: 'external-rest-edge',
          rateLimitBucket: bucket,
          retryAfterSeconds,
        })
      },
    })

  // Keep direct, recognised edge guards at this service as well as the
  // cross-replica Control API buckets. They run before JWT work and prevent a
  // client from using the proxy hop to make auth or downstream requests
  // unbounded. The aggregate and authenticated class buckets are deliberately
  // sized for a shared NAT address; the token bucket remains tighter. The
  // narrower buckets run first so their rejected requests do not consume
  // broader capacity. The Control API owns the authoritative per-user/session/
  // actor budgets.
  router.use('/me/gfs', attachGfsRequestId)
  router.use('/me/gfs/token', edgeLimiter(edgeLimits.tokenIpPerMin, 'token-ip'))
  router.use('/me/gfs', edgeLimiter(edgeLimits.authenticatedIpPerMin, 'authenticated-ip'))
  router.use(
    '/me/gfs',
    edgeLimiter(edgeLimits.aggregatePerMin, 'aggregate-ip', {
      // This is intentionally a process-wide backstop, not another per-IP
      // bucket. The authenticated-IP limiter above owns client fairness;
      // keeping a constant key makes distributed source-IP floods observable
      // at this edge instead of allowing the aggregate budget to be bypassed.
      keyGenerator: () => 'gfs-edge-aggregate',
    })
  )
  router.use('/me/gfs', requireAuth)

  // Coarse per-process guard for the public Express edge (and a CodeQL-visible
  // middleware on every new route). The authoritative replica-safe request,
  // weighted-byte, and active-request budgets are enforced again in
  // control-api with PostgreSQL before GFSC body forwarding.
  const edgeRequestLimit = options.edgeRequestLimit ?? config.gfsUploadRequestPerMinute
  const uploadEdgeRateLimit = rateLimit({
    windowMs: 60_000,
    limit: edgeRequestLimit,
    legacyHeaders: false,
    standardHeaders: false,
    skipFailedRequests: false,
    skipSuccessfulRequests: false,
    passOnStoreError: true,
    keyGenerator: request => {
      const req = request as AuthedRequest
      const sourceIp = req.ip || req.socket.remoteAddress || 'unknown'
      const normalizedIp = sourceIp === 'unknown' ? sourceIp : ipKeyGenerator(sourceIp)
      return `${req.auth?.userId || '__no_user__'}:${normalizedIp}`
    },
    handler: (request, res, _next, optionsUsed) => {
      const info = (request as AugmentedRequest).rateLimit
      const resetAt = info?.resetTime?.getTime() ?? Date.now() + optionsUsed.windowMs
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.setHeader('X-RateLimit-Limit', String(info?.limit ?? edgeRequestLimit))
      res.setHeader('X-GFS-RateLimit-Scope', 'public_edge_requests')
      res.setHeader('X-RateLimit-Remaining', '0')
      res.status(429).json({
        error: 'gfs_upload_rate_limited',
        limit: 'public_edge_requests',
        retryAfterSeconds,
      })
    },
  })

  // Resumable v2 relay. JSON lifecycle calls remain bounded metadata requests;
  // a part PUT passes the IncomingMessage directly to control-api so neither
  // external-rest-api nor control-api materializes the part in memory.
  router.get('/me/gfs/capabilities', uploadEdgeRateLimit, (req: AuthedRequest, res, next) => {
    void proxyUploadStream(req, res, next, 'GET', '/external/gfs/capabilities')
  })
  router.post('/me/gfs/uploads', uploadEdgeRateLimit, (req: AuthedRequest, res, next) => {
    void proxyUploadStream(req, res, next, 'POST', '/external/gfs/uploads')
  })
  router.head('/me/gfs/uploads/:id', uploadEdgeRateLimit, (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'HEAD',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}`
    )
  })
  router.get('/me/gfs/uploads/:id/status', uploadEdgeRateLimit, (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'GET',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}/status`
    )
  })
  router.put(
    '/me/gfs/uploads/:id/parts/:part',
    uploadEdgeRateLimit,
    (req: AuthedRequest, res, next) => {
      void proxyUploadStream(
        req,
        res,
        next,
        'PUT',
        `/external/gfs/uploads/${encodeURIComponent(req.params.id)}/parts/${encodeURIComponent(req.params.part)}`
      )
    }
  )
  for (const action of ['pause', 'resume', 'complete'] as const) {
    router.post(
      `/me/gfs/uploads/:id/${action}`,
      uploadEdgeRateLimit,
      (req: AuthedRequest, res, next) => {
        void proxyUploadStream(
          req,
          res,
          next,
          'POST',
          `/external/gfs/uploads/${encodeURIComponent(req.params.id)}/${action}`
        )
      }
    )
  }
  router.delete('/me/gfs/uploads/:id', uploadEdgeRateLimit, (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'DELETE',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}`
    )
  })

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

async function proxyUploadStream(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE',
  path: string
): Promise<void> {
  try {
    const extraHeaders: Record<string, string> = {}
    for (const name of [
      'content-type',
      'upload-part-number',
      'upload-offset',
      'upload-chunk-length',
      'upload-checksum',
    ]) {
      const value = req.headers[name]
      if (typeof value === 'string') extraHeaders[name] = value
    }
    const isPart = method === 'PUT' && /\/parts\/[0-9]+$/.test(path)
    if (isPart) {
      const contentLength = String(req.headers['content-length'] || '')
      const chunkLength = String(req.headers['upload-chunk-length'] || '')
      if (!/^[0-9]+$/.test(contentLength) || !/^[0-9]+$/.test(chunkLength)) {
        res.status(411).json({ error: 'upload_content_length_required' })
        return
      }
      const declaredBytes = Number(contentLength)
      if (
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 1 ||
        declaredBytes > config.gfsUploadMaxPartBytes
      ) {
        res.status(413).json({ error: 'payload_too_large' })
        return
      }
      if (Number(chunkLength) !== declaredBytes) {
        res.status(400).json({ error: 'upload_length_mismatch' })
        return
      }
      extraHeaders['content-length'] = contentLength
    }
    extraHeaders['x-gfs-upload-source-ip'] = req.ip || req.socket.remoteAddress || 'unknown'
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : isPart
          ? req
          : JSON.stringify(req.body ?? {})
    const upstream = await controlApiStreamRequest(method, path, {
      userSessionToken: extractAuthToken(req),
      // Preserve the bounded status cursor contract across the relay.  Dropping
      // these query parameters makes every resume request fetch page one and
      // can silently truncate a session with more than 256 parts.
      query: {
        // Drive syntax, body/query agreement, ownership, and authorization are
        // validated once by control-api before admission/token minting. The
        // relay must not make a security decision from a user-controlled drive
        // value or maintain a second, divergent drive policy.
        drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
        limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      },
      extraHeaders,
      body,
    })
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
}
