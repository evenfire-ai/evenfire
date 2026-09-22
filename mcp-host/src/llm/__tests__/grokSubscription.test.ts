import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { classifyFailoverClass } from '../failover/classify'
import { GrokProxyError } from '../grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../grokSubscription'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'

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
    const oversized = provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    await expect(oversized).rejects.toBeInstanceOf(GrokProxyError)
    // The message is unchanged by the taxonomy work; only the code says this
    // is a contract limit rather than a provider outage.
    await expect(oversized).rejects.toMatchObject({
      name: 'GrokProxyError',
      code: 'tool_call_limit_exceeded',
      message: 'tool calls exceed 64',
    })

    const classified = provider.classifyError(
      new GrokProxyError('tool_call_limit_exceeded', 'tool calls exceed 64')
    )
    expect(classified.code).toBe(LlmErrorCode.ToolCallLimitExceeded)
    expect(classified.retryable).toBe(false)
    expect(classified.providerDispatched).toBe(true)
    // Retrying the same request produces the same limit, so failover must not
    // treat it as a provider outage worth trying elsewhere.
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
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

  it('authorizes through the gateway and returns proxy tool calls without executing them', async () => {
    const wired = deps({
      stream: vi.fn().mockResolvedValue({
        text: 'use a tool',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }],
        outcome: 'success',
      }),
    })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    const authorizedBody = wired.authorizer.authorize.mock.calls[0][0]
    expect(authorizedBody.request.provider).toBe('grok-subscription')
    expect(authorizedBody.request.model).toBe('grok-4.6')
    expect(authorizedBody.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(wired.proxy.stream).toHaveBeenCalledWith(
      expect.objectContaining({ executionTicket: 'ticket-123456', requestHash })
    )
    expect(result.tool_calls).toEqual([{ id: 'c1', name: 'echo', arguments: { x: 1 } }])
    expect(result.finish_reason).toBe('tool_use')
  })

  it('preserves assistant toolCalls and tool results in the authorize request', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    await provider.completeSingleTurnWithTools(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call-1', name: 'echo' },
      ],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    expect(wired.authorizer.authorize.mock.calls[0][0].request.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call-1', name: 'echo' },
    ])
  })

  it('does not authorize or call the proxy when aborted before authorize', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const attempt = provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      signal: AbortSignal.abort(),
    })
    await expect(attempt).rejects.toMatchObject({ code: 'canceled', dispatched: false })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()
  })

  it('issues a new authorize attempt index and request id on every physical call', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    await provider.completeSingleTurn([{ role: 'user', content: 'one' }])
    await provider.completeSingleTurn([{ role: 'user', content: 'two' }])
    const calls = wired.authorizer.authorize.mock.calls
    expect(calls[0][0].providerAttemptIndex).toBe(1)
    expect(calls[1][0].providerAttemptIndex).toBe(2)
    expect(calls[0][0].request.requestId).not.toBe(calls[1][0].request.requestId)
  })

  it('passes the selected model into attemptContext and uses a captured attempt index', async () => {
    const wired = deps()
    wired.attemptContext = vi.fn(() => ({
      policyRevision: 3,
      policyHash: 'c'.repeat(64),
      hostRef: 'chatllm',
      providerAttemptIndex: 7,
      invocationId: 'inv-9',
      pluginWorkloadSdkProviderAttemptId: 'sdk-attempt-9',
      targetRef: 'grok-primary',
    }))
    const provider = new GrokSubscriptionProvider('grok-4.6-mini', wired as never)
    const result = await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.attemptContext).toHaveBeenCalledWith({ model: 'grok-4.6-mini' })
    expect(wired.authorizer.authorize.mock.calls[0][0]).toMatchObject({
      providerAttemptIndex: 7,
      invocationId: 'inv-9',
      policyRevision: 3,
      policyHash: 'c'.repeat(64),
      pluginWorkloadSdkProviderAttemptId: 'sdk-attempt-9',
      targetRef: 'grok-primary',
    })
    expect(result.providerAttemptIndex).toBe(7)
  })

  it('keeps unknown usage unknown and forwards reported usage', async () => {
    const unknownUsage = await new GrokSubscriptionProvider(
      'grok-4.6',
      deps() as never
    ).completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(unknownUsage.usage_reported).toBe(false)
    expect(unknownUsage.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    expect(unknownUsage.providerAttemptId).toBe('attempt-1')

    const reported = await new GrokSubscriptionProvider(
      'grok-4.6',
      deps({
        stream: vi.fn().mockResolvedValue({
          text: 'ok',
          toolCalls: [],
          outcome: 'success',
          usage: { inputTokens: 11, outputTokens: 4 },
        }),
      }) as never
    ).completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(reported.usage_reported).toBe(true)
    expect(reported.usage).toEqual({ input_tokens: 11, output_tokens: 4, total_tokens: 15 })
  })

  it.each([1, 83, 250])(
    'preserves all %i approved tool definitions through authorization and dispatch',
    async count => {
      const wired = deps()
      const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
      const tools = Array.from({ length: count }, (_, i) => ({
        name: `eventasks__read_${i}`,
        description: 'read task',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
      }))
      await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Find a task' }], tools)
      const authorized = wired.authorizer.authorize.mock.calls[0][0]
      expect(authorized.request.tools).toEqual(tools)
      expect(wired.proxy.stream.mock.calls[0][0].request).toEqual(authorized.request)
    }
  )

  it('accepts exactly 64 tool calls from a successful batch', async () => {
    const toolCalls = Array.from({ length: 64 }, (_, index) => ({
      id: `call-${index}`,
      name: 'echo',
      arguments: {},
    }))
    const provider = new GrokSubscriptionProvider(
      'grok-4.6',
      deps({
        stream: vi.fn().mockResolvedValue({ text: '', outcome: 'success', toolCalls }),
      }) as never
    )
    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    expect(result.tool_calls).toHaveLength(64)
    const over = new GrokSubscriptionProvider(
      'grok-4.6',
      deps({
        stream: vi.fn().mockResolvedValue({
          text: '',
          outcome: 'success',
          toolCalls: [...toolCalls, { id: 'call-64', name: 'echo', arguments: {} }],
        }),
      }) as never
    )
    const rejected = over.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    await expect(rejected).rejects.toThrow(/tool calls exceed 64/)
    await expect(rejected).rejects.toMatchObject({ code: 'tool_call_limit_exceeded' })
  })

  it('refuses 129 messages before authorize and classifies the refusal as a context limit', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const message = { role: 'user' as const, content: 'hi' }

    // Liveness witness for the negative assertion below: the identical call
    // one message shorter does reach authorize, so "authorize was not called"
    // reports the guard rather than a provider that never ran.
    await provider.completeSingleTurn(Array.from({ length: 128 }, () => message))
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)

    const refused = provider.completeSingleTurn(Array.from({ length: 129 }, () => message))
    await expect(refused).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(refused).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'messages exceed 128',
    })
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)

    // A request too long for the contract is not an outage and not retryable;
    // `providerDispatched: false` is what proves nothing was billed for it,
    // and it comes from the authorize arm of the same expression.
    const classified = provider.classifyError(
      new CodexAuthorizeError('request_limit_exceeded', 'messages exceed 128')
    )
    expect(classified.code).toBe(LlmErrorCode.ContextLengthExceeded)
    expect(classified.retryable).toBe(false)
    expect(classified.providerDispatched).toBe(false)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  it('does not treat an unknown empty stream as a successful stop', async () => {
    const provider = new GrokSubscriptionProvider(
      'grok-4.6',
      deps({
        stream: vi.fn().mockResolvedValue({ text: '', toolCalls: [], outcome: 'unknown' }),
      }) as never
    )
    await expect(
      provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  // xAI refuses subscription inference when the client version it sees is below
  // its floor (live 426, probed 2026-09-18). An operator must act, so this is
  // not an overload and must not be retried or failed over.
  it('classifies a client upgrade requirement as non-retryable, not an overload', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const classified = provider.classifyError(
      new GrokProxyError('client_upgrade_required', 'xAI requires a newer Grok client version')
    )
    expect(classified).toMatchObject({
      code: LlmErrorCode.ModelNotAvailable,
      retryable: false,
      providerCode: 'client_upgrade_required',
    })
    expect(classified.code).not.toBe(LlmErrorCode.ModelOverloaded)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  it('classifies authorize denials as non-retryable and never dispatched', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const scope = provider.classifyError(new CodexAuthorizeError('insufficient_scope', 'scope'))
    expect(scope).toMatchObject({
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
      providerCode: 'insufficient_scope',
      providerDispatched: false,
    })

    const revoked = provider.classifyError(new CodexAuthorizeError('no_grant', 'revoked'))
    expect(revoked.code).toBe(LlmErrorCode.AuthenticationFailed)
    expect(revoked.retryable).toBe(false)
    expect(revoked.providerDispatched).toBe(false)
    expect(classifyFailoverClass(revoked.code, revoked.retryable)).toBe('auth')

    const budget = provider.classifyError(new CodexAuthorizeError('budget_denied', 'over'))
    expect(budget).toMatchObject({ code: LlmErrorCode.InsufficientQuota, retryable: false })

    const model = provider.classifyError(new CodexAuthorizeError('model_not_allowed', 'model'))
    expect(model).toMatchObject({ code: LlmErrorCode.ModelNotAvailable, retryable: false })

    const transient = provider.classifyError(
      new CodexAuthorizeError('connection_unavailable', 'catalog unavailable')
    )
    expect(transient.code).toBe(LlmErrorCode.ModelOverloaded)
    expect(transient.retryable).toBe(true)
    expect(classifyFailoverClass(transient.code, transient.retryable)).toBe('provider_unavailable')
  })

  it('maps transient proxy failures onto failover-eligible classes as dispatched', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const unavailable = provider.classifyError(
      new GrokProxyError('provider_unavailable', 'upstream 5xx')
    )
    expect(unavailable).toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      providerDispatched: true,
    })
    expect(classifyFailoverClass(unavailable.code, unavailable.retryable)).toBe(
      'provider_unavailable'
    )

    const limited = provider.classifyError(new GrokProxyError('rate_limited', 'upstream 429'))
    expect(limited).toMatchObject({ code: LlmErrorCode.RateLimited, retryable: true })
    expect(classifyFailoverClass(limited.code, limited.retryable)).toBe('rate_limited')

    expect(
      provider.classifyError(new GrokProxyError('canceled', 'aborted before authorize', false))
        .providerDispatched
    ).toBe(false)
    expect(provider.classifyError(new Error('who knows')).providerDispatched).toBeUndefined()
  })

  it('shares the caller deadline with the authorize hop and the proxy stream', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const controller = new AbortController()
    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })
    expect(wired.authorizer.authorize).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal,
    })
    expect(wired.proxy.stream.mock.calls[0][0].signal).toBe(controller.signal)

    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.authorizer.authorize).toHaveBeenNthCalledWith(2, expect.any(Object), {})
  })
})
