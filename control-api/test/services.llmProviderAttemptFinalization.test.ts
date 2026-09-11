import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import { finalizeLlmProviderAttempt } from '../src/services/llmProviderAttemptFinalization.js'
import { hashCodexAttemptReceipt } from '../src/services/llmProviderAttemptReceipt.js'
import { opaqueAttemptReceipt } from '../src/services/llmProviderAttemptRedemption.js'

const ingest = vi.hoisted(() => vi.fn())
const loadAttempt = vi.hoisted(() => vi.fn())
const markFinalized = vi.hoisted(() => vi.fn())

vi.mock('../src/services/usageEvents.js', () => ({
  ingestUsageEventsInTransaction: (...args: unknown[]) => ingest(...args),
}))
vi.mock('../src/services/llmProviderAttemptStore.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/llmProviderAttemptStore.js')>()
  return {
    ...actual,
    loadLlmProviderAttempt: (...args: unknown[]) => loadAttempt(...args),
    markLlmProviderAttemptFinalized: (...args: unknown[]) => markFinalized(...args),
  }
})

const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_HASH = 'b'.repeat(64)
const JTI = 'jti-finalize'

const attemptRow = {
  id: ATTEMPT_ID,
  callerKind: 'host' as const,
  hostRef: 'research-host',
  recipeName: null,
  requestHash: REQUEST_HASH,
  model: 'gpt-5.1',
  provider: 'codex-subscription' as const,
  budgetReservationId: 'unbudgeted',
}

const successReceipt = {
  schemaVersion: 'codex-attempt-receipt.v1' as const,
  providerAttemptId: ATTEMPT_ID,
  requestHash: REQUEST_HASH,
  outcome: 'success' as const,
  usage: { inputTokens: 12, outputTokens: 4 },
}

function attemptReceipt(): string {
  return opaqueAttemptReceipt({
    jti: JTI,
    providerAttemptId: ATTEMPT_ID,
    requestHash: REQUEST_HASH,
  })
}

function runTx(tx: { query: ReturnType<typeof vi.fn> }) {
  return async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx)
}

describe('finalizeLlmProviderAttempt', () => {
  beforeEach(() => {
    config.codexSubscriptionEnabled = true
    ingest.mockReset()
    loadAttempt.mockReset()
    markFinalized.mockReset()
  })

  it('rejects a malformed receipt without inventing usage', async () => {
    await expect(
      finalizeLlmProviderAttempt({
        attemptReceipt: 'not-a-hash',
        receipt: { outcome: 'success' },
      })
    ).rejects.toMatchObject({ code: 'invalid_receipt' })
    expect(hashCodexAttemptReceipt).toBeTypeOf('function')
    expect(ingest).not.toHaveBeenCalled()
  })

  it('is disabled when the flag is off', async () => {
    config.codexSubscriptionEnabled = false
    await expect(
      finalizeLlmProviderAttempt({
        attemptReceipt: 'a'.repeat(64),
        receipt: {
          schemaVersion: 'codex-attempt-receipt.v1',
          providerAttemptId: ATTEMPT_ID,
          requestHash: REQUEST_HASH,
          outcome: 'success',
        },
      })
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(ingest).not.toHaveBeenCalled()
  })

  it('ingests exactly one channel ledger row on first success finalize', async () => {
    loadAttempt.mockResolvedValueOnce(attemptRow)
    markFinalized.mockResolvedValueOnce('applied')
    ingest.mockResolvedValueOnce({
      result: { accepted: 1, duplicates: 0, rejected: 0 },
      acceptedEvents: [{ request_id: ATTEMPT_ID }],
    })
    const tx = { query: vi.fn().mockResolvedValue({ rows: [{ jti: JTI }] }) }

    const result = await finalizeLlmProviderAttempt(
      { attemptReceipt: attemptReceipt(), receipt: successReceipt },
      runTx(tx) as never
    )

    expect(result).toEqual({
      providerAttemptId: ATTEMPT_ID,
      outcome: 'success',
      duplicate: false,
    })
    expect(ingest).toHaveBeenCalledTimes(1)
    const [events, db, binding, options] = ingest.mock.calls[0] as unknown[]
    expect(db).toBe(tx)
    expect(binding).toBeUndefined()
    expect(options).toEqual({ origin: 'finalize' })
    expect(events).toEqual([
      expect.objectContaining({
        request_id: ATTEMPT_ID,
        host_ref: 'research-host',
        recipe_name: null,
        provider: 'codex-subscription',
        model: 'gpt-5.1',
        source_kind: 'channel',
        user_id: null,
        sender: null,
        team_id: null,
        context_ref: null,
        llm_secret_name: null,
        channel_type: null,
        input_tokens: 12,
        output_tokens: 4,
      }),
    ])
  })

  it('does not ingest on duplicate finalize', async () => {
    loadAttempt.mockResolvedValueOnce(attemptRow)
    markFinalized.mockResolvedValueOnce('duplicate')
    const tx = { query: vi.fn().mockResolvedValue({ rows: [{ jti: JTI }] }) }

    const result = await finalizeLlmProviderAttempt(
      { attemptReceipt: attemptReceipt(), receipt: successReceipt },
      runTx(tx) as never
    )

    expect(result.duplicate).toBe(true)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('does not ingest cancel, error, unknown, or success without both token counts', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [{ jti: JTI }] }) }
    const cases = [
      { outcome: 'canceled' as const },
      { outcome: 'error' as const },
      { outcome: 'unknown' as const },
      { outcome: 'success' as const, usage: { inputTokens: 3 } },
    ]
    for (const extra of cases) {
      loadAttempt.mockResolvedValueOnce(attemptRow)
      markFinalized.mockResolvedValueOnce('applied')
      await finalizeLlmProviderAttempt(
        {
          attemptReceipt: attemptReceipt(),
          receipt: {
            schemaVersion: 'codex-attempt-receipt.v1',
            providerAttemptId: ATTEMPT_ID,
            requestHash: REQUEST_HASH,
            ...extra,
          },
        },
        runTx(tx) as never
      )
    }
    expect(ingest).not.toHaveBeenCalled()
  })

  it('rolls back when finalize ingest cannot bind a single ledger row', async () => {
    loadAttempt.mockResolvedValueOnce(attemptRow)
    markFinalized.mockResolvedValueOnce('applied')
    ingest.mockResolvedValueOnce({
      result: { accepted: 0, duplicates: 0, rejected: 1 },
      acceptedEvents: [],
    })
    const tx = { query: vi.fn().mockResolvedValue({ rows: [{ jti: JTI }] }) }

    await expect(
      finalizeLlmProviderAttempt(
        { attemptReceipt: attemptReceipt(), receipt: successReceipt },
        runTx(tx) as never
      )
    ).rejects.toMatchObject({ code: 'invalid_receipt' })
  })
})
