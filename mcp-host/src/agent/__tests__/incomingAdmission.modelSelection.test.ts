/**
 * Image sends and the per-session model selection (review findings M3 / LM1).
 *
 * The Desktop sends `model` (the model it displays, usually the Host default)
 * and `modelSelectionRevision` with every image. These tests wire the admission
 * gate to the REAL selection core over a real `ConversationManager`, so the
 * revision and the saved selections are the ones a later `GET /v1/runtime/models`
 * would read:
 *   - asking for the model the session already runs on writes nothing;
 *   - an image the requested model cannot read is refused before any write.
 */
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AllowlistView } from '../../config/allowlistCheck'
import type { AllowedModelEntry } from '../../config/configStore'
import { resolveSessionModel } from '../../config/modelResolution'
import { ConversationManager } from '../../core/conversation/conversation'
import type { IncomingMessage } from '../../server/types'
import { serializeSessionKey } from '../../session'
import { type IncomingAdmissionDeps, createIncomingAdmission } from '../incomingAdmission'
import { applySessionModelSelection } from '../sessionModelSelection'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EVIDENCE = {
  source: 'curated',
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}
const PROVIDER = 'zai'
const HOST_DEFAULT = 'glm-5.3-flash'
const VISION = 'glm-5.3-vision'
const TEXT_ONLY = 'glm-5.3-text'
const UNVERIFIED = 'glm-5.3-unverified'

const USER = 'user-1'
const AGENT = 'agent-1'
const CHAT = 'chat-1'
const sessionKey = serializeSessionKey({
  userId: USER,
  channelType: 'rpc',
  channelId: AGENT,
  threadId: CHAT,
})

const catalog = new Map<string, AllowedModelEntry[]>([
  [
    PROVIDER,
    [
      { model: HOST_DEFAULT, imageInput: { state: 'supported', evidence: EVIDENCE } },
      { model: VISION, imageInput: { state: 'supported', evidence: EVIDENCE } },
      { model: TEXT_ONLY, imageInput: { state: 'unsupported', evidence: EVIDENCE } },
      { model: UNVERIFIED, imageInput: { state: 'unknown' } },
    ] as AllowedModelEntry[],
  ],
])
const view: AllowlistView = { allowlistAvailable: () => true, allowedModels: () => catalog }

function imageMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: 'look at this',
    channelType: 'rpc',
    channelId: AGENT,
    sender: USER,
    timestamp: '2026-09-17T10:00:00Z',
    messageId: 'msg-1',
    hostRef: 'host-1',
    threadId: CHAT,
    attachments: [
      {
        id: 'image-1',
        kind: 'image',
        mimeType: 'image/png',
        encoding: 'base64',
        dataBase64: PNG_SIGNATURE.toString('base64'),
      },
    ],
    ...overrides,
  }
}

describe('image sends and the session model selection', () => {
  let cm: ConversationManager
  let setModelSelection: Mock<ConversationManager['setModelSelection']>
  let dispatch: Mock<IncomingAdmissionDeps['dispatch']>
  let resolveTaskModel: Mock<IncomingAdmissionDeps['resolveTaskModel']>
  let resolveImageInput: Mock<IncomingAdmissionDeps['resolveImageInput']>
  let applySelection: Mock<IncomingAdmissionDeps['applySessionModelSelection']>
  let admit: ReturnType<typeof createIncomingAdmission>

  beforeEach(() => {
    cm = new ConversationManager()
    setModelSelection = vi.spyOn(cm, 'setModelSelection')
    dispatch = vi.fn<IncomingAdmissionDeps['dispatch']>(() => ({
      success: true,
      taskId: 't-1',
      status: 'pending',
    }))
    // Same resolution primitive as main.ts `resolveTaskModel`.
    resolveTaskModel = vi.fn<IncomingAdmissionDeps['resolveTaskModel']>(selections => ({
      provider: { getProviderType: () => PROVIDER },
      model: resolveSessionModel(view, PROVIDER, HOST_DEFAULT, selections).model,
    }))
    resolveImageInput = vi.fn<IncomingAdmissionDeps['resolveImageInput']>((provider, model) => {
      const entry = catalog.get(provider)?.find(candidate => candidate.model === model)
      return entry ? { capability: entry.imageInput } : undefined
    })
    applySelection = vi.fn<IncomingAdmissionDeps['applySessionModelSelection']>(
      (userSub, hostRef, chatId, model, expectedRevision, options) =>
        applySessionModelSelection(
          {
            modelCfg: { provider: PROVIDER, name: HOST_DEFAULT },
            allowlistView: view,
            convManager: cm,
          },
          userSub,
          hostRef,
          chatId,
          model,
          expectedRevision,
          options
        )
    )
    admit = createIncomingAdmission({
      limits: { maxCount: 4, maxBytes: 1_000_000 },
      queueReady: () => true,
      degradedReason: () => null,
      hostProvider: () => PROVIDER,
      getConversationByKey: (key, userId) => cm.getSessionByKeyForUserAsync(key, userId),
      resolveTaskModel,
      resolveImageInput,
      applySessionModelSelection: applySelection,
      dispatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    })
  })

  async function session() {
    return cm.getOrCreate(sessionKey)
  }

  it('(a) admits an image on the Host default without pinning it', async () => {
    const response = await admit(imageMessage({ model: HOST_DEFAULT, modelSelectionRevision: 0 }))

    expect(response).toMatchObject({ success: true, taskId: 't-1', modelSelectionRevision: 0 })
    // Witnesses: the selection core ran and the task was dispatched on the pair.
    expect(applySelection).toHaveBeenCalledWith(USER, AGENT, CHAT, HOST_DEFAULT, 0, {
      skipWriteWhenEffective: true,
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      imageModel: { provider: PROVIDER, model: HOST_DEFAULT },
    })
    expect(setModelSelection).not.toHaveBeenCalled()
    const conv = await session()
    expect(conv.modelSelections ?? {}).toEqual({})
    expect(conv.modelSelectionRevision).toBe(0)
  })

  it('(a) repeated default-model image sends keep the revision at 0', async () => {
    for (const messageId of ['msg-1', 'msg-2', 'msg-3']) {
      const response = await admit(
        imageMessage({ messageId, model: HOST_DEFAULT, modelSelectionRevision: 0 })
      )
      expect(response).toMatchObject({ success: true, modelSelectionRevision: 0 })
    }
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(applySelection).toHaveBeenCalledTimes(3)
    expect(setModelSelection).not.toHaveBeenCalled()
    expect((await session()).modelSelectionRevision).toBe(0)
  })

  it('(b) refuses a stale revision on the Host default with the winning revision', async () => {
    // Another client selected the vision model: revision 1.
    await admit(imageMessage({ model: VISION, modelSelectionRevision: 0 }))
    expect((await session()).modelSelectionRevision).toBe(1)
    // Then that client went back to the default: revision 2, default pinned.
    await admit(
      imageMessage({ messageId: 'msg-2', model: HOST_DEFAULT, modelSelectionRevision: 1 })
    )
    expect(await session()).toMatchObject({
      modelSelections: { [PROVIDER]: HOST_DEFAULT },
      modelSelectionRevision: 2,
    })
    dispatch.mockClear()
    setModelSelection.mockClear()

    // This client still holds revision 0 and asks for the (effective) default.
    const response = await admit(
      imageMessage({ messageId: 'msg-3', model: HOST_DEFAULT, modelSelectionRevision: 0 })
    )

    expect(response).toMatchObject({
      success: false,
      modelSelectionRevision: 2,
      error: { code: 'LLM_MODEL_SELECTION_CONFLICT', retryable: true },
    })
    expect(applySelection).toHaveBeenLastCalledWith(USER, AGENT, CHAT, HOST_DEFAULT, 0, {
      skipWriteWhenEffective: true,
    })
    expect(setModelSelection).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect((await session()).modelSelectionRevision).toBe(2)
  })

  it('(c) writes and bumps for an explicit different image-capable model', async () => {
    const response = await admit(imageMessage({ model: VISION, modelSelectionRevision: 0 }))

    expect(response).toMatchObject({ success: true, modelSelectionRevision: 1 })
    expect(setModelSelection).toHaveBeenCalledTimes(1)
    expect(resolveImageInput).toHaveBeenCalledWith(PROVIDER, VISION)
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      imageModel: { provider: PROVIDER, model: VISION },
    })
    expect(await session()).toMatchObject({
      modelSelections: { [PROVIDER]: VISION },
      modelSelectionRevision: 1,
    })
  })

  it.each([
    [TEXT_ONLY, 'LLM_IMAGE_INPUT_UNSUPPORTED'],
    [UNVERIFIED, 'LLM_IMAGE_INPUT_UNKNOWN'],
  ])(
    '(d) refuses an image for %s with %s and leaves the selection untouched',
    async (model, code) => {
      await admit(imageMessage({ model: VISION, modelSelectionRevision: 0 }))
      dispatch.mockClear()
      setModelSelection.mockClear()
      applySelection.mockClear()
      resolveImageInput.mockClear()

      const response = await admit(
        imageMessage({ messageId: 'msg-2', model, modelSelectionRevision: 1 })
      )

      expect(response).toEqual({
        success: false,
        error: expect.objectContaining({ code, retryable: false, provider: PROVIDER }),
      })
      // Witness: the capability of the REQUESTED model was what got checked.
      expect(resolveTaskModel).toHaveBeenCalledWith({ [PROVIDER]: model })
      expect(resolveImageInput).toHaveBeenCalledWith(PROVIDER, model)
      expect(applySelection).not.toHaveBeenCalled()
      expect(setModelSelection).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(await session()).toMatchObject({
        modelSelections: { [PROVIDER]: VISION },
        modelSelectionRevision: 1,
      })
    }
  )

  it('(d) a text-only send with a model that cannot read images still writes it', async () => {
    const response = await admit(
      imageMessage({ attachments: undefined, model: TEXT_ONLY, modelSelectionRevision: undefined })
    )

    expect(response).toMatchObject({ success: true, modelSelectionRevision: 1 })
    expect(resolveImageInput).not.toHaveBeenCalled()
    expect(setModelSelection).toHaveBeenCalledTimes(1)
    expect((await session()).modelSelections).toEqual({ [PROVIDER]: TEXT_ONLY })
  })

  it('a text-only piggyback of the Host default still pins it (no skip option)', async () => {
    const response = await admit(
      imageMessage({
        attachments: undefined,
        model: HOST_DEFAULT,
        modelSelectionRevision: undefined,
      })
    )

    expect(response).toMatchObject({ success: true, modelSelectionRevision: 1 })
    expect(applySelection).toHaveBeenCalledWith(
      USER,
      AGENT,
      CHAT,
      HOST_DEFAULT,
      undefined,
      undefined
    )
    expect(setModelSelection).toHaveBeenCalledTimes(1)
    expect((await session()).modelSelections).toEqual({ [PROVIDER]: HOST_DEFAULT })
  })
})
