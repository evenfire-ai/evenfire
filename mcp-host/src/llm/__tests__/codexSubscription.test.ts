import { describe, expect, it, vi } from 'vitest'
import { minifiedMcpResult } from '../../__tests__/fixtures/minifiedMcpResult'
import {
  buildToolDescribeResponse,
  buildToolSearchResponse,
  createToolCallTool,
  createToolDescribeTool,
  createToolSearchTool,
} from '../../capabilities/toolCatalogTools'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../../core/errors'
import { DeferrableToolController } from '../../core/orchestration/deferrableToolController'
import { DefaultLoopController } from '../../core/orchestration/loopConfig'
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
  function successfulBatch(count: number) {
    return deps({
      stream: vi.fn().mockResolvedValue({
        text: '',
        outcome: 'success',
        toolCalls: Array.from({ length: count }, (_, index) => ({
          id: `call-${index}`,
          name: 'echo',
          arguments: {},
        })),
      }),
    })
  }

  it('returns a successful proxy batch of exactly 256 tool calls', async () => {
    const wired = successfulBatch(256)
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    const result = await provider.completeSingleTurnWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'echo', description: 'echo', parameters: {} }]
    )
    expect(result.tool_calls).toHaveLength(256)
  })

  it('rejects a 257-call proxy batch with tool_call_limit_exceeded before returning any executable tools', async () => {
    const wired = successfulBatch(257)
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    await expect(
      provider.completeSingleTurnWithTools(
        [{ role: 'user', content: 'hi' }],
        [{ name: 'echo', description: 'echo', parameters: {} }]
      )
    ).rejects.toMatchObject({
      name: 'CodexProxyError',
      code: 'tool_call_limit_exceeded',
      message: 'tool calls exceed 256',
    })
    // Liveness witness: the batch really came back from the proxy.
    expect(wired.stream).toHaveBeenCalledTimes(1)
  })

  it('surfaces a 257-call stream through the port adapter as a non-retryable LlmError', async () => {
    const wired = successfulBatch(257)
    const adapter = new LlmPortAdapter(
      new CodexSubscriptionProvider('gpt-5.3-codex', wired as never),
      'gpt-5.3-codex',
      'codex-subscription'
    )
    const failure = await adapter
      .completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'echo', description: 'echo', parameters: {} }],
      })
      .catch((err: unknown) => err)

    expect(wired.stream).toHaveBeenCalledTimes(1)
    expect(failure).toBeInstanceOf(LlmError)
    expect(failure).toMatchObject({
      code: 'LLM_TOOL_CALL_LIMIT_EXCEEDED',
      retryable: false,
      providerCode: 'tool_call_limit_exceeded',
    })
  })

  it('rejects more than 1024 messages before authorize or dispatch', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    const history = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        role: 'user' as const,
        content: `message ${index}`,
      }))

    const rejected = provider.completeSingleTurn(history(1025))
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'messages exceed 1024',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()

    // Liveness witness: at the limit the same provider authorizes and streams.
    await provider.completeSingleTurn(history(1024))
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    expect(wired.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C reports an over-sized request as request_limit_exceeded before authorize (#731)', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    // A single tool result over the byte cap. The message count is 4, far below
    // `maxMessages`, so the refusal can only come from the canonical-hash path
    // at `codexSubscription.ts:337-350` - the one that measures real bytes.
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
        content: minifiedMcpResult(3, 1_048_576),
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
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })

    // Liveness witness: the same provider authorizes and streams a small turn,
    // so the rejection above is a property of the payload, not of the wiring.
    await provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    expect(wired.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C2 reports a 257-call assistant message as request_limit_exceeded before authorize (#731)', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    // The `messages[i].toolCalls` bound has no guard ahead of it in this file -
    // unlike the message count, which `execute` refuses itself. It can only be
    // reached through the canonical hash, which makes it the one size refusal
    // whose classification depends entirely on the regex list.
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
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()

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
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    expect(wired.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C3 reports the element bound as request_limit_exceeded before authorize (#731)', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    // `checkStructure` runs before `JSON.stringify`, so a structure with more
    // elements than the byte cap is refused by the element bound and never by
    // the byte measurement. Its message carries a suffix the byte bound does
    // not, which is why `CONTEXT_LENGTH_REFUSALS` matches the byte pattern as a
    // prefix: anchoring it at both ends would drop this refusal back to
    // `invalid_request` and no other test would notice.
    const history = [
      { role: 'user' as const, content: 'summarize the export' },
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            name: 'export_rows',
            arguments: { ids: Array.from({ length: 1_048_577 }, () => 0) },
          },
        ],
      },
    ]

    const rejected = provider.completeSingleTurn(history)
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'request exceeds maxRequestBodyBytes element bound',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()

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
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    expect(wired.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C4 keeps a non-size limit refusal out of the context-length taxonomy (#731)', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    // The negative half of the partition. Nesting depth also fails with
    // `code: 'limit'`, and compaction cannot fix it: a shorter conversation
    // keeps whatever depth the surviving arguments have. Classifying it as a
    // context-length failure would put the user in a compaction loop that never
    // converges, so it has to stay `invalid_request`.
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
      message: 'request exceeds maximum nesting depth 64',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()

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
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    expect(wired.stream).toHaveBeenCalledTimes(1)
  })

  it('T-C5 keeps an out-of-range maxOutputTokens out of the context-length taxonomy (#731)', async () => {
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)
    // T-C4 and this test pin the same half of the partition from opposite
    // distances, which is why both exist. `request exceeds maximum nesting
    // depth 64` shares the prefix `request exceeds max` with the byte regex and
    // diverges one character later, so T-C4 is the near miss: it fails the
    // moment that regex is loosened at all. This message shares nothing with
    // any of the three patterns, so it only fails under a broadening wide
    // enough to swallow an unrelated field - the case T-C4 cannot see.
    // `maxOutputTokens` reaches the contract from the caller unclamped
    // (`codexSubscription.ts:265-267` -> `:450`), so this is a refusal a caller
    // can actually provoke, not a synthetic one.
    const history = [{ role: 'user' as const, content: 'summarize' }]

    const rejected = provider.completeSingleTurn(history, { max_tokens: 16_385 })
    await expect(rejected).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(rejected).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'generation.maxOutputTokens is out of range',
    })
    expect(wired.authorize).not.toHaveBeenCalled()
    expect(wired.stream).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
    })

    // Liveness witness: the bound itself authorizes and streams, so the refusal
    // is the range check and not the presence of `max_tokens` in the request.
    await provider.completeSingleTurn(history, { max_tokens: 16_384 })
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    expect(wired.stream).toHaveBeenCalledTimes(1)
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

  it.each([
    ['unknown', 'partial codex text', 'outcome_unknown'],
    ['canceled', '', 'canceled'],
    ['canceled', 'partial codex text', 'canceled'],
  ] as const)(
    'rejects a non-success %s terminal outcome (text=%j) instead of completing',
    async (outcome, text, code) => {
      const stream = vi.fn().mockResolvedValue({ text, toolCalls: [], outcome })
      const provider = new CodexSubscriptionProvider('gpt-5.3-codex', deps({ stream }) as never)

      const single = provider.completeSingleTurn([{ role: 'user', content: 'hi' }])
      await expect(single).rejects.toBeInstanceOf(CodexProxyError)
      await expect(single).rejects.toMatchObject({ code, dispatched: true })

      await expect(
        provider.completeSingleTurnWithTools(
          [{ role: 'user', content: 'hi' }],
          [{ name: 'echo', description: 'echo', parameters: {} }]
        )
      ).rejects.toMatchObject({ code, dispatched: true })

      const classified = provider.classifyError(new CodexProxyError(code, 'terminal'))
      expect(classified.code).toBe(LlmErrorCode.ApiCallFailed)
      expect(classified.retryable).toBe(false)
      expect(classified.providerDispatched).toBe(true)
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
    }
  )

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

  it('classifies request limits as non-retryable, non-failover errors', () => {
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', deps() as never)

    const toolLimit = provider.classifyError(
      new CodexProxyError('tool_call_limit_exceeded', 'tool calls exceed 256')
    )
    expect(toolLimit).toEqual({
      code: LlmErrorCode.ToolCallLimitExceeded,
      retryable: false,
      message: 'tool calls exceed 256',
      providerCode: 'tool_call_limit_exceeded',
      providerDispatched: true,
    })
    expect(classifyFailoverClass(toolLimit.code, toolLimit.retryable)).toBeNull()

    const history = provider.classifyError(
      new CodexAuthorizeError('request_limit_exceeded', 'messages exceed 1024')
    )
    expect(history).toEqual({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
      message: 'messages exceed 1024',
      providerCode: 'request_limit_exceeded',
      providerDispatched: false,
    })
    expect(classifyFailoverClass(history.code, history.retryable)).toBeNull()

    // Witness: the new branches leave the outage mapping untouched.
    const unavailable = provider.classifyError(
      new CodexProxyError('provider_unavailable', 'upstream 5xx')
    )
    expect(unavailable.code).toBe(LlmErrorCode.ModelOverloaded)
    expect(unavailable.retryable).toBe(true)
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
