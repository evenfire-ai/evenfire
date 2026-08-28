import { parseCodexAttemptReceiptV1 } from '@clerum/llm-provider-attempt-contract'
import { config } from '../config.js'
import { withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { releaseReservation } from './budgets/reservations.js'
import { hashCodexAttemptReceipt } from './llmProviderAttemptReceipt.js'
import { opaqueAttemptReceipt } from './llmProviderAttemptRedemption.js'
import {
  loadLlmProviderAttempt,
  markLlmProviderAttemptFinalized,
} from './llmProviderAttemptStore.js'

const log = rootLogger.child({ module: 'llm-provider-attempt-finalization' })

export type LlmProviderAttemptFinalizeErrorCode =
  | 'disabled'
  | 'ticket_invalid'
  | 'request_hash_mismatch'
  | 'invalid_receipt'
  | 'conflict'

export class LlmProviderAttemptFinalizeError extends Error {
  constructor(
    readonly code: LlmProviderAttemptFinalizeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmProviderAttemptFinalizeError'
  }
}

export type FinalizeAttemptInput = {
  attemptReceipt: string
  receipt: unknown
}

export type FinalizeAttemptSuccess = {
  providerAttemptId: string
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  duplicate: boolean
}

export async function finalizeLlmProviderAttempt(
  input: FinalizeAttemptInput,
  runTransaction: typeof withTransaction = withTransaction
): Promise<FinalizeAttemptSuccess> {
  if (!config.codexSubscriptionEnabled) {
    throw new LlmProviderAttemptFinalizeError('disabled', 'Codex subscription is disabled')
  }
  if (typeof input.attemptReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(input.attemptReceipt)) {
    throw new LlmProviderAttemptFinalizeError('invalid_receipt', 'attemptReceipt is invalid')
  }
  const parsed = parseCodexAttemptReceiptV1(input.receipt)
  if (!parsed.ok) {
    throw new LlmProviderAttemptFinalizeError('invalid_receipt', parsed.message)
  }
  const receipt = parsed.value

  return runTransaction(async tx => {
    const attempt = await loadLlmProviderAttempt(tx, receipt.providerAttemptId)
    if (!attempt) {
      throw new LlmProviderAttemptFinalizeError('ticket_invalid', 'provider attempt was not found')
    }
    if (attempt.requestHash !== receipt.requestHash) {
      throw new LlmProviderAttemptFinalizeError(
        'request_hash_mismatch',
        'receipt requestHash does not match the attempt'
      )
    }

    const ticketRow = (
      await tx.query(
        `SELECT jti::text FROM llm_provider_attempt_tickets WHERE provider_attempt_id = $1`,
        [attempt.id]
      )
    ).rows[0] as { jti?: string } | undefined
    const jti = ticketRow?.jti ? String(ticketRow.jti) : ''
    const opaque = opaqueAttemptReceipt({
      jti,
      providerAttemptId: attempt.id,
      requestHash: attempt.requestHash,
    })
    if (opaque !== input.attemptReceipt) {
      throw new LlmProviderAttemptFinalizeError(
        'ticket_invalid',
        'attemptReceipt does not authorize this attempt'
      )
    }

    const receiptHash = hashCodexAttemptReceipt(receipt)
    const result = await markLlmProviderAttemptFinalized(tx, {
      providerAttemptId: attempt.id,
      receiptHash,
      outcome: receipt.outcome,
      usageInputTokens: receipt.usage?.inputTokens,
      usageOutputTokens: receipt.usage?.outputTokens,
    })
    if (result === 'missing') {
      throw new LlmProviderAttemptFinalizeError('ticket_invalid', 'provider attempt was not found')
    }
    if (result === 'conflict') {
      throw new LlmProviderAttemptFinalizeError(
        'conflict',
        'provider attempt already has a different terminal outcome'
      )
    }
    if (attempt.budgetReservationId && attempt.budgetReservationId !== 'unbudgeted') {
      await releaseReservation(
        { reservationId: attempt.budgetReservationId, hostRef: attempt.hostRef },
        tx
      )
    }
    log.info(
      {
        event: 'codex_attempt_finalized',
        providerAttemptId: attempt.id,
        outcome: receipt.outcome,
        duplicate: result === 'duplicate',
      },
      'finalized Codex provider attempt'
    )
    return {
      providerAttemptId: attempt.id,
      outcome: receipt.outcome,
      duplicate: result === 'duplicate',
    }
  })
}
