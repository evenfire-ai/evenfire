import { describe, expect, it, vi } from 'vitest'
import { createIncomingAdmission } from '../agent/incomingAdmission'
import { LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import { LlmError, LlmErrorCode } from '../core/errors'
import {
  type ChatMessage,
  FinishReason,
  type MessageContentPart,
  type PendingApproval,
} from '../core/types'
import {
  JPEG_2X2_BASE64,
  PNG_2X2_BASE64,
  realPngOfDecodedBytesBase64,
} from '../llm/__tests__/codexImageFixtures'
import { GrokSubscriptionProvider } from '../llm/grokSubscription'
import type { ImageInputResolver } from '../llm/imageInput'
import type { IncomingMessage } from '../server/types'
import { resolveVisualDeliveryLimits } from '../visualInput/deliveryLimits'
import { projectGfsApproval } from '../visualInput/suspension'

const VISION_SUPPORTED: ImageInputResolver = () => ({
  capability: {
    state: 'supported',
    evidence: {
      source: 'curated',
      reference: 'https://unit.invalid/vision',
      checkedAt: '2026-10-02T00:00:00Z',
    },
  },
})

const VISION_UNSUPPORTED: ImageInputResolver = () => ({
  capability: {
    state: 'unsupported',
    evidence: {
      source: 'curated',
      reference: 'https://unit.invalid/text-only',
      checkedAt: '2026-10-02T00:00:00Z',
    },
  },
})

function channelImageMessage(
  parts: Array<Extract<MessageContentPart, { type: 'image' }>>,
  text = 'Analyze this'
): ChatMessage {
  return {
    role: 'user',
    content: text,
    imageOrigin: 'channel_retained',
    contentParts: [{ type: 'text', text }, ...parts],
  }
}

function makeProviderMock(
  type: 'codex-subscription' | 'grok-subscription' | 'openai' | 'claude' | 'zai',
  limits: ReturnType<typeof resolveVisualDeliveryLimits> | null
) {
  const completeSingleTurnWithTools = vi.fn(async (_messages: ChatMessage[]) => ({
    content: 'analysis complete',
    tool_calls: null,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: FinishReason.Stop,
  }))
  const provider = {
    getProviderType: () => type,
    getVisualDeliveryLimits: () => limits,
    completeSingleTurnWithTools,
    completeSingleTurn: vi.fn(),
    classifyError: vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: false,
      message: 'err',
    })),
  }
  return { provider, completeSingleTurnWithTools }
}

describe('X12 & projectGfsApproval — channel_retained vision projection, limits, and suspension strip', () => {
  it('S42: demotes channel_retained PNG on non-vision model with explicit notice while Desktop rpc inline image still hard-refuses', async () => {
    const { provider, completeSingleTurnWithTools } = makeProviderMock(
      'openai',
      resolveVisualDeliveryLimits('codex-subscription')
    )
    const adapter = new LlmPortAdapter(
      provider as never,
      'text-only-model',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_UNSUPPORTED
    )

    const channelMsgs = [
      channelImageMessage([
        {
          type: 'image',
          mimeType: 'image/png',
          data: PNG_2X2_BASE64,
          width: 2,
          height: 2,
          filename: 'chart.png',
          visualValid: true,
          source: { kind: 'attachment', attachmentId: 'att-1', messageId: 'm-1' },
        },
      ]),
    ]

    const result = await adapter.completeWithTools({ messages: channelMsgs, tools: [] })
    expect(result.content).toBe('analysis complete')
    const sent = completeSingleTurnWithTools.mock.calls[0]![0]!
    expect(sent[0]!.contentParts).toBeUndefined()
    expect(sent[0]!.content).toContain('chart.png')
    expect(sent[0]!.content).toContain('does not support image input')

    // Liveness witness: Desktop inline image (no imageOrigin) on the same non-vision adapter MUST still throw LlmError.
    const desktopMsgs: ChatMessage[] = [
      {
        role: 'user',
        content: 'Describe this',
        contentParts: [
          { type: 'text', text: 'Describe this' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: PNG_2X2_BASE64,
            width: 2,
            height: 2,
            source: { kind: 'attachment', attachmentId: 'desk-1', messageId: 'm-desk' },
          },
        ],
      },
    ]
    await expect(
      adapter.completeWithTools({ messages: desktopMsgs, tools: [] })
    ).rejects.toBeInstanceOf(LlmError)
  })

  it('S43: degrades channel_retained image cleanly when failover switches from vision primary to non-vision fallback', async () => {
    const primaryMock = makeProviderMock(
      'codex-subscription',
      resolveVisualDeliveryLimits('codex-subscription')
    )
    primaryMock.completeSingleTurnWithTools.mockRejectedValueOnce(new Error('503 primary outage'))
    primaryMock.provider.classifyError = vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: '503 primary outage',
    }))

    const fallbackMock = makeProviderMock('openai', null)

    const primaryAdapter = new LlmPortAdapter(
      primaryMock.provider as never,
      'vision-model',
      'codex-subscription',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_SUPPORTED
    )
    const fallbackAdapter = new LlmPortAdapter(
      fallbackMock.provider as never,
      'text-fallback',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_UNSUPPORTED
    )

    const messages = [
      channelImageMessage([
        {
          type: 'image',
          mimeType: 'image/png',
          data: PNG_2X2_BASE64,
          width: 2,
          height: 2,
          filename: 'receipt.png',
          visualValid: true,
          source: { kind: 'attachment', attachmentId: 'att-failover', messageId: 'm-fo' },
        },
      ]),
    ]

    // Attempt 1 on vision primary carries the image part and fails retryably.
    await expect(primaryAdapter.completeWithTools({ messages, tools: [] })).rejects.toThrow()
    const attempt1Sent = primaryMock.completeSingleTurnWithTools.mock.calls[0]![0]!
    expect(attempt1Sent[0]!.contentParts?.filter(p => p.type === 'image')).toHaveLength(1)

    // Attempt 2 on text-only fallback strips the image part, injects notice, and succeeds.
    const res2 = await fallbackAdapter.completeWithTools({ messages, tools: [] })
    expect(res2.content).toBe('analysis complete')
    const attempt2Sent = fallbackMock.completeSingleTurnWithTools.mock.calls[0]![0]!
    expect(attempt2Sent[0]!.contentParts).toBeUndefined()
    expect(attempt2Sent[0]!.content).toContain('receipt.png')
    expect(attempt2Sent[0]!.content).toContain('does not support image input')
  })

  it('S51 & S67: two-phase fitGfsImages demotes per-image oversized Turn-1 4032x3024 photo first while preserving valid Turn-2 diagram, and trims aggregate overflow oldest-first', async () => {
    const { provider, completeSingleTurnWithTools } = makeProviderMock(
      'codex-subscription',
      resolveVisualDeliveryLimits('codex-subscription')
    )
    const adapter = new LlmPortAdapter(
      provider as never,
      'codex-vision',
      'codex-subscription',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_SUPPORTED
    )

    // Phase 1 test: Turn 1 has oversized 4032x3024 JPEG; Turn 2 has valid 800x600 diagram.png.
    const twoTurnMsgs: ChatMessage[] = [
      channelImageMessage(
        [
          {
            type: 'image',
            mimeType: 'image/jpeg',
            data: JPEG_2X2_BASE64,
            width: 4032,
            height: 3024,
            filename: 'photo.jpg',
            visualValid: true,
            source: { kind: 'attachment', attachmentId: 'att-old-big', messageId: 'm-1' },
          },
        ],
        'Turn 1 photo'
      ),
      channelImageMessage(
        [
          {
            type: 'image',
            mimeType: 'image/png',
            data: PNG_2X2_BASE64,
            width: 800,
            height: 600,
            filename: 'diagram.png',
            visualValid: true,
            source: { kind: 'attachment', attachmentId: 'att-new-good', messageId: 'm-2' },
          },
        ],
        'Turn 2 diagram'
      ),
    ]

    await adapter.completeWithTools({ messages: twoTurnMsgs, tools: [] })
    const sent = completeSingleTurnWithTools.mock.calls[0]![0]!
    // Turn 1 oversized JPEG demoted to text notice; Turn 2 diagram.png preserved!
    expect(sent[0]!.contentParts).toBeUndefined()
    expect(sent[0]!.content).toContain('photo.jpg')
    expect(sent[0]!.content).toContain('visual delivery limits')
    const turn2Images = sent[1]!.contentParts?.filter(p => p.type === 'image') ?? []
    expect(turn2Images).toHaveLength(1)
    expect(turn2Images[0]!.filename).toBe('diagram.png')

    // Phase 2 oldest-first test: 22 valid images on Codex (maxImages=20) -> oldest 2 demoted, newest 20 kept.
    completeSingleTurnWithTools.mockClear()
    const manyParts = Array.from({ length: 22 }, (_, i) => ({
      type: 'image' as const,
      mimeType: 'image/png' as const,
      data: PNG_2X2_BASE64,
      width: 100,
      height: 100,
      filename: `img-${i}.png`,
      visualValid: true,
      source: { kind: 'attachment' as const, attachmentId: `att-${i}`, messageId: `m-${i}` },
    }))
    await adapter.completeWithTools({
      messages: [channelImageMessage(manyParts, 'Compare all')],
      tools: [],
    })
    const sentMany = completeSingleTurnWithTools.mock.calls[0]![0]!
    const keptImages = sentMany[0]!.contentParts!.filter(p => p.type === 'image')
    expect(keptImages).toHaveLength(20)
    expect(keptImages[0]!.filename).toBe('img-2.png')
    expect(keptImages[19]!.filename).toBe('img-21.png')
    expect(sentMany[0]!.content).toContain('img-0.png')
    expect(sentMany[0]!.content).toContain('img-1.png')
  })

  it('S57: resolves Grok visual delivery limits (demoting 3x8MiB PNGs down to 2 fitting <=20MiB) and projects valid channel images on vision-capable OpenAI-compatible (limits=null)', async () => {
    const grokLimits = resolveVisualDeliveryLimits('grok-subscription')
    expect(grokLimits).toMatchObject({
      maxImages: 20,
      maxImageBytes: 20_971_520,
      maxTotalImageBytes: 20_971_520,
    })

    const realGrok = new GrokSubscriptionProvider('grok-4', {
      authorizer: {} as never,
      proxy: {} as never,
      attemptContext: () => ({ policyRevision: 1, policyHash: 'h' }),
    })
    expect(realGrok.getVisualDeliveryLimits('completeWithTools')).toEqual(grokLimits)

    // 3 x 8 MiB PNGs = 24 MiB > 20 MiB Grok maxTotalImageBytes -> oldest 1 demoted, newest 2 sent.
    const eightMiBPng = realPngOfDecodedBytesBase64(8 * 1024 * 1024)
    const grokMock = makeProviderMock('grok-subscription', grokLimits)
    const grokAdapter = new LlmPortAdapter(
      grokMock.provider as never,
      'grok-4',
      'grok-subscription',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_SUPPORTED
    )
    const grokMsgs = [
      channelImageMessage([
        {
          type: 'image',
          mimeType: 'image/png',
          data: eightMiBPng,
          width: 100,
          height: 100,
          filename: 'one.png',
          visualValid: true,
          source: { kind: 'attachment', attachmentId: 'g-1', messageId: 'm-g' },
        },
        {
          type: 'image',
          mimeType: 'image/png',
          data: eightMiBPng,
          width: 100,
          height: 100,
          filename: 'two.png',
          visualValid: true,
          source: { kind: 'attachment', attachmentId: 'g-2', messageId: 'm-g' },
        },
        {
          type: 'image',
          mimeType: 'image/png',
          data: eightMiBPng,
          width: 100,
          height: 100,
          filename: 'three.png',
          visualValid: true,
          source: { kind: 'attachment', attachmentId: 'g-3', messageId: 'm-g' },
        },
      ]),
    ]
    await grokAdapter.completeWithTools({ messages: grokMsgs, tools: [] })
    const grokSent = grokMock.completeSingleTurnWithTools.mock.calls[0]![0]!
    const grokImages = grokSent[0]!.contentParts!.filter(p => p.type === 'image')
    expect(grokImages).toHaveLength(2)
    expect(grokImages.map(p => p.filename)).toEqual(['two.png', 'three.png'])
    expect(grokSent[0]!.content).toContain('one.png')

    // Vision-capable OpenAI-compatible provider (zai, limits === null): valid 200 KiB PNG is projected, NOT blanket-demoted!
    const compatMock = makeProviderMock('zai', null)
    const compatAdapter = new LlmPortAdapter(
      compatMock.provider as never,
      'glm-4v',
      'zai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_SUPPORTED
    )
    const valid200KiB = realPngOfDecodedBytesBase64(200 * 1024)
    await compatAdapter.completeWithTools({
      messages: [
        channelImageMessage([
          {
            type: 'image',
            mimeType: 'image/png',
            data: valid200KiB,
            width: 400,
            height: 300,
            filename: 'compat.png',
            visualValid: true,
            source: { kind: 'attachment', attachmentId: 'c-1', messageId: 'm-c' },
          },
        ]),
      ],
      tools: [],
    })
    const compatSent = compatMock.completeSingleTurnWithTools.mock.calls[0]![0]!
    const compatImages = compatSent[0]!.contentParts!.filter(p => p.type === 'image')
    expect(compatImages).toHaveLength(1)
    expect(compatImages[0]!.filename).toBe('compat.png')
  })

  it('S58: demotes visualValid=false channel_retained images before provider dispatch without throwing InvalidAttachment', async () => {
    const { provider, completeSingleTurnWithTools } = makeProviderMock(
      'codex-subscription',
      resolveVisualDeliveryLimits('codex-subscription')
    )
    const adapter = new LlmPortAdapter(
      provider as never,
      'codex-vision',
      'codex-subscription',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      VISION_SUPPORTED
    )

    const msgs = [
      channelImageMessage([
        {
          type: 'image',
          mimeType: 'image/jpeg',
          data: JPEG_2X2_BASE64,
          width: 2,
          height: 2,
          filename: 'motion-photo.jpg',
          visualValid: false,
          source: { kind: 'attachment', attachmentId: 'm-bad', messageId: 'm-58' },
        },
      ]),
    ]
    const res = await adapter.completeWithTools({ messages: msgs, tools: [] })
    expect(res.content).toBe('analysis complete')
    const sent = completeSingleTurnWithTools.mock.calls[0]![0]!
    expect(sent[0]!.contentParts).toBeUndefined()
    expect(sent[0]!.content).toContain('motion-photo.jpg')
    expect(sent[0]!.content).toContain('container framing')
  })

  it('projectGfsApproval strips channel_retained image parts from PendingApproval.context_snapshot', () => {
    const approval: PendingApproval = {
      request_id: 'req-1',
      tool_name: 'clerum__gfs_save_attachment',
      tool_call_id: 'tc-1',
      description: 'Save photo to EvenDrive',
      parameters: { attachmentId: 'att-img-1' },
      context_snapshot: [
        channelImageMessage([
          {
            type: 'image',
            mimeType: 'image/png',
            data: PNG_2X2_BASE64,
            width: 2,
            height: 2,
            filename: 'secret.png',
            visualValid: true,
            source: { kind: 'attachment', attachmentId: 'att-img-1', messageId: 'm-1' },
          },
        ]),
      ],
    }

    const projected = projectGfsApproval(approval)
    expect(JSON.stringify(projected.context_snapshot)).not.toContain(PNG_2X2_BASE64)
    expect(projected.context_snapshot[0]!.contentParts).toBeUndefined()
    expect(projected.context_snapshot[0]!.imageOrigin).toBeUndefined()
    expect(projected.context_snapshot[0]!.content).toContain('secret.png')
    // Original snapshot is not mutated.
    expect(approval.context_snapshot[0]!.contentParts).toHaveLength(2)
  })

  it('IncomingAdmission exempts channelAttachmentIds from Desktop #654/#669 hard-refusal while keeping Desktop rpc inline images refused on non-vision models', async () => {
    const dispatchSpy = vi.fn(async () => ({
      success: true,
      status: 'completed' as const,
      response: 'dispatched',
    }))
    const admit = createIncomingAdmission({
      limits: {
        maxCount: 10,
        maxBytes: 16 * 1024 * 1024,
        maxFileBytes: 11 * 1024 * 1024,
      },
      queueReady: () => true,
      degradedReason: () => null,
      hostProvider: () => 'openai',
      getConversationByKey: async () => undefined,
      resolveTaskModel: () => ({
        provider: { getProviderType: () => 'openai' },
        model: 'text-only-model',
      }),
      resolveImageInput: () => ({
        capability: {
          state: 'unsupported',
          evidence: {
            source: 'curated',
            reference: 'https://unit.invalid/text-only',
            checkedAt: '2026-10-02T00:00:00Z',
          },
        },
      }),
      applySessionModelSelection: async () => ({
        ok: true,
        provider: 'openai',
        model: 'text-only-model',
        modelSelectionRevision: 1,
      }),
      dispatch: dispatchSpy,
      fileReferenceGfs: () => ({ status: 'unsupported' }),
      logger: { info: vi.fn(), warn: vi.fn() },
      approvalSnapshot: () =>
        ({
          effective: { defaultPolicy: 'cli_only' },
          ceiling: 'manual',
          channelSwitch: 'manual_only',
        }) as never,
    })

    // Channel message carrying channelAttachmentIds passes admission on non-vision model.
    const channelMsg: IncomingMessage = {
      content: 'analyze this image and pdf',
      channelType: 'telegram',
      channelId: 'chat-1',
      sender: 'tg-1',
      timestamp: new Date().toISOString(),
      messageId: 'm-ch-1',
      hostRef: 'ns/host',
      channelAttachmentIds: ['att-img-1', 'att-pdf-1'],
    }
    const chRes = await admit(channelMsg)
    expect(chRes.success).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)

    // Liveness witness: Desktop rpc message with inline kind:'image' on the same non-vision model is still hard-refused.
    const desktopMsg: IncomingMessage = {
      content: 'describe image',
      channelType: 'rpc',
      channelId: 'agent-1',
      sender: 'user-1',
      timestamp: new Date().toISOString(),
      messageId: 'm-rpc-img',
      hostRef: 'ns/host',
      attachments: [
        {
          id: 'desk-img-1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: PNG_2X2_BASE64,
        },
      ],
    }
    const rpcRes = await admit(desktopMsg)
    expect(rpcRes.success).toBe(false)
    expect(rpcRes.error?.code).toBe(LlmErrorCode.ImageInputUnsupported)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
  })
})
