import { describe, expect, it, vi } from 'vitest'
import {
  JPEG_2X2_BASE64,
  PNG_2X2_BASE64,
  realPngOfDecodedBytesBase64,
} from '../../../llm/__tests__/codexImageFixtures'
import type { ImageInputResolver, ImageTransportOperation } from '../../../llm/imageInput'
import {
  type VisualDeliveryLimits,
  resolveOfficialVisualDeliveryLimits,
  resolveVisualDeliveryLimits,
} from '../../../visualInput/deliveryLimits'
import { assertVisualRequestFits } from '../../../visualInput/requestPolicy'
import { type ChatMessage, FinishReason } from '../../types'
import { LlmPortAdapter } from '../llmPortAdapter'

const source = {
  kind: 'gfs' as const,
  drive: 'main',
  resourceId: 'a'.repeat(32),
  gfsUri: `gfs://main/${'a'.repeat(32)}`,
  version: 7,
  name: 'unit.png',
  toolCallId: 'read-image',
}
const receipt = {
  delivery: 'workspace_file',
  id: 'unit-download',
  source,
  path: '.gfs-downloads/unit-download/source',
  sizeBytes: 100,
  sha256: 'b'.repeat(64),
  expiresAt: '2026-10-09T00:00:00.000Z',
  visualDelivery: 'included',
  usage: { visualDelivery: 'included', wholeFileToContextAllowed: false },
}
const resolver: ImageInputResolver = () => ({
  capability: {
    state: 'supported',
    evidence: {
      source: 'curated',
      reference: 'https://unit-only.invalid/vision',
      checkedAt: '2026-10-02T00:00:00Z',
    },
  },
})

function messages(): ChatMessage[] {
  return [
    {
      role: 'tool',
      name: 'clerum__gfs_read',
      tool_call_id: 'read-image',
      content: JSON.stringify(receipt),
    },
    {
      role: 'user',
      content: '',
      imageOrigin: 'tool_result',
      contentParts: [
        { type: 'image', mimeType: 'image/png', data: PNG_2X2_BASE64, source, width: 2, height: 2 },
      ],
    },
  ]
}

function scenario(
  type: 'openai' | 'claude' | 'codex-subscription',
  getVisualDeliveryLimits: (
    operation: ImageTransportOperation
  ) => VisualDeliveryLimits | null = () =>
    type === 'codex-subscription' ? resolveVisualDeliveryLimits(type) : null
) {
  const result = {
    content: 'bounded',
    tool_calls: null,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    finish_reason: FinishReason.Stop,
  }
  const completeSingleTurnWithTools = vi.fn(
    async (_messages: ChatMessage[], _tools: unknown[]) => result
  )
  const completeSingleTurnWithToolsAndCache = vi.fn(
    async (_parts: unknown, _messages: ChatMessage[], _tools: unknown[]) => result
  )
  const provider = {
    getProviderType: () => type,
    getVisualDeliveryLimits,
    completeSingleTurnWithTools,
    completeSingleTurnWithToolsAndCache,
    completeSingleTurn: vi.fn(),
    classifyError: vi.fn(),
  }
  const adapter = new LlmPortAdapter(
    provider,
    'unit-model',
    type,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resolver
  )
  return { adapter, completeSingleTurnWithTools, completeSingleTurnWithToolsAndCache }
}

describe('GFS pixels require this attempt visual profile', () => {
  it.each(['openai', 'claude'] as const)(
    'demotes a catalog-supported %s attempt and preserves the file receipt',
    async type => {
      const subject = scenario(type)
      const original = messages()
      const before = structuredClone(original)
      await subject.adapter.completeWithTools({ messages: original, tools: [] })
      const sent = subject.completeSingleTurnWithTools.mock.calls[0]![0] as ChatMessage[]
      expect(JSON.stringify(sent)).not.toContain(PNG_2X2_BASE64)
      expect(JSON.parse(sent[0]!.content)).toMatchObject({
        ...receipt,
        visualDelivery: 'not_included',
        usage: { visualDelivery: 'not_included' },
        visualReason: 'provider_visual_profile_unavailable',
      })
      expect(original).toEqual(before)
    }
  )

  it('does not retain a Codex primary profile when dispatching a catalog-supported fallback', async () => {
    const primary = scenario('codex-subscription')
    const fallback = scenario('openai')
    const original = messages()
    const before = structuredClone(original)
    await primary.adapter.completeWithTools({ messages: original, tools: [] })
    await fallback.adapter.completeWithTools({ messages: original, tools: [] })
    expect(JSON.stringify(primary.completeSingleTurnWithTools.mock.calls[0]![0])).toContain(
      PNG_2X2_BASE64
    )
    expect(JSON.stringify(fallback.completeSingleTurnWithTools.mock.calls[0]![0])).not.toContain(
      PNG_2X2_BASE64
    )
    expect(original).toEqual(before)
  })

  it('updates a deduplicated GFS receipt before losing its source identity in an unknown-profile attempt', async () => {
    const subject = scenario('openai')
    const original = messages()
    original[1]!.contentParts![0]!.sourceIdentityOnly = true
    original.push({
      role: 'user',
      content: 'Composer image',
      contentParts: [
        { type: 'image', mimeType: 'image/png', data: PNG_2X2_BASE64, width: 2, height: 2 },
      ],
    })
    const before = structuredClone(original)
    await subject.adapter.completeWithTools({ messages: original, tools: [] })
    const sent = subject.completeSingleTurnWithTools.mock.calls[0]![0]
    expect(JSON.parse(sent[0]!.content)).toMatchObject({
      ...receipt,
      visualDelivery: 'not_included',
      usage: { visualDelivery: 'not_included' },
      visualReason: 'provider_visual_profile_unavailable',
    })
    const images = sent.flatMap(message =>
      (message.contentParts ?? []).filter(part => part.type === 'image')
    )
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ data: PNG_2X2_BASE64 })
    expect(images[0]!.source).toBeUndefined()
    expect(original).toEqual(before)
  })

  it('projects the cache attempt receipt before its cached dispatch', async () => {
    const subject = scenario('claude')
    const original = messages()
    const before = structuredClone(original)
    await subject.adapter.completeWithTools({
      messages: original,
      tools: [],
      systemPromptParts: {
        stable: 'stable',
        context: 'context',
        stableHash: 'unit-stable',
        contextHash: 'unit-context',
      },
    })
    const sent = subject.completeSingleTurnWithToolsAndCache.mock.calls[0]![1] as ChatMessage[]
    expect(JSON.stringify(sent)).not.toContain(PNG_2X2_BASE64)
    expect(JSON.parse(sent[0]!.content)).toMatchObject({
      visualDelivery: 'not_included',
      usage: { visualDelivery: 'not_included' },
      path: receipt.path,
      sha256: receipt.sha256,
    })
    expect(original).toEqual(before)
  })

  it('rechecks the cached operation instead of reusing its admission profile', async () => {
    const subject = scenario('claude', operation =>
      operation === 'completeWithTools'
        ? resolveOfficialVisualDeliveryLimits('claude', 'https://api.anthropic.com', operation)
        : null
    )
    expect(await subject.adapter.getImageInputCapability()).toMatchObject({
      status: 'supported',
      deliveryLimits: { maxImageEncodedBytes: 10_000_000 },
    })
    const original = messages()
    const before = structuredClone(original)
    await subject.adapter.completeWithTools({
      messages: original,
      tools: [],
      systemPromptParts: {
        stable: 'stable',
        context: 'context',
        stableHash: 'unit-stable',
        contextHash: 'unit-context',
      },
    })
    const sent = subject.completeSingleTurnWithToolsAndCache.mock.calls[0]![1]
    expect(JSON.stringify(sent)).not.toContain(PNG_2X2_BASE64)
    expect(JSON.parse(sent[0]!.content)).toMatchObject({
      visualDelivery: 'not_included',
      usage: { visualDelivery: 'not_included' },
      path: receipt.path,
      sha256: receipt.sha256,
    })
    expect(subject.completeSingleTurnWithTools).not.toHaveBeenCalled()
    expect(original).toEqual(before)
  })

  it.each([false, true])(
    'checks every origin measured geometry under the Claude profile: known=%s',
    async known => {
      const subject = scenario('claude', operation =>
        resolveOfficialVisualDeliveryLimits('claude', 'https://api.anthropic.com', operation)
      )
      const original = messages()
      const ordinary = {
        type: 'image' as const,
        mimeType: 'image/jpeg' as const,
        data: JPEG_2X2_BASE64,
        ...(known ? { width: 2, height: 2 } : {}),
      }
      original.push({ role: 'user', content: 'Composer image', contentParts: [ordinary] })
      const before = structuredClone(original)
      await subject.adapter.completeWithTools({ messages: original, tools: [] })
      const sent = subject.completeSingleTurnWithTools.mock.calls[0]![0]
      const projectedReceipt = JSON.parse(sent[0]!.content)
      expect(projectedReceipt).toMatchObject({
        ...receipt,
        visualDelivery: known ? 'included' : 'not_included',
        usage: { visualDelivery: known ? 'included' : 'not_included' },
      })
      if (known) expect(JSON.stringify(sent)).toContain(PNG_2X2_BASE64)
      else {
        expect(JSON.stringify(sent)).not.toContain(PNG_2X2_BASE64)
        expect(projectedReceipt).toMatchObject({
          visualReason: 'geometry_unknown',
          usage: { visualReason: 'geometry_unknown' },
        })
      }
      expect(sent[2]!.contentParts![0]).toBe(ordinary)
      expect(original).toEqual(before)
    }
  )

  it('withholds a GFS frame whose measured geometry is absent', async () => {
    const subject = scenario('claude', operation =>
      resolveOfficialVisualDeliveryLimits('claude', 'https://api.anthropic.com', operation)
    )
    const original = messages()
    const image = original[1]!.contentParts![0]!
    if (image.type !== 'image') throw new Error('expected image')
    delete image.height
    const before = structuredClone(original)
    await subject.adapter.completeWithTools({ messages: original, tools: [] })
    const sent = subject.completeSingleTurnWithTools.mock.calls[0]![0]
    expect(JSON.stringify(sent)).not.toContain(PNG_2X2_BASE64)
    expect(JSON.parse(sent[0]!.content)).toMatchObject({
      ...receipt,
      visualDelivery: 'not_included',
      usage: { visualDelivery: 'not_included', visualReason: 'geometry_unknown' },
      visualReason: 'geometry_unknown',
    })
    expect(original).toEqual(before)
  })

  it('does not impose geometry on the official OpenAI profile', async () => {
    const subject = scenario('openai', operation =>
      resolveOfficialVisualDeliveryLimits('openai', 'https://api.openai.com/v1', operation)
    )
    const original = messages()
    original.push({
      role: 'user',
      content: 'Composer image',
      contentParts: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG_2X2_BASE64 }],
    })
    const before = structuredClone(original)
    await subject.adapter.completeWithTools({ messages: original, tools: [] })
    const sent = subject.completeSingleTurnWithTools.mock.calls[0]![0]
    expect(JSON.stringify(sent)).toContain(PNG_2X2_BASE64)
    expect(JSON.stringify(sent)).toContain(JPEG_2X2_BASE64)
    expect(JSON.parse(sent[0]!.content)).toMatchObject({ visualDelivery: 'included' })
    expect(original).toEqual(before)
  })

  it('recalculates the Claude dimension threshold after demoting a GFS frame among ordinary images', async () => {
    const profile = resolveOfficialVisualDeliveryLimits(
      'claude',
      'https://api.anthropic.com',
      'completeWithTools'
    )!
    const subject = scenario('claude', () => profile)
    const original = messages()
    const first = original[1]!.contentParts![0]!
    if (first.type !== 'image') throw new Error('expected image')
    first.data = realPngOfDecodedBytesBase64(64 * 1024, 2001, 2)
    first.width = 2001
    const secondSource = {
      ...source,
      resourceId: 'c'.repeat(32),
      gfsUri: `gfs://main/${'c'.repeat(32)}`,
      toolCallId: 'read-image-2',
    }
    original[1]!.contentParts!.push({
      type: 'image',
      mimeType: 'image/png',
      data: PNG_2X2_BASE64,
      source: secondSource,
      width: 2,
      height: 2,
    })
    original.unshift({
      role: 'tool',
      name: 'clerum__gfs_read',
      tool_call_id: secondSource.toolCallId,
      content: JSON.stringify({
        ...receipt,
        id: 'unit-download-2',
        source: secondSource,
        path: '.gfs-downloads/unit-download-2/source',
      }),
    })
    original.push({
      role: 'user',
      content: 'Composer images',
      contentParts: Array.from({ length: 19 }, () => ({
        type: 'image',
        mimeType: 'image/png',
        data: PNG_2X2_BASE64,
        width: 2,
        height: 2,
      })),
    })
    const before = structuredClone(original)
    await subject.adapter.completeWithTools({ messages: original, tools: [] })
    const sent = subject.completeSingleTurnWithTools.mock.calls[0]![0]
    const images = sent.flatMap(message =>
      (message.contentParts ?? []).filter(part => part.type === 'image')
    )
    expect(images).toHaveLength(20)
    expect(
      images.some(
        part =>
          part.type === 'image' &&
          part.source?.kind === 'gfs' &&
          part.source.resourceId === source.resourceId &&
          part.width === 2001
      )
    ).toBe(true)
    expect(JSON.parse(sent[0]!.content)).toMatchObject({
      source: secondSource,
      visualDelivery: 'not_included',
      usage: { visualDelivery: 'not_included' },
      path: '.gfs-downloads/unit-download-2/source',
    })
    expect(() => assertVisualRequestFits(sent, { messages: sent }, false, profile)).not.toThrow()
    expect(original).toEqual(before)
  })
})
