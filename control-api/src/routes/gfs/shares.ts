import type { Request, Response, Router } from 'express'
import { withTransaction } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import {
  GfsGrantError,
  type GfsPermission,
  type GfsSubjectType,
  UUID_RE,
  appendGfsPermissionEvent,
  assertMayGrant,
  auditMutation,
  driveOf,
  parsePermissions,
  parseSubject,
  requestIdOf,
  resolveCaller,
  subjectKey,
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

    const result = await withTransaction(async db => {
      try {
        await assertMayGrant(db, caller, drive, resourceId, permissions, subject, {
          isShare: true,
        })
      } catch (error) {
        if (!(error instanceof GfsGrantError)) throw error
        const auditId = await auditMutation(db, {
          actorKey: caller.actorKey,
          targetKey: subjectKey(subject),
          op: `share.create[${permissions.join(',')}]`,
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
          mutation: 'share',
          action: 'grant',
          outcome: 'rejected',
          auditId,
        })
        return { error }
      }

      await db.query(
        `INSERT INTO gfs_shares (drive, resource_id, subject_type, subject_id, permissions, include_descendants, created_by)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (drive, resource_id, subject_type, subject_id)
         DO UPDATE SET permissions = EXCLUDED.permissions,
                       include_descendants = EXCLUDED.include_descendants,
                       created_by = EXCLUDED.created_by`,
        [
          drive,
          resourceId,
          subject.type,
          subject.id ?? '',
          permissions,
          includeDescendants,
          caller.actorKey,
        ]
      )
      const auditId = await auditMutation(db, {
        actorKey: caller.actorKey,
        targetKey: subjectKey(subject),
        op: `share.create[${permissions.join(',')}]`,
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
        mutation: 'share',
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

export async function handleShareDelete(req: Request, res: Response): Promise<void> {
  try {
    const caller = resolveCaller(req)
    const id = String(req.params.id)
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'share_invalid' })
      return
    }
    const result = await withTransaction(async db => {
      const existing = await db.query(
        `SELECT drive, resource_id, subject_type, subject_id, permissions
           FROM gfs_shares WHERE id = $1::uuid
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
      try {
        await assertMayGrant(
          db,
          caller,
          row.drive,
          String(row.resource_id),
          (row.permissions as GfsPermission[]) ?? ['share'],
          subject,
          { isShare: true }
        )
      } catch (error) {
        if (!(error instanceof GfsGrantError)) throw error
        const auditId = await auditMutation(db, {
          actorKey: caller.actorKey,
          targetKey: subjectKey(subject),
          op: 'share.delete',
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
          mutation: 'share',
          action: 'revoke',
          outcome: 'rejected',
          auditId,
        })
        return { kind: 'denied' as const, error }
      }
      await db.query(`DELETE FROM gfs_shares WHERE id = $1::uuid`, [id])
      const auditId = await auditMutation(db, {
        actorKey: caller.actorKey,
        targetKey: subjectKey(subject),
        op: 'share.delete',
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
        mutation: 'share',
        action: 'revoke',
        outcome: 'committed',
        auditId,
      })
      return { kind: 'ok' as const }
    })
    if (result.kind === 'not_found') {
      res.status(404).json({ error: 'share_not_found' })
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
