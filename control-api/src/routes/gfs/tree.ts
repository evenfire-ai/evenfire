import type { Router } from 'express'
import { pool } from '../../db.js'
import { DbResolveStore } from '../../gfs/resolve.js'
import { DbChildrenStore, GfsTreeError, listChildrenPaged } from '../../gfs/tree.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireAuthForControlUI } from '../../middleware/controlUIAuth.js'

const DEFAULT_DRIVE = 'main'
const RID_OR_UUID =
  /^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function driveOf(query: unknown): string {
  return typeof query === 'string' && query.length > 0 ? query : DEFAULT_DRIVE
}

function cursorOf(query: unknown): string | undefined {
  return typeof query === 'string' && query.length > 0 ? query : undefined
}

export function registerGfsTreeRoutes(router: Router): void {
  // GET /api/v1/gfs/tree?drive=&limit=&cursor= — the synthetic root's children.
  router.get(
    '/gfs/tree',
    requireAuthForControlUI,
    asyncHandler(async (req, res) => {
      const drive = driveOf(req.query.drive)
      const root = await new DbResolveStore(pool).getByPath(drive, '/')
      if (!root) {
        res.status(404).json({ error: 'drive_not_seeded' })
        return
      }
      try {
        const page = await listChildrenPaged(new DbChildrenStore(pool), drive, root.resourceId, {
          limit: req.query.limit,
          cursor: cursorOf(req.query.cursor),
        })
        res.status(200).json({ ...page, rootResourceId: root.resourceId })
      } catch (err) {
        if (err instanceof GfsTreeError) {
          res.status(400).json({ error: 'path_invalid' })
          return
        }
        throw err
      }
    })
  )

  // GET /api/v1/gfs/resources/:id/children?drive=&limit=&cursor=
  router.get(
    '/gfs/resources/:id/children',
    requireAuthForControlUI,
    asyncHandler(async (req, res) => {
      const id = req.params.id
      if (!RID_OR_UUID.test(id)) {
        res.status(400).json({ error: 'path_invalid' })
        return
      }
      const drive = driveOf(req.query.drive)
      try {
        const page = await listChildrenPaged(new DbChildrenStore(pool), drive, id, {
          limit: req.query.limit,
          cursor: cursorOf(req.query.cursor),
        })
        res.status(200).json(page)
      } catch (err) {
        if (err instanceof GfsTreeError) {
          res.status(400).json({ error: 'path_invalid' })
          return
        }
        throw err
      }
    })
  )
}
