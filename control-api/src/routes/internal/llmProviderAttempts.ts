import { Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import { requireInternalService } from '../../middleware/internalServiceAuth.js'
import { rootLogger } from '../../observability/logger.js'
import {
  LlmProviderAttemptFinalizeError,
  finalizeLlmProviderAttempt,
} from '../../services/llmProviderAttemptFinalization.js'
import {
  LlmProviderAttemptRedeemError,
  redeemLlmProviderAttempt,
} from '../../services/llmProviderAttemptRedemption.js'
import { isPlainObject } from '../../utils/isPlainObject.js'

const log = rootLogger.child({ module: 'internal-llm-provider-attempts' })

const REDEEM_STATUS: Record<string, number> = {
  disabled: 404,
  ticket_invalid: 403,
  ticket_replayed: 409,
  ticket_expired: 403,
  request_hash_mismatch: 403,
  connection_unavailable: 503,
  no_grant: 403,
  provider_unavailable: 503,
}

const FINALIZE_STATUS: Record<string, number> = {
  disabled: 404,
  ticket_invalid: 403,
  request_hash_mismatch: 403,
  invalid_receipt: 400,
  conflict: 409,
}

export function createInternalLlmProviderAttemptRoutes(): Router {
  const router = Router()
  router.use('/internal/llm/provider-attempts', requireInternalService('codex-llm-proxy'))

  router.post(
    '/internal/llm/provider-attempts/redeem',
    asyncHandler(async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {}
      try {
        const result = await redeemLlmProviderAttempt({
          executionTicket: typeof body.executionTicket === 'string' ? body.executionTicket : '',
          requestHash: typeof body.requestHash === 'string' ? body.requestHash : '',
          model: typeof body.model === 'string' ? body.model : undefined,
          hostRef: typeof body.hostRef === 'string' ? body.hostRef : undefined,
          operation:
            body.operation === 'completion_cancel' || body.operation === 'connection_test'
              ? body.operation
              : 'completion_stream',
        })
        res.status(200).json(result)
      } catch (err) {
        if (err instanceof LlmProviderAttemptRedeemError) {
          log.warn({ event: 'codex_attempt_redeem_denied', code: err.code }, err.message)
          res.status(REDEEM_STATUS[err.code] ?? 400).json({ error: err.code })
          return
        }
        throw err
      }
    })
  )

  router.post(
    '/internal/llm/provider-attempts/finalize',
    asyncHandler(async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {}
      try {
        const result = await finalizeLlmProviderAttempt({
          attemptReceipt: typeof body.attemptReceipt === 'string' ? body.attemptReceipt : '',
          receipt: body.receipt,
        })
        res.status(200).json(result)
      } catch (err) {
        if (err instanceof LlmProviderAttemptFinalizeError) {
          log.warn({ event: 'codex_attempt_finalize_denied', code: err.code }, err.message)
          res.status(FINALIZE_STATUS[err.code] ?? 400).json({ error: err.code })
          return
        }
        throw err
      }
    })
  )

  return router
}
