import { describe, expect, it, vi } from 'vitest'
import { PNG_2X2_BASE64 } from '../../../llm/__tests__/codexImageFixtures'
import type { ImageInputResolver } from '../../../llm/imageInput'
import { deepFreeze } from '../../../llm/openaiFamily/__tests__/responsesFixtures'
import { resolveVisualDeliveryLimits } from '../../../visualInput/deliveryLimits'
import { historyAfterToolTurn } from '../../orchestration/__tests__/loopHistory'
import { type ChatMessage, FinishReason, type MessageContentPart } from '../../types'
import { LlmPortAdapter } from '../llmPortAdapter'

function gfsImagePart(
  index: number,
  width = 1,
  height = 1
): Extract<MessageContentPart, { type: 'image' }> {
  const resourceId = String(index).padStart(32, '0')
  return {
    type: 'image',
    mimeType: 'image/png',
    data: PNG_2X2_BASE64,
    width,
    height,
    source: {
      kind: 'gfs',
      drive: 'main',
      resourceId,
      gfsUri: `gfs://main/${resourceId}`,
      version: 1,
      name: `image-${index}.png`,
    },
  }
}

function imageMessage(count: number, width = 1, height = 1): ChatMessage {
  return {
    role: 'user',
    content: 'Compare these governed images',
    contentParts: Array.from({ length: count }, (_, index) => gfsImagePart(index, width, height)),
  }
}

function fittedImageCount(adapter: LlmPortAdapter, count: number, width = 1, height = 1): number {
  const messages = [imageMessage(count, width, height)]
  const fitted = (
    adapter as unknown as {
      fitGfsImages(
        request: { messages: ChatMessage[]; tools: unknown[] },
        providerMessages: ChatMessage[]
      ): ChatMessage[]
    }
  ).fitGfsImages({ messages, tools: [] }, messages)
  return fitted[0]!.contentParts!.filter(part => part.type === 'image').length
}

describe('LlmPortAdapter effective GFS visual limits', () => {
  it('keeps four valid Codex images instead of applying the old three-image GFS gate', () => {
    const adapter = new LlmPortAdapter(
      {
        getProviderType: () => 'codex-subscription',
        getVisualDeliveryLimits: () => resolveVisualDeliveryLimits('codex-subscription'),
      } as never,
      'fixture-model',
      'codex-subscription'
    )
    expect(fittedImageCount(adapter, 4)).toBe(4)
  })

  it('demotes only beyond the effective Codex image-count profile', () => {
    const adapter = new LlmPortAdapter(
      {
        getProviderType: () => 'codex-subscription',
        getVisualDeliveryLimits: () => resolveVisualDeliveryLimits('codex-subscription'),
      } as never,
      'fixture-model',
      'codex-subscription'
    )
    expect(fittedImageCount(adapter, 21)).toBe(20)
  })

  it('demotes an image exceeding the effective Codex shape profile', () => {
    const adapter = new LlmPortAdapter(
      {
        getProviderType: () => 'codex-subscription',
        getVisualDeliveryLimits: () => resolveVisualDeliveryLimits('codex-subscription'),
      } as never,
      'fixture-model',
      'codex-subscription'
    )
    expect(fittedImageCount(adapter, 1, 2048, 2048)).toBe(1)
    expect(fittedImageCount(adapter, 1, 2049, 2048)).toBe(0)
  })

  it('uses the actual attempt transport instead of retaining a primary profile label', () => {
    const adapter = new LlmPortAdapter(
      { getProviderType: () => 'openai', getVisualDeliveryLimits: () => null } as never,
      'fixture-model',
      'codex-subscription'
    )
    expect(fittedImageCount(adapter, 1)).toBe(0)
  })
})

describe('opaque provider continuity is not measured as visual request bytes', () => {
  const source = {
    kind: 'gfs' as const,
    drive: 'main',
    resourceId: 'a'.repeat(32),
    gfsUri: `gfs://main/${'a'.repeat(32)}`,
    version: 7,
    name: 'unit.png',
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
  const bytes = (ms: ChatMessage[]) =>
    ms.reduce((total, m) => total + Buffer.byteLength(JSON.stringify(m), 'utf8'), 0)

  it('a failover target keeps GFS images that only the continuation blobs would push over the limit', async () => {
    // History from the real decode + loop push; the image arrives after it.
    const history = await historyAfterToolTurn('v1-rfc-preamble-gpt-6.1-terra')
    const messages = deepFreeze([
      ...history,
      {
        role: 'user',
        content: '',
        imageOrigin: 'tool_result',
        contentParts: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: PNG_2X2_BASE64,
            source,
            width: 2,
            height: 2,
          },
        ],
      },
    ] as ChatMessage[])
    const withBlob = bytes(messages)
    const withoutBlob = bytes(
      messages.map(({ provider_continuation: _drop, ...rest }) => rest as ChatMessage)
    )
    expect(withBlob - withoutBlob).toBeGreaterThan(1024)
    // Room for everything the target will receive, but not for the blobs.
    const maxVisualRequestBytes = withoutBlob + Math.floor((withBlob - withoutBlob) / 2)

    const completeSingleTurnWithTools = vi.fn(async (_messages: ChatMessage[]) => ({
      content: 'seen',
      tool_calls: null,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: FinishReason.Stop,
    }))
    const adapter = new LlmPortAdapter(
      {
        getProviderType: () => 'claude',
        getVisualDeliveryLimits: () => ({ maxImages: 20, maxVisualRequestBytes }),
        completeSingleTurnWithTools,
        completeSingleTurn: vi.fn(),
        classifyError: vi.fn(),
      } as never,
      'unit-model',
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resolver
    )
    await adapter.completeWithTools({ messages, tools: [] })

    const sent = completeSingleTurnWithTools.mock.calls[0]![0]
    expect(JSON.stringify(sent)).toContain(PNG_2X2_BASE64)
    // The measurement must not strip the field from what the driver receives.
    expect(sent.find(m => m.provider_continuation)?.provider_continuation).toEqual(
      history.find(m => m.provider_continuation)?.provider_continuation
    )
  })
})
