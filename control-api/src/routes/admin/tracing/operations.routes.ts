import { Router } from 'express'
import type { TracingOperationsSnapshot } from '../../../services/tracing/operations/contracts.js'

export interface TracingOperationsReader {
  read(): Promise<TracingOperationsSnapshot>
}

export function createAdminTracingOperationsRouter(reader: TracingOperationsReader): Router {
  const router = Router()

  router.get('/admin/tracing/operations', async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json(await reader.read())
    } catch (error) {
      next(error)
    }
  })

  return router
}
