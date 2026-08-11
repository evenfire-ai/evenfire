import { type NextFunction, Router } from 'express'
import {
  GFS_DELETE_SCOPE,
  GFS_READ_SCOPE,
  GFS_WRITE_SCOPE,
  signGfsToken,
} from '../../auth/gfsToken.js'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { isValidHostSubjectId, makeHostSubjectId } from '../../gfs/hostSubject.js'
import { GfsTreeError, clampLimit, decodeCursor, encodeCursor } from '../../gfs/tree.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import {
  type GfsUploadAdmissionRequest,
  createObservedGfsUploadPartBody,
  gfsUploadAdmission,
} from '../../middleware/gfsUploadAdmission.js'
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
import { handleShareDelete, handleShareWrite } from '../gfs/shares.js'
import { GFS_DEFAULT_DRIVE, parseRequestedGfsScopes } from '../gfs/token.js'

// A gfs:// URI is `gfs://<drive>/<path-or-rid>`; cap it so an oversized value is
// rejected here, not forwarded to gfsc as an unbounded request.
const MAX_GFS_URI_LEN = 2048
const ACCESSIBLE_RESOURCE_DEFAULT_LIMIT = 100

type ExternalGfsRequest = ExternalAuthedRequest & {
  gfsSubjectKeys?: string[]
}

type ExternalGfsUploadRequest = GfsUploadAdmissionRequest & {
  gfsUploadDrive?: string
}

function requireCanonicalUploadDrive(
  req: ExternalGfsUploadRequest,
  res: import('express').Response,
  next: NextFunction
): void {
  const rawDrive = typeof req.query.drive === 'string' ? req.query.drive : ''
  const drive = rawDrive.trim()
  if (!drive || drive !== rawDrive) {
    res.status(400).json({ error: 'drive_required' })
    return
  }
  if (req.method === 'POST' && req.path === '/external/gfs/uploads') {
    const bodyDrive = (req.body as { drive?: unknown } | undefined)?.drive
    if (bodyDrive !== drive) {
      res.status(400).json({ error: 'drive_mismatch' })
      return
    }
  }
  req.gfsUploadDrive = drive
  next()
}

function canonicalUploadDrive(req: ExternalGfsUploadRequest): string {
  const drive = req.gfsUploadDrive
  if (!drive) throw new Error('canonical upload drive middleware was not applied')
  return drive
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

  // Every gfs user route is on the Session-JWT plane: the user session token
  // (x-user-session-token, forwarded by external-rest-api) is required.
  router.use('/external/gfs', requireValidExternalSessionToken)

  // Per-user token bucket on the DELEGATION plane only (grants + shares),
  // mirroring the admin plane's grantsRateLimit but in a DISTINCT bucket so the
  // two planes never share quota. requireValidExternalSessionToken runs at
  // router level first, so externalAuth.userId is always present by the time the
  // limiter keys; the no-user branch is therefore unreachable, but it returns a
  // shared sentinel (never null) so the limiter fails CLOSED — per
  // rateLimitMiddleware's guidance for strict enforcement — instead of the
  // default fail-open, keeping this plane strictly metered under any future
  // auth-ordering change.
  const externalGrantsRateLimit = rateLimitMiddleware({
    bucketType: 'gfs_grants_external',
    maxPerMinute: 30,
    getBucketKey: req => {
      const userId = (req as ExternalAuthedRequest).externalAuth?.userId
      return userId ? `gfsgrants-ext:${userId}` : 'gfsgrants-ext:__no_user__'
    },
  })

  // ── token mint (mirror /external/rpc/token, but a gfs token sub=users.id) ──
  router.post(
    '/external/gfs/token',
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
      })
      res.status(200).json({ token, expiresInSeconds })
    })
  )

  // Indexed upload-v2 relay. Part PUTs stay a Node stream all the way from
  // external-rest-api to the writer GFSC; lifecycle requests use the same
  // writer-scoped token and never fall back to the legacy JSON/base64 path.
  router.get(
    '/external/gfs/capabilities',
    requireCanonicalUploadDrive,
    gfsUploadAdmission,
    asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
      await proxyUploadToGfsc(req, res, canonicalUploadDrive(req), 'GET', '/v1/capabilities')
    })
  )
  router.post(
    '/external/gfs/uploads',
    requireCanonicalUploadDrive,
    gfsUploadAdmission,
    asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
      await proxyUploadToGfsc(req, res, canonicalUploadDrive(req), 'POST', '/v1/uploads')
    })
  )
  router.head(
    '/external/gfs/uploads/:id',
    requireCanonicalUploadDrive,
    gfsUploadAdmission,
    asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
      if (!UUID_RE.test(String(req.params.id))) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyUploadToGfsc(
        req,
        res,
        canonicalUploadDrive(req),
        'HEAD',
        `/v1/uploads/${encodeURIComponent(req.params.id)}`
      )
    })
  )
  router.get(
    '/external/gfs/uploads/:id/status',
    requireCanonicalUploadDrive,
    gfsUploadAdmission,
    asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
      if (!UUID_RE.test(String(req.params.id))) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyUploadToGfsc(
        req,
        res,
        canonicalUploadDrive(req),
        'GET',
        `/v1/uploads/${encodeURIComponent(req.params.id)}/status`,
        {
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        }
      )
    })
  )
  router.put(
    '/external/gfs/uploads/:id/parts/:part',
    requireCanonicalUploadDrive,
    gfsUploadAdmission,
    asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
      const id = String(req.params.id)
      const part = String(req.params.part)
      if (!UUID_RE.test(id) || !/^[0-9]+$/.test(part)) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyUploadToGfsc(
        req,
        res,
        canonicalUploadDrive(req),
        'PUT',
        `/v1/uploads/${encodeURIComponent(id)}/parts/${part}`
      )
    })
  )
  for (const action of ['pause', 'resume', 'complete'] as const) {
    router.post(
      `/external/gfs/uploads/:id/${action}`,
      requireCanonicalUploadDrive,
      gfsUploadAdmission,
      asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
        if (!UUID_RE.test(String(req.params.id))) {
          res.status(400).json({ error: 'resource_invalid' })
          return
        }
        await proxyUploadToGfsc(
          req,
          res,
          canonicalUploadDrive(req),
          'POST',
          `/v1/uploads/${encodeURIComponent(req.params.id)}/${action}`
        )
      })
    )
  }
  router.delete(
    '/external/gfs/uploads/:id',
    requireCanonicalUploadDrive,
    gfsUploadAdmission,
    asyncHandler(async (req: ExternalGfsUploadRequest, res) => {
      if (!UUID_RE.test(String(req.params.id))) {
        res.status(400).json({ error: 'resource_invalid' })
        return
      }
      await proxyUploadToGfsc(
        req,
        res,
        canonicalUploadDrive(req),
        'DELETE',
        `/v1/uploads/${encodeURIComponent(req.params.id)}`
      )
    })
  )

  // ── delegation: reuse the EXISTING grant/share handlers (caller-agnostic) ──
  // resolveCaller(req) reads req.externalAuth → user:<id> plus all active team
  // memberships resolved here; assertMayGrant enforces no-escalation (a user may
  // grant only bits it holds, within its subtree).
  // The grants list is delegation metadata naming third-party subjects, so
  // reading it requires the same manage_acl authority as mutating it
  // (view-ACL = manage-ACL); handleGrantListForCaller enforces that.
  router.get(
    '/external/gfs/grants',
    externalGrantsRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleGrantListForCaller)
  )
  router.put(
    '/external/gfs/grants',
    externalGrantsRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(assertHostTargetsWithinCallerAgents),
    asyncHandler(handleGrantWrite)
  )
  router.delete(
    '/external/gfs/grants/:id',
    externalGrantsRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleGrantDelete)
  )
  router.post(
    '/external/gfs/shares',
    externalGrantsRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleShareWrite)
  )
  router.delete(
    '/external/gfs/shares/:id',
    externalGrantsRateLimit,
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handleShareDelete)
  )

  // ── affordances: which bits does the caller hold on a resource? ──
  // Drives the Desktop delegation panel (delegationAffordances). Reuses the
  // EXISTING checkAccess (same allow() engine as assertMayGrant). Read-only.
  router.get(
    '/external/gfs/resources/:id/affordances',
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
    asyncHandler(attachExternalGfsCallerSubjects),
    asyncHandler(handlePatch)
  )

  router.post(
    '/external/gfs/resources/:id/children',
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
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const drive = driveOf(req.query.drive)
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
  const claims = req.externalAuth!
  const { token } = signGfsToken({
    subject: claims.userId,
    drive,
    scopes: [GFS_READ_SCOPE],
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
      headers: { authorization: `Bearer ${token}` },
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
  const claims = req.externalAuth!
  const { token } = signGfsToken({
    subject: claims.userId,
    drive,
    scopes: [scope],
  })
  const target = `${config.gfscWriteBaseUrl.replace(/\/+$/, '')}${gfscPath}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  headers['author' + 'ization'] = ['Bearer', token].join(' ')
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

async function proxyUploadToGfsc(
  req: ExternalGfsUploadRequest,
  res: import('express').Response,
  drive: string,
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE',
  gfscPath: string,
  query?: Record<string, string | undefined>
): Promise<void> {
  const claims = req.externalAuth!
  const { token } = signGfsToken({ subject: claims.userId, drive, scopes: [GFS_WRITE_SCOPE] })
  const targetUrl = new URL(`${config.gfscWriteBaseUrl.replace(/\/+$/, '')}${gfscPath}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') targetUrl.searchParams.set(key, value)
  }
  const target = targetUrl.toString()
  const rawPart = method === 'PUT' && /\/parts\/[0-9]+$/.test(gfscPath)
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (rawPart) {
    for (const name of [
      'content-type',
      'upload-part-number',
      'upload-offset',
      'upload-chunk-length',
      'upload-checksum',
    ]) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    headers['content-length'] = String(req.gfsUploadDeclaredBytes)
  } else if (method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json'
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort()
    },
    Math.max(config.gfscProxyTimeoutMs, 600_000)
  )
  let clientAborted = false
  const abortForClientDisconnect = (): void => {
    clientAborted = true
    controller.abort()
  }
  req.once('aborted', abortForClientDisconnect)

  const declaredBytes = req.gfsUploadDeclaredBytes
  if (rawPart && (!Number.isSafeInteger(declaredBytes) || !declaredBytes)) {
    throw new Error('upload admission did not provide a declared byte count')
  }
  const observedPart = rawPart
    ? createObservedGfsUploadPartBody(req, declaredBytes as number, config.gfsUploadMaxPartBytes)
    : null
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body:
      method === 'GET' || method === 'HEAD'
        ? undefined
        : rawPart
          ? (observedPart!.body as unknown as BodyInit)
          : JSON.stringify(req.body ?? {}),
    signal: controller.signal,
  }
  if (rawPart) init.duplex = 'half'
  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch (error) {
    const validationError = observedPart?.validationError()
    if (validationError) {
      res.status(validationError.status).json({ error: validationError.code })
      return
    }
    if (clientAborted) return
    rootLogger.error(
      { err: error, gfscPath, method },
      timedOut ? 'gfs external upload proxy timed out' : 'gfs external upload proxy failed'
    )
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'gfsc_timeout' : 'gfsc_unreachable' })
    return
  } finally {
    clearTimeout(timer)
    req.off('aborted', abortForClientDisconnect)
  }
  if (upstream.status >= 400) {
    const body = await upstream.text()
    if (upstream.status >= 500)
      rootLogger.error(
        { gfscPath, method, status: upstream.status, body: body.slice(0, 2048) },
        'gfs external upload upstream error'
      )
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType) res.setHeader('content-type', contentType)
    res.send(body)
    return
  }
  res.status(upstream.status)
  for (const name of [
    'content-type',
    'content-length',
    'cache-control',
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
  ]) {
    const value = upstream.headers.get(name)
    if (value) res.setHeader(name, value)
  }
  if (!upstream.body) {
    res.end()
    return
  }
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>)
      res.write(Buffer.from(chunk))
    res.end()
  } catch (error) {
    rootLogger.error({ err: error, gfscPath, method }, 'gfs external upload response stream failed')
    if (!res.headersSent) res.status(502).json({ error: 'gfsc upstream error' })
    else res.end()
  }
}
