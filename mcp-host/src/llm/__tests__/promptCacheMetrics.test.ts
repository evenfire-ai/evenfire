import { describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import type { TokenUsage } from '../../core/types'
import { UsageReporter } from '../../usage/usageReporter'
import {
  clerumPromptCacheInputTokens,
  clerumPromptCacheReadTokens,
  clerumPromptCacheWriteTokens,
  clerumPromptStableHash,
  stampStableHashGauge,
} from '../promptCacheMetrics'

function fakeProvider(response: { usage: TokenUsage }) {
  return {
    completeSingleTurn: vi.fn().mockResolvedValue({
      content: 'ok',
      finish_reason: 'stop',
      usage: response.usage,
    }),
    completeSingleTurnWithTools: vi.fn().mockResolvedValue({
      content: 'ok',
      tool_calls: null,
      finish_reason: 'stop',
      usage: response.usage,
    }),
    getProviderType: () => 'claude' as const,
    classifyError: () => ({ code: 'api_call_failed' as const, retryable: false, message: 'x' }),
  }
}

describe('Prompt-cache metrics (T2.2)', () => {
  it('LlmPortAdapter observes input/cache_read/cache_write tokens per call', async () => {
    const inputBefore =
      (await clerumPromptCacheInputTokens.get()).values.find(
        v => v.metricName === 'clerum_prompt_cache_input_tokens_count'
      )?.value ?? 0
    const readBefore =
      (await clerumPromptCacheReadTokens.get()).values.find(
        v => v.metricName === 'clerum_prompt_cache_read_tokens_count'
      )?.value ?? 0
    const writeBefore =
      (await clerumPromptCacheWriteTokens.get()).values.find(
        v => v.metricName === 'clerum_prompt_cache_creation_tokens_count'
      )?.value ?? 0

    const provider = fakeProvider({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_tokens: 80,
        cache_write_tokens: 15,
      },
    })
    const adapter = new LlmPortAdapter(provider as any, 'claude-sonnet-4-6', 'claude')
    await adapter.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })

    const inputAfter =
      (await clerumPromptCacheInputTokens.get()).values.find(
        v => v.metricName === 'clerum_prompt_cache_input_tokens_count'
      )?.value ?? 0
    const readAfter =
      (await clerumPromptCacheReadTokens.get()).values.find(
        v => v.metricName === 'clerum_prompt_cache_read_tokens_count'
      )?.value ?? 0
    const writeAfter =
      (await clerumPromptCacheWriteTokens.get()).values.find(
        v => v.metricName === 'clerum_prompt_cache_creation_tokens_count'
      )?.value ?? 0

    expect(inputAfter).toBe(inputBefore + 1)
    expect(readAfter).toBe(readBefore + 1)
    expect(writeAfter).toBe(writeBefore + 1)
  })

  it('forwards cache_read/write tokens to the UsageReporter (P1-006)', async () => {
    const enqueue = vi.fn()
    const reporter = { enqueue } as unknown as UsageReporter
    const provider = fakeProvider({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_tokens: 80,
        cache_write_tokens: 15,
      },
    })
    const adapter = new LlmPortAdapter(
      provider as any,
      'claude-sonnet-4-6',
      'claude',
      reporter,
      { host_ref: 'h', context_ref: 'c', llm_secret_name: 'n' },
      { source_kind: 'desktop', task_id: 't1' }
    )
    await adapter.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })

    expect(enqueue).toHaveBeenCalledOnce()
    const event = enqueue.mock.calls[0][0]
    expect(event.input_tokens).toBe(100)
    expect(event.output_tokens).toBe(20)
    expect(event.cache_read_tokens).toBe(80)
    expect(event.cache_write_tokens).toBe(15)
  })

  it('stampStableHashGauge sets the gauge with session_key + stable_hash labels (value=1)', async () => {
    stampStableHashGauge('s-metrics-1', 'deadbeef')
    const snapshot = await clerumPromptStableHash.get()
    const match = snapshot.values.find(
      v => v.labels?.session_key === 's-metrics-1' && v.labels?.stable_hash === 'deadbeef'
    )
    expect(match).toBeDefined()
    expect(match?.value).toBe(1)
  })
})
