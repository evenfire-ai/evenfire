import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { K8sGateway } from '../../k8s.js'
import {
  HostEnvServiceError,
  HostEnvWriteEntry,
} from '../../services/hostEnvService.js'

/**
 * Admin endpoints for per-Host operator-managed env vars.
 *
 * Backed by HostEnvService. The /api/v1/admin/secrets flow for LLM
 * provider keys is unchanged; this router covers only non-secret +
 * secret env-var CRUD scoped to a single hostRef.
 */
const HOSTREF_RE = /^[a-z][a-z0-9-]{0,62}$/

export function createAdminHostEnvRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    '/admin/hosts/:hostRef/env',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const hostRef = String(req.params.hostRef || '').trim()
      if (!HOSTREF_RE.test(hostRef)) {
        res.status(400).json({ error: 'invalid hostRef' })
        return
      }
      try {
        const items = await gateway.hostEnv().list(hostRef)
        res.status(200).json({ items })
      } catch (err) {
        respondWithEnvError(res, err)
      }
    })
  )

  router.put(
    '/admin/hosts/:hostRef/env',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const hostRef = String(req.params.hostRef || '').trim()
      if (!HOSTREF_RE.test(hostRef)) {
        res.status(400).json({ error: 'invalid hostRef' })
        return
      }
      const body = (req.body ?? []) as HostEnvWriteEntry[]
      try {
        const result = await gateway.hostEnv().putMany(hostRef, body)
        res.status(200).json(result)
      } catch (err) {
        respondWithEnvError(res, err)
      }
    })
  )

  router.delete(
    '/admin/hosts/:hostRef/env/:key',
    enforceNamespace(config.hostsNamespace),
    asyncHandler(async (req, res) => {
      const hostRef = String(req.params.hostRef || '').trim()
      const key = String(req.params.key || '').trim()
      if (!HOSTREF_RE.test(hostRef)) {
        res.status(400).json({ error: 'invalid hostRef' })
        return
      }
      try {
        await gateway.hostEnv().deleteKey(hostRef, key)
        res.status(204).send()
      } catch (err) {
        respondWithEnvError(res, err)
      }
    })
  )

  return router
}

function respondWithEnvError(res: import('express').Response, err: unknown): void {
  if (err instanceof HostEnvServiceError) {
    const body: Record<string, unknown> = { error: err.message }
    if (err.hint) body.hint = err.hint
    res.status(err.status).json(body)
    return
  }
  // Re-throw to the global error handler.
  throw err
}
