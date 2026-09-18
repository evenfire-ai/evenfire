/**
 * #650 — image source identity compatibility across the LlmPort boundary.
 *
 * `appendToolResults` keeps one visual part per producing tool call (each with
 * its own `source`) and marks the parts that only exist to retain a source
 * identity with `sourceIdentityOnly: true`. The marker is an internal loop
 * detail: `LlmPortAdapter` must translate it per provider, so a transport that
 * binds each image source sees every identity while a legacy field-by-field
 * transport keeps the historical content-deduplicated view.
 *
 * These tests drive the REAL `appendToolResults` and the REAL `LlmPortAdapter`
 * with injected provider stand-ins (no network, no SDK client).
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  CodexCompletionRequest,
  CodexMessagePartImageV2,
} from '@clerum/llm-provider-attempt-contract'
import type { SingleTurnProvider } from '../../../llm'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from '../../../llm/__tests__/codexImageFixtures'
import {
  type CodexSubscriptionDeps,
  CodexSubscriptionProvider,
} from '../../../llm/codexSubscription'
import { FailoverEngine } from '../../../llm/failover/engine'
import type { LlmPolicy } from '../../../llm/failover/types'
import { CodexAuthorizeError } from '../../../llm/providerAttemptAuthorizer'
import { LlmErrorCode } from '../../errors'
import { stripHistoricalMedia } from '../../extensions/prePrune'
import { appendToolResults } from '../../orchestration/toolUseLoopMessages'
import type { SystemPromptParts } from '../../reasoning/systemPrompt'
import {
  type Attachment,
  type ChatMessage,
  type CompletionRequest,
  FinishReason,
  type MessageContentPart,
  type ToolDefinition,
  type ToolResult,
  prependTextToParts,
} from '../../types'
import { maybeWrapFailover } from '../failoverLlmPort'
import { LlmPortAdapter } from '../llmPortAdapter'

const SYSTEM_PARTS: SystemPromptParts = {
  stable: 'stable tier',
  context: 'context tier',
  stableHash: 'stable-tier-hash',
  contextHash: 'context-tier-hash',
}

const TOOLS: ToolDefinition[] = [
  { name: 'desktop_screenshot', description: 'Capture the desktop', parameters: {} },
]

const EXPLANATORY_TEXT = 'Here are the screenshots from the tool results above.'

const imageAttachment = (
  id: string,
  data = PNG_2X2_BASE64,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png'
): Attachment => ({
  id,
  kind: 'image',
  mimeType,
  encoding: 'base64',
  dataBase64: data,
})

const frameResult = (toolCallId: string, attachment: Attachment): ToolResult => ({
  tool_call_id: toolCallId,
  name: 'desktop_screenshot',
  content: `${toolCallId} frame`,
  is_error: false,
  attachments: [attachment],
})

const screenshotResult = (toolCallId: string, attachmentId: string): ToolResult =>
  frameResult(toolCallId, imageAttachment(attachmentId))

/**
 * Two tool-loop iterations whose screenshots carry identical bytes, built the
 * way a source-binding chain does it: the loop forwards
 * `LoopConfig.imageSourceIdentity` and the caller states it explicitly.
 */
function repeatedFrameMessages(preserveSourceIdentity = true): {
  messages: ChatMessage[]
  collected: Attachment[]
} {
  const messages: ChatMessage[] = []
  const collected: Attachment[] = []
  appendToolResults(
    messages,
    [screenshotResult('tc_first', 'att-first')],
    collected,
    preserveSourceIdentity
  )
  appendToolResults(
    messages,
    [screenshotResult('tc_second', 'att-second')],
    collected,
    preserveSourceIdentity
  )
  return { messages, collected }
}

type ImagePart = Extract<MessageContentPart, { type: 'image' }>

function imagePartsOf(messages: ChatMessage[]): ImagePart[] {
  return messages
    .flatMap(message => message.contentParts ?? [])
    .filter((part): part is ImagePart => part.type === 'image')
}

function imageMessagesOf(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    message =>
      message.role === 'user' && (message.contentParts ?? []).some(part => part.type === 'image')
  )
}

function explanatoryTextCount(messages: ChatMessage[]): number {
  return messages
    .flatMap(message => message.contentParts ?? [])
    .filter(part => part.type === 'text' && part.text === EXPLANATORY_TEXT).length
}

type ProviderCall = { parts?: SystemPromptParts; messages: ChatMessage[] }

/**
 * Stand-in for a `SingleTurnProvider`. `cache: true` adds the optional
 * cache-aware methods so the adapter routes to them; `imageSourceIdentity`
 * models a transport that binds every image source (Codex V2).
 */
function recordingProvider(options: { cache: boolean; imageSourceIdentity?: boolean }) {
  const complete: ProviderCall[] = []
  const completeWithTools: ProviderCall[] = []
  const base = {
    getProviderType: () => 'openai' as const,
    classifyError: () => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: 'mock',
    }),
    ...(options.imageSourceIdentity ? { requiresImageSourceIdentity: true as const } : {}),
  }

  const stopResponse = () => ({
    content: 'ok',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    finish_reason: FinishReason.Stop,
  })
  const toolResponse = () => ({
    content: null,
    tool_calls: null,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    finish_reason: FinishReason.Stop,
  })

  const provider: SingleTurnProvider = options.cache
    ? {
        ...base,
        completeSingleTurn: async messages => {
          complete.push({ messages })
          return stopResponse()
        },
        completeSingleTurnWithTools: async messages => {
          completeWithTools.push({ messages })
          return toolResponse()
        },
        completeSingleTurnAndCache: async (parts, messages) => {
          complete.push({ parts, messages })
          return stopResponse()
        },
        completeSingleTurnWithToolsAndCache: async (parts, messages) => {
          completeWithTools.push({ parts, messages })
          return toolResponse()
        },
      }
    : {
        ...base,
        completeSingleTurn: async messages => {
          complete.push({ messages })
          return stopResponse()
        },
        completeSingleTurnWithTools: async messages => {
          completeWithTools.push({ messages })
          return toolResponse()
        },
      }

  return { provider, complete, completeWithTools }
}

type DispatchVariant = { label: string; tools: boolean; cache: boolean }

const DISPATCH_VARIANTS: DispatchVariant[] = [
  { label: 'complete via the cache-aware path', tools: false, cache: true },
  { label: 'complete via the concat fallback', tools: false, cache: false },
  { label: 'completeWithTools via the cache-aware path', tools: true, cache: true },
  { label: 'completeWithTools via the concat fallback', tools: true, cache: false },
]

async function runVariant(
  variant: DispatchVariant,
  imageSourceIdentity: boolean,
  messages: ChatMessage[]
): Promise<ProviderCall> {
  const { provider, complete, completeWithTools } = recordingProvider({
    cache: variant.cache,
    imageSourceIdentity,
  })
  const adapter = new LlmPortAdapter(provider, 'gpt-4o', 'openai')

  if (variant.tools) {
    await adapter.completeWithTools({ messages, tools: TOOLS, systemPromptParts: SYSTEM_PARTS })
    expect(complete).toHaveLength(0)
    expect(completeWithTools).toHaveLength(1)
    return completeWithTools[0]
  }

  await adapter.complete({ messages, systemPromptParts: SYSTEM_PARTS })
  expect(completeWithTools).toHaveLength(0)
  expect(complete).toHaveLength(1)
  return complete[0]
}

/** The message view the provider actually received, past the concat system part. */
function providerView(call: ProviderCall, cache: boolean): ChatMessage[] {
  if (cache) return call.messages
  expect(call.messages[0]?.role).toBe('system')
  return call.messages.slice(1)
}

describe('image source identity compatibility (#650)', () => {
  it('marks the frames the legacy collection deduplicates while the loop keeps every source', () => {
    const { messages, collected } = repeatedFrameMessages()

    // The user-facing attachment list keeps its cross-iteration dedup contract.
    expect(collected).toHaveLength(1)

    const images = imagePartsOf(messages)
    expect(images.map(image => image.source)).toEqual([
      { kind: 'tool', attachmentId: 'att-first', toolCallId: 'tc_first' },
      { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
    ])
    expect(images[0].sourceIdentityOnly).toBeUndefined()
    expect(images[1].sourceIdentityOnly).toBe(true)

    const visualMessages = imageMessagesOf(messages)
    expect(visualMessages).toHaveLength(2)
    // The first frame was legacy-retained, so neither its image nor its
    // explanatory text carries the marker.
    expect(visualMessages[0].contentParts?.some(part => part.sourceIdentityOnly)).toBe(false)
    // The second message exists only for the repeated identity: image AND text.
    expect(visualMessages[1].contentParts).toEqual([
      { type: 'text', text: EXPLANATORY_TEXT, sourceIdentityOnly: true },
      expect.objectContaining({ type: 'image', sourceIdentityOnly: true }),
    ])
  })

  it.each(DISPATCH_VARIANTS)(
    'drops identity-only parts for a provider without the trait on $label',
    async variant => {
      const { messages } = repeatedFrameMessages()
      const call = await runVariant(variant, false, messages)
      const view = providerView(call, variant.cache)

      // Historical view: exactly the frame the legacy collection retained.
      expect(imagePartsOf(view)).toEqual([
        expect.objectContaining({
          source: { kind: 'tool', attachmentId: 'att-first', toolCallId: 'tc_first' },
        }),
      ])
      expect(imagePartsOf(view)[0].sourceIdentityOnly).toBeUndefined()
      expect(imageMessagesOf(view)).toHaveLength(1)
      expect(explanatoryTextCount(view)).toBe(1)

      // The second tool call itself survives; only its extra image message goes.
      expect(
        view.filter(message => message.role === 'tool').map(message => message.tool_call_id)
      ).toEqual(['tc_first', 'tc_second'])
    }
  )

  it.each(DISPATCH_VARIANTS)(
    'delivers every source identity to a provider with the trait on $label',
    async variant => {
      const { messages } = repeatedFrameMessages()
      const call = await runVariant(variant, true, messages)
      const view = providerView(call, variant.cache)

      expect(imagePartsOf(view)).toEqual(imagePartsOf(messages))
      expect(imageMessagesOf(view)).toHaveLength(2)
      expect(explanatoryTextCount(view)).toBe(2)
    }
  )

  it('keeps the retained frame and its text when only one part of a message is identity-only', async () => {
    const messages: ChatMessage[] = []
    const collected: Attachment[] = []
    // Same bytes, two attachment identities inside ONE tool-result batch.
    // A source-binding chain states the flag explicitly.
    appendToolResults(
      messages,
      [screenshotResult('tc_one', 'att-a'), screenshotResult('tc_two', 'att-b')],
      collected,
      true
    )

    expect(collected.map(attachment => attachment.id)).toEqual(['att-a'])
    const visual = imageMessagesOf(messages)
    expect(visual).toHaveLength(1)
    expect(visual[0].content).toBe(EXPLANATORY_TEXT)
    expect(visual[0].contentParts?.map(part => part.sourceIdentityOnly)).toEqual([
      undefined,
      undefined,
      true,
    ])
    expect(visual[0].contentParts?.[1]).not.toHaveProperty('sourceIdentityOnly')

    const { provider, complete } = recordingProvider({ cache: true })
    await new LlmPortAdapter(provider, 'gpt-4o', 'openai').complete({
      messages,
      systemPromptParts: SYSTEM_PARTS,
    })
    const [filtered] = imageMessagesOf(providerView(complete[0], true))

    // Legacy keeps the first identity and the text; the repeated one is dropped.
    expect(filtered.content).toBe(EXPLANATORY_TEXT)
    expect(filtered.contentParts).toEqual([
      { type: 'text', text: EXPLANATORY_TEXT },
      expect.objectContaining({
        type: 'image',
        source: { kind: 'tool', attachmentId: 'att-a', toolCallId: 'tc_one' },
      }),
    ])
    // The text is present exactly once (no re-derivation of `content` into parts).
    expect(
      filtered.contentParts?.filter(part => part.type === 'text').map(part => part.text)
    ).toEqual([filtered.content])

    const binding = recordingProvider({ cache: true, imageSourceIdentity: true })
    await new LlmPortAdapter(binding.provider, 'codex-subscription', 'codex-subscription').complete(
      {
        messages,
        systemPromptParts: SYSTEM_PARTS,
      }
    )
    expect(imagePartsOf(binding.complete[0].messages).map(image => image.source)).toEqual([
      { kind: 'tool', attachmentId: 'att-a', toolCallId: 'tc_one' },
      { kind: 'tool', attachmentId: 'att-b', toolCallId: 'tc_two' },
    ])
  })

  it('leaves the canonical request untouched and lets a later adapter see the full view', async () => {
    const { messages } = repeatedFrameMessages()
    const snapshot = structuredClone(messages)
    const request: CompletionRequest = { messages, systemPromptParts: SYSTEM_PARTS }

    const legacy = recordingProvider({ cache: true })
    await new LlmPortAdapter(legacy.provider, 'gpt-4o', 'openai').complete(request)

    // The filtering produced a provider-specific view, not a mutation.
    expect(legacy.complete[0].messages).not.toBe(messages)
    expect(messages).toEqual(snapshot)
    expect(imagePartsOf(legacy.complete[0].messages)).toHaveLength(1)

    const binding = recordingProvider({ cache: true, imageSourceIdentity: true })
    await new LlmPortAdapter(binding.provider, 'codex-subscription', 'codex-subscription').complete(
      request
    )
    expect(imagePartsOf(binding.complete[0].messages)).toEqual(imagePartsOf(snapshot))
  })

  it('applies the same view when the request carries no system prompt parts', async () => {
    const { messages } = repeatedFrameMessages()

    const legacy = recordingProvider({ cache: false })
    await new LlmPortAdapter(legacy.provider, 'gpt-4o', 'openai').complete({ messages })
    expect(imagePartsOf(legacy.complete[0].messages)).toHaveLength(1)

    const legacyTools = recordingProvider({ cache: false })
    await new LlmPortAdapter(legacyTools.provider, 'gpt-4o', 'openai').completeWithTools({
      messages,
      tools: TOOLS,
    })
    expect(imagePartsOf(legacyTools.completeWithTools[0].messages)).toHaveLength(1)
  })

  it('keeps the pure API-key loop on the legacy shape with no markers and no extra message', async () => {
    const messages: ChatMessage[] = []
    const collected: Attachment[] = []
    // No fourth argument: the loop path for a chain with no source-binding member.
    appendToolResults(messages, [screenshotResult('tc_first', 'att-first')], collected)
    appendToolResults(messages, [screenshotResult('tc_second', 'att-second')], collected)

    // The repeated frame adds no message at all, so compaction sees the old shape.
    expect(collected).toHaveLength(1)
    expect(messages.map(message => message.role)).toEqual(['tool', 'user', 'tool'])
    expect(imagePartsOf(messages)).toHaveLength(1)
    expect(imagePartsOf(messages)[0].source).toEqual({
      kind: 'tool',
      attachmentId: 'att-first',
      toolCallId: 'tc_first',
    })
    expect(JSON.stringify(messages)).not.toContain('sourceIdentityOnly')

    const { provider, complete } = recordingProvider({ cache: true })
    await new LlmPortAdapter(provider, 'gpt-4o', 'openai').complete({ messages })

    // Nothing to translate, so the adapter hands the canonical view straight on.
    expect(complete[0].messages).toEqual(messages)
    expect(JSON.stringify(complete[0].messages)).not.toContain('sourceIdentityOnly')
  })

  it.each([false, true])(
    'retains both frames when identical bytes and id carry different filenames (preserveSourceIdentity=%s)',
    preserveSourceIdentity => {
      const messages: ChatMessage[] = []
      const collected: Attachment[] = []
      appendToolResults(
        messages,
        [
          {
            tool_call_id: 'tc_named',
            name: 'desktop_screenshot',
            content: 'two names',
            is_error: false,
            attachments: [
              { ...imageAttachment('att-same'), filename: 'first.png' },
              { ...imageAttachment('att-same'), filename: 'second.png' },
            ],
          },
        ],
        collected,
        preserveSourceIdentity
      )

      // The collection keys on the filename, so neither frame is a duplicate.
      expect(collected.map(attachment => attachment.filename)).toEqual(['first.png', 'second.png'])
      const images = imagePartsOf(messages)
      expect(images).toHaveLength(2)
      expect(images.map(image => image.sourceIdentityOnly)).toEqual([undefined, undefined])
    }
  )

  it.each([false, true])(
    'keeps one frame when the same attachment object repeats inside one result (preserveSourceIdentity=%s)',
    preserveSourceIdentity => {
      const shared = imageAttachment('att-shared')
      const messages: ChatMessage[] = []
      const collected: Attachment[] = []
      appendToolResults(
        messages,
        [
          {
            tool_call_id: 'tc_dup',
            name: 'desktop_screenshot',
            content: 'duplicate frame',
            is_error: false,
            attachments: [shared, shared],
          },
        ],
        collected,
        preserveSourceIdentity
      )

      expect(collected).toHaveLength(1)
      const images = imagePartsOf(messages)
      expect(images).toHaveLength(1)
      expect(images[0].sourceIdentityOnly).toBeUndefined()
      expect(images[0].source).toEqual({
        kind: 'tool',
        attachmentId: 'att-shared',
        toolCallId: 'tc_dup',
      })
    }
  )
})

describe('mixed-chain pruning recovery (#650)', () => {
  it('promotes the surviving frame when pruning removed the legacy representative', async () => {
    const { messages } = repeatedFrameMessages(true)
    // protectedTailStart=2 prunes the first frame message and keeps the second.
    const stripped = stripHistoricalMedia(messages, 2)
    expect(imagePartsOf(stripped)).toHaveLength(1)
    expect(imagePartsOf(stripped)[0].source).toEqual({
      kind: 'tool',
      attachmentId: 'att-second',
      toolCallId: 'tc_second',
    })
    expect(imagePartsOf(stripped)[0].sourceIdentityOnly).toBe(true)
    const snapshot = structuredClone(stripped)

    const { provider, complete } = recordingProvider({ cache: true })
    await new LlmPortAdapter(provider, 'gpt-4o', 'openai').complete({
      messages: stripped,
      systemPromptParts: SYSTEM_PARTS,
    })
    const view = providerView(complete[0], true)

    // One frame survives without the internal flag, and its text comes back.
    const visual = imageMessagesOf(view)
    expect(visual).toHaveLength(1)
    expect(visual[0].contentParts?.map(part => part.type)).toEqual(['text', 'image'])
    expect(visual[0].contentParts?.[0]).toEqual({ type: 'text', text: EXPLANATORY_TEXT })
    expect(imagePartsOf(view)).toHaveLength(1)
    // The promoted part is the current frame with its internal flag removed.
    expect(imagePartsOf(view)[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: PNG_2X2_BASE64,
      source: { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
    })
    expect(JSON.stringify(view)).not.toContain('sourceIdentityOnly')

    // The adapter cloned: the pruned canonical messages keep their marked frame.
    expect(stripped).toEqual(snapshot)
    expect(imagePartsOf(stripped)[0].sourceIdentityOnly).toBe(true)
  })

  it('promotes one frame per distinct frame when pruning removed both representatives', async () => {
    const png = imageAttachment('att-x1', PNG_2X2_BASE64)
    const jpeg = imageAttachment('att-y1', JPEG_2X2_BASE64, 'image/jpeg')
    const messages: ChatMessage[] = []
    const collected: Attachment[] = []
    appendToolResults(messages, [frameResult('tc_x1', png)], collected, true)
    appendToolResults(messages, [frameResult('tc_y1', jpeg)], collected, true)
    // The same bytes from a later call: only the source identity differs.
    appendToolResults(messages, [frameResult('tc_x2', { ...png, id: 'att-x2' })], collected, true)
    appendToolResults(messages, [frameResult('tc_y2', { ...jpeg, id: 'att-y2' })], collected, true)

    expect(collected).toHaveLength(2)
    expect(imagePartsOf(messages).map(image => image.sourceIdentityOnly)).toEqual([
      undefined,
      undefined,
      true,
      true,
    ])

    // Both older representatives are pruned; only the marked pair is left.
    const stripped = stripHistoricalMedia(messages, 4)
    expect(imagePartsOf(stripped).map(image => image.sourceIdentityOnly)).toEqual([true, true])
    const snapshot = structuredClone(stripped)

    const { provider, complete } = recordingProvider({ cache: true })
    await new LlmPortAdapter(provider, 'gpt-4o', 'openai').complete({
      messages: stripped,
      systemPromptParts: SYSTEM_PARTS,
    })
    const view = providerView(complete[0], true)

    expect(imagePartsOf(view).map(image => image.source)).toEqual([
      { kind: 'tool', attachmentId: 'att-x2', toolCallId: 'tc_x2' },
      { kind: 'tool', attachmentId: 'att-y2', toolCallId: 'tc_y2' },
    ])
    expect(
      imageMessagesOf(view).map(message => message.contentParts?.map(part => part.type))
    ).toEqual([
      ['text', 'image'],
      ['text', 'image'],
    ])
    expect(JSON.stringify(view)).not.toContain('sourceIdentityOnly')
    expect(stripped).toEqual(snapshot)
  })
})

describe('Codex V2 transport wiring (#650)', () => {
  it('authorizes every source identity and never serializes the internal marker', async () => {
    const authorize = vi.fn(async (_input: { request: CodexCompletionRequest }) => ({
      providerAttemptId: 'attempt-1',
      requestHash: 'a'.repeat(64),
      executionTicket: 'ticket-123456',
      expiresAt: '2026-09-17T10:00:00.000Z',
    }))
    const stream = vi.fn(
      async (_input: { request: CodexCompletionRequest; requestHash: string }) => ({
        text: 'ok',
        toolCalls: [],
        outcome: 'success' as const,
      })
    )
    // Infrastructure stand-ins: the authorize gateway and the proxy stream.
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', {
      authorizer: { authorize },
      proxy: { stream },
      attemptContext: () => ({
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
        hostRef: 'chatllm',
      }),
    } as unknown as CodexSubscriptionDeps)

    const { messages } = repeatedFrameMessages()
    // The canonical loop view carries the marker for the repeated identity...
    expect(imagePartsOf(messages)[1].sourceIdentityOnly).toBe(true)
    expect(JSON.stringify(messages)).toContain('sourceIdentityOnly')

    await new LlmPortAdapter(provider, 'gpt-5.3-codex', 'codex-subscription').completeWithTools({
      messages,
      tools: TOOLS,
    })

    const wire = authorize.mock.calls[0][0].request
    if (wire.schemaVersion !== 'codex-completion-request.v2') {
      throw new Error(`expected a Codex V2 request, received ${wire.schemaVersion}`)
    }
    // The class opt-in (not a test-side trait stub) is what keeps both frames:
    // neither source may be dropped before the request is hashed and authorized.
    const authorizedImages = wire.messages
      .flatMap(message => message.contentParts ?? [])
      .filter((part): part is CodexMessagePartImageV2 => part.type === 'image')
    expect(authorizedImages.map(image => image.source)).toEqual([
      { kind: 'tool', attachmentId: 'att-first', toolCallId: 'tc_first' },
      { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
    ])
    // ...while the serialized contract never carries the internal marker.
    expect(JSON.stringify(wire)).not.toContain('sourceIdentityOnly')
    // The proxy streams the same authorized request.
    expect(stream.mock.calls[0][0].request).toBe(wire)
  })

  it('survives a real cross-provider failover without re-marking or losing a frame', async () => {
    const authorize = vi.fn(async (_input: { request: CodexCompletionRequest }) => {
      throw new CodexAuthorizeError('rate_limited', 'gateway answered 429')
    })
    const primary = new CodexSubscriptionProvider('gpt-5.3-codex', {
      authorizer: { authorize },
      proxy: { stream: vi.fn() },
      attemptContext: () => ({
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
        hostRef: 'chatllm',
      }),
    } as unknown as CodexSubscriptionDeps)
    const fallback = recordingProvider({ cache: false })
    const policy: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['rate_limited'],
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
    }
    const engine = new FailoverEngine(policy, { metricInc: () => {} })

    const { messages } = repeatedFrameMessages()
    const snapshot = structuredClone(messages)
    const wrapped = maybeWrapFailover({
      primaryPort: new LlmPortAdapter(primary, 'gpt-5.3-codex', 'codex-subscription'),
      primaryPair: { provider: 'codex-subscription', model: 'gpt-5.3-codex' },
      engine,
      policy,
      buildFallbackPort: () => new LlmPortAdapter(fallback.provider, 'gpt-5.4', 'openai'),
    })

    await wrapped.completeWithTools({ messages, tools: TOOLS })

    // The failed codex attempt still projected both sources before authorizing.
    expect(engine.servedBy()).toEqual({ provider: 'openai', model: 'gpt-5.4', fallback: true })
    const attempted = authorize.mock.calls[0][0].request
    if (attempted.schemaVersion !== 'codex-completion-request.v2') {
      throw new Error(`expected a Codex V2 request, received ${attempted.schemaVersion}`)
    }
    const attemptedImages = attempted.messages
      .flatMap(message => message.contentParts ?? [])
      .filter((part): part is CodexMessagePartImageV2 => part.type === 'image')
    expect(attemptedImages.map(image => image.source)).toEqual([
      { kind: 'tool', attachmentId: 'att-first', toolCallId: 'tc_first' },
      { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
    ])
    // The legacy fallback applies its OWN view to the same retried request...
    expect(imagePartsOf(fallback.completeWithTools[0].messages)).toHaveLength(1)
    // ...while the canonical messages keep both identities for the next attempt.
    expect(messages).toEqual(snapshot)
    expect(imagePartsOf(messages)[1].sourceIdentityOnly).toBe(true)
  })
})

describe('identity-only marker preservation', () => {
  it('keeps the marker when a historical frame is replaced by redaction text', () => {
    const markedFrame: ChatMessage = {
      role: 'user',
      content: EXPLANATORY_TEXT,
      contentParts: [
        { type: 'text', text: EXPLANATORY_TEXT, sourceIdentityOnly: true },
        {
          type: 'image',
          mimeType: 'image/png',
          data: PNG_2X2_BASE64,
          sourceIdentityOnly: true,
          source: { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
        },
      ],
    }
    const retainedFrame: ChatMessage = {
      role: 'user',
      content: EXPLANATORY_TEXT,
      contentParts: [
        { type: 'text', text: EXPLANATORY_TEXT },
        { type: 'image', mimeType: 'image/png', data: PNG_2X2_BASE64 },
      ],
    }

    const stripped = stripHistoricalMedia([markedFrame, retainedFrame], 2)

    expect(stripped[0].contentParts?.[1]).toEqual({
      type: 'text',
      text: '[image redacted — see turn 0]',
      sourceIdentityOnly: true,
    })
    expect(stripped[1].contentParts?.[1]).toEqual({
      type: 'text',
      text: '[image redacted — see turn 1]',
    })
  })

  it('keeps the marker when the turn-context prefix rewrites the text part', () => {
    const parts: MessageContentPart[] = [
      { type: 'text', text: 'body', sourceIdentityOnly: true },
      {
        type: 'image',
        mimeType: 'image/png',
        data: PNG_2X2_BASE64,
        sourceIdentityOnly: true,
        source: { kind: 'tool', attachmentId: 'att-second', toolCallId: 'tc_second' },
      },
    ]

    expect(prependTextToParts(parts, '<turn-context>\n')).toEqual([
      { type: 'text', text: '<turn-context>\nbody', sourceIdentityOnly: true },
      parts[1],
    ])
  })
})
