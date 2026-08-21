import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import {
  CodexSubscriptionProvider,
  isCodexNativeToolName,
  selectCodexAdvertisedTools,
} from '../codexSubscription'
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
  })

  it('omits MCP tools and caps natives at the Codex maxTools limit', () => {
    const tools = [
      { name: 'file_read', description: 'read', parameters: {} },
      {
        name: 'mongodb-mcp-stack-mongodb-mcp-server__find',
        description: 'find',
        parameters: {},
      },
      { name: 'clerum__gfs_read', description: 'gfs', parameters: {} },
      {
        name: 'mongodb-mcp-stack-mongodb-mcp-server__aggregate',
        description: 'agg',
        parameters: {},
      },
    ]
    expect(isCodexNativeToolName('file_read')).toBe(true)
    expect(isCodexNativeToolName('clerum__gfs_read')).toBe(true)
    expect(isCodexNativeToolName('mongodb-mcp-stack-mongodb-mcp-server__find')).toBe(false)
    expect(selectCodexAdvertisedTools(tools).map(tool => tool.name)).toEqual([
      'file_read',
      'clerum__gfs_read',
    ])

    const overflow = Array.from({ length: 40 }, (_, i) => ({
      name: i < 36 ? `native_${i}` : `mongo-server__tool_${i}`,
      description: 't',
      parameters: {},
    }))
    const advertised = selectCodexAdvertisedTools(overflow)
    expect(advertised).toHaveLength(32)
    expect(advertised.every(tool => isCodexNativeToolName(tool.name))).toBe(true)
    expect(advertised[0]?.name).toBe('native_0')
    expect(advertised[31]?.name).toBe('native_31')
  })

  it('authorizes with native tools only when MCP tools are also offered', async () => {
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
        { name: 'clerum__tool_search', description: 'search', parameters: {} },
      ]
    )
    const authorizedBody = wired.authorize.mock.calls[0][0]
    expect(authorizedBody.request.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'file_read',
      'clerum__tool_search',
    ])
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
})
