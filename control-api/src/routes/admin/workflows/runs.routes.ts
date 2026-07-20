import { type Request, type Response, Router } from 'express'
import type { PoolClient } from 'pg'
import { pool } from '../../../db.js'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { rootLogger } from '../../../observability/logger.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import { type WorkflowRunRow, getRun } from '../../../services/workflowRunService.js'
import type { WorkflowLeaderDto } from '../../../services/workflows/types.js'
import {
  WORKFLOW_RECIPE_PLURAL,
  ensureRecipeAuthorized,
  isRecipeNamespaceAllowed,
} from '../../../services/workflows/workflowRecipeAccessService.js'
import {
  WorkflowArtifactHttpError,
  deleteWorkflowRunArtifact,
  deleteWorkflowRunArtifacts,
  downloadWorkflowRunArtifact,
  listWorkflowRunArtifacts,
} from '../../../services/workflows/workflowRunArtifactService.js'
import { listCanonicalRuns, mapDbRun } from '../../../services/workflows/workflowRunReadService.js'
import { requireAdminWorkflowCaller } from '../../workflows/shared/auth.js'
import { parseLimit } from '../../workflows/shared/validation.js'

const BASE = '/admin/workflows'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const logger = rootLogger.child({ module: 'admin-workflow-runs' })

function sendArtifactError(res: Response, err: unknown): void {
  if (err instanceof WorkflowArtifactHttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err instanceof K8sNotFoundError) {
    res.status(404).json({ error: 'Workflow run artifact resource not found' })
    return
  }
  throw err
}

function sendDownloadResult(
  res: Response,
  result: Awaited<ReturnType<typeof downloadWorkflowRunArtifact>>
): void {
  if (Buffer.isBuffer(result.body)) {
    res.status(result.status)
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value)
    res.end(result.body)
    return
  }
  res.status(result.status).json(result.body)
}

function sendDeleteResult(
  res: Response,
  result: Awaited<ReturnType<typeof deleteWorkflowRunArtifact>>
): void {
  if (result.status === 204) {
    res.status(204).end()
    return
  }
  res.status(result.status).json(result.body)
}

export interface AdminWorkflowRunsRoutesOptions {
  runsStreamAutoCloseMs?: number
  runsStreamKeepAliveMs?: number
}

export function createAdminWorkflowRunsRoutes(
  gateway: K8sGateway,
  options: AdminWorkflowRunsRoutesOptions = {}
): Router {
  const router = Router()
  const runsStreamKeepAliveMs = options.runsStreamKeepAliveMs ?? 25_000
  const runsStreamAutoCloseMs = options.runsStreamAutoCloseMs ?? 300_000

  router.get(
    `${BASE}/leader`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const query = `
          SELECT a.pid,
                 a.state,
                 a.query,
                 a.backend_start,
                 a.application_name
          FROM pg_stat_activity a
          JOIN pg_locks l ON l.pid = a.pid
          WHERE l.locktype = 'advisory'
            AND l.objid = (hashtext('wrc-leader-v1')::bigint & x'FFFFFFFF'::bigint)::oid
            AND l.classid = ((hashtext('wrc-leader-v1')::bigint >> 32) & x'FFFFFFFF'::bigint)::oid
            AND l.objsubid = 1
            AND l.granted = true
          LIMIT 1
        `
        const result = await pool.query<{
          pid: number
          state: string | null
          query: string | null
          backend_start: string | Date | null
          application_name: string | null
        }>(query)

        if (result.rowCount === 0) {
          const dto: WorkflowLeaderDto = {
            held: false,
            leader_pid: null,
            leader_instance_id: null,
            acquired_at: null,
            last_query: null,
          }
          res.json(dto)
          return
        }

        const row = result.rows[0]
        const appName = row.application_name ?? ''
        const instanceId = appName.startsWith('wrc-') ? appName.slice(4) : null
        const acquiredAt = row.backend_start
          ? row.backend_start instanceof Date
            ? row.backend_start.toISOString()
            : new Date(row.backend_start).toISOString()
          : null

        const dto: WorkflowLeaderDto = {
          held: true,
          leader_pid: row.pid,
          leader_instance_id: instanceId,
          acquired_at: acquiredAt,
          last_query: row.query ?? null,
        }
        res.json(dto)
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to query WRC leader state'
        )
        res.status(500).json({ error: 'Failed to query leader state' })
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/runs`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name } = req.params
      if (!isRecipeNamespaceAllowed(ns)) {
        res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
        return
      }
      if (!(await ensureRecipeAuthorized(caller, ns, name))) {
        res.status(403).json({ error: 'Not authorized to view runs for this recipe' })
        return
      }
      try {
        await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)
        const limit = parseLimit(req.query?.limit)
        const items = await listCanonicalRuns(ns, name, limit)
        res.json({ items, count: items.length })
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        throw err
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/runs/:runId`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      const { ns, name, runId } = req.params
      if (!isRecipeNamespaceAllowed(ns)) {
        res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
        return
      }
      if (!(await ensureRecipeAuthorized(caller, ns, name))) {
        res.status(403).json({ error: 'Not authorized to view runs for this recipe' })
        return
      }
      if (!UUID_RE.test(runId)) {
        res.status(400).json({ error: 'Invalid workflow run id' })
        return
      }

      try {
        await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)
        const row = await getRun(runId)
        if (!row || row.recipe_namespace !== ns || row.recipe_name !== name) {
          res.status(404).json({ error: `Workflow run ${runId} not found` })
          return
        }
        res.json(mapDbRun(row))
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        throw err
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/runs/:runId/artifacts`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const artifacts = await listWorkflowRunArtifacts({
          gateway,
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          runId: req.params.runId,
        })
        res.json({ artifacts })
      } catch (err) {
        sendArtifactError(res, err)
      }
    })
  )

  router.get(
    `${BASE}/:ns/:name/runs/:runId/artifacts/:artifactName/download`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await downloadWorkflowRunArtifact({
          gateway,
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          runId: req.params.runId,
          artifactName: req.params.artifactName,
        })
        sendDownloadResult(res, result)
      } catch (err) {
        sendArtifactError(res, err)
      }
    })
  )

  router.delete(
    `${BASE}/:ns/:name/runs/:runId/artifacts/:artifactName`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await deleteWorkflowRunArtifact({
          gateway,
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          runId: req.params.runId,
          artifactName: req.params.artifactName,
        })
        sendDeleteResult(res, result)
      } catch (err) {
        sendArtifactError(res, err)
      }
    })
  )

  router.delete(
    `${BASE}/:ns/:name/runs/:runId/artifacts`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      try {
        const result = await deleteWorkflowRunArtifacts({
          gateway,
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          runId: req.params.runId,
        })
        sendDeleteResult(res, result)
      } catch (err) {
        sendArtifactError(res, err)
      }
    })
  )

  router.get(
    `${BASE}/runs/stream`,
    asyncHandler(async (req: Request, res: Response) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      const filterNamespace =
        typeof req.query.namespace === 'string' ? req.query.namespace.trim() : ''
      const filterName = typeof req.query.name === 'string' ? req.query.name.trim() : ''

      if (filterNamespace && !isRecipeNamespaceAllowed(filterNamespace)) {
        res.status(400).json({ error: 'Invalid namespace filter' })
        return
      }

      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()

      let client: PoolClient | null = null
      let closed = false
      let keepAliveTimer: NodeJS.Timeout | null = null
      let autoCloseTimer: NodeJS.Timeout | null = null

      const writeEvent = (event: string, data: unknown): void => {
        if (closed) return
        try {
          res.write(`event: ${event}\n`)
          res.write(`data: ${JSON.stringify(data)}\n\n`)
        } catch {
          /* socket closed */
        }
      }

      const cleanup = (reason: string): void => {
        if (closed) return
        closed = true
        if (keepAliveTimer) clearInterval(keepAliveTimer)
        if (autoCloseTimer) clearTimeout(autoCloseTimer)
        if (client) {
          Promise.resolve(client.query('UNLISTEN workflow_run_update'))
            .catch(() => {})
            .finally(() => {
              try {
                client?.release()
              } catch {
                /* already released */
              }
            })
        }
        try {
          res.end()
        } catch {
          /* already ended */
        }
        logger.debug({ reason }, 'SSE run stream closed')
      }

      try {
        client = await pool.connect()
        await client.query('LISTEN workflow_run_update')

        client.on('notification', async (msg: { channel: string; payload?: string }) => {
          if (closed || msg.channel !== 'workflow_run_update') return
          const runId = msg.payload?.trim()
          if (!runId) return

          try {
            const result = await pool.query<WorkflowRunRow>(
              `SELECT * FROM workflow_runs WHERE run_id = $1`,
              [runId]
            )
            if (result.rowCount === 0) return
            const row = result.rows[0]
            if (filterNamespace && row.recipe_namespace !== filterNamespace) return
            if (filterName && row.recipe_name !== filterName) return
            writeEvent('run', mapDbRun(row))
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err), runId },
              'Failed to fetch run row for SSE emit'
            )
          }
        })

        client.on('error', (err: Error) => {
          logger.error({ err: err.message }, 'Dedicated SSE listener connection errored')
          writeEvent('error', { message: 'listener connection lost' })
          cleanup('client-error')
        })

        writeEvent('open', {
          filter: { namespace: filterNamespace || null, name: filterName || null },
        })

        keepAliveTimer = setInterval(() => {
          if (closed) return
          try {
            res.write(`: keep-alive ${Date.now()}\n\n`)
          } catch {
            cleanup('write-failed')
          }
        }, runsStreamKeepAliveMs)

        autoCloseTimer = setTimeout(() => {
          writeEvent('close', { reason: 'auto-close', ttlMs: runsStreamAutoCloseMs })
          cleanup('auto-close')
        }, runsStreamAutoCloseMs)

        req.on('close', () => cleanup('client-disconnect'))
        req.on('error', () => cleanup('request-error'))
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to open SSE run stream'
        )
        writeEvent('error', { message: 'failed to open stream' })
        cleanup('open-failed')
      }
    })
  )

  return router
}
