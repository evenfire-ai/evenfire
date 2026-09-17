import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { classifyFailoverClass } from '../failover/classify'
import { GrokProxyError } from '../grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../grokSubscription'

const requestHash = 'a'.repeat(64)

function deps(overrides?: { stream?: ReturnType<typeof vi.fn> }) {
  const authorize = vi.fn().mockResolvedValue({
    providerAttemptId: 'attempt-1',
    requestHash,
    executionTicket: 'ticket-123456',
    expiresAt: '2026-08-20T10:00:00.000Z',
  })
  const stream =
    overrides?.stream ??
    vi.fn().mockResolvedValue({
      text: 'hello from grok proxy',
      toolCalls: [],
      outcome: 'success',
    })
  return {
    authorizer: { authorize },
    proxy: { stream },
    attemptContext: vi.fn(() => ({
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
      hostRef: 'chatllm',
    })),
  }
}

describe('GrokSubscriptionProvider', () => {
  it.each(['unknown', 'canceled', 'error'])(
    'never returns executable calls from a %s batch',
    async outcome => {
      const wired = deps({
        stream: vi.fn().mockResolvedValue({
          text: 'partial',
          outcome,
          toolCalls: [{ id: 'partial', name: 'echo', arguments: {} }],
        }),
      })
      const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
      await expect(
        provider.completeSingleTurnWithTools(
          [{ role: 'user', content: 'hi' }],
          [{ name: 'echo', description: 'echo', parameters: {} }]
        )
      ).rejects.toThrow(/successful terminal outcome/)
    }
  )

  it('rejects an oversized successful proxy batch before returning any executable tools', async () => {
    const wired = deps({
      stream: vi.fn().mockResolvedValue({
        text: '',
        outcome: 'success',
        toolCalls: Array.from({ length: 65 }, (_, index) => ({
          id: `call-${index}`,
          name: 'echo',
          arguments: {},
        })),
      }),
    })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    await expect(
      provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'echo', description: 'echo', parameters: {} }]
      )
    ).rejects.toBeInstanceOf(GrokProxyError)
  })
  it.each([
    ['unknown', 'partial grok text', 'outcome_unknown'],
    ['canceled', '', 'canceled'],
    ['canceled', 'partial grok text', 'canceled'],
  ] as const)(
    'rejects a non-success %s terminal outcome (text=%j) instead of completing',
    async (outcome, text, code) => {
      const stream = vi.fn().mockResolvedValue({ text, toolCalls: [], outcome })
      const provider = new GrokSubscriptionProvider('grok-4.6', deps({ stream }) as never)

      const single = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
      await expect(single).rejects.toBeInstanceOf(GrokProxyError)
      await expect(single).rejects.toMatchObject({ code, dispatched: true })

      await expect(
        provider.completeSingleTurnWithTools(
          [{ role: 'user', content: 'hi' }],
          [{ name: 'echo', description: 'echo', parameters: {} }]
        )
      ).rejects.toMatchObject({ code, dispatched: true })

      // A dispatched, non-success terminal state must stay fenced: not a
      // failover trigger and never proof that nothing was executed.
      const classified = provider.classifyError(new GrokProxyError(code, 'terminal'))
      expect(classified.code).toBe(LlmErrorCode.ApiCallFailed)
      expect(classified.retryable).toBe(false)
      expect(classified.providerDispatched).toBe(true)
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
    }
  )

  it('still completes a successful terminal outcome', async () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    await expect(
      provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    ).resolves.toMatchObject({ content: 'hello from grok proxy', finish_reason: 'stop' })
  })

  it('refuses to authorize without a Grok catalog policy binding using Grok wording', async () => {
    const wired = deps()
    wired.attemptContext = vi.fn().mockReturnValue({ policyRevision: 0, policyHash: '' })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const attempt = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    await expect(attempt).rejects.toMatchObject({ code: 'no_grant' })
    await expect(attempt).rejects.toThrow(/Grok catalog policy binding is missing/)
    await expect(attempt).rejects.not.toThrow(/Codex/)
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()
  })
})
