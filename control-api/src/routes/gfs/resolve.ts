import type { Router } from 'express'
import { pool } from '../../db.js'
import {
  DbResolveStore,
  GfsUriError,
  ResolveStore,
  ResolvedResource,
  resolveGfsUri,
} from '../../gfs/resolve.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'

export interface GfsResourceView {
  resourceId: string
  /** Canonical 32-hex rid (dashes stripped). */
  rid: string
  gfsUri: string
  drive: string
  name: string
  kind: string
  path: string | null
  updatedAt: string
}

export function toResolveView(resource: ResolvedResource): GfsResourceView {
  const rid = resource.resourceId.replace(/-/g, '').toLowerCase()
  return {
    resourceId: resource.resourceId,
    rid,
    gfsUri: `gfs://${resource.drive}/${rid}`,
    drive: resource.drive,
    name: resource.name,
    kind: resource.kind,
    path: resource.pathCache,
    updatedAt: resource.updatedAt,
  }
}

export interface HttpResult {
  status: number
  body: unknown
}

/** GET /api/v1/gfs/resolve?uri= — resolve a gfs:// URI to its canonical view. */
export async function resolveUriToHttp(store: ResolveStore, uri: unknown): Promise<HttpResult> {
  if (typeof uri !== 'string' || uri.length === 0) {
    return { status: 400, body: { error: 'missing_uri' } }
  }
  let resolved: ResolvedResource | null
  try {
    resolved = await resolveGfsUri(store, uri)
  } catch (err) {
    if (err instanceof GfsUriError) return { status: 400, body: { error: 'path_invalid' } }
    throw err
  }
  if (!resolved) return { status: 404, body: { error: 'not_found' } }
  return { status: 200, body: toResolveView(resolved) }
}

/** GET /api/v1/gfs/by-path?drive=&path= — path lookup → canonical view. */
export async function byPathToHttp(
  store: ResolveStore,
  drive: unknown,
  path: unknown
): Promise<HttpResult> {
  if (
    typeof drive !== 'string' ||
    drive.length === 0 ||
    typeof path !== 'string' ||
    path.length === 0
  ) {
    return { status: 400, body: { error: 'missing_drive_or_path' } }
  }
  const resolved = await store.getByPath(drive, path)
  if (!resolved) return { status: 404, body: { error: 'not_found' } }
  return { status: 200, body: toResolveView(resolved) }
}

export function registerGfsResolveRoutes(router: Router): void {
  router.get(
    '/gfs/resolve',
    requireAuthForControlUI,
    asyncHandler(async (req, res) => {
      const result = await resolveUriToHttp(new DbResolveStore(pool), req.query.uri)
      res.status(result.status).json(result.body)
    })
  )

  router.get(
    '/gfs/by-path',
    requireAuthForControlUI,
    asyncHandler(async (req, res) => {
      const result = await byPathToHttp(new DbResolveStore(pool), req.query.drive, req.query.path)
      res.status(result.status).json(result.body)
    })
  )
}
