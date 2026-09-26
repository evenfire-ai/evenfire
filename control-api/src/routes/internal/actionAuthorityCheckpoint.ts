import { Router } from 'express'
import { ACTION_CONTEXT_VERSION } from '@clerum/action-context-contracts'
import type { K8sGateway } from '../../k8s.js'
import { requireActionCheckpointCaller } from '../../middleware/actionCheckpointCaller.js'
import { AccessExecutionBudget } from '../../services/access/accessExecutionBudget.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../../services/access/actionAuthorityCheckpoint.js'
import {
  admitHostMessage,
  respondHostMessageAdmissionFailure,
} from '../../services/hostMessageAdmission.js'
import {
  issueHostMessageAdmissionReceipt,
  verifyHostMessageAdmissionReceipt,
} from '../../utils/auth/hostMessageAdmissionReceipt.js'

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
      const caller = req.actionCheckpointCaller!
      let parsed
      try {
        parsed = parseActionAuthorityCheckpointRequest(req.body, caller)
      } catch {
        res.status(400).json({
          version: ACTION_CONTEXT_VERSION,
          status: 'invalid_binding',
          code: 'invalid_binding',
        })
        return
      }
      const chargesHostMessageAdmission =
        parsed.operationId === 'chat.message.invoke' && caller.service === 'rpc-proxy'
      if (chargesHostMessageAdmission && !parsed.hostMessageAdmission) {
        res.status(400).json({
          version: ACTION_CONTEXT_VERSION,
          status: 'invalid_binding',
          code: 'invalid_binding',
        })
        return
      }
      let admissionReceipt: string | undefined
      if (chargesHostMessageAdmission) {
        const admissionContext = parsed.hostMessageAdmission!
        if (admissionContext.receipt !== undefined) {
          if (
            !verifyHostMessageAdmissionReceipt(
              admissionContext.receipt,
              parsed,
              caller,
              admissionContext
            )
          ) {
            res.status(400).json({
              version: ACTION_CONTEXT_VERSION,
              status: 'invalid_binding',
              code: 'invalid_binding',
            })
            return
          }
          admissionReceipt = admissionContext.receipt
        } else {
          const admission = await admitHostMessage(parsed.principal.sub)
          if (admission.status !== 'allowed') {
            respondHostMessageAdmissionFailure(res, admission)
            return
          }
        }
      }
      const budget = AccessExecutionBudget.create('action')
      try {
        const result = await checkpointActionAuthority({
          request: parsed,
          gateway,
          budget,
          correlationId: req.correlationId,
        })
        if (result.status === 'allowed' && chargesHostMessageAdmission) {
          try {
            admissionReceipt ??= issueHostMessageAdmissionReceipt(
              parsed,
              caller,
              parsed.hostMessageAdmission!
            )
          } catch {
            res.status(503).json({
              version: ACTION_CONTEXT_VERSION,
              status: 'authority_unavailable',
              code: 'authority_unavailable',
              retryable: true,
            })
            return
          }
          res.status(STATUS_BY_OUTCOME[result.status]).json({
            ...result,
            hostMessageAdmissionReceipt: admissionReceipt,
          })
          return
        }
        res.status(STATUS_BY_OUTCOME[result.status]).json(result)
      } finally {
        budget.close()
      }
    }
  )
  return router
}
