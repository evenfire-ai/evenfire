/**
 * Issue #654 — the admission gate, tested directly.
 *
 * Every refusal here costs the user their turn, and every acceptance pins the
 * model the task will actually run on, so each case asserts BOTH the envelope
 * the caller receives and the witness that the path really ran (the dispatch,
 * the resolver call, or the structured log line the branch had to emit).
 */
import { type Mock, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, MessageResponse, SetModelResult } from '../../server/types'
import { type IncomingAdmissionDeps, createIncomingAdmission } from '../incomingAdmission'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CURATED_SUPPORTED = {
  state: 'supported',
  evidence: {
    source: 'curated',
    reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
    checkedAt: '2026-09-16T00:00:00Z',
  },
}

function imageAttachment() {
  return {
    id: 'image-1',
    kind: 'image' as const,
    mimeType: 'image/png' as const,
    encoding: 'base64' as const,
    dataBase64: PNG_SIGNATURE.toString('base64'),
  }
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: 'look at this',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-17T10:00:00Z',
    messageId: 'msg-1',
    hostRef: 'host-1',
    threadId: 'chat-1',
    ...overrides,
  }
}

function imageMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return message({ attachments: [imageAttachment()], ...overrides })
}

/** The spies are read back OFF the resolved deps, never off the defaults, so a
 *  test that overrides a dependency still asserts against the function the gate
 *  actually called. Asserting on a replaced default would make every witness
 *  vacuously report zero calls. */
type Spies = {
  dispatch: Mock<IncomingAdmissionDeps['dispatch']>
  resolveImageInput: Mock<IncomingAdmissionDeps['resolveImageInput']>
  applySessionModelSelection: Mock<IncomingAdmissionDeps['applySessionModelSelection']>
  resolveTaskModel: Mock<IncomingAdmissionDeps['resolveTaskModel']>
  info: Mock<IncomingAdmissionDeps['logger']['info']>
  warn: Mock<IncomingAdmissionDeps['logger']['warn']>
}

function makeAdmission(overrides: Partial<IncomingAdmissionDeps> = {}): {
  admit: ReturnType<typeof createIncomingAdmission>
  spies: Spies
} {
  const logger = {
    info: vi.fn<IncomingAdmissionDeps['logger']['info']>(),
    warn: vi.fn<IncomingAdmissionDeps['logger']['warn']>(),
  }
  const deps: IncomingAdmissionDeps = {
    limits: { maxCount: 4, maxBytes: 1_000_000 },
    queueReady: () => true,
    degradedReason: () => null,
    hostProvider: () => 'zai',
    getConversationByKey: async () => ({ modelSelections: { zai: 'glm-5.3-flash' } }),
    resolveTaskModel: vi.fn<IncomingAdmissionDeps['resolveTaskModel']>(() => ({
      provider: { getProviderType: () => 'zai' },
      model: 'glm-5.3-flash',
    })),
    resolveImageInput: vi.fn<IncomingAdmissionDeps['resolveImageInput']>(() => ({
      capability: CURATED_SUPPORTED,
    })),
    applySessionModelSelection: vi.fn<IncomingAdmissionDeps['applySessionModelSelection']>(),
    dispatch: vi.fn<IncomingAdmissionDeps['dispatch']>(() => ({
      success: true,
      taskId: 't-1',
      status: 'pending',
    })),
    logger,
    ...overrides,
  }
  const spies: Spies = {
    dispatch: deps.dispatch as Spies['dispatch'],
    resolveImageInput: deps.resolveImageInput as Spies['resolveImageInput'],
    applySessionModelSelection:
      deps.applySessionModelSelection as Spies['applySessionModelSelection'],
    resolveTaskModel: deps.resolveTaskModel as Spies['resolveTaskModel'],
    info: deps.logger.info as Spies['info'],
    warn: deps.logger.warn as Spies['warn'],
  }
  return { admit: createIncomingAdmission(deps), spies }
}

function refusalLogs(spies: Spies): Record<string, unknown>[] {
  return spies.info.mock.calls
    .map(call => call[0] as Record<string, unknown>)
    .filter(fields => fields.event === 'message_image_refused')
}

describe('#654 incoming admission gate', () => {
  it('passes a text-only message through with a caller-supplied imageModel cleared', async () => {
    const { admit, spies } = makeAdmission()

    // The caller claims a visual execution identity; only the gate may set one.
    const response = await admit(message({ imageModel: { provider: 'zai', model: 'spoofed' } }))

    expect(response).toMatchObject({ success: true, taskId: 't-1' })
    expect(spies.dispatch).toHaveBeenCalledTimes(1)
    const dispatched = spies.dispatch.mock.calls[0][0]
    expect(dispatched.content).toBe('look at this')
    expect(dispatched).toHaveProperty('imageModel', undefined)
    // A text turn never consults the image catalog: the guard is a no-op here.
    expect(spies.resolveImageInput).not.toHaveBeenCalled()
  })

  it('refuses an image on an unverified pair with LLM_IMAGE_INPUT_UNKNOWN and logs message_image_refused', async () => {
    const { admit, spies } = makeAdmission({
      resolveImageInput: vi.fn(() => ({ capability: { state: 'unknown' } })),
    })

    const response = await admit(imageMessage())

    expect(response).toMatchObject({
      success: false,
      error: { code: 'LLM_IMAGE_INPUT_UNKNOWN', retryable: false, provider: 'zai' },
    })
    expect(spies.dispatch).toHaveBeenCalledTimes(0)
    // Witness: the catalog WAS consulted and the refusal WAS recorded, so the
    // zero dispatch above is a decision and not an unreached branch.
    expect(refusalLogs(spies)).toEqual([
      expect.objectContaining({
        event: 'message_image_refused',
        reason: 'model_unknown',
        provider: 'zai',
        model: 'glm-5.3-flash',
        code: 'LLM_IMAGE_INPUT_UNKNOWN',
      }),
    ])
  })

  it('admits a Codex image when the live catalog has no imageInput field', async () => {
    const { admit, spies } = makeAdmission({
      hostProvider: () => 'codex-subscription',
      resolveTaskModel: vi.fn(() => ({
        provider: { getProviderType: () => 'codex-subscription' },
        model: 'gpt-5.6-luna',
      })),
      resolveImageInput: vi.fn(() => ({})),
    })

    const response = await admit(imageMessage())

    expect(response).toMatchObject({ success: true, taskId: 't-1' })
    expect(spies.resolveImageInput).toHaveBeenCalledWith('codex-subscription', 'gpt-5.6-luna')
    expect(spies.dispatch).toHaveBeenCalledTimes(1)
    expect(refusalLogs(spies)).toHaveLength(0)
  })

  it('refuses an OpenAI image when the live catalog has no imageInput field', async () => {
    const { admit, spies } = makeAdmission({
      hostProvider: () => 'openai',
      resolveTaskModel: vi.fn(() => ({
        provider: { getProviderType: () => 'openai' },
        model: 'gpt-6',
      })),
      resolveImageInput: vi.fn(() => ({})),
    })

    const response = await admit(imageMessage())

    expect(response).toMatchObject({
      success: false,
      error: { code: 'LLM_IMAGE_INPUT_UNKNOWN', retryable: false, provider: 'openai' },
    })
    expect(spies.dispatch).toHaveBeenCalledTimes(0)
  })

  it('admits an image on a supported pair and pins imageModel to the served pair', async () => {
    const { admit, spies } = makeAdmission()

    const response = await admit(imageMessage())

    expect(response).toMatchObject({ success: true, taskId: 't-1' })
    expect(spies.resolveImageInput).toHaveBeenCalledWith('zai', 'glm-5.3-flash')
    expect(spies.dispatch).toHaveBeenCalledTimes(1)
    expect(spies.dispatch.mock.calls[0][0]).toMatchObject({
      imageModel: { provider: 'zai', model: 'glm-5.3-flash' },
    })
    expect(refusalLogs(spies)).toHaveLength(0)
  })

  it('refuses an image when no task model can be resolved', async () => {
    const { admit, spies } = makeAdmission({ resolveTaskModel: vi.fn(() => null) })

    const response = await admit(imageMessage())

    expect(response).toMatchObject({
      success: false,
      error: { code: 'LLM_IMAGE_INPUT_UNKNOWN', retryable: false },
    })
    expect(spies.dispatch).toHaveBeenCalledTimes(0)
    expect(refusalLogs(spies)).toEqual([expect.objectContaining({ reason: 'no_model' })])
  })

  it('answers a piggybacked CAS conflict with LLM_MODEL_SELECTION_CONFLICT and the winning revision', async () => {
    const applied: SetModelResult = {
      ok: false,
      reason: 'model_selection_conflict',
      provider: 'zai',
      model: 'glm-5.3-flash',
      modelSelectionRevision: 7,
    }
    const { admit, spies } = makeAdmission({
      applySessionModelSelection: vi.fn(async () => applied),
    })

    const response = await admit(
      imageMessage({ model: 'glm-5.3-flash', modelSelectionRevision: 3 })
    )

    expect(response).toMatchObject({
      success: false,
      modelSelectionRevision: 7,
      error: { code: 'LLM_MODEL_SELECTION_CONFLICT', retryable: true, provider: 'zai' },
    })
    // Witness: the CAS really ran, with the revision the client sent.
    expect(spies.applySessionModelSelection).toHaveBeenCalledWith(
      'user-1',
      'agent-1',
      'chat-1',
      'glm-5.3-flash',
      3,
      { skipWriteWhenEffective: true }
    )
    expect(spies.dispatch).toHaveBeenCalledTimes(0)
  })

  it('acknowledges an applied piggybacked selection with its revision (H1)', async () => {
    const applySessionModelSelection = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        provider: 'zai',
        model: 'glm-5.3-flash',
        modelSelectionRevision: 4,
      })
      .mockResolvedValueOnce({
        ok: true,
        provider: 'zai',
        model: 'glm-5.3-flash',
        modelSelectionRevision: 5,
      })
    const { admit, spies } = makeAdmission({ applySessionModelSelection })

    const first = await admit(imageMessage({ model: 'glm-5.3-flash', modelSelectionRevision: 3 }))
    // The client adopts the acknowledged revision and sends it as the next CAS
    // base — which is the whole point: without the ack it would still hold 3.
    const second = await admit(
      imageMessage({
        messageId: 'msg-2',
        model: 'glm-5.3-flash',
        modelSelectionRevision: (first as MessageResponse).modelSelectionRevision,
      })
    )

    expect(first).toMatchObject({ success: true, modelSelectionRevision: 4 })
    expect(second).toMatchObject({ success: true, modelSelectionRevision: 5 })
    expect(applySessionModelSelection.mock.calls[1][4]).toBe(4)
    expect(spies.dispatch).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid revision with a conflict code and no revision', async () => {
    const { admit, spies } = makeAdmission()

    const response = await admit(
      imageMessage({ model: 'glm-5.3-flash', modelSelectionRevision: -1 })
    )

    expect(response).toMatchObject({
      success: false,
      error: { code: 'LLM_MODEL_SELECTION_CONFLICT', retryable: true },
    })
    // No revision to adopt: the client must re-read the current selection.
    expect('modelSelectionRevision' in response).toBe(false)
    expect(spies.applySessionModelSelection).toHaveBeenCalledTimes(0)
    expect(spies.dispatch).toHaveBeenCalledTimes(0)
    expect(refusalLogs(spies)).toEqual([expect.objectContaining({ reason: 'invalid_revision' })])
  })

  it('reports a disallowed piggybacked model with LLM_MODEL_NOT_ALLOWED', async () => {
    const { admit, spies } = makeAdmission({
      applySessionModelSelection: vi.fn(async () => ({
        ok: false as const,
        reason: 'model_not_allowed' as const,
        provider: 'zai',
        model: 'glm-5.3-flash',
      })),
    })

    const response = await admit(imageMessage({ model: 'glm-5.3-flash' }))

    expect(response).toMatchObject({
      success: false,
      error: { code: 'LLM_MODEL_NOT_ALLOWED', retryable: false, provider: 'zai' },
    })
    expect('modelSelectionRevision' in response).toBe(false)
    expect(spies.dispatch).toHaveBeenCalledTimes(0)
    expect(refusalLogs(spies)).toEqual([
      expect.objectContaining({ reason: 'model_not_allowed', code: 'LLM_MODEL_NOT_ALLOWED' }),
    ])
  })

  it('ignores a piggybacked model on a text-only send and acknowledges without a revision (L8)', async () => {
    const { admit, spies } = makeAdmission({
      applySessionModelSelection: vi.fn(async () => ({
        ok: false as const,
        reason: 'model_not_allowed' as const,
        provider: 'zai',
        model: 'glm-5.3-flash',
      })),
    })

    const response = await admit(message({ model: 'glm-5.3-flash' }))

    // Fail-OPEN on the message: a rejected selection never drops the turn.
    expect(response).toMatchObject({ success: true, taskId: 't-1' })
    expect('modelSelectionRevision' in response).toBe(false)
    expect(spies.dispatch).toHaveBeenCalledTimes(1)
    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'message_model_ignored', reason: 'model_not_allowed' }),
      'Host runtime event'
    )
  })
})
