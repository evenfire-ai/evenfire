import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildAttachmentFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { createIncomingAdmission } from '../agent/incomingAdmission'
import { AgentStateMachine } from '../agent/stateMachine'
import { config } from '../config'
import { maybeWrapFailover } from '../core/adapters/failoverLlmPort'
import { LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import { makeSqliteStore } from '../core/conversation/persistence/__tests__/testHelpers'
import { LlmError, LlmErrorCode } from '../core/errors'
import {
  type ChatMessage,
  FinishReason,
  type MessageContentPart,
  type PendingApproval,
} from '../core/types'
import {
  ChannelAttachmentStore,
  normalizeChannelFilename,
  validateStrictChannelImageContainer,
} from '../internalTools/channelAttachmentStore'
import { TaskLifecycle } from '../lifecycle/taskLifecycle'
import {
  JPEG_2X2_BASE64,
  PNG_2X2_BASE64,
  realPngOfDecodedBytesBase64,
} from '../llm/__tests__/codexImageFixtures'
import { FailoverEngine } from '../llm/failover/engine'
import type { LlmPolicy } from '../llm/failover/types'
import { GrokSubscriptionProvider } from '../llm/grokSubscription'
import type { ImageInputResolver } from '../llm/imageInput'
import { IncomingMessageHandler, type PendingTaskEntry } from '../messageHandler'
import { MessageQueue } from '../queue/messageQueue'
import { ResultStore } from '../resultStore'
import type { IncomingMessage } from '../server/types'
import { SessionProcessor, resolveCanonicalSessionKey } from '../session'
import { resolveVisualDeliveryLimits } from '../visualInput/deliveryLimits'
import { projectGfsApproval } from '../visualInput/suspension'
import { putTestBuffer } from './channelAttachmentTestHelpers'

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

  it('S43 (BR-T3): real maybeWrapFailover / FailoverLlmPort degrades channel_retained image cleanly on failover from vision primary to non-vision fallback AND preserves source binding on failover to Codex/Grok secondary', async () => {
    // Part A: vision Codex primary fails retryably -> real FailoverLlmPort switches to non-vision OpenAI fallback.
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

    const policyA: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['provider_unavailable'],
      fallbacks: [{ provider: 'openai', model: 'text-fallback' }],
    }
    const engineA = new FailoverEngine(policyA)
    const portA = maybeWrapFailover({
      primaryPort: primaryAdapter,
      primaryPair: { provider: 'codex-subscription', model: 'vision-model' },
      engine: engineA,
      policy: policyA,
      buildFallbackPort: () => fallbackAdapter,
    })

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

    const resA = await portA.completeWithTools({ messages, tools: [] })
    expect(resA.content).toBe('analysis complete')
    expect(engineA.servedBy()).toEqual({
      provider: 'openai',
      model: 'text-fallback',
      fallback: true,
    })
    const attempt1Sent = primaryMock.completeSingleTurnWithTools.mock.calls[0]![0]!
    expect(attempt1Sent[0]!.contentParts?.filter(p => p.type === 'image')).toHaveLength(1)
    const attempt2Sent = fallbackMock.completeSingleTurnWithTools.mock.calls[0]![0]!
    expect(attempt2Sent[0]!.contentParts).toBeUndefined()
    expect(attempt2Sent[0]!.content).toContain('receipt.png')
    expect(attempt2Sent[0]!.content).toContain('does not support image input')

    // Part B: OpenAI primary fails retryably -> real FailoverLlmPort fails over to Grok vision secondary,
    // preserving source binding on valid images and demoting framing-invalid ones.
    const primaryOpenAi = makeProviderMock('openai', null)
    primaryOpenAi.completeSingleTurnWithTools.mockRejectedValueOnce(new Error('503 openai down'))
    primaryOpenAi.provider.classifyError = vi.fn(() => ({
      code: LlmErrorCode.ApiCallFailed,
      retryable: true,
      message: '503 openai down',
    }))
    const grokSecondary = makeProviderMock(
      'grok-subscription',
      resolveVisualDeliveryLimits('grok-subscription')
    )
    const policyB: LlmPolicy = {
      cooldownSeconds: 300,
      triggerOn: ['provider_unavailable'],
      fallbacks: [{ provider: 'grok-subscription', model: 'grok-4' }],
    }
    const engineB = new FailoverEngine(policyB)
    const portB = maybeWrapFailover({
      primaryPort: new LlmPortAdapter(
        primaryOpenAi.provider as never,
        'gpt-4o',
        'openai',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        VISION_SUPPORTED
      ),
      primaryPair: { provider: 'openai', model: 'gpt-4o' },
      engine: engineB,
      policy: policyB,
      buildFallbackPort: () =>
        new LlmPortAdapter(
          grokSecondary.provider as never,
          'grok-4',
          'grok-subscription',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          VISION_SUPPORTED
        ),
    })

    const resB = await portB.completeWithTools({
      messages: [
        channelImageMessage([
          {
            type: 'image',
            mimeType: 'image/png',
            data: PNG_2X2_BASE64,
            width: 2,
            height: 2,
            filename: 'valid.png',
            visualValid: true,
            source: { kind: 'attachment', attachmentId: 'att-ok', messageId: 'm-ok' },
          },
          {
            type: 'image',
            mimeType: 'image/jpeg',
            data: JPEG_2X2_BASE64,
            width: 2,
            height: 2,
            filename: 'bad-motion.jpg',
            visualValid: false,
            source: { kind: 'attachment', attachmentId: 'att-bad', messageId: 'm-ok' },
          },
        ]),
      ],
      tools: [],
    })
    expect(resB.content).toBe('analysis complete')
    expect(engineB.servedBy()).toEqual({
      provider: 'grok-subscription',
      model: 'grok-4',
      fallback: true,
    })
    const grokSent = grokSecondary.completeSingleTurnWithTools.mock.calls[0]![0]!
    const grokImgParts = grokSent[0]!.contentParts!.filter(p => p.type === 'image')
    expect(grokImgParts).toHaveLength(1)
    expect(grokImgParts[0]!.source).toEqual({
      kind: 'attachment',
      attachmentId: 'att-ok',
      messageId: 'm-ok',
    })
    expect(grokSent[0]!.content).toContain('bad-motion.jpg')
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

  it('T-BR20 (V4): buildChannelRetainedImageContentParts validates source.messageId against strict V2 ID_PATTERN (no @) and falls back to task.id while preserving valid Slack ts', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-br20-'))
    const dbPath = path.join(tmpDir, 'state.db')
    const origEnableApproval = config.enableApproval
    config.enableApproval = false
    const storeHandle = makeSqliteStore({ dbPath })
    const attachmentStore = new ChannelAttachmentStore({
      hostWorkspaceRoot: tmpDir,
      sessionStoreMode: 'sqlite',
      statfsFn: async () => ({
        bsize: 4096n,
        blocks: (100n * 1024n * 1024n * 1024n) / 4096n,
        bavail: (50n * 1024n * 1024n * 1024n) / 4096n,
      }),
    })
    const queue = new MessageQueue()
    const lifecycle = new TaskLifecycle()
    queue.setLifecycle(lifecycle)
    const pendingTaskResults = new ResultStore<PendingTaskEntry>(10 * 60 * 1000, e => e.storedAt)
    const agent = new AgentStateMachine(queue, lifecycle, {
      autoStart: false,
      channelCallerContextResolver: async msg => ({
        targetUserId: 'linked-user-a',
        conversationId: msg.channelId,
      }),
    })
    agent.setConversationStore(storeHandle.store)
    agent.setChannelAttachmentStore(attachmentStore)
    agent.setPendingTaskResults(pendingTaskResults)

    const capturedMessages: ChatMessage[][] = []
    agent.setLLMProvider(
      {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools: vi.fn(async (msgs: ChatMessage[]) => {
          capturedMessages.push(msgs)
          return {
            content: 'vision ok',
            tool_calls: null,
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            finish_reason: FinishReason.Stop,
          }
        }),
        getProviderType: () => 'codex-subscription' as const,
        getVisualDeliveryLimits: () => resolveVisualDeliveryLimits('codex-subscription'),
      } as never,
      'gpt-5.3-codex'
    )
    agent.setImageInputResolver(VISION_SUPPORTED)
    agent.setMcpManager({ getAllTools: () => [], callTool: vi.fn() } as never)
    const sessionProcessor = new SessionProcessor({
      maxConcurrent: 4,
      lifecycle,
      executor: task => agent.executeTask(task),
    })
    agent.setSessionProcessor(sessionProcessor)

    const V2_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/

    try {
      const pngBytes = Buffer.from(PNG_2X2_BASE64, 'base64')
      const sessionKey = resolveCanonicalSessionKey({
        sender: 'u-br20',
        channelType: 'teams',
        channelId: '19:room@thread.tacv2',
      })
      const put = await putTestBuffer(attachmentStore, {
        bytes: pngBytes,
        linkedUserId: 'linked-user-a',
      })
      const classification = classifyBytes({
        bytes: pngBytes,
        totalByteLength: pngBytes.length,
        declaredMediaType: 'image/png',
        filename: 'shot.png',
      })
      const name = normalizeChannelFilename('shot.png', classification.class, 'br20')
      const ref = buildAttachmentFileReference({
        attachmentId: put.attachmentId,
        messageId: 'seed-msg',
        name,
        declaredMediaType: 'image/png',
        byteLength: put.byteLength,
        digestHex: put.sha256,
        classification,
      })
      if (!ref.ok) throw new Error(ref.message)
      const framing = validateStrictChannelImageContainer(pngBytes, 'png')
      const now = Math.floor(Date.now() / 1000)
      await storeHandle.store.insertChannelAttachment!({
        attachment_id: put.attachmentId,
        session_key: sessionKey,
        linked_user_id: 'linked-user-a',
        provider_event_id: `evt-${randomUUID().slice(0, 8)}`,
        provider_attachment_id: `patt-${randomUUID().slice(0, 8)}`,
        storage_rel_path: put.storageRelPath,
        sha256: put.sha256,
        byte_length: put.byteLength,
        file_reference_json: JSON.stringify(ref.value),
        width: framing.width,
        height: framing.height,
        visual_valid: framing.visualValid ? 1 : 0,
        created_at: now,
        expires_at: now + 3600,
        status: 'ready',
      })

      const runWithMessageId = async (messageId: string) => {
        const handler = new IncomingMessageHandler(
          {
            content: 'Inspect screenshot',
            channelType: 'teams',
            channelId: '19:room@thread.tacv2',
            sender: 'u-br20',
            timestamp: new Date().toISOString(),
            messageId,
            hostRef: 'ns/host',
            admittedLinkedUserId: 'linked-user-a',
            providerIdentity: {
              medium: 'teams',
              providerUserId: 'u-br20',
              providerWorkspaceId: 'tenant-1',
              providerChannelId: '19:room@thread.tacv2',
              providerChannelType: 'channel',
            },
          },
          {
            messageQueue: queue,
            agent,
            pendingTaskResults,
            getModel: () => 'gpt-5.3-codex',
            sanitizeAttachments: a => a,
            sessionProcessor,
            taskLifecycle: lifecycle,
          }
        )
        const res = await handler.execute()
        expect(res.success).toBe(true)
        const lastMsgs = capturedMessages[capturedMessages.length - 1]!
        const userMsg = [...lastMsgs].reverse().find(m => m.role === 'user')!
        const imgPart = userMsg.contentParts!.find(p => p.type === 'image')!
        expect(imgPart.source?.kind).toBe('attachment')
        return (imgPart.source as { kind: 'attachment'; attachmentId: string; messageId: string })
          .messageId
      }

      // Invalid @-bearing Teams messageId, spaces/semicolons, and >128 chars MUST fall back to valid task.id!
      for (const badId of ['19:abc@thread.tacv2', 'bad; id with space', 'x'.repeat(129)]) {
        const emittedId = await runWithMessageId(badId)
        expect(emittedId).not.toBe(badId)
        expect(V2_ID_PATTERN.test(emittedId)).toBe(true)
      }

      // Liveness witness: valid Slack ts '1700000001.000200' is preserved verbatim!
      const validTs = '1700000001.000200'
      expect(await runWithMessageId(validTs)).toBe(validTs)
    } finally {
      config.enableApproval = origEnableApproval
      await agent.stop()
      await storeHandle.shutdown()
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
