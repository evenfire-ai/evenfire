import type { Request, Response, Router } from 'express'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import {
  assertMayGrant,
  auditMutation,
  driveOf,
  GfsGrantError,
  type GfsPermission,
  type GfsSubjectType,
  parsePermissions,
  parseSubject,
  requestIdOf,
  resolveCaller,
  subjectKey,
  UUID_RE,
} from './grants.js'

/**
 * gfs URI-bound share write API (Layer 3). A share grants a single resource (or
 * its subtree, with includeDescendants) to a subject that has no folder grant.
 * The authority to create/revoke a share is the `share` permission bit; the
 * sharer may only share bits it itself holds (no-escalation), and shares target
 * users/teams only — never an agent (host). Enforcement is the same engine as
 * folder grants (grants.ts assertMayGrant with isShare:true).
 */

export function registerGfsShareRoutes(router: Router): void {
  router.post('/gfs/shares', requireAuthForControlUI, asyncHandler(handleShareWrite))
  router.delete('/gfs/shares/:id', requireAuthForControlUI, asyncHandler(handleShareDelete))
}

export async function handleShareWrite(req: Request, res: Response): Promise<void> {
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
    const includeDescendants = Boolean(body.includeDescendants)

    try {
      await assertMayGrant(pool, caller, drive, resourceId, permissions, subject, { isShare: true })
    } catch (err) {
      if (err instanceof GfsGrantError) {
        await auditMutation(pool, {
          actorKey: caller.actorKey,
          targetKey: subjectKey(subject),
          op: `share.create[${permissions.join(',')}]`,
          drive,
          resourceId,
          outcome: 'denied',
          requestId: requestIdOf(req),
          sourceIp: req.ip,
        })
        res.status(err.status).json({ error: err.code })
        return
      }
      throw err
    }

    await pool.query(
      `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants, created_by)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
       ON CONFLICT (drive, resource_id, subject_type, subject_id)
       DO UPDATE SET permissions = EXCLUDED.permissions,
                     include_descendants = EXCLUDED.include_descendants,
                     created_by = EXCLUDED.created_by`,
      [drive, resourceId, subject.type, subject.id ?? '', permissions, includeDescendants, caller.actorKey]
    )
    await auditMutation(pool, {
      actorKey: caller.actorKey,
      targetKey: subjectKey(subject),
      op: `share.create[${permissions.join(',')}]`,
      drive,
      resourceId,
      outcome: 'allowed',
      requestId: requestIdOf(req),
      sourceIp: req.ip,
    })
    res.status(200).json({ ok: true })
  } catch (err) {
    if (err instanceof GfsGrantError) {
      res.status(err.status).json({ error: err.code })
      return
    }
    throw err
  }
}

export async function handleShareDelete(req: Request, res: Response): Promise<void> {
  try {
    const caller = resolveCaller(req)
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'share_invalid' })
      return
    }
    const existing = await pool.query(
      `SELECT drive, resource_id, subject_type, subject_id, permissions
         FROM gfs_shares WHERE id = $1::uuid`,
      [id]
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'share_not_found' })
      return
    }
    const row = existing.rows[0] as {
      drive: string
      resource_id: string
      subject_type: string
      subject_id: string
      permissions: string[]
    }
    // Revoking a share is itself a `share`-authority act — same no-escalation gate.
    await assertMayGrant(
      pool,
      caller,
      row.drive,
      String(row.resource_id),
      (row.permissions as GfsPermission[]) ?? ['share'],
      { type: row.subject_type as GfsSubjectType, id: row.subject_id || undefined },
      { isShare: true }
    )
    await pool.query(`DELETE FROM gfs_shares WHERE id = $1::uuid`, [id])
    await auditMutation(pool, {
      actorKey: caller.actorKey,
      targetKey: `${row.subject_type}:${row.subject_id ?? ''}`,
      op: 'share.delete',
      drive: row.drive,
      resourceId: String(row.resource_id),
      outcome: 'allowed',
      requestId: requestIdOf(req),
      sourceIp: req.ip,
    })
    res.status(200).json({ ok: true })
  } catch (err) {
    if (err instanceof GfsGrantError) {
      res.status(err.status).json({ error: err.code })
      return
    }
    throw err
  }
}
