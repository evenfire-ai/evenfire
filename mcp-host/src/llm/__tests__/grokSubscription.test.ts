import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GROK_VISUAL_LIMITS,
  LIMITS,
  hashCanonicalGrokRequest,
} from '@clerum/grok-provider-attempt-contract'
import { minifiedMcpResult } from '../../__tests__/fixtures/minifiedMcpResult'
import { LlmErrorCode } from '../../core/errors'
import type { ChatMessage, MessageContentPart } from '../../core/types'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { classifyFailoverClass } from '../failover/classify'
import { GrokProxyError } from '../grokLlmProxyClient'
import { GrokSubscriptionProvider } from '../grokSubscription'
import {
  CodexAuthorizeError,
  ProviderAttemptAuthorizer,
  resolveCodexAuthorizeUrl,
} from '../providerAttemptAuthorizer'
import {
  GROK_JPEG_2X2_BASE64,
  GROK_PNG_2X2_BASE64,
  GROK_PNG_9000_BASE64,
  grokPngOfDecodedBytesBase64,
} from './grokImageFixtures'

const requestHash = 'a'.repeat(64)

function deps(overrides?: {
  authorize?: ReturnType<typeof vi.fn>
  stream?: ReturnType<typeof vi.fn>
}) {
  const authorize =
    overrides?.authorize ??
    vi.fn().mockResolvedValue({
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
        toolCalls: Array.from({ length: 257 }, (_, index) => ({
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
      message: 'tool calls exceed 256',
    })

    const classified = provider.classifyError(
      new GrokProxyError('tool_call_limit_exceeded', 'tool calls exceed 256')
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

  // T-MB-5 — the proxy's 408 for a body upload over its read deadline. The
  // upstream never saw the body; a retryable class would cost the provider a
  // failover cooldown for what is the Host's own slow upload.
  it('T-MB-5d classifies request_timeout as a non-retryable ApiCallFailed', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const message = 'proxy stream failed with 408 (request_timeout)'
    const classified = provider.classifyError(new GrokProxyError('request_timeout', message))
    expect(classified).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message,
      providerCode: 'request_timeout',
      providerDispatched: true,
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  // T-TE-1 (D4) — control-api answers 403 `ticket_expired` when the redeem
  // arrives after the execution ticket's `exp`. The attempt never reached the
  // provider, so it is a capacity race: re-authorizing yields a fresh ticket.
  // `ticket_replayed` and `ticket_invalid` are defects and stay terminal.
  it('T-TE-1d classifies ticket_expired as a retryable ApiCallFailed that fails over', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const classified = provider.classifyError(
      new GrokProxyError('ticket_expired', 'proxy stream failed with 403 (ticket_expired)')
    )
    expect(classified).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'execution ticket expired before redeem; re-authorize',
      providerCode: 'ticket_expired',
      providerDispatched: true,
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBe(
      'provider_unavailable'
    )
  })

  it.each([
    ['ticket_replayed', 409],
    ['ticket_invalid', 403],
  ] as const)('T-TE-1d keeps %s a non-retryable ApiCallFailed', (code, status) => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const message = `proxy stream failed with ${status} (${code})`
    const classified = provider.classifyError(new GrokProxyError(code, message))
    expect(classified).toEqual({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message,
      providerCode: code,
      providerDispatched: true,
    })
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

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

  it('accepts exactly 256 tool calls from a successful batch', async () => {
    const toolCalls = Array.from({ length: 256 }, (_, index) => ({
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
    expect(result.tool_calls).toHaveLength(256)
    const over = new GrokSubscriptionProvider(
      'grok-4.6',
      deps({
        stream: vi.fn().mockResolvedValue({
          text: '',
          outcome: 'success',
          toolCalls: [...toolCalls, { id: 'call-256', name: 'echo', arguments: {} }],
        }),
      }) as never
    )
    const rejected = over.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    await expect(rejected).rejects.toThrow(/tool calls exceed 256/)
    await expect(rejected).rejects.toMatchObject({ code: 'tool_call_limit_exceeded' })
  })

  it('refuses 1025 messages before authorize and classifies the refusal as a context limit', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const message = { role: 'user' as const, content: 'hi' }

    // Liveness witness for the negative assertion below: the identical call
    // one message shorter does reach authorize, so "authorize was not called"
    // reports the guard rather than a provider that never ran. The returned
    // completion is part of the witness — a call that reached authorize and
    // then failed downstream would satisfy the call count alone — and it is
    // also the only case that falsifies the bound this PR replaced, where 1024
    // messages were refused.
    await expect(
      provider.completeSingleTurn(Array.from({ length: 1024 }, () => message))
    ).resolves.toMatchObject({ content: 'hello from grok proxy', finish_reason: 'stop' })
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)

    const refused = provider.completeSingleTurn(Array.from({ length: 1025 }, () => message))
    await expect(refused).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(refused).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'messages exceed 1024',
    })
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)

    // A request too long for the contract is not an outage and not retryable;
    // `providerDispatched: false` is what proves nothing was billed for it,
    // and it comes from the authorize arm of the same expression.
    const classified = provider.classifyError(
      new CodexAuthorizeError('request_limit_exceeded', 'messages exceed 1024')
    )
    expect(classified.code).toBe(LlmErrorCode.ContextLengthExceeded)
    expect(classified.retryable).toBe(false)
    expect(classified.providerDispatched).toBe(false)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  it('T-R3-1c-grok dispatches a 2 MiB conversation instead of refusing it (#731)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const large = [
      { role: 'user' as const, content: 'summarize every contact' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_1', name: 'crm_search_contacts', arguments: { q: '*' } }],
      },
      {
        role: 'tool' as const,
        content: minifiedMcpResult(3, 2 * 1024 * 1024),
        tool_call_id: 'call_1',
        name: 'crm_search_contacts',
      },
    ]
    expect(Buffer.byteLength(JSON.stringify(large), 'utf8')).toBeGreaterThan(2 * 1024 * 1024)

    await provider.completeSingleTurn(large)
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C-grok reports an over-sized request as request_limit_exceeded before authorize (#731)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The Grok mirror of T-C. The guard above refuses on message count; this
    // history is 4 messages, so the refusal can only come from the
    // canonical-hash path (`hashCanonicalGrokRequest` in `execute`) - the one
    // that measures real bytes. #728 classified the message count correctly and left
    // this path reporting `invalid_request`, which is what reached the user as
    // "Connection Error", a label that reads as transient.
    const oversized = [
      { role: 'system' as const, content: 'you are a helpful assistant' },
      { role: 'user' as const, content: 'list every contact' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_1', name: 'crm_search_contacts', arguments: { q: '*' } }],
      },
      {
        role: 'tool' as const,
        // Sized from the contract, so the payload stays over the cap whatever
        // its value; the escaped quotes of minified JSON push it past.
        content: minifiedMcpResult(3, LIMITS.maxRequestBodyBytes),
        tool_call_id: 'call_1',
        name: 'crm_search_contacts',
      },
    ]

    const rejected = provider.completeSingleTurn(oversized)
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      // The contract's own wording. Asserting it is the positive witness that
      // the refusal came from the byte bound and not from some earlier guard,
      // which is what keeps the `not.toHaveBeenCalled` below from being vacuous.
      message: 'request exceeds maxRequestBodyBytes',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })

    // Liveness witness: the same provider authorizes and streams a small turn,
    // so the rejection above is a property of the payload, not of the wiring.
    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C2-grok reports a 257-call assistant message as request_limit_exceeded before authorize (#731)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The `messages[i].toolCalls` bound has no guard ahead of it in this file -
    // unlike the message count, which `execute` refuses itself before hashing. It can
    // only be reached through the canonical hash, which makes it the one size
    // refusal whose classification depends entirely on the regex list. 257 is
    // the right number because #728 raised `maxToolCalls` to 256 (`8e12900e6`);
    // against the earlier bound of 64 this message would not have overrun.
    const calls = Array.from({ length: 257 }, (_, index) => ({
      id: `call_${index}`,
      name: 'echo',
      arguments: {},
    }))
    const history = [
      { role: 'user' as const, content: 'run everything' },
      { role: 'assistant' as const, content: '', tool_calls: calls },
    ]

    const rejected = provider.completeSingleTurn(history)
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'messages[1].toolCalls exceed 256',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })

    // Liveness witness: 256 calls on the same message authorize and stream.
    await provider.completeSingleTurn([
      history[0],
      { ...history[1], tool_calls: calls.slice(0, 256) },
    ])
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C3-grok reports the element bound as request_limit_exceeded before authorize (#731)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // This body fits the byte cap. The independent element bound refuses it
    // before authorize and must remain a non-retryable context-length error.
    const history = [
      { role: 'user' as const, content: 'summarize the export' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            name: 'export_rows',
            arguments: { ids: new Array<number>(LIMITS.maxRequestElements + 1).fill(0) },
          },
        ],
      },
    ]

    const rejected = provider.completeSingleTurn(history)
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'request exceeds maxRequestElements',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })

    // Liveness witness: the same call with a one-element array goes through.
    await provider.completeSingleTurn([
      history[0],
      {
        ...history[1],
        tool_calls: [{ id: 'call_1', name: 'export_rows', arguments: { ids: [0] } }],
      },
    ])
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C3b-grok reports the container bound as a non-retryable context-length failure (A8)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The Grok twin of T-C3b. The refusal carries `kind: 'size'` and matches
    // no `CONTEXT_LENGTH_REFUSALS` row or attachment row, so it reaches the
    // user through `payload_too_large` as `ContextLengthExceeded`. The array
    // holds maxRequestContainers + 1 objects in well under 8 MiB.
    const rows = (count: number) => Array.from({ length: count }, () => ({}))
    const history = (count: number) => [
      { role: 'user' as const, content: 'summarize the export' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_1', name: 'export_rows', arguments: { rows: rows(count) } }],
      },
    ]

    const rejected = provider.completeSingleTurn(history(LIMITS.maxRequestContainers + 1))
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'payload_too_large',
      message: 'request exceeds maxRequestContainers',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })

    // Liveness witness: the same shape with a few objects goes through.
    await provider.completeSingleTurn(history(3))
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C3c-grok surfaces the proxy member-bound 413 as a non-retryable context-length failure', async () => {
    const wired = deps({
      stream: vi
        .fn()
        .mockRejectedValue(new GrokProxyError('payload_too_large', 'proxy refused the envelope')),
    })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The Grok twin of T-C3c. The proxy's raw-body scan refuses a body over
    // `BODY_STRUCTURE_LIMITS.maxMembers` with HTTP 413
    // `body.structure.too.many.members`, which reaches mcp-host as
    // `payload_too_large`. A small turn passes every local guard, so the
    // refusal can only come from the proxy's member scan: the classify call
    // sees the same `payload_too_large` code the real 413 carries.
    const rejected = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    await expect(rejected).rejects.toBeInstanceOf(GrokProxyError)
    await expect(rejected).rejects.toMatchObject({
      code: 'payload_too_large',
      dispatched: true,
    })

    const err = await rejected.catch((e: unknown) => e)
    const classified = provider.classifyError(err)
    expect(classified).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
      providerCode: 'payload_too_large',
      providerDispatched: true,
    })
    // Retrying or failing over cannot shrink a body the proxy already counted:
    // this is a context-length refusal, not a provider outage.
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()

    // Liveness witness: the request actually reached the proxy path.
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C3d-grok reports the local member bound as a non-retryable context-length failure (R2-H1)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The local member-bound twin of T-C3b-grok. `checkStructure` refuses a
    // request over `maxRequestMembers` with `kind: 'size'` and the message
    // `request exceeds maxRequestMembers`, which matches no
    // `CONTEXT_LENGTH_REFUSALS` row or attachment row, so — exactly like the
    // container bound — it reaches the user through `payload_too_large`, which
    // classifies as `ContextLengthExceeded`. A single flat object of scalar
    // keys trips the member bound (262144) before the element bound (1048576)
    // and adds only one container, so neither of those can be what refuses it.
    const fields = (count: number) => {
      const object: Record<string, number> = {}
      for (let i = 0; i < count; i++) object['f' + i] = 1
      return object
    }
    const history = (count: number) => [
      { role: 'user' as const, content: 'summarize the export' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_1', name: 'export_rows', arguments: { fields: fields(count) } }],
      },
    ]

    const rejected = provider.completeSingleTurn(history(LIMITS.maxRequestMembers + 1))
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'payload_too_large',
      message: 'request exceeds maxRequestMembers',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })

    // Liveness witness: the same shape with a few members goes through.
    await provider.completeSingleTurn(history(3))
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C4-grok keeps a nesting-depth refusal out of the context-length taxonomy (#731)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The near miss of the partition. Nesting depth fails with `code: 'limit'`
    // and a message that shares the `request exceeds max` prefix with the byte
    // bound, so it is the refusal that a widened byte pattern swallows first.
    // T-C5-grok's distant miss cannot see that widening. Compaction cannot fix
    // depth: a shorter conversation keeps whatever depth the surviving arguments
    // have, so it has to stay `invalid_request`.
    let nested: unknown = 'leaf'
    for (let i = 0; i < 80; i++) nested = [nested]
    const history = [
      { role: 'user' as const, content: 'walk the tree' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'call_1', name: 'walk', arguments: { nested } }],
      },
    ]

    const rejected = provider.completeSingleTurn(history)
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/^request exceeds maximum nesting depth 64$/),
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    // The positive label, not only "not context-length": a remap of
    // `invalid_request` to a retryable class would send the same refusal back
    // to the contract on every retry.
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
    })

    // Liveness witness: the same shape at a legal depth authorizes and streams,
    // so the refusal is the depth and not the arguments payload as such.
    let shallow: unknown = 'leaf'
    for (let i = 0; i < 8; i++) shallow = [shallow]
    await provider.completeSingleTurn([
      history[0],
      {
        ...history[1],
        tool_calls: [{ id: 'call_1', name: 'walk', arguments: { nested: shallow } }],
      },
    ])
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C5-grok keeps an out-of-range maxOutputTokens out of the context-length taxonomy (#731)', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    // The negative half of the partition: a mutation that collapses the ternary
    // to `request_limit_exceeded` turns this test red.
    // `generation.maxOutputTokens is out of range`
    // (`parseGeneration` in `grok-provider-attempt-contract/index.cjs`) is a `limit` refusal that
    // shares no prefix with any of the three regexes, so it is the distant miss:
    // it survives a narrow widening and fails only under one broad enough to
    // swallow an unrelated field. `max_tokens` reaches the contract from the
    // caller unclamped (`completeSingleTurn` -> `execute` -> `buildRequest`,
    // which copies `max_tokens` into `generation.maxOutputTokens`), so this is a
    // refusal a caller can provoke, not a synthetic one.
    const history = [{ role: 'user' as const, content: 'summarize' }]

    const rejected = provider.completeSingleTurn(history, { max_tokens: 16_385 })
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'generation.maxOutputTokens is out of range',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    // The positive label, not only "not context-length": a remap of
    // `invalid_request` to a retryable class would send the same refusal back
    // to the contract on every retry.
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
    })

    // Liveness witness: the bound itself authorizes and streams, so the refusal
    // is the range check and not the presence of `max_tokens` in the request.
    await provider.completeSingleTurn(history, { max_tokens: 16_384 })
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
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

  // A response whose tool-call arguments overrun the transport budget is a size
  // refusal, the same family as a request that overruns `maxMessages`. Reading
  // it as an overload would retry the identical oversized call and, being
  // failover-eligible, would spend a second provider on it.
  it('classifies oversized tool-call arguments as a size refusal, not an overload', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const classified = provider.classifyError(
      new GrokProxyError(
        'tool_call_arguments_exceeded',
        `tool call arguments exceed ${LIMITS.maxRequestBodyBytes}`
      )
    )
    expect(classified).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
      providerCode: 'tool_call_arguments_exceeded',
    })
    expect(classified.code).not.toBe(LlmErrorCode.ModelOverloaded)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  // The proxy refused a tool call whose arguments are not a JSON object. The
  // model output is invalid, so retrying or failing over would re-run the turn
  // on a response the contract already rejected.
  it('classifies invalid tool-call arguments as an invalid response, not an overload', () => {
    const provider = new GrokSubscriptionProvider('grok-4.6', deps() as never)
    const classified = provider.classifyError(
      new GrokProxyError(
        'invalid_tool_arguments',
        'proxy stream failed with invalid_tool_arguments'
      )
    )
    expect(classified).toEqual({
      code: LlmErrorCode.InvalidResponse,
      retryable: false,
      message: 'proxy stream failed with invalid_tool_arguments',
      providerCode: 'invalid_tool_arguments',
      providerDispatched: true,
    })
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

    const binding = provider.classifyError(
      new GrokProxyError(
        'host_binding_mismatch',
        'proxy stream failed with 403 (host_binding_mismatch)'
      )
    )
    expect(binding).toMatchObject({
      code: LlmErrorCode.AuthenticationFailed,
      retryable: false,
      providerCode: 'host_binding_mismatch',
    })
    expect(classifyFailoverClass(binding.code, binding.retryable)).toBe('auth')

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
      provider.classifyError(
        new GrokProxyError('canceled', 'aborted before authorize', { dispatched: false })
      ).providerDispatched
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

// ─── #784 G4b: Grok image input ───────────────────────────────────────────
//
// The Grok twin of the Codex V2 projection (#660) and of R9-11: parts ride on
// user messages only, every image names its source, and a contract image
// budget refusal reaches the Desktop as "Invalid Attachment" with a sentence
// naming the Grok limit.

type ImagePart = Extract<MessageContentPart, { type: 'image' }>

const QUESTION = 'what is on screen?'
const attachmentImage = (
  data: string,
  attachmentId: string,
  mimeType: ImagePart['mimeType'] = 'image/png'
): ImagePart => ({
  type: 'image',
  mimeType,
  data,
  source: { kind: 'attachment', attachmentId, messageId: 'msg-1' },
})
const userWithImages = (parts: ImagePart[], preamble?: string): ChatMessage[] => [
  ...(preamble !== undefined ? [{ role: 'user' as const, content: preamble }] : []),
  {
    role: 'user',
    content: QUESTION,
    contentParts: [{ type: 'text', text: QUESTION }, ...parts],
  },
]

describe('GrokSubscriptionProvider image input (#784)', () => {
  it('T-G4b-1 authorizes an attachment image as a V2 request the contract re-derives', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    await provider.completeSingleTurn(
      userWithImages([attachmentImage(GROK_PNG_2X2_BASE64, 'att-1')])
    )

    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    const body = wired.authorizer.authorize.mock.calls[0][0]
    expect(body.request.schemaVersion).toBe('grok-completion-request.v2')
    expect(body.request.messages).toEqual([
      {
        role: 'user',
        content: QUESTION,
        contentParts: [
          { type: 'text', text: QUESTION },
          {
            type: 'image',
            mimeType: 'image/png',
            data: GROK_PNG_2X2_BASE64,
            source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' },
          },
        ],
      },
    ])
    // control-api and the proxy hash the JSON wire copy; the Host must agree.
    const rederived = hashCanonicalGrokRequest(JSON.parse(JSON.stringify(body.request)))
    if (!rederived.ok) throw new Error(rederived.message)
    expect(rederived.value.requestHash).toBe(body.requestHash)
    expect(wired.proxy.stream.mock.calls[0][0].request).toEqual(body.request)
  })

  it('T-G4b-2 carries a tool screenshot on a user message with a tool source', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    await provider.completeSingleTurnWithTools(
      [
        { role: 'user', content: 'take a screenshot' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tc-1', name: 'browser_screenshot', arguments: {} }],
        },
        {
          role: 'tool',
          content: 'screenshot captured',
          tool_call_id: 'tc-1',
          name: 'browser_screenshot',
        },
        {
          role: 'user',
          content: 'Screenshot from browser_screenshot',
          contentParts: [
            { type: 'text', text: 'Screenshot from browser_screenshot' },
            {
              type: 'image',
              mimeType: 'image/jpeg',
              data: GROK_JPEG_2X2_BASE64,
              source: { kind: 'tool', attachmentId: 'shot-1', toolCallId: 'tc-1' },
            },
          ],
        },
      ],
      [{ name: 'browser_screenshot', description: 'screenshot', parameters: {} }]
    )

    const request = wired.authorizer.authorize.mock.calls[0][0].request
    expect(request.schemaVersion).toBe('grok-completion-request.v2')
    const withParts = request.messages.filter(
      (message: { contentParts?: unknown }) => message.contentParts !== undefined
    )
    // Exactly one message carries parts, and it is the user frame; the
    // assistant and tool messages keep their V1 shape inside the V2 request.
    expect(withParts).toHaveLength(1)
    expect(withParts[0].role).toBe('user')
    expect(withParts[0].contentParts[1]).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      data: GROK_JPEG_2X2_BASE64,
      source: { kind: 'tool', attachmentId: 'shot-1', toolCallId: 'tc-1' },
    })
    expect(request.messages[2]).toEqual({
      role: 'tool',
      content: 'screenshot captured',
      toolCallId: 'tc-1',
      name: 'browser_screenshot',
    })
  })

  it('T-G4b-2b projects a GFS read to its tool-call source on the Grok wire', async () => {
    // The twin of the Codex test #670 added: a GFS image names the read that
    // produced it, and the contract's closed source union carries it as `tool`.
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    await provider.completeSingleTurnWithTools(
      userWithImages([
        {
          type: 'image',
          mimeType: 'image/png',
          data: GROK_PNG_2X2_BASE64,
          source: {
            kind: 'gfs',
            drive: 'main',
            resourceId: 'a'.repeat(32),
            gfsUri: `gfs://main/${'a'.repeat(32)}`,
            version: 7,
            name: 'image.png',
            attachmentId: 'gfs-read-attachment',
            toolCallId: 'gfs-read-call',
          },
        },
      ]),
      []
    )

    const body = wired.authorizer.authorize.mock.calls[0][0]
    expect(body.request.messages[0].contentParts[1].source).toEqual({
      kind: 'tool',
      attachmentId: 'gfs-read-attachment',
      toolCallId: 'gfs-read-call',
    })
    const rederived = hashCanonicalGrokRequest(JSON.parse(JSON.stringify(body.request)))
    if (!rederived.ok) throw new Error(rederived.message)
    expect(rederived.value.requestHash).toBe(body.requestHash)
  })

  it('T-G4b-3 keeps text and image parts in their original order', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    await provider.completeSingleTurn([
      {
        role: 'user',
        content: 'before\nafter',
        contentParts: [
          { type: 'text', text: 'before' },
          attachmentImage(GROK_PNG_2X2_BASE64, 'att-1'),
          { type: 'text', text: 'after' },
        ],
      },
    ])

    const [message] = wired.authorizer.authorize.mock.calls[0][0].request.messages
    expect(message.content).toBe('before\nafter')
    expect(message.contentParts.map((part: { type: string }) => part.type)).toEqual([
      'text',
      'image',
      'text',
    ])
  })

  it('T-G4b-4 sends a 9000x9000 image, since Grok has no dimension limit', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    await provider.completeSingleTurn(
      userWithImages([attachmentImage(GROK_PNG_9000_BASE64, 'att-large')])
    )

    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    const [message] = wired.authorizer.authorize.mock.calls[0][0].request.messages
    expect(message.contentParts[1].data).toBe(GROK_PNG_9000_BASE64)
  })

  it('T-G4b-5 refuses parts on a non-user message instead of dropping them', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const rejected = await provider
      .completeSingleTurn([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'look',
          contentParts: [{ type: 'text', text: 'look' }, attachmentImage(GROK_PNG_2X2_BASE64, 'a')],
        },
      ])
      .catch((e: unknown) => e)

    expect(rejected).toBeInstanceOf(CodexAuthorizeError)
    expect(rejected).toMatchObject({
      code: 'invalid_request',
      message: 'content parts are only supported on user messages (role=assistant)',
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()

    // Liveness witness: the same provider authorizes and streams a small turn.
    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing source', { type: 'image', mimeType: 'image/png', data: GROK_PNG_2X2_BASE64 }],
    [
      'empty attachmentId',
      {
        type: 'image',
        mimeType: 'image/png',
        data: GROK_PNG_2X2_BASE64,
        source: { kind: 'attachment', attachmentId: ' ', messageId: 'msg-1' },
      },
    ],
    [
      'empty messageId',
      {
        type: 'image',
        mimeType: 'image/png',
        data: GROK_PNG_2X2_BASE64,
        source: { kind: 'attachment', attachmentId: 'att-1', messageId: '' },
      },
    ],
    [
      'empty toolCallId',
      {
        type: 'image',
        mimeType: 'image/png',
        data: GROK_PNG_2X2_BASE64,
        source: { kind: 'tool', attachmentId: 'shot-1', toolCallId: '' },
      },
    ],
  ] as Array<[string, ImagePart]>)(
    'T-G4b-6 refuses an image with %s as image_source_invalid before authorize',
    async (detail, part) => {
      const wired = deps()
      const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

      const rejected = await provider
        .completeSingleTurn(userWithImages([part]))
        .catch((e: unknown) => e)

      expect(rejected).toBeInstanceOf(CodexAuthorizeError)
      expect(rejected).toMatchObject({
        code: 'image_source_invalid',
        message: `image part has no usable provenance source (${detail}); host producers must attach the attachment or tool call it came from`,
      })
      expect(wired.authorizer.authorize).not.toHaveBeenCalled()
      expect(wired.proxy.stream).not.toHaveBeenCalled()

      const classified = provider.classifyError(rejected)
      expect(classified).toMatchObject({
        code: LlmErrorCode.ApiCallFailed,
        retryable: false,
        providerDispatched: false,
      })
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()

      // Liveness witness: the same provider authorizes a well-sourced image.
      await provider.completeSingleTurn(
        userWithImages([attachmentImage(GROK_PNG_2X2_BASE64, 'att-1')])
      )
      expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    }
  )

  const gfsSource = (attachmentId: string, toolCallId: string) => ({
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: 'a'.repeat(32),
    gfsUri: `gfs://main/${'a'.repeat(32)}`,
    version: 7,
    name: 'image.png',
    attachmentId,
    toolCallId,
  })
  it.each([
    ['a tool source', 'empty attachmentId', { kind: 'tool', attachmentId: '', toolCallId: 'tc-1' }],
    ['a GFS source', 'empty attachmentId', gfsSource(' ', 'gfs-read-call')],
    ['a GFS source', 'empty toolCallId', gfsSource('gfs-read-attachment', '')],
    ['an unknown source kind', 'unknown source kind', { kind: 'upload', attachmentId: 'att-1' }],
  ])(
    'T-G4b-6b refuses %s with %s as image_source_invalid before authorize',
    async (_label, detail, source) => {
      const wired = deps()
      const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
      const part = { type: 'image', mimeType: 'image/png', data: GROK_PNG_2X2_BASE64, source }

      const rejected = await provider
        .completeSingleTurn(userWithImages([part as ImagePart]))
        .catch((e: unknown) => e)

      expect(rejected).toMatchObject({
        code: 'image_source_invalid',
        message: `image part has no usable provenance source (${detail}); host producers must attach the attachment or tool call it came from`,
      })
      expect(wired.authorizer.authorize).not.toHaveBeenCalled()
      expect(wired.proxy.stream).not.toHaveBeenCalled()

      // Liveness witness: the same provider authorizes a well-sourced image.
      await provider.completeSingleTurn(
        userWithImages([attachmentImage(GROK_PNG_2X2_BASE64, 'att-1')])
      )
      expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    }
  )

  const MIB = 1024 * 1024
  const GROK_ATTACHMENT_REFUSALS: Array<{
    name: string
    messages: () => ChatMessage[]
    userMessage: string
  }> = [
    {
      name: 'one image over maxImageBytes decoded',
      messages: () =>
        userWithImages([
          attachmentImage(grokPngOfDecodedBytesBase64(GROK_VISUAL_LIMITS.maxImageBytes + 1), 'a'),
        ]),
      userMessage: `An attached image is too large: it exceeds ${GROK_VISUAL_LIMITS.maxImageBytes / MIB} MiB. Reduce its size and send it again.`,
    },
    {
      name: 'images over maxTotalImageBytes together',
      messages: () => {
        const half = grokPngOfDecodedBytesBase64(GROK_VISUAL_LIMITS.maxTotalImageBytes / 2 + 1)
        return userWithImages([attachmentImage(half, 'a'), attachmentImage(half, 'b')])
      },
      userMessage: `The attached images are too large together: they exceed ${GROK_VISUAL_LIMITS.maxTotalImageBytes / MIB} MiB in total. Send fewer or smaller images.`,
    },
    {
      name: 'an image whose encoded bytes alone cross maxVisualRequestBodyBytes',
      // The whole-body ceiling is checked before any part is parsed. With the
      // Grok limits, images within 20 MiB plus text within 8 MiB stay under
      // 35 MiB, so only an image past the per-image limit reaches this check.
      messages: () =>
        userWithImages([
          attachmentImage(
            grokPngOfDecodedBytesBase64((LIMITS.maxVisualRequestBodyBytes / 4) * 3 + 3),
            'a'
          ),
        ]),
      userMessage: `The message and its attached images are too large together: they exceed ${LIMITS.maxVisualRequestBodyBytes / MIB} MiB. Send fewer or smaller images.`,
    },
  ]

  it.each(GROK_ATTACHMENT_REFUSALS)(
    'T-G4b-7 refuses $name as attachment_too_large before authorize',
    async ({ messages, userMessage }) => {
      const wired = deps()
      const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

      const rejected = await provider.completeSingleTurn(messages()).catch((e: unknown) => e)

      // The limit-specific sentence is the positive witness that the contract
      // refused this image budget, not an earlier, unrelated guard.
      expect(rejected).toBeInstanceOf(CodexAuthorizeError)
      expect(rejected).toMatchObject({ code: 'attachment_too_large', message: userMessage })
      expect(wired.authorizer.authorize).not.toHaveBeenCalled()
      expect(wired.proxy.stream).not.toHaveBeenCalled()

      const classified = provider.classifyError(rejected)
      expect(classified).toEqual({
        code: LlmErrorCode.InvalidAttachment,
        retryable: false,
        message: userMessage,
        providerCode: 'attachment_too_large',
        providerDispatched: false,
      })
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()

      // Liveness witness: the same provider authorizes and streams a small turn.
      await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
      expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
      expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    }
  )

  it('T-G4b-8 keeps conversation-volume refusals on a V2 request as context length', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    // A small image plus text over the non-image cap.
    const textOverCap = await provider
      .completeSingleTurn(
        userWithImages(
          [attachmentImage(GROK_PNG_2X2_BASE64, 'a')],
          'x'.repeat(LIMITS.maxRequestBodyBytes)
        )
      )
      .catch((e: unknown) => e)
    expect(textOverCap).toMatchObject({
      code: 'request_limit_exceeded',
      message: 'request exceeds maxRequestBodyBytes outside image data',
    })
    expect(provider.classifyError(textOverCap).code).toBe(LlmErrorCode.ContextLengthExceeded)

    // A V2 request with no image at all over the whole-body ceiling: the text
    // is what is too large, so it must not be blamed on an attachment. The
    // contract checks the non-image share before the whole body, so this is
    // reported as text too.
    const text = 'x'.repeat(LIMITS.maxVisualRequestBodyBytes)
    const wholeBody = await provider
      .completeSingleTurn([{ role: 'user', content: text, contentParts: [{ type: 'text', text }] }])
      .catch((e: unknown) => e)
    expect(wholeBody).toMatchObject({
      code: 'request_limit_exceeded',
      message: 'request exceeds maxRequestBodyBytes outside image data',
    })
    expect(provider.classifyError(wholeBody).code).toBe(LlmErrorCode.ContextLengthExceeded)
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()

    // Liveness witness: the same provider authorizes and streams a small turn.
    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
  })

  // #806 review M6, user decision: keep Codex parity. More than maxImages
  // images is `invalid_request`, not an attachment refusal, exactly as Codex
  // classifies it (codexSubscription.ts, "the maxImages count refusal stays
  // invalid_request").
  it('T-G4b-9 refuses more than maxImages images as invalid_request, classified as Codex does', async () => {
    const wired = deps()
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const images = Array.from({ length: GROK_VISUAL_LIMITS.maxImages + 1 }, (_, index) =>
      attachmentImage(GROK_PNG_2X2_BASE64, `att-${index}`)
    )

    const rejected = await provider
      .completeSingleTurn(userWithImages(images))
      .catch((e: unknown) => e)

    // The contract's own sentence is the witness that the canonical-hash path
    // refused the batch, not an earlier guard.
    expect(rejected).toBeInstanceOf(CodexAuthorizeError)
    expect(rejected).toMatchObject({
      code: 'invalid_request',
      message: `request exceeds ${GROK_VISUAL_LIMITS.maxImages} images`,
    })
    expect(wired.authorizer.authorize).not.toHaveBeenCalled()
    expect(wired.proxy.stream).not.toHaveBeenCalled()
    const classified = provider.classifyError(rejected)
    expect(classified).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      providerCode: 'invalid_request',
      providerDispatched: false,
    })
    expect(classified).toEqual(
      new CodexSubscriptionProvider('gpt-5.3-codex', {} as never).classifyError(rejected)
    )

    // Liveness witness: maxImages images are authorized and streamed.
    await provider.completeSingleTurn(userWithImages(images.slice(1)))
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })
})
describe('GrokSubscriptionProvider Retry-After retry (G1-9, #720)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const ok = { text: 'after the wait', toolCalls: [], outcome: 'success' }
  const limited = (retryAfterMs?: number) =>
    new GrokProxyError('rate_limited', 'proxy stream failed with 429 (rate_limited)', {
      retryAfterMs,
    })
  const authorizeTwice = () =>
    vi
      .fn()
      .mockResolvedValueOnce({
        providerAttemptId: 'attempt-1',
        requestHash,
        executionTicket: 'ticket-first',
        expiresAt: '2026-08-20T10:00:00.000Z',
      })
      .mockResolvedValueOnce({
        providerAttemptId: 'attempt-2',
        requestHash,
        executionTicket: 'ticket-second',
        expiresAt: '2026-08-20T10:00:00.000Z',
      })

  it('G1-9a: waits the advised delay, re-authorizes with the next index and dispatches again', async () => {
    vi.useFakeTimers()
    const stream = vi.fn().mockRejectedValueOnce(limited(2000)).mockResolvedValueOnce(ok)
    const wired = deps({ authorize: authorizeTwice(), stream })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    await vi.advanceTimersByTimeAsync(1999)
    // The advised delay is honoured: nothing is re-sent before it elapses.
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await turn

    expect(result.content).toBe('after the wait')
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(2)
    const [first, second] = wired.authorizer.authorize.mock.calls.map(call => call[0])
    expect(second.invocationId).toBe(first.invocationId)
    expect(second.requestHash).toBe(first.requestHash)
    expect(first.providerAttemptIndex).toBe(1)
    expect(second.providerAttemptIndex).toBe(2)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(2)
    expect(wired.proxy.stream.mock.calls[1][0].executionTicket).toBe('ticket-second')
  })

  it('G1-9a: retries at exactly the 30 s cap', async () => {
    vi.useFakeTimers()
    const stream = vi.fn().mockRejectedValueOnce(limited(30_000)).mockResolvedValueOnce(ok)
    const wired = deps({ authorize: authorizeTwice(), stream })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(turn).resolves.toMatchObject({ content: 'after the wait' })
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['G1-9b: without Retry-After', undefined],
    ['G1-9c: over the 30 s cap', 31_000],
    // The Host parser never yields these; a non-positive value built directly
    // into the error is treated as absent (@claude review, PR #821).
    ['G1-9j: a zero Retry-After', 0],
    ['G1-9j: a negative Retry-After', -1000],
  ])('%s the 429 is thrown with no retry', async (_label, retryAfterMs) => {
    vi.useFakeTimers()
    const err = limited(retryAfterMs)
    const wired = deps({ stream: vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(ok) })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const settled = expect(turn).rejects.toBe(err)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    // Witness: the first attempt ran; the negative is that no second one did.
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    expect(provider.classifyError(err).code).toBe(LlmErrorCode.RateLimited)
  })

  it('G1-9d: a second 429 is thrown as RateLimited with no third attempt', async () => {
    vi.useFakeTimers()
    const second = limited(1000)
    const stream = vi.fn().mockRejectedValueOnce(limited(1000)).mockRejectedValueOnce(second)
    const wired = deps({ authorize: authorizeTwice(), stream })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const settled = expect(turn).rejects.toBe(second)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(2)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(2)
    expect(provider.classifyError(second)).toMatchObject({
      code: LlmErrorCode.RateLimited,
      retryable: true,
    })
  })

  it('G1-9e: a caller-pinned attempt index is never retried here', async () => {
    vi.useFakeTimers()
    const err = limited(1000)
    const wired = deps({ stream: vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(ok) })
    wired.attemptContext = vi.fn(() => ({
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
      hostRef: 'chatllm',
      providerAttemptIndex: 3,
    }))
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const settled = expect(turn).rejects.toBe(err)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.authorizer.authorize.mock.calls[0][0].providerAttemptIndex).toBe(3)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('G1-9f: an abort during the wait rejects with the abort reason and sends nothing more', async () => {
    vi.useFakeTimers()
    const wired = deps({
      authorize: authorizeTwice(),
      stream: vi.fn().mockRejectedValueOnce(limited(5000)).mockResolvedValueOnce(ok),
    })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const controller = new AbortController()
    const reason = new Error('caller gave up')

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })
    const settled = expect(turn).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(1000)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    controller.abort(reason)
    await settled
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('G1-9g: control_plane_unavailable is never retried here', async () => {
    vi.useFakeTimers()
    // Carries a delay on purpose, so only the code keeps it from being retried.
    const err = new GrokProxyError('control_plane_unavailable', 'proxy could not be reached', {
      retryAfterMs: 1000,
    })
    const wired = deps({ stream: vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(ok) })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const settled = expect(turn).rejects.toBe(err)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })

  it('G1-9h: a retry whose stream fails with provider_unavailable surfaces that error (review round 2 M5)', async () => {
    vi.useFakeTimers()
    const outage = new GrokProxyError('provider_unavailable', 'proxy stream failed with 503')
    const stream = vi.fn().mockRejectedValueOnce(limited(1000)).mockRejectedValueOnce(outage)
    const wired = deps({ authorize: authorizeTwice(), stream })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const settled = expect(turn).rejects.toBe(outage)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    // Witness: the retry ran; the negative is that nothing ran after it.
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(2)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(2)
    expect(provider.classifyError(outage).code).toBe(LlmErrorCode.ModelOverloaded)
  })

  it('G1-9h: a retry whose authorize fails with control_plane_unavailable surfaces that error (review round 2 M5)', async () => {
    vi.useFakeTimers()
    const unreachable = new CodexAuthorizeError(
      'control_plane_unavailable',
      'authorize could not reach the control plane (ECONNREFUSED)'
    )
    const authorize = vi
      .fn()
      .mockResolvedValueOnce({
        providerAttemptId: 'attempt-1',
        requestHash,
        executionTicket: 'ticket-first',
        expiresAt: '2026-08-20T10:00:00.000Z',
      })
      .mockRejectedValueOnce(unreachable)
    const wired = deps({
      authorize,
      stream: vi.fn().mockRejectedValueOnce(limited(1000)).mockResolvedValueOnce(ok),
    })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const settled = expect(turn).rejects.toBe(unreachable)
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    // Witness: the second authorize ran; the negative is that it dispatched nothing.
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(2)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    expect(provider.classifyError(unreachable)).toMatchObject({
      code: LlmErrorCode.ControlPlaneUnavailable,
      providerDispatched: false,
    })
  })

  it('G1-9i: a successful retry passes the caller signal to the second stream (review round 2 L9)', async () => {
    vi.useFakeTimers()
    const stream = vi.fn().mockRejectedValueOnce(limited(1000)).mockResolvedValueOnce(ok)
    const wired = deps({ authorize: authorizeTwice(), stream })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)
    const controller = new AbortController()

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(turn).resolves.toMatchObject({ content: 'after the wait' })
    expect(controller.signal.aborted).toBe(false)
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(2)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(2)
    expect(wired.proxy.stream.mock.calls[1][0].signal).toBe(controller.signal)
  })

  // G1-11 (#720, review R1-B1): the 429 that control-api's own limiters answer
  // on authorize, in the shape they send it, takes the same single retry as a
  // proxy 429. The authorizer is the real one; only its fetch is faked.
  const controlApiLimiter429 = (seconds: number) =>
    Response.json(
      { error: 'Too Many Requests', retryAfterSeconds: seconds },
      { status: 429, headers: { 'retry-after': String(seconds) } }
    )
  const authorizedSecond = () =>
    Response.json({
      providerAttemptId: 'attempt-2',
      requestHash,
      executionTicket: 'ticket-second',
      expiresAt: '2026-08-20T10:00:00.000Z',
    })
  const realAuthorize = (fetchFn: ReturnType<typeof vi.fn>) => {
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl('http://gateway:8092'),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    return vi.fn((body, options) => authorizer.authorize(body, options))
  }

  it('G1-11a: a control-api limiter 429 on authorize is retried once after its Retry-After', async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(controlApiLimiter429(2))
      .mockResolvedValueOnce(authorizedSecond())
    const wired = deps({ authorize: realAuthorize(fetchFn), stream: vi.fn().mockResolvedValue(ok) })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    await vi.advanceTimersByTimeAsync(1999)
    // Witness: the first authorize ran; nothing was dispatched on its 429.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(turn).resolves.toMatchObject({ content: 'after the wait' })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [first, second] = fetchFn.mock.calls.map(call => JSON.parse(call[1].body as string))
    expect(second.invocationId).toBe(first.invocationId)
    expect([first.providerAttemptIndex, second.providerAttemptIndex]).toEqual([1, 2])
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream.mock.calls[0][0].executionTicket).toBe('ticket-second')
  })

  it('G1-11b: a control-api limiter 429 over the cap is thrown as RateLimited with no retry', async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(controlApiLimiter429(31))
      .mockResolvedValueOnce(authorizedSecond())
    const wired = deps({ authorize: realAuthorize(fetchFn) })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const caught = turn.then(
      () => undefined,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const err = await caught

    expect(err).toBeInstanceOf(CodexAuthorizeError)
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 31_000 })
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.RateLimited,
      retryable: true,
      providerDispatched: false,
    })
    // Witness: the first authorize ran; the negative is that no second one did.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(0)
  })

  it('G1-11e: a budget_denied 429 with a short Retry-After is not retried (review round 2 M6)', async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'budget_denied' }, { status: 429, headers: { 'retry-after': '1' } })
      )
      .mockResolvedValueOnce(authorizedSecond())
    const wired = deps({ authorize: realAuthorize(fetchFn) })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    const caught = turn.then(
      () => undefined,
      (e: unknown) => e
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const err = await caught

    // The delay is within the cap, so only the code keeps it from being retried.
    expect(err).toBeInstanceOf(CodexAuthorizeError)
    expect(err).toMatchObject({ code: 'budget_denied', retryAfterMs: 1000 })
    // Witness: the first authorize ran; the negative is that no second one did.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(0)
  })

  it('G1-12: an abort after the wait resolves and before the second authorize sends nothing more', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    let abortInGap = false
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(
      (type, listener, opts) => {
        remove(type, listener, opts)
        // The wait drops its abort listener once its timer fired: abort right
        // then, in the gap no listener watches.
        if (abortInGap) {
          abortInGap = false
          controller.abort(reason)
        }
      }
    )
    const stream = vi
      .fn()
      .mockImplementationOnce(async () => {
        abortInGap = true
        throw limited(1000)
      })
      .mockResolvedValueOnce(ok)
    const wired = deps({ authorize: authorizeTwice(), stream })
    const provider = new GrokSubscriptionProvider('grok-4.6', wired as never)

    const turn = provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })
    const settled = expect(turn).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(1000)
    await settled
    // Witness: the abort did land in the gap, after the first attempt ran.
    expect(controller.signal.aborted).toBe(true)
    expect(abortInGap).toBe(false)
    expect(wired.authorizer.authorize).toHaveBeenCalledTimes(1)
    expect(wired.proxy.stream).toHaveBeenCalledTimes(1)
  })
})
