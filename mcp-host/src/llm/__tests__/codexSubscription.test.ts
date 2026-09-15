import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import { CodexProxyError } from '../codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { classifyFailoverClass } from '../failover/classify'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'
import { makeProvider } from '../registry'

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
      text: 'hello from proxy',
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
    authorize,
    stream,
  }
}

describe('CodexSubscriptionProvider', () => {
  it('requires an explicit model plus authorizer and proxy dependencies', () => {
    process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED = 'true'
    expect(() => makeProvider('codex-subscription', {})).toThrow(/explicit model and runtime/)
    expect(() => makeProvider('codex-subscription', {}, 'gpt-5.3-codex')).toThrow(
      /explicit model and runtime/
    )
    const wired = deps()
    const provider = makeProvider('codex-subscription', {}, 'gpt-5.3-codex', {
      codex: wired as never,
    })
    expect(provider.getProviderType()).toBe('codex-subscription')
    delete process.env.MCP_HOST_CODEX_SUBSCRIPTION_ENABLED
  })

  it('authorizes through the gateway and streams to the proxy without executing tools', async () => {
    const wired = deps({
      stream: vi.fn().mockResolvedValue({
        text: 'use a tool',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { x: 1 } }],
        outcome: 'success',
      }),
    })
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    const authorizedBody = wired.authorize.mock.calls[0][0]
    expect(authorizedBody.request.model).toBe('gpt-5.3-codex')
    expect(authorizedBody.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(wired.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTicket: 'ticket-123456',
        requestHash,
      })
    )
    expect(result.tool_calls).toEqual([{ id: 'c1', name: 'echo', arguments: { x: 1 } }])
  })

  it('preserves assistant toolCalls and tool results in the authorize request', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
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
    const authorizedBody = wired.authorize.mock.calls[0][0]
    expect(authorizedBody.request.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call-1', name: 'echo' },
    ])
  })

  it('does not call the proxy when aborted before authorize', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await expect(
      provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ code: 'canceled' })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()
  })

  it('issues a new authorize attempt index on every physical call', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await provider.completeSingleTurn([{ role: 'user', content: 'one' }])
    await provider.completeSingleTurn([{ role: 'user', content: 'two' }])
    expect(wired.authorize.mock.calls[0][0].providerAttemptIndex).toBe(1)
    expect(wired.authorize.mock.calls[1][0].providerAttemptIndex).toBe(2)
    expect(wired.authorize.mock.calls[0][0].request.requestId).not.toBe(
      wired.authorize.mock.calls[1][0].request.requestId
    )
  })

  it('passes the selected model into attemptContext', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)
    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.attemptContext).toHaveBeenCalledWith({ model: 'gpt-5.6-luna' })
  })

  it('refuses to authorize without a catalog policy binding', async () => {
    const wired = deps()
    wired.attemptContext = vi.fn().mockReturnValue({ policyRevision: 0, policyHash: '' })
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)
    await expect(
      provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({
      name: 'CodexAuthorizeError',
      code: 'no_grant',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()
  })

  it('keeps unknown usage unknown when the proxy omits token counts', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    const result = await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(result.usage_reported).toBe(false)
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    expect(result.providerAttemptId).toBe('attempt-1')
    expect(result.providerAttemptIndex).toBe(1)
  })

  it('advertises approved MCP tools instead of dropping them', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [
        { name: 'file_read', description: 'read', parameters: {} },
        {
          name: 'mongodb-mcp-stack-mongodb-mcp-server__find',
          description: 'find',
          parameters: {},
        },
      ]
    )
    const authorizedBody = wired.authorize.mock.calls[0][0]
    // The defect this replaces: the MCP tool never reached the wire, so an
    // agent that had successfully connected to the service could not use it.
    expect(authorizedBody.request.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'file_read',
      'mongodb-mcp-stack-mongodb-mcp-server__find',
    ])
  })

  it('advertises a lone MCP tool when no native tool is offered', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'connector__lookup', description: 'lookup', parameters: {} }]
    )
    const authorizedBody = wired.authorize.mock.calls[0][0]
    // Previously this produced zero definitions, so the request carried no
    // tools at all and the model had nothing to select.
    expect(authorizedBody.request.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'connector__lookup',
    ])
  })

  it('defers an oversized MCP catalog to the bridge and keeps every native', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', {
      ...wired,
      maxToolDefinitions: 8,
    } as never)
    await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [
        ...Array.from({ length: 4 }, (_, i) => ({
          name: `native_${i}`,
          description: 'n',
          parameters: {},
        })),
        ...Array.from({ length: 90 }, (_, i) => ({
          name: `connector__tool_${i}`,
          description: 'm',
          parameters: {},
        })),
        { name: 'clerum__tool_search', description: 'search', parameters: {} },
        { name: 'clerum__tool_describe', description: 'describe', parameters: {} },
        { name: 'clerum__tool_call', description: 'call', parameters: {} },
      ]
    )
    const authorizedBody = wired.authorize.mock.calls[0][0]
    const names = authorizedBody.request.tools.map((tool: { name: string }) => tool.name)
    // The bridge leads, so the tools that make the deferred catalog reachable
    // can never be the ones capacity removes.
    expect(names.slice(0, 3)).toEqual([
      'clerum__tool_search',
      'clerum__tool_describe',
      'clerum__tool_call',
    ])
    expect(names).toContain('native_3')
    expect(names.some((name: string) => name.startsWith('connector__'))).toBe(false)
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('does not treat an unknown empty stream as a successful stop', async () => {
    const wired = deps({
      stream: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [],
        outcome: 'unknown',
      }),
    })
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await expect(
      provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('keeps insufficient_scope distinguishable', () => {
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', deps() as never)
    const classified = provider.classifyError(
      new CodexAuthorizeError('insufficient_scope', 'missing scope')
    )
    expect(classified.code).toBe(LlmErrorCode.AuthenticationFailed)
    expect(classified.providerCode).toBe('insufficient_scope')
    expect(classified.retryable).toBe(false)
  })

  it('does not treat a revoked grant as a retryable provider outage', () => {
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', deps() as never)
    const revoked = provider.classifyError(new CodexAuthorizeError('no_grant', 'revoked'))
    expect(revoked.code).toBe(LlmErrorCode.AuthenticationFailed)
    expect(revoked.retryable).toBe(false)
    expect(classifyFailoverClass(revoked.code, revoked.retryable)).toBe('auth')

    const transient = provider.classifyError(
      new CodexAuthorizeError('connection_unavailable', 'catalog unavailable')
    )
    expect(transient.code).toBe(LlmErrorCode.ModelOverloaded)
    expect(transient.retryable).toBe(true)
    expect(classifyFailoverClass(transient.code, transient.retryable)).toBe('provider_unavailable')
  })

  it('maps transient proxy failures onto failover-eligible classes', () => {
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', deps() as never)
    const unavailable = provider.classifyError(
      new CodexProxyError('provider_unavailable', 'upstream 5xx')
    )
    expect(unavailable.code).toBe(LlmErrorCode.ModelOverloaded)
    expect(unavailable.retryable).toBe(true)
    expect(classifyFailoverClass(unavailable.code, unavailable.retryable)).toBe(
      'provider_unavailable'
    )

    const limited = provider.classifyError(new CodexProxyError('rate_limited', 'upstream 429'))
    expect(limited.code).toBe(LlmErrorCode.RateLimited)
    expect(limited.retryable).toBe(true)
    expect(classifyFailoverClass(limited.code, limited.retryable)).toBe('rate_limited')
  })

  it('records whether a classified Codex failure had already left the process', () => {
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', deps() as never)

    // Every CodexAuthorizeError throw site precedes `proxy.stream`.
    expect(
      provider.classifyError(new CodexAuthorizeError('no_grant', 'revoked')).providerDispatched
    ).toBe(false)
    expect(
      provider.classifyError(new CodexAuthorizeError('budget_denied', 'over budget'))
        .providerDispatched
    ).toBe(false)
    expect(
      provider.classifyError(new CodexAuthorizeError('insufficient_scope', 'scope'))
        .providerDispatched
    ).toBe(false)

    // The two pre-stream aborts are the only proxy errors that prove it.
    expect(
      provider.classifyError(new CodexProxyError('canceled', 'aborted before authorize', false))
        .providerDispatched
    ).toBe(false)

    // Anything else on the proxy happened after the request was issued.
    expect(
      provider.classifyError(new CodexProxyError('provider_unavailable', 'upstream 5xx'))
        .providerDispatched
    ).toBe(true)
    expect(
      provider.classifyError(new CodexProxyError('rate_limited', 'upstream 429')).providerDispatched
    ).toBe(true)

    // An unrecognized error is not evidence that no call was made.
    expect(provider.classifyError(new Error('who knows')).providerDispatched).toBeUndefined()
  })

  it('shares the caller deadline with the authorize hop', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    const controller = new AbortController()

    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })
    expect(wired.authorize).toHaveBeenCalledWith(expect.any(Object), {
      signal: controller.signal,
    })

    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.authorize).toHaveBeenNthCalledWith(2, expect.any(Object), {})
  })
})
