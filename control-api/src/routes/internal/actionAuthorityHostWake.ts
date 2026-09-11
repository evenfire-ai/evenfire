import { Router } from 'express'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import { requireActionCheckpointCaller } from '../../middleware/actionCheckpointCaller.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { AccessExecutionBudget } from '../../services/access/accessExecutionBudget.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../../services/access/actionAuthorityCheckpoint.js'
import { executeHostWake } from '../../services/hostWakeAction.js'

const WAKE_REASONS = new Set(['explicit', 'message_retry', 'task_retry', 'session_retry'])
const STATUS = Object.freeze({
  denied: 403,
  not_found: 404,
  access_path_stale: 409,
  authority_unavailable: 503,
  invalid_binding: 400,
})

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function createInternalActionAuthorityHostWakeRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/internal/action-authority/hosts/:hostRef/wake',
    requireActionCheckpointCaller,
    rateLimitMiddleware({
      bucketType: 'host_wake',
      maxPerMinute: config.hostWakeRlPerMin,
      getBucketKey: req => {
        const hostRef = String(req.params.hostRef || '').trim()
        return hostRef ? `host-wake:${hostRef}` : null
      },
    }),
    async (req, res, next) => {
      const body = record(req.body)
      const hostRef = String(req.params.hostRef || '').trim()
      if (
        req.actionCheckpointCaller?.service !== 'rpc-proxy' ||
        !body ||
        Object.keys(body).sort().join(',') !== 'binding,wakeReason' ||
        typeof body.wakeReason !== 'string' ||
        !WAKE_REASONS.has(body.wakeReason)
      ) {
        res.status(400).json({ version: 2, status: 'invalid_binding', code: 'invalid_binding' })
        return
      }
      let binding
      try {
        binding = parseActionAuthorityCheckpointRequest(body.binding, req.actionCheckpointCaller)
      } catch {
        res.status(400).json({ version: 2, status: 'invalid_binding', code: 'invalid_binding' })
        return
      }
      const expectedRef = `${config.hostsNamespace}/${hostRef}`
      const target = record(binding.target)
      if (
        binding.operationId !== 'host.wake' ||
        !target ||
        Object.keys(target).sort().join(',') !== 'hostRef,wakeReason' ||
        target.hostRef !== expectedRef ||
        target.wakeReason !== body.wakeReason
      ) {
        res.status(403).json({
          version: 2,
          status: 'denied',
          code: 'wake_delegation_required',
        })
        return
      }
      const budget = AccessExecutionBudget.create('action')
      try {
        const checkpoint = await checkpointActionAuthority({
          request: binding,
          gateway,
          budget,
          correlationId: req.correlationId,
        })
        if (checkpoint.status !== 'allowed') {
          res.status(STATUS[checkpoint.status]).json(checkpoint)
          return
        }
        if (
          !checkpoint.destination ||
          checkpoint.destination.kind !== 'host' ||
          checkpoint.destination.ref !== expectedRef ||
          binding.resource.type !== 'host'
        ) {
          res.status(400).json({ version: 2, status: 'invalid_binding', code: 'invalid_binding' })
          return
        }
        const wake = await executeHostWake(gateway, hostRef)
        if (wake.kind === 'unknown') {
          res.status(404).json({ status: 'unknown' })
        } else if (wake.kind === 'not-stateless') {
          res.status(409).json({ status: 'not-stateless' })
        } else if (wake.kind === 'active') {
          res.status(200).json({
            status: 'active',
            ...(wake.wakeGeneration !== null ? { wakeGeneration: wake.wakeGeneration } : {}),
          })
        } else {
          res.status(202).json({ status: 'wake-requested', wakeGeneration: wake.wakeGeneration })
        }
      } catch (error) {
        next(error)
      } finally {
        budget.close()
      }
    }
  )
  return router
}
