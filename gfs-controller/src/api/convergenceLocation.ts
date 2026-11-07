import type { GfsVerifiedClaims } from '../auth/verify'
import type {
  AuthorizationRequest,
  AuthzContext,
  PermissionClient,
} from '../authz/permissionClient'
import type { Decision } from '../authz/resolve'
import { GfsSubjectResolutionDeniedError } from '../authz/subjectResolver'
import { checkTokenCeiling } from '../authz/tokenCeiling'
import type { DeadlinePool } from '../db/deadlineQuery'
import { withReadAdmissionSnapshot } from '../db/deadlineQuery'
import type { Queryable } from '../db/resourceStore'
import { GfsError } from './errors'

export interface ConvergenceLocationEntry {
  resourceId: string
  rid: string
  gfsUri: string
  name: string
  kind: 'file' | 'directory'
  version: number
}

export type ConvergenceLocationResult =
  | { available: true; location: ConvergenceLocationEntry; breadcrumbs: ConvergenceLocationEntry[] }
  | { available: false }

export interface ConvergenceLocationDependencies {
  pool: DeadlinePool
  permissions: PermissionClient
  resolveContext: (
    db: Queryable,
    claims: GfsVerifiedClaims,
    requestId?: string
  ) => Promise<AuthzContext>
}

interface SnapshotNode {
  resourceId: string
  parentResourceId: string | null
  name: string
  kind: 'file' | 'directory'
  pathCache: string | null
  version: number
  deletedAt: Date | string | null
  depth: number
  cycle: boolean
}

interface CandidateDecision {
  node: SnapshotNode
  decision: Decision
}

function toEntry(drive: string, node: SnapshotNode): ConvergenceLocationEntry {
  const rid = node.resourceId.replaceAll('-', '').toLowerCase()
  return {
    resourceId: node.resourceId,
    rid,
    gfsUri: `gfs://${drive}/${rid}`,
    name: node.name,
    kind: node.kind,
    version: node.version,
  }
}

function deniedDecision(): Decision {
  return { allowed: false, via: null, matchedSubject: null, authorizationSource: null }
}

function fallbackAuditContext(claims: GfsVerifiedClaims, requestId?: string): AuthzContext {
  const linked = claims.brokeredAuthority
  return {
    drive: claims.drive,
    subjects: [],
    isOperator: false,
    primarySubject: claims.sub,
    ...(linked
      ? {
          desktopUserId: linked.desktopUserId,
          effectiveControlAdminId: linked.controlAdminId,
          authoritySource: 'linked-admin' as const,
        }
      : claims.principalType === 'user'
        ? { desktopUserId: claims.sub, authoritySource: 'user-session' as const }
        : {}),
    requestId,
  }
}

function normalizeResourceId(raw: string): string {
  const compact = raw.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new GfsError('path_invalid', 'convergence target is invalid')
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

async function loadSnapshotChain(
  db: Queryable,
  drive: string,
  resourceId: string
): Promise<SnapshotNode[]> {
  const result = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT r.resource_id, r.parent_resource_id, r.name, r.kind, r.path_cache,
              r.version, r.deleted_at, 0 AS depth,
              ARRAY[r.resource_id]::uuid[] AS visited, false AS cycle
         FROM gfs_resources r
        WHERE r.drive = $1 AND r.resource_id = $2
       UNION ALL
       SELECT parent.resource_id, parent.parent_resource_id, parent.name, parent.kind,
              parent.path_cache, parent.version, parent.deleted_at, child.depth + 1,
              child.visited || parent.resource_id,
              parent.resource_id = ANY(child.visited) AS cycle
         FROM chain child
         JOIN gfs_resources parent
           ON parent.drive = $1 AND parent.resource_id = child.parent_resource_id
        WHERE NOT child.cycle
     )
     SELECT resource_id, parent_resource_id, name, kind, path_cache, version,
            deleted_at, depth, cycle
       FROM chain
      ORDER BY depth ASC`,
    [drive, resourceId]
  )
  return result.rows.map(row => ({
    resourceId: String(row.resource_id),
    parentResourceId: row.parent_resource_id == null ? null : String(row.parent_resource_id),
    name: String(row.name),
    kind: String(row.kind) === 'directory' ? 'directory' : 'file',
    pathCache: row.path_cache == null ? null : String(row.path_cache),
    version: Number(row.version),
    deletedAt: row.deleted_at == null ? null : (row.deleted_at as Date | string),
    depth: Number(row.depth),
    cycle: Boolean(row.cycle),
  }))
}

/**
 * Resolve a saved Files target against one current, uncached PostgreSQL
 * authorization snapshot. Only readable live rows are projected to the caller;
 * tombstones and inaccessible ancestors contribute no returned metadata.
 */
export async function resolveConvergenceLocation(
  deps: ConvergenceLocationDependencies,
  claims: GfsVerifiedClaims,
  requestId: string | undefined,
  rawResourceId: string
): Promise<ConvergenceLocationResult> {
  const targetId = normalizeResourceId(rawResourceId)
  const targetRequest: AuthorizationRequest = { resourceId: targetId, op: 'read' }
  let auditContext = fallbackAuditContext(claims, requestId)
  let auditRows: CandidateDecision[] = []
  let auditFallbackReason: string | undefined
  let completed = false

  try {
    const resolved = await withReadAdmissionSnapshot(deps.pool, async client => {
      const ctx = await deps.resolveContext(client, claims, requestId)
      auditContext = ctx
      const chain = await loadSnapshotChain(client, claims.drive, targetId)
      if (chain.length === 0 || chain.some(node => node.cycle)) {
        auditFallbackReason = chain.length === 0 ? 'target_unavailable' : 'ancestry_cycle'
        return { ctx, candidates: [] as CandidateDecision[] }
      }

      const live = chain.filter(node => node.deletedAt === null)
      const requests = live.map(node => ({ resourceId: node.resourceId, op: 'read' as const }))
      const decisions = await deps.permissions.authorizeFreshWithinSnapshot(ctx, requests, client)
      const candidates = live.map((node, index) => {
        const ceiling = checkTokenCeiling({
          scopes: claims.scopes,
          pathBindings: claims.pathBindings,
          op: 'read',
          resourcePath: claims.pathBindings.length === 0 ? null : node.pathCache,
        })
        return {
          node,
          decision: ceiling.allowed ? (decisions[index] ?? deniedDecision()) : deniedDecision(),
        }
      })
      return { ctx, candidates }
    })
    auditRows = resolved.candidates
    completed = true

    if (auditRows.length === 0) {
      await deps.permissions.recordReadAdmissionFailure(
        auditContext,
        targetRequest,
        auditFallbackReason ?? 'no_authorized_location'
      )
      return { available: false }
    }
    for (const { node, decision } of auditRows) {
      await deps.permissions.recordReadAdmission(
        auditContext,
        { resourceId: node.resourceId, op: 'read' },
        decision
      )
    }
    const selectedIndex = auditRows.findIndex(row => row.decision.allowed)
    if (selectedIndex < 0) return { available: false }

    const selected = auditRows[selectedIndex]
    const authorizedAncestors = auditRows
      .slice(selectedIndex)
      .filter(row => row.decision.allowed)
      .reverse()
      .map(row => toEntry(claims.drive, row.node))
    return {
      available: true,
      location: toEntry(claims.drive, selected.node),
      breadcrumbs: authorizedAncestors,
    }
  } catch (error) {
    if (!completed) {
      try {
        await deps.permissions.recordReadAdmissionFailure(
          auditContext,
          targetRequest,
          error instanceof GfsSubjectResolutionDeniedError
            ? 'subject_not_current'
            : 'convergence_resolution_failed'
        )
      } catch {
        return { available: false }
      }
    }
    return { available: false }
  }
}
