/**
 * Issue #654 — the image guard on the physical attempt boundary.
 *
 * Proves, per attempt: text-only requests never touch the resolver; an
 * image-bearing request is refused BEFORE the provider SDK is called when the
 * intersection is not affirmative; and a refusal is never handed to
 * `provider.classifyError` (which is what would make it retryable).
 */
import { describe, expect, it, vi } from 'vitest'
import type { ImageInputResolver } from '../../../llm/imageInput'
import type { ClassifiedError, SingleTurnProvider } from '../../../llm/types'
import { LlmError, LlmErrorCode } from '../../errors'
import type { SystemPromptParts } from '../../reasoning/systemPrompt'
import { type ChatMessage, FinishReason } from '../../types'
import { LlmPortAdapter } from '../llmPortAdapter'

const CURATED_EVIDENCE = {
  source: 'curated' as const,
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}

function allow(capability: unknown): ImageInputResolver {
  return () => ({ capability, policyAllowed: true })
}

function imageMessage(role: ChatMessage['role'] = 'user'): ChatMessage {
  return {
    role,
    content: 'look',
    contentParts: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }],
  }
}

function textMessage(): ChatMessage {
  return { role: 'user', content: 'hello' }
}

function parts(): SystemPromptParts {
  return { stable: 'stable', context: 'context', stableHash: 'h1', contextHash: 'h2' }
}

function fakeProvider(
  providerType: string,
  opts: { cache?: boolean; cacheTools?: boolean } = {}
): SingleTurnProvider & {
  completeSingleTurn: ReturnType<typeof vi.fn>
  completeSingleTurnWithTools: ReturnType<typeof vi.fn>
  completeSingleTurnAndCache?: ReturnType<typeof vi.fn>
  completeSingleTurnWithToolsAndCache?: ReturnType<typeof vi.fn>
  classifyError: ReturnType<typeof vi.fn>
} {
  const ok = {
    content: 'ok',
    tool_calls: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    finish_reason: FinishReason.Stop,
  }
  const provider = {
    completeSingleTurn: vi.fn(async () => ok),
    completeSingleTurnWithTools: vi.fn(async () => ok),
    getProviderType: () => providerType,
    classifyError: vi.fn(
      (err: unknown): ClassifiedError => ({
        code: LlmErrorCode.ApiCallFailed,
        retryable: true,
        message: (err as Error).message,
      })
    ),
  } as unknown as SingleTurnProvider & Record<string, unknown>
  if (opts.cache) provider.completeSingleTurnAndCache = vi.fn(async () => ok)
  if (opts.cacheTools) provider.completeSingleTurnWithToolsAndCache = vi.fn(async () => ok)
  return provider as never
}

async function expectDenied(
  run: () => Promise<unknown>,
  code: LlmErrorCode,
  reason: string
): Promise<LlmError> {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError)
    const llmError = err as LlmError
    expect(llmError.code).toBe(code)
    expect(llmError.retryable).toBe(false)
    expect(llmError.message).toContain(reason)
    return llmError
  }
  throw new Error('expected the guard to reject this attempt')
}

describe('#654 LlmPortAdapter image guard', () => {
  it('never consults the resolver for a text-only request', async () => {
    const provider = fakeProvider('openai')
    const resolver = vi.fn<ImageInputResolver>(() => undefined)
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver
    )

    await adapter.complete({ messages: [textMessage()] })
    await adapter.completeWithTools({ messages: [textMessage()], tools: [] })

    expect(resolver).not.toHaveBeenCalled()
    expect(provider.completeSingleTurn).toHaveBeenCalledTimes(1)
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
  })

  it('fails closed with LLM_IMAGE_INPUT_UNKNOWN when no catalog resolver is wired', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(provider, 'gpt-5.4-mini', 'openai')

    await expectDenied(
      () => adapter.completeWithTools({ messages: [imageMessage()], tools: [] }),
      LlmErrorCode.ImageInputUnknown,
      'not verified'
    )

    // The refusal happens BEFORE the SDK call and is NOT reclassified by the
    // provider (which would flip it to retryable=true and re-open retries).
    expect(provider.completeSingleTurnWithTools).not.toHaveBeenCalled()
    expect(provider.classifyError).not.toHaveBeenCalled()
  })

  it('dispatches a supported tool-bearing request and keeps the image part', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'supported', evidence: CURATED_EVIDENCE })
    )

    await adapter.completeWithTools({ messages: [imageMessage()], tools: [] })

    const [messages] = provider.completeSingleTurnWithTools.mock.calls[0]
    expect(messages[0].contentParts).toHaveLength(1)
    expect(messages[0].contentParts[0].type).toBe('image')
  })

  it('refuses the tool-less plain path that would drop the image (OpenAI family)', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'supported', evidence: CURATED_EVIDENCE })
    )

    await expectDenied(
      () => adapter.complete({ messages: [imageMessage()] }),
      LlmErrorCode.ImageInputUnsupported,
      'cannot carry images'
    )
    expect(provider.completeSingleTurn).not.toHaveBeenCalled()
  })

  it('refuses an image on a role the family cannot carry', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'supported', evidence: CURATED_EVIDENCE })
    )

    await expectDenied(
      () => adapter.completeWithTools({ messages: [imageMessage('tool')], tools: [] }),
      LlmErrorCode.ImageInputUnsupported,
      'cannot carry images'
    )
  })

  it('allows the cache-aware path where the serializer preserves images (Claude)', async () => {
    const provider = fakeProvider('claude', { cache: true, cacheTools: true })
    const resolver = vi.fn(allow({ state: 'supported', evidence: CURATED_EVIDENCE }))
    const adapter = new LlmPortAdapter(
      provider,
      'claude-sonnet-4-6',
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver
    )

    await adapter.complete({ messages: [imageMessage()], systemPromptParts: parts() })
    await adapter.completeWithTools({
      messages: [imageMessage()],
      tools: [],
      systemPromptParts: parts(),
    })

    expect(provider.completeSingleTurnAndCache).toHaveBeenCalledTimes(1)
    expect(provider.completeSingleTurnWithToolsAndCache).toHaveBeenCalledTimes(1)
    // The resolver is asked about the pair this adapter really sends.
    expect(resolver).toHaveBeenCalledWith('claude', 'claude-sonnet-4-6')
  })

  it('refuses Claude plain too: that variant rebuilds role/content', async () => {
    const provider = fakeProvider('claude', { cache: true, cacheTools: true })
    const adapter = new LlmPortAdapter(
      provider,
      'claude-sonnet-4-6',
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'supported', evidence: CURATED_EVIDENCE })
    )

    await expectDenied(
      () => adapter.complete({ messages: [imageMessage()] }),
      LlmErrorCode.ImageInputUnsupported,
      'cannot carry images'
    )
    expect(provider.completeSingleTurn).not.toHaveBeenCalled()
  })

  it('reports model_unsupported for a known text-only model', async () => {
    const provider = fakeProvider('zai')
    const adapter = new LlmPortAdapter(
      provider,
      'glm-5.3',
      'zai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'unsupported', evidence: CURATED_EVIDENCE })
    )

    await expectDenied(
      () => adapter.completeWithTools({ messages: [imageMessage()], tools: [] }),
      LlmErrorCode.ImageInputUnsupported,
      'not supported by zai/glm-5.3'
    )
    expect(provider.classifyError).not.toHaveBeenCalled()
  })

  it('treats a pair missing from the catalog as unknown (never as allow)', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => undefined
    )

    await expectDenied(
      () => adapter.completeWithTools({ messages: [imageMessage()], tools: [] }),
      LlmErrorCode.ImageInputUnknown,
      'not verified'
    )
  })

  it('degrades to unknown when the catalog resolver throws, without failing text', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('catalog unavailable')
      }
    )

    await expectDenied(
      () => adapter.completeWithTools({ messages: [imageMessage()], tools: [] }),
      LlmErrorCode.ImageInputUnknown,
      'not verified'
    )
    // A text-only turn on the same adapter is unaffected by the broken catalog.
    await adapter.completeWithTools({ messages: [textMessage()], tools: [] })
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
  })

  it('refuses Codex transport until #650 lands, even with curated evidence', async () => {
    const provider = fakeProvider('codex-subscription')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.3-codex',
      'codex-subscription',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'supported', evidence: CURATED_EVIDENCE })
    )

    await expectDenied(
      () => adapter.completeWithTools({ messages: [imageMessage()], tools: [] }),
      LlmErrorCode.ImageInputUnsupported,
      'cannot carry images'
    )
    expect(provider.completeSingleTurnWithTools).not.toHaveBeenCalled()
  })

  it('refuses a malformed base64 image part with LLM_INVALID_ATTACHMENT before consulting the resolver', async () => {
    const provider = fakeProvider('openai')
    const resolver = vi.fn(allow({ state: 'supported', evidence: CURATED_EVIDENCE }))
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver
    )

    await expectDenied(
      () =>
        adapter.completeWithTools({
          messages: [
            {
              role: 'user',
              content: 'look',
              contentParts: [{ type: 'image', mimeType: 'image/png', data: 'not base64!' }],
            },
          ],
          tools: [],
        }),
      LlmErrorCode.InvalidAttachment,
      'unsupported image format or encoding'
    )
    // The shape check is the first gate: neither the catalog nor the SDK is
    // reached, so a malformed part can never become a provider round-trip.
    expect(resolver).toHaveBeenCalledTimes(0)
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(0)
  })

  it('refuses a non PNG/JPEG mime with LLM_INVALID_ATTACHMENT', async () => {
    const provider = fakeProvider('openai')
    const resolver = vi.fn(allow({ state: 'supported', evidence: CURATED_EVIDENCE }))
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver
    )

    await expectDenied(
      () =>
        adapter.completeWithTools({
          messages: [
            {
              role: 'user',
              content: 'look',
              contentParts: [{ type: 'image', mimeType: 'image/gif' as never, data: 'QUJD' }],
            },
          ],
          tools: [],
        }),
      LlmErrorCode.InvalidAttachment,
      'unsupported image format or encoding'
    )
    expect(resolver).toHaveBeenCalledTimes(0)
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(0)
  })

  it('dispatches a 5 MiB canonical image part without RangeError', async () => {
    const provider = fakeProvider('openai')
    const adapter = new LlmPortAdapter(
      provider,
      'gpt-5.4-mini',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      allow({ state: 'supported', evidence: CURATED_EVIDENCE })
    )
    // Tool screenshots are not bounded by the admission limit, so the adapter
    // sees sizes the grouped-quantifier regex could not scan.
    const data = Buffer.alloc(5 * 1024 * 1024).toString('base64')
    expect(data.length).toBeGreaterThan(4_470_000)

    await adapter.completeWithTools({
      messages: [
        {
          role: 'user',
          content: 'look',
          contentParts: [{ type: 'image', mimeType: 'image/png', data }],
        },
      ],
      tools: [],
    })

    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    const [messages] = provider.completeSingleTurnWithTools.mock.calls[0]
    expect(messages[0].contentParts[0].data).toBe(data)
  })
})
