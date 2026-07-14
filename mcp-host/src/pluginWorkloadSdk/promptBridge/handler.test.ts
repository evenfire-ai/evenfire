import { describe, expect, it, vi } from 'vitest'
import { PluginWorkloadError } from '../domain/errors'
import type { PluginWorkloadSdkControlApiClient } from './controlApiClient'
import { PromptBridgeHandler } from './handler'
import type { LlmBridge } from './llmBridge'

const validBody = {
  purpose: 'summarization',
  idempotencyKey: 'key-1',
  messages: [{ role: 'user', content: 'summarize this' }],
}

function makeDeps(
  overrides: {
    authorize?: ReturnType<typeof vi.fn>
    complete?: ReturnType<typeof vi.fn>
    report?: ReturnType<typeof vi.fn>
    defaultModel?: string | null
    onUsage?: (usage: {
      model: string
      inputTokens: number
      outputTokens: number
      callerRef: string
    }) => void
  } = {}
) {
  const authorize =
    overrides.authorize ??
    vi.fn().mockResolvedValue({
      invocationId: 'inv-1',
      replay: false,
      status: 'in_progress',
      model: 'glm-4.7',
      modelPolicy: null,
      maxOutputTokens: 2048,
    })
  const report = overrides.report ?? vi.fn().mockResolvedValue(undefined)
  const complete =
    overrides.complete ??
    vi.fn().mockResolvedValue({
      model: 'glm-4.7',
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
  const controlApiClient = {
    authorizePromptBridge: authorize,
    reportInvocationStatus: report,
  } as unknown as PluginWorkloadSdkControlApiClient
  const llmBridge = { complete } as unknown as LlmBridge
  const handler = new PromptBridgeHandler({
    controlApiClient,
    llmBridge,
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'r1',
    promptTimeoutMs: 120_000,
    resolveDefaultModel: () => overrides.defaultModel ?? 'glm-4.7',
    onUsage: overrides.onUsage,
  })
  return { handler, authorize, complete, report }
}

describe('PromptBridgeHandler', () => {
  it('rejects an invalid purpose before authorizing', async () => {
    const { handler, authorize } = makeDeps()
    await expect(
      handler.handle({ ...validBody, purpose: 'jailbreak' }, 'api')
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects a malformed idempotency key', async () => {
    const { handler } = makeDeps()
    await expect(
      handler.handle({ ...validBody, idempotencyKey: 'has spaces!' }, 'api')
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('rejects oversized message content with payload_too_large', async () => {
    const { handler, authorize } = makeDeps()
    await expect(
      handler.handle(
        { ...validBody, messages: [{ role: 'user', content: 'x'.repeat(128 * 1024 + 1) }] },
        'api'
      )
    ).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(authorize).not.toHaveBeenCalled()
  })

  it('returns the spec §10 result shape and reports completion', async () => {
    const onUsage = vi.fn()
    const { handler, complete, report } = makeDeps({ onUsage })
    const result = await handler.handle(validBody, 'api')
    expect(result).toMatchObject({
      invocationId: 'inv-1',
      model: 'glm-4.7',
      content: 'summary text',
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'complete',
    })
    expect(result.correlationId).toBeTruthy()
    expect(result.createdAt).toBeTruthy()
    // maxOutputTokens from the grant clamps the request
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 2048 }))
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'complete')
    expect(onUsage).toHaveBeenCalledWith({
      model: 'glm-4.7',
      inputTokens: 10,
      outputTokens: 5,
      callerRef: 'api',
    })
  })

  it('clamps requested maxTokens to the grant cap', async () => {
    const { handler, complete } = makeDeps()
    await handler.handle({ ...validBody, maxTokens: 9999 }, 'api')
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 2048 }))
  })

  it('authorizes the mcp-host default model when the request omits model', async () => {
    const { handler, authorize } = makeDeps({ defaultModel: 'glm-5.1' })
    await handler.handle(validBody, 'api')
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-5.1' }))
  })

  it('keeps modelPolicyRef authoritative instead of replacing it with the default model', async () => {
    const { handler, authorize } = makeDeps({ defaultModel: 'glm-5.1' })
    await handler.handle({ ...validBody, modelPolicyRef: 'policy-a' }, 'api')
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined, modelPolicyRef: 'policy-a' })
    )
  })

  it('keeps an explicit request model over the mcp-host default model', async () => {
    const { handler, authorize } = makeDeps({ defaultModel: 'glm-5.1' })
    await handler.handle({ ...validBody, model: 'glm-4.7' }, 'api')
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-4.7' }))
  })

  it('propagates authorization errors without calling the LLM', async () => {
    const authorize = vi
      .fn()
      .mockRejectedValue(new PluginWorkloadError('quota_exceeded', 'limit', false))
    const { handler, complete } = makeDeps({ authorize })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'quota_exceeded',
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('reports provider_unavailable status when the LLM call times out', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new PluginWorkloadError('provider_unavailable', 'timeout', true))
    const { handler, report } = makeDeps({ complete })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    })
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'provider_unavailable')
  })

  it('reports failed status for non-provider errors', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new PluginWorkloadError('payload_too_large', 'response too big'))
    const { handler, report } = makeDeps({ complete })
    await expect(handler.handle(validBody, 'api')).rejects.toMatchObject({
      code: 'payload_too_large',
    })
    expect(report).toHaveBeenCalledWith('inv-1', 'sandbox-recipes', 'r1', 'failed')
  })
})
