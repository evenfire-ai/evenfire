import type { NextFunction, Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { config } from '../config.js'
import type { ExternalGfsAuthority } from '../gfs/externalAuthority.js'
import { rootLogger } from '../observability/logger.js'
import {
  externalGfsRateLimitDurationSeconds,
  externalGfsRateLimitRequestsTotal,
} from '../observability/metrics.js'
import { type RateLimitCheck, checkAndIncrement } from '../services/rateLimiterService.js'

/**
 * The external Desktop GFS surface has a small, explicit operation matrix.
 * Keeping the classifier here makes a newly added handler fail review/tests
 * until it is assigned to a bounded class; there is no route-level default
 * that can silently bypass the authority-resolution DoS boundary.
 */
export type ExternalGfsOperationClass =
  | 'token'
  | 'resource'
  | 'proxy-read'
  | 'resource-mutation'
  | 'grants'
  | 'shares'

export type ExternalGfsOperation = {
  operationClass: ExternalGfsOperationClass
  route: string
}

type ExternalGfsRateLimitPhase = 'pre-resolution' | 'resolved-operation'
type Bucket = { key: string; maxPerMinute: number }

type ExternalGfsAuthedRequest = Request & {
  externalAuth?: { userId?: string }
  gfsAuthority?: ExternalGfsAuthority
}

const GFS_PREFIX = '/external/gfs'

function pathWithinExternalGfs(req: Request): string {
  // At this router's middleware layer Express has already removed the route
  // prefix from req.path, while req.baseUrl retains it. This reconstruction
  // works both when the router is mounted beneath /api/v1 in production and
  // when it is mounted directly in a focused route test.
  const mountedPath = `${req.baseUrl ?? ''}${req.path ?? ''}`
  const marker = mountedPath.lastIndexOf(GFS_PREFIX)
  if (marker >= 0) return mountedPath.slice(marker + GFS_PREFIX.length) || '/'

  const originalPath = String(req.originalUrl ?? '').split('?', 1)[0]
  const originalMarker = originalPath.lastIndexOf(GFS_PREFIX)
  if (originalMarker >= 0) return originalPath.slice(originalMarker + GFS_PREFIX.length) || '/'

  return req.path || '/'
}

/** Map every external GFS handler to exactly one approved rate class. */
export function externalGfsOperationFor(
  req: Pick<Request, 'method' | 'baseUrl' | 'path' | 'originalUrl'>
): ExternalGfsOperation | null {
  const path = pathWithinExternalGfs(req as Request)
  const method = req.method.toUpperCase()

  if (method === 'POST' && path === '/token') {
    return { operationClass: 'token', route: `${GFS_PREFIX}/token` }
  }
  if (path === '/resolve' && method === 'GET') {
    return { operationClass: 'resource', route: `${GFS_PREFIX}/resolve` }
  }
  if (path === '/resources' && method === 'GET') {
    return { operationClass: 'resource', route: `${GFS_PREFIX}/resources` }
  }
  if (/^\/resources\/[^/]+\/affordances$/.test(path) && method === 'GET') {
    return { operationClass: 'resource', route: `${GFS_PREFIX}/resources/:id/affordances` }
  }
  if (/^\/resources\/[^/]+\/children$/.test(path)) {
    return method === 'GET'
      ? { operationClass: 'resource', route: `${GFS_PREFIX}/resources/:id/children` }
      : method === 'POST'
        ? { operationClass: 'resource-mutation', route: `${GFS_PREFIX}/resources/:id/children` }
        : null
  }
  if (/^\/resources\/[^/]+\/content$/.test(path) && method === 'PUT') {
    return { operationClass: 'resource-mutation', route: `${GFS_PREFIX}/resources/:id/content` }
  }
  if (/^\/resources\/[^/]+$/.test(path)) {
    return method === 'PATCH' || method === 'DELETE'
      ? { operationClass: 'resource-mutation', route: `${GFS_PREFIX}/resources/:id` }
      : null
  }
  if (/^\/proxy\/[^/]+$/.test(path) && method === 'GET') {
    return { operationClass: 'proxy-read', route: `${GFS_PREFIX}/proxy/:rid` }
  }
  if (path === '/grants' && (method === 'GET' || method === 'PUT')) {
    return { operationClass: 'grants', route: `${GFS_PREFIX}/grants` }
  }
  if (/^\/grants\/[^/]+$/.test(path) && method === 'DELETE') {
    return { operationClass: 'grants', route: `${GFS_PREFIX}/grants/:id` }
  }
  if (path === '/shares' && (method === 'GET' || method === 'POST')) {
    return { operationClass: 'shares', route: `${GFS_PREFIX}/shares` }
  }
  if (/^\/shares\/[^/]+$/.test(path) && method === 'DELETE') {
    return { operationClass: 'shares', route: `${GFS_PREFIX}/shares/:id` }
  }
  return null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function authenticatedSessionDigest(req: Request): string | null {
  const token = req.header('x-user-session-token')?.trim()
  return token ? digest(token) : null
}

/**
 * Source address forwarded by the authenticated external-rest-api boundary.
 *
 * The first XFF element is accepted only when it is an IP literal. This is
 * intentionally exported for the recognisable edge limiter as well as the
 * durable Postgres buckets below: the two guards must meter the same trusted
 * client identity, never a caller-selected header fragment.
 */
export function externalGfsSourceIp(req: Request): string {
  // The app-level /external gate accepts only the authenticated
  // external-rest-api service. That service overwrites X-Forwarded-For with
  // its proxy-attested client address; profile-control-funnel then appends its
  // pod peer. Read the validated first element so the pre-resolution IP bucket
  // remains per client rather than collapsing every Desktop installation into
  // the funnel's address. Direct/test callers fall back to Express's normal
  // proxy-aware address.
  const forwardedIp = req.header('x-forwarded-for')?.split(',', 1)[0]?.trim()
  const ip =
    forwardedIp && isIP(forwardedIp) !== 0
      ? forwardedIp
      : req.ip || req.socket.remoteAddress || '__unknown_peer__'
  return ip
}

function sourceIpDigest(req: Request): string {
  return digest(externalGfsSourceIp(req))
}

function applyRateLimitHeaders(
  res: Response,
  result: RateLimitCheck,
  maxPerMinute: number
): number {
  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000))
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.setHeader('X-RateLimit-Limit', String(maxPerMinute))
  res.setHeader('X-RateLimit-Remaining', '0')
  res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
  return retryAfterSeconds
}

function applyAllowedRateHeaders(
  res: Response,
  result: RateLimitCheck,
  maxPerMinute: number
): void {
  res.setHeader('X-RateLimit-Limit', String(maxPerMinute))
  res.setHeader('X-RateLimit-Remaining', String(result.remaining))
  res.setHeader('X-RateLimit-Reset', String(Math.floor(result.resetMs / 1000)))
}

function reportDecision(input: {
  bucket: Bucket
  operation: ExternalGfsOperation
  phase: ExternalGfsRateLimitPhase
  outcome: 'allowed' | 'denied'
  latencyMs: number
  authorityResolutionAvoided: boolean
}): void {
  const labels = {
    operation_class: input.operation.operationClass,
    route: input.operation.route,
    outcome: input.outcome,
    phase: input.phase,
    authority_resolution_avoided: input.authorityResolutionAvoided ? 'true' : 'false',
  }
  externalGfsRateLimitRequestsTotal.inc(labels)
  externalGfsRateLimitDurationSeconds.observe(labels, input.latencyMs / 1_000)

  // The hash gives operators a join key for a single limiter identity without
  // exposing session tokens, source IPs, or stable internal IDs in logs.
  const fields = {
    event: 'external_gfs_rate_limit',
    operationClass: input.operation.operationClass,
    route: input.operation.route,
    outcome: input.outcome,
    phase: input.phase,
    hashedKey: digest(input.bucket.key),
    latencyMs: input.latencyMs,
    authorityResolutionAvoided: input.authorityResolutionAvoided,
  }
  if (input.outcome === 'denied') {
    rootLogger.warn(fields, 'external GFS rate limit denied')
  } else {
    rootLogger.debug(fields, 'external GFS rate limit checked')
  }
}

async function enforceBuckets(input: {
  req: Request
  res: Response
  operation: ExternalGfsOperation
  phase: ExternalGfsRateLimitPhase
  buckets: readonly Bucket[]
}): Promise<boolean> {
  for (const bucket of input.buckets) {
    const startedAt = performance.now()
    const result = await checkAndIncrement(bucket.key, bucket.maxPerMinute)
    const latencyMs = performance.now() - startedAt
    const allowed = result.allowed
    reportDecision({
      bucket,
      operation: input.operation,
      phase: input.phase,
      outcome: allowed ? 'allowed' : 'denied',
      latencyMs,
      authorityResolutionAvoided: input.phase === 'pre-resolution' && !allowed,
    })
    if (!allowed) {
      const retryAfterSeconds = applyRateLimitHeaders(input.res, result, bucket.maxPerMinute)
      input.res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds })
      return false
    }
    applyAllowedRateHeaders(input.res, result, bucket.maxPerMinute)
  }
  return true
}

/**
 * First rate gate: runs immediately after the external Session-JWT check and
 * before attachExternalGfsAuthority can touch the link resolver or any
 * authority database path. Token mint intentionally remains user-only, so its
 * stable per-user + per-IP limits are complete at this phase.
 */
export function externalGfsPreResolutionRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void (async () => {
    const operation = externalGfsOperationFor(req)
    if (!operation) {
      // Do not let an unclassified path fall through to the global authority
      // resolver. Besides preserving the ordinary external API 404 shape, this
      // makes the route matrix exhaustive at the authority boundary: a new
      // handler must be classified before it can reach any DB-backed work.
      res.status(404).json({ error: 'Not Found' })
      return
    }
    const externalReq = req as ExternalGfsAuthedRequest
    const desktopUserId = externalReq.externalAuth?.userId
    const sessionDigest = authenticatedSessionDigest(req)
    if (!desktopUserId || !sessionDigest) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const buckets: Bucket[] =
      operation.operationClass === 'token'
        ? [
            {
              key: `gfs-ext:pre:token:user:${desktopUserId}`,
              maxPerMinute: config.externalGfsTokenUserRlPerMin,
            },
            {
              key: `gfs-ext:pre:token:ip:${sourceIpDigest(req)}`,
              maxPerMinute: config.externalGfsIpRlPerMin,
            },
          ]
        : [
            {
              key: `gfs-ext:pre:${operation.operationClass}:session:${sessionDigest}`,
              maxPerMinute: config.externalGfsOperationRlPerMin,
            },
            {
              key: `gfs-ext:pre:${operation.operationClass}:ip:${sourceIpDigest(req)}`,
              maxPerMinute: config.externalGfsOperationRlPerMin,
            },
          ]

    if (await enforceBuckets({ req, res, operation, phase: 'pre-resolution', buckets })) next()
  })().catch(next)
}

/**
 * Second rate gate: runs only after the server-derived authority is attached.
 * It is keyed by the effective actor and operation class, so refreshing or
 * reminting a public user token cannot evade the brokered-operation budget.
 */
export function externalGfsResolvedOperationRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void (async () => {
    const operation = externalGfsOperationFor(req)
    if (!operation || operation.operationClass === 'token') {
      next()
      return
    }
    const authority = (req as ExternalGfsAuthedRequest).gfsAuthority
    if (!authority) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    const bucket: Bucket = {
      key: `gfs-ext:resolved:${operation.operationClass}:actor:${authority.kind}:${authority.tokenSubject}`,
      maxPerMinute: config.externalGfsOperationRlPerMin,
    }
    if (
      await enforceBuckets({
        req,
        res,
        operation,
        phase: 'resolved-operation',
        buckets: [bucket],
      })
    ) {
      next()
    }
  })().catch(next)
}
