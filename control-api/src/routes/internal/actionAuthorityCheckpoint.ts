import { Router } from 'express'
import { ACTION_CONTEXT_VERSION } from '@clerum/action-context-contracts'
import { pool } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import {
  attachAccessExecutionBudget,
  requestAccessExecutionBudget,
} from '../../middleware/accessExecutionBudget.js'
import { requireActionCheckpointCaller } from '../../middleware/actionCheckpointCaller.js'
import { requireActionContextEnabled } from '../../middleware/actionContextEnabled.js'
import {
  checkpointActionAuthority,
  parseActionAuthorityCheckpointRequest,
} from '../../services/access/actionAuthorityCheckpoint.js'
import { isAuthorityDependencyUnavailable } from '../../services/access/authorityDependency.js'
import {
  admitHostMessage,
  respondHostMessageAdmissionFailure,
} from '../../services/hostMessageAdmission.js'
import {
  admitHostRpc,
  requiresHostRpcAdmission,
  respondHostRpcAdmissionFailure,
} from '../../services/hostRpcAdmission.js'
import { revalidateWorkflowTriggerCheckpoint } from '../../services/workflows/workflowTriggerCheckpointRevalidation.js'
import {
  HostMessageAdmissionReceiptBindingError,
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

const AUTHORITY_UNAVAILABLE = Object.freeze({
  version: ACTION_CONTEXT_VERSION,
  status: 'authority_unavailable' as const,
  code: 'authority_unavailable' as const,
  retryable: true as const,
})

export function createInternalActionAuthorityCheckpointRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/internal/action-authority/checkpoint',
    requireActionCheckpointCaller,
    // One action budget for the policy read, the admissions and the
    // checkpoint, so the whole authority prefix ends by the action deadline.
    attachAccessExecutionBudget,
    requireActionContextEnabled,
    async (req, res, next) => {
      try {
        const budget = requestAccessExecutionBudget(req)
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
            const admission = await budget.untilDeadline(admitHostMessage(parsed.principal.sub))
            if (admission.status !== 'allowed') {
              respondHostMessageAdmissionFailure(res, admission)
              return
            }
          }
        }
        if (requiresHostRpcAdmission(parsed.operationId)) {
          const admission = await budget.untilDeadline(admitHostRpc(parsed.principal.sub))
          if (admission.status !== 'allowed') {
            respondHostRpcAdmissionFailure(res, admission)
            return
          }
        }
        if (
          caller.service === 'workflow-recipes' &&
          (parsed.operationId === 'workflow.trigger' ||
            parsed.operationId === 'workflow.run.manage')
        ) {
          let revalidated
          try {
            revalidated = await revalidateWorkflowTriggerCheckpoint({
              request: parsed,
              caller,
              gateway,
              budget,
              db: pool,
              correlationId: req.correlationId,
            })
          } catch (error) {
            // Only a dependency failure is retryable; a defect reaches the
            // error handler (logged, 500) instead of pausing runs.
            if (!isAuthorityDependencyUnavailable(error)) throw error
            revalidated = AUTHORITY_UNAVAILABLE
          }
          res.status(STATUS_BY_OUTCOME[revalidated.status]).json(revalidated)
          return
        }
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
          } catch (error) {
            // Signing reads no dependency. A binding the receipt cannot
            // carry (an expired delegation, another trust plane) is the
            // caller's invalid binding; anything else (the signing key) is a
            // defect for the error handler, never a retryable outage.
            if (!(error instanceof HostMessageAdmissionReceiptBindingError)) throw error
            res.status(400).json({
              version: ACTION_CONTEXT_VERSION,
              status: 'invalid_binding',
              code: 'invalid_binding',
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
      } catch (error) {
        // The request budget ended, or a dependency failed, inside an
        // admission or the checkpoint.
        if (isAuthorityDependencyUnavailable(error) && !res.headersSent) {
          res.status(503).json(AUTHORITY_UNAVAILABLE)
          return
        }
        next(error)
      }
    }
  )
  return router
}
