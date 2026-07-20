import type { Request, Response, Router } from 'express'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import {
  type GfsCaller,
  type GrantsDb,
  UUID_RE,
  ancestorsOf,
  auditMutation,
  checkAccess,
  driveOf,
  requestIdOf,
  resolveCaller,
} from './grants.js'

/**
 * gfs resource mutation — PATCH /resources/:id = rename and/or move (spec
 * community.md §Move, rename, delete). A move is a pure DB reparent (bytes are
 * flat by resourceId). control-api is the sole writer of resource rows (CC6);
 * the move rules mirror the writer-routed gfs-controller/src/api/move.ts (the
 * two live in different packages — a shared @clerum/gfs-authz extraction is a
 * known follow-up).
 *
 * Authorization (no operator bypass for non-operators): rename → write on the
 * resource; move → write+delete on the source parent + write on the destination
 * parent. Cross-drive move → 403 cross_boundary. Optimistic concurrency: a
 * stale If-Match (or a concurrent version bump) → 412 precondition_failed.
 */

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
}

export interface ResourcePatch {
  newName?: unknown
  newParentId?: unknown
  ifMatch?: unknown
}

async function loadResource(db: GrantsDb, resourceId: string): Promise<ResourceRow | null> {
  const res = await db.query(
    `SELECT resource_id, drive, parent_resource_id, name, kind, version
       FROM gfs_resources WHERE resource_id = $1::uuid AND deleted_at IS NULL`,
    [resourceId]
  )
  return (res.rows[0] as ResourceRow | undefined) ?? null
}

/**
 * Authorize and apply a rename/move. Pure of HTTP — throws ResourcePatchError
 * with the spec error code; tests drive it with a fake GrantsDb. Returns the new
 * version (etag).
 */
export async function applyResourcePatch(
  db: GrantsDb,
  caller: GfsCaller,
  drive: string,
  resourceId: string,
  patch: ResourcePatch,
  audit: (params: Parameters<typeof auditMutation>[1]) => Promise<void>
): Promise<{ version: number }> {
  const resource = await loadResource(db, resourceId)
  if (!resource || resource.drive !== drive) {
    throw new ResourcePatchError(404, 'not_found')
  }

  const wantsRename = patch.newName !== undefined
  const wantsMove = patch.newParentId !== undefined
  if (!wantsRename && !wantsMove) {
    throw new ResourcePatchError(400, 'path_invalid')
  }

  // Optimistic concurrency: a provided If-Match must equal the current version.
  if (patch.ifMatch !== undefined) {
    const ifMatch = Number(patch.ifMatch)
    if (!Number.isInteger(ifMatch) || ifMatch !== resource.version) {
      throw new ResourcePatchError(412, 'precondition_failed')
    }
  }

  const name = wantsRename ? validateName(patch.newName) : resource.name
  let newParentId: string | null = resource.parent_resource_id
  const op = wantsMove
    ? wantsRename
      ? 'resource.rename+move'
      : 'resource.move'
    : 'resource.rename'

  // Authorization with audited denials (spec: every authz denial is audited).
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
    const dest = String(patch.newParentId)
    if (!UUID_RE.test(dest)) throw new ResourcePatchError(400, 'path_invalid')
    if (resource.parent_resource_id === null) throw new ResourcePatchError(400, 'path_invalid')
    const destRow = await loadResource(db, dest)
    if (!destRow) throw new ResourcePatchError(404, 'not_found')
    if (destRow.drive !== resource.drive) throw new ResourcePatchError(403, 'cross_boundary')
    if (destRow.kind !== 'directory') throw new ResourcePatchError(400, 'not_a_directory')
    // Cycle guard: never move a resource into itself or one of its descendants
    // (would orphan the subtree and loop ancestor traversal).
    const destAncestors = await ancestorsOf(db, drive, dest)
    if (dest === resourceId || destAncestors.includes(resourceId)) {
      throw new ResourcePatchError(400, 'path_invalid')
    }
    // move authority: write+delete on source parent, write on destination parent.
    await requireAccess('write', resource.parent_resource_id)
    await requireAccess('delete', resource.parent_resource_id)
    await requireAccess('write', dest)
    newParentId = dest
  }

  // Apply with a version guard (catches a concurrent bump → precondition_failed).
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
    // Sibling uniqueness violation in the destination directory.
    if ((err as { code?: string }).code === '23505') {
      throw new ResourcePatchError(409, 'already_exists')
    }
    throw err
  }
  if (updated.rows.length === 0) {
    throw new ResourcePatchError(412, 'precondition_failed')
  }
  const version = Number((updated.rows[0] as { version: number }).version)

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
    const { version } = await applyResourcePatch(pool, caller, drive, id, body, async params => {
      await auditMutation(pool, { ...params, requestId, sourceIp })
    })
    res.status(200).json({ ok: true, data: { resourceId: id, version } })
  } catch (err) {
    if (err instanceof ResourcePatchError) {
      res.status(err.status).json({ ok: false, error: { code: err.code, message: err.code } })
      return
    }
    throw err
  }
}
