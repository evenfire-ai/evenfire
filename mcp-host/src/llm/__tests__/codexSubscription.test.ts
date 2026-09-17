import { describe, expect, it, vi } from 'vitest'
import {
  hashCodexCompletionRequest,
  parseCodexCompletionRequest,
} from '@clerum/llm-provider-attempt-contract'
import {
  buildToolDescribeResponse,
  buildToolSearchResponse,
  createToolCallTool,
  createToolDescribeTool,
  createToolSearchTool,
} from '../../capabilities/toolCatalogTools'
import { LlmErrorCode } from '../../core/errors'
import { DeferrableToolController } from '../../core/orchestration/deferrableToolController'
import { DefaultLoopController } from '../../core/orchestration/loopConfig'
import type { ChatMessage } from '../../core/types'
import { CodexProxyError } from '../codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { classifyFailoverClass } from '../failover/classify'
import { CodexAuthorizeError } from '../providerAttemptAuthorizer'
import { makeProvider } from '../registry'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from './codexImageFixtures'

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
      const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
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
        toolCalls: Array.from({ length: 33 }, (_, index) => ({
          id: `call-${index}`,
          name: 'echo',
          arguments: {},
        })),
      }),
    })
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await expect(
      provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'echo', description: 'echo', parameters: {} }]
      )
    ).rejects.toThrow(/tool calls exceed 32/)
  })
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

  it.each([1, 33, 83, 150, 250])(
    'preserves all %i approved MCP definitions through authorization and dispatch',
    async count => {
      const wired = deps()
      const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)
      const tools = [
        ...Array.from({ length: 36 }, (_, i) => ({
          name: `native_${i}`,
          description: 'native',
          parameters: { type: 'object' },
        })),
        ...Array.from({ length: count }, (_, i) => ({
          name: `eventasks__read_${i}`,
          description: 'read task',
          parameters: { type: 'object', properties: { key: { type: 'string' } } },
        })),
        { name: 'clerum__tool_search', description: 'search', parameters: { type: 'object' } },
      ]
      await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Find a task' }], tools)
      const authorized = wired.authorize.mock.calls[0][0]
      expect(authorized.request.tools).toEqual(tools)
      expect(wired.stream.mock.calls[0][0].request).toEqual(authorized.request)
      expect(authorized.request.tools.at(-2).name).toBe(`eventasks__read_${count - 1}`)
    }
  )

  it('can advertise a single MCP tool without native tools', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)
    const tools = [
      { name: 'eventasks__workitem_get', description: 'read', parameters: { type: 'object' } },
    ]
    await provider.completeSingleTurnWithTools([{ role: 'user', content: 'Read' }], tools)
    expect(wired.authorize.mock.calls[0][0].request.tools).toEqual(tools)
  })

  it('keeps the same advertised schemas for 83, 150 and 250 tools and describes only the selected target', async () => {
    let baseline: string | undefined
    for (const count of [83, 150, 250]) {
      const catalog = Array.from({ length: count }, (_, i) => ({
        name: `eventasks__read_${i}`,
        serverName: 'eventasks',
        description: `Read record ${i}`,
        inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      }))
      const nativeTools = [
        createToolSearchTool(() => catalog),
        createToolDescribeTool(() => catalog),
        createToolCallTool(),
      ].map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
      const controller = new DeferrableToolController(
        new DefaultLoopController(),
        new Set(nativeTools.map(t => t.name)),
        { dynamicToolsEnabled: true, dynamicToolsThreshold: 60, codexMode: 'auto' },
        {
          get: () => false,
          set: () => {
            throw new Error('Codex must not use a stale legacy latch')
          },
        }
      )
      const all = [
        ...nativeTools,
        ...catalog.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      ]
      const presented = await controller.refreshTools(all)
      const wired = deps()
      const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)
      await provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'Find a record' }],
        presented
      )
      const first = wired.authorize.mock.calls[0][0].request
      const serialized = JSON.stringify(first.tools)
      baseline ??= serialized
      expect(serialized).toBe(baseline)
      expect(first.tools.map((t: { name: string }) => t.name)).toEqual(nativeTools.map(t => t.name))
      const chosen = catalog[count - 1]
      const search = buildToolSearchResponse(catalog, chosen.name, { limit: 1 })
      expect(search.results[0].name).toBe(chosen.name)
      expect(JSON.stringify(search)).not.toContain('parameters')
      const described = buildToolDescribeResponse(catalog, chosen.name)
      expect(described.found).toBe(true)
      await provider.completeSingleTurnWithTools(
        [
          { role: 'user', content: 'Find a record' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'describe-1', name: 'clerum__tool_describe', arguments: { name: chosen.name } },
            ],
          },
          {
            role: 'tool',
            name: 'clerum__tool_describe',
            tool_call_id: 'describe-1',
            content: JSON.stringify(described),
          },
        ],
        await controller.refreshTools(all)
      )
      const second = wired.authorize.mock.calls[1][0].request
      expect(JSON.stringify(second.tools)).toBe(baseline)
      expect(second.messages[2].toolCallId).toBe('describe-1')
      expect(second.messages[2].content).toBe(JSON.stringify(described))
      expect(wired.stream.mock.calls[1][0].request).toEqual(second)
    }
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

  // ─── #650: image input projection ─────────────────────────────────────────

  const METHODS = ['completeSingleTurn', 'completeSingleTurnWithTools'] as const
  type Method = (typeof METHODS)[number]

  function invoke(
    provider: CodexSubscriptionProvider,
    method: Method,
    messages: ChatMessage[]
  ): Promise<unknown> {
    const tools = [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }]
    return method === 'completeSingleTurn'
      ? provider.completeSingleTurn(messages)
      : provider.completeSingleTurnWithTools(messages, tools)
  }

  function userWithImage(
    data = PNG_2X2_BASE64,
    mimeType: 'image/png' | 'image/jpeg' = 'image/png'
  ): ChatMessage[] {
    return [
      {
        role: 'user',
        content: 'what is on screen?',
        contentParts: [
          { type: 'text', text: 'what is on screen?' },
          {
            type: 'image',
            mimeType,
            data,
            source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' },
          },
        ],
      },
    ]
  }

  it.each(METHODS)('sends a real PNG as a V2 part through %s', async method => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
      ...wired,
      imageInputEnabled: true,
    } as never)

    await invoke(provider, method, userWithImage())

    const authorized = wired.authorize.mock.calls[0][0]
    expect(authorized.request.schemaVersion).toBe('codex-completion-request.v2')
    expect(authorized.request.messages[0]).toEqual({
      role: 'user',
      content: 'what is on screen?',
      contentParts: [
        { type: 'text', text: 'what is on screen?' },
        {
          type: 'image',
          mimeType: 'image/png',
          data: PNG_2X2_BASE64,
          source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'msg-1' },
        },
      ],
    })
    // The authorized hash and the dispatched request are the same canonical
    // projection the proxy and control-api re-derive from these bytes.
    const parsed = parseCodexCompletionRequest(authorized.request)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(authorized.requestHash).toBe(hashCodexCompletionRequest(parsed.value))
    }
    expect(wired.stream.mock.calls[0][0].request).toEqual(authorized.request)
  })

  it('accepts a JPEG part when image input is enabled', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
      ...wired,
      imageInputEnabled: true,
    } as never)

    await provider.completeSingleTurn(userWithImage(JPEG_2X2_BASE64, 'image/jpeg'))

    const parts = wired.authorize.mock.calls[0][0].request.messages[0].contentParts
    expect(parts[1]).toEqual(
      expect.objectContaining({ mimeType: 'image/jpeg', data: JPEG_2X2_BASE64 })
    )
  })

  it.each(METHODS)(
    'refuses to authorize an image through %s while image input is dark',
    async method => {
      const wired = deps()
      // `imageInputEnabled` is absent: the documented default is false.
      const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)

      await expect(invoke(provider, method, userWithImage())).rejects.toMatchObject({
        name: 'CodexAuthorizeError',
        code: 'image_input_unsupported',
      })
      expect(wired.authorize).not.toHaveBeenCalled()
      expect(wired.stream).not.toHaveBeenCalled()
    }
  )

  it('classifies an unsupported visual request as terminal with no fallback', () => {
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', deps() as never)
    const classified = provider.classifyError(
      new CodexAuthorizeError('image_input_unsupported', 'image input is not enabled')
    )
    expect(classified.code).toBe(LlmErrorCode.ApiCallFailed)
    expect(classified.retryable).toBe(false)
    expect(classified.providerDispatched).toBe(false)
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
  })

  it.each(METHODS)('rejects an image part without provenance through %s', async method => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
      ...wired,
      imageInputEnabled: true,
    } as never)
    const messages = userWithImage()
    messages[0].contentParts = [
      { type: 'text', text: 'what is on screen?' },
      { type: 'image', mimeType: 'image/png', data: PNG_2X2_BASE64 },
    ]

    await expect(invoke(provider, method, messages)).rejects.toMatchObject({
      name: 'CodexAuthorizeError',
      code: 'image_source_invalid',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()
  })

  it('rejects parts on a non-user message instead of dropping them', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
      ...wired,
      imageInputEnabled: true,
    } as never)

    await expect(
      provider.completeSingleTurn([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'look',
          contentParts: [{ type: 'text', text: 'look' }],
        },
      ])
    ).rejects.toMatchObject({ name: 'CodexAuthorizeError', code: 'invalid_request' })
    expect(wired.authorize).not.toHaveBeenCalled()
  })

  it('keeps a redacted text-only message on V2 without requiring image input', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)
    const messages = userWithImage()
    // What pre-prune leaves behind: the image became a text part and `content`
    // is restated from the parts.
    messages[0].contentParts = [
      { type: 'text', text: 'what is on screen?' },
      { type: 'text', text: '[image redacted — see turn 1]' },
    ]
    messages[0].content = 'what is on screen?\n[image redacted — see turn 1]'

    await provider.completeSingleTurn(messages)

    const authorized = wired.authorize.mock.calls[0][0]
    expect(authorized.request.schemaVersion).toBe('codex-completion-request.v2')
    expect(authorized.request.messages[0].content).toBe(messages[0].content)
    expect(parseCodexCompletionRequest(authorized.request).ok).toBe(true)
  })

  it('restates content from the parts when the caller left them out of sync', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
      ...wired,
      imageInputEnabled: true,
    } as never)
    const messages = userWithImage()
    // A stale `content` must never reach the wire as a contradiction of its own
    // parts: V2 rejects the request outright, so the projection rebuilds it.
    messages[0].content = 'stale text that no part carries'

    await provider.completeSingleTurn(messages)

    expect(wired.authorize.mock.calls[0][0].request.messages[0].content).toBe('what is on screen?')
  })

  it.each(METHODS)(
    'rejects a signature-only image stub through %s before authorize',
    async method => {
      const wired = deps()
      const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
        ...wired,
        imageInputEnabled: true,
      } as never)

      await expect(
        invoke(provider, method, userWithImage('iVBORw0KGgo=', 'image/png'))
      ).rejects.toMatchObject({ name: 'CodexAuthorizeError', code: 'invalid_request' })
      expect(wired.authorize).not.toHaveBeenCalled()
      expect(wired.stream).not.toHaveBeenCalled()
    }
  )

  it('rejects an over-limit image batch through the shared contract, not a local copy', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
      ...wired,
      imageInputEnabled: true,
    } as never)
    const messages = userWithImage()
    messages[0].contentParts = [
      { type: 'text', text: 'what is on screen?' },
      ...Array.from({ length: 4 }, (_, index) => ({
        type: 'image' as const,
        mimeType: 'image/png' as const,
        data: PNG_2X2_BASE64,
        source: {
          kind: 'attachment' as const,
          attachmentId: `att-${index}`,
          messageId: 'msg-1',
        },
      })),
    ]

    await expect(provider.completeSingleTurn(messages)).rejects.toMatchObject({
      name: 'CodexAuthorizeError',
      code: 'invalid_request',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
  })

  it('keeps a text-only turn on the unchanged V1 request', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.6-luna', wired as never)

    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])

    const request = wired.authorize.mock.calls[0][0].request
    expect(request.schemaVersion).toBe('codex-completion-request.v1')
    expect(request.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(JSON.stringify(request)).not.toContain('contentParts')
  })
})
