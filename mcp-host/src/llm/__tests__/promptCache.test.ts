import { describe, expect, it, vi } from 'vitest'
import { DefaultPromptBuilder } from '../../core/reasoning/promptBuilder'
import type { SystemPromptParts } from '../../core/reasoning/systemPrompt'
import { ClaudeProvider } from '../claude'
import { PromptCache } from '../promptCache'

function makeMockClient() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 15,
        },
      }),
    },
  }
}

function makeParts(): SystemPromptParts {
  const builder = new DefaultPromptBuilder()
  return builder.buildParts({
    identityFiles: { identity: 'I', soul: 'S', agents: 'A', user: 'U' },
    dailyLogSnapshot: '## Today\nentry',
    model: 'claude-sonnet-4-6',
    provider: 'claude',
    platformHints: [],
    capabilities: 'cap',
    workflowGuidance: '',
    mcpServerGuidance: '',
    toolDiscoveryGuidance: '',
    memoryGuidance: 'mem',
  })
}

describe('PromptCache (T2.2)', () => {
  it('get returns undefined on miss; set/get round-trip', () => {
    const cache = new PromptCache()
    expect(cache.get('s1')).toBeUndefined()
    const parts = makeParts()
    cache.set('s1', { parts, dailyLogSnapshot: 'today' })
    expect(cache.get('s1')?.parts).toBe(parts)
    expect(cache.get('s1')?.dailyLogSnapshot).toBe('today')
  })

  it('drop fires onDrop observer and removes the entry', () => {
    const onDrop = vi.fn()
    const cache = new PromptCache({ onDrop })
    cache.set('s1', { parts: makeParts(), dailyLogSnapshot: 'today' })
    cache.drop('s1')
    expect(onDrop).toHaveBeenCalledWith('s1')
    expect(cache.get('s1')).toBeUndefined()
  })

  it('drop is a no-op (no observer fire) when sessionKey is unknown', () => {
    const onDrop = vi.fn()
    new PromptCache({ onDrop }).drop('unknown')
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('invalidate(compact) drops the entry entirely (next call re-snapshots daily)', () => {
    const cache = new PromptCache()
    cache.set('s1', { parts: makeParts(), dailyLogSnapshot: 'frozen-v1' })
    cache.invalidate('s1', 'compact')
    expect(cache.get('s1')).toBeUndefined()
  })

  it('invalidate(host_change) keeps the dailyLogSnapshot but drops parts', () => {
    const cache = new PromptCache()
    cache.set('s1', { parts: makeParts(), dailyLogSnapshot: 'frozen-v1' })
    cache.invalidate('s1', 'host_change')
    const after = cache.get('s1')
    expect(after?.parts).toBeNull()
    expect(after?.dailyLogSnapshot).toBe('frozen-v1')
  })

  it('observer.onInvalidate receives previous stableHash', () => {
    const onInvalidate = vi.fn()
    const cache = new PromptCache({ onInvalidate })
    const parts = makeParts()
    cache.set('s1', { parts, dailyLogSnapshot: 'x' })
    cache.invalidate('s1', 'model_change')
    expect(onInvalidate).toHaveBeenCalledWith('s1', 'model_change', parts.stableHash)
  })

  it('invalidateAll broadcasts across every session', () => {
    const cache = new PromptCache()
    cache.set('s1', { parts: makeParts(), dailyLogSnapshot: 'd1' })
    cache.set('s2', { parts: makeParts(), dailyLogSnapshot: 'd2' })
    cache.invalidateAll('identity_reconciled')
    expect(cache.get('s1')?.parts).toBeNull()
    expect(cache.get('s2')?.parts).toBeNull()
    expect(cache.get('s1')?.dailyLogSnapshot).toBe('d1')
  })
})

describe('ClaudeProvider.completeSingleTurnWithToolsAndCache (T2.2)', () => {
  it('emits system as an array of TextBlockParam with cache_control on each tier', async () => {
    const client = makeMockClient()
    const provider = new ClaudeProvider(client as any, 'claude-sonnet-4-6')
    const parts = makeParts()

    await provider.completeSingleTurnWithToolsAndCache!(
      parts,
      [{ role: 'user', content: 'hi' }],
      []
    )

    const args = client.messages.create.mock.calls[0][0]
    expect(Array.isArray(args.system)).toBe(true)
    expect(args.system).toHaveLength(2)
    expect(args.system[0]).toMatchObject({
      type: 'text',
      text: parts.stable,
      cache_control: { type: 'ephemeral' },
    })
    expect(args.system[1]).toMatchObject({
      type: 'text',
      text: parts.context,
      cache_control: { type: 'ephemeral' },
    })
  })

  it('sorts tools alphabetically so polling churn shifts only the delta', async () => {
    const client = makeMockClient()
    const provider = new ClaudeProvider(client as any, 'claude-sonnet-4-6')

    await provider.completeSingleTurnWithToolsAndCache!(
      makeParts(),
      [],
      [
        { name: 'zebra', description: 'last', parameters: {} },
        { name: 'apple', description: 'first', parameters: {} },
        { name: 'mango', description: 'mid', parameters: {} },
      ]
    )

    const args = client.messages.create.mock.calls[0][0]
    expect(args.tools.map((t: any) => t.name)).toEqual(['apple', 'mango', 'zebra'])
  })

  it('maps Anthropic cache_*_input_tokens to mcp-host cache_(read|write)_tokens (P1-006)', async () => {
    const client = makeMockClient()
    const provider = new ClaudeProvider(client as any, 'claude-sonnet-4-6')

    const resp = await provider.completeSingleTurnWithToolsAndCache!(
      makeParts(),
      [{ role: 'user', content: 'hi' }],
      []
    )

    expect(resp.usage.cache_read_tokens).toBe(80)
    expect(resp.usage.cache_write_tokens).toBe(15)
    expect(resp.usage.input_tokens).toBe(100)
    expect(resp.usage.output_tokens).toBe(20)
  })

  it('omits the system array when both tiers are empty (defensive shape)', async () => {
    const client = makeMockClient()
    const provider = new ClaudeProvider(client as any, 'claude-sonnet-4-6')

    await provider.completeSingleTurnWithToolsAndCache!(
      { stable: '', context: '', stableHash: '', contextHash: '' },
      [{ role: 'user', content: 'hi' }],
      []
    )

    const args = client.messages.create.mock.calls[0][0]
    expect(args.system).toBeUndefined()
  })
})

describe('LlmPortAdapter wiring (T2.2)', () => {
  it('falls back to concat when the provider lacks cache-aware method', async () => {
    const { LlmPortAdapter } = await import('../../core/adapters/llmPortAdapter')
    const completeSingleTurnWithTools = vi.fn().mockResolvedValue({
      content: 'ok',
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    })
    const provider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools,
      getProviderType: () => 'openai' as const,
      classifyError: () => ({ code: 'api_call_failed' as const, retryable: false, message: 'x' }),
      // No cache-aware methods → adapter must concat parts into messages.
    }
    const adapter = new LlmPortAdapter(provider as any, 'gpt-x', 'openai')
    const parts = makeParts()
    await adapter.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      systemPromptParts: parts,
    })

    expect(completeSingleTurnWithTools).toHaveBeenCalled()
    const sentMessages = completeSingleTurnWithTools.mock.calls[0][0]
    expect(sentMessages[0]).toMatchObject({ role: 'system' })
    expect(sentMessages[0].content).toContain(parts.stable)
    expect(sentMessages[0].content).toContain(parts.context)
    expect(sentMessages[1]).toMatchObject({ role: 'user', content: 'hi' })
  })

  it('routes to completeSingleTurnWithToolsAndCache when available', async () => {
    const { LlmPortAdapter } = await import('../../core/adapters/llmPortAdapter')
    const cacheMethod = vi.fn().mockResolvedValue({
      content: 'ok',
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    })
    const legacyMethod = vi.fn()
    const provider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: legacyMethod,
      completeSingleTurnWithToolsAndCache: cacheMethod,
      getProviderType: () => 'claude' as const,
      classifyError: () => ({ code: 'api_call_failed' as const, retryable: false, message: 'x' }),
    }
    const adapter = new LlmPortAdapter(provider as any, 'claude-sonnet-4-6', 'claude')
    const parts = makeParts()
    await adapter.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      systemPromptParts: parts,
    })

    expect(cacheMethod).toHaveBeenCalled()
    expect(legacyMethod).not.toHaveBeenCalled()
    expect(cacheMethod.mock.calls[0][0]).toBe(parts)
  })

  it('keeps legacy path when systemPromptParts is omitted', async () => {
    const { LlmPortAdapter } = await import('../../core/adapters/llmPortAdapter')
    const cacheMethod = vi.fn()
    const legacyMethod = vi.fn().mockResolvedValue({
      content: 'ok',
      tool_calls: null,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    })
    const provider = {
      completeSingleTurn: vi.fn(),
      completeSingleTurnWithTools: legacyMethod,
      completeSingleTurnWithToolsAndCache: cacheMethod,
      getProviderType: () => 'claude' as const,
      classifyError: () => ({ code: 'api_call_failed' as const, retryable: false, message: 'x' }),
    }
    const adapter = new LlmPortAdapter(provider as any, 'claude-sonnet-4-6', 'claude')
    await adapter.completeWithTools({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [],
    })

    expect(legacyMethod).toHaveBeenCalled()
    expect(cacheMethod).not.toHaveBeenCalled()
  })
})
