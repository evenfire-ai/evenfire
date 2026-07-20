import type { Request, Router } from 'express'
import { createHash } from 'node:crypto'
import { type DbClient, pool, withTransaction } from '../../db.js'
import { isValidHostSubjectId } from '../../gfs/hostSubject.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import {
  type ControlApiPermissionSubject,
  appendControlApiPermissionEventsInTransaction,
} from '../../services/tracing/controlApiPermissionEvents.js'

/**
 * gfs grant write API (Layer-1 operator seed + Layer-2 folder-owner delegation).
 *
 * Enforces the spec's no-escalation invariant (community.md §RBAC model /
 * §Inheritance #4 / §Delegation): a grantor may grant ONLY permissions it
 * itself holds — including `manage_acl` — and only on a resource within its own
 * subtree (i.e. where it holds `manage_acl` on R or an inheriting ancestor of
 * R). The cluster operator is the intrinsic root of trust and bypasses the
 * stored-grant check. Every mutation is appended to the hash-chained,
 * INSERT-only `gfs_audit` log.
 *
 * The allow() evaluation here is a faithful mirror of the gfsc decision logic
 * (gfs-controller/src/authz/resolve.ts `resolveDecision`) — keep the two in
 * lockstep; any divergence is a security bug.
 */

/** Minimal query surface — a pg client/pool satisfies this; tests inject a fake. */
export interface GrantsDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>
}

const DEFAULT_DRIVE = 'main'
export const PERMISSIONS = ['read', 'write', 'delete', 'manage_acl', 'share'] as const
export type GfsPermission = (typeof PERMISSIONS)[number]
const SUBJECT_TYPES = ['operator', 'user', 'team', 'host', 'context'] as const
export type GfsSubjectType = (typeof SUBJECT_TYPES)[number]
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface GfsSubject {
  type: GfsSubjectType
  id?: string
}

/** Canonical `type:id` key (operator carries no id → `operator:`). */
export function subjectKey(subject: GfsSubject): string {
  return `${subject.type}:${subject.id ?? ''}`
}

export class GfsGrantError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'GfsGrantError'
  }
}

/** The authenticated caller, reduced to the gfs authority it carries. */
export interface GfsCaller {
  /** Cluster operator — intrinsic full authority, no stored grant required. */
  isOperator: boolean
  /** Canonical subject keys the caller resolves to (self + groups). */
  subjects: Set<string>
  /** Audit actor key (`operator:` or `user:<uuid>`). */
  actorKey: string
}

type RequestWithResolvedGfsSubjects = Request & {
  gfsSubjectKeys?: string[]
}

/**
 * Reduce the authenticated request to its gfs caller. Operators authenticate
 * via Control UI (`req.adminAuth`); folder owners delegate from Profile/Desktop
 * via an external user session (`req.externalAuth`). Team-membership enrichment
 * of a user's subject set is owned by P2-S02 (subjects.ts) and wired into
 * delegation in P2-S04; P2-S01 resolves the user's own `user:<uuid>` subject.
 */
export function resolveCaller(req: Request): GfsCaller {
  const admin = (req as { adminAuth?: { sub?: string } }).adminAuth
  if (admin?.sub) {
    return { isOperator: true, subjects: new Set(['operator:']), actorKey: 'operator:' }
  }
  const external = (req as { externalAuth?: { userId?: string; teamId?: string | null } })
    .externalAuth
  if (external?.userId) {
    const key = `user:${external.userId}`
    const preResolved = (req as RequestWithResolvedGfsSubjects).gfsSubjectKeys
    const subjects = new Set(preResolved && preResolved.length > 0 ? preResolved : [key])
    subjects.add(key)
    if (external.teamId) subjects.add(`team:${external.teamId}`)
    return { isOperator: false, subjects, actorKey: key }
  }
  throw new GfsGrantError(401, 'unauthenticated')
}

interface GrantRow {
  subjectKey: string
  resourceId: string
  permissions: string[]
  inherit: boolean
}
interface ShareRow {
  subjectKey: string
  resourceId: string
  permissions: string[]
  includeDescendants: boolean
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

/** R plus all ancestors (R included), root last — mirrors permissionClient. */
export async function ancestorsOf(
  db: GrantsDb,
  drive: string,
  resourceId: string
): Promise<string[]> {
  const sql = `
    WITH RECURSIVE chain AS (
      SELECT resource_id, parent_resource_id, 0 AS depth
        FROM gfs_resources
       WHERE drive = $1 AND resource_id = $2::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT r.resource_id, r.parent_resource_id, c.depth + 1
        FROM gfs_resources r
        JOIN chain c ON r.resource_id = c.parent_resource_id
       WHERE r.drive = $1 AND r.deleted_at IS NULL
    )
    SELECT resource_id FROM chain ORDER BY depth ASC`
  const result = await db.query(sql, [drive, resourceId])
  return (result.rows as { resource_id: string }[]).map(row => String(row.resource_id))
}

async function loadGrants(db: GrantsDb, drive: string, subjects: Set<string>): Promise<GrantRow[]> {
  // Filter by the caller's subjects IN SQL (mirrors gfsc grantsFor) — never fetch
  // the whole drive's grants and filter in JS. Keep subject_type and subject_id
  // as independent predicates so the (drive, subject_type, subject_id) index can
  // stay useful as the drive grows.
  if (subjects.size === 0) return []
  const { types, ids } = subjectColumns(subjects)
  if (types.length === 0) return []
  const result = await db.query(
    `WITH requested_subjects(subject_type, subject_id) AS (
       SELECT * FROM unnest($2::text[], $3::text[])
     )
     SELECT g.subject_type, g.subject_id, g.resource_id, g.permissions, g.inherit
       FROM gfs_grants g
       JOIN requested_subjects s
         ON s.subject_type = g.subject_type AND s.subject_id = g.subject_id
      WHERE g.drive = $1`,
    [drive, types, ids]
  )
  return (result.rows as Record<string, unknown>[]).map(r => ({
    subjectKey: `${String(r.subject_type)}:${String(r.subject_id ?? '')}`,
    resourceId: String(r.resource_id),
    permissions: (r.permissions as string[]) ?? [],
    inherit: Boolean(r.inherit),
  }))
}

async function loadShares(db: GrantsDb, drive: string, subjects: Set<string>): Promise<ShareRow[]> {
  if (subjects.size === 0) return []
  const { types, ids } = subjectColumns(subjects)
  if (types.length === 0) return []
  const result = await db.query(
    `WITH requested_subjects(subject_type, subject_id) AS (
       SELECT * FROM unnest($2::text[], $3::text[])
     )
     SELECT s0.subject_type, s0.subject_id, s0.resource_id, s0.permissions, s0.include_descendants
       FROM gfs_shares s0
       JOIN requested_subjects s
         ON s.subject_type = s0.subject_type AND s.subject_id = s0.subject_id
      WHERE s0.drive = $1`,
    [drive, types, ids]
  )
  return (result.rows as Record<string, unknown>[]).map(r => ({
    subjectKey: `${String(r.subject_type)}:${String(r.subject_id ?? '')}`,
    resourceId: String(r.resource_id),
    permissions: (r.permissions as string[]) ?? [],
    includeDescendants: Boolean(r.include_descendants),
  }))
}

/**
 * Does the caller hold `op` on `resourceId`? Faithful mirror of gfsc
 * `resolveDecision`: a grant on R itself, or on an inheriting ancestor; a share
 * on R, or on an ancestor with includeDescendants. Operator is intrinsic.
 */
function holds(
  op: GfsPermission,
  resourceId: string,
  ancestors: Set<string>,
  grants: GrantRow[],
  shares: ShareRow[]
): boolean {
  for (const g of grants) {
    if (!g.permissions.includes(op)) continue
    if (g.resourceId === resourceId) return true
    if (g.inherit && ancestors.has(g.resourceId)) return true
  }
  for (const s of shares) {
    if (!s.permissions.includes(op)) continue
    if (s.resourceId === resourceId) return true
    if (s.includeDescendants && ancestors.has(s.resourceId)) return true
  }
  return false
}

/**
 * Assert the caller may grant `permissions` to `target` on `resourceId`. Throws
 * GfsGrantError on any violation. Enforces: no-escalation (only bits held,
 * incl. manage_acl, within subtree); a folder owner may never make an agent
 * (`host`) a manager (`manage_acl`/`share`) — operator only.
 */
export async function assertMayGrant(
  db: GrantsDb,
  caller: GfsCaller,
  drive: string,
  resourceId: string,
  permissions: GfsPermission[],
  target: GfsSubject,
  opts: { isShare: boolean }
): Promise<void> {
  // Agent (host) restriction (spec §Delegation): manage_acl/share are never
  // grantable to a host by a folder owner — only the operator can. `share` as a
  // share-grant is for users/teams only, never a host.
  const grantsManagerBit = permissions.includes('manage_acl') || permissions.includes('share')
  if (!caller.isOperator && target.type === 'host' && grantsManagerBit) {
    throw new GfsGrantError(403, 'agent_manager_forbidden')
  }
  if (opts.isShare && target.type === 'host') {
    throw new GfsGrantError(403, 'share_to_agent_forbidden')
  }
  // A non-operator may not grant/share TO the operator subject — the operator is
  // the intrinsic root of trust, never a delegation target. Without this a user
  // holding manage_acl could write a subject_type='operator' grant row (inert,
  // since operator authority is intrinsic, but it pollutes the store + audit).
  if (!caller.isOperator && target.type === 'operator') {
    throw new GfsGrantError(403, 'operator_grant_forbidden')
  }

  // Operator is the intrinsic root of trust — may grant any bit anywhere.
  if (caller.isOperator) return

  const ancestorList = await ancestorsOf(db, drive, resourceId)
  if (ancestorList.length === 0) {
    throw new GfsGrantError(403, opts.isShare ? 'not_sharer' : 'not_manager')
  }
  const ancestors = new Set(ancestorList)
  const [grants, shares] = await Promise.all([
    loadGrants(db, drive, caller.subjects),
    loadShares(db, drive, caller.subjects),
  ])

  // Subtree confinement: the grantor must hold the authority bit on R (or an
  // inheriting ancestor) — `manage_acl` to write a folder grant, `share` to
  // write a URI share (spec §Permission bits). Holding it on R via the inherit
  // rule is exactly "R is within the grantor's subtree".
  const authorityBit: GfsPermission = opts.isShare ? 'share' : 'manage_acl'
  if (!holds(authorityBit, resourceId, ancestors, grants, shares)) {
    throw new GfsGrantError(403, opts.isShare ? 'not_sharer' : 'not_manager')
  }
  // No-escalation: the grantor may only hand out bits it itself holds.
  for (const p of permissions) {
    if (!holds(p, resourceId, ancestors, grants, shares)) {
      throw new GfsGrantError(403, 'escalation_rejected')
    }
  }
}

/**
 * Plain access check: does `caller` hold `op` on `resourceId`? (Used by the
 * move/rename write path — P2-S05.) Operator is intrinsic; otherwise the same
 * allow() evaluation as assertMayGrant (own grant on R, or an inheriting
 * ancestor; share on R, or an includeDescendants ancestor). Returns false for a
 * missing resource — the caller decides whether that is 404 or forbidden.
 */
export async function checkAccess(
  db: GrantsDb,
  caller: GfsCaller,
  drive: string,
  resourceId: string,
  op: GfsPermission
): Promise<boolean> {
  if (caller.isOperator) return true
  const ancestorList = await ancestorsOf(db, drive, resourceId)
  if (ancestorList.length === 0) return false
  const ancestors = new Set(ancestorList)
  const [grants, shares] = await Promise.all([
    loadGrants(db, drive, caller.subjects),
    loadShares(db, drive, caller.subjects),
  ])
  return holds(op, resourceId, ancestors, grants, shares)
}

/**
 * All permission bits the caller holds on a resource — the "all bits" answer the
 * affordances panel needs. Loads ancestors/grants/shares ONCE and maps the pure
 * `holds()` over PERMISSIONS in memory (vs calling checkAccess per-bit, which
 * re-runs the same 3 queries N times serially). Same authority engine, 1/N the
 * queries.
 */
export async function heldPermissions(
  db: GrantsDb,
  caller: GfsCaller,
  drive: string,
  resourceId: string
): Promise<GfsPermission[]> {
  if (caller.isOperator) return [...PERMISSIONS]
  const ancestorList = await ancestorsOf(db, drive, resourceId)
  if (ancestorList.length === 0) return []
  const ancestors = new Set(ancestorList)
  const [grants, shares] = await Promise.all([
    loadGrants(db, drive, caller.subjects),
    loadShares(db, drive, caller.subjects),
  ])
  return PERMISSIONS.filter(op => holds(op, resourceId, ancestors, grants, shares))
}

/**
 * Append one INSERT-only audit row. Mirrors gfsc DbAuditSink content hashing;
 * the full prev_hash→row_hash chaining is completed in P4-S02, so prev_hash is
 * left null here (each row still carries a tamper-evident content row_hash).
 */
export async function auditMutation(
  db: GrantsDb,
  params: {
    actorKey: string
    targetKey: string
    op: string
    drive: string
    resourceId: string
    outcome: 'allowed' | 'denied'
    requestId?: string
    sourceIp?: string
  }
): Promise<string | null> {
  const gfsUri = `gfs://${params.drive}/${params.resourceId}`
  const rowHash = createHash('sha256')
    .update(
      [
        params.targetKey,
        params.op,
        gfsUri,
        params.outcome,
        params.actorKey,
        params.requestId ?? '',
      ].join(' ')
    )
    .digest('hex')
  const result = await db.query(
    `INSERT INTO gfs_audit (subject, actor_on_behalf_of, op, gfs_uri, outcome, source_ip, request_id, row_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING sequence_no::text AS id`,
    [
      params.targetKey,
      params.actorKey,
      params.op,
      gfsUri,
      params.outcome,
      params.sourceIp ?? null,
      params.requestId ?? null,
      rowHash,
    ]
  )
  const row = result.rows[0] as { id?: unknown } | undefined
  return row?.id === null || row?.id === undefined ? null : String(row.id)
}

export function parseSubject(value: unknown): GfsSubject {
  if (typeof value !== 'object' || value === null) {
    throw new GfsGrantError(400, 'subject_invalid')
  }
  const { type, id } = value as { type?: unknown; id?: unknown }
  if (typeof type !== 'string' || !SUBJECT_TYPES.includes(type as GfsSubjectType)) {
    throw new GfsGrantError(400, 'subject_invalid')
  }
  if (type === 'operator') {
    return { type: 'operator' }
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new GfsGrantError(400, 'subject_invalid')
  }
  // user/team subject ids are real UUIDs (users.id / team_members.team_id); reject
  // anything else so a typo can't persist an inert, never-matching grant row.
  if ((type === 'user' || type === 'team') && !UUID_RE.test(id)) {
    throw new GfsGrantError(400, 'subject_invalid')
  }
  // host ids are canonical provisioner principals: 1st/3rd party plus a
  // Kubernetes namespace/name pair. Do not accept free-form host strings here:
  // grants written with a shape the token minter never issues become an inert
  // second source of truth and can mask security-review drift.
  if (type === 'host' && !isValidHostSubjectId(id)) {
    throw new GfsGrantError(400, 'subject_invalid')
  }
  return { type: type as GfsSubjectType, id }
}

export function parsePermissions(value: unknown): GfsPermission[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new GfsGrantError(400, 'permissions_invalid')
  }
  const perms = value.map(p => {
    if (typeof p !== 'string' || !PERMISSIONS.includes(p as GfsPermission)) {
      throw new GfsGrantError(400, 'permissions_invalid')
    }
    return p as GfsPermission
  })
  return Array.from(new Set(perms))
}

export function driveOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_DRIVE
}

export function requestIdOf(req: Request): string | undefined {
  const id = (req as { correlationId?: string }).correlationId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

type GfsPermissionEventOperator = {
  kind: 'control_admin' | 'platform_user'
  sub: string
}

function permissionEventOperator(req: Request, caller: GfsCaller): GfsPermissionEventOperator {
  const adminSub = (req as { adminAuth?: { sub?: string } }).adminAuth?.sub
  if (adminSub) return { kind: 'control_admin', sub: adminSub }
  const userId = (req as { externalAuth?: { userId?: string } }).externalAuth?.userId
  if (userId) return { kind: 'platform_user', sub: userId }
  if (caller.actorKey.startsWith('user:') && caller.actorKey.length > 'user:'.length) {
    return { kind: 'platform_user', sub: caller.actorKey.slice('user:'.length) }
  }
  throw new GfsGrantError(401, 'unauthenticated')
}

function permissionEventSubject(subject: GfsSubject): ControlApiPermissionSubject {
  if (subject.type === 'user' && subject.id) return { kind: 'user', id: subject.id }
  if (subject.type === 'team' && subject.id) return { kind: 'team', id: subject.id }
  const principalKind =
    subject.type === 'operator' || subject.type === 'host' || subject.type === 'context'
      ? subject.type
      : 'service'
  return {
    kind: 'service',
    id: subjectKey(subject),
    principalKind,
  }
}

function permissionsDetailRef(permissions: readonly string[]): string {
  return `gfs_permissions/${[...new Set(permissions)].sort().join('.')}`
}

export async function appendGfsPermissionEvent(
  db: DbClient,
  params: {
    req: Request
    caller: GfsCaller
    subject: GfsSubject
    permissions: readonly string[]
    drive: string
    resourceId: string
    mutation: 'grant' | 'share'
    action: 'grant' | 'revoke'
    outcome: 'committed' | 'rejected'
    auditId: string | null
  }
): Promise<void> {
  const operator = permissionEventOperator(params.req, params.caller)
  await appendControlApiPermissionEventsInTransaction(db, {
    operatorSub: operator.sub,
    operatorKind: operator.kind,
    requestId: requestIdOf(params.req) ?? null,
    changes: [
      {
        action: params.action,
        resourceClass: params.mutation === 'grant' ? 'gfs_folder_grant' : 'gfs_share',
        resourceRef: `gfs://${params.drive}/${params.resourceId}`,
        subject: permissionEventSubject(params.subject),
        sourceAuditRef: params.auditId ? `gfs_audit:${params.auditId}` : null,
        status:
          params.outcome === 'rejected'
            ? `${params.mutation}_${params.action}_rejected`
            : `${params.mutation}_${params.action === 'grant' ? 'configured' : 'revoked'}`,
        detailRef: permissionsDetailRef(params.permissions),
        count: new Set(params.permissions).size,
        outcome: params.outcome,
        authorizationDecision: params.outcome === 'rejected' ? 'deny' : 'allow',
      },
    ],
  })
}

export function registerGfsGrantRoutes(router: Router): void {
  // Operator (Control UI) seeds Layer-1/2 folder grants. The no-escalation
  // engine (assertMayGrant) is caller-agnostic; the Profile/Desktop folder-owner
  // delegation surface (external user session) wires onto it when that UI lands.
  router.put('/gfs/grants', requireAuthForControlUI, asyncHandler(handleGrantWrite))
  router.delete('/gfs/grants/:id', requireAuthForControlUI, asyncHandler(handleGrantDelete))
}

export async function handleGrantWrite(
  req: Request,
  res: import('express').Response
): Promise<void> {
  try {
    const caller = resolveCaller(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const drive = driveOf(body.drive)
    const resourceId = String(body.resourceId ?? '')
    if (!UUID_RE.test(resourceId)) {
      res.status(400).json({ error: 'resource_invalid' })
      return
    }
    const subject = parseSubject(body.subject)
    const permissions = parsePermissions(body.permissions)
    const inherit = Boolean(body.inherit)
    const result = await withTransaction(async db => {
      try {
        await assertMayGrant(db, caller, drive, resourceId, permissions, subject, {
          isShare: false,
        })
      } catch (error) {
        if (!(error instanceof GfsGrantError)) throw error
        const auditId = await auditMutation(db, {
          actorKey: caller.actorKey,
          targetKey: subjectKey(subject),
          op: `grant.put[${permissions.join(',')}]`,
          drive,
          resourceId,
          outcome: 'denied',
          requestId: requestIdOf(req),
          sourceIp: req.ip,
        })
        await appendGfsPermissionEvent(db, {
          req,
          caller,
          subject,
          permissions,
          drive,
          resourceId,
          mutation: 'grant',
          action: 'grant',
          outcome: 'rejected',
          auditId,
        })
        return { error }
      }

      await db.query(
        `INSERT INTO gfs_grants (drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (drive, resource_id, subject_type, subject_id)
         DO UPDATE SET permissions = EXCLUDED.permissions, inherit = EXCLUDED.inherit,
                       granted_by = EXCLUDED.granted_by, updated_at = now()`,
        [drive, resourceId, subject.type, subject.id ?? '', permissions, inherit, caller.actorKey]
      )
      const auditId = await auditMutation(db, {
        actorKey: caller.actorKey,
        targetKey: subjectKey(subject),
        op: `grant.put[${permissions.join(',')}]`,
        drive,
        resourceId,
        outcome: 'allowed',
        requestId: requestIdOf(req),
        sourceIp: req.ip,
      })
      await appendGfsPermissionEvent(db, {
        req,
        caller,
        subject,
        permissions,
        drive,
        resourceId,
        mutation: 'grant',
        action: 'grant',
        outcome: 'committed',
        auditId,
      })
      return { error: null }
    })
    if (result.error) {
      res.status(result.error.status).json({ error: result.error.code })
      return
    }
    res.status(200).json({ ok: true })
  } catch (err) {
    if (err instanceof GfsGrantError) {
      res.status(err.status).json({ error: err.code })
      return
    }
    throw err
  }
}

export async function handleGrantDelete(
  req: Request,
  res: import('express').Response
): Promise<void> {
  try {
    const caller = resolveCaller(req)
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'grant_invalid' })
      return
    }
    const result = await withTransaction(async db => {
      const existing = await db.query(
        `SELECT drive, resource_id, subject_type, subject_id, permissions
           FROM gfs_grants WHERE id = $1::uuid
           FOR UPDATE`,
        [id]
      )
      if (existing.rows.length === 0) return { kind: 'not_found' as const }
      const row = existing.rows[0] as {
        drive: string
        resource_id: string
        subject_type: string
        subject_id: string
        permissions: string[]
      }
      const subject = {
        type: row.subject_type as GfsSubjectType,
        id: row.subject_id || undefined,
      }
      // Revoking uses the same no-escalation gate as granting. A lower authority
      // cannot remove access that was seeded with permissions it does not hold.
      try {
        await assertMayGrant(
          db,
          caller,
          row.drive,
          String(row.resource_id),
          (row.permissions as GfsPermission[]) ?? ['manage_acl'],
          subject,
          { isShare: false }
        )
      } catch (error) {
        if (!(error instanceof GfsGrantError)) throw error
        const auditId = await auditMutation(db, {
          actorKey: caller.actorKey,
          targetKey: subjectKey(subject),
          op: 'grant.delete',
          drive: row.drive,
          resourceId: String(row.resource_id),
          outcome: 'denied',
          requestId: requestIdOf(req),
          sourceIp: req.ip,
        })
        await appendGfsPermissionEvent(db, {
          req,
          caller,
          subject,
          permissions: row.permissions,
          drive: row.drive,
          resourceId: String(row.resource_id),
          mutation: 'grant',
          action: 'revoke',
          outcome: 'rejected',
          auditId,
        })
        return { kind: 'denied' as const, error }
      }
      await db.query(`DELETE FROM gfs_grants WHERE id = $1::uuid`, [id])
      const auditId = await auditMutation(db, {
        actorKey: caller.actorKey,
        targetKey: subjectKey(subject),
        op: 'grant.delete',
        drive: row.drive,
        resourceId: String(row.resource_id),
        outcome: 'allowed',
        requestId: requestIdOf(req),
        sourceIp: req.ip,
      })
      await appendGfsPermissionEvent(db, {
        req,
        caller,
        subject,
        permissions: row.permissions,
        drive: row.drive,
        resourceId: String(row.resource_id),
        mutation: 'grant',
        action: 'revoke',
        outcome: 'committed',
        auditId,
      })
      return { kind: 'ok' as const }
    })
    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'grant_not_found' })
      return
    }
    if (result.kind === 'denied') {
      res.status(result.error.status).json({ error: result.error.code })
      return
    }
    res.status(200).json({ ok: true })
  } catch (err) {
    if (err instanceof GfsGrantError) {
      res.status(err.status).json({ error: err.code })
      return
    }
    throw err
  }
}
