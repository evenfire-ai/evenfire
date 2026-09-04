import { Router } from 'express'
import { ACTION_CONTEXT_VERSION } from '@clerum/action-context-contracts'
import type { K8sGateway } from '../../k8s.js'
import { requireActionCheckpointCaller } from '../../middleware/actionCheckpointCaller.js'
import { AccessExecutionBudget } from '../../services/access/accessExecutionBudget.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../../services/access/actionAuthorityCheckpoint.js'

const STATUS_BY_OUTCOME = Object.freeze({
  allowed: 200,
  denied: 403,
  not_found: 404,
  access_path_stale: 409,
  authority_unavailable: 503,
  invalid_binding: 400,
})

export function createInternalActionAuthorityCheckpointRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/internal/action-authority/checkpoint',
    requireActionCheckpointCaller,
    async (req, res) => {
      let parsed
      try {
        parsed = parseActionAuthorityCheckpointRequest(req.body, req.actionCheckpointCaller!)
      } catch {
        res.status(400).json({
          version: ACTION_CONTEXT_VERSION,
          status: 'invalid_binding',
          code: 'invalid_binding',
        })
        return
      }
      const budget = AccessExecutionBudget.create('action')
      try {
        const result = await checkpointActionAuthority({
          request: parsed,
          gateway,
          budget,
          correlationId: req.correlationId,
        })
        res.status(STATUS_BY_OUTCOME[result.status]).json(result)
      } finally {
        budget.close()
      }
    }
  )
  return router
}
