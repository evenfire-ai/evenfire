import type { Request, Response, Router } from 'express'
import { withTransaction } from '../../db.js'
import {
  DbSeedResourceStore,
  InvalidRootDirectoriesError,
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
 * GlobalFileSystem's rootDirectories as gfs_resources rows. Control API owns
 * this bootstrap; governed runtime mutations are applied by the GFSC writer.
 * HCC calls this after the drive reaches Ready. Idempotent.
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
  try {
    const result = await seedRootDirectories(store, b.drive, b.rootDirectories as string[])
    return { status: 200, body: result }
  } catch (error) {
    if (error instanceof InvalidRootDirectoriesError) {
      return { status: 400, body: { error: 'invalid_rootDirectories' } }
    }
    throw error
  }
}

export async function handleSeed(req: Request, res: Response): Promise<void> {
  const result = await withTransaction(db =>
    seedRootDirectoriesToHttp(new DbSeedResourceStore(db), req.body)
  )
  res.status(result.status).json(result.body)
}

export function registerGfsSeedRoute(router: Router): void {
  router.post(
    '/gfs/seed',
    requireInternalControlJwt,
    asyncHandler(handleSeed)
  )
}
