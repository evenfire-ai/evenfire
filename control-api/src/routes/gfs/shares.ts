import type { Request, Response, Router } from 'express'
import { pool, withTransaction } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  GfsGrantError,
  type GfsPermission,
  type GfsSubject,
  type GfsSubjectType,
  UUID_RE,
  appendGfsPermissionEvent,
  appendGfsPermissionEvents,
  assertMayGrant,
  assertMayGrantBatch,
  assertMutationSubjectTransport,
  auditMutation,
  driveOf,
  normalizeMutationSubjects,
  parsePermissions,
  permissionReadFilter,
  requestIdOf,
  resolveCaller,
  sendGfsGrantError,
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
  // Per-admin token bucket, same shape as the folder-grant routes above.
  const sharesRateLimit = rateLimitMiddleware({
    bucketType: 'gfs_shares',
    maxPerMinute: 30,
    getBucketKey: req => {
      const sub = (req as { adminAuth?: { sub?: string } }).adminAuth?.sub
      return sub ? `gfsshares:${sub}` : null
    },
  })
  router.get('/gfs/shares', requireAuthForControlUI, sharesRateLimit, asyncHandler(handleShareRead))
  router.post(
    '/gfs/shares',
    requireAuthForControlUI,
    sharesRateLimit,
    asyncHandler(handleShareWrite)
  )
  router.delete(
    '/gfs/shares/:id',
    requireAuthForControlUI,
    sharesRateLimit,
    asyncHandler(handleShareDelete)
  )
}

export async function handleShareRead(req: Request, res: Response): Promise<void> {
  try {
    const { drive, resourceId } = permissionReadFilter(req)
    const result = await pool.query(
      `SELECT id, drive, resource_id, subject_type, subject_id, permissions, include_descendants
         FROM gfs_shares
        WHERE drive = $1 AND resource_id = $2::uuid
        ORDER BY created_at ASC, id ASC`,
      [drive, resourceId]
    )
    res.status(200).json({
      items: (result.rows as Record<string, unknown>[]).map(row => {
        const subjectId = String(row.subject_id ?? '')
        return {
          id: String(row.id),
          drive: String(row.drive),
          resourceId: String(row.resource_id),
          subject: {
            type: String(row.subject_type),
            ...(subjectId ? { id: subjectId } : {}),
          },
          permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
          includeDescendants: Boolean(row.include_descendants),
        }
      }),
    })
  } catch (err) {
    if (err instanceof GfsGrantError) {
      sendGfsGrantError(res, err)
      return
    }
    throw err
  }
}

export async function writeGfsShareBatchInTransaction(
  db: import('../../db.js').DbClient,
  params: {
    req: Request
    caller: ReturnType<typeof resolveCaller>
    drive: string
    resourceId: string
    subjects: readonly GfsSubject[]
    permissions: readonly GfsPermission[]
    includeDescendants: boolean
  }
): Promise<{ error: GfsGrantError | null }> {
  const auditIds: Array<string | null> = []
  let outcome: 'allowed' | 'denied' = 'allowed'
  let policyError: GfsGrantError | null = null
  try {
    await assertMayGrantBatch(
      db,
      params.caller,
      params.drive,
      params.resourceId,
      params.permissions,
      params.subjects,
      { isShare: true }
    )
  } catch (error) {
    if (!(error instanceof GfsGrantError)) throw error
    outcome = 'denied'
    policyError = error
  }

  if (!policyError) {
    const types = params.subjects.map(subject => subject.type)
    const ids = params.subjects.map(subject => subject.id ?? '')
    await db.query(
      `INSERT INTO gfs_shares
         (drive, resource_id, subject_type, subject_id, permissions, include_descendants, created_by)
       SELECT $1, $2::uuid, input.subject_type, input.subject_id, $5::text[], $6, $7
         FROM unnest($3::text[], $4::text[]) AS input(subject_type, subject_id)
       ON CONFLICT (drive, resource_id, subject_type, subject_id)
       DO UPDATE SET permissions = EXCLUDED.permissions,
                     include_descendants = EXCLUDED.include_descendants,
                     created_by = EXCLUDED.created_by`,
      [
        params.drive,
        params.resourceId,
        types,
        ids,
        params.permissions,
        params.includeDescendants,
        params.caller.actorKey,
      ]
    )
  }

  for (const subject of params.subjects) {
    auditIds.push(
      await auditMutation(db, {
        actorKey: params.caller.actorKey,
        targetKey: subjectKey(subject),
        op: `share.create[${params.permissions.join(',')}]`,
        drive: params.drive,
        resourceId: params.resourceId,
        outcome,
        requestId: requestIdOf(params.req),
        sourceIp: params.req.ip,
      })
    )
  }
  await appendGfsPermissionEvents(db, {
    req: params.req,
    caller: params.caller,
    subjects: params.subjects,
    permissions: params.permissions,
    drive: params.drive,
    resourceId: params.resourceId,
    mutation: 'share',
    action: 'grant',
    outcome: policyError ? 'rejected' : 'committed',
    auditIds,
  })
  return { error: policyError }
}

export async function handleShareWrite(req: Request, res: Response): Promise<void> {
  try {
    const caller = resolveCaller(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const drive = driveOf(body.drive)
    const resourceId = String(body.resourceId ?? '')
    assertMutationSubjectTransport(body)
    if (!UUID_RE.test(resourceId)) {
      throw new GfsGrantError(400, 'resource_invalid')
    }
    const subjects = normalizeMutationSubjects(body, { isShare: true })
    const permissions = parsePermissions(body.permissions)
    const includeDescendants = Boolean(body.includeDescendants)

    const result = await withTransaction(db =>
      writeGfsShareBatchInTransaction(db, {
        req,
        caller,
        drive,
        resourceId,
        subjects,
        permissions,
        includeDescendants,
      })
    )
    if (result.error) {
      sendGfsGrantError(res, result.error)
      return
    }
    res.status(200).json({ ok: true, resourceId, updated: subjects, count: subjects.length })
  } catch (err) {
    if (err instanceof GfsGrantError) {
      sendGfsGrantError(res, err)
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
