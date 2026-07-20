import { type Response, Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { GovernedReadScope } from '../../../services/tracing/contracts.js'
import type {
  GovernedEventReadService,
  GovernedReadInvalidQueryError,
} from '../../../services/tracing/governedEventReadService.js'
import { isInvalidTracingQuery, parseBoundedReadQuery, requireBoundedPathValue } from './query.js'
import type { QueryParseResult } from './query.js'

export type GovernedEventReader = Pick<GovernedEventReadService, 'read'>

function isGovernedReadInvalidQueryError(error: unknown): error is GovernedReadInvalidQueryError {
  return (
    error instanceof Error && (error as { code?: unknown }).code === 'governed_read_invalid_query'
  )
}

export async function sendReadResult(
  res: Response,
  reader: GovernedEventReader,
  query: QueryParseResult
): Promise<void> {
  if (isInvalidTracingQuery(query)) {
    res.status(400).json(query)
    return
  }
  try {
    res.status(200).json(await reader.read(query))
  } catch (error) {
    if (isGovernedReadInvalidQueryError(error)) {
      res.status(400).json({ error: 'invalid_query', detail: error.message })
      return
    }
    throw error
  }
}

export function createAdminTracingRunsRouter(reader: GovernedEventReader): Router {
  const router = Router()

  router.get(
    '/admin/tracing/runs',
    asyncHandler(async (req, res) => {
      const parsed = parseBoundedReadQuery(
        req,
        { kind: 'stream' },
        { defaultFamilies: ['agent_run'] }
      )
      await sendReadResult(res, reader, parsed)
    })
  )

  router.get(
    '/admin/tracing/workflows/:ns/:name/runs/:runId',
    asyncHandler(async (req, res) => {
      const recipeNamespace = requireBoundedPathValue(req.params.ns, 'ns')
      const recipeName = requireBoundedPathValue(req.params.name, 'name')
      const runId = requireBoundedPathValue(req.params.runId, 'runId')
      if (
        typeof recipeNamespace !== 'string' ||
        typeof recipeName !== 'string' ||
        typeof runId !== 'string'
      ) {
        res
          .status(400)
          .json(
            typeof recipeNamespace === 'string'
              ? typeof recipeName === 'string'
                ? runId
                : recipeName
              : recipeNamespace
          )
        return
      }
      const scope: GovernedReadScope = { kind: 'workflow_run', recipeNamespace, recipeName, runId }
      const parsed = parseBoundedReadQuery(req, scope, { defaultFamilies: ['agent_run'] })
      await sendReadResult(res, reader, parsed)
    })
  )

  router.get(
    '/admin/tracing/hosts/:hostRef/runs/:runId',
    asyncHandler(async (req, res) => {
      const hostRef = requireBoundedPathValue(req.params.hostRef, 'hostRef')
      const runId = requireBoundedPathValue(req.params.runId, 'runId')
      if (typeof hostRef !== 'string' || typeof runId !== 'string') {
        res.status(400).json(typeof hostRef === 'string' ? runId : hostRef)
        return
      }
      const scope: GovernedReadScope = { kind: 'host_run', hostRef, runId }
      const parsed = parseBoundedReadQuery(req, scope, { defaultFamilies: ['agent_run'] })
      await sendReadResult(res, reader, parsed)
    })
  )

  return router
}
