import { describe, expect, it } from 'vitest'
import { PNG_2X2_BASE64 } from '../../../llm/__tests__/codexImageFixtures'
import { resolveVisualDeliveryLimits } from '../../../visualInput/deliveryLimits'
import type { ChatMessage, MessageContentPart } from '../../types'
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
