import { createHash } from 'node:crypto'
import { stableStringify } from '../utils/stableStringify.js'

export const CODEX_ATTEMPT_RECEIPT_SCHEMA_VERSION = 'codex-attempt-receipt.v1' as const

export type CodexAttemptReceiptV1 = {
  schemaVersion: typeof CODEX_ATTEMPT_RECEIPT_SCHEMA_VERSION
  providerAttemptId: string
  requestHash: string
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  usage?: { inputTokens?: number; outputTokens?: number }
}

export function hashCodexAttemptReceipt(receipt: CodexAttemptReceiptV1): string {
  return createHash('sha256').update(stableStringify(receipt)).digest('hex')
}
