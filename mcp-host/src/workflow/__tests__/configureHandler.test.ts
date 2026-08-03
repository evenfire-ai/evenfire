import { describe, expect, it, vi } from 'vitest'
import { LlmErrorCode } from '../../core/errors'
import type { SingleTurnProvider } from '../../llm'
import type { ConfigureRequest } from '../types'
import { WorkflowService } from '../workflowService'

// ─── Mock LLM Factory ──────────────────────────────────────────────────

function mockLlmFactory(shouldFail = false) {
  return (provider: string, model: string, _apiKey: string): SingleTurnProvider | null => {
    if (shouldFail) return null
    return {
      completeSingleTurn: vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop',
      }),
      completeSingleTurnWithTools: vi.fn().mockResolvedValue({
        content: 'ok',
        tool_calls: null,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        finish_reason: 'stop',
      }),
      getProviderType: () => provider as 'openai',
      classifyError: vi.fn(() => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: 'mock',
      })),
    }
  }
}

describe('POST /configure — JWT scope', () => {
  // JWT scope validation happens in workflowRouter middleware, not in WorkflowService.
  // These tests verify configure() rejects bad input at the service level.

  it('returns configured: false when provider scope is missing', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const result = svc.configure({ apiKey: 'sk-123' } as ConfigureRequest)
    expect(result.configured).toBe(false)
    expect(result.message).toContain('provider is required')
  })

  it('returns configured: false when apiKey is missing', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const result = svc.configure({ provider: 'openai' } as ConfigureRequest)
    expect(result.configured).toBe(false)
    expect(result.message).toContain('apiKey is required')
  })

  it('returns configured: true with valid provider and apiKey', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const result = svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
    expect(result.configured).toBe(true)
    expect(result.provider).toBe('openai')
  })

  it('publishes SDK bootstrap identity without making the workflow service ready or receiving a key', async () => {
    const onBootstrap = vi.fn()
    const svc = new WorkflowService('test', {
      llmFactory: mockLlmFactory(),
      onPluginWorkloadSdkBootstrapConfigured: onBootstrap,
    })
    const result = await svc.configurePluginWorkloadSdkBootstrap({
      provider: 'openai',
      model: 'gpt-4',
      // @ts-expect-error the public bootstrap contract intentionally has no apiKey
      apiKey: 'must-not-be-consumed',
    })
    expect(result).toEqual({
      configured: true,
      ready: true,
      provider: 'openai',
      model: 'gpt-4',
      contractVersion: 2,
    })
    expect(onBootstrap).toHaveBeenCalledWith({ provider: 'openai', defaultModel: 'gpt-4' })
    expect(svc.isReady()).toBe(false)
  })
})

describe('POST /configure — provider hot-swap', () => {
  it('creates new LLM provider instance with given provider and model', () => {
    const factory = vi.fn(mockLlmFactory())
    const svc = new WorkflowService('test', { llmFactory: factory })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
    expect(factory).toHaveBeenCalledWith('openai', 'gpt-4', 'sk-123')
  })

  it('replaces in-memory provider reference atomically', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-123' })
    expect(svc.isReady()).toBe(true)

    svc.configure({ provider: 'claude', model: 'claude-3', apiKey: 'sk-ant-456' })
    expect(svc.isReady()).toBe(true)
  })

  it('returns configured: true with provider and model', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const result = svc.configure({ provider: 'zai', model: 'glm-4.7', apiKey: 'zai-123' })
    expect(result).toEqual({ configured: true, provider: 'zai', model: 'glm-4.7' })
  })

  it('returns configured: false for unknown provider string', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const result = svc.configure({ provider: 'unknown' as never, model: 'x', apiKey: 'k' })
    expect(result.configured).toBe(false)
  })

  it('returns configured: false for missing apiKey', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const result = svc.configure({ provider: 'openai', model: 'gpt-4' } as ConfigureRequest)
    expect(result.configured).toBe(false)
  })
})

describe('POST /configure — SOUL override', () => {
  it('sets soulOverrideActive flag when soulContent is present', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    svc.configure({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'k',
      soulContent: 'You are an expert.',
    })
    expect(svc.isSoulOverrideActive()).toBe(true)
  })

  it('does not set soulOverrideActive flag when soulContent is absent', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k' })
    expect(svc.isSoulOverrideActive()).toBe(false)
  })

  it('stores soulContent in memory for use by next execute call', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k', soulContent: 'Custom SOUL' })
    expect(svc.getActiveSoulContent()).toBe('Custom SOUL')
  })

  it('returns configured: false when soulContent exceeds 64KB', () => {
    const svc = new WorkflowService('test', { llmFactory: mockLlmFactory() })
    const bigContent = 'x'.repeat(65 * 1024)
    const result = svc.configure({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'k',
      soulContent: bigContent,
    })
    expect(result.configured).toBe(false)
    expect(result.message).toContain('64KB')
  })
})

describe('POST /configure — idempotency', () => {
  it('second configure call with different model replaces first', () => {
    const factory = vi.fn(mockLlmFactory())
    const svc = new WorkflowService('test', { llmFactory: factory })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k1' })
    svc.configure({ provider: 'openai', model: 'gpt-4o', apiKey: 'k2' })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('configure with same provider/model is a no-op (no new instance created)', () => {
    const factory = vi.fn(mockLlmFactory())
    const svc = new WorkflowService('test', { llmFactory: factory })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k1' })
    svc.configure({ provider: 'openai', model: 'gpt-4', apiKey: 'k1' })
    expect(factory).toHaveBeenCalledTimes(1) // idempotent
  })

  it('rejects invalid llmSecretName metadata before configuring provider', () => {
    const factory = vi.fn(mockLlmFactory())
    const svc = new WorkflowService('test', { llmFactory: factory })
    const result = svc.configure({
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'k1',
      llmSecretName: '../secret',
    })
    expect(result.configured).toBe(false)
    expect(result.message).toContain('llmSecretName')
    expect(factory).not.toHaveBeenCalled()
  })
})
