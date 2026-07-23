import type { Request, Response, Router } from 'express'
import { pool } from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'

export const LEGACY_STANDALONE_HOST_SUBJECT_ID = '1st:mcp-host/standalone'
const LEGACY_GRANT_REPORT_LIMIT = 1000

export interface LegacyStandaloneGrantsDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface LegacyStandaloneGrant {
  id: string
  drive: string
  resourceId: string
  permissions: string[]
  inherit: boolean
}

/**
 * Read-only inventory for the bounded operator migration tool. Candidate Hosts
 * deliberately come from the trusted Host directory instead of PostgreSQL.
 */
export async function listLegacyStandaloneGrants(
  db: LegacyStandaloneGrantsDb = pool
): Promise<LegacyStandaloneGrant[]> {
  const result = await db.query(
    `SELECT id, drive, resource_id, permissions, inherit
       FROM gfs_grants
      WHERE subject_type = 'host' AND subject_id = $1
      ORDER BY drive ASC, resource_id ASC, id ASC
      LIMIT $2`,
    [LEGACY_STANDALONE_HOST_SUBJECT_ID, LEGACY_GRANT_REPORT_LIMIT + 1]
  )
  if (result.rows.length > LEGACY_GRANT_REPORT_LIMIT) {
    throw new Error('legacy_grant_report_limit_exceeded')
  }
  return (result.rows as Array<Record<string, unknown>>).map(row => ({
    id: String(row.id),
    drive: String(row.drive),
    resourceId: String(row.resource_id),
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String).sort() : [],
    inherit: Boolean(row.inherit),
  }))
}

export async function handleLegacyStandaloneGrantReport(
  _req: Request,
  res: Response
): Promise<void> {
  const grants = await listLegacyStandaloneGrants()
  res.status(200).json({
    sourceSubject: `host:${LEGACY_STANDALONE_HOST_SUBJECT_ID}`,
    grants,
  })
}

export function registerLegacyStandaloneGrantReportRoute(router: Router): void {
  router.get(
    '/gfs/grants/legacy-standalone',
    requireAuthForControlUI,
    asyncHandler(handleLegacyStandaloneGrantReport)
  )
}
