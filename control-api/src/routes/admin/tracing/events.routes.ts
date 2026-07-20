import { Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import { parseBoundedReadQuery, resolveEventsScope } from './query.js'
import { type GovernedEventReader, sendReadResult } from './runs.routes.js'

export function createAdminTracingEventsRouter(reader: GovernedEventReader): Router {
  const router = Router()

  router.get(
    '/admin/tracing/events',
    asyncHandler(async (req, res) => {
      const scope = resolveEventsScope(req)
      if ('error' in scope) {
        res.status(400).json(scope)
        return
      }
      const parsed = parseBoundedReadQuery(req, scope, {
        allowWorkloadRef: true,
        allowExplorationFilters: true,
      })
      await sendReadResult(res, reader, parsed)
    })
  )

  return router
}
