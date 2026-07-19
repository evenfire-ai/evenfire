import { describe, expect, it, vi } from 'vitest'
import { SingleTurnProvider } from '../../../llm'
import { ClaudeProvider } from '../../../llm/claude'
import { OpenAIProvider } from '../../../llm/openai'
import { LlmError, LlmErrorCode } from '../../errors'
import { FinishReason } from '../../types'
import { LlmPortAdapter } from '../llmPortAdapter'

describe('LlmPortAdapter', () => {
  it('should delegate complete() to provider.completeSingleTurn()', async () => {
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockResolvedValue({
        content: 'Hello',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: FinishReason.Stop,
      }),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'mock',
      })),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    const result = await adapter.complete({
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 100,
      temperature: 0.7,
    })

    expect(mockProvider.completeSingleTurn).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hi' }],
      { max_tokens: 100, temperature: 0.7 }
    )
    expect(result.content).toBe('Hello')
  })

  it('should delegate completeWithTools() to provider.completeSingleTurnWithTools()', async () => {
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn().mockResolvedValue({
        content: null,
        tool_calls: [{ id: 'tc_1', name: 'search', arguments: { q: 'X' } }],
        usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 },
        finish_reason: FinishReason.ToolUse,
      }),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'mock',
      })),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    const result = await adapter.completeWithTools({
      messages: [{ role: 'user', content: 'Search' }],
      tools: [{ name: 'search', description: 'Search', parameters: {} }],
      tool_choice: 'auto',
    })

    expect(result.tool_calls).toHaveLength(1)
    expect(result.finish_reason).toBe(FinishReason.ToolUse)
  })

  it('should wrap provider errors in LlmError', async () => {
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(new Error('API rate limited')),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'mock',
      })),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    await expect(adapter.complete({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow(
      LlmError
    )

    try {
      await adapter.complete({ messages: [{ role: 'user', content: 'Hi' }] })
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).provider).toBe('openai')
      expect((err as LlmError).code).toBe(LlmErrorCode.ApiCallFailed)
      expect((err as LlmError).cause?.message).toBe('API rate limited')
    }
  })

  it('should return model name', () => {
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'mock',
      })),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'claude-3-5-sonnet-20241022', 'claude')
    expect(adapter.modelName()).toBe('claude-3-5-sonnet-20241022')
  })

  it('delegates error classification to provider.classifyError and preserves retryable', async () => {
    const originalError = {
      status: 429,
      error: { code: 'insufficient_quota', message: 'out of credit' },
    }
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn().mockRejectedValue(originalError),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn().mockReturnValue({
        code: LlmErrorCode.InsufficientQuota,
        retryable: false,
        message: 'out of credit',
      }),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    await expect(
      adapter.completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      })
    ).rejects.toMatchObject({
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      message: 'out of credit',
      provider: 'openai',
    })

    expect(mockProvider.classifyError).toHaveBeenCalledWith(originalError)
  })

  it('delegates error classification for complete() as well', async () => {
    const originalError = { status: 503, message: 'overloaded' }
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(originalError),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn().mockReturnValue({
        code: LlmErrorCode.ModelOverloaded,
        retryable: true,
        message: 'overloaded',
      }),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    await expect(
      adapter.complete({
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      message: 'overloaded',
      provider: 'openai',
    })

    expect(mockProvider.classifyError).toHaveBeenCalledWith(originalError)
  })

  it('preserves the original SDK error as the LlmError cause', async () => {
    const originalError = new Error('network dead')
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(originalError),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn().mockReturnValue({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'network dead',
      }),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'gpt-4o', 'openai')

    try {
      await adapter.complete({ messages: [{ role: 'user', content: 'x' }] })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).cause).toBe(originalError)
    }
  })

  it('propagates retryable=true for transient errors', async () => {
    const mockProvider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue({ status: 503 }),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'claude' as const,
      classifyError: vi.fn().mockReturnValue({
        code: LlmErrorCode.ModelOverloaded,
        retryable: true,
        message: 'overloaded',
      }),
    }
    const adapter = new LlmPortAdapter(mockProvider, 'claude-3-5', 'claude')

    await expect(adapter.complete({ messages: [] })).rejects.toMatchObject({
      retryable: true,
      provider: 'claude',
    })
  })
})

describe('LlmPortAdapter usage reporting', () => {
  it('enqueues a usage event when reporter + staticContext + usageContext are all present', async () => {
    const enqueue = vi.fn()
    const reporter = { enqueue, drain: vi.fn(), stop: vi.fn(), bufferSize: vi.fn() }
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn().mockResolvedValue({
        content: null,
        tool_calls: [],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        finish_reason: FinishReason.Stop,
      }),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(provider, 'gpt-4o', 'openai', reporter as never, {
      host_ref: 'trader',
      context_ref: 'trader-context',
      llm_secret_name: 'openai-key',
    })
    await adapter.completeWithTools({
      messages: [],
      tools: [],
      usageContext: {
        source_kind: 'desktop',
        traceContext: {
          version: 1,
          runId: '00000000-0000-4000-8000-000000000001',
          origin: 'direct_chat',
          correlationRefs: [],
        },
        team_id: '11111111-1111-4111-8111-111111111111',
        user_id: 'user-1',
        task_id: 'task-1',
      },
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const event = enqueue.mock.calls[0][0]
    expect(event).toMatchObject({
      host_ref: 'trader',
      context_ref: 'trader-context',
      team_id: '11111111-1111-4111-8111-111111111111',
      llm_secret_name: 'openai-key',
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'desktop',
      run_id: '00000000-0000-4000-8000-000000000001',
      user_id: 'user-1',
      task_id: 'task-1',
      input_tokens: 100,
      output_tokens: 50,
    })
    expect(typeof event.request_id).toBe('string')
    expect(typeof event.ts).toBe('string')
  })

  it('does not enqueue when usageContext is omitted', async () => {
    const enqueue = vi.fn()
    const reporter = { enqueue, drain: vi.fn(), stop: vi.fn(), bufferSize: vi.fn() }
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn().mockResolvedValue({
        content: null,
        tool_calls: [],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        finish_reason: FinishReason.Stop,
      }),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(provider, 'gpt-4o', 'openai', reporter as never, {
      host_ref: 'trader',
      context_ref: null,
      llm_secret_name: null,
    })
    await adapter.completeWithTools({ messages: [], tools: [] })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('does not enqueue when reporter is omitted', async () => {
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: FinishReason.Stop,
      }),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(provider, 'gpt-4o', 'openai')
    // Should not throw despite usageContext being present without a reporter.
    await adapter.complete({
      messages: [],
      usageContext: { source_kind: 'desktop' },
    })
  })

  it('does not enqueue on provider error', async () => {
    const enqueue = vi.fn()
    const reporter = { enqueue, drain: vi.fn(), stop: vi.fn(), bufferSize: vi.fn() }
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(new Error('boom')),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'boom',
      })),
    }
    const adapter = new LlmPortAdapter(provider, 'gpt-4o', 'openai', reporter as never, {
      host_ref: 'trader',
      context_ref: null,
      llm_secret_name: null,
    })
    await expect(
      adapter.complete({
        messages: [],
        usageContext: { source_kind: 'desktop' },
      })
    ).rejects.toThrow(LlmError)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('LlmPortAdapter session usage sink (onUsageRecorded)', () => {
  it('forwards tokens, preserving undefined cache fields for providers that omit them (OpenAI)', async () => {
    const onUsageRecorded = vi.fn()
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn().mockResolvedValue({
        content: null,
        tool_calls: [],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        finish_reason: FinishReason.Stop,
      }),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      onUsageRecorded
    )
    await adapter.completeWithTools({ messages: [], tools: [] })
    expect(onUsageRecorded).toHaveBeenCalledTimes(1)
    expect(onUsageRecorded).toHaveBeenCalledWith({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: undefined,
      cache_write_tokens: undefined,
    })
  })

  it('forwards defined cache fields for providers that report them (Anthropic, incl. 0)', async () => {
    const onUsageRecorded = vi.fn()
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn().mockResolvedValue({
        content: null,
        tool_calls: [],
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
          cache_read_tokens: 0,
          cache_write_tokens: 12,
        },
        finish_reason: FinishReason.Stop,
      }),
      getProviderType: () => 'claude' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(
      provider,
      'claude-x',
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      onUsageRecorded
    )
    await adapter.completeWithTools({ messages: [], tools: [] })
    expect(onUsageRecorded).toHaveBeenCalledWith({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 0,
      cache_write_tokens: 12,
    })
  })

  it('fires INDEPENDENTLY of the UsageReporter (no reporter wired)', async () => {
    // crit #5 — session persistence must not depend on control-api being wired.
    const onUsageRecorded = vi.fn()
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        finish_reason: FinishReason.Stop,
      }),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      onUsageRecorded
    )
    await adapter.complete({ messages: [] })
    expect(onUsageRecorded).toHaveBeenCalledTimes(1)
  })

  it('swallows a throwing sink so it cannot abort a successful call', async () => {
    // crit: recordUsage runs inside the LLM try block — a sink throw must NOT
    // bubble up and be mis-classified as a provider error.
    const onUsageRecorded = vi.fn(() => {
      throw new Error('sink boom')
    })
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        finish_reason: FinishReason.Stop,
      }),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      onUsageRecorded
    )
    const result = await adapter.complete({ messages: [] })
    expect(result.content).toBe('ok')
    expect(onUsageRecorded).toHaveBeenCalledTimes(1)
  })

  it('does not fire on provider error', async () => {
    const onUsageRecorded = vi.fn()
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockRejectedValue(new Error('boom')),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'boom',
      })),
    }
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      onUsageRecorded
    )
    await expect(adapter.complete({ messages: [] })).rejects.toThrow(LlmError)
    expect(onUsageRecorded).not.toHaveBeenCalled()
  })
})

describe('LlmPortAdapter token counter wiring (P.2)', () => {
  it('forwards observed usage to the counter on every successful round-trip', async () => {
    const recordObservedUsage = vi.fn()
    const counter = {
      providerName: 'openai' as const,
      modelName: 'gpt-4o',
      count: vi.fn(async () => 0),
      countSync: vi.fn(() => 0),
      warmup: vi.fn(async () => {}),
      recordObservedUsage,
      lastObservedInputTokens: vi.fn(() => null),
    }
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { input_tokens: 314, output_tokens: 27, total_tokens: 341 },
        finish_reason: FinishReason.Stop,
      }),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-4o',
      'openai',
      undefined,
      undefined,
      undefined,
      counter
    )
    await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(recordObservedUsage).toHaveBeenCalledTimes(1)
    expect(recordObservedUsage.mock.calls[0][0]).toMatchObject({
      input_tokens: 314,
      output_tokens: 27,
    })
    expect(adapter.getTokenCounter()).toBe(counter)
  })

  it('getTokenCounter() throws when no counter was injected', () => {
    const provider: SingleTurnProvider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: vi.fn(),
      getProviderType: () => 'openai' as const,
      classifyError: vi.fn(),
    }
    const adapter = new LlmPortAdapter(provider, 'gpt-4o', 'openai')
    expect(() => adapter.getTokenCounter()).toThrow(/wiring bug/)
  })
})

describe('Cross-provider ToolCall normalization', () => {
  it('should produce identical ToolCall structures from both providers', async () => {
    const expectedToolCall = {
      id: expect.any(String),
      name: 'search',
      arguments: { query: 'hello', limit: 10 },
    }

    // OpenAI path
    const openaiClient = {
      chat: { completions: { create: vi.fn() } },
    }
    openaiClient.chat.completions.create.mockResolvedValue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"query":"hello","limit":10}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })
    const openai = new OpenAIProvider(openaiClient as any, 'gpt-4o')
    const openaiResult = await openai.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    // Claude path
    const claudeClient = {
      messages: { create: vi.fn() },
    }
    claudeClient.messages.create.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_xyz',
          name: 'search',
          input: { query: 'hello', limit: 10 },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    const claude = new ClaudeProvider(claudeClient as any, 'claude-3-5-sonnet-20241022')
    const claudeResult = await claude.completeSingleTurnWithTools(
      [{ role: 'user', content: 'Search' }],
      [{ name: 'search', description: 'Search', parameters: {} }]
    )

    // Both should produce normalized ToolCall with identical structure (except id)
    expect(openaiResult.tool_calls![0]).toMatchObject(expectedToolCall)
    expect(claudeResult.tool_calls![0]).toMatchObject(expectedToolCall)
    expect(typeof openaiResult.tool_calls![0].arguments).toBe('object')
    expect(typeof claudeResult.tool_calls![0].arguments).toBe('object')
  })
})
