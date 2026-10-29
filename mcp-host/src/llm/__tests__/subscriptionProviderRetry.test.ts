import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maybeWrapFailover } from '../../core/adapters/failoverLlmPort'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { LlmErrorCode } from '../../core/errors'
import { isModelStepCheckpointEligibleError } from '../../core/orchestration/modelStepCheckpointEligibility'
import { logger } from '../../logger'
import { CodexLlmProxyClient, CodexProxyError } from '../codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { FailoverEngine } from '../failover/engine'
import type { LlmPolicy } from '../failover/types'
import { GrokLlmProxyClient, GrokProxyError } from '../grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../grokSubscription'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'
import { providerUnavailableRetryDelayMs } from '../rateLimitRetry'

describe.each([
  [
    'codex-subscription',
    'gpt-5.3-codex',
    CodexSubscriptionProvider,
    CodexProxyError,
    CodexLlmProxyClient,
  ],
  ['grok-subscription', 'grok-4.6', GrokSubscriptionProvider, GrokProxyError, GrokLlmProxyClient],
] as const)(
  '%s transient provider retry (F4)',
  (providerName, model, Provider, ProxyError, ProxyClient) => {
    const messages = [{ role: 'user' as const, content: 'continue' }]
    const ok = { text: 'recovered', toolCalls: [], outcome: 'success' as const }
    const call = { id: 'call-1', name: 'echo', arguments: { text: 'once' } }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    function setup(stream = vi.fn().mockResolvedValue(ok), providerAttemptIndex?: number) {
      const authorize = vi.fn(
        async (input: { providerAttemptIndex: number; requestHash: string }) => ({
          providerAttemptId: `attempt-${input.providerAttemptIndex}`,
          requestHash: input.requestHash,
          executionTicket: `ticket-${input.providerAttemptIndex}`,
          expiresAt: '2026-10-20T00:00:00.000Z',
        })
      )
      const wired = {
        authorizer: { authorize },
        proxy: { stream },
        attemptContext: () => ({
          policyRevision: 1,
          policyHash: 'b'.repeat(64),
          ...(providerAttemptIndex === undefined ? {} : { providerAttemptIndex }),
        }),
      }
      return { provider: new Provider(model, wired as never), wired, authorize, stream }
    }

    it('R2-M7 does not repeat a dispatched terminal error with tool output', async () => {
      const healthy = setup()
      await expect(healthy.provider.completeSingleTurn(messages)).resolves.toMatchObject({
        content: 'recovered',
      })
      expect(healthy.authorize).toHaveBeenCalledTimes(1)

      const failed = { text: 'generated', toolCalls: [call], outcome: 'error' as const }
      const { provider, authorize, stream } = setup(vi.fn().mockResolvedValue(failed))
      const settled = provider.completeSingleTurnWithTools(messages, []).catch(error => error)
      await vi.runAllTimersAsync()
      const error = await settled
      expect(provider.classifyError(error)).toMatchObject({
        providerCode: 'provider_unavailable',
        providerDispatched: true,
      })
      expect(stream).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(1)
    })

    it.each(['idle timeout', 'queued ticket refusal'])(
      'R2-M8 ends a dispatched %s after its first 300-second attempt',
      async reason => {
        const started = Date.now()
        const stream = vi.fn(
          () =>
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new ProxyError('provider_unavailable', reason)), 300_000)
            })
        )
        const { provider, authorize } = setup(stream)
        const settled = provider.completeSingleTurn(messages).catch(error => error)
        await vi.runAllTimersAsync()
        expect(await settled).toBeInstanceOf(ProxyError)
        expect(stream).toHaveBeenCalledTimes(1)
        expect(authorize).toHaveBeenCalledTimes(1)
        expect(Date.now() - started).toBe(300_000)
      }
    )

    it('R2-M7 keeps pre-dispatch authorization recovery live', async () => {
      const { provider, authorize, stream } = setup()
      authorize.mockRejectedValueOnce(new CodexAuthorizeError('provider_unavailable', 'refused'))
      const settled = expect(provider.completeSingleTurn(messages)).resolves.toMatchObject({
        content: 'recovered',
      })
      await vi.runAllTimersAsync()
      await settled
      expect(authorize).toHaveBeenCalledTimes(2)
      expect(stream).toHaveBeenCalledTimes(1)
    })

    it('R2-M7 treats missing dispatch proof as ineligible for transient retry', () => {
      expect(
        providerUnavailableRetryDelayMs(
          {
            code: LlmErrorCode.ModelOverloaded,
            retryable: true,
            message: 'unavailable',
            providerCode: 'provider_unavailable',
          },
          0
        )
      ).toBeUndefined()
    })

    it('F4 retries one transient failure with a fresh authorize and returns the result', async () => {
      const error = new ProxyError('provider_unavailable', 'pre-dispatch refusal', {
        dispatched: false,
      })
      const { provider, authorize, stream } = setup(
        vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(ok)
      )
      const outcome = provider.completeSingleTurn(messages).then(
        result => ({ result }),
        (error: unknown) => ({ error })
      )
      await vi.advanceTimersByTimeAsync(999)
      expect(authorize).toHaveBeenCalledTimes(1)
      expect(stream).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toMatchObject({
        result: {
          content: 'recovered',
          providerAttemptId: 'attempt-2',
          providerAttemptIndex: 2,
        },
      })
      expect(authorize).toHaveBeenCalledTimes(2)
      const [first, second] = authorize.mock.calls.map(([input]) => input)
      expect([first.providerAttemptIndex, second.providerAttemptIndex]).toEqual([1, 2])
      expect(second.requestHash).toBe(first.requestHash)
      expect(stream.mock.calls.map(([input]) => input.executionTicket)).toEqual([
        'ticket-1',
        'ticket-2',
      ])
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        {
          provider: providerName,
          providerAttemptIndex: 1,
          delayMs: 1000,
          errorCode: 'provider_unavailable',
        },
        'Retrying subscription provider attempt'
      )
    })

    it.each([
      [0, 800, 2400],
      [0.999999, 1200, 3600],
    ])(
      'F4 applies bounded jitter %s to both backoffs and can recover on the third attempt',
      async (random, firstDelay, secondDelay) => {
        vi.mocked(Math.random).mockReturnValue(random)
        const error = new ProxyError('provider_unavailable', 'pre-dispatch refusal', {
          dispatched: false,
        })
        const { provider, authorize, stream } = setup(
          vi
            .fn()
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(ok)
        )
        const settled = expect(provider.completeSingleTurn(messages)).resolves.toMatchObject({
          content: 'recovered',
          providerAttemptIndex: 3,
        })
        await vi.advanceTimersByTimeAsync(firstDelay - 1)
        expect(authorize).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(authorize).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(secondDelay - 1)
        expect(authorize).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(1)
        await settled
        expect(stream).toHaveBeenCalledTimes(3)
        expect(authorize.mock.calls.map(([input]) => input.providerAttemptIndex)).toEqual([1, 2, 3])
        expect(vi.mocked(logger.warn).mock.calls.map(([fields]) => fields.delayMs)).toEqual([
          firstDelay,
          secondDelay,
        ])
      }
    )

    it('F4 stops after three failures and rethrows the final original error unchanged', async () => {
      const errors = [1, 2, 3].map(
        index =>
          new ProxyError('provider_unavailable', `pre-dispatch refusal #${index}`, {
            dispatched: false,
          })
      )
      const { provider, authorize, stream } = setup(
        vi
          .fn()
          .mockRejectedValueOnce(errors[0])
          .mockRejectedValueOnce(errors[1])
          .mockRejectedValueOnce(errors[2])
      )
      const settled = expect(provider.completeSingleTurn(messages)).rejects.toBe(errors[2])
      await vi.advanceTimersByTimeAsync(1000)
      expect(authorize).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2999)
      expect(authorize).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await settled
      expect(authorize.mock.calls.map(([input]) => input.providerAttemptIndex)).toEqual([1, 2, 3])
      expect(stream).toHaveBeenCalledTimes(3)
      expect(logger.warn).toHaveBeenCalledTimes(2)
      expect(vi.mocked(logger.warn).mock.calls.map(([fields]) => fields.delayMs)).toEqual([
        1000, 3000,
      ])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(authorize).toHaveBeenCalledTimes(3)
    })

    it.each([
      [500, 1],
      [1500, 2],
    ])('F4 aborts at %i ms without any further authorize', async (abortAt, count) => {
      const { provider, authorize, stream } = setup(
        vi
          .fn()
          .mockRejectedValue(
            new ProxyError('provider_unavailable', 'pre-dispatch refusal', { dispatched: false })
          )
      )
      const controller = new AbortController()
      const reason = new Error('caller stopped during backoff')
      const settled = expect(
        provider.completeSingleTurn(messages, { signal: controller.signal })
      ).rejects.toBe(reason)
      await vi.advanceTimersByTimeAsync(abortAt)
      expect(authorize).toHaveBeenCalledTimes(count)
      expect(stream).toHaveBeenCalledTimes(count)
      controller.abort(reason)
      await settled
      await vi.advanceTimersByTimeAsync(60_000)
      expect(controller.signal.aborted).toBe(true)
      expect(authorize).toHaveBeenCalledTimes(count)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('F4 checks abort again when the backoff timer has already fired', async () => {
      const { provider, authorize, stream } = setup(
        vi
          .fn()
          .mockRejectedValue(
            new ProxyError('provider_unavailable', 'pre-dispatch refusal', { dispatched: false })
          )
      )
      const controller = new AbortController()
      const reason = new Error('caller stopped after timer')
      const remove = controller.signal.removeEventListener.bind(controller.signal)
      vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(
        (type, listener, options) => {
          remove(type, listener, options)
          controller.abort(reason)
        }
      )
      const settled = expect(
        provider.completeSingleTurn(messages, { signal: controller.signal })
      ).rejects.toBe(reason)
      await vi.advanceTimersByTimeAsync(1000)
      await settled
      expect(controller.signal.aborted).toBe(true)
      expect(stream).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(1)
    })

    it.each([
      'control_plane_unavailable',
      'authorize_timeout',
      'budget_denied',
      'insufficient_scope',
      'model_not_allowed',
      'connection_unavailable',
      'outcome_unknown',
      'canceled',
      'upstream_rejected',
    ])('F4 does not retry a non-eligible %s proxy error', async code => {
      const error = new ProxyError(code, 'refused')
      const { provider, authorize, stream } = setup(vi.fn().mockRejectedValue(error))
      const settled = expect(provider.completeSingleTurn(messages)).rejects.toBe(error)
      await vi.runAllTimersAsync()
      await settled
      expect(stream).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(1)
    })

    it.each([
      'control_plane_unavailable',
      'authorize_timeout',
      'budget_denied',
      'no_grant',
      'model_not_allowed',
    ])('F4 does not retry an authorize %s refusal', async code => {
      const { provider, authorize, stream } = setup()
      const error = new CodexAuthorizeError(code, 'refused')
      authorize.mockRejectedValue(error)
      const settled = expect(provider.completeSingleTurn(messages)).rejects.toBe(error)
      await vi.runAllTimersAsync()
      await settled
      expect(authorize).toHaveBeenCalledTimes(1)
      expect(stream).toHaveBeenCalledTimes(0)
    })

    it('F4 retries an eligible authorize failure under a fresh attempt index', async () => {
      const { provider, authorize, stream } = setup()
      authorize.mockRejectedValueOnce(
        new CodexAuthorizeError('provider_unavailable', 'upstream 503')
      )
      const settled = expect(provider.completeSingleTurn(messages)).resolves.toMatchObject({
        content: 'recovered',
      })
      await vi.runAllTimersAsync()
      await settled
      expect(authorize.mock.calls.map(([input]) => input.providerAttemptIndex)).toEqual([1, 2])
      expect(stream).toHaveBeenCalledTimes(1)
      expect(stream.mock.calls[0][0].executionTicket).toBe('ticket-2')
    })

    it('F4 leaves a caller-pinned attempt index to its owner', async () => {
      const error = new ProxyError('provider_unavailable', 'upstream 503')
      const { provider, authorize, stream } = setup(vi.fn().mockRejectedValue(error), 7)
      const settled = expect(provider.completeSingleTurn(messages)).rejects.toBe(error)
      await vi.runAllTimersAsync()
      await settled
      expect(stream).toHaveBeenCalledTimes(1)
      expect(authorize.mock.calls.map(([input]) => input.providerAttemptIndex)).toEqual([7])
    })

    it.each(['error', 'unknown'] as const)(
      'F4 discards dispatched %s tool frames without retry or execution',
      async outcome => {
        const { provider, authorize, stream } = setup(
          vi.fn().mockResolvedValue({ text: '', toolCalls: [call], outcome })
        )
        const executeTool = vi.fn()
        const turn = provider
          .completeSingleTurnWithTools(messages, [
            { name: 'echo', description: 'echo', parameters: {} },
          ])
          .then(result => {
            result.tool_calls?.forEach(executeTool)
            return result
          })
        const settled = expect(turn).rejects.toBeInstanceOf(ProxyError)
        await vi.runAllTimersAsync()
        await settled
        expect(stream).toHaveBeenCalledTimes(1)
        expect(authorize).toHaveBeenCalledTimes(1)
        expect(executeTool).toHaveBeenCalledTimes(0)
      }
    )

    it('F4 keeps failed real SSE text and tool frames from delivery without retry', async () => {
      function sse(frames: unknown[]) {
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      const fetchFn = vi.fn().mockResolvedValue(
        sse([
          { type: 'text', text: 'discarded partial' },
          { type: 'tool_call', ...call },
          { type: 'error', code: 'provider_unavailable' },
        ])
      )
      const { wired, authorize } = setup()
      const proxy = new ProxyClient({
        runtimeUrl: 'http://proxy/completions',
        readPlatformJwt: () => 'test-jwt',
        fetchFn: fetchFn as typeof fetch,
      })
      const provider = new Provider(model, { ...wired, proxy } as never)
      const deliver = vi.fn()
      const turn = provider.completeSingleTurnWithTools(messages, []).then(result => {
        deliver(result)
        return result
      })
      const settled = expect(turn).rejects.toBeInstanceOf(ProxyError)
      await vi.runAllTimersAsync()
      await settled
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(1)
      expect(deliver).toHaveBeenCalledTimes(0)
    })

    it('F4 returns successful output once and schedules no retry after delivery', async () => {
      const { provider, authorize, stream } = setup()
      const deliver = vi.fn()
      const result = await provider.completeSingleTurn(messages)
      deliver(result.content)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(deliver).toHaveBeenCalledExactlyOnceWith('recovered')
      expect(stream).toHaveBeenCalledTimes(1)
      expect(authorize).toHaveBeenCalledTimes(1)
    })

    it('F4 preserves checkpoint eligibility after exhausting pre-dispatch attempts through the real adapter', async () => {
      const error = new ProxyError('provider_unavailable', 'pre-dispatch refusal', {
        dispatched: false,
      })
      const { provider, authorize, stream } = setup(vi.fn().mockRejectedValue(error))
      const adapter = new LlmPortAdapter(provider, model, providerName)
      const outcome = adapter.completeWithTools({ messages, tools: [] }).catch((err: Error) => err)
      await vi.runAllTimersAsync()
      const caught = await outcome
      expect(caught).toBeInstanceOf(Error)
      expect(isModelStepCheckpointEligibleError(caught as Error)).toBe(true)
      expect(authorize).toHaveBeenCalledTimes(3)
      expect(stream).toHaveBeenCalledTimes(3)
    })

    it('F4 exhausts primary retries before the real failover engine calls a fallback', async () => {
      const order: string[] = []
      const primary = setup(
        vi.fn(async () => {
          order.push('primary')
          throw new ProxyError('provider_unavailable', 'pre-dispatch refusal', {
            dispatched: false,
          })
        })
      )
      const fallback = setup(
        vi.fn(async () => {
          order.push('fallback')
          return ok
        })
      )
      const policy: LlmPolicy = {
        cooldownSeconds: 300,
        triggerOn: ['provider_unavailable'],
        fallbacks: [{ provider: providerName, model }],
      }
      const port = maybeWrapFailover({
        primaryPort: new LlmPortAdapter(primary.provider, model, providerName),
        primaryPair: { provider: providerName, model },
        engine: new FailoverEngine(policy),
        policy,
        buildFallbackPort: () => new LlmPortAdapter(fallback.provider, model, providerName),
      })
      const settled = expect(
        port.completeWithTools({ messages, tools: [] })
      ).resolves.toMatchObject({ content: 'recovered' })
      await vi.advanceTimersByTimeAsync(3999)
      expect(primary.authorize).toHaveBeenCalledTimes(2)
      expect(fallback.authorize).toHaveBeenCalledTimes(0)
      await vi.advanceTimersByTimeAsync(1)
      await settled
      expect(primary.authorize).toHaveBeenCalledTimes(3)
      expect(fallback.authorize).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['primary', 'primary', 'primary', 'fallback'])
    })
  }
)
