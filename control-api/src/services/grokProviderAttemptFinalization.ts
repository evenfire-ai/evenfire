import { createHash } from 'node:crypto'
import {
  type GrokAttemptReceiptV1,
  parseGrokAttemptReceiptV1,
} from '@clerum/grok-provider-attempt-contract'
import { config } from '../config.js'
import { type DbClient, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import { stableStringify } from '../utils/stableStringify.js'
import { releaseReservation } from './budgets/reservations.js'
import { opaqueAttemptReceipt } from './llmProviderAttemptRedemption.js'
import {
  type LlmProviderAttemptRow,
  loadLlmProviderAttempt,
  markLlmProviderAttemptFinalized,
} from './llmProviderAttemptStore.js'
import { ingestUsageEventsInTransaction } from './usageEvents.js'

const log = rootLogger.child({ module: 'grok-provider-attempt-finalization' })

export type GrokProviderAttemptFinalizeErrorCode =
  | 'disabled'
  | 'ticket_invalid'
  | 'request_hash_mismatch'
  | 'invalid_receipt'
  | 'conflict'

export class GrokProviderAttemptFinalizeError extends Error {
  constructor(
    readonly code: GrokProviderAttemptFinalizeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'GrokProviderAttemptFinalizeError'
  }
}

export type FinalizeGrokAttemptInput = {
  attemptReceipt: string
  receipt: unknown
}

export type FinalizeGrokAttemptSuccess = {
  providerAttemptId: string
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  duplicate: boolean
}

function hashGrokAttemptReceipt(receipt: GrokAttemptReceiptV1): string {
  return createHash('sha256').update(stableStringify(receipt)).digest('hex')
}

export async function finalizeGrokProviderAttempt(
  input: FinalizeGrokAttemptInput,
  runTransaction: typeof withTransaction = withTransaction
): Promise<FinalizeGrokAttemptSuccess> {
  if (!config.grokSubscriptionEnabled) {
    throw new GrokProviderAttemptFinalizeError('disabled', 'Grok subscription is disabled')
  }
  if (typeof input.attemptReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(input.attemptReceipt)) {
    throw new GrokProviderAttemptFinalizeError('invalid_receipt', 'attemptReceipt is invalid')
  }
  const parsed = parseGrokAttemptReceiptV1(input.receipt)
  if (!parsed.ok) {
    throw new GrokProviderAttemptFinalizeError('invalid_receipt', parsed.message)
  }
  const receipt = parsed.value

  return runTransaction(async tx => {
    const attempt = await loadLlmProviderAttempt(tx, receipt.providerAttemptId)
    if (!attempt) {
      throw new GrokProviderAttemptFinalizeError('ticket_invalid', 'provider attempt was not found')
    }
    if (attempt.provider !== 'grok-subscription') {
      throw new GrokProviderAttemptFinalizeError(
        'ticket_invalid',
        'attempt provider is not grok-subscription'
      )
    }
    if (attempt.requestHash !== receipt.requestHash) {
      throw new GrokProviderAttemptFinalizeError(
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
      throw new GrokProviderAttemptFinalizeError(
        'ticket_invalid',
        'attemptReceipt does not authorize this attempt'
      )
    }

    const receiptHash = hashGrokAttemptReceipt(receipt)
    const result = await markLlmProviderAttemptFinalized(tx, {
      providerAttemptId: attempt.id,
      receiptHash,
      outcome: receipt.outcome,
      usageInputTokens: receipt.usage?.inputTokens,
      usageOutputTokens: receipt.usage?.outputTokens,
    })
    if (result === 'missing') {
      throw new GrokProviderAttemptFinalizeError('ticket_invalid', 'provider attempt was not found')
    }
    if (result === 'conflict') {
      throw new GrokProviderAttemptFinalizeError(
        'conflict',
        'provider attempt already has a different terminal outcome'
      )
    }
    if (result === 'applied') {
      await ingestGrokFinalizeLedgerRow(tx, attempt, receipt)
    }
    if (attempt.budgetReservationId && attempt.budgetReservationId !== 'unbudgeted') {
      await releaseReservation(
        { reservationId: attempt.budgetReservationId, hostRef: attempt.hostRef },
        tx
      )
    }
    log.info(
      {
        event: 'grok_attempt_finalized',
        providerAttemptId: attempt.id,
        outcome: receipt.outcome,
        duplicate: result === 'duplicate',
      },
      'finalized Grok provider attempt'
    )
    return {
      providerAttemptId: attempt.id,
      outcome: receipt.outcome,
      duplicate: result === 'duplicate',
    }
  })
}

async function ingestGrokFinalizeLedgerRow(
  tx: DbClient,
  attempt: LlmProviderAttemptRow,
  receipt: GrokAttemptReceiptV1
): Promise<void> {
  if (receipt.outcome !== 'success') return
  const inputTokens = receipt.usage?.inputTokens
  const outputTokens = receipt.usage?.outputTokens
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return
  }
  await ingestUsageEventsInTransaction(
    [
      {
        request_id: attempt.id,
        ts: new Date().toISOString(),
        run_id: null,
        host_ref: attempt.hostRef,
        context_ref: null,
        team_id: null,
        provider: attempt.provider,
        model: attempt.model,
        llm_secret_name: null,
        source_kind: 'channel',
        user_id: null,
        sender: null,
        channel_type: null,
        recipe_name: attempt.recipeName ?? null,
        cron_job_id: null,
        task_id: null,
        iteration: null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_tokens_reported: false,
        prompt_bridge_metadata: null,
      },
    ],
    tx,
    undefined,
    { origin: 'finalize' }
  )
}
