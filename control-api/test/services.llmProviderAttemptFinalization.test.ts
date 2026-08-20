import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import { finalizeLlmProviderAttempt } from '../src/services/llmProviderAttemptFinalization.js'
import { hashCodexAttemptReceipt } from '../src/services/llmProviderAttemptReceipt.js'

describe('finalizeLlmProviderAttempt', () => {
  it('rejects a malformed receipt without inventing usage', async () => {
    config.codexSubscriptionEnabled = true
    await expect(
      finalizeLlmProviderAttempt({
        attemptReceipt: 'not-a-hash',
        receipt: { outcome: 'success' },
      })
    ).rejects.toMatchObject({ code: 'invalid_receipt' })
    expect(hashCodexAttemptReceipt).toBeTypeOf('function')
  })

  it('is disabled when the flag is off', async () => {
    config.codexSubscriptionEnabled = false
    await expect(
      finalizeLlmProviderAttempt({
        attemptReceipt: 'a'.repeat(64),
        receipt: {
          schemaVersion: 'codex-attempt-receipt.v1',
          providerAttemptId: '33333333-3333-4333-8333-333333333333',
          requestHash: 'b'.repeat(64),
          outcome: 'success',
        },
      })
    ).rejects.toMatchObject({ code: 'disabled' })
  })
})
