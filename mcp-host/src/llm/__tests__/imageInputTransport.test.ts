/**
 * Issue #654 — cross-suite guard for the transport matrix.
 *
 * Uses the REAL provider implementations with their SDK clients intercepted, so
 * every cell the guard labels image-capable is proven by the serializer that
 * actually runs. A cell that says "supported" but drops the part on the wire, or
 * an "unsupported" cell that silently reaches the SDK, fails here.
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../../core/errors'
import type { SystemPromptParts } from '../../core/reasoning/systemPrompt'
import { type ChatMessage, FinishReason } from '../../core/types'
import { ClaudeProvider } from '../claude'
import { type BedrockConverseClient, BedrockConverseDriver } from '../drivers/bedrockConverse'
import { type GeminiGenerateClient, GoogleGenerativeDriver } from '../drivers/googleGenerative'
import type { ImageInputResolver, ImageTransportOperation } from '../imageInput'
import { OpenAIProvider } from '../openai'
import { OpenAICompatibleProvider } from '../openaiCompatible'
import type { ClassifiedError, SingleTurnProvider } from '../types'

const EVIDENCE = {
  source: 'curated' as const,
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}

const allowResolver: ImageInputResolver = () => ({
  capability: { state: 'supported', evidence: EVIDENCE },
})

function parts(): SystemPromptParts {
  return { stable: 'stable', context: 'context', stableHash: 'h1', contextHash: 'h2' }
}

function imageMessage(): ChatMessage {
  return {
    role: 'user',
    content: 'what does this picture show?',
    contentParts: [
      { type: 'text', text: 'what does this picture show?' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    ],
  }
}

const OPENAI_OK = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}
const CLAUDE_OK = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}
const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
}
const BEDROCK_OK = {
  output: { message: { content: [{ text: 'ok' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
}

type Family = 'openai-compatible' | 'claude' | 'vertex' | 'bedrock' | 'codex'

interface Harness {
  provider: SingleTurnProvider
  /** Number of SDK calls that left the process boundary. */
  sdkCalls: () => number
  /** The last wire payload handed to the SDK, or undefined. */
  wire: () => unknown
}

function buildHarness(family: Family): Harness {
  switch (family) {
    case 'openai-compatible': {
      const create = vi.fn(async (_input: unknown) => OPENAI_OK)
      const provider = new OpenAIProvider({ chat: { completions: { create } } } as never, 'gpt-4o')
      return {
        provider,
        sdkCalls: () => create.mock.calls.length,
        wire: () => create.mock.calls[0]?.[0],
      }
    }
    case 'claude': {
      const create = vi.fn(async (_input: unknown) => CLAUDE_OK)
      const provider = new ClaudeProvider({ messages: { create } } as never, 'claude-sonnet-4-6')
      return {
        provider,
        sdkCalls: () => create.mock.calls.length,
        wire: () => create.mock.calls[0]?.[0],
      }
    }
    case 'vertex': {
      const generateContent = vi.fn(async (_input: unknown) => GEMINI_OK)
      const client = { generateContent } as unknown as GeminiGenerateClient
      const provider = new GoogleGenerativeDriver(client, 'gemini-2.5-pro')
      return {
        provider,
        sdkCalls: () => generateContent.mock.calls.length,
        wire: () => generateContent.mock.calls[0]?.[0],
      }
    }
    case 'bedrock': {
      const converse = vi.fn(async (_input: unknown) => BEDROCK_OK)
      const client = { converse } as unknown as BedrockConverseClient
      const provider = new BedrockConverseDriver(client, 'anthropic.claude-sonnet-4-6-v1:0')
      return {
        provider,
        sdkCalls: () => converse.mock.calls.length,
        wire: () => converse.mock.calls[0]?.[0],
      }
    }
    case 'codex': {
      const textOk = {
        content: 'ok',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: FinishReason.Stop,
      }
      let lastMessages: ChatMessage[] | undefined
      const withTools = vi.fn(async (messages: ChatMessage[]) => {
        lastMessages = messages
        return { ...textOk, tool_calls: [] }
      })
      const single = vi.fn(async (messages: ChatMessage[]) => {
        lastMessages = messages
        return textOk
      })
      const provider = {
        completeSingleTurn: single,
        completeSingleTurnWithTools: withTools,
        getProviderType: () => 'codex-subscription' as const,
        classifyError: (err: unknown): ClassifiedError => ({
          code: LlmErrorCode.ApiCallFailed,
          retryable: true,
          message: (err as Error).message,
        }),
      } as unknown as SingleTurnProvider
      return {
        provider,
        sdkCalls: () => single.mock.calls.length + withTools.mock.calls.length,
        wire: () => lastMessages,
      }
    }
  }
}

/** Structural image-presence check per wire family. */
function wireHasImage(family: Family, wire: unknown): boolean {
  const payload = wire as {
    messages?: Array<{ content?: unknown }>
    contents?: Array<{ parts?: Array<{ inlineData?: unknown }> }>
  }
  switch (family) {
    case 'openai-compatible':
      return Boolean(
        payload.messages?.some(
          m =>
            Array.isArray(m.content) &&
            (m.content as Array<{ type?: string }>).some(p => p.type === 'image_url')
        )
      )
    case 'claude':
      return Boolean(
        payload.messages?.some(
          m =>
            Array.isArray(m.content) &&
            (m.content as Array<{ type?: string }>).some(p => p.type === 'image')
        )
      )
    case 'vertex':
      return Boolean(payload.contents?.some(c => c.parts?.some(p => p.inlineData !== undefined)))
    case 'bedrock':
      return Boolean(
        payload.messages?.some(
          m =>
            Array.isArray(m.content) &&
            (m.content as Array<Record<string, unknown>>).some(b => 'image' in b)
        )
      )
    case 'codex':
      return Boolean(
        Array.isArray(wire) &&
        wire.some((message: ChatMessage) =>
          message.contentParts?.some(part => part.type === 'image')
        )
      )
  }
}

/** Representative REGISTERED provider id for each family (never a family name). */
function providerIdFor(family: Family): string {
  switch (family) {
    case 'openai-compatible':
      return 'openai'
    case 'claude':
      return 'claude'
    case 'vertex':
      return 'vertex'
    case 'bedrock':
      return 'bedrock'
    case 'codex':
      return 'codex-subscription'
  }
}

function modelFor(family: Family): string {
  switch (family) {
    case 'openai-compatible':
      return 'gpt-4o'
    case 'claude':
      return 'claude-sonnet-4-6'
    case 'vertex':
      return 'gemini-2.5-pro'
    case 'bedrock':
      return 'anthropic.claude-sonnet-4-6-v1:0'
    case 'codex':
      return 'gpt-5.3-codex'
  }
}

function adapterFor(harness: Harness, family: Family): LlmPortAdapter {
  return new LlmPortAdapter(
    harness.provider,
    modelFor(family),
    providerIdFor(family),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    allowResolver
  )
}

/** Dispatch the operation the way the real call sites do. */
async function dispatch(
  adapter: LlmPortAdapter,
  operation: ImageTransportOperation,
  messages: ChatMessage[]
): Promise<void> {
  switch (operation) {
    case 'complete':
      await adapter.complete({ messages })
      return
    case 'completeWithTools':
      await adapter.completeWithTools({ messages, tools: [] })
      return
    case 'completeAndCache':
      await adapter.complete({ messages, systemPromptParts: parts() })
      return
    case 'completeWithToolsAndCache':
      await adapter.completeWithTools({ messages, tools: [], systemPromptParts: parts() })
  }
}

/** Cells each family can really reach through the adapter. */
const REACHABLE: Record<Family, ImageTransportOperation[]> = {
  'openai-compatible': ['complete', 'completeWithTools'],
  claude: ['complete', 'completeWithTools', 'completeAndCache', 'completeWithToolsAndCache'],
  vertex: ['complete', 'completeWithTools'],
  bedrock: ['complete', 'completeWithTools'],
  codex: ['complete', 'completeWithTools'],
}

/** Expected outcome, restated from plan §4.1 (not imported from the module). */
function expectedSupported(family: Family, operation: ImageTransportOperation): boolean {
  if (family === 'codex') return operation === 'complete' || operation === 'completeWithTools'
  if (operation === 'complete') return family === 'vertex' || family === 'bedrock'
  if (operation === 'completeWithTools') return true
  return family === 'claude'
}

const FAMILIES: Family[] = ['openai-compatible', 'claude', 'vertex', 'bedrock', 'codex']

describe('#654 transport cross-suite (real serializers)', () => {
  for (const family of FAMILIES) {
    for (const operation of REACHABLE[family]) {
      const supported = expectedSupported(family, operation)
      it(`${family}/${operation} → ${supported ? 'keeps the image on the wire' : 'never reaches the SDK'}`, async () => {
        const harness = buildHarness(family)
        const adapter = adapterFor(harness, family)

        if (supported) {
          await dispatch(adapter, operation, [imageMessage()])
          expect(harness.sdkCalls()).toBe(1)
          expect(wireHasImage(family, harness.wire())).toBe(true)
        } else {
          await expect(dispatch(adapter, operation, [imageMessage()])).rejects.toBeInstanceOf(
            LlmError
          )
          expect(harness.sdkCalls()).toBe(0)
        }
      })
    }
  }

  it('text-only traffic is dispatched unchanged on every family', async () => {
    for (const family of FAMILIES) {
      const harness = buildHarness(family)
      const adapter = adapterFor(harness, family)
      await adapter.completeWithTools({ messages: [{ role: 'user', content: 'hi' }], tools: [] })
      expect(harness.sdkCalls()).toBe(1)
    }
  })

  it('counterfactual: the tool-less path really drops the part (so the cell is not a guess)', async () => {
    // OpenAI: completeSingleTurn rebuilds role/content and loses contentParts.
    const openaiHarness = buildHarness('openai-compatible')
    await openaiHarness.provider.completeSingleTurn([imageMessage()])
    expect(openaiHarness.sdkCalls()).toBe(1)
    expect(wireHasImage('openai-compatible', openaiHarness.wire())).toBe(false)

    // Claude: the tool-less variant does the same.
    const claudeHarness = buildHarness('claude')
    await claudeHarness.provider.completeSingleTurn([imageMessage()])
    expect(claudeHarness.sdkCalls()).toBe(1)
    expect(wireHasImage('claude', claudeHarness.wire())).toBe(false)
  })

  it('counterfactual: the tool-bearing paths really preserve the part', async () => {
    for (const family of ['openai-compatible', 'claude', 'vertex', 'bedrock'] as Family[]) {
      const harness = buildHarness(family)
      await harness.provider.completeSingleTurnWithTools([imageMessage()], [])
      expect(harness.sdkCalls()).toBe(1)
      expect(wireHasImage(family, harness.wire())).toBe(true)
    }
  })

  it('names the pair that would have been called in the refusal', async () => {
    const harness = buildHarness('openai-compatible')
    const adapter = adapterFor(harness, 'openai-compatible')
    await expect(adapter.complete({ messages: [imageMessage()] })).rejects.toMatchObject({
      code: LlmErrorCode.ImageInputUnsupported,
      retryable: false,
      provider: 'openai',
    })
  })

  it('does not leak image bytes or base64 into the refusal message', async () => {
    const harness = buildHarness('openai-compatible')
    const adapter = new LlmPortAdapter(
      harness.provider,
      'glm-5.3',
      'zai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        capability: { state: 'unsupported', evidence: EVIDENCE },
      })
    )
    let error: LlmError | undefined
    try {
      await adapter.completeWithTools({ messages: [imageMessage()], tools: [] })
    } catch (err) {
      error = err as LlmError
    }
    expect(error).toBeInstanceOf(LlmError)
    expect(error!.message).not.toContain('QUJD')
    expect(error!.message).not.toContain('base64')
  })

  it('the data-driven compatible arm shares the proven serializer (real subclass, stub transport)', async () => {
    // `OpenAICompatibleProvider` builds its own SDK client, so the client field is
    // swapped for a stub AFTER construction: the class, its provider id and every
    // serializer it runs are the production ones.
    const provider = new OpenAICompatibleProvider(
      { id: 'zai', baseURL: 'https://api.z.ai/api/coding/paas/v4', defaultModel: 'glm-5.3-flash' },
      'fake-key',
      'glm-5.3-flash'
    )
    const create = vi.fn(async (_input: unknown) => OPENAI_OK)
    ;(provider as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    }
    const adapter = new LlmPortAdapter(
      provider,
      'glm-5.3-flash',
      'zai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allowResolver
    )

    await adapter.completeWithTools({ messages: [imageMessage()], tools: [] })
    expect(create).toHaveBeenCalledTimes(1)
    expect(wireHasImage('openai-compatible', create.mock.calls[0]?.[0])).toBe(true)

    // The tool-less path is still refused, so Flash cannot be attached for a
    // `complete` call by accident.
    await expect(adapter.complete({ messages: [imageMessage()] })).rejects.toBeInstanceOf(LlmError)
  })
})
