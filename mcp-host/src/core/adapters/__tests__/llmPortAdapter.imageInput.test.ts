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
import { logger } from '../../../logger'
import { LlmError, LlmErrorCode } from '../../errors'
import { appendToolResults } from '../../orchestration/toolUseLoopMessages'
import type { SystemPromptParts } from '../../reasoning/systemPrompt'
import {
  type ChatMessage,
  FinishReason,
  type MessageContentPart,
  type ToolResult,
} from '../../types'
import { LlmPortAdapter } from '../llmPortAdapter'

const CURATED_EVIDENCE = {
  source: 'curated' as const,
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}

function allow(capability: unknown): ImageInputResolver {
  return () => ({ capability })
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

  it('withholds tool screenshots from an unverified model and still dispatches the text turn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
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
        allow(undefined)
      )
      const request = {
        messages: [
          textMessage(),
          { role: 'tool' as const, content: 'captured', tool_call_id: 'tc_1', name: 'shot' },
          {
            role: 'user' as const,
            content: 'Here are the screenshots from the tool results above.',
            imageOrigin: 'tool_result' as const,
            contentParts: [
              {
                type: 'text' as const,
                text: 'Here are the screenshots from the tool results above.',
              },
              { type: 'image' as const, mimeType: 'image/png' as const, data: 'QUJD' },
            ],
          },
        ],
        tools: [],
      }

      await adapter.completeWithTools(request)

      // Witness: the turn was dispatched. An unverified model must not turn a
      // screenshot tool call into a task failure.
      expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
      const [messages] = provider.completeSingleTurnWithTools.mock.calls[0]
      expect(messages[2].contentParts).toBeUndefined()
      expect(messages[2].imageOrigin).toBeUndefined()
      expect(messages[2].content).toContain('were not forwarded')
      expect(messages[2].content).toContain('Here are the screenshots from the tool results above.')
      // The text-only messages are passed through by identity.
      expect(messages[0]).toBe(request.messages[0])
      expect(messages[1]).toBe(request.messages[1])
      // Immutability witness: a later failover attempt on a supported pair must
      // still see the image, so the caller's array is never rewritten in place.
      expect(request.messages[2].contentParts).toHaveLength(2)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ withheldImages: 1, reason: 'model_unknown' }),
        'tool screenshots withheld: model has no affirmative image-input evidence'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps refusing a user-attached image on an unverified model even when tool screenshots are present', async () => {
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
      allow(undefined)
    )

    await expectDenied(
      () =>
        adapter.completeWithTools({
          messages: [
            imageMessage(),
            {
              role: 'user',
              content: 'Here are the screenshots from the tool results above.',
              imageOrigin: 'tool_result',
              contentParts: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }],
            },
          ],
          tools: [],
        }),
      LlmErrorCode.ImageInputUnknown,
      'not verified'
    )

    // Witness: the refusal is the typed terminal error above, raised before the
    // SDK call. One tool-originated message never licenses a user attachment.
    expect(provider.completeSingleTurnWithTools).not.toHaveBeenCalled()
    expect(provider.classifyError).not.toHaveBeenCalled()
  })
})

describe('#669 LlmPortAdapter malformed tool screenshots', () => {
  const LINE_WRAPPED = 'QUJD\nRUZH'
  const DATA_URL = 'data:image/png;base64,QUJD'
  const NOTICE_SUFFIX =
    'screenshot(s) returned by tool results were not forwarded: invalid image encoding]'

  function screenshotResult(id: string, data: string): ToolResult {
    return {
      tool_call_id: `tc_${id}`,
      name: 'take_screenshot',
      content: `captured ${id}`,
      is_error: false,
      attachments: [
        {
          id: `shot-${id}`,
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: data,
        },
      ],
    }
  }

  /** Builds the turn exactly as the tool-use loop does, via `appendToolResults`. */
  function toolTurn(images: string[]): ChatMessage[] {
    const messages: ChatMessage[] = [textMessage()]
    appendToolResults(
      messages,
      images.map((data, index) => screenshotResult(String(index), data)),
      []
    )
    return messages
  }

  function adapterFor(
    provider: ReturnType<typeof fakeProvider>,
    resolver: ImageInputResolver
  ): LlmPortAdapter {
    return new LlmPortAdapter(
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
  }

  function imageParts(messages: ChatMessage[]): MessageContentPart[] {
    return messages.flatMap(message =>
      (message.contentParts ?? []).filter(part => part.type === 'image')
    )
  }

  it('dispatches a turn with malformed tool screenshots on a model with no image evidence', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const provider = fakeProvider('openai')
      const adapter = adapterFor(provider, allow(undefined))
      const messages = toolTurn([LINE_WRAPPED, DATA_URL])
      // Precondition: the real builder forwards the malformed data unnormalized.
      expect(imageParts(messages)).toHaveLength(2)

      await adapter.completeWithTools({ messages, tools: [] })

      // Liveness witness: the turn reached the provider exactly once.
      expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
      const [dispatched] = provider.completeSingleTurnWithTools.mock.calls[0] as [ChatMessage[]]
      expect(imageParts(dispatched)).toHaveLength(0)
      const carrier = dispatched[dispatched.length - 1]
      expect(carrier.contentParts).toBeUndefined()
      expect(carrier.imageOrigin).toBeUndefined()
      expect(carrier.content).toContain(`[2 ${NOTICE_SUFFIX}`)
      expect(JSON.stringify(dispatched)).not.toContain('RUZH')
      expect(JSON.stringify(dispatched)).not.toContain('data:image/png')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          component: 'LlmPortAdapter',
          method: 'completeWithTools',
          count: 2,
        }),
        'tool screenshots removed before provider dispatch: invalid image encoding'
      )
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('RUZH')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('drops malformed tool screenshots but forwards a canonical one on an image-capable model', async () => {
    const provider = fakeProvider('openai')
    const adapter = adapterFor(provider, allow({ state: 'supported', evidence: CURATED_EVIDENCE }))
    const messages = toolTurn([LINE_WRAPPED, 'QUJD', DATA_URL])

    await adapter.completeWithTools({ messages, tools: [] })

    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    const [dispatched] = provider.completeSingleTurnWithTools.mock.calls[0] as [ChatMessage[]]
    expect(imageParts(dispatched)).toEqual([{ type: 'image', mimeType: 'image/png', data: 'QUJD' }])
    const carrier = dispatched[dispatched.length - 1]
    expect(carrier.imageOrigin).toBe('tool_result')
    expect(carrier.content).toContain(`[2 ${NOTICE_SUFFIX}`)
    // Providers render `contentParts` instead of `content` when parts are
    // present, so the notice must also travel as a text part.
    expect(carrier.contentParts?.at(-1)).toEqual({
      type: 'text',
      text: `[2 ${NOTICE_SUFFIX}`,
    })
    expect(JSON.stringify(dispatched)).not.toContain('RUZH')
    expect(JSON.stringify(dispatched)).not.toContain('data:image/png')
  })

  it('still refuses a malformed USER image with LLM_INVALID_ATTACHMENT', async () => {
    const provider = fakeProvider('openai')
    const adapter = adapterFor(provider, allow({ state: 'supported', evidence: CURATED_EVIDENCE }))
    const messages: ChatMessage[] = [
      ...toolTurn([DATA_URL]),
      {
        role: 'user',
        content: 'look',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: LINE_WRAPPED }],
      },
    ]

    await expectDenied(
      () => adapter.completeWithTools({ messages, tools: [] }),
      LlmErrorCode.InvalidAttachment,
      'unsupported image format or encoding'
    )
    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(0)
    expect(provider.classifyError).not.toHaveBeenCalled()
  })

  it('leaves the caller messages untouched so a failover attempt sees the original', async () => {
    const provider = fakeProvider('openai')
    const adapter = adapterFor(provider, allow(undefined))
    const messages = toolTurn([LINE_WRAPPED, 'QUJD'])
    const snapshot = structuredClone(messages)
    const references = [...messages]

    await adapter.completeWithTools({ messages, tools: [] })

    expect(provider.completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    const [dispatched] = provider.completeSingleTurnWithTools.mock.calls[0] as [ChatMessage[]]
    expect(dispatched).not.toBe(messages)
    expect(messages).toEqual(snapshot)
    expect(messages).toHaveLength(references.length)
    messages.forEach((message, index) => expect(message).toBe(references[index]))
    expect(imageParts(messages).map(part => part.type === 'image' && part.data)).toEqual([
      LINE_WRAPPED,
      'QUJD',
    ])
  })
})
