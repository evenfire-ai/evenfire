/**
 * /healthz and /readyz handlers.
 *
 *   /healthz: liveness — process is up. Always 200 once the server has started.
 *   /readyz:  readiness — mount is present and writable. Used by the K8s
 *             readinessProbe so traffic only lands once the PVC is mounted.
 */
import * as fs from 'node:fs/promises'
import { Router, type Request, type Response } from 'express'
import { logger } from '../logger'

export interface HealthRouterOptions {
  mountPath: string
}

export function createHealthRouter(opts: HealthRouterOptions): Router {
  const router = Router()

  router.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, status: 'alive' })
  })

  router.get('/readyz', async (_req: Request, res: Response) => {
    try {
      const stat = await fs.stat(opts.mountPath)
      if (!stat.isDirectory()) {
        res.status(503).json({ ok: false, status: 'not_a_directory' })
        return
      }
      // Confirm the mount is writable by the wfc UID. We check by stat'ing
      // — a touch-and-delete probe would race with concurrent uploads.
      await fs.access(opts.mountPath, fs.constants.W_OK)
      res.json({ ok: true, status: 'ready' })
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '/readyz failed')
      res.status(503).json({ ok: false, status: 'unready', message: (e as Error).message })
    }
  })

  return router
}
