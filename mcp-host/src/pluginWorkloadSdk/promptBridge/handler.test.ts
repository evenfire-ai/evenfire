import { describe, expect, it, vi } from 'vitest'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import type { PluginWorkloadSdkControlApiClient } from './controlApiClient'
import {
  FINALIZE_LEDGER_RETRY_DELAYS_MS,
  PromptBridgeHandler,
  type PromptBridgeHandlerDeps,
  finalizeWithLedgerRetry,
  isLedgerPendingError,
} from './handler'
import type { LlmBridge } from './llmBridge'

const validBody = {
  purpose: 'summarization',
  idempotencyKey: 'key-1',
  messages: [{ role: 'user', content: 'summarize this' }],
}
const primary: PromptBridgeTarget = {
  targetRef: 'primary-zai',
  provider: 'zai',
  model: 'glm-4.7',
  credentialSlot: 'zai-api-key',
}
const fallback: PromptBridgeTarget = {
  targetRef: 'fallback-openai',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  credentialSlot: 'openai-api-key',
}

type FinalizePromptBridge = NonNullable<PromptBridgeHandlerDeps['finalizePromptBridge']>

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 2,
    invocationId: 'inv-1',
    replay: false,
    providerCallRequired: true,
    status: 'in_progress',
    model: primary.model,
    modelPolicy: null,
    selectedTarget: primary,
    authorizedTargets: [primary, fallback],
    attemptGeneration: 1,
    policyRevision: 7,
    policyHash: 'a'.repeat(64),
    maxOutputTokens: null,
    ...overrides,
  }
}

function makeDeps(
  overrides: {
    ensure?: ReturnType<typeof vi.fn>
    authorize?: ReturnType<typeof vi.fn>
    complete?: ReturnType<typeof vi.fn>
    report?: ReturnType<typeof vi.fn>
    bootstrap?: () => { provider: string; model: string } | null
    onUsage?: (usage: any) => void
    finalize?: FinalizePromptBridge
  } = {}
) {
  const authorize = overrides.authorize ?? vi.fn().mockResolvedValue(authorization())
  const report = overrides.report ?? vi.fn().mockResolvedValue(undefined)
  const complete =
    overrides.complete ??
    vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
  const handler = new PromptBridgeHandler({
    controlApiClient: {
      ensurePromptBridgeCapabilities: overrides.ensure ?? vi.fn().mockResolvedValue(undefined),
      authorizePromptBridge: authorize,
      reissuePromptBridgeCredentialTicket: vi.fn(),
      reportProviderAttemptStatus: vi.fn().mockResolvedValue(undefined),
      reportInvocationStatus: report,
    } as unknown as PluginWorkloadSdkControlApiClient,
    llmBridge: { complete } as unknown as LlmBridge,
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'r1',
    promptTimeoutMs: 120_000,
    ...(overrides.bootstrap ? { getBootstrapTarget: overrides.bootstrap } : {}),
    ...(overrides.finalize ? { finalizePromptBridge: overrides.finalize } : {}),
    onUsage: overrides.onUsage,
  })
  return { handler, authorize, complete, report }
}

describe('PromptBridgeHandler', () => {
  it('rejects invalid input before authorizing', async () => {
    const { handler, authorize } = makeDeps()
    await expect(
      handler.handle({ ...validBody, purpose: 'jailbreak' }, 'api')
    ).rejects.toMatchObject({
      code: 'invalid_request',
    })
    await expect(
      handler.handle({ ...validBody, idempotencyKey: 'has spaces!' }, 'api')
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects oversized content before authorizing', async () => {
    const { handler, authorize } = makeDeps()
    await expect(
      handler.handle(
        { ...validBody, messages: [{ role: 'user', content: 'x'.repeat(128 * 1024 + 1) }] },
        'api'
      )
    ).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('lets the operator default resolve omission and forwards selectors unchanged', async () => {
    const { handler, authorize } = makeDeps()
    await handler.handle(validBody, 'api')
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined, provider: undefined, targetRef: undefined })
    )

    await handler.handle(
      { ...validBody, idempotencyKey: 'key-2', provider: 'openai', model: 'gpt-5.4-mini' },
      'api'
    )
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.4-mini' })
    )
  })

  it('forwards the live spec.agent binding to authorization', async () => {
    const { handler, authorize } = makeDeps({
      bootstrap: () => ({ provider: 'zai', model: 'glm-4.7' }),
    })
    await handler.handle(validBody, 'api')
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapProvider: 'zai', bootstrapModel: 'glm-4.7' })
    )
  })

  it('fails before authorization while the host bootstrap binding is not ready', async () => {
    const { handler, authorize } = makeDeps({ bootstrap: () => null })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('reports missing operator policy as a policy denial before creating an invocation', async () => {
    const ensure = vi
      .fn()
      .mockRejectedValue(
        new PluginWorkloadError(
          'provider_policy_denied',
          'an active operator grant is required',
          false
        )
      )
    const { handler, authorize, complete, report } = makeDeps({ ensure })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_policy_denied',
      retryable: false,
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('passes exactly the signed authorized suffix and returns the served target', async () => {
    const onUsage = vi.fn()
    const { handler, complete, report } = makeDeps({ onUsage })
    const result = await handler.handle(validBody, 'api')

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'inv-1',
        targets: [{ target: primary }, { target: fallback }],
      })
    )
    expect(result).toMatchObject({
      invocationId: 'inv-1',
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      policyRevision: 7,
      content: 'summary text',
    })
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'complete', 1)
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: fallback.model,
        servedTarget: fallback,
        fallbackUsed: true,
        llmSecretName: 'provider-secret',
        attemptCount: 2,
      })
    )
  })

  // R4-H2. J8 dropped the clamp on the premise that nothing enforced the
  // ceiling. That held only for codex-subscription, whose ChatGPT wire rejects
  // `max_output_tokens`; every API-key provider does send it, so for them the
  // per-grant cap was a working billing control that the removal silenced.
  it('clamps the workload maxTokens down to the grant ceiling', async () => {
    const authorize = vi.fn().mockResolvedValue(authorization({ maxOutputTokens: 4096 }))
    const { handler, complete } = makeDeps({ authorize })
    await handler.handle({ ...validBody, maxTokens: 9000 }, 'api')
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }))
  })

  it('applies the grant ceiling when the workload names no maxTokens', async () => {
    const authorize = vi.fn().mockResolvedValue(authorization({ maxOutputTokens: 4096 }))
    const { handler, complete } = makeDeps({ authorize })
    await handler.handle(validBody, 'api')
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }))
  })

  it('passes the workload maxTokens through when the grant sets no ceiling', async () => {
    const { handler, complete } = makeDeps()
    await handler.handle({ ...validBody, maxTokens: 9000 }, 'api')
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 9000 }))
  })

  it('sends no maxTokens when neither the workload nor the grant names one', async () => {
    const { handler, complete } = makeDeps()
    await handler.handle(validBody, 'api')
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ maxTokens: undefined })
  })

  it.each([0, -1, 1.5])('rejects a non-positive-integer maxTokens (%s)', async maxTokens => {
    const { handler, complete } = makeDeps()
    await expect(handler.handle({ ...validBody, maxTokens }, 'api')).rejects.toMatchObject({
      code: 'invalid_request',
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('preserves metering when the logical terminal acknowledgement is unavailable', async () => {
    const report = vi.fn().mockRejectedValue(new Error('control-api unavailable'))
    const onUsage = vi.fn()
    const { handler, complete } = makeDeps({ report, onUsage })

    const result = await handler.handle(validBody, 'api')

    expect(result).toMatchObject({ invocationId: 'inv-1', content: 'summary text' })
    expect(complete).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'complete', 1)
    // The provider-attempt receipt is authoritative for usage binding, so a
    // lost logical ACK must not silently discard the billable usage event.
    expect(onUsage).toHaveBeenCalledOnce()
  })

  it('closes the invocation as provider_unavailable when the physical receipt is unknown', async () => {
    const report = vi.fn().mockResolvedValue(undefined)
    const complete = vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
      providerAttemptAcknowledgement: 'failed',
    })
    const onUsage = vi.fn()
    const { handler } = makeDeps({ complete, report, onUsage })

    const result = await handler.handle(validBody, 'api')

    expect(result).toMatchObject({ invocationId: 'inv-1', content: 'summary text' })
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'provider_unavailable', 1)
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('does not repeat a provider charge for an existing non-failed replay', async () => {
    const authorize = vi
      .fn()
      .mockResolvedValue(
        authorization({ replay: true, providerCallRequired: false, status: 'complete' })
      )
    const { handler, complete } = makeDeps({ authorize })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('propagates authorization errors without calling the LLM', async () => {
    const authorize = vi
      .fn()
      .mockRejectedValue(new PluginWorkloadError('ambiguous_model', 'ambiguous', false))
    const { handler, complete } = makeDeps({ authorize })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'ambiguous_model',
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('reports pre-provider credential/configuration failures as revivable failed invocations', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(
        new PluginWorkloadError(
          'provider_unavailable',
          'credentials unavailable',
          false,
          'credential_unavailable',
          false
        )
      )
    const { handler, report } = makeDeps({ complete })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: false,
    })
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'failed', 1)
  })

  it('atomically finalizes the physical attempt as not_executed in SDK-only mode', async () => {
    const finalize = vi.fn<FinalizePromptBridge>().mockResolvedValue({
      invocationId: 'inv-1',
      providerAttemptId: 'attempt-1',
      status: 'failed',
      outcome: 'not_executed',
      idempotent: false,
      usageAccepted: false,
    })
    const complete = vi.fn().mockRejectedValue(
      new PluginWorkloadError(
        'provider_unavailable',
        'credentials unavailable',
        false,
        'credential_unavailable',
        false,
        {
          providerAttemptId: 'attempt-1',
          providerAttemptIndex: 1,
          target: primary,
          attemptCount: 1,
          fallbackUsed: false,
        }
      )
    )
    const { handler, report } = makeDeps({ complete, finalize })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'credential_unavailable',
    })
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        status: 'failed',
        reason: 'credential_unavailable',
        target: primary,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('keeps an ambiguous/post-provider failure terminal even when the public code is the same', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(
        new PluginWorkloadError(
          'provider_unavailable',
          'provider outcome unknown',
          false,
          'outcome_unknown',
          true
        )
      )
    const { handler, report } = makeDeps({ complete })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'outcome_unknown',
    })
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'provider_unavailable', 1)
  })

  it('preserves the original provider error when the failure audit acknowledgement fails', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new PluginWorkloadError('provider_unavailable', 'provider failed', false))
    const report = vi.fn().mockRejectedValue(new Error('control-api unavailable'))
    const { handler } = makeDeps({ complete, report })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'provider failed',
    })
  })

  it('uses the SDK-only finalizer instead of separate status and usage reporting', async () => {
    const finalize = vi.fn<FinalizePromptBridge>().mockResolvedValue({
      invocationId: 'inv-1',
      providerAttemptId: 'attempt-1',
      status: 'complete',
      outcome: 'exact',
      idempotent: false,
      usageAccepted: true,
    })
    const onUsage = vi.fn()
    const complete = vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      providerAttemptId: 'attempt-1',
      providerAttemptIndex: 2,
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
    const { handler, report } = makeDeps({ complete, finalize, onUsage })

    await expect(handler.handle(validBody, 'api')).resolves.toMatchObject({
      invocationId: 'inv-1',
      content: 'summary text',
    })
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        providerAttemptIndex: 2,
        status: 'complete',
        target: fallback,
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(report).not.toHaveBeenCalled()
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('records an unknown spend receipt before returning an ambiguous provider error', async () => {
    const finalize = vi.fn<FinalizePromptBridge>().mockResolvedValue({
      invocationId: 'inv-1',
      providerAttemptId: 'attempt-1',
      status: 'provider_unavailable',
      outcome: 'unknown',
      idempotent: false,
      usageAccepted: false,
    })
    const complete = vi.fn().mockRejectedValue(
      new PluginWorkloadError(
        'provider_unavailable',
        'provider outcome unknown',
        false,
        'outcome_unknown',
        true,
        {
          providerAttemptId: 'attempt-1',
          providerAttemptIndex: 1,
          target: primary,
          attemptCount: 1,
          fallbackUsed: false,
          llmSecretName: 'provider-secret',
        }
      )
    )
    const { handler, report } = makeDeps({ complete, finalize })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'outcome_unknown',
    })
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'provider_unavailable',
        reason: 'outcome_unknown',
        target: primary,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('bounds ledger_pending patience to a fixed four-attempt table', () => {
    expect(FINALIZE_LEDGER_RETRY_DELAYS_MS).toEqual([500, 1000, 2000])
    // Four attempts, three waits: the table length IS the retry budget.
    expect(FINALIZE_LEDGER_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBe(3_500)
  })

  it('recognises only the ledger_pending triple as a retryable finalize error', () => {
    expect(
      isLedgerPendingError(
        new PluginWorkloadError(
          'provider_unavailable',
          'linked Codex attempt has not finalized usage yet',
          true,
          'provider_unavailable'
        )
      )
    ).toBe(true)
    // Retryable but reasonless: control-api 5xx, open breaker, exhausted
    // transport retries. Those already burnt their own backoff inside postOnce.
    expect(
      isLedgerPendingError(
        new PluginWorkloadError('provider_unavailable', 'control-api responded 503', true)
      )
    ).toBe(false)
    expect(
      isLedgerPendingError(
        new PluginWorkloadError(
          'provider_unavailable',
          'not retryable',
          false,
          'provider_unavailable'
        )
      )
    ).toBe(false)
    expect(
      isLedgerPendingError(
        new PluginWorkloadError('provider_unavailable', 'other reason', true, 'timeout')
      )
    ).toBe(false)
    expect(isLedgerPendingError(new Error('plain'))).toBe(false)
  })

  it('does not retry a retryable finalize error that is not ledger_pending', async () => {
    const finalize = vi
      .fn<FinalizePromptBridge>()
      .mockRejectedValue(
        new PluginWorkloadError('provider_unavailable', 'control-api responded 503', true)
      )
    const complete = vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      providerAttemptId: 'attempt-1',
      providerAttemptIndex: 2,
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
    const { handler } = makeDeps({ complete, finalize })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'outcome_unknown',
    })
    // One attempt on the complete path, then one on the error path (N-11).
    // Neither retries: the error is retryable but carries no `reason`.
    expect(finalize).toHaveBeenCalledTimes(2)
    expect(finalize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'complete' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(finalize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'provider_unavailable' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('exhausts exactly the table budget on a persistent ledger_pending', async () => {
    const finalize = vi
      .fn<FinalizePromptBridge>()
      .mockRejectedValue(
        new PluginWorkloadError(
          'provider_unavailable',
          'linked Codex attempt has not finalized usage yet',
          true,
          'provider_unavailable'
        )
      )
    const complete = vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      providerAttemptId: 'attempt-1',
      providerAttemptIndex: 2,
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
    const { handler } = makeDeps({ complete, finalize })

    vi.useFakeTimers()
    try {
      // Attach the rejection handler before advancing the clock, or the
      // in-flight rejection surfaces as an unhandled rejection.
      const settled = expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
        code: 'provider_unavailable',
        reason: 'outcome_unknown',
      })
      await vi.runAllTimersAsync()
      await settled
    } finally {
      vi.useRealTimers()
    }
    // Four attempts per finalize path, never five. The complete path exhausts
    // its budget, then the error path (N-11) settles the same receipt with a
    // budget of its own — the documented worst case of two bounded deadlines.
    expect(finalize).toHaveBeenCalledTimes((FINALIZE_LEDGER_RETRY_DELAYS_MS.length + 1) * 2)
  })

  it('surfaces ledger_pending without another wait once its deadline is aborted', async () => {
    const pendingError = new PluginWorkloadError(
      'provider_unavailable',
      'linked Codex attempt has not finalized usage yet',
      true,
      'provider_unavailable'
    )
    const finalize = vi.fn<FinalizePromptBridge>().mockRejectedValue(pendingError)

    await expect(
      finalizeWithLedgerRetry(
        finalize,
        {
          invocationId: 'inv-1',
          attemptGeneration: 1,
          providerAttemptId: 'attempt-1',
          providerAttemptIndex: 1,
          status: 'complete',
          reason: 'provider_completed',
          target: primary,
        },
        AbortSignal.abort()
      )
    ).rejects.toBe(pendingError)
    // An expired deadline buys neither another attempt nor another sleep, and
    // the real pending error reaches the caller instead of a synthetic one.
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('retries ledger_pending on the error path with the same bounded budget', async () => {
    const finalize = vi
      .fn<FinalizePromptBridge>()
      .mockRejectedValueOnce(
        new PluginWorkloadError(
          'provider_unavailable',
          'linked Codex attempt has not finalized usage yet',
          true,
          'provider_unavailable'
        )
      )
      .mockResolvedValueOnce({
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        status: 'provider_unavailable',
        outcome: 'unknown',
        idempotent: false,
        usageAccepted: false,
      })
    const complete = vi.fn().mockRejectedValue(
      new PluginWorkloadError(
        'provider_unavailable',
        'provider outcome unknown',
        false,
        'outcome_unknown',
        true,
        {
          providerAttemptId: 'attempt-1',
          providerAttemptIndex: 1,
          target: primary,
          attemptCount: 1,
          fallbackUsed: false,
        }
      )
    )
    const { handler, report } = makeDeps({ complete, finalize })

    vi.useFakeTimers()
    try {
      const settled = expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
        code: 'provider_unavailable',
        reason: 'outcome_unknown',
      })
      await vi.runAllTimersAsync()
      await settled
    } finally {
      vi.useRealTimers()
    }
    expect(finalize).toHaveBeenCalledTimes(2)
    expect(finalize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'provider_unavailable' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    // The retry succeeded, so the legacy invocation-status report stays silent.
    expect(report).not.toHaveBeenCalled()
  })

  it('retries a retryable complete finalization before treating the outcome as unknown', async () => {
    const finalize = vi
      .fn<FinalizePromptBridge>()
      .mockRejectedValueOnce(
        new PluginWorkloadError(
          'provider_unavailable',
          'linked Codex attempt has not finalized usage yet',
          true,
          'provider_unavailable'
        )
      )
      .mockResolvedValueOnce({
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        status: 'complete',
        outcome: 'exact',
        idempotent: false,
        usageAccepted: false,
      })
    const complete = vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      providerAttemptId: 'attempt-1',
      providerAttemptIndex: 2,
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
    const { handler, report } = makeDeps({ complete, finalize })

    vi.useFakeTimers()
    try {
      const pending = handler.handle(validBody, 'api')
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({
        invocationId: 'inv-1',
        content: 'summary text',
      })
    } finally {
      vi.useRealTimers()
    }
    expect(finalize).toHaveBeenCalledTimes(2)
    expect(finalize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'complete' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(finalize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'complete' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('reconciles an exact-finalization failure into a durable unknown receipt', async () => {
    const finalize = vi
      .fn<FinalizePromptBridge>()
      .mockRejectedValueOnce(new Error('finalization transaction lost'))
      .mockResolvedValueOnce({
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        status: 'provider_unavailable',
        outcome: 'unknown',
        idempotent: false,
        usageAccepted: false,
      })
    const complete = vi.fn().mockResolvedValue({
      model: fallback.model,
      servedTarget: fallback,
      fallbackUsed: true,
      attemptCount: 2,
      llmSecretName: 'provider-secret',
      providerAttemptId: 'attempt-1',
      providerAttemptIndex: 2,
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
    const { handler, report } = makeDeps({ complete, finalize })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      reason: 'outcome_unknown',
    })
    expect(finalize).toHaveBeenCalledTimes(2)
    expect(finalize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'complete' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(finalize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'provider_unavailable', reason: 'outcome_unknown' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(report).not.toHaveBeenCalled()
  })

  it('does not return an SDK-only completion without a physical attempt receipt', async () => {
    const finalize = vi.fn<FinalizePromptBridge>()
    const complete = vi.fn().mockResolvedValue({
      model: primary.model,
      servedTarget: primary,
      fallbackUsed: false,
      attemptCount: 1,
      llmSecretName: '',
      providerAttemptAcknowledgement: 'owned_by_finalizer',
      content: 'ok',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'complete',
    })
    const { handler } = makeDeps({ complete, finalize })

    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'provider attempt receipt is missing from the SDK-only completion',
    })
    expect(finalize).not.toHaveBeenCalled()
  })
})
