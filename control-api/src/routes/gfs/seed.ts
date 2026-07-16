import type { Router } from 'express'
import { pool } from '../../db.js'
import {
  DbSeedResourceStore,
  SeedResourceStore,
  seedRootDirectories,
} from '../../gfs/seedResources.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireInternalControlJwt } from '../../middleware/internalControlJwt.js'

export interface HttpResult {
  status: number
  body: unknown
}

/**
 * POST /api/v1/gfs/seed — internal endpoint (HCC → control-api). Materializes a
 * GlobalFileSystem's rootDirectories as gfs_resources rows. The governance
 * plane (control-api) is the ONLY writer of resource rows (CC6); HCC's
 * gfsReconciler calls this after the drive reaches Ready. Idempotent.
 */
export async function seedRootDirectoriesToHttp(
  store: SeedResourceStore,
  body: unknown
): Promise<HttpResult> {
  const b = (body ?? {}) as { drive?: unknown; rootDirectories?: unknown }
  if (typeof b.drive !== 'string' || b.drive.length === 0) {
    return { status: 400, body: { error: 'missing_drive' } }
  }
  if (!Array.isArray(b.rootDirectories) || b.rootDirectories.some(d => typeof d !== 'string')) {
    return { status: 400, body: { error: 'invalid_rootDirectories' } }
  }
  const result = await seedRootDirectories(store, b.drive, b.rootDirectories as string[])
  return { status: 200, body: result }
}

export function registerGfsSeedRoute(router: Router): void {
  router.post(
    '/gfs/seed',
    requireInternalControlJwt,
    asyncHandler(async (req, res) => {
      const result = await seedRootDirectoriesToHttp(new DbSeedResourceStore(pool), req.body)
      res.status(result.status).json(result.body)
    })
  )
}
