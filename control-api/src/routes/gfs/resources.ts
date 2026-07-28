/**
 * User-plane resource PATCH (rename/move). The structural protocol below
 * (advisory structure lock, ancestor-chain revalidation, sorted FOR UPDATE row
 * locks, subtree path recompute) mirrors gfs-controller/src/db/writeStore.ts —
 * the two live in different packages, and a shared @clerum/gfs-authz
 * extraction of the drive-lock + tree-walk skeleton is a known follow-up.
 */
import type { Request, Response, Router } from 'express'
import { withTransaction } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import {
  type GfsCaller,
  type GrantsDb,
  UUID_RE,
  auditMutation,
  checkAccess,
  driveOf,
  requestIdOf,
  resolveCaller,
} from './grants.js'

const NAME_MAX = 255
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/
export class ResourcePatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'ResourcePatchError'
  }
}

function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ResourcePatchError(400, 'path_invalid')
  const name = raw.normalize('NFC')
  if (
    name.length === 0 ||
    name.length > NAME_MAX ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    CONTROL_CHARS.test(name)
  ) {
    throw new ResourcePatchError(400, 'path_invalid')
  }
  return name
}

interface ResourceRow {
  resource_id: string
  drive: string
  parent_resource_id: string | null
  name: string
  kind: string
  version: number
  deleted_at: string | null
}

export interface ResourcePatch {
  newName?: unknown
  newParentId?: unknown
  ifMatch?: unknown
}

async function loadResource(db: GrantsDb, resourceId: string): Promise<ResourceRow | null> {
  const res = await db.query(
    `SELECT resource_id, drive, parent_resource_id, name, kind, version, deleted_at
       FROM gfs_resources WHERE resource_id = $1::uuid`,
    [resourceId]
  )
  return (res.rows[0] as ResourceRow | undefined) ?? null
}

interface AncestorRow extends ResourceRow {
  cycle: boolean
}
async function acquireStructureLock(db: GrantsDb, drive: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)`, [drive])
}

async function lockRows(db: GrantsDb, resourceIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(resourceIds)].sort()
  if (ids.length === 0) return
  await db.query(
    `SELECT resource_id
       FROM gfs_resources
      WHERE resource_id = ANY($1::uuid[])
      ORDER BY resource_id
      FOR UPDATE`,
    [ids]
  )
}

async function loadAncestorChain(db: GrantsDb, resourceId: string): Promise<AncestorRow[]> {
  const result = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.version, r.deleted_at,
              ARRAY[r.resource_id]::uuid[] AS visited, false AS cycle
         FROM gfs_resources r WHERE r.resource_id = $1::uuid
       UNION ALL
       SELECT p.resource_id, p.drive, p.parent_resource_id, p.name, p.kind,
              p.version, p.deleted_at, c.visited || p.resource_id,
              p.resource_id = ANY(c.visited) AS cycle
         FROM chain c JOIN gfs_resources p ON p.resource_id = c.parent_resource_id WHERE NOT c.cycle
     )
     SELECT resource_id, drive, parent_resource_id, name, kind, version, deleted_at, cycle
       FROM chain`,
    [resourceId]
  )
  return result.rows as AncestorRow[]
}

function assertLiveDirectoryChain(rows: AncestorRow[], drive: string): void {
  if (
    rows.length === 0 ||
    rows.some(
      row => row.cycle || row.deleted_at !== null || row.drive !== drive || row.kind !== 'directory'
    ) ||
    rows.at(-1)?.parent_resource_id !== null
  ) {
    throw new ResourcePatchError(412, 'precondition_failed')
  }
}

function directoryPath(rows: AncestorRow[]): string {
  const names = rows
    .slice(0, -1)
    .map(row => row.name)
    .reverse()
  return names.length === 0 ? '/' : `/${names.join('/')}`
}
const sameChain = (a: AncestorRow[], b: AncestorRow[]) =>
  a.length === b.length && a.every((row, i) => row.resource_id === b[i]?.resource_id)
async function refreshSubtreePaths(
  db: GrantsDb,
  drive: string,
  resourceId: string,
  rootPath: string
): Promise<void> {
  const result = await db.query(
    `WITH RECURSIVE subtree AS (
       SELECT r.resource_id, $3::text canonical_path,
              ARRAY[r.resource_id]::uuid[] visited, false cycle FROM gfs_resources r
        WHERE r.resource_id = $2::uuid AND r.drive = $1 AND r.deleted_at IS NULL
       UNION ALL
       SELECT child.resource_id,
              CASE WHEN parent.canonical_path = '/' THEN '/' || child.name
                   ELSE parent.canonical_path || '/' || child.name END,
              parent.visited || child.resource_id, child.resource_id = ANY(parent.visited)
         FROM subtree parent JOIN gfs_resources child ON child.parent_resource_id = parent.resource_id
          AND child.drive = $1 AND child.deleted_at IS NULL WHERE NOT parent.cycle
     ),
     canonical AS (
       SELECT resource_id, canonical_path FROM subtree WHERE NOT cycle
     ),
     updated AS (
       UPDATE gfs_resources resource SET path_cache = canonical.canonical_path, updated_at = now()
         FROM canonical WHERE resource.resource_id = canonical.resource_id RETURNING resource.resource_id
     )
     SELECT (SELECT count(DISTINCT resource_id) FROM subtree WHERE NOT cycle) AS expected_count,
       (SELECT count(*) FROM updated) AS updated_count,
       (SELECT count(*) FROM canonical) AS canonical_count,
       (SELECT count(DISTINCT canonical_path) FROM canonical) AS distinct_path_count,
       EXISTS (SELECT 1 FROM subtree WHERE cycle) AS has_cycle`,
    [drive, resourceId, rootPath]
  )
  const row = result.rows[0] as Record<string, string | number | boolean> | undefined
  if (!row) throw new ResourcePatchError(412, 'precondition_failed')
  const expected = Number(row.expected_count)
  if (
    row.has_cycle ||
    expected === 0 ||
    Number(row.updated_count) !== expected ||
    Number(row.canonical_count) !== expected ||
    Number(row.distinct_path_count) !== expected
  ) {
    throw new ResourcePatchError(412, 'precondition_failed')
  }
}

export async function applyResourcePatch(
  db: GrantsDb,
  caller: GfsCaller,
  drive: string,
  resourceId: string,
  patch: ResourcePatch,
  audit: (params: Parameters<typeof auditMutation>[1]) => Promise<void>
): Promise<{ version: number }> {
  await acquireStructureLock(db, drive)

  const observedResource = await loadResource(db, resourceId)
  if (!observedResource || observedResource.deleted_at !== null || observedResource.drive !== drive)
    throw new ResourcePatchError(404, 'not_found')
  const wantsRename = patch.newName !== undefined
  const wantsMove = patch.newParentId !== undefined
  if (!wantsRename && !wantsMove) throw new ResourcePatchError(400, 'path_invalid')
  const op = wantsMove
    ? wantsRename
      ? 'resource.rename+move'
      : 'resource.move'
    : 'resource.rename'

  let ifMatch: number | undefined
  if (patch.ifMatch !== undefined) {
    ifMatch = Number(patch.ifMatch)
    if (!Number.isInteger(ifMatch)) throw new ResourcePatchError(412, 'precondition_failed')
  }

  const requestedName = wantsRename ? validateName(patch.newName) : observedResource.name
  const requestedDestination = wantsMove ? String(patch.newParentId) : null
  if (wantsMove && !UUID_RE.test(requestedDestination!))
    throw new ResourcePatchError(400, 'path_invalid')

  const observedDestination = requestedDestination
    ? await loadResource(db, requestedDestination)
    : null
  if (requestedDestination && (!observedDestination || observedDestination.deleted_at !== null))
    throw new ResourcePatchError(404, 'not_found')
  if (requestedDestination && observedDestination?.drive !== drive) {
    await audit({
      actorKey: caller.actorKey,
      targetKey: caller.actorKey,
      op,
      drive,
      resourceId,
      outcome: 'denied',
    })
    throw new ResourcePatchError(403, 'cross_boundary')
  }
  if (requestedDestination && observedDestination?.kind !== 'directory')
    throw new ResourcePatchError(400, 'not_a_directory')
  const initialChains = await Promise.all([
    observedResource.parent_resource_id
      ? loadAncestorChain(db, observedResource.parent_resource_id)
      : Promise.resolve([]),
    requestedDestination ? loadAncestorChain(db, requestedDestination) : Promise.resolve([]),
  ])
  if (initialChains.flat().some(row => row.drive !== drive))
    throw new ResourcePatchError(412, 'precondition_failed')
  await lockRows(db, [
    resourceId,
    ...(observedResource.parent_resource_id ? [observedResource.parent_resource_id] : []),
    ...(requestedDestination ? [requestedDestination] : []),
    ...initialChains.flat().map(row => row.resource_id),
  ])

  const resource = await loadResource(db, resourceId)
  if (!resource || resource.deleted_at !== null || resource.drive !== drive)
    throw new ResourcePatchError(412, 'precondition_failed')
  if (
    resource.parent_resource_id !== observedResource.parent_resource_id ||
    resource.version !== observedResource.version
  )
    throw new ResourcePatchError(412, 'precondition_failed')
  if (resource.parent_resource_id === null) throw new ResourcePatchError(400, 'path_invalid')
  if (ifMatch !== undefined && ifMatch !== resource.version)
    throw new ResourcePatchError(412, 'precondition_failed')

  const sourceChain = await loadAncestorChain(db, resource.parent_resource_id)
  assertLiveDirectoryChain(sourceChain, drive)
  if (!sameChain(sourceChain, initialChains[0]))
    throw new ResourcePatchError(412, 'precondition_failed')
  const name = wantsRename ? requestedName : resource.name
  let newParentId: string | null = resource.parent_resource_id
  let parentChain = sourceChain

  const requireAccess = async (
    bit: 'read' | 'write' | 'delete' | 'manage_acl' | 'share',
    rid: string
  ): Promise<void> => {
    if (!(await checkAccess(db, caller, drive, rid, bit))) {
      await audit({
        actorKey: caller.actorKey,
        targetKey: caller.actorKey,
        op,
        drive,
        resourceId,
        outcome: 'denied',
      })
      throw new ResourcePatchError(403, 'forbidden')
    }
  }

  if (wantsRename) {
    await requireAccess('write', resourceId)
  }

  if (wantsMove) {
    const dest = requestedDestination!
    const destRow = await loadResource(db, dest)
    const observedDest = observedDestination!
    if (
      !destRow ||
      destRow.deleted_at !== null ||
      destRow.drive !== observedDest.drive ||
      destRow.kind !== observedDest.kind ||
      destRow.parent_resource_id !== observedDest.parent_resource_id ||
      destRow.version !== observedDest.version
    )
      throw new ResourcePatchError(412, 'precondition_failed')
    const destinationChain = await loadAncestorChain(db, dest)
    assertLiveDirectoryChain(destinationChain, drive)
    if (!sameChain(destinationChain, initialChains[1]))
      throw new ResourcePatchError(412, 'precondition_failed')
    if (dest === resourceId || destinationChain.some(row => row.resource_id === resourceId)) {
      throw new ResourcePatchError(400, 'path_invalid')
    }
    await requireAccess('write', resource.parent_resource_id)
    await requireAccess('delete', resource.parent_resource_id)
    await requireAccess('write', dest)
    newParentId = dest
    parentChain = destinationChain
  }
  let updated
  try {
    updated = await db.query(
      `UPDATE gfs_resources
          SET name = $1, parent_resource_id = $2::uuid, version = version + 1, updated_at = now()
        WHERE resource_id = $3::uuid AND version = $4 AND deleted_at IS NULL
        RETURNING version`,
      [name, newParentId, resourceId, resource.version]
    )
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ResourcePatchError(409, 'already_exists')
    }
    throw err
  }
  if (updated.rows.length === 0) throw new ResourcePatchError(412, 'precondition_failed')
  const version = Number((updated.rows[0] as { version: number }).version)

  const parentPath = directoryPath(parentChain)
  const rootPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
  await refreshSubtreePaths(db, drive, resourceId, rootPath)
  await audit({
    actorKey: caller.actorKey,
    targetKey: caller.actorKey,
    op,
    drive,
    resourceId,
    outcome: 'allowed',
  })
  return { version }
}

export function registerGfsResourceRoutes(router: Router): void {
  router.patch('/gfs/resources/:id', requireAuthForControlUI, asyncHandler(handlePatch))
}

export async function handlePatch(req: Request, res: Response): Promise<void> {
  try {
    const caller = resolveCaller(req)
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) {
      res
        .status(400)
        .json({ ok: false, error: { code: 'path_invalid', message: 'invalid resource id' } })
      return
    }
    const body = (req.body ?? {}) as ResourcePatch
    const drive = driveOf(
      (req.query as { drive?: unknown }).drive ?? (body as { drive?: unknown }).drive
    )
    const requestId = requestIdOf(req)
    const sourceIp = req.ip
    let denied: ResourcePatchError | undefined
    const patched = await withTransaction(async db => {
      try {
        return await applyResourcePatch(db, caller, drive, id, body, async params => {
          await auditMutation(db, { ...params, requestId, sourceIp })
        })
      } catch (err) {
        if (err instanceof ResourcePatchError && err.status === 403) {
          denied = err
          return null
        }
        throw err
      }
    })
    if (denied) throw denied
    if (!patched) throw new ResourcePatchError(500, 'internal_error')
    const { version } = patched
    res.status(200).json({ ok: true, data: { resourceId: id, version } })
  } catch (err) {
    if (err instanceof ResourcePatchError) {
      res.status(err.status).json({ ok: false, error: { code: err.code, message: err.code } })
      return
    }
    throw err
  }
}
