import { type NextFunction, Router } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { createHash, randomUUID } from 'node:crypto'
import {
  GFS_DELETE_SCOPE,
  GFS_READ_SCOPE,
  GFS_WRITE_SCOPE,
  signGfsToken,
} from '../../auth/gfsToken.js'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import {
  type ExternalGfsAuthority,
  type RequestWithExternalGfsAuthority,
  attachExternalGfsAuthority,
  attachExternalGfsUserLifecycle,
} from '../../gfs/externalAuthority.js'
import { isValidHostSubjectId, makeHostSubjectId } from '../../gfs/hostSubject.js'
import { DbResolveStore } from '../../gfs/resolve.js'
import {
  DbChildrenStore,
  GfsTreeError,
  clampLimit,
  decodeCursor,
  encodeCursor,
  listChildrenPaged,
} from '../../gfs/tree.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import {
  externalGfsPreResolutionRateLimit,
  externalGfsResolvedOperationRateLimit,
  externalGfsSourceIp,
} from '../../middleware/externalGfsRateLimit.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import { getUserAgents } from '../../services/directory/index.js'
import {
  GfsGrantError,
  UUID_RE,
  driveOf,
  handleGrantDelete,
  handleGrantListForCaller,
  handleGrantWrite,
  heldPermissions,
  resolveCaller,
  sendGfsGrantError,
} from '../gfs/grants.js'
import { handlePatch } from '../gfs/resources.js'
import { handleShareDelete, handleShareListForCaller, handleShareWrite } from '../gfs/shares.js'
import { GFS_DEFAULT_DRIVE, parseRequestedGfsScopes } from '../gfs/token.js'

// A gfs:// URI is `gfs://<drive>/<path-or-rid>`; cap it so an oversized value is
// rejected here, not forwarded to gfsc as an unbounded request.
const MAX_GFS_URI_LEN = 2048
const ACCESSIBLE_RESOURCE_DEFAULT_LIMIT = 100

type ExternalGfsRequest = ExternalAuthedRequest & {
  gfsSubjectKeys?: string[]
  gfsRequestId?: string
  gfsAuthority?: ExternalGfsAuthority
}

const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function attachExternalGfsRequestId(
  req: import('express').Request,
  res: import('express').Response,
  next: NextFunction
): void {
  const raw = req.header('x-request-id')?.trim()
  const requestId =
    raw && UUID_ANY_RE.test(raw)
      ? raw.toLowerCase()
      : ((req as { correlationId?: string }).correlationId ?? randomUUID())
  ;(req as ExternalGfsRequest).gfsRequestId = requestId
  res.setHeader('x-request-id', requestId)
  next()
}

function externalGfsRateKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * These key factories back the recognised in-process edge guards. The durable
 * Postgres limiter remains the source of cross-replica enforcement and emits
 * the public quota headers. These guards are deliberately direct
 * express-rate-limit middleware so CodeQL can prove every external GFS route
 * is bounded before auth, authority resolution, or route-specific work.
 */
function externalGfsIngressRateKey(req: import('express').Request): string {
  return `external-gfs:ingress:${externalGfsRateKey(ipKeyGenerator(externalGfsSourceIp(req)))}`
}

function externalGfsTokenRateKey(req: import('express').Request): string {
  const userId = (req as ExternalGfsRequest).externalAuth?.userId ?? '__missing_user__'
  return `external-gfs:token:user:${externalGfsRateKey(userId)}`
}

function externalGfsActorRateKey(operationClass: string) {
  return (req: import('express').Request): string => {
    const externalReq = req as ExternalGfsRequest
    const authority = externalReq.gfsAuthority
    const actor = authority
      ? `${authority.kind}:${authority.tokenSubject}`
      : `session:${externalReq.externalAuth?.userId ?? '__missing_user__'}`
    return `external-gfs:${operationClass}:actor:${externalGfsRateKey(actor)}`
  }
}

function authorityOf(req: ExternalGfsRequest): ExternalGfsAuthority {
  const authority = req.gfsAuthority
  if (!authority) throw new GfsGrantError(401, 'unauthenticated')
  return authority
}

function ridOf(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

function subjectColumns(subjects: Set<string>): { types: string[]; ids: string[] } {
  const types: string[] = []
  const ids: string[] = []
  for (const key of subjects) {
    const sep = key.indexOf(':')
    if (sep < 0) continue
    types.push(key.slice(0, sep))
    ids.push(key.slice(sep + 1))
  }
  return { types, ids }
}

async function externalCallerSubjects(req: ExternalAuthedRequest): Promise<Set<string>> {
  const authority = authorityOf(req as ExternalGfsRequest)
  if (authority.kind === 'linked-admin') return new Set(['operator:'])
  const claims = req.externalAuth!
  const subjects = new Set<string>([`user:${claims.userId}`])
  if (claims.teamId) subjects.add(`team:${claims.teamId}`)
  const result = await pool.query(
    `SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'active'`,
    [claims.userId]
  )
  for (const row of result.rows as { team_id: unknown }[]) {
    subjects.add(`team:${String(row.team_id)}`)
  }
  return subjects
}

async function attachExternalGfsCallerSubjects(
  req: import('express').Request,
  _res: import('express').Response,
  next: NextFunction
): Promise<void> {
  const externalReq = req as ExternalGfsRequest
  externalReq.gfsSubjectKeys = [...(await externalCallerSubjects(externalReq))]
  next()
}

/**
 * Indexes of well-formed host subjects in `values` that are NOT in
 * `allowedHostIds`. Malformed entries (wrong shape, invalid host id) are
 * deliberately skipped so `handleGrantWrite` keeps sole ownership of the
 * `subjects_invalid` + `invalidIndexes` contract; only a syntactically valid
 * host that simply is not the caller's is adjudicated here.
 */
export function foreignHostSubjectIndexes(
  values: readonly unknown[],
  allowedHostIds: ReadonlySet<string>
): number[] {
  const foreign: number[] = []
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'object' || value === null) continue
    const { type, id } = value as { type?: unknown; id?: unknown }
    if (type !== 'host' || typeof id !== 'string' || !isValidHostSubjectId(id)) continue
    if (!allowedHostIds.has(id)) foreign.push(index)
  }
  return foreign
}

/**
 * User-plane eligibility: a folder owner may delegate only to agents in their
 * own directory. The allowed set is derived from the SAME authorization
 * boundary the agent catalog uses — `getUserAgents` (DB-only, no Kubernetes in
 * the mutation path) — mapped to the exact `1st:<hostsNamespace>/<name>` ids
 * `buildAgentDirectoryEntry` emits. Consequences: `3rd:` hosts and the legacy
 * fleet-wide sentinel are foreign for every user; sentinel retirement stays on
 * the DELETE `allowLegacyRetirement` path; an authorized-but-not-yet-reconciled
 * agent is grantable (inert row, consistent with catalog semantics). The admin
 * (operator) plane never runs this guard.
 */
async function assertHostTargetsWithinCallerAgents(
  req: import('express').Request,
  res: import('express').Response,
  next: NextFunction
): Promise<void> {
  const externalReq = req as ExternalGfsRequest
  if (authorityOf(externalReq).kind === 'linked-admin') {
    next()
    return
  }
  const body = (externalReq.body ?? {}) as Record<string, unknown>
  const plural = Array.isArray(body.subjects)
  const values = plural
    ? (body.subjects as unknown[])
    : Object.prototype.hasOwnProperty.call(body, 'subject')
      ? [body.subject]
      : []
  const probe = foreignHostSubjectIndexes(values, new Set())
  if (probe.length === 0) {
    // No well-formed host targets at all — nothing for this guard to decide.
    next()
    return
  }
  const { agentNames } = await getUserAgents(externalReq.externalAuth!.userId)
  // makeHostSubjectId returns null for a name that cannot form a canonical
  // host subject; such an agent is not grantable and never appears in the
  // catalog either, so skipping it mirrors buildAgentDirectoryEntry exactly.
  const allowed = new Set(
    agentNames
      .map(name => makeHostSubjectId('1st', config.hostsNamespace, name))
      .filter((id): id is string => id !== null)
  )
  const foreign = foreignHostSubjectIndexes(values, allowed)
  if (foreign.length > 0) {
    sendGfsGrantError(
      res,
      new GfsGrantError(403, 'foreign_agent_forbidden', plural ? foreign : undefined)
    )
    return
  }
  next()
}

/**
 * End-user (folder-owner) gfs surface on the `/external` plane — the Session-JWT
 * plane (external-rest-api ← desktop-app / profile-ui) of the platform's defined
 * JWT scheme. NO new auth is introduced: the user session is verified by the
 * existing `requireValidExternalSessionToken` (sets `req.externalAuth`), the gfs
 * token is minted by the existing `signGfsToken` (same platform keypair / aud /
 * verifier as operator + host tokens — only `sub = users.id`), and grant/share
 * reuse the EXISTING `handleGrantWrite`/`handleShareWrite` whose `resolveCaller`
 * already yields the `user:<id>` caller and whose `assertMayGrant` enforces
 * no-escalation. gfsc re-checks the permission store on every op, so the user
 * token is only an upper bound.
 *
 * This mirrors `routes/external/sharedFilesystems.ts` (user-session-gated proxy)
 * and `routes/external/auth.ts` `/external/rpc/token` (session → downstream token).
 */
export function createExternalGfsRouter(): Router {
  const router = Router()

  // The durable externalGfs* guards below are the authoritative distributed
  // limiter. These direct express-rate-limit guards provide a recognisable
  // routing-boundary backstop so static analysis can prove every
  // auth/authority/handler path is metered. The all-route ingress guard is
  // deliberately wider than the product quotas; the per-class guards and
  // distributed buckets retain the narrower security budgets. They keep no
  // response quota headers: the distributed guard owns the externally
  // forwarded values.
  const externalGfsIngressRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsIngressRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsIngressRateKey,
    message: { error: 'Too Many Requests' },
  })
  const externalGfsTokenRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsTokenUserRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsTokenRateKey,
    message: { error: 'Too Many Requests' },
  })
  const externalGfsResourceRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsReadRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('resource'),
    message: { error: 'Too Many Requests' },
  })
  const externalGfsProxyReadRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsReadRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('proxy-read'),
    message: { error: 'Too Many Requests' },
  })
  const externalGfsMutationRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsOperationRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('resource-mutation'),
    message: { error: 'Too Many Requests' },
  })
  const externalGfsGrantsReadRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsReadRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('grants-read'),
    message: { error: 'Too Many Requests' },
  })
  const externalGfsGrantsMutationRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsOperationRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('grants-mutation'),
    message: { error: 'Too Many Requests' },
  })
  const externalGfsSharesReadRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsReadRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('shares-read'),
    message: { error: 'Too Many Requests' },
  })
  const externalGfsSharesMutationRouteRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.externalGfsOperationRlPerMin,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: externalGfsActorRateKey('shares-mutation'),
    message: { error: 'Too Many Requests' },
  })

  // The source-IP guard intentionally precedes authentication and authority
  // lookup. The authenticated external-rest-api boundary overwrites XFF with
  // its trust-proxy-derived client address; externalGfsSourceIp accepts only
  // that valid first IP, so a raw caller cannot select a bucket.
  router.use('/external/gfs', externalGfsIngressRateLimit)

  // Every gfs user route is on the Session-JWT plane: the user session token
  // (x-user-session-token, forwarded by external-rest-api) is required.
  router.use('/external/gfs', requireValidExternalSessionToken)
  router.use('/external/gfs', attachExternalGfsRequestId)
  // This boundary deliberately precedes attachExternalGfsAuthority. A rate
  // rejection therefore performs no operator-link lookup or route-specific
  // database/handler work; see externalGfsRateLimit.ts for the complete
  // session/IP and effective-actor operation-class matrix.
  router.use('/external/gfs', externalGfsPreResolutionRateLimit)

  // ACL listing is still a privileged manage_acl operation, but it must not
  // consume the smaller mutation budget: opening the Manage dialog performs
  // several list/refetch reads before one visible grant/share action. Keep
  // those reads in the existing bounded GFS read budget and in a distinct
  // actor bucket from mutations.
  const externalGrantsReadRateLimit = rateLimitMiddleware({
    bucketType: 'gfs_grants_external_read',
    maxPerMinute: config.externalGfsReadRlPerMin,
    getBucketKey: req => {
      const authority = (req as RequestWithExternalGfsAuthority).gfsAuthority
      if (authority?.kind === 'linked-admin') {
        return `gfsgrants-ext-read:linked-admin:${authority.controlAdminId}`
      }
      if (authority?.kind === 'user-session') {
        return `gfsgrants-ext-read:user:${authority.desktopUserId}`
      }
      return 'gfsgrants-ext-read:__no_authority__'
    },
  })

  // Keep the existing mutation bucket identity and 30/min budget for
  // compatibility with telemetry and abuse controls; only read/list calls
  // move to the separate read bucket above.
  const externalGrantsMutationRateLimit = rateLimitMiddleware({
    bucketType: 'gfs_grants_external',
    maxPerMinute: config.externalGfsOperationRlPerMin,
    getBucketKey: req => {
      const authority = (req as RequestWithExternalGfsAuthority).gfsAuthority
      if (authority?.kind === 'linked-admin') {
        return `gfsgrants-ext:linked-admin:${authority.controlAdminId}`
      }
      if (authority?.kind === 'user-session') {
        return `gfsgrants-ext:user:${authority.desktopUserId}`
      }
      return 'gfsgrants-ext:__no_authority__'
    },
  })

  // ── token mint (mirror /external/rpc/token, but a gfs token sub=users.id) ──
  router.post(
    '/external/gfs/token',
    externalGfsTokenRouteRateLimit,
    asyncHandler(attachExternalGfsUserLifecycle),
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const claims = req.externalAuth!
      const body = (req.body ?? {}) as { drive?: unknown; scopes?: unknown }
      const drive =
        typeof body.drive === 'string' && body.drive.length > 0 ? body.drive : GFS_DEFAULT_DRIVE
      const scopes = parseRequestedGfsScopes(body.scopes)
      if (scopes === null) {
        res.status(400).json({ error: 'invalid_gfs_scopes' })
        return
      }
      // pathBindings: [] — the permission store is the source of truth; gfsc
      // re-checks it on every op (same as the operator/human mint).
      const { token, expiresInSeconds } = signGfsToken({
        subject: claims.userId,
        drive,
        scopes,
        pathBindings: [],
        ...(claims.authGeneration === undefined ? {} : { authGeneration: claims.authGeneration }),
        principalType: 'user',
      })
      res.status(200).json({ token, expiresInSeconds })
    })
  )

  // Public token mint above is deliberately user-only. Effective linked-admin
  // authority is resolved only for the internal broker routes below.
  router.use('/external/gfs', asyncHandler(attachExternalGfsAuthority))
  router.use('/external/gfs', externalGfsResolvedOperationRateLimit)

  // ── delegation: reuse the EXISTING grant/share handlers (caller-agnostic) ──
  // resolveCaller(req) reads req.externalAuth → user:<id> plus all active team
  // memberships resolved here; assertMayGrant enforces no-escalation (a user may
  // grant only bits it holds, within its subtree).
  // The grants list is delegation metadata naming third-party subjects, so
  // reading it requires the same manage_acl authority as mutating it
  // (view-ACL = manage-ACL); handleGrantListForCaller enforces that.
  router.get(
    '/external/gfs/grants',
    externalGfsGrantsReadRouteRateLimit,
    externalGrantsReadRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleGrantListForCaller)
  )
  router.put(
    '/external/gfs/grants',
    externalGfsGrantsMutationRouteRateLimit,
    externalGrantsMutationRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(assertHostTargetsWithinCallerAgents),
    asyncHandler(handleGrantWrite)
  )
  router.delete(
    '/external/gfs/grants/:id',
    externalGfsGrantsMutationRouteRateLimit,
    externalGrantsMutationRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleGrantDelete)
  )
  router.post(
    '/external/gfs/shares',
    externalGfsSharesMutationRouteRateLimit,
    externalGrantsMutationRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleShareWrite)
  )
  router.get(
    '/external/gfs/shares',
    externalGfsSharesReadRouteRateLimit,
    externalGrantsReadRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleShareListForCaller)
  )
  router.delete(
    '/external/gfs/shares/:id',
    externalGfsSharesMutationRouteRateLimit,
    externalGrantsMutationRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleShareDelete)
  )

  // ── affordances: which bits does the caller hold on a resource? ──
  // Drives the Desktop delegation panel (delegationAffordances). Reuses the
  // EXISTING checkAccess (same allow() engine as assertMayGrant). Read-only.
  router.get(
    '/external/gfs/resources/:id/affordances',
    externalGfsResourceRouteRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const caller = resolveCaller(req)
      const drive = driveOf(req.query.drive)
      const resourceId = String(req.params.id)
      if (!UUID_RE.test(resourceId)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      // One store load → all held bits (vs checkAccess per-bit). Same engine.
      const held = await heldPermissions(pool, caller, drive, resourceId)
      res.status(200).json({ held, isOperator: caller.isOperator })
    })
  )

  router.patch(
    '/external/gfs/resources/:id',
    externalGfsMutationRouteRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handlePatch)
  )

  router.post(
    '/external/gfs/resources/:id/children',
    externalGfsMutationRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const rid = String(req.params.id)
      if (!UUID_RE.test(rid)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyMutationToGfsc(
        req,
        res,
        driveOf(req.query.drive ?? (req.body as { drive?: unknown } | undefined)?.drive),
        'POST',
        `/v1/resources/${encodeURIComponent(ridOf(rid))}/children`,
        GFS_WRITE_SCOPE
      )
    })
  )

  router.put(
    '/external/gfs/resources/:id/content',
    externalGfsMutationRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const rid = String(req.params.id)
      if (!UUID_RE.test(rid)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyMutationToGfsc(
        req,
        res,
        driveOf(req.query.drive ?? (req.body as { drive?: unknown } | undefined)?.drive),
        'PUT',
        `/v1/resources/${encodeURIComponent(ridOf(rid))}/content`,
        GFS_WRITE_SCOPE
      )
    })
  )

  router.delete(
    '/external/gfs/resources/:id',
    externalGfsMutationRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const rid = String(req.params.id)
      if (!UUID_RE.test(rid)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyMutationToGfsc(
        req,
        res,
        driveOf(req.query.drive ?? (req.body as { drive?: unknown } | undefined)?.drive),
        'DELETE',
        `/v1/resources/${encodeURIComponent(ridOf(rid))}`,
        GFS_DELETE_SCOPE
      )
    })
  )

  router.get(
    '/external/gfs/resources',
    externalGfsResourceRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const drive = driveOf(req.query.drive)
      const authority = authorityOf(req as ExternalGfsRequest)
      if (authority.kind === 'linked-admin') {
        const root = await new DbResolveStore(pool).getByPath(drive, '/')
        if (!root) {
          res.status(404).json({
            ok: false,
            error: { code: 'drive_not_seeded', message: 'drive root is not seeded' },
          })
          return
        }
        try {
          const page = await listChildrenPaged(new DbChildrenStore(pool), drive, root.resourceId, {
            limit: req.query.limit,
            cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          })
          res.status(200).json({
            ok: true,
            data: { ...page, rootResourceId: root.resourceId, view: 'operator' },
          })
        } catch (error) {
          if (error instanceof GfsTreeError) {
            res.status(400).json({ ok: false, error: { code: error.code, message: error.message } })
            return
          }
          throw error
        }
        return
      }
      const subjects = await externalCallerSubjects(req)
      const { types, ids } = subjectColumns(subjects)
      if (types.length === 0) {
        res.status(200).json({ ok: true, data: { items: [], nextCursor: null } })
        return
      }
      let after: { n: string; i: string } | undefined
      try {
        after = typeof req.query.cursor === 'string' ? decodeCursor(req.query.cursor) : undefined
      } catch (err) {
        if (err instanceof GfsTreeError) {
          res.status(400).json({ ok: false, error: { code: err.code, message: err.message } })
          return
        }
        throw err
      }
      const limit =
        req.query.limit == null ? ACCESSIBLE_RESOURCE_DEFAULT_LIMIT : clampLimit(req.query.limit)
      const result = await pool.query(
        `WITH requested_subjects(subject_type, subject_id) AS (
           SELECT * FROM unnest($2::text[], $3::text[])
         ),
         accessible AS (
           SELECT g.resource_id, g.permissions, g.inherit AS covers_descendants, 'grant'::text AS source
             FROM gfs_grants g
             JOIN requested_subjects s
               ON s.subject_type = g.subject_type AND s.subject_id = g.subject_id
            WHERE g.drive = $1 AND 'read' = ANY(g.permissions)
           UNION ALL
           SELECT sh.resource_id, sh.permissions, sh.include_descendants AS covers_descendants, 'share'::text AS source
             FROM gfs_shares sh
             JOIN requested_subjects s
               ON s.subject_type = sh.subject_type AND s.subject_id = sh.subject_id
            WHERE sh.drive = $1 AND 'read' = ANY(sh.permissions)
         )
         SELECT r.resource_id,
                r.drive,
                r.parent_resource_id,
                r.name,
                r.kind,
                r.path_cache,
                r.version,
                r.bytes,
                array_remove(array_agg(DISTINCT a.source), NULL) AS sources,
                array_remove(array_agg(DISTINCT p.permission), NULL) AS permissions,
                bool_or(a.covers_descendants) AS covers_descendants
           FROM accessible a
           JOIN gfs_resources r
             ON r.drive = $1 AND r.resource_id = a.resource_id AND r.deleted_at IS NULL
           LEFT JOIN LATERAL unnest(a.permissions) AS p(permission) ON true
          WHERE ($4::text IS NULL OR (r.name, r.resource_id) > ($4, $5::uuid))
          GROUP BY r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.path_cache, r.version, r.bytes
          ORDER BY r.name, r.resource_id
          LIMIT $6`,
        [drive, types, ids, after?.n ?? null, after?.i ?? null, limit + 1]
      )
      const rows = result.rows as Array<{
        resource_id: string
        drive: string
        parent_resource_id: string | null
        name: string
        kind: 'file' | 'directory'
        path_cache: string | null
        version: number
        bytes: number
        sources: string[]
        permissions: string[]
        covers_descendants: boolean
      }>
      const page = rows.length > limit ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      res.status(200).json({
        ok: true,
        data: {
          items: page.map(row => {
            const rid = ridOf(String(row.resource_id))
            return {
              resourceId: String(row.resource_id),
              rid,
              gfsUri: `gfs://${row.drive}/${rid}`,
              drive: row.drive,
              parentResourceId: row.parent_resource_id ? String(row.parent_resource_id) : null,
              name: String(row.name),
              kind: row.kind,
              path: row.path_cache,
              version: Number(row.version ?? 0),
              bytes: Number(row.bytes ?? 0),
              sources: row.sources ?? [],
              permissions: row.permissions ?? [],
              coversDescendants: Boolean(row.covers_descendants),
            }
          }),
          nextCursor:
            rows.length > limit && last ? encodeCursor(last.name, String(last.resource_id)) : null,
        },
      })
    })
  )

  // ── read: resolve / list-children / download — proxied to gfsc with a freshly
  // minted USER read token (sub=users.id). gfsc authorizes against the store
  // (deny-by-default), so a user only reads what it is granted. GET only. ──
  router.get(
    '/external/gfs/resolve',
    externalGfsResourceRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const uri = typeof req.query.uri === 'string' ? req.query.uri : ''
      if (!uri) {
        res.status(400).json({ error: 'uri_required' })
        return
      }
      if (uri.length > MAX_GFS_URI_LEN) {
        res.status(400).json({ error: 'uri_too_long' })
        return
      }
      await proxyReadToGfsc(
        req,
        res,
        driveOf(req.query.drive),
        `/v1/resolve?uri=${encodeURIComponent(uri)}`
      )
    })
  )

  router.get(
    '/external/gfs/resources/:id/children',
    externalGfsResourceRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const rid = String(req.params.id)
      if (!UUID_RE.test(rid)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      const drive = driveOf(req.query.drive)
      const q = new URLSearchParams()
      q.set('drive', drive)
      if (typeof req.query.limit === 'string') q.set('limit', req.query.limit)
      if (typeof req.query.cursor === 'string') q.set('cursor', req.query.cursor)
      await proxyReadToGfsc(
        req,
        res,
        drive,
        `/v1/resources/${encodeURIComponent(rid)}/children?${q.toString()}`
      )
    })
  )

  router.get(
    '/external/gfs/proxy/:rid',
    externalGfsProxyReadRouteRateLimit,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const rid = String(req.params.rid)
      if (!UUID_RE.test(rid)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyReadToGfsc(
        req,
        res,
        driveOf(req.query.drive),
        `/v1/resources/${encodeURIComponent(rid)}/content`
      )
    })
  )

  return router
}

/**
 * Mint a short-lived USER read token (sub=users.id, gfs.read) and forward a GET
 * to gfsc, streaming the response back. Mirrors `routes/gfs/proxy.ts` but the
 * principal is the user, not the operator — gfsc re-checks the store, so this
 * grants nothing the user is not already entitled to.
 */
async function proxyReadToGfsc(
  req: ExternalAuthedRequest,
  res: import('express').Response,
  drive: string,
  gfscPath: string
): Promise<void> {
  const authority = authorityOf(req as ExternalGfsRequest)
  const { token } = signGfsToken({
    subject: authority.tokenSubject,
    drive,
    scopes: [GFS_READ_SCOPE],
    ...(authority.authGeneration === undefined ? {} : { authGeneration: authority.authGeneration }),
    principalType: authority.kind === 'linked-admin' ? 'control-admin' : 'user',
    ...(authority.kind === 'linked-admin'
      ? {
          brokeredAuthority: {
            desktopUserId: authority.desktopUserId,
            controlAdminId: authority.controlAdminId,
            authoritySource: authority.authoritySource,
            linkLineageId: authority.linkLineageId,
            linkGeneration: authority.linkGeneration,
            desktopUserGeneration: authority.desktopUserGeneration,
          },
        }
      : {}),
  })
  const target = `${config.gfscBaseUrl.replace(/\/+$/, '')}${gfscPath}`
  let upstream: Response
  // Header-only deadline: bound the wait for gfsc to START responding, but never
  // the streamed download body — a large/slow read must not be truncated
  // mid-stream by the mutation budget. Cleared once headers arrive.
  const readDeadline = new AbortController()
  const readTimer = setTimeout(() => readDeadline.abort(), config.gfscProxyTimeoutMs)
  try {
    upstream = await fetch(target, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': (req as ExternalGfsRequest).gfsRequestId!,
      },
      signal: readDeadline.signal,
    })
  } catch (err) {
    const timedOut =
      readDeadline.signal.aborted || (err instanceof Error && err.name === 'TimeoutError')
    rootLogger.error(
      { err, gfscPath, timeoutMs: config.gfscProxyTimeoutMs },
      timedOut
        ? 'gfs external read proxy: gfsc fetch timed out'
        : 'gfs external read proxy: gfsc fetch failed'
    )
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'gfsc_timeout' : 'gfsc_unreachable' })
    return
  } finally {
    clearTimeout(readTimer)
  }
  if (upstream.status >= 400) {
    // Error envelopes are small JSON: buffer, LOG, forward verbatim (a gfsc 5xx on a
    // read was invisible at this hop before). Success bodies keep streaming below.
    const errorBody = await upstream.text()
    if (upstream.status >= 500) {
      rootLogger.error(
        { gfscPath, status: upstream.status, body: errorBody.slice(0, 2048) },
        'gfs external read proxy: gfsc upstream error'
      )
    }
    res.status(upstream.status)
    const ct = upstream.headers.get('content-type')
    if (ct) res.setHeader('content-type', ct)
    res.send(errorBody)
    return
  }
  res.status(upstream.status)
  for (const h of ['content-type', 'content-disposition', 'content-length']) {
    const v = upstream.headers.get(h)
    if (v) res.setHeader(h, v)
  }
  if (!upstream.body) {
    res.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
    res.end()
  } catch (err) {
    // Mid-stream gfsc read failure (pod restart, network abort). Surface it —
    // never swallow silently. If headers are already committed we can only end
    // the (now-truncated) response; the logged error is the operator's trace.
    rootLogger.error({ err, gfscPath }, 'gfs external read proxy: gfsc upstream stream error')
    if (!res.headersSent) res.status(502).json({ error: 'gfsc upstream error' })
    else res.end()
  }
}

async function proxyMutationToGfsc(
  req: ExternalAuthedRequest,
  res: import('express').Response,
  drive: string,
  method: 'POST' | 'PUT' | 'DELETE',
  gfscPath: string,
  scope: typeof GFS_WRITE_SCOPE | typeof GFS_DELETE_SCOPE
): Promise<void> {
  const authority = authorityOf(req as ExternalGfsRequest)
  const { token } = signGfsToken({
    subject: authority.tokenSubject,
    drive,
    scopes: [scope],
    ...(authority.authGeneration === undefined ? {} : { authGeneration: authority.authGeneration }),
    principalType: authority.kind === 'linked-admin' ? 'control-admin' : 'user',
    ...(authority.kind === 'linked-admin'
      ? {
          brokeredAuthority: {
            desktopUserId: authority.desktopUserId,
            controlAdminId: authority.controlAdminId,
            authoritySource: authority.authoritySource,
            linkLineageId: authority.linkLineageId,
            linkGeneration: authority.linkGeneration,
            desktopUserGeneration: authority.desktopUserGeneration,
          },
        }
      : {}),
  })
  const target = `${config.gfscWriteBaseUrl.replace(/\/+$/, '')}${gfscPath}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  headers['author' + 'ization'] = ['Bearer', token].join(' ')
  headers['x-request-id'] = (req as ExternalGfsRequest).gfsRequestId!
  let upstream: Response
  // A TOTAL deadline (not the header-only one the streaming read proxies use):
  // a mutation response is a small JSON body, so bounding the whole fetch+read
  // exchange is correct — the read proxies stream large bodies and must clear the
  // timer after headers, but here we want the whole exchange bounded. Without a
  // timeout a hung gfsc pinned the desktop upload indefinitely (#281/H1).
  const deadline = AbortSignal.timeout(config.gfscProxyTimeoutMs)
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: JSON.stringify(req.body ?? {}),
      signal: deadline,
    })
  } catch (err) {
    const timedOut = deadline.aborted || (err instanceof Error && err.name === 'TimeoutError')
    rootLogger.error(
      { err, gfscPath, method, timeoutMs: config.gfscProxyTimeoutMs },
      timedOut
        ? 'gfs external mutation proxy: gfsc fetch timed out'
        : 'gfs external mutation proxy: gfsc fetch failed'
    )
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'gfsc_timeout' : 'gfsc_unreachable' })
    return
  }
  // The same deadline also bounds this response-body read. If gfsc sent headers
  // and then stalled the body, text() rejects — classify it (504/502) instead of
  // letting it reject uncaught into a generic 500. Read BEFORE committing status,
  // so a read failure can still set the right code.
  let text: string
  try {
    text = await upstream.text()
  } catch (err) {
    const timedOut =
      deadline.aborted ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    rootLogger.error(
      { err, gfscPath, method, status: upstream.status, timeoutMs: config.gfscProxyTimeoutMs },
      'gfs external mutation proxy: gfsc response body read failed'
    )
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'gfsc_timeout' : 'gfsc_unreachable' })
    return
  }
  res.status(upstream.status)
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('content-type', contentType)
  // Never silent: surface a gfsc 4xx/5xx at this hop (the base64 RangeError 500 was
  // invisible here before) while forwarding the body verbatim.
  if (upstream.status >= 500) {
    rootLogger.error(
      { gfscPath, method, status: upstream.status, body: text.slice(0, 2048) },
      'gfs external mutation proxy: gfsc upstream error'
    )
  } else if (upstream.status >= 400) {
    rootLogger.warn(
      { gfscPath, method, status: upstream.status, body: text.slice(0, 2048) },
      'gfs external mutation proxy: gfsc upstream client error'
    )
  }
  res.send(text)
}
